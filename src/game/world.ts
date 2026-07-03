// Chunked procedural world: a gently curving road built from vertex-colored
// ribbons, theme palettes (sunset mountains → town → beach) blended by
// distance, plus sky dome, sun, clouds and roadside props.
// 100 m chunks, 3 generated ahead, disposed behind (spec §5).

import * as THREE from 'three';
import { CHUNKS_AHEAD, CHUNK_LEN, ROAD_HALF, clamp } from '../shared/types';

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
  skyBottom: THREE.Color;
  fog: THREE.Color;
  ground: THREE.Color;
  sun: THREE.Color;
}

const PALETTES: Record<keyof ThemeWeights, Palette> = {
  mountain: {
    skyTop: new THREE.Color(0x7b5bd6),
    skyBottom: new THREE.Color(0xffab6b),
    fog: new THREE.Color(0xeba36f),
    ground: new THREE.Color(0x7fae5c),
    sun: new THREE.Color(0xffd9a8),
  },
  town: {
    skyTop: new THREE.Color(0x5a8fe0),
    skyBottom: new THREE.Color(0xffe3ae),
    fog: new THREE.Color(0xf2d9ae),
    ground: new THREE.Color(0x8cbf63),
    sun: new THREE.Color(0xfff2cf),
  },
  beach: {
    skyTop: new THREE.Color(0x47b3e6),
    skyBottom: new THREE.Color(0xfff0c4),
    fog: new THREE.Color(0xf7ebc4),
    ground: new THREE.Color(0xeedaa0),
    sun: new THREE.Color(0xffffff),
  },
};

export function blendPalette(w: ThemeWeights, out: Palette): void {
  for (const key of ['skyTop', 'skyBottom', 'fog', 'ground', 'sun'] as const) {
    const c = out[key];
    c.setRGB(0, 0, 0);
    c.r = PALETTES.mountain[key].r * w.mountain + PALETTES.town[key].r * w.town + PALETTES.beach[key].r * w.beach;
    c.g = PALETTES.mountain[key].g * w.mountain + PALETTES.town[key].g * w.town + PALETTES.beach[key].g * w.beach;
    c.b = PALETTES.mountain[key].b * w.mountain + PALETTES.town[key].b * w.town + PALETTES.beach[key].b * w.beach;
  }
}

// ---------------------------------------------------------------------------
// Shared prop geometry/materials — cloned into chunks, NEVER disposed.
// ---------------------------------------------------------------------------
const smat = (color: number, rough = 0.9) =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });

const GEO = {
  trunk: new THREE.CylinderGeometry(0.14, 0.2, 1.1, 6),
  cone: new THREE.ConeGeometry(1, 1, 7),
  rock: new THREE.IcosahedronGeometry(1, 0),
  box: new THREE.BoxGeometry(1, 1, 1),
  roof: new THREE.ConeGeometry(1, 1, 4),
  sphere: new THREE.SphereGeometry(1, 10, 8),
  frond: new THREE.ConeGeometry(0.09, 1.7, 5),
};

const MAT = {
  trunk: smat(0x7a4a2b),
  palmTrunk: smat(0x9c6b3f),
  pine1: smat(0x2f7d3f),
  pine2: smat(0x3c9a4e),
  rock: smat(0x8d8fa0),
  roof: smat(0xc94f4f, 0.8),
  door: smat(0x6b4226),
  frond: smat(0x3fae5a),
  bush: smat(0x4d9e45),
  mountain: smat(0x6b5d84, 1),
  snow: smat(0xf0eef7, 1),
  lampPole: smat(0x44485a, 0.5),
  lampGlow: new THREE.MeshBasicMaterial({ color: 0xffe9a8 }),
  // Self-lit so clouds stay fluffy-white regardless of sun angle (fog still tints)
  cloud: new THREE.MeshBasicMaterial({ color: 0xfff6ec }),
  sand: smat(0xf0dfae),
  houses: [0xf2c9a8, 0xc9e4f2, 0xf2e3c9, 0xe8c9f2, 0xfad4d4].map((c) => smat(c)),
  umbrella: [0xff6b6b, 0x4d96ff, 0xffd93d].map((c) => smat(c, 0.7)),
};

function makePine(rng: () => number): THREE.Group {
  const g = new THREE.Group();
  const scale = 0.8 + rng() * 0.9;
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
  g.scale.setScalar(scale);
  return g;
}

function makeRock(rng: () => number): THREE.Mesh {
  const m = new THREE.Mesh(GEO.rock, MAT.rock);
  const s = 0.35 + rng() * 0.9;
  m.scale.set(s * (0.8 + rng() * 0.5), s * 0.7, s);
  m.position.y = s * 0.4;
  m.rotation.y = rng() * Math.PI;
  m.castShadow = true;
  return m;
}

function makeHouse(rng: () => number): THREE.Group {
  const g = new THREE.Group();
  const w = 2.6 + rng() * 1.4;
  const h = 2.2 + rng() * 1;
  const body = new THREE.Mesh(GEO.box, MAT.houses[Math.floor(rng() * MAT.houses.length)]);
  body.scale.set(w, h, w * 0.9);
  body.position.y = h / 2;
  body.castShadow = true;
  const roof = new THREE.Mesh(GEO.roof, MAT.roof);
  roof.scale.set(w * 0.8, 1.3, w * 0.72);
  roof.position.y = h + 0.65;
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  const door = new THREE.Mesh(GEO.box, MAT.door);
  door.scale.set(0.6, 1.1, 0.1);
  door.position.set(0, 0.55, w * 0.45 + 0.02);
  g.add(body, roof, door);
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

function makePalm(rng: () => number): THREE.Group {
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

function makeUmbrella(rng: () => number): THREE.Group {
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

function makeBackdropMountain(rng: () => number): THREE.Group {
  const g = new THREE.Group();
  const h = 20 + rng() * 22;
  const r = h * (1.1 + rng() * 0.5);
  const body = new THREE.Mesh(GEO.cone, MAT.mountain);
  body.scale.set(r, h, r);
  body.position.y = h / 2 - 1;
  const cap = new THREE.Mesh(GEO.cone, MAT.snow);
  cap.scale.set(r * 0.28, h * 0.26, r * 0.28);
  cap.position.y = h - h * 0.13 - 1;
  g.add(body, cap);
  return g;
}

// ---------------------------------------------------------------------------
// Chunk
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
  groundMat: THREE.MeshStandardMaterial;
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

export class World {
  private scene: THREE.Scene;
  private env: WorldEnv;
  private delegate: ChunkDelegate;
  private chunks = new Map<number, Chunk>();
  private skyMat: THREE.ShaderMaterial;
  private sky: THREE.Mesh;
  private sunBall: THREE.Mesh;
  private clouds: THREE.Group[] = [];
  private palette: Palette = {
    skyTop: new THREE.Color(),
    skyBottom: new THREE.Color(),
    fog: new THREE.Color(),
    ground: new THREE.Color(),
    sun: new THREE.Color(),
  };
  private worldSeed: number;

  readonly centerXAt = centerXAt;

  constructor(scene: THREE.Scene, env: WorldEnv, delegate: ChunkDelegate, seed = 1234) {
    this.scene = scene;
    this.env = env;
    this.delegate = delegate;
    this.worldSeed = seed;

    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x7b5bd6) },
        bottomColor: { value: new THREE.Color(0xffab6b) },
        exponent: { value: 0.7 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform float exponent;
        varying vec3 vDir;
        void main() {
          float h = max(vDir.y, 0.0);
          gl_FragColor = vec4(mix(bottomColor, topColor, pow(h, exponent)), 1.0);
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(850, 24, 12), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    scene.add(this.sky);

    this.sunBall = new THREE.Mesh(
      new THREE.SphereGeometry(38, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xfff3d6, fog: false }),
    );
    scene.add(this.sunBall);

    // A drifting flotilla of clouds, recycled as the rider passes them
    const cloudRng = mulberry32(999);
    for (let i = 0; i < 9; i++) {
      const cloud = new THREE.Group();
      const n = 3 + Math.floor(cloudRng() * 3);
      for (let b = 0; b < n; b++) {
        const puff = new THREE.Mesh(GEO.sphere, MAT.cloud);
        const s = 2.2 + cloudRng() * 2.6;
        puff.scale.set(s * 1.5, s * 0.85, s);
        puff.position.set((b - n / 2) * s * 1.35, cloudRng() * 1.2, cloudRng() * 2);
        cloud.add(puff);
      }
      cloud.position.set((cloudRng() - 0.5) * 200, 26 + cloudRng() * 22, i * 60);
      scene.add(cloud);
      this.clouds.push(cloud);
    }
  }

  groundColorAt(z: number): THREE.Color {
    const w = themeWeightsAt(z);
    const c = new THREE.Color();
    blendPalette(w, this.palette);
    c.copy(this.palette.ground);
    return c;
  }

  /** Keep chunks alive around the rider; blend environment colors. */
  update(riderZ: number, camera: THREE.Camera, dt: number): void {
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
    (this.skyMat.uniforms.topColor.value as THREE.Color).copy(this.palette.skyTop);
    (this.skyMat.uniforms.bottomColor.value as THREE.Color).copy(this.palette.skyBottom);
    this.env.fog.color.copy(this.palette.fog);
    this.env.hemi.color.copy(this.palette.skyTop).lerp(new THREE.Color(0xffffff), 0.5);
    this.env.hemi.groundColor.copy(this.palette.ground).multiplyScalar(0.7);
    this.env.sun.color.copy(this.palette.sun);

    // Sky + sun follow the camera so the dome never ends
    const camPos = new THREE.Vector3();
    camera.getWorldPosition(camPos);
    this.sky.position.set(camPos.x, 0, camPos.z);
    this.sunBall.position.set(camPos.x - 260, 105, camPos.z + 690);

    // Clouds drift; recycle any that fall behind
    for (const cloud of this.clouds) {
      cloud.position.x += dt * 0.6;
      if (cloud.position.z < riderZ - 60) {
        cloud.position.z = riderZ + 380 + Math.random() * 120;
        cloud.position.x = centerXAt(cloud.position.z) + (Math.random() - 0.5) * 220;
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

    // ---- ground strip ------------------------------------------------------
    const groundGeo = new THREE.PlaneGeometry(340, CHUNK_LEN + 2);
    owned.push(groundGeo);
    blendPalette(weights, this.palette);
    const groundMat = new THREE.MeshStandardMaterial({
      color: this.palette.ground.clone(),
      roughness: 1,
      metalness: 0,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(centerXAt(z0 + CHUNK_LEN / 2), -0.05, z0 + CHUNK_LEN / 2);
    ground.receiveShadow = true;
    group.add(ground);

    // ---- road ribbon with baked-in edge stripes (one draw call) ------------
    group.add(this.buildRoadRibbon(z0, z1, owned));
    group.add(this.buildCenterDashes(z0, z1, owned));

    // ---- scenery ------------------------------------------------------------
    this.scatterProps(group, rng, z0, z1, weights);

    this.scene.add(group);
    const chunk: Chunk = { index, z0, z1, rng, group, weights, owned, groundMat };
    this.chunks.set(index, chunk);
    this.delegate.populate(chunk);
  }

  private buildRoadRibbon(z0: number, z1: number, owned: THREE.BufferGeometry[]): THREE.Mesh {
    const STEP = 2.5;
    const rows = Math.round((z1 - z0) / STEP) + 1;
    const asphalt = new THREE.Color(0x3d4250);
    const white = new THREE.Color(0xf5f2e8);
    const shoulder = new THREE.Color(0x565b68);
    // Cross-section offsets + colors; duplicated verts give hard stripe edges.
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
      // subtle per-row shade so the asphalt doesn't read flat
      const shade = 0.94 + ((r * 7919) % 13) / 13 * 0.06;
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 3;
        positions[i] = cx + xs[c];
        positions[i + 1] = 0.02;
        positions[i + 2] = z;
        colors[i] = cs[c].r * shade;
        colors[i + 1] = cs[c].g * shade;
        colors[i + 2] = cs[c].b * shade;
      }
    }
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        indices.push(a, d, b, b, d, e);
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
    _z1: number,
    w: ThemeWeights,
  ): void {
    const pickTheme = (): keyof ThemeWeights => {
      const r = rng();
      if (r < w.mountain) return 'mountain';
      if (r < w.mountain + w.town) return 'town';
      return 'beach';
    };

    // Near props (cast shadows)
    const nearCount = 9 + Math.floor(rng() * 4);
    for (let i = 0; i < nearCount; i++) {
      const z = z0 + rng() * CHUNK_LEN;
      const side = rng() > 0.5 ? 1 : -1;
      const off = 9 + rng() * 22;
      const theme = pickTheme();
      let prop: THREE.Object3D;
      if (theme === 'mountain') {
        prop = rng() > 0.25 ? makePine(rng) : makeRock(rng);
      } else if (theme === 'town') {
        const r = rng();
        prop = r > 0.55 ? makeHouse(rng) : r > 0.25 ? makeBush(rng) : makeLamp();
      } else {
        const r = rng();
        prop = r > 0.5 ? makePalm(rng) : r > 0.2 ? makeUmbrella(rng) : makeRock(rng);
      }
      prop.position.set(centerXAt(z) + side * off, 0, z);
      group.add(prop);
    }

    // Backdrop mountains, fading in with the mountain theme
    if (w.mountain > 0.25) {
      for (let i = 0; i < 3; i++) {
        const z = z0 + rng() * CHUNK_LEN;
        const side = rng() > 0.5 ? 1 : -1;
        const m = makeBackdropMountain(rng);
        m.position.set(centerXAt(z) + side * (70 + rng() * 70), 0, z + 60);
        group.add(m);
      }
    }
  }

  private disposeChunk(chunk: Chunk): void {
    this.delegate.depopulate(chunk.index);
    this.scene.remove(chunk.group);
    for (const geo of chunk.owned) geo.dispose();
    chunk.groundMat.dispose();
  }
}
