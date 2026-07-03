// Particles + confetti. Points-based pools (one draw call each) so bursts of
// dust, splashes and sparkles stay inside the render budget.

import * as THREE from 'three';

let circleTex: THREE.CanvasTexture | null = null;

/** Soft radial-gradient sprite, generated once (no asset files). */
function getCircleTexture(): THREE.CanvasTexture {
  if (circleTex) return circleTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.7)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  circleTex = new THREE.CanvasTexture(c);
  return circleTex;
}

interface ParticleOpts {
  capacity: number;
  size: number;
  additive?: boolean;
  gravity?: number;
  drag?: number;
}

export class ParticlePool {
  readonly points: THREE.Points;

  private capacity: number;
  private positions: Float32Array;
  private colors: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private baseR: Float32Array;
  private baseG: Float32Array;
  private baseB: Float32Array;
  private cursor = 0;
  private gravity: number;
  private drag: number;
  private geometry: THREE.BufferGeometry;

  constructor(scene: THREE.Scene, opts: ParticleOpts) {
    this.capacity = opts.capacity;
    this.gravity = opts.gravity ?? 0;
    this.drag = opts.drag ?? 0;
    this.positions = new Float32Array(this.capacity * 3);
    this.colors = new Float32Array(this.capacity * 3);
    this.vel = new Float32Array(this.capacity * 3);
    this.life = new Float32Array(this.capacity);
    this.maxLife = new Float32Array(this.capacity);
    this.baseR = new Float32Array(this.capacity);
    this.baseG = new Float32Array(this.capacity);
    this.baseB = new Float32Array(this.capacity);
    // Park dead particles far underground
    for (let i = 0; i < this.capacity; i++) this.positions[i * 3 + 1] = -1000;

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));

    const material = new THREE.PointsMaterial({
      size: opts.size,
      map: getCircleTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  spawn(
    pos: THREE.Vector3,
    vel: THREE.Vector3,
    life: number,
    color: THREE.Color,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.positions[i * 3] = pos.x;
    this.positions[i * 3 + 1] = pos.y;
    this.positions[i * 3 + 2] = pos.z;
    this.vel[i * 3] = vel.x;
    this.vel[i * 3 + 1] = vel.y;
    this.vel[i * 3 + 2] = vel.z;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.baseR[i] = color.r;
    this.baseG[i] = color.g;
    this.baseB[i] = color.b;
  }

  burst(
    pos: THREE.Vector3,
    count: number,
    speed: number,
    life: number,
    color: THREE.Color,
    upBias = 0.5,
  ): void {
    const v = new THREE.Vector3();
    for (let n = 0; n < count; n++) {
      v.set(
        (Math.random() - 0.5) * 2,
        Math.random() * upBias * 2,
        (Math.random() - 0.5) * 2,
      )
        .normalize()
        .multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      this.spawn(pos, v, life * (0.6 + Math.random() * 0.7), color);
    }
  }

  update(dt: number): void {
    const drag = Math.max(0, 1 - this.drag * dt);
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.positions[i * 3 + 1] = -1000;
        continue;
      }
      this.vel[i * 3] *= drag;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * drag - this.gravity * dt;
      this.vel[i * 3 + 2] *= drag;
      this.positions[i * 3] += this.vel[i * 3] * dt;
      this.positions[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      // Fade by scaling color toward black (additive) / sky-ish (normal)
      const f = this.life[i] / this.maxLife[i];
      this.colors[i * 3] = this.baseR[i] * f;
      this.colors[i * 3 + 1] = this.baseG[i] * f;
      this.colors[i * 3 + 2] = this.baseB[i] * f;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }
}

const CONFETTI_COLORS = [0xff5a5a, 0xffd93d, 0x6bcb77, 0x4d96ff, 0xff8fab, 0xb388ff].map(
  (c) => new THREE.Color(c),
);

export class Confetti {
  private mesh: THREE.InstancedMesh;
  private capacity: number;
  private pos: Float32Array;
  private vel: Float32Array;
  private rot: Float32Array; // euler xyz
  private rotVel: Float32Array;
  private life: Float32Array;
  private dummy = new THREE.Object3D();

  constructor(scene: THREE.Scene, capacity = 320) {
    this.capacity = capacity;
    const geo = new THREE.PlaneGeometry(0.14, 0.2);
    const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.rot = new Float32Array(capacity * 3);
    this.rotVel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    for (let i = 0; i < capacity; i++) {
      this.dummy.position.set(0, -1000, 0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.mesh.setColorAt(i, CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    scene.add(this.mesh);
  }

  burst(center: THREE.Vector3, count = 200): void {
    let spawned = 0;
    for (let i = 0; i < this.capacity && spawned < count; i++) {
      if (this.life[i] > 0) continue;
      spawned++;
      this.life[i] = 2.5 + Math.random() * 1.5;
      this.pos[i * 3] = center.x + (Math.random() - 0.5) * 6;
      this.pos[i * 3 + 1] = center.y + Math.random() * 2;
      this.pos[i * 3 + 2] = center.z + (Math.random() - 0.5) * 2;
      this.vel[i * 3] = (Math.random() - 0.5) * 7;
      this.vel[i * 3 + 1] = 5 + Math.random() * 6;
      this.vel[i * 3 + 2] = (Math.random() - 0.5) * 7;
      for (let a = 0; a < 3; a++) {
        this.rot[i * 3 + a] = Math.random() * Math.PI * 2;
        this.rotVel[i * 3 + a] = (Math.random() - 0.5) * 12;
      }
    }
  }

  update(dt: number): void {
    let any = false;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= 7 * dt; // gentle gravity — confetti flutters
      this.vel[i * 3] *= 1 - 0.8 * dt;
      this.vel[i * 3 + 2] *= 1 - 0.8 * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      for (let a = 0; a < 3; a++) this.rot[i * 3 + a] += this.rotVel[i * 3 + a] * dt;

      if (this.life[i] <= 0 || this.pos[i * 3 + 1] < -1) {
        this.life[i] = 0;
        this.dummy.position.set(0, -1000, 0);
      } else {
        this.dummy.position.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
        this.dummy.rotation.set(this.rot[i * 3], this.rot[i * 3 + 1], this.rot[i * 3 + 2]);
      }
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** All effect systems bundled, so game code can say fx.dust.burst(...). */
export class Effects {
  readonly dust: ParticlePool;
  readonly splash: ParticlePool;
  readonly sparkle: ParticlePool;
  readonly confetti: Confetti;

  constructor(scene: THREE.Scene) {
    this.dust = new ParticlePool(scene, { capacity: 220, size: 0.5, gravity: 2, drag: 1.5 });
    this.splash = new ParticlePool(scene, { capacity: 180, size: 0.35, gravity: 9, drag: 0.4 });
    this.sparkle = new ParticlePool(scene, {
      capacity: 260,
      size: 0.4,
      additive: true,
      gravity: -0.5,
      drag: 1.2,
    });
    this.confetti = new Confetti(scene);
  }

  update(dt: number): void {
    this.dust.update(dt);
    this.splash.update(dt);
    this.sparkle.update(dt);
    this.confetti.update(dt);
  }
}
