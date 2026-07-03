// The star of the show: a cheerful low-poly bike + kid built entirely from
// Three.js primitives, plus the kinematic controller that moves them.
// Rate-based steering (angle → lateral velocity) absorbs camera latency far
// better than position mapping, per spec §5.

import * as THREE from 'three';
import {
  GRAVITY,
  MAX_LAT_SPEED,
  ROAD_HALF,
  clamp,
  damp,
  lerp,
} from '../shared/types';

const WHEEL_R = 0.34;

export interface RiderStepEvents {
  landed: boolean;
  landingSpeed: number;
  edgeBump: boolean;
  hopped: boolean;
}

const mat = (color: number, rough = 0.85) =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.05 });

function makeWheel(): THREE.Group {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.TorusGeometry(WHEEL_R, 0.055, 10, 20), mat(0x2b2b33, 0.95));
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.08, 8), mat(0xcfd6e4, 0.4));
  hub.rotation.z = Math.PI / 2;
  g.add(tire, hub);
  const spokeMat = mat(0xcfd6e4, 0.4);
  for (let i = 0; i < 3; i++) {
    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, WHEEL_R * 2 - 0.08, 5), spokeMat);
    spoke.rotation.x = (i * Math.PI) / 3;
    g.add(spoke);
  }
  g.traverse((o) => (o.castShadow = true));
  return g;
}

/** Position + orient a unit-height cylinder mesh so it spans a→b. */
function stretchBetween(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3): void {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.scale.set(1, len, 1);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
}

export class Rider {
  readonly group = new THREE.Group();

  // Simulation state (fixed-step)
  z = 0;
  lateral = 0;
  latVel = 0;
  y = 0;
  vy = 0;
  airborne = false;
  x = 0;

  // Previous-step snapshot for render interpolation
  prevX = 0;
  prevY = 0;
  prevZ = 0;

  private bike = new THREE.Group();
  private frontAssembly = new THREE.Group();
  private frontWheel: THREE.Group;
  private rearWheel: THREE.Group;
  private crank = new THREE.Group();
  private pedalL = new THREE.Group();
  private pedalR = new THREE.Group();
  private legL: THREE.Mesh;
  private legR: THREE.Mesh;
  private riderBody = new THREE.Group();
  private shadowBlob: THREE.Mesh;

  private spin = 0; // wheel rotation accumulator
  private wobbleT = 0;
  private squashT = 0;
  private hopCooldown = 0;
  private lastGroundY = 0;
  private groundSlope = 0;

  constructor(scene: THREE.Scene) {
    // ---- bike frame -------------------------------------------------------
    const frameMat = mat(0xff4757, 0.55);
    const rear = new THREE.Vector3(0, WHEEL_R, -0.68);
    const front = new THREE.Vector3(0, WHEEL_R, 0.72);
    const crankPos = new THREE.Vector3(0, 0.36, -0.05);
    const seatTop = new THREE.Vector3(0, 0.95, -0.42);
    const headTop = new THREE.Vector3(0, 0.98, 0.6);

    const tube = () => new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1, 7), frameMat);
    const beams: [THREE.Vector3, THREE.Vector3][] = [
      [rear, crankPos],
      [crankPos, seatTop],
      [seatTop, headTop],
      [crankPos, headTop],
      [rear, seatTop],
    ];
    for (const [a, b] of beams) {
      const m = tube();
      stretchBetween(m, a, b);
      m.castShadow = true;
      this.bike.add(m);
    }

    // Seat
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.07, 0.34), mat(0x2f3542));
    seat.position.copy(seatTop).add(new THREE.Vector3(0, 0.05, 0));
    seat.castShadow = true;
    this.bike.add(seat);

    // ---- front assembly (fork + bars + wheel) turns with steering ---------
    this.frontAssembly.position.copy(headTop);
    const fork = tube();
    stretchBetween(
      fork,
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, WHEEL_R - headTop.y, front.z - headTop.z),
    );
    this.frontAssembly.add(fork);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.62, 7), mat(0x2f3542, 0.5));
    bar.rotation.z = Math.PI / 2;
    bar.position.y = 0.09;
    this.frontAssembly.add(bar);
    // Neon grip markers — a wink at the real tape on the real bike
    const gripL = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.09, 7), mat(0x39ff6a, 0.4));
    gripL.rotation.z = Math.PI / 2;
    gripL.position.set(-0.33, 0.09, 0);
    const gripR = gripL.clone();
    (gripR as THREE.Mesh).material = mat(0xff4fd8, 0.4);
    gripR.position.x = 0.33;
    this.frontAssembly.add(gripL, gripR);

    this.frontWheel = makeWheel();
    this.frontWheel.position.set(0, WHEEL_R - headTop.y, front.z - headTop.z);
    this.frontAssembly.add(this.frontWheel);
    this.bike.add(this.frontAssembly);

    this.rearWheel = makeWheel();
    this.rearWheel.position.copy(rear);
    this.bike.add(this.rearWheel);

    // ---- crank + pedals ----------------------------------------------------
    this.crank.position.copy(crankPos);
    const crankMat = mat(0x57606f, 0.4);
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.3, 0.05), crankMat);
      arm.position.set(side * 0.09, side * 0.075, 0); // opposite phases
      const pedal = side === -1 ? this.pedalL : this.pedalR;
      pedal.position.set(side * 0.13, side * 0.15, 0);
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.03, 0.16), mat(0x2f3542));
      pedal.add(plate);
      const holder = new THREE.Group();
      holder.add(arm, pedal);
      if (side === 1) holder.rotation.x = Math.PI; // 180° out of phase
      this.crank.add(holder);
    }
    this.bike.add(this.crank);

    // ---- kid --------------------------------------------------------------
    const skin = mat(0xffcf9e, 0.7);
    const shirt = mat(0x1fb8b2, 0.8);
    const pants = mat(0x3a4a9f, 0.85);

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.3, 6, 12), shirt);
    torso.position.set(0, 1.28, -0.18);
    torso.rotation.x = 0.32; // leaning toward the bars
    torso.castShadow = true;

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 12), skin);
    head.position.set(0, 1.62, -0.02);
    head.castShadow = true;

    // Helmet: flattened half-sphere with a little brim
    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.185, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      mat(0xffd93d, 0.5),
    );
    helmet.position.copy(head.position).add(new THREE.Vector3(0, 0.03, 0));
    helmet.scale.set(1, 0.85, 1.1);
    helmet.castShadow = true;
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.03, 0.12), mat(0xffb830, 0.5));
    brim.position.copy(head.position).add(new THREE.Vector3(0, 0.08, 0.17));

    // Arms: shoulders → grips
    const armMat = shirt;
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.045, 1, 6), armMat);
      stretchBetween(
        arm,
        new THREE.Vector3(side * 0.18, 1.42, -0.16),
        new THREE.Vector3(side * 0.3, 1.08, 0.58),
      );
      arm.castShadow = true;
      this.riderBody.add(arm);
    }

    // Legs get re-stretched every frame to follow the pedals
    this.legL = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.055, 1, 6), pants);
    this.legR = this.legL.clone() as THREE.Mesh;
    this.legL.castShadow = this.legR.castShadow = true;

    this.riderBody.add(torso, head, helmet, brim, this.legL, this.legR);
    this.bike.add(this.riderBody);

    // Soft blob shadow (in addition to the real shadow — reads at distance)
    this.shadowBlob = new THREE.Mesh(
      new THREE.CircleGeometry(0.75, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false }),
    );
    this.shadowBlob.rotation.x = -Math.PI / 2;

    this.group.add(this.bike, this.shadowBlob);
    scene.add(this.group);
  }

  /** One fixed physics step. */
  step(
    dt: number,
    steer: number,
    hop: boolean,
    speed: number,
    groundYAt: (x: number, z: number) => number,
    centerXAt: (z: number) => number,
  ): RiderStepEvents {
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;

    const ev: RiderStepEvents = { landed: false, landingSpeed: 0, edgeBump: false, hopped: false };

    this.z += speed * dt;
    this.hopCooldown = Math.max(0, this.hopCooldown - dt);

    // Rate-based steering with gentle auto-centering near zero input
    const targetLatVel = steer * MAX_LAT_SPEED;
    this.latVel = damp(this.latVel, targetLatVel, 9, dt);
    if (Math.abs(steer) < 0.06 && !this.airborne) {
      this.latVel -= clamp(this.lateral * 0.55, -1.2, 1.2) * dt * 2;
    }

    // Side-hop (Space / Phase-2 slide): quick lateral kick + a small jump
    if (hop && !this.airborne && this.hopCooldown <= 0) {
      const dir = steer !== 0 ? Math.sign(steer) : Math.sign(this.latVel) || 0;
      this.latVel += dir * 4.5;
      this.vy = 4.6;
      this.airborne = true;
      this.hopCooldown = 1;
      this.squashT = 0.001; // pre-load squash-stretch
      ev.hopped = true;
    }

    this.lateral += this.latVel * dt;
    const edge = ROAD_HALF - 0.7;
    if (Math.abs(this.lateral) > edge) {
      this.lateral = Math.sign(this.lateral) * edge;
      if (Math.abs(this.latVel) > 2.5) ev.edgeBump = true;
      this.latVel *= 0.3;
    }

    this.x = centerXAt(this.z) + this.lateral;

    const gY = groundYAt(this.x, this.z);
    if (this.airborne) {
      this.vy -= GRAVITY * dt;
      this.y += this.vy * dt;
      if (this.y <= gY && this.vy <= 0) {
        ev.landed = true;
        ev.landingSpeed = -this.vy;
        this.y = gY;
        this.vy = 0;
        this.airborne = false;
        this.squashT = 0.001;
      }
    } else {
      // Follow the ground; leaving a ramp's high edge launches us ballistic.
      const slope = (gY - this.lastGroundY) / Math.max(speed * dt, 1e-5);
      if (gY < this.y - 0.12 && this.groundSlope > 0.08) {
        this.airborne = true;
        this.vy = clamp(this.groundSlope * speed * 1.05, 2.5, 8.5);
      } else {
        this.y = gY;
        this.groundSlope = slope;
      }
    }
    this.lastGroundY = gY;

    this.spin += (speed * dt) / WHEEL_R;
    return ev;
  }

  startWobble(): void {
    this.wobbleT = 0.001;
  }

  /** Per-render-frame: interpolate between physics steps + play animations. */
  visualUpdate(alpha: number, dtRender: number, speed: number, steer: number): void {
    const x = lerp(this.prevX, this.x, alpha);
    const y = lerp(this.prevY, this.y, alpha);
    const z = lerp(this.prevZ, this.z, alpha);
    this.group.position.set(x, y, z);

    // Lean into turns; a hit adds a comedy wobble on top.
    let roll = (-this.latVel / MAX_LAT_SPEED) * THREE.MathUtils.degToRad(25);
    if (this.wobbleT > 0) {
      this.wobbleT += dtRender;
      const w = this.wobbleT;
      if (w > 0.9) this.wobbleT = 0;
      else roll += Math.sin(w * 26) * 0.3 * (1 - w / 0.9);
    }
    this.bike.rotation.z = damp(this.bike.rotation.z, roll, 12, dtRender);
    this.bike.rotation.y = damp(
      this.bike.rotation.y,
      Math.atan2(this.latVel, Math.max(speed, 4)) * 0.9,
      10,
      dtRender,
    );
    this.bike.rotation.x = this.airborne ? clamp(-this.vy * 0.045, -0.28, 0.2) :
      damp(this.bike.rotation.x, 0, 10, dtRender);

    // Squash & stretch on hop/landing
    if (this.squashT > 0) {
      this.squashT += dtRender;
      const s = this.squashT;
      if (s > 0.35) {
        this.squashT = 0;
        this.bike.scale.set(1, 1, 1);
      } else {
        const k = Math.sin((s / 0.35) * Math.PI) * 0.16;
        this.bike.scale.set(1 + k * 0.6, 1 - k, 1 + k * 0.6);
      }
    }

    // Wheels + steering + pedals
    this.frontWheel.rotation.x = this.spin;
    this.rearWheel.rotation.x = this.spin;
    this.frontAssembly.rotation.y = damp(this.frontAssembly.rotation.y, -steer * 0.45, 14, dtRender);
    this.crank.rotation.x = this.spin * 0.42; // geared down

    // Legs chase the pedals
    const hipL = new THREE.Vector3(-0.12, 1.02, -0.34);
    const hipR = new THREE.Vector3(0.12, 1.02, -0.34);
    const footL = new THREE.Vector3();
    const footR = new THREE.Vector3();
    this.pedalL.getWorldPosition(footL);
    this.pedalR.getWorldPosition(footR);
    this.bike.worldToLocal(footL);
    this.bike.worldToLocal(footR);
    stretchBetween(this.legL, hipL, footL.add(new THREE.Vector3(0, 0.06, 0)));
    stretchBetween(this.legR, hipR, footR.add(new THREE.Vector3(0, 0.06, 0)));

    // Blob shadow hugs the ground and thins out with air height
    const h = clamp(y - (this.airborne ? 0 : y), 0, 3);
    this.shadowBlob.position.set(0, -y + 0.015 + (this.airborne ? 0 : 0), 0);
    // While airborne, project the blob down to ground level (y≈ramp/road top is fine)
    if (this.airborne) this.shadowBlob.position.y = -y + 0.015;
    const fade = this.airborne ? clamp(1 - h / 3, 0.25, 1) : 1;
    (this.shadowBlob.material as THREE.MeshBasicMaterial).opacity = 0.22 * fade;
    const sc = this.airborne ? lerp(1, 0.7, clamp(h / 3, 0, 1)) : 1;
    this.shadowBlob.scale.set(sc, sc, sc);
  }
}
