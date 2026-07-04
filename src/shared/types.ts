// Shared types + tuning constants for Endless Rider.
// Everything the tracking worker and the game agree on lives here.

/** Steering state posted from the tracking worker to the main thread, ~30 Hz. */
export interface SteerState {
  /** performance.now() when the frame was processed (worker clock ≈ main clock). */
  ts: number;
  /** Normalized steering, -1 (left) .. +1 (right), post-smoothing, sign-corrected. */
  angle: number;
  /** Raw bar angle in degrees, pre-normalization (debug + calibration). */
  raw: number;
  /** Normalized lateral offset -1..+1 (Phase 2 slide/hop; 0 until then). */
  offset: number;
  /** 0..1 confidence — min of both blobs' area vs expected, clamped. */
  quality: number;
  state: 'tracking' | 'lost' | 'calibrating';
}

/** An HSV threshold window. Hue is degrees [0, 360) and MAY wrap (min > max). */
export interface HSVWindow {
  hueMin: number;
  hueMax: number;
  satMin: number; // 0..1
  valMin: number; // 0..1
}

/** Persisted to localStorage; produced by the calibration wizard. */
export interface CalibrationProfile {
  version: 2;
  left: HSVWindow;
  right: HSVWindow;
  /** Raw bar angle (degrees) with the handlebars held straight. */
  centerDeg: number;
  /** Raw bar angle at full-left / full-right lock. */
  leftMaxDeg: number;
  rightMaxDeg: number;
  /** Midpoint X of the two markers at center, normalized 0..1 (raw, unmirrored). */
  centerMidX: number;
  /** Distance between markers at center, as a fraction of frame width. */
  barLength: number;
  /** Smaller blob pixel area (at 320x240) recorded at the center step. */
  expectedArea: number;
  /** +1 or -1; folds front-camera mirroring into one flippable constant. */
  steerSign: 1 | -1;
  /**
   * Optional third marker on the FIXED frame (not the steering assembly). When
   * present, the tracker separates steering from whole-bike lean: a lean rolls
   * the frame marker too, so it can be cancelled out. Absent => 2-marker mode.
   */
  frame?: HSVWindow;
  /**
   * Image-plane angle (deg) of the line from the frame marker to the grips'
   * midpoint, recorded with the bike straight AND upright. Runtime lean is the
   * deviation of that angle from this rest value.
   */
  leanRestDeg?: number;
}

/** Detected marker centroid, normalized 0..1 in RAW (unmirrored) frame coords. */
export interface MarkerPoint {
  x: number;
  y: number;
  area: number; // pixel count at processing resolution
}

/** Full per-frame report from the tracker (worker or fallback). */
export interface TrackerReport {
  steer: SteerState;
  left: MarkerPoint | null;
  right: MarkerPoint | null;
  /** Optional fixed-frame reference marker (lean cancellation). */
  frame: MarkerPoint | null;
  /** Milliseconds the detector spent on this frame. */
  workerMs: number;
}

export type ToWorkerMsg =
  | { type: 'frame'; bitmap: ImageBitmap; ts: number }
  | { type: 'profile'; profile: CalibrationProfile | null }
  | { type: 'filter'; minCutoff: number; beta: number };

export type FromWorkerMsg = { type: 'report'; report: TrackerReport };

// ---------------------------------------------------------------------------
// Tracking constants
// ---------------------------------------------------------------------------
export const CAPTURE_W = 640;
export const CAPTURE_H = 480;
export const PROC_W = 320;
export const PROC_H = 240;
export const TRACK_HZ = 30;
export const TRACK_HZ_REDUCED = 20;
export const DEADZONE = 0.07;
// Direction is now derived automatically from the labeled left/right calibration
// limits, so the default sign is a neutral +1 (the Flip button remains as a
// rarely-needed manual override).
export const DEFAULT_STEER_SIGN: 1 | -1 = 1;
export const MIN_BLOB_AREA = 14; // px at 320x240 — reject noise specks
/** Worker holds the last angle this long after losing a marker, then reports lost. */
export const HOLD_LAST_MS = 300;
/** Main thread: no fresh SteerState for this long → treat as lost. */
export const STALE_MS = 300;
/** Steering eases back to 0 over this long when tracking is lost. */
export const LOSS_EASE_MS = 500;
// Lower minCutoff = more smoothing of slow/rest signal (kills jitter with a
// little more lag); rate-based steering hides the lag well. beta keeps fast
// turns responsive. Tunable live in the debug overlay (backtick).
export const ONE_EURO_MIN_CUTOFF = 0.8;
export const ONE_EURO_BETA = 0.007;

// ---------------------------------------------------------------------------
// Game constants
// ---------------------------------------------------------------------------
export const ROAD_WIDTH = 12;
export const ROAD_HALF = ROAD_WIDTH / 2;
export const BASE_SPEED = 12; // m/s
export const SPEED_RAMP = 0.15; // m/s gained per second
export const MAX_SPEED = 26;
export const MAX_LAT_SPEED = 6; // m/s at full lock
export const GRAVITY = 14; // snappy jump arcs
export const CHUNK_LEN = 100;
export const CHUNKS_AHEAD = 3;
export const GATE_EVERY_M = 1250; // ≈ 90 s at typical speeds
export const STAR_POINTS = 25;
export const COLLISION_SPEED_FACTOR = 0.6;
export const COLLISION_RECOVER_S = 3;
export const MAGNET_DURATION_S = 8;

// Perf tiering (§6 of the spec)
export const FRAME_BUDGET_MS = 14;
export const TIER_WINDOW_FRAMES = 10;

export const LS = {
  calibration: 'endless-rider.calibration.v2',
  highScore: 'endless-rider.highscore',
  muted: 'endless-rider.muted',
  pipHidden: 'endless-rider.pip-hidden',
} as const;

export const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Frame-rate independent exponential approach: moves `current` toward `target`. */
export const damp = (current: number, target: number, lambda: number, dt: number) =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));

/** Wrap an angle difference in degrees to [-180, 180]. */
export const wrapDeg = (d: number) => {
  let x = d % 360;
  if (x > 180) x -= 360;
  if (x < -180) x += 360;
  return x;
};
