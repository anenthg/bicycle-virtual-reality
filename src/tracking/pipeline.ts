// Frame pixels → SteerState. Shared by the Web Worker and the main-thread
// fallback so both paths behave identically.

import type { CalibrationProfile, TrackerReport } from '../shared/types';
import {
  DEADZONE,
  HOLD_LAST_MS,
  ONE_EURO_BETA,
  ONE_EURO_MIN_CUTOFF,
  clamp,
  wrapDeg,
} from '../shared/types';
import { detectMarkers } from './detect';
import { OneEuroFilter } from './oneEuro';

export class SteerPipeline {
  profile: CalibrationProfile | null = null;

  private filter = new OneEuroFilter(ONE_EURO_MIN_CUTOFF, ONE_EURO_BETA);
  private lastGoodAngle = 0;
  private lastGoodRaw = 0;
  private lastGoodTs = -Infinity;

  setProfile(profile: CalibrationProfile | null): void {
    this.profile = profile;
    this.filter.reset();
  }

  setFilterParams(minCutoff: number, beta: number): void {
    this.filter.minCutoff = minCutoff;
    this.filter.beta = beta;
  }

  /**
   * @param data RGBA pixels at procW x procH
   * @param ts   performance.now() at capture time
   */
  process(
    data: Uint8ClampedArray,
    procW: number,
    procH: number,
    ts: number,
    detectMs: () => number,
  ): TrackerReport {
    const p = this.profile;

    // No calibration yet: wizard mode. Detect with whatever windows exist so
    // the wizard can show live centroid dots, but report state 'calibrating'.
    const windows = p ?? provisional;
    const frameWin = windows.frame ?? (p ? undefined : provisional.frame);
    const { left, right, frame } = detectMarkers(
      data, procW, procH, windows.left, windows.right, frameWin,
    );

    let rawDeg = this.lastGoodRaw;
    let angle = this.lastGoodAngle;
    let offset = 0;
    let quality = 0;
    let state: TrackerReport['steer']['state'] = p ? 'tracking' : 'calibrating';

    if (left && right) {
      // Bar-line tilt on RAW (unmirrored) coords; mirroring is folded into steerSign.
      const barTilt =
        (Math.atan2(right.y - left.y, right.x - left.x) * 180) / Math.PI;

      // Lean cancellation: with a calibrated frame marker, a whole-bike lean
      // rolls the frame→bar-midpoint line by the same angle it rolls the bar
      // line, so subtracting it leaves pure steering. Steering barely moves the
      // grips' midpoint (it sits on the steering axis), so it survives.
      let lean = 0;
      if (p?.frame && p.leanRestDeg != null && frame) {
        const midX = (left.x + right.x) / 2;
        const midY = (left.y + right.y) / 2;
        const leanNow = (Math.atan2(midY - frame.y, midX - frame.x) * 180) / Math.PI;
        lean = wrapDeg(leanNow - p.leanRestDeg);
      }
      rawDeg = wrapDeg(barTilt - lean);

      if (p) {
        // Deflection from the calibrated straight position, and the deflections
        // recorded at the full-LEFT and full-RIGHT locks.
        const d = wrapDeg(rawDeg - p.centerDeg);
        const dl = wrapDeg(p.leftMaxDeg - p.centerDeg); // deflection at full LEFT
        const dr = wrapDeg(p.rightMaxDeg - p.centerDeg); // deflection at full RIGHT

        // Piecewise map: full-left → -1, straight → 0, full-right → +1. Because
        // the limits are taken from the LABELED wizard steps ("turn left",
        // "turn right"), the direction is baked in and correct no matter how the
        // camera mirrors the image or which color sits on which grip — no manual
        // flip needed. Whichever recorded limit the live deflection shares a sign
        // with tells us which way (and how far) the bars are turned.
        let n = 0;
        if (dl !== 0 && Math.sign(d) === Math.sign(dl)) {
          n = -clamp(d / dl, 0, 1); // toward the left lock
        } else if (dr !== 0 && Math.sign(d) === Math.sign(dr)) {
          n = clamp(d / dr, 0, 1); // toward the right lock
        }
        n *= p.steerSign; // optional manual override; +1 by default (no-op)

        // Deadzone ±DEADZONE around center, rescaled so output stays continuous.
        const a = Math.abs(n);
        n = a < DEADZONE ? 0 : (Math.sign(n) * (a - DEADZONE)) / (1 - DEADZONE);

        angle = this.filter.filter(n, ts / 1000);

        // Lateral offset (Phase 2): midpoint X vs calibrated center,
        // normalized by calibrated bar pixel-length.
        const midX = (left.x + right.x) / 2;
        offset = p.barLength > 0.01
          ? clamp(((midX - p.centerMidX) / p.barLength) * 2 * p.steerSign, -1, 1)
          : 0;

        quality = clamp(
          Math.min(left.area, right.area) / Math.max(p.expectedArea * 0.5, 1),
          0,
          1,
        );
      }

      this.lastGoodAngle = angle;
      this.lastGoodRaw = rawDeg;
      this.lastGoodTs = ts;
    } else if (p) {
      // Single- or double-marker loss: hold the last angle briefly, then lost.
      if (ts - this.lastGoodTs > HOLD_LAST_MS) {
        state = 'lost';
        this.filter.reset();
      }
      quality = 0;
    }

    return {
      steer: { ts, angle, raw: rawDeg, offset, quality, state },
      left,
      right,
      frame,
      workerMs: detectMs(),
    };
  }
}

// Default hue windows so the wizard shows guide dots before patches are
// sampled. Left covers lime tape AND a true-green LED (~140°); right covers
// magenta/pink tape AND a red LED (~0-15°). High sat floors keep warm floors
// and skin out. (Calibration re-samples the exact tapped color regardless.)
const provisional = {
  left: { hueMin: 70, hueMax: 165, satMin: 0.4, valMin: 0.35 }, // green / lime
  right: { hueMin: 325, hueMax: 12, satMin: 0.5, valMin: 0.3 }, // red / pink / magenta (wraps 0°)
  frame: { hueMin: 185, hueMax: 235, satMin: 0.35, valMin: 0.25 }, // blue
};
