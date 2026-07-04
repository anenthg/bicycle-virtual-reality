// Color-blob detection on raw pixels. Shared by the Web Worker (normal path)
// and the main-thread fallback (Safari without OffscreenCanvas).
// Deliberately no OpenCV/MediaPipe — two-marker centroids are lighter and
// more robust for this job.

import type { HSVWindow, MarkerPoint } from '../shared/types';
import { MIN_BLOB_AREA } from '../shared/types';

export interface DetectResult {
  left: MarkerPoint | null;
  right: MarkerPoint | null;
  frame: MarkerPoint | null;
}

const hueInWindow = (h: number, win: HSVWindow): boolean =>
  win.hueMin <= win.hueMax
    ? h >= win.hueMin && h <= win.hueMax
    : h >= win.hueMin || h <= win.hueMax; // wrapped window (e.g. 350°..10°)

/**
 * One pass over the frame, testing every pixel against the marker HSV windows
 * and accumulating centroid sums. The optional `frame` window is the fixed-
 * frame reference marker (lean cancellation). ~77k pixels at 320x240 —
 * comfortably inside the 12 ms worker budget in plain JS.
 */
export function detectMarkers(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  left: HSVWindow,
  right: HSVWindow,
  frame?: HSVWindow,
): DetectResult {
  let lSumX = 0, lSumY = 0, lN = 0;
  let rSumX = 0, rSumY = 0, rN = 0;
  let fSumX = 0, fSumY = 0, fN = 0;
  const minSat = frame
    ? Math.min(left.satMin, right.satMin, frame.satMin)
    : Math.min(left.satMin, right.satMin);

  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];

      // Inline RGB→HSV (h in degrees, s/v in 0..1)
      const max = r > g ? (r > b ? r : b) : g > b ? g : b;
      if (max === 0) continue;
      const min = r < g ? (r < b ? r : b) : g < b ? g : b;
      const d = max - min;
      const s = d / max;
      const v = max / 255;

      // Cheap pre-reject before computing hue
      if (s < minSat) continue;

      let h: number;
      if (d === 0) h = 0;
      else if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
      if (h < 0) h += 360;

      if (s >= left.satMin && v >= left.valMin && hueInWindow(h, left)) {
        lSumX += x; lSumY += y; lN++;
      } else if (s >= right.satMin && v >= right.valMin && hueInWindow(h, right)) {
        rSumX += x; rSumY += y; rN++;
      } else if (frame && s >= frame.satMin && v >= frame.valMin && hueInWindow(h, frame)) {
        fSumX += x; fSumY += y; fN++;
      }
    }
  }

  return {
    left:
      lN >= MIN_BLOB_AREA
        ? { x: lSumX / lN / width, y: lSumY / lN / height, area: lN }
        : null,
    right:
      rN >= MIN_BLOB_AREA
        ? { x: rSumX / rN / width, y: rSumY / rN / height, area: rN }
        : null,
    frame:
      frame && fN >= MIN_BLOB_AREA
        ? { x: fSumX / fN / width, y: fSumY / fN / height, area: fN }
        : null,
  };
}

/**
 * Sample a square patch (client already extracted the pixels) into a generous
 * HSV window. Hue is averaged as a vector so red wraparound works.
 */
export function patchToWindow(data: Uint8ClampedArray): HSVWindow {
  let cos = 0, sin = 0, sSum = 0, vSum = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (max === 0) continue;
    const s = d / max;
    const v = max / 255;
    let h: number;
    if (d === 0) h = 0;
    else if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    const rad = (h * Math.PI) / 180;
    cos += Math.cos(rad);
    sin += Math.sin(rad);
    sSum += s;
    vSum += v;
    n++;
  }
  if (n === 0) return { hueMin: 0, hueMax: 30, satMin: 0.4, valMin: 0.3 };

  let hue = (Math.atan2(sin / n, cos / n) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  const avgS = sSum / n;
  const avgV = vSum / n;

  // ±15° hue window. The saturation floor is a firm fraction of the sampled
  // tape's saturation: warm-neutral backgrounds (floors, walls, wood, skin)
  // sit in the red/orange hue range at moderate saturation, so a red/pink/
  // magenta marker needs a high floor to reject them. Gating at ~0.66× the
  // vivid tape's saturation isolates the marker; the 0.30 floor keeps it sane
  // for less-saturated tape. (Verified against a magenta grip over a warm floor.)
  const HUE_TOL = 15;
  return {
    hueMin: (hue - HUE_TOL + 360) % 360,
    hueMax: (hue + HUE_TOL) % 360,
    satMin: Math.max(0.3, avgS * 0.66),
    valMin: Math.max(0.15, avgV * 0.4),
  };
}
