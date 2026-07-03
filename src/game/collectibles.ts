// Stars (in trails that teach good lines), magnet power-up, and launch ramps
// with mid-air star arcs (spec §5).

import * as THREE from 'three';
import { CHUNK_LEN, GRAVITY, clamp } from '../shared/types';
import type { ChunkInfo } from './world';
import { centerXAt } from './world';

// ---------------------------------------------------------------------------
// Shared geometry/materials (never disposed)
// ---------------------------------------------------------------------------
function makeStarGeometry(): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  const outer = 0.42;
  const inner = 0.18;
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.12,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.04,
    bevelSegments: 1,
  });
  geo.center();
  return geo;
}

const STAR_GEO = makeStarGeometry();
const STAR_MAT = new THREE.MeshStandardMaterial({
  color: 0xffd23f,
  emissive: 0xa87a00,
  emissiveIntensity: 0.55,
  roughness: 0.35,
  metalness: 0.4,
});

const MAGNET_MAT_RED = new THREE.MeshStandardMaterial({ color: 0xe8443a, roughness: 0.5 });
const MAGNET_MAT_TIP = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 });

const RAMP_MAT = new THREE.MeshStandardMaterial({ color: 0xff8c42, roughness: 0.7 });
const RAMP_STRIPE = new THREE.MeshStandardMaterial({ color: 0xfff3e0, roughness: 0.7 });

function makeMagnetMesh(): THREE.Group {
  const g = new THREE.Group();
  const arc = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.11, 8, 14, Math.PI), MAGNET_MAT_RED);
  arc.rotation.z = Math.PI;
  const tipGeo = new THREE.BoxGeometry(0.13, 0.2, 0.13);
  for (const side of [-1, 1]) {
    const tip = new THREE.Mesh(tipGeo, MAGNET_MAT_TIP);
    tip.position.set(side * 0.32, 0.1, 0);
    g.add(tip);
  }
  g.add(arc);
  g.scale.setScalar(1.15);
  return g;
}

const RAMP_W = 3.4;
const RAMP_LEN = 6;
const RAMP_H = 1.15;

function makeRampMesh(): THREE.Group {
  const g = new THREE.Group();
  // Wedge: two triangle sides + inclined top plane
  const geo = new THREE.BufferGeometry();
  const hw = RAMP_W / 2;
  // prettier-ignore
  const verts = new Float32Array([
    // top incline (two triangles)
    -hw, 0, 0,   hw, 0, 0,   hw, RAMP_H, RAMP_LEN,
    -hw, 0, 0,   hw, RAMP_H, RAMP_LEN,  -hw, RAMP_H, RAMP_LEN,
    // back face
    -hw, 0, RAMP_LEN,  -hw, RAMP_H, RAMP_LEN,   hw, RAMP_H, RAMP_LEN,
    -hw, 0, RAMP_LEN,   hw, RAMP_H, RAMP_LEN,   hw, 0, RAMP_LEN,
    // left side
    -hw, 0, 0,  -hw, RAMP_H, RAMP_LEN,  -hw, 0, RAMP_LEN,
    // right side
     hw, 0, 0,   hw, 0, RAMP_LEN,   hw, RAMP_H, RAMP_LEN,
  ]);
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.computeVertexNormals();
  const wedge = new THREE.Mesh(geo, RAMP_MAT);
  wedge.castShadow = true;
  wedge.receiveShadow = true;
  g.add(wedge);
  // white chevrons on the incline
  for (let i = 1; i <= 3; i++) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(RAMP_W * 0.72, 0.03, 0.28), RAMP_STRIPE);
    const t = i / 4;
    stripe.position.set(0, RAMP_H * t + 0.03, RAMP_LEN * t);
    stripe.rotation.x = -Math.atan2(RAMP_H, RAMP_LEN);
    g.add(stripe);
  }
  return g;
}

// ---------------------------------------------------------------------------

interface Star {
  mesh: THREE.Mesh;
  chunkIndex: number;
  collected: boolean;
  baseY: number;
  attracting: boolean;
}

interface Ramp {
  group: THREE.Group;
  chunkIndex: number;
  x: number;
  z0: number;
}

interface Magnet {
  mesh: THREE.Group;
  chunkIndex: number;
  collected: boolean;
}

export interface CollectStep {
  starPositions: THREE.Vector3[]; // world positions of stars collected this step
  magnetPicked: boolean;
}

export class CollectibleManager {
  private scene: THREE.Scene;
  private stars: Star[] = [];
  private ramps: Ramp[] = [];
  private magnets: Magnet[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  populate(chunk: ChunkInfo, riderZ: number): void {
    const { rng, index, z0 } = chunk;
    if (index < 1) return;

    // Maybe a ramp (with a star arc above it) — physics as delight
    if (rng() < 0.32 && index >= 2) {
      const z = z0 + 15 + rng() * (CHUNK_LEN - 45);
      if (z > riderZ + 60) {
        const x = centerXAt(z) + (rng() * 2 - 1) * 2.6;
        this.spawnRamp(index, x, z);
        this.spawnRampArc(index, x, z);
      }
    }

    // 1–2 star trails per chunk
    const trails = 1 + (rng() < 0.5 ? 1 : 0);
    for (let t = 0; t < trails; t++) {
      const z = z0 + 8 + rng() * (CHUNK_LEN - 30);
      if (z < riderZ + 20) continue;
      if (rng() < 0.5) this.spawnLine(index, z, rng);
      else this.spawnWeave(index, z, rng);
    }

    // Occasional magnet power-up
    if (rng() < 0.22 && index >= 3) {
      const z = z0 + rng() * CHUNK_LEN;
      if (z > riderZ + 40) this.spawnMagnet(index, z, rng);
    }
  }

  depopulate(index: number): void {
    this.stars = this.stars.filter((s) => {
      if (s.chunkIndex !== index) return true;
      this.scene.remove(s.mesh);
      return false;
    });
    this.ramps = this.ramps.filter((r) => {
      if (r.chunkIndex !== index) return true;
      this.scene.remove(r.group);
      r.group.traverse((c) => {
        if (c instanceof THREE.Mesh && c.geometry !== STAR_GEO) c.geometry.dispose();
      });
      return false;
    });
    this.magnets = this.magnets.filter((m) => {
      if (m.chunkIndex !== index) return true;
      this.scene.remove(m.mesh);
      return false;
    });
  }

  reset(): void {
    for (const s of this.stars) this.scene.remove(s.mesh);
    for (const r of this.ramps) this.scene.remove(r.group);
    for (const m of this.magnets) this.scene.remove(m.mesh);
    this.stars = [];
    this.ramps = [];
    this.magnets = [];
  }

  /** Ground height contributed by ramps (0 elsewhere). */
  groundYAt(x: number, z: number): number {
    for (const r of this.ramps) {
      if (z < r.z0 || z > r.z0 + RAMP_LEN) continue;
      if (Math.abs(x - r.x) > RAMP_W / 2) continue;
      return ((z - r.z0) / RAMP_LEN) * RAMP_H;
    }
    return 0;
  }

  /** Fixed-step: collection + magnet attraction. */
  step(
    dt: number,
    rider: { x: number; y: number; z: number },
    magnetActive: boolean,
  ): CollectStep {
    const out: CollectStep = { starPositions: [], magnetPicked: false };
    const riderPos = new THREE.Vector3(rider.x, rider.y + 0.9, rider.z);

    for (const s of this.stars) {
      if (s.collected) continue;
      const dz = s.mesh.position.z - rider.z;
      if (dz < -4 || dz > 12) continue;
      const d = s.mesh.position.distanceTo(riderPos);
      if (magnetActive && d < 8) s.attracting = true;
      if (s.attracting) {
        const pull = 26 * dt;
        s.mesh.position.lerp(riderPos, clamp(pull / Math.max(d, 0.01), 0, 1));
      }
      if (d < 1.35) {
        s.collected = true;
        out.starPositions.push(s.mesh.position.clone());
        this.scene.remove(s.mesh);
      }
    }

    for (const m of this.magnets) {
      if (m.collected) continue;
      if (Math.abs(m.mesh.position.z - rider.z) > 3) continue;
      if (m.mesh.position.distanceTo(riderPos) < 1.5) {
        m.collected = true;
        out.magnetPicked = true;
        this.scene.remove(m.mesh);
      }
    }
    return out;
  }

  /** Per-render-frame sparkle: spin + bob. */
  visualUpdate(elapsed: number): void {
    for (const s of this.stars) {
      if (s.collected || s.attracting) continue;
      s.mesh.rotation.y = elapsed * 2.4 + s.baseY;
      s.mesh.position.y = s.baseY + Math.sin(elapsed * 2.2 + s.mesh.position.z) * 0.12;
    }
    for (const m of this.magnets) {
      if (m.collected) continue;
      m.mesh.rotation.y = elapsed * 2;
      m.mesh.position.y = 1.1 + Math.sin(elapsed * 2.6) * 0.15;
    }
  }

  // -------------------------------------------------------------------------

  private addStar(chunkIndex: number, x: number, y: number, z: number): void {
    const mesh = new THREE.Mesh(STAR_GEO, STAR_MAT);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.stars.push({ mesh, chunkIndex, collected: false, baseY: y, attracting: false });
  }

  private spawnLine(chunkIndex: number, z: number, rng: () => number): void {
    const lat = (rng() * 2 - 1) * 3.6;
    for (let i = 0; i < 6; i++) {
      const sz = z + i * 3;
      this.addStar(chunkIndex, centerXAt(sz) + lat, 1.0, sz);
    }
  }

  private spawnWeave(chunkIndex: number, z: number, rng: () => number): void {
    const amp = 2.2 + rng() * 1.4;
    const phase = rng() * Math.PI * 2;
    for (let i = 0; i < 8; i++) {
      const sz = z + i * 3.2;
      const lat = Math.sin(i * 0.7 + phase) * amp;
      this.addStar(chunkIndex, centerXAt(sz) + lat, 1.0, sz);
    }
  }

  private spawnRamp(chunkIndex: number, x: number, z: number): void {
    const group = makeRampMesh();
    group.position.set(x, 0, z);
    this.scene.add(group);
    this.ramps.push({ group, chunkIndex, x, z0: z });
  }

  /** Stars along the ballistic arc a rider actually flies off this ramp. */
  private spawnRampArc(chunkIndex: number, x: number, rampZ: number): void {
    const launchZ = rampZ + RAMP_LEN;
    const v = 17; // representative forward speed
    const vy = (RAMP_H / RAMP_LEN) * v * 1.05;
    for (let i = 1; i <= 5; i++) {
      const t = i * 0.16;
      const z = launchZ + v * t;
      const y = RAMP_H + vy * t - 0.5 * GRAVITY * t * t;
      if (y < 0.8) break;
      this.addStar(chunkIndex, x, y + 0.4, z);
    }
  }

  private spawnMagnet(chunkIndex: number, z: number, rng: () => number): void {
    const mesh = makeMagnetMesh();
    mesh.position.set(centerXAt(z) + (rng() * 2 - 1) * 3.5, 1.1, z);
    this.scene.add(mesh);
    this.magnets.push({ mesh, chunkIndex, collected: false });
  }
}
