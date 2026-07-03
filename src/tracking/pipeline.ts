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
    const { left, right } = detectMarkers(data, procW, procH, windows.left, windows.right);

    let rawDeg = this.lastGoodRaw;
    let angle = this.lastGoodAngle;
    let offset = 0;
    let quality = 0;
    let state: TrackerReport['steer']['state'] = p ? 'tracking' : 'calibrating';

    if (left && right) {
      // atan2 on RAW (unmirrored) coords; mirroring is folded into steerSign.
      rawDeg =
        (Math.atan2(right.y - left.y, right.x - left.x) * 180) / Math.PI;

      if (p) {
        // Image-space deflection from center. The two recorded locks give the
        // span magnitude on each side; steerSign alone decides which way is
        // "left" in the game (front-camera mirroring folded into one constant,
        // verified by the wizard's flip-direction check).
        const d = wrapDeg(rawDeg - p.centerDeg);
        const dl = wrapDeg(p.leftMaxDeg - p.centerDeg);
        const dr = wrapDeg(p.rightMaxDeg - p.centerDeg);
        let posSpan = Math.max(dl, dr);
        let negSpan = Math.min(dl, dr);
        if (posSpan <= 1) posSpan = Math.max(Math.abs(negSpan), 5); // degenerate calibration guard
        if (negSpan >= -1) negSpan = -Math.max(posSpan, 5);
        let n = d >= 0 ? d / posSpan : d / Math.abs(negSpan);
        n = clamp(n, -1, 1) * p.steerSign;

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
      workerMs: detectMs(),
    };
  }
}

// Neon green + neon pink/orange defaults so the wizard shows dots even before
// the first patch is sampled (helps a parent aim the tape at the camera).
const provisional = {
  left: { hueMin: 75, hueMax: 165, satMin: 0.35, valMin: 0.25 },
  right: { hueMin: 300, hueMax: 350, satMin: 0.35, valMin: 0.25 },
};
