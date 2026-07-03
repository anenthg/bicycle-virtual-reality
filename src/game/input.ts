// Combines every steering source into one value the game consumes each tick:
//  - camera tracking (SteerState reports, with stale/lost easing)
//  - keyboard (always available in parallel — primary dev loop)
//  - fake injector (scripts/fake-input.ts) for latency tuning
// Also owns hop detection (Space + Phase-2 lateral slide) and hotkeys.

import type { TrackerReport } from '../shared/types';
import { LOSS_EASE_MS, STALE_MS, clamp } from '../shared/types';

export interface InputSnapshot {
  steer: number; // -1..1
  hop: boolean; // edge-triggered this tick
  trackingState: 'tracking' | 'lost' | 'calibrating' | 'off';
  quality: number;
}

export class InputManager {
  /** Set true while an overlay (wizard/pause) owns the keyboard. */
  suspended = false;

  onRestart: (() => void) | null = null;
  onPause: (() => void) | null = null;
  onMute: (() => void) | null = null;

  private keyLeft = false;
  private keyRight = false;
  private keySteer = 0;
  private hopQueued = false;

  private cameraEnabled = false;
  private cameraSteer = 0;
  private lastReport: TrackerReport | null = null;
  private lastReportAt = -Infinity;

  // Phase-2 slide/hop: offset crossing ±0.5 within 250 ms
  private offsetHistory: { t: number; v: number }[] = [];
  private lastHopAt = -Infinity;

  private fakeSteer: number | null = null;

  constructor() {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
  }

  enableCamera(): void {
    this.cameraEnabled = true;
  }

  /** Feed from the Tracker. */
  acceptReport(report: TrackerReport): void {
    this.lastReport = report;
    this.lastReportAt = performance.now();

    const now = this.lastReportAt;
    this.offsetHistory.push({ t: now, v: report.steer.offset });
    while (this.offsetHistory.length && now - this.offsetHistory[0].t > 300) {
      this.offsetHistory.shift();
    }
    if (
      report.steer.state === 'tracking' &&
      Math.abs(report.steer.offset) > 0.5 &&
      now - this.lastHopAt > 1000
    ) {
      // Was the offset near center within the last 250 ms? Then this is a
      // deliberate sideways shove, not a slow drift.
      const recentCenter = this.offsetHistory.some(
        (s) => now - s.t <= 250 && Math.abs(s.v) < 0.2,
      );
      if (recentCenter) {
        this.lastHopAt = now;
        this.hopQueued = true;
      }
    }
  }

  /** scripts/fake-input.ts pushes values here; null returns control. */
  setFakeSteer(v: number | null): void {
    this.fakeSteer = v;
  }

  /** Call once per fixed physics step. */
  sample(dt: number): InputSnapshot {
    // Keyboard: eased to simulate an analog stick.
    const target = (this.keyRight ? 1 : 0) - (this.keyLeft ? 1 : 0);
    if (target !== 0) {
      this.keySteer = clamp(this.keySteer + target * 4.5 * dt, -1, 1);
    } else {
      const decay = 5 * dt;
      this.keySteer =
        Math.abs(this.keySteer) < decay ? 0 : this.keySteer - Math.sign(this.keySteer) * decay;
    }

    // Camera: use the freshest report; ease to 0 when stale or lost (never snap).
    let trackingState: InputSnapshot['trackingState'] = this.cameraEnabled
      ? 'calibrating'
      : 'off';
    let quality = 0;
    if (this.cameraEnabled && this.lastReport) {
      const stale = performance.now() - this.lastReportAt > STALE_MS;
      const lost = stale || this.lastReport.steer.state === 'lost';
      trackingState = lost ? 'lost' : this.lastReport.steer.state;
      quality = lost ? 0 : this.lastReport.steer.quality;
      if (lost) {
        const rate = (1000 / LOSS_EASE_MS) * dt; // full-scale → 0 over LOSS_EASE_MS
        this.cameraSteer =
          Math.abs(this.cameraSteer) < rate
            ? 0
            : this.cameraSteer - Math.sign(this.cameraSteer) * rate;
      } else if (this.lastReport.steer.state === 'tracking') {
        this.cameraSteer = this.lastReport.steer.angle;
      }
    }

    let steer = clamp(this.cameraSteer + this.keySteer, -1, 1);
    if (this.fakeSteer !== null) steer = clamp(this.fakeSteer, -1, 1);

    const hop = this.hopQueued;
    this.hopQueued = false;
    return { steer, hop, trackingState, quality };
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (this.suspended) return;
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        this.keyLeft = down;
        e.preventDefault();
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.keyRight = down;
        e.preventDefault();
        break;
      case 'Space':
        if (down && !e.repeat) this.hopQueued = true;
        e.preventDefault();
        break;
      case 'KeyR':
        if (down && !e.repeat) this.onRestart?.();
        break;
      case 'KeyP':
      case 'Escape':
        if (down && !e.repeat) this.onPause?.();
        break;
      case 'KeyM':
        if (down && !e.repeat) this.onMute?.();
        break;
    }
  }
}
