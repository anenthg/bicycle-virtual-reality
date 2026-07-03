// Soft, funny obstacles (spec §5): tumbling hay bales, splash puddles,
// scatterable cones, solid parked scooters, and chickens that always flap
// away in time. Dynamics via Rapier; the rider itself never becomes a
// dynamic body.

import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { CHUNK_LEN, clamp } from '../shared/types';
import type { ChunkInfo } from './world';
import { centerXAt } from './world';

type RapierApi = typeof RAPIER;

export type ObstacleKind = 'bale' | 'puddle' | 'cone' | 'scooter' | 'chicken';

export interface HitEvent {
  kind: ObstacleKind;
  pos: THREE.Vector3;
  /** 'splash' for puddles, 'soft' for cones, 'crash' for bales/scooters. */
  severity: 'splash' | 'soft' | 'crash';
}

interface Obstacle {
  kind: ObstacleKind;
  mesh: THREE.Object3D;
  chunkIndex: number;
  x: number;
  z: number;
  radius: number;
  height: number;
  hitCooldown: number;
  body: RAPIER.RigidBody | null;
  staticBody?: RAPIER.RigidBody;
  shadow?: THREE.Mesh; // scene-level decal that must not inherit tumbling
  // interpolation snapshots for dynamic bodies
  prevPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
  currPos: THREE.Vector3;
  currQuat: THREE.Quaternion;
  // chicken brain
  fleeing?: boolean;
  fleeDir?: number;
  animPhase?: number;
  wings?: THREE.Object3D[];
}

const mat = (color: number, rough = 0.85) =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.02 });

const MATS = {
  hay: mat(0xe3c25c),
  hayBand: mat(0xb98f3e),
  cone: mat(0xff7f2a, 0.7),
  coneBand: mat(0xfff3e0, 0.6),
  puddle: new THREE.MeshStandardMaterial({
    color: 0x5fb6dc,
    roughness: 0.15,
    metalness: 0.3,
    transparent: true,
    opacity: 0.72,
  }),
  scooterBody: mat(0x53d8c9, 0.5),
  scooterDark: mat(0x2f3542, 0.6),
  chickenBody: mat(0xfdfdf5, 0.9),
  chickenComb: mat(0xe8443a, 0.8),
  chickenBeak: mat(0xffab3d, 0.7),
  blob: new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  }),
};

/** Telegraphing shadow decal under an obstacle (spec: shadow decals). */
function blobShadow(radius: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CircleGeometry(radius, 16), MATS.blob);
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.012;
  return m;
}

function makeBaleMesh(): THREE.Group {
  const g = new THREE.Group();
  const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.05, 14), MATS.hay);
  roll.rotation.z = Math.PI / 2;
  roll.castShadow = true;
  g.add(roll);
  for (const off of [-0.3, 0.05, 0.38]) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.025, 6, 18), MATS.hayBand);
    band.rotation.y = Math.PI / 2;
    band.position.x = off;
    g.add(band);
  }
  return g;
}

function makeConeMesh(): THREE.Group {
  const g = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.62, 10), MATS.cone);
  cone.position.y = 0.06;
  cone.castShadow = true;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.09, 10), MATS.coneBand);
  band.position.y = 0.13;
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 0.42), MATS.cone);
  base.position.y = -0.23;
  g.add(cone, band, base);
  // center the group on its collider center (y=0 at collider middle)
  g.children.forEach((c) => (c.position.y += 0.0));
  return g;
}

function makeScooterMesh(): THREE.Group {
  const g = new THREE.Group();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.08, 1.1), MATS.scooterBody);
  deck.position.y = 0.16;
  deck.castShadow = true;
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.95, 8), MATS.scooterDark);
  column.position.set(0, 0.62, 0.48);
  column.rotation.x = -0.25;
  const bars = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 8), MATS.scooterBody);
  bars.rotation.z = Math.PI / 2;
  bars.position.set(0, 1.06, 0.36);
  const wheelGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.05, 12);
  for (const z of [-0.48, 0.52]) {
    const w = new THREE.Mesh(wheelGeo, MATS.scooterDark);
    w.rotation.z = Math.PI / 2;
    w.position.set(0, 0.12, z);
    g.add(w);
  }
  // kickstand lean
  g.add(deck, column, bars);
  g.rotation.z = 0.12;
  return g;
}

function makeChickenMesh(): { group: THREE.Group; wings: THREE.Object3D[] } {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), MATS.chickenBody);
  body.position.y = 0.3;
  body.scale.set(1, 0.9, 1.25);
  body.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), MATS.chickenBody);
  head.position.set(0, 0.58, 0.2);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.12, 6), MATS.chickenBeak);
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 0.57, 0.34);
  const comb = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.1, 0.12), MATS.chickenComb);
  comb.position.set(0, 0.71, 0.18);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.22, 6), MATS.chickenBody);
  tail.rotation.x = -Math.PI / 2.6;
  tail.position.set(0, 0.42, -0.28);
  const wings: THREE.Object3D[] = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.2, 0.38, 0);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.04, 0.3), MATS.chickenBody);
    wing.position.x = side * 0.13;
    pivot.add(wing);
    wings.push(pivot);
    g.add(pivot);
  }
  const legGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.16, 5);
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(legGeo, MATS.chickenBeak);
    leg.position.set(side * 0.08, 0.1, 0);
    g.add(leg);
  }
  g.add(body, head, beak, comb, tail);
  return { group: g, wings };
}

export class ObstacleManager {
  godMode = false;

  private scene: THREE.Scene;
  private rapier: RapierApi;
  private phys: RAPIER.World;
  private obstacles: Obstacle[] = [];

  constructor(scene: THREE.Scene, rapier: RapierApi, phys: RAPIER.World) {
    this.scene = scene;
    this.rapier = rapier;
    this.phys = phys;
  }

  populate(chunk: ChunkInfo, riderZ: number, gatesPassed: number): void {
    const { rng, index, z0 } = chunk;
    // Difficulty: density keyed to distance, capped low (target age 4–8).
    const count = index < 1 ? 0 : Math.min(1 + Math.floor(index * 0.45), 4);

    // Pre-pick z slots with generous spacing so no wall of obstacles forms.
    const slots: number[] = [];
    for (let i = 0; i < count; i++) {
      const z = z0 + ((i + 0.5) / count) * CHUNK_LEN + (rng() - 0.5) * 14;
      // Telegraph rule: never materialize anything closer than 60 m ahead.
      if (z < riderZ + 60) continue;
      slots.push(z);
    }

    for (const z of slots) {
      const r = rng();
      const scootersAllowed = gatesPassed >= 1; // scooters only after first gate
      if (r < 0.28) this.spawnBale(index, z, rng);
      else if (r < 0.48) this.spawnPuddle(index, z, rng);
      else if (r < 0.72) this.spawnConeCluster(index, z, rng);
      else if (r < 0.85 && scootersAllowed) this.spawnScooter(index, z, rng);
      else this.spawnChicken(index, z, rng);
    }

    // Bonus roadside chicken now and then — pure comedy, costs nothing
    if (rng() < 0.4) this.spawnChicken(index, z0 + rng() * CHUNK_LEN, rng, true);
  }

  depopulate(index: number): void {
    const keep: Obstacle[] = [];
    for (const o of this.obstacles) {
      if (o.chunkIndex === index) this.destroy(o);
      else keep.push(o);
    }
    this.obstacles = keep;
  }

  reset(): void {
    for (const o of this.obstacles) this.destroy(o);
    this.obstacles = [];
  }

  /** Fixed-step: chicken AI, dynamic-body snapshots, hit detection. */
  step(
    dt: number,
    rider: { x: number; z: number; y: number; airborne: boolean },
    speed: number,
  ): HitEvent[] {
    const events: HitEvent[] = [];
    for (const o of this.obstacles) {
      o.hitCooldown = Math.max(0, o.hitCooldown - dt);

      // Snapshot dynamic bodies for interpolation
      if (o.body) {
        o.prevPos.copy(o.currPos);
        o.prevQuat.copy(o.currQuat);
        const t = o.body.translation();
        const q = o.body.rotation();
        o.currPos.set(t.x, t.y, t.z);
        o.currQuat.set(q.x, q.y, q.z, q.w);
        o.x = t.x;
        o.z = t.z;
      }

      // Chicken: flee LONG before the rider arrives — never hittable
      if (o.kind === 'chicken') {
        const dz = o.z - rider.z;
        const dx = o.x - rider.x;
        if (!o.fleeing && dz < 26 && dz > -4 && Math.abs(dx) < 5) {
          o.fleeing = true;
          o.fleeDir = Math.sign(o.x - centerXAt(o.z)) || 1;
          events.push({ kind: 'chicken', pos: o.currPos.clone().setY(0.4), severity: 'soft' });
        }
        if (o.fleeing) {
          o.x += o.fleeDir! * 7.5 * dt;
          o.z += 2.5 * dt;
          o.mesh.position.x = o.x;
          o.mesh.position.z = o.z;
          o.mesh.position.y = Math.abs(Math.sin(performance.now() * 0.02)) * 0.35;
          o.mesh.rotation.y = o.fleeDir! > 0 ? Math.PI / 2 : -Math.PI / 2;
        }
        continue;
      }

      if (this.godMode || o.hitCooldown > 0) continue;

      // Cheap 2D proximity gate, then real overlap test
      const dz = Math.abs(o.z - rider.z);
      if (dz > 3.5) continue;
      const dx = o.x - rider.x;
      const dist2d = Math.hypot(dx, o.z - rider.z);
      if (dist2d > o.radius + 0.55) continue;
      if (rider.y > o.height + 0.15) continue; // hopped clean over it

      o.hitCooldown = 1.6;
      const pos = new THREE.Vector3(o.x, 0.5, o.z);
      if (o.kind === 'puddle') {
        events.push({ kind: o.kind, pos, severity: 'splash' });
      } else if (o.kind === 'cone') {
        events.push({ kind: o.kind, pos, severity: 'soft' });
        this.punt(o, dx, speed, 0.35);
      } else if (o.kind === 'bale') {
        events.push({ kind: o.kind, pos, severity: 'crash' });
        this.punt(o, dx, speed, 1.6);
      } else {
        events.push({ kind: o.kind, pos, severity: 'crash' });
      }
    }
    return events;
  }

  /** Per-render-frame: interpolate dynamics, animate chickens/puddles. */
  visualUpdate(alpha: number, elapsed: number): void {
    for (const o of this.obstacles) {
      if (o.body) {
        o.mesh.position.lerpVectors(o.prevPos, o.currPos, alpha);
        o.mesh.quaternion.slerpQuaternions(o.prevQuat, o.currQuat, alpha);
      }
      if (o.kind === 'chicken') {
        o.animPhase = (o.animPhase ?? 0) + 0.016;
        const flap = o.fleeing
          ? Math.sin(elapsed * 28) * 1.1
          : Math.sin(elapsed * 3 + o.z) * 0.12; // idle rustle
        o.wings?.forEach((w, i) => (w.rotation.z = (i === 0 ? 1 : -1) * (0.2 + Math.abs(flap))));
        if (!o.fleeing) {
          // idle peck
          o.mesh.rotation.x = Math.max(0, Math.sin(elapsed * 1.7 + o.x)) * 0.25;
        }
      }
      if (o.kind === 'puddle') {
        const s = 1 + Math.sin(elapsed * 2 + o.z * 0.5) * 0.03;
        o.mesh.scale.set(s, 1, s);
      }
    }
  }

  // -------------------------------------------------------------------------

  private punt(o: Obstacle, dx: number, speed: number, mass: number): void {
    if (!o.body) return;
    const side = Math.sign(-dx) || (Math.random() > 0.5 ? 1 : -1);
    o.body.wakeUp();
    o.body.applyImpulse(
      { x: side * 2.2 * mass, y: 2.8 * mass, z: clamp(speed * 0.45, 4, 11) * mass },
      true,
    );
    o.body.applyTorqueImpulse(
      { x: mass * (1 + Math.random()), y: 0, z: mass * (Math.random() - 0.5) },
      true,
    );
  }

  private baseObstacle(
    kind: ObstacleKind,
    chunkIndex: number,
    mesh: THREE.Object3D,
    x: number,
    z: number,
    radius: number,
    height: number,
  ): Obstacle {
    const o: Obstacle = {
      kind,
      mesh,
      chunkIndex,
      x,
      z,
      radius,
      height,
      hitCooldown: 0,
      body: null,
      prevPos: new THREE.Vector3(x, 0, z),
      prevQuat: new THREE.Quaternion(),
      currPos: new THREE.Vector3(x, 0, z),
      currQuat: new THREE.Quaternion(),
    };
    this.scene.add(mesh);
    this.obstacles.push(o);
    return o;
  }

  private laneX(z: number, rng: () => number): number {
    return centerXAt(z) + (rng() * 2 - 1) * 4.2;
  }

  private spawnBale(chunkIndex: number, z: number, rng: () => number): void {
    const x = this.laneX(z, rng);
    const mesh = makeBaleMesh();
    const shadow = blobShadow(1);
    shadow.position.set(x, 0.012, z);
    this.scene.add(shadow);

    const body = this.phys.createRigidBody(
      this.rapier.RigidBodyDesc.dynamic().setTranslation(x, 0.56, z).setLinearDamping(0.4),
    );
    const collDesc = this.rapier.ColliderDesc.cylinder(0.52, 0.55)
      .setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 })
      .setDensity(0.35)
      .setFriction(0.9);
    this.phys.createCollider(collDesc, body);

    const o = this.baseObstacle('bale', chunkIndex, mesh, x, z, 0.95, 1.1);
    o.shadow = shadow;
    o.body = body;
    o.currPos.set(x, 0.56, z);
    o.prevPos.copy(o.currPos);
    mesh.position.copy(o.currPos);
  }

  private spawnPuddle(chunkIndex: number, z: number, rng: () => number): void {
    const x = this.laneX(z, rng);
    const r = 1.5 + rng() * 0.9;
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(1, 22), MATS.puddle);
    mesh.rotation.x = -Math.PI / 2;
    mesh.scale.setScalar(r);
    mesh.position.set(x, 0.035, z);
    const o = this.baseObstacle('puddle', chunkIndex, mesh, x, z, r * 0.85, 0.3);
    o.mesh.scale.set(r, r, r); // uniform so visualUpdate ripple works
  }

  private spawnConeCluster(chunkIndex: number, z: number, rng: () => number): void {
    const cx = this.laneX(z, rng);
    const n = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) {
      const x = cx + (rng() - 0.5) * 1.6;
      const cz = z + (rng() - 0.5) * 2.5;
      const mesh = makeConeMesh();
      const shadow = blobShadow(0.45);
      shadow.position.set(x, 0.012, cz);
      this.scene.add(shadow);

      const body = this.phys.createRigidBody(
        this.rapier.RigidBodyDesc.dynamic().setTranslation(x, 0.33, cz).setLinearDamping(0.6),
      );
      this.phys.createCollider(
        this.rapier.ColliderDesc.cylinder(0.33, 0.22).setDensity(0.25).setFriction(0.8),
        body,
      );
      const o = this.baseObstacle('cone', chunkIndex, mesh, x, cz, 0.42, 0.62);
      o.shadow = shadow;
      o.body = body;
      o.currPos.set(x, 0.33, cz);
      o.prevPos.copy(o.currPos);
      mesh.position.copy(o.currPos);
    }
  }

  private spawnScooter(chunkIndex: number, z: number, rng: () => number): void {
    const x = this.laneX(z, rng);
    const mesh = makeScooterMesh();
    mesh.position.set(x, 0, z);
    mesh.rotation.y = rng() * Math.PI * 2;
    mesh.add(blobShadow(0.9));
    // Static Rapier body so knocked props bounce off it believably
    const body = this.phys.createRigidBody(
      this.rapier.RigidBodyDesc.fixed().setTranslation(x, 0.5, z),
    );
    this.phys.createCollider(this.rapier.ColliderDesc.cuboid(0.4, 0.5, 0.6), body);
    const o = this.baseObstacle('scooter', chunkIndex, mesh, x, z, 0.85, 1.1);
    o.staticBody = body; // fixed body — no interpolation, cleaned up on destroy
  }

  private spawnChicken(
    chunkIndex: number,
    z: number,
    rng: () => number,
    roadside = false,
  ): void {
    const cx = centerXAt(z);
    const x = roadside
      ? cx + (rng() > 0.5 ? 1 : -1) * (5.4 + rng() * 2)
      : cx + (rng() * 2 - 1) * 3.5;
    const { group, wings } = makeChickenMesh();
    group.position.set(x, 0, z);
    group.rotation.y = rng() * Math.PI * 2;
    const o = this.baseObstacle('chicken', chunkIndex, group, x, z, 0, 0);
    o.wings = wings;
    o.fleeing = false;
  }

  private destroy(o: Obstacle): void {
    this.scene.remove(o.mesh);
    // Dispose only geometry we own per-instance (all these are per-instance)
    o.mesh.traverse((child) => {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    });
    if (o.shadow) {
      this.scene.remove(o.shadow);
      o.shadow.geometry.dispose();
    }
    if (o.body) this.phys.removeRigidBody(o.body);
    if (o.staticBody) this.phys.removeRigidBody(o.staticBody);
  }
}
