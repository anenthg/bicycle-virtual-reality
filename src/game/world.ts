// Chunked procedural world: noise-displaced rolling terrain, a vertex-colored
// road ribbon, a 3-stop gradient sky with in-shader sun, animated ocean with
// foam shoreline, layered mountain ridges, fences, flowers, birds and
// butterflies. Themes (sunset mountains → town → beach) blend by distance.
// 100 m chunks, 3 generated ahead, disposed behind (spec §5).

import * as THREE from 'three';
import { assets, type AssetId } from './assets';
import { CHUNKS_AHEAD, CHUNK_LEN, ROAD_HALF, clamp } from '../shared/types';

/** A jittered clone of a generated GLB prop, or null to fall back to procedural. */
function glbProp(
  id: AssetId,
  rng: () => number,
  scaleLo = 0.85,
  scaleHi = 1.25,
  randomYaw = true,
): THREE.Object3D | null {
  const g = assets.create(id);
  if (!g) return null;
  g.scale.multiplyScalar(scaleLo + rng() * (scaleHi - scaleLo));
  if (randomYaw) g.rotation.y += rng() * Math.PI * 2;
  return g;
}

/** Deterministic per-chunk RNG so a chunk always rebuilds identically. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Road centerline — sums of long sines: gentle enough that play stays about
// dodging, not track-following (max slope ≈ 0.05).
// ---------------------------------------------------------------------------
export function centerXAt(z: number): number {
  return 7 * Math.sin(z * 0.006) + 4 * Math.sin(z * 0.0023 + 1.7);
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------
export interface ThemeWeights {
  mountain: number;
  town: number;
  beach: number;
}

const CYCLE = 1800;
const PHASE = CYCLE / 3;
const BLEND = 160;

/** Smooth cyclic weights; always sum to 1. */
export function themeWeightsAt(z: number): ThemeWeights {
  const p = ((z % CYCLE) + CYCLE) % CYCLE;
  const w = { mountain: 0, town: 0, beach: 0 };
  const names: (keyof ThemeWeights)[] = ['mountain', 'town', 'beach'];
  for (let i = 0; i < 3; i++) {
    const center = i * PHASE + PHASE / 2;
    let d = Math.abs(p - center);
    d = Math.min(d, CYCLE - d); // cyclic distance
    w[names[i]] = clamp(1 - (d - (PHASE / 2 - BLEND)) / BLEND, 0, 1);
  }
  const sum = w.mountain + w.town + w.beach;
  w.mountain /= sum;
  w.town /= sum;
  w.beach /= sum;
  return w;
}

interface Palette {
  skyTop: THREE.Color;
  skyMid: THREE.Color;
  skyBottom: THREE.Color;
  fog: THREE.Color;
  ground: THREE.Color;
  groundHi: THREE.Color; // dry/highlight tint for raised terrain
  sun: THREE.Color;
}

const P = (hex: number) => new THREE.Color(hex);

const PALETTES: Record<keyof ThemeWeights, Palette> = {
  // Golden-hour alpine: indigo → magenta → hot orange
  mountain: {
    skyTop: P(0x3d2b8f),
    skyMid: P(0xc9648f),
    skyBottom: P(0xff9a4d),
    fog: P(0xeb9d6e),
    ground: P(0x6da24f),
    groundHi: P(0x9db058),
    sun: P(0xffd9a8),
  },
  // Bright storybook afternoon
  town: {
    skyTop: P(0x3f7fd9),
    skyMid: P(0x8fc3ef),
    skyBottom: P(0xfff0c9),
    fog: P(0xf0e2c0),
    ground: P(0x7fb85a),
    groundHi: P(0xa8c46a),
    sun: P(0xfff6da),
  },
  // Turquoise coast
  beach: {
    skyTop: P(0x2f9fd8),
    skyMid: P(0x7fd4ea),
    skyBottom: P(0xfff4cf),
    fog: P(0xf4eccd),
    ground: P(0xecd9a4),
    groundHi: P(0xf7ecc0),
    sun: P(0xffffff),
  },
};

const PALETTE_KEYS = ['skyTop', 'skyMid', 'skyBottom', 'fog', 'ground', 'groundHi', 'sun'] as const;

export function blendPalette(w: ThemeWeights, out: Palette): void {
  for (const key of PALETTE_KEYS) {
    const c = out[key];
    c.r = PALETTES.mountain[key].r * w.mountain + PALETTES.town[key].r * w.town + PALETTES.beach[key].r * w.beach;
    c.g = PALETTES.mountain[key].g * w.mountain + PALETTES.town[key].g * w.town + PALETTES.beach[key].g * w.beach;
    c.b = PALETTES.mountain[key].b * w.mountain + PALETTES.town[key].b * w.town + PALETTES.beach[key].b * w.beach;
  }
}

// ---------------------------------------------------------------------------
// Terrain: cheap layered sine noise. Flat corridor around the road, rolling
// hills beyond. Same function displaces the ground mesh AND places props.
// ---------------------------------------------------------------------------
function noise2(x: number, z: number): number {
  return (
    Math.sin(x * 0.045 + z * 0.021) * 0.45 +
    Math.sin(x * 0.017 - z * 0.033 + 2.1) * 0.33 +
    Math.sin((x + z) * 0.06 + 0.7) * 0.22
  );
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export function terrainHeightAt(x: number, z: number, w: ThemeWeights): number {
  const lat = Math.abs(x - centerXAt(z));
  const mask = smoothstep(13, 40, lat);
  if (mask <= 0) return 0;
  const amp = 7.5 * w.mountain + 2.6 * w.town + 1.9 * w.beach;
  const n = noise2(x, z);
  // Lift so hills mostly rise (valleys stay shallow)
  return Math.max((n * 0.5 + 0.5) * amp * mask - 0.3 * mask, -0.4);
}

// ---------------------------------------------------------------------------
// Shared prop geometry/materials — cloned into chunks, NEVER disposed.
// ---------------------------------------------------------------------------
const smat = (color: number, rough = 0.9) =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });

const GEO = {
  trunk: new THREE.CylinderGeometry(0.14, 0.2, 1.1, 6),
  cone: new THREE.ConeGeometry(1, 1, 7),
  cone4: new THREE.ConeGeometry(1, 1, 4),
  rock: new THREE.IcosahedronGeometry(1, 0),
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(1, 10, 8),
  frond: new THREE.ConeGeometry(0.09, 1.7, 5),
  tuft: new THREE.ConeGeometry(0.09, 0.42, 4),
  petal: new THREE.SphereGeometry(0.085, 6, 5),
};

const MAT = {
  trunk: smat(0x7a4a2b),
  palmTrunk: smat(0x9c6b3f),
  pine1: smat(0x2f7d3f),
  pine2: smat(0x3c9a4e),
  pineSnow: smat(0xf0f2f7, 1),
  rock: smat(0x8d8fa0),
  roofA: smat(0xc94f4f, 0.8),
  roofB: smat(0x4f7fc9, 0.8),
  door: smat(0x6b4226),
  window: new THREE.MeshBasicMaterial({ color: 0xffd88a }),
  frond: smat(0x3fae5a),
  bush: smat(0x4d9e45),
  ridgeFar: smat(0x8578ab, 1),
  ridgeNear: smat(0x6b5d84, 1),
  snow: smat(0xf0eef7, 1),
  lampPole: smat(0x44485a, 0.5),
  lampGlow: new THREE.MeshBasicMaterial({ color: 0xffe9a8 }),
  // Self-lit so clouds stay fluffy-white regardless of sun angle (fog still tints)
  cloud: new THREE.MeshBasicMaterial({ color: 0xfff6ec }),
  fence: smat(0x9a7448, 0.85),
  tuft: smat(0x3e8f3e),
  sailHull: smat(0xb5583e, 0.7),
  sail: new THREE.MeshBasicMaterial({ color: 0xfffaf0, side: THREE.DoubleSide }),
  bird: new THREE.MeshBasicMaterial({ color: 0x33314a, side: THREE.DoubleSide }),
  houses: [0xf2c9a8, 0xc9e4f2, 0xf2e3c9, 0xe8c9f2, 0xfad4d4].map((c) => smat(c)),
  umbrella: [0xff6b6b, 0x4d96ff, 0xffd93d].map((c) => smat(c, 0.7)),
  butterfly: [0xff8fab, 0xffd93d, 0x9fd8ff].map(
    (c) => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }),
  ),
};

const FLOWER_COLORS = [0xff8fab, 0xffd93d, 0xffffff, 0xff9a5e, 0xb388ff].map((c) => new THREE.Color(c));
const FLOWER_MAT = new THREE.MeshBasicMaterial({ color: 0xffffff }); // per-instance colors tint this

function makePine(rng: () => number): THREE.Object3D {
  const glb = glbProp('pine', rng, 0.8, 1.7);
  if (glb) return glb;
  const g = new THREE.Group();
  const scale = 0.8 + rng() * 1.1;
  const snowy = rng() < 0.3;
  const trunk = new THREE.Mesh(GEO.trunk, MAT.trunk);
  trunk.position.y = 0.55;
  g.add(trunk);
  for (let i = 0; i < 3; i++) {
    const c = new THREE.Mesh(GEO.cone, rng() > 0.5 ? MAT.pine1 : MAT.pine2);
    const r = 1.15 - i * 0.3;
    c.scale.set(r, 1.05 - i * 0.15, r);
    c.position.y = 1.1 + i * 0.75;
    c.castShadow = true;
    g.add(c);
  }
  if (snowy) {
    const cap = new THREE.Mesh(GEO.cone, MAT.pineSnow);
    cap.scale.set(0.42, 0.5, 0.42);
    cap.position.y = 2.85;
    g.add(cap);
  }
  g.scale.setScalar(scale);
  return g;
}

function makeRockCluster(rng: () => number): THREE.Object3D {
  const glb = glbProp('rock', rng, 0.7, 1.6);
  if (glb) return glb;
  const g = new THREE.Group();
  const n = 1 + Math.floor(rng() * 2.4);
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(GEO.rock, MAT.rock);
    const s = 0.3 + rng() * 0.9;
    m.scale.set(s * (0.8 + rng() * 0.5), s * 0.7, s);
    m.position.set((rng() - 0.5) * 1.6, s * 0.35, (rng() - 0.5) * 1.6);
    m.rotation.y = rng() * Math.PI;
    m.castShadow = true;
    g.add(m);
  }
  return g;
}

function makeHouse(rng: () => number): THREE.Object3D {
  const glb = glbProp('house', rng, 0.9, 1.35);
  if (glb) return glb;
  const g = new THREE.Group();
  const w = 2.6 + rng() * 1.6;
  const h = 2.2 + rng() * 1.1;
  const body = new THREE.Mesh(GEO.box, MAT.houses[Math.floor(rng() * MAT.houses.length)]);
  body.scale.set(w, h, w * 0.9);
  body.position.y = h / 2;
  body.castShadow = true;
  const roof = new THREE.Mesh(GEO.cone4, rng() > 0.4 ? MAT.roofA : MAT.roofB);
  roof.scale.set(w * 0.85, 1.4, w * 0.78);
  roof.position.y = h + 0.68;
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  const door = new THREE.Mesh(GEO.box, MAT.door);
  door.scale.set(0.6, 1.15, 0.1);
  door.position.set(-w * 0.2, 0.57, w * 0.45 + 0.02);
  g.add(body, roof, door);
  // Warm lit windows — instant storybook
  for (const wx of [w * 0.22, -w * 0.02]) {
    const win = new THREE.Mesh(GEO.box, MAT.window);
    win.scale.set(0.5, 0.5, 0.06);
    win.position.set(wx + w * 0.08, h * 0.6, w * 0.45 + 0.03);
    g.add(win);
  }
  const chimney = new THREE.Mesh(GEO.box, MAT.rock);
  chimney.scale.set(0.35, 0.9, 0.35);
  chimney.position.set(w * 0.28, h + 0.75, -w * 0.15);
  g.add(chimney);
  g.rotation.y = (rng() - 0.5) * 0.6;
  return g;
}

function makeLamp(): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(GEO.box, MAT.lampPole);
  pole.scale.set(0.09, 3, 0.09);
  pole.position.y = 1.5;
  const glow = new THREE.Mesh(GEO.sphere, MAT.lampGlow);
  glow.scale.setScalar(0.18);
  glow.position.y = 3.05;
  g.add(pole, glow);
  return g;
}

function makePalm(rng: () => number): THREE.Object3D {
  const glb = glbProp('palm', rng, 0.85, 1.4);
  if (glb) return glb;
  const g = new THREE.Group();
  const lean = (rng() - 0.5) * 0.5;
  let x = 0;
  for (let i = 0; i < 4; i++) {
    const seg = new THREE.Mesh(GEO.trunk, MAT.palmTrunk);
    seg.scale.set(0.75 - i * 0.1, 0.85, 0.75 - i * 0.1);
    x += lean * 0.28;
    seg.position.set(x, 0.45 + i * 0.85, 0);
    seg.rotation.z = -lean * 0.35;
    seg.castShadow = true;
    g.add(seg);
  }
  // Fronds: flattened cones with tips pointing outward and drooping down
  const top = new THREE.Vector3(x, 3.75, 0);
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 7; i++) {
    const f = new THREE.Mesh(GEO.frond, MAT.frond);
    f.scale.set(3.2, 1.15, 1); // wide leaf, not a spike
    const a = (i / 7) * Math.PI * 2 + rng() * 0.3;
    const dir = new THREE.Vector3(Math.sin(a), -0.5 - rng() * 0.25, Math.cos(a)).normalize();
    f.quaternion.setFromUnitVectors(up, dir);
    f.position.copy(top).addScaledVector(dir, 0.8);
    g.add(f);
  }
  g.scale.setScalar(0.85 + rng() * 0.5);
  return g;
}

function makeUmbrella(rng: () => number): THREE.Object3D {
  const glb = glbProp('umbrella', rng, 0.9, 1.3);
  if (glb) return glb;
  const g = new THREE.Group();
  const pole = new THREE.Mesh(GEO.box, MAT.lampPole);
  pole.scale.set(0.07, 2.2, 0.07);
  pole.position.y = 1.1;
  const top = new THREE.Mesh(GEO.cone, MAT.umbrella[Math.floor(rng() * MAT.umbrella.length)]);
  top.scale.set(1.5, 0.55, 1.5);
  top.position.y = 2.3;
  top.castShadow = true;
  g.add(pole, top);
  return g;
}

function makeBush(rng: () => number): THREE.Mesh {
  const m = new THREE.Mesh(GEO.sphere, MAT.bush);
  const s = 0.5 + rng() * 0.5;
  m.scale.set(s * 1.3, s * 0.8, s * 1.3);
  m.position.y = s * 0.5;
  return m;
}

function makeSailboat(rng: () => number): THREE.Group {
  const g = new THREE.Group();
  const hull = new THREE.Mesh(GEO.box, MAT.sailHull);
  hull.scale.set(0.7, 0.4, 2.2);
  hull.position.y = 0.15;
  const mast = new THREE.Mesh(GEO.box, MAT.lampPole);
  mast.scale.set(0.06, 2.6, 0.06);
  mast.position.y = 1.6;
  const sail = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2), MAT.sail);
  sail.position.set(0.02, 1.7, 0.35);
  sail.rotation.y = Math.PI / 2;
  // triangle-ish: shear by scaling top in via geometry? cheap: rotate slightly
  sail.scale.set(1, 1, 1);
  g.add(hull, mast, sail);
  g.scale.setScalar(1.6 + rng() * 0.9);
  return g;
}

/** Two-cone layered ridge with optional snow cap. */
function makeRidge(rng: () => number, far: boolean): THREE.Group {
  const g = new THREE.Group();
  const n = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < n; i++) {
    const h = far ? 30 + rng() * 26 : 13 + rng() * 12;
    const r = h * (0.85 + rng() * 0.35); // keep bases from creeping toward the road
    const body = new THREE.Mesh(GEO.cone, far ? MAT.ridgeFar : MAT.ridgeNear);
    body.scale.set(r, h, r * (0.7 + rng() * 0.5));
    body.position.set((i - n / 2) * r * 0.9, h / 2 - 1.5, (rng() - 0.5) * r * 0.5);
    body.rotation.y = rng() * Math.PI;
    g.add(body);
    if (h > 22) {
      const cap = new THREE.Mesh(GEO.cone, MAT.snow);
      cap.scale.set(r * 0.3, h * 0.28, r * 0.3 * (0.7 + rng() * 0.5));
      cap.position.set(body.position.x, h - h * 0.14 - 1.5, body.position.z);
      cap.rotation.y = body.rotation.y;
      g.add(cap);
    }
  }
  return g;
}

// ---------------------------------------------------------------------------
// Ocean — one shared shader material, per-chunk shore-following ribbon.
// ---------------------------------------------------------------------------
const OCEAN_MAT = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uShallow: { value: new THREE.Color(0x63d3d8) },
    uDeep: { value: new THREE.Color(0x1f7fc4) },
    uFoam: { value: new THREE.Color(0xffffff) },
    uFog: { value: new THREE.Color(0xf4eccd) },
  },
  vertexShader: /* glsl */ `
    uniform float uTime;
    varying vec2 vUv;
    varying vec3 vWorld;
    void main() {
      vUv = uv;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      wp.y += sin(uTime * 1.2 + wp.x * 0.14) * 0.10 + cos(uTime * 0.8 + wp.z * 0.09) * 0.08;
      vWorld = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */ `
    uniform float uTime;
    uniform vec3 uShallow;
    uniform vec3 uDeep;
    uniform vec3 uFoam;
    uniform vec3 uFog;
    varying vec2 vUv;
    varying vec3 vWorld;
    void main() {
      float depthT = clamp(vUv.x * 1.5, 0.0, 1.0);
      vec3 col = mix(uShallow, uDeep, depthT);
      // soft moving glints
      float band = sin(vWorld.z * 0.12 - uTime * 1.1 + sin(vWorld.x * 0.07 + uTime * 0.4) * 1.8);
      col += vec3(0.10) * smoothstep(0.72, 1.0, band) * (1.0 - depthT * 0.6);
      // breaking foam at the shore edge
      float lap = sin(vWorld.z * 0.32 + uTime * 1.6) * 0.012 + sin(vWorld.z * 0.11 - uTime * 0.7) * 0.02;
      float foam = smoothstep(0.055, 0.0, vUv.x + lap);
      float foam2 = smoothstep(0.02, 0.0, abs(vUv.x + lap - 0.085)) * 0.5;
      col = mix(col, uFoam, clamp(foam + foam2, 0.0, 1.0) * 0.92);
      // manual exponential fog so the shader material matches the scene
      float d = distance(vWorld, cameraPosition);
      float f = 1.0 - exp(-d * 0.0052);
      col = mix(col, uFog, f);
      gl_FragColor = vec4(col, 1.0);
    }`,
});

const SHORE_OFF = 27; // lateral offset (from centerline) where water starts
const OCEAN_W = 190;

function buildOceanRibbon(z0: number, z1: number): THREE.BufferGeometry {
  const STEP = 5;
  const rows = Math.round((z1 - z0) / STEP) + 1;
  const COLS = 14;
  const positions = new Float32Array(rows * COLS * 3);
  const uvs = new Float32Array(rows * COLS * 2);
  const indices: number[] = [];
  for (let r = 0; r < rows; r++) {
    const z = z0 + r * STEP;
    const cx = centerXAt(z);
    for (let c = 0; c < COLS; c++) {
      const t = c / (COLS - 1);
      const i = (r * COLS + c) * 3;
      positions[i] = cx + SHORE_OFF + t * OCEAN_W;
      positions[i + 1] = 0.06;
      positions[i + 2] = z;
      uvs[(r * COLS + c) * 2] = t;
      uvs[(r * COLS + c) * 2 + 1] = z * 0.01;
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < COLS - 1; c++) {
      const a = r * COLS + c;
      indices.push(a, a + COLS, a + 1, a + 1, a + COLS, a + COLS + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------
// Chunk plumbing
// ---------------------------------------------------------------------------
export interface ChunkInfo {
  index: number;
  z0: number;
  z1: number;
  rng: () => number;
  group: THREE.Group;
  weights: ThemeWeights;
}

interface Chunk extends ChunkInfo {
  owned: THREE.BufferGeometry[]; // per-chunk geometry we must dispose
  instanced: THREE.InstancedMesh[]; // per-chunk instanced meshes (dispose frees buffers)
  ownedMats: THREE.Material[];
}

export type ChunkDelegate = {
  populate(chunk: ChunkInfo): void;
  depopulate(index: number): void;
};

export interface WorldEnv {
  fog: THREE.FogExp2;
  hemi: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
}

// Sun direction for the sky shader (normalized; roughly matches the light)
const SUN_DIR = new THREE.Vector3(-0.3, 0.18, 0.85).normalize();

export class World {
  private scene: THREE.Scene;
  private env: WorldEnv;
  private delegate: ChunkDelegate;
  private chunks = new Map<number, Chunk>();
  private skyMat: THREE.ShaderMaterial;
  private sky: THREE.Mesh;
  private clouds: THREE.Group[] = [];
  private birds: { g: THREE.Group; wingL: THREE.Mesh; wingR: THREE.Mesh; vx: number; vz: number; phase: number }[] = [];
  private butterflies: { g: THREE.Group; wingL: THREE.Mesh; wingR: THREE.Mesh; baseX: number; baseY: number; phase: number }[] = [];
  private elapsed = 0;
  private palette: Palette = {
    skyTop: new THREE.Color(),
    skyMid: new THREE.Color(),
    skyBottom: new THREE.Color(),
    fog: new THREE.Color(),
    ground: new THREE.Color(),
    groundHi: new THREE.Color(),
    sun: new THREE.Color(),
  };
  private worldSeed: number;

  readonly centerXAt = centerXAt;

  constructor(scene: THREE.Scene, env: WorldEnv, delegate: ChunkDelegate, seed = 1234) {
    this.scene = scene;
    this.env = env;
    this.delegate = delegate;
    this.worldSeed = seed;

    // ---- sky dome: 3-stop gradient + sun disc & glow in-shader -------------
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x3d2b8f) },
        midColor: { value: new THREE.Color(0xc9648f) },
        bottomColor: { value: new THREE.Color(0xff9a4d) },
        sunColor: { value: new THREE.Color(0xffe9c4) },
        sunDir: { value: SUN_DIR.clone() },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 topColor;
        uniform vec3 midColor;
        uniform vec3 bottomColor;
        uniform vec3 sunColor;
        uniform vec3 sunDir;
        varying vec3 vDir;
        void main() {
          vec3 dir = normalize(vDir);
          float h = dir.y;
          vec3 col;
          if (h > 0.0) {
            col = mix(midColor, topColor, pow(min(h * 1.35, 1.0), 0.75));
          } else {
            col = mix(midColor, bottomColor, clamp(-h * 9.0, 0.0, 1.0));
          }
          // horizon warm band
          col = mix(col, bottomColor, smoothstep(0.22, 0.0, abs(h)) * 0.55);
          // sun disc + halo
          float d = max(dot(dir, sunDir), 0.0);
          col += sunColor * (pow(d, 900.0) * 1.1 + pow(d, 60.0) * 0.35 + pow(d, 8.0) * 0.12);
          gl_FragColor = vec4(col, 1.0);
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(850, 28, 16), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    scene.add(this.sky);

    // ---- clouds --------------------------------------------------------------
    const cloudRng = mulberry32(999);
    for (let i = 0; i < 10; i++) {
      const cloud = new THREE.Group();
      const n = 3 + Math.floor(cloudRng() * 4);
      for (let b = 0; b < n; b++) {
        const puff = new THREE.Mesh(GEO.sphere, MAT.cloud);
        const s = 2.2 + cloudRng() * 3;
        puff.scale.set(s * 1.6, s * 0.8, s);
        puff.position.set((b - n / 2) * s * 1.3, cloudRng() * 1.4, cloudRng() * 2.5);
        cloud.add(puff);
      }
      cloud.position.set((cloudRng() - 0.5) * 240, 26 + cloudRng() * 26, i * 55);
      scene.add(cloud);
      this.clouds.push(cloud);
    }

    // ---- birds (ambient life, always around) -----------------------------------
    const birdRng = mulberry32(4242);
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group();
      const wingGeo = new THREE.PlaneGeometry(0.9, 0.32);
      const wingL = new THREE.Mesh(wingGeo, MAT.bird);
      const wingR = new THREE.Mesh(wingGeo, MAT.bird);
      wingL.position.x = -0.45;
      wingR.position.x = 0.45;
      g.add(wingL, wingR);
      g.position.set((birdRng() - 0.5) * 80, 16 + birdRng() * 14, i * 90);
      scene.add(g);
      this.birds.push({
        g,
        wingL,
        wingR,
        vx: (birdRng() - 0.5) * 5,
        vz: 3 + birdRng() * 4,
        phase: birdRng() * 7,
      });
    }

    // ---- butterflies near the road ----------------------------------------------
    const bRng = mulberry32(777);
    for (let i = 0; i < 6; i++) {
      const g = new THREE.Group();
      const wingGeo = new THREE.PlaneGeometry(0.22, 0.3);
      const m = MAT.butterfly[i % MAT.butterfly.length];
      const wingL = new THREE.Mesh(wingGeo, m);
      const wingR = new THREE.Mesh(wingGeo, m);
      wingL.position.x = -0.11;
      wingR.position.x = 0.11;
      g.add(wingL, wingR);
      g.position.set(0, 1, i * 40);
      scene.add(g);
      this.butterflies.push({ g, wingL, wingR, baseX: (bRng() - 0.5) * 16, baseY: 0.8 + bRng() * 1.2, phase: bRng() * 9 });
    }
  }

  /** Keep chunks alive around the rider; blend environment; animate ambience. */
  update(riderZ: number, camera: THREE.Camera, dt: number): void {
    this.elapsed += dt;
    const current = Math.floor(riderZ / CHUNK_LEN);
    for (let i = current - 1; i <= current + CHUNKS_AHEAD; i++) {
      if (i >= 0 && !this.chunks.has(i)) this.buildChunk(i);
    }
    for (const [i, chunk] of this.chunks) {
      if (i < current - 1 || i > current + CHUNKS_AHEAD + 1) {
        this.disposeChunk(chunk);
        this.chunks.delete(i);
      }
    }

    // Environment blend, looking slightly ahead so transitions lead the rider
    const w = themeWeightsAt(riderZ + 60);
    blendPalette(w, this.palette);
    const u = this.skyMat.uniforms;
    (u.topColor.value as THREE.Color).copy(this.palette.skyTop);
    (u.midColor.value as THREE.Color).copy(this.palette.skyMid);
    (u.bottomColor.value as THREE.Color).copy(this.palette.skyBottom);
    (u.sunColor.value as THREE.Color).copy(this.palette.sun);
    this.env.fog.color.copy(this.palette.fog);
    this.env.hemi.color.copy(this.palette.skyMid).lerp(new THREE.Color(0xffffff), 0.45);
    this.env.hemi.groundColor.copy(this.palette.ground).multiplyScalar(0.75);
    this.env.sun.color.copy(this.palette.sun);
    (OCEAN_MAT.uniforms.uFog.value as THREE.Color).copy(this.palette.fog);
    OCEAN_MAT.uniforms.uTime.value = this.elapsed;

    // Sky follows the camera so the dome never ends
    const camPos = new THREE.Vector3();
    camera.getWorldPosition(camPos);
    this.sky.position.set(camPos.x, 0, camPos.z);

    // Clouds drift; recycle any that fall behind
    for (const cloud of this.clouds) {
      cloud.position.x += dt * 0.6;
      if (cloud.position.z < riderZ - 60) {
        cloud.position.z = riderZ + 380 + Math.random() * 140;
        cloud.position.x = centerXAt(cloud.position.z) + (Math.random() - 0.5) * 260;
      }
    }

    // Birds: glide + flap, recycle behind/far-side
    for (const b of this.birds) {
      b.g.position.x += b.vx * dt;
      b.g.position.z += b.vz * dt;
      b.g.position.y += Math.sin(this.elapsed * 1.4 + b.phase) * dt * 1.6;
      const flap = Math.sin(this.elapsed * 9 + b.phase) * 0.75;
      b.wingL.rotation.z = flap;
      b.wingR.rotation.z = -flap;
      b.g.rotation.y = Math.atan2(b.vx, b.vz);
      if (b.g.position.z < riderZ - 40 || Math.abs(b.g.position.x - centerXAt(riderZ)) > 130) {
        b.g.position.set(
          centerXAt(riderZ + 200) + (Math.random() - 0.5) * 90,
          14 + Math.random() * 16,
          riderZ + 180 + Math.random() * 160,
        );
        b.vx = (Math.random() - 0.5) * 6;
        b.vz = 2.5 + Math.random() * 4;
      }
    }

    // Butterflies: flutter near the roadside, leapfrog ahead when passed
    for (const bf of this.butterflies) {
      const t = this.elapsed * 1.7 + bf.phase;
      bf.g.position.x = centerXAt(bf.g.position.z) + bf.baseX + Math.sin(t * 0.9) * 1.6;
      bf.g.position.y = bf.baseY + Math.sin(t * 1.3) * 0.5;
      bf.g.position.z += Math.sin(t * 0.5) * dt * 2;
      const flap = Math.abs(Math.sin(t * 7)) * 1.1;
      bf.wingL.rotation.y = flap;
      bf.wingR.rotation.y = -flap;
      if (bf.g.position.z < riderZ - 15) {
        bf.g.position.z = riderZ + 70 + Math.random() * 120;
        bf.baseX = (Math.random() - 0.5) * 17;
      }
    }
  }

  reset(): void {
    for (const chunk of this.chunks.values()) this.disposeChunk(chunk);
    this.chunks.clear();
  }

  // -------------------------------------------------------------------------

  private buildChunk(index: number): void {
    const z0 = index * CHUNK_LEN;
    const z1 = z0 + CHUNK_LEN;
    const rng = mulberry32(this.worldSeed + index * 7919);
    const group = new THREE.Group();
    const weights = themeWeightsAt(z0 + CHUNK_LEN / 2);
    const owned: THREE.BufferGeometry[] = [];
    const instanced: THREE.InstancedMesh[] = [];
    const ownedMats: THREE.Material[] = [];

    group.add(this.buildTerrain(z0, z1, weights, owned, ownedMats));
    group.add(this.buildRoadRibbon(z0, z1, owned));
    group.add(this.buildCenterDashes(z0, z1, owned));

    if (weights.beach > 0.45) {
      const oceanGeo = buildOceanRibbon(z0, z1);
      owned.push(oceanGeo);
      const ocean = new THREE.Mesh(oceanGeo, OCEAN_MAT);
      ocean.frustumCulled = false;
      group.add(ocean);
      // Sailboats out on the water
      if (rng() < 0.5) {
        const boat = makeSailboat(rng);
        const bz = z0 + rng() * CHUNK_LEN;
        boat.position.set(centerXAt(bz) + SHORE_OFF + 25 + rng() * 60, 0.1, bz);
        boat.rotation.y = rng() * Math.PI * 2;
        group.add(boat);
      }
    }

    this.scatterProps(group, rng, z0, weights);
    this.buildFences(group, rng, z0, weights, owned);
    this.buildFlora(group, rng, z0, weights, instanced);

    this.scene.add(group);
    const chunk: Chunk = { index, z0, z1, rng, group, weights, owned, instanced, ownedMats };
    this.chunks.set(index, chunk);
    this.delegate.populate(chunk);
  }

  /** Noise-displaced, vertex-colored ground. Flat corridor for the road. */
  private buildTerrain(
    z0: number,
    z1: number,
    w: ThemeWeights,
    owned: THREE.BufferGeometry[],
    ownedMats: THREE.Material[],
  ): THREE.Mesh {
    const W = 340;
    const SEG_X = 56;
    const SEG_Z = 14;
    const geo = new THREE.PlaneGeometry(W, z1 - z0 + 2, SEG_X, SEG_Z);
    geo.rotateX(-Math.PI / 2);
    owned.push(geo);

    blendPalette(w, this.palette);
    const base = this.palette.ground;
    const hi = this.palette.groundHi;

    const cx0 = centerXAt(z0 + CHUNK_LEN / 2);
    const zMid = (z0 + z1) / 2;
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + cx0;
      const wz = pos.getZ(i) + zMid;
      const h = terrainHeightAt(wx, wz, w);
      pos.setY(i, h - 0.05);
      // color: base grass modulated by fine noise + height highlight
      const n = noise2(wx * 2.3, wz * 2.3) * 0.5 + 0.5;
      const hT = clamp(h / 6, 0, 1);
      c.copy(base).lerp(hi, hT * 0.8 + n * 0.15);
      c.multiplyScalar(0.93 + n * 0.12);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    ownedMats.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx0, 0, zMid);
    mesh.receiveShadow = true;
    return mesh;
  }

  private buildRoadRibbon(z0: number, z1: number, owned: THREE.BufferGeometry[]): THREE.Mesh {
    const STEP = 2.5;
    const rows = Math.round((z1 - z0) / STEP) + 1;
    const asphalt = new THREE.Color(0x3d4250);
    const white = new THREE.Color(0xf5f2e8);
    const shoulder = new THREE.Color(0x565b68);
    const xs = [-ROAD_HALF - 0.5, -ROAD_HALF, -ROAD_HALF, -ROAD_HALF + 0.36, -ROAD_HALF + 0.36,
      ROAD_HALF - 0.36, ROAD_HALF - 0.36, ROAD_HALF, ROAD_HALF, ROAD_HALF + 0.5];
    const cs = [shoulder, shoulder, white, white, asphalt, asphalt, white, white, shoulder, shoulder];
    const cols = xs.length;

    const positions = new Float32Array(rows * cols * 3);
    const colors = new Float32Array(rows * cols * 3);
    const indices: number[] = [];
    for (let r = 0; r < rows; r++) {
      const z = z0 + r * STEP;
      const cx = centerXAt(z);
      const shade = 0.94 + ((r * 7919) % 13) / 13 * 0.06;
      for (let cI = 0; cI < cols; cI++) {
        const i = (r * cols + cI) * 3;
        positions[i] = cx + xs[cI];
        positions[i + 1] = 0.02;
        positions[i + 2] = z;
        colors[i] = cs[cI].r * shade;
        colors[i + 1] = cs[cI].g * shade;
        colors[i + 2] = cs[cI].b * shade;
      }
    }
    for (let r = 0; r < rows - 1; r++) {
      for (let cI = 0; cI < cols - 1; cI++) {
        const a = r * cols + cI;
        indices.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    owned.push(geo);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }),
    );
    mesh.receiveShadow = true;
    return mesh;
  }

  private buildCenterDashes(z0: number, z1: number, owned: THREE.BufferGeometry[]): THREE.Mesh {
    const positions: number[] = [];
    const indices: number[] = [];
    let v = 0;
    for (let z = z0 + 2; z < z1; z += 6) {
      const halfW = 0.14;
      const len = 2.2;
      for (const [dx, dz] of [[-halfW, 0], [halfW, 0], [-halfW, len], [halfW, len]] as const) {
        positions.push(centerXAt(z + dz) + dx, 0.028, z + dz);
      }
      indices.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
      v += 4;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    owned.push(geo);
    return new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0xffe9a8, roughness: 0.9 }),
    );
  }

  private scatterProps(
    group: THREE.Group,
    rng: () => number,
    z0: number,
    w: ThemeWeights,
  ): void {
    const pickTheme = (): keyof ThemeWeights => {
      const r = rng();
      if (r < w.mountain) return 'mountain';
      if (r < w.mountain + w.town) return 'town';
      return 'beach';
    };
    const beachy = w.beach > 0.45;

    // Near props (cast shadows), seated on the terrain
    const nearCount = 12 + Math.floor(rng() * 5);
    for (let i = 0; i < nearCount; i++) {
      const z = z0 + rng() * CHUNK_LEN;
      const side = rng() > 0.5 ? 1 : -1;
      // Don't drop props into the ocean
      const maxOff = beachy && side > 0 ? 19 : 34;
      const off = 8.5 + rng() * (maxOff - 8.5);
      const theme = pickTheme();
      let prop: THREE.Object3D;
      if (theme === 'mountain') {
        prop = rng() > 0.28 ? makePine(rng) : makeRockCluster(rng);
      } else if (theme === 'town') {
        const r = rng();
        prop = r > 0.52 ? makeHouse(rng) : r > 0.24 ? makeBush(rng) : makeLamp();
      } else {
        const r = rng();
        prop = r > 0.5 ? makePalm(rng) : r > 0.22 ? makeUmbrella(rng) : makeRockCluster(rng);
      }
      const x = centerXAt(z) + side * off;
      prop.position.set(x, terrainHeightAt(x, z, w) - 0.04, z);
      group.add(prop);
    }

    // Mid-distance tree belts thicken the mountain forests
    if (w.mountain > 0.3) {
      const beltCount = 8 + Math.floor(rng() * 5);
      for (let i = 0; i < beltCount; i++) {
        const z = z0 + rng() * CHUNK_LEN;
        const side = rng() > 0.5 ? 1 : -1;
        const off = 34 + rng() * 30;
        const x = centerXAt(z) + side * off;
        const pine = makePine(rng);
        pine.traverse((o) => (o.castShadow = false)); // outside the shadow frustum anyway
        pine.position.set(x, terrainHeightAt(x, z, w) - 0.04, z);
        group.add(pine);
      }
    }

    // Layered ridges: near + far, fading into fog
    if (w.mountain > 0.2) {
      for (let i = 0; i < 2; i++) {
        const z = z0 + rng() * CHUNK_LEN;
        const side = rng() > 0.5 ? 1 : -1;
        const near = makeRidge(rng, false);
        near.position.set(centerXAt(z) + side * (78 + rng() * 40), 0, z + 40);
        group.add(near);
        const far = makeRidge(rng, true);
        far.position.set(centerXAt(z) + side * (165 + rng() * 80), 0, z + 80);
        group.add(far);
      }
    } else if (w.town > 0.4) {
      // Soft rolling hills behind town
      for (let i = 0; i < 2; i++) {
        const z = z0 + rng() * CHUNK_LEN;
        const side = rng() > 0.5 ? 1 : -1;
        const hill = new THREE.Mesh(GEO.sphere, MAT.bush);
        const s = 25 + rng() * 30;
        hill.scale.set(s * 1.8, s * 0.5, s);
        const x = centerXAt(z) + side * (95 + rng() * 70);
        hill.position.set(x, -s * 0.12, z + 60);
        group.add(hill);
      }
    }
  }

  /** Wooden fences hugging the road — depth cue + speed sensation. */
  private buildFences(
    group: THREE.Group,
    rng: () => number,
    z0: number,
    w: ThemeWeights,
    owned: THREE.BufferGeometry[],
  ): void {
    if (w.beach > 0.5) return; // no fences on the coast road
    if (rng() < 0.35) return;
    const side = rng() > 0.5 ? 1 : -1;
    const start = z0 + rng() * 40;
    const len = 30 + rng() * 50;
    const off = ROAD_HALF + 1.6;

    const postCount = Math.floor(len / 2.5);
    const posts = new THREE.InstancedMesh(GEO.box, MAT.fence, postCount);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < postCount; i++) {
      const z = start + i * 2.5;
      dummy.position.set(centerXAt(z) + side * off, 0.42, z);
      dummy.scale.set(0.1, 0.85, 0.1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      posts.setMatrixAt(i, dummy.matrix);
    }
    posts.instanceMatrix.needsUpdate = true;
    posts.castShadow = true;
    group.add(posts);

    // Rails: short segments following the curve, merged into one geometry
    const positions: number[] = [];
    const indices: number[] = [];
    let v = 0;
    for (const railY of [0.7, 0.38]) {
      for (let z = start; z < start + len - 2.5; z += 2.5) {
        const x1 = centerXAt(z) + side * off;
        const x2 = centerXAt(z + 2.6) + side * off;
        const hw = 0.045;
        // simple quad strip (front face only — thin rail reads fine)
        positions.push(
          x1 - hw * side, railY - 0.05, z,
          x1 + hw * side, railY + 0.05, z,
          x2 - hw * side, railY - 0.05, z + 2.6,
          x2 + hw * side, railY + 0.05, z + 2.6,
        );
        indices.push(v, v + 1, v + 2, v + 1, v + 3, v + 2, v, v + 2, v + 1, v + 1, v + 2, v + 3);
        v += 4;
      }
    }
    const railGeo = new THREE.BufferGeometry();
    railGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    railGeo.setIndex(indices);
    railGeo.computeVertexNormals();
    owned.push(railGeo);
    group.add(new THREE.Mesh(railGeo, MAT.fence));
  }

  /** Instanced flowers + grass tufts near the road — cheap liveliness. */
  private buildFlora(
    group: THREE.Group,
    rng: () => number,
    z0: number,
    w: ThemeWeights,
    instanced: THREE.InstancedMesh[],
  ): void {
    const green = w.mountain + w.town; // flora density fades on the beach
    const dummy = new THREE.Object3D();

    const tuftCount = Math.floor(50 * green) + 10;
    const tufts = new THREE.InstancedMesh(GEO.tuft, MAT.tuft, tuftCount);
    for (let i = 0; i < tuftCount; i++) {
      const z = z0 + rng() * CHUNK_LEN;
      const side = rng() > 0.5 ? 1 : -1;
      const x = centerXAt(z) + side * (7.2 + rng() * 18);
      dummy.position.set(x, terrainHeightAt(x, z, w) + 0.14, z);
      const s = 0.7 + rng() * 1;
      dummy.scale.set(s, s * (0.8 + rng() * 0.6), s);
      dummy.rotation.set((rng() - 0.5) * 0.3, rng() * Math.PI, (rng() - 0.5) * 0.3);
      dummy.updateMatrix();
      tufts.setMatrixAt(i, dummy.matrix);
    }
    tufts.instanceMatrix.needsUpdate = true;
    group.add(tufts);
    instanced.push(tufts);

    if (green > 0.35) {
      const flowerCount = Math.floor(34 * green);
      const flowers = new THREE.InstancedMesh(GEO.petal, FLOWER_MAT, flowerCount);
      for (let i = 0; i < flowerCount; i++) {
        const z = z0 + rng() * CHUNK_LEN;
        const side = rng() > 0.5 ? 1 : -1;
        const x = centerXAt(z) + side * (7 + rng() * 14);
        dummy.position.set(x, terrainHeightAt(x, z, w) + 0.16, z);
        const s = 0.8 + rng() * 0.9;
        dummy.scale.set(s, s * 0.75, s);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        flowers.setMatrixAt(i, dummy.matrix);
        flowers.setColorAt(i, FLOWER_COLORS[Math.floor(rng() * FLOWER_COLORS.length)]);
      }
      flowers.instanceMatrix.needsUpdate = true;
      if (flowers.instanceColor) flowers.instanceColor.needsUpdate = true;
      group.add(flowers);
      instanced.push(flowers);
    }
  }

  private disposeChunk(chunk: Chunk): void {
    this.delegate.depopulate(chunk.index);
    this.scene.remove(chunk.group);
    for (const geo of chunk.owned) geo.dispose();
    for (const im of chunk.instanced) im.dispose();
    for (const m of chunk.ownedMats) m.dispose();
  }
}
