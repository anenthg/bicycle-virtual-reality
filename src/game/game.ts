// Game orchestrator: fixed 60 Hz Rapier step + interpolated rendering,
// no-fail collisions (speed penalty only), finish gates with confetti,
// and the §6 perf auto-tiering.

import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import {
  BASE_SPEED,
  COLLISION_RECOVER_S,
  COLLISION_SPEED_FACTOR,
  FRAME_BUDGET_MS,
  GATE_EVERY_M,
  LS,
  MAGNET_DURATION_S,
  MAX_SPEED,
  SPEED_RAMP,
  STAR_POINTS,
  TIER_WINDOW_FRAMES,
  clamp,
  damp,
  lerp,
} from '../shared/types';
import type { AudioEngine } from './audio';
import { CollectibleManager } from './collectibles';
import { Effects } from './effects';
import type { InputManager, InputSnapshot } from './input';
import { ObstacleManager } from './obstacles';
import { Rider } from './rider';
import { World, centerXAt } from './world';

type RapierApi = typeof RAPIER;

export interface GateSummary {
  score: number;
  stars: number;
  distance: number;
  highScore: number;
  isNewHigh: boolean;
}

export interface GameHooks {
  onGate(summary: GateSummary): void;
  onRunStart(): void;
  onTierChange(tier: number, message: string): void;
  onFrame(input: InputSnapshot): void;
}

export interface GameStats {
  fps: number;
  frameMs: number;
  physMs: number;
  tier: number;
  speed: number;
  steer: number;
}

const FIXED_DT = 1 / 60;

function makeFinishGate(): THREE.Group {
  const g = new THREE.Group();
  const pillarGeo = new THREE.CylinderGeometry(0.28, 0.34, 6.4, 10);
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0xff5a8a, roughness: 0.6 });
  for (const side of [-1, 1]) {
    const p = new THREE.Mesh(pillarGeo, pillarMat);
    p.position.set(side * 6.4, 3.2, 0);
    p.castShadow = true;
    g.add(p);
  }
  // Banner with procedural canvas texture — no asset files
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const x = c.getContext('2d')!;
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, 512, 128);
  // checkered border
  x.fillStyle = '#222';
  for (let i = 0; i < 32; i++) {
    if (i % 2 === 0) x.fillRect(i * 16, 0, 16, 16);
    else x.fillRect(i * 16, 112, 16, 16);
  }
  x.fillStyle = '#ff3d71';
  x.font = 'bold 72px ui-rounded, "Comic Sans MS", sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText('FINISH!', 256, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const banner = new THREE.Mesh(
    new THREE.PlaneGeometry(13.4, 2.6),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }),
  );
  banner.position.y = 5.6;
  g.add(banner);
  return g;
}

export class Game {
  state: 'idle' | 'playing' | 'gate' | 'paused' = 'idle';

  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly stats: GameStats = { fps: 60, frameMs: 0, physMs: 0, tier: 0, speed: 0, steer: 0 };

  score = 0;
  starsCollected = 0;
  magnetTimer = 0;
  gatesPassed = 0;

  private phys: RAPIER.World;
  private riderBody: RAPIER.RigidBody;
  private input: InputManager;
  private audio: AudioEngine;
  private hooks: GameHooks;

  private world: World;
  private rider: Rider;
  private obstacles: ObstacleManager;
  private collectibles: CollectibleManager;
  private effects: Effects;

  private sun: THREE.DirectionalLight;

  private runTime = 0;
  private collisionFactor = 1;
  private puddleUntil = 0;
  private streak = 0;
  private lastStarAt = -10;
  private nextGateZ = GATE_EVERY_M;
  private gate: THREE.Group;
  private gateTimer = 0;
  private lastInput: InputSnapshot = { steer: 0, hop: false, trackingState: 'off', quality: 0 };

  private accumulator = 0;
  private lastFrameT = 0;
  private elapsed = 0;
  private rafId = 0;

  // perf tiering
  private frameWindow: number[] = [];
  private overBudgetStreak = 0;

  get godMode(): boolean {
    return this.obstacles.godMode;
  }
  set godMode(v: boolean) {
    this.obstacles.godMode = v;
  }

  constructor(
    canvas: HTMLCanvasElement,
    rapier: RapierApi,
    input: InputManager,
    audio: AudioEngine,
    hooks: GameHooks,
  ) {
    this.input = input;
    this.audio = audio;
    this.hooks = hooks;

    // ---- renderer (spec §3: sRGB output, ACES, shadows on) -----------------
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    window.addEventListener('resize', () => this.onResize());

    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 900);
    this.camera.position.set(0, 5.2, -9.5);

    // ---- lights + fog -------------------------------------------------------
    const fog = new THREE.FogExp2(0xeba36f, 0.0055);
    this.scene.fog = fog;
    const hemi = new THREE.HemisphereLight(0xbdd4ff, 0x7fae5c, 0.85);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xffd9a8, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 5;
    this.sun.shadow.camera.far = 160;
    const S = 42;
    this.sun.shadow.camera.left = -S;
    this.sun.shadow.camera.right = S;
    this.sun.shadow.camera.top = S;
    this.sun.shadow.camera.bottom = -S;
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun, this.sun.target);

    // ---- physics -------------------------------------------------------------
    this.phys = new rapier.World({ x: 0, y: -14, z: 0 });
    const groundBody = this.phys.createRigidBody(rapier.RigidBodyDesc.fixed());
    this.phys.createCollider(
      rapier.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setFriction(0.9),
      groundBody,
    );
    this.riderBody = this.phys.createRigidBody(
      rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 1, 0),
    );
    this.phys.createCollider(rapier.ColliderDesc.capsule(0.5, 0.45), this.riderBody);

    // ---- world + actors --------------------------------------------------------
    this.obstacles = new ObstacleManager(this.scene, rapier, this.phys);
    this.collectibles = new CollectibleManager(this.scene);
    this.world = new World(
      this.scene,
      { fog, hemi, sun: this.sun },
      {
        populate: (chunk) => {
          this.obstacles.populate(chunk, this.rider?.z ?? 0, this.gatesPassed);
          this.collectibles.populate(chunk, this.rider?.z ?? 0);
        },
        depopulate: (index) => {
          this.obstacles.depopulate(index);
          this.collectibles.depopulate(index);
        },
      },
    );
    this.rider = new Rider(this.scene);
    this.effects = new Effects(this.scene);

    this.gate = makeFinishGate();
    this.positionGate();
    this.scene.add(this.gate);
  }

  /** Dev helper (?warp=800): begin the run partway down the road. */
  warpTo(z: number): void {
    this.rider.z = z;
    this.rider.prevZ = z;
    this.gatesPassed = Math.floor(z / GATE_EVERY_M);
    this.nextGateZ = (this.gatesPassed + 1) * GATE_EVERY_M;
    this.positionGate();
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.state = 'playing';
    this.hooks.onRunStart();
    this.lastFrameT = performance.now();
    this.loop(this.lastFrameT);
  }

  /** Dev helper (?sim=25): synchronously fast-forward N seconds of gameplay. */
  simulate(seconds: number): void {
    const steps = Math.min(Math.floor(seconds * 60), 60 * 120);
    for (let i = 0; i < steps; i++) {
      if (this.state !== 'playing') break;
      this.fixedStep(FIXED_DT);
      // Stream the world along the way so chunks exist when we land
      if (i % 30 === 0) this.world.update(this.rider.z, this.camera, FIXED_DT);
    }
    // Snap camera to the new position so the first frame isn't a swoop
    const rp = this.rider.group.position;
    rp.set(this.rider.x, this.rider.y, this.rider.z);
    this.camera.position.set(rp.x, rp.y + 5.1, rp.z - 9.5);
  }

  pause(): void {
    if (this.state === 'playing') this.state = 'paused';
  }

  resume(): void {
    if (this.state === 'paused') {
      this.state = 'playing';
      this.lastFrameT = performance.now();
      this.accumulator = 0;
    }
  }

  togglePause(): void {
    if (this.state === 'paused') this.resume();
    else this.pause();
  }

  restart(): void {
    // Fresh run; difficulty memory (gates passed) survives.
    this.world.reset();
    this.obstacles.reset();
    this.collectibles.reset();
    this.rider.z = 0.01;
    this.rider.prevZ = 0.01;
    this.rider.lateral = 0;
    this.rider.latVel = 0;
    this.rider.y = 0;
    this.rider.vy = 0;
    this.rider.airborne = false;
    this.runTime = 0;
    this.collisionFactor = 1;
    this.score = 0;
    this.starsCollected = 0;
    this.streak = 0;
    this.magnetTimer = 0;
    this.nextGateZ = GATE_EVERY_M;
    this.positionGate();
    this.state = 'playing';
    this.accumulator = 0;
    this.lastFrameT = performance.now();
    this.hooks.onRunStart();
  }

  get currentSpeed(): number {
    if (this.state !== 'playing') return 0;
    const base = Math.min(BASE_SPEED + SPEED_RAMP * this.runTime, MAX_SPEED);
    const puddle = performance.now() < this.puddleUntil ? 0.72 : 1;
    return base * this.collisionFactor * puddle;
  }

  // ---------------------------------------------------------------------------

  private positionGate(): void {
    const z = this.nextGateZ;
    this.gate.position.set(centerXAt(z), 0, z);
  }

  private loop = (t: number): void => {
    this.rafId = requestAnimationFrame(this.loop);
    const rawDt = Math.min((t - this.lastFrameT) / 1000, 0.1);
    this.lastFrameT = t;
    this.elapsed += rawDt;

    const frameStart = performance.now();

    if (this.state === 'playing' || this.state === 'gate') {
      this.accumulator += rawDt;
      let physMs = 0;
      while (this.accumulator >= FIXED_DT) {
        this.accumulator -= FIXED_DT;
        const p0 = performance.now();
        this.fixedStep(FIXED_DT);
        physMs += performance.now() - p0;
        if (this.accumulator > 0.25) this.accumulator = 0; // spiral-of-death guard
      }
      this.stats.physMs = physMs;
    }

    const alpha = clamp(this.accumulator / FIXED_DT, 0, 1);
    this.render(alpha, rawDt);

    const frameMs = performance.now() - frameStart;
    this.trackPerf(frameMs, rawDt);
    this.hooks.onFrame(this.lastInput);
  };

  private fixedStep(dt: number): void {
    const input = this.input.sample(dt);
    this.lastInput = input;
    this.stats.steer = input.steer;

    if (this.state === 'gate') {
      // Glide to a stop under the banner
      this.gateTimer += dt;
      const speed = Math.max(0, 8 * (1 - this.gateTimer / 1.4));
      this.rider.step(dt, 0, false, speed, (x, z) => this.collectibles.groundYAt(x, z), centerXAt);
      this.phys.step();
      return;
    }
    if (this.state !== 'playing') return;

    this.runTime += dt;
    this.collisionFactor = Math.min(1, this.collisionFactor + dt / COLLISION_RECOVER_S * (1 - COLLISION_SPEED_FACTOR));
    this.magnetTimer = Math.max(0, this.magnetTimer - dt);

    const speed = this.currentSpeed;
    this.stats.speed = speed;

    const ev = this.rider.step(
      dt,
      input.steer,
      input.hop,
      speed,
      (x, z) => this.collectibles.groundYAt(x, z),
      centerXAt,
    );

    if (ev.hopped) this.audio.boing();
    if (ev.landed) {
      this.effects.dust.burst(
        new THREE.Vector3(this.rider.x, 0.15, this.rider.z),
        10,
        2.5,
        0.7,
        new THREE.Color(0xc9b28a),
      );
      if (ev.landingSpeed > 5) this.audio.thud();
    }
    if (ev.edgeBump) {
      this.effects.dust.burst(
        new THREE.Vector3(this.rider.x, 0.2, this.rider.z),
        6,
        2,
        0.5,
        new THREE.Color(0xa8b06a),
      );
    }

    // Keep the kinematic rider body in sync so props collide with the bike
    this.riderBody.setNextKinematicTranslation({
      x: this.rider.x,
      y: this.rider.y + 1,
      z: this.rider.z,
    });

    this.phys.step();

    // Obstacles
    const hits = this.obstacles.step(dt, this.rider, speed);
    for (const hit of hits) {
      if (hit.kind === 'chicken') {
        this.audio.cluck();
        continue;
      }
      if (hit.severity === 'splash') {
        this.puddleUntil = performance.now() + 500;
        this.audio.splash();
        this.effects.splash.burst(hit.pos, 26, 4.5, 0.8, new THREE.Color(0xbfe6f5), 1.2);
      } else if (hit.severity === 'soft') {
        this.collisionFactor = Math.min(this.collisionFactor, 0.92);
        this.audio.click();
        this.effects.dust.burst(hit.pos, 8, 3, 0.6, new THREE.Color(0xffb27a));
      } else {
        // The real thing to avoid — still never a run-ender
        this.collisionFactor = COLLISION_SPEED_FACTOR;
        this.rider.startWobble();
        this.audio.thud();
        this.effects.dust.burst(hit.pos, 20, 4, 0.9, new THREE.Color(0xd9c68a), 1);
      }
    }

    // Collectibles
    const col = this.collectibles.step(dt, this.rider, this.magnetTimer > 0);
    for (const pos of col.starPositions) {
      if (this.runTime - this.lastStarAt > 2) this.streak = 0;
      this.lastStarAt = this.runTime;
      this.streak++;
      this.starsCollected++;
      this.audio.chime(this.streak);
      this.effects.sparkle.burst(pos, 14, 3.5, 0.7, new THREE.Color(0xffe27a), 1.4);
    }
    if (col.magnetPicked) {
      this.magnetTimer = MAGNET_DURATION_S;
      this.audio.magnet();
      this.effects.sparkle.burst(
        new THREE.Vector3(this.rider.x, 1.4, this.rider.z),
        22,
        4,
        0.9,
        new THREE.Color(0xff7ab8),
        1.5,
      );
    }

    this.score = Math.floor(this.rider.z) + this.starsCollected * STAR_POINTS;

    // World streaming + gate
    if (this.rider.z >= this.nextGateZ) this.reachGate();
  }

  private reachGate(): void {
    this.state = 'gate';
    this.gateTimer = 0;
    this.gatesPassed++;
    this.audio.fanfare();
    this.effects.confetti.burst(
      new THREE.Vector3(this.rider.x, 4.5, this.rider.z + 6),
      300,
    );

    const prevHigh = Number(localStorage.getItem(LS.highScore) ?? 0);
    const isNewHigh = this.score > prevHigh;
    if (isNewHigh) localStorage.setItem(LS.highScore, String(this.score));
    this.hooks.onGate({
      score: this.score,
      stars: this.starsCollected,
      distance: Math.floor(this.rider.z),
      highScore: Math.max(prevHigh, this.score),
      isNewHigh,
    });
  }

  private render(alpha: number, dt: number): void {
    const speed = this.state === 'playing' ? this.stats.speed : 0;
    this.rider.visualUpdate(alpha, dt, speed, this.lastInput.steer);
    this.obstacles.visualUpdate(alpha, this.elapsed);
    this.collectibles.visualUpdate(this.elapsed);
    this.effects.update(dt);
    this.world.update(this.rider.z, this.camera, dt);

    // Elevated chase camera with long sightlines (spec: telegraph early)
    const rp = this.rider.group.position;
    const targetX = rp.x * 0.75 + centerXAt(rp.z) * 0.25;
    this.camera.position.x = damp(this.camera.position.x, targetX, 6, dt);
    this.camera.position.y = damp(this.camera.position.y, rp.y + 5.1, 5, dt);
    this.camera.position.z = rp.z - 9.5;
    const look = new THREE.Vector3(
      lerp(this.camera.position.x, centerXAt(rp.z + 16), 0.55),
      rp.y + 1.7,
      rp.z + 16,
    );
    this.camera.lookAt(look);
    const targetFov = 58 + (speed / MAX_SPEED) * 11;
    this.camera.fov = damp(this.camera.fov, targetFov, 4, dt);
    this.camera.updateProjectionMatrix();

    // Sun + shadow frustum follow the rider
    this.sun.position.set(rp.x - 28, 42, rp.z + 55);
    this.sun.target.position.set(rp.x, 0, rp.z + 8);

    this.audio.setSpeed(speed, this.rider.airborne);
    this.renderer.render(this.scene, this.camera);
  }

  private trackPerf(frameMs: number, rawDt: number): void {
    this.stats.frameMs = lerp(this.stats.frameMs, frameMs, 0.08);
    this.stats.fps = lerp(this.stats.fps, 1 / Math.max(rawDt, 1e-4), 0.05);

    this.frameWindow.push(frameMs);
    if (this.frameWindow.length > TIER_WINDOW_FRAMES) this.frameWindow.shift();
    const avg = this.frameWindow.reduce((a, b) => a + b, 0) / this.frameWindow.length;
    if (avg > FRAME_BUDGET_MS && this.frameWindow.length === TIER_WINDOW_FRAMES) {
      this.overBudgetStreak++;
    } else {
      this.overBudgetStreak = 0;
    }
    // Sustained overload → step down one tier (tracking Hz first, then shadows)
    if (this.overBudgetStreak > 90 && this.stats.tier < 2) {
      this.overBudgetStreak = 0;
      this.stats.tier++;
      if (this.stats.tier === 1) {
        this.hooks.onTierChange(1, 'tracking → 20 Hz, shadows → 1024');
        this.sun.shadow.mapSize.set(1024, 1024);
        this.sun.shadow.map?.dispose();
        (this.sun.shadow as unknown as { map: unknown }).map = null;
      } else {
        this.hooks.onTierChange(2, 'pixel ratio → 1');
        this.renderer.setPixelRatio(1);
      }
    }
  }

  private onResize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.renderer.dispose();
  }
}
