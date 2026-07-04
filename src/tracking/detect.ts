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

// Reused per-frame scratch buffers (avoid GC churn at 30 Hz). Sized on demand.
let labelBuf: Uint8Array | null = null;
let visitedBuf: Uint8Array | null = null;
let stackBuf: Int32Array | null = null;

/**
 * Per-frame marker detection. Two stages:
 *  1. Label every pixel by which HSV window it matches (1=left, 2=right,
 *     3=frame).
 *  2. Take the LARGEST 4-connected blob per label as the marker.
 *
 * Stage 2 is what makes tracking robust in a busy room: scattered background
 * pixels that happen to match a marker color (skin on a red marker, a blue
 * poster on a blue marker) form small disconnected blobs and are ignored — only
 * the one solid tape band wins, instead of the old global-centroid average that
 * every stray pixel dragged around. ~77k pixels at 320x240; the flood fill only
 * touches matched pixels, so it stays well inside the 12 ms worker budget.
 */
export function detectMarkers(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  left: HSVWindow,
  right: HSVWindow,
  frame?: HSVWindow,
): DetectResult {
  const N = width * height;
  if (!labelBuf || labelBuf.length < N) {
    labelBuf = new Uint8Array(N);
    visitedBuf = new Uint8Array(N);
    stackBuf = new Int32Array(N);
  }
  const label = labelBuf;
  const visited = visitedBuf!;
  const stack = stackBuf!;
  label.fill(0, 0, N);
  visited.fill(0, 0, N);

  const minSat = frame
    ? Math.min(left.satMin, right.satMin, frame.satMin)
    : Math.min(left.satMin, right.satMin);

  // ---- stage 1: label pixels by matching window --------------------------
  let i = 0;
  for (let p = 0; p < N; p++, i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    if (max === 0) continue;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    const d = max - min;
    const s = d / max;
    if (s < minSat) continue;
    const v = max / 255;

    let h: number;
    if (d === 0) h = 0;
    else if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;

    if (s >= left.satMin && v >= left.valMin && hueInWindow(h, left)) label[p] = 1;
    else if (s >= right.satMin && v >= right.valMin && hueInWindow(h, right)) label[p] = 2;
    else if (frame && s >= frame.satMin && v >= frame.valMin && hueInWindow(h, frame)) label[p] = 3;
  }

  // ---- stage 2: largest connected component per label --------------------
  // best[lab] = [size, sumX, sumY]
  const best: Array<[number, number, number]> = [
    [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
  ];
  for (let p0 = 0; p0 < N; p0++) {
    const lab = label[p0];
    if (lab === 0 || visited[p0]) continue;
    let size = 0, sx = 0, sy = 0, sp = 0;
    stack[sp++] = p0;
    visited[p0] = 1;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % width;
      const y = (p - x) / width;
      size++; sx += x; sy += y;
      if (x > 0) { const q = p - 1; if (label[q] === lab && !visited[q]) { visited[q] = 1; stack[sp++] = q; } }
      if (x < width - 1) { const q = p + 1; if (label[q] === lab && !visited[q]) { visited[q] = 1; stack[sp++] = q; } }
      if (y > 0) { const q = p - width; if (label[q] === lab && !visited[q]) { visited[q] = 1; stack[sp++] = q; } }
      if (y < height - 1) { const q = p + width; if (label[q] === lab && !visited[q]) { visited[q] = 1; stack[sp++] = q; } }
    }
    if (size > best[lab][0]) best[lab] = [size, sx, sy];
  }

  const toPoint = (b: [number, number, number]): MarkerPoint | null =>
    b[0] >= MIN_BLOB_AREA
      ? { x: b[1] / b[0] / width, y: b[2] / b[0] / height, area: b[0] }
      : null;

  return {
    left: toPoint(best[1]),
    right: toPoint(best[2]),
    frame: frame ? toPoint(best[3]) : null,
  };
}

/**
 * Sample a square patch (client already extracted the pixels) into a generous
 * HSV window. Hue is averaged as a vector so red wraparound works.
 */
export function patchToWindow(data: Uint8ClampedArray): HSVWindow {
  // Two accumulators: one over the COLORED pixels (sat above a floor) and one
  // over all pixels. A bright LED blows its center out to near-white — those
  // desaturated core pixels would drag the average saturation down and make the
  // window far too loose. So we characterize the marker from its colored ring
  // (hue + saturation), and only fall back to the whole patch if almost nothing
  // is colored. peakV (the brightest pixel) tells us if it's a self-lit source.
  let cos = 0, sin = 0, sSum = 0, vSum = 0, n = 0;
  let vAll = 0, nAll = 0, peakV = 0;
  const COLOR_SAT = 0.28;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === 0) continue;
    const d = max - min;
    const s = d / max;
    const v = max / 255;
    vAll += v; nAll++;
    if (v > peakV) peakV = v;
    if (s < COLOR_SAT) continue; // skip the blown-white core / gray pixels
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
  if (nAll === 0) return { hueMin: 0, hueMax: 30, satMin: 0.4, valMin: 0.3 };
  // If the patch is essentially colorless (tapped a white light with no colored
  // ring), there is no hue to track — return a permissive default and let the
  // user retap. Otherwise characterize from the colored pixels.
  if (n < 3) return { hueMin: 0, hueMax: 30, satMin: 0.4, valMin: 0.3 };

  let hue = (Math.atan2(sin / n, cos / n) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  const avgS = sSum / n; // saturation of the colored ring (not the white core)
  const avgV = vSum / n;

  // ±15° hue window. Saturation/brightness floors ADAPT to the sample so a
  // marker locks onto its own core, not dimmer look-alikes nearby:
  //
  //  - A bright, pure sample (a self-lit LED: high value AND high saturation)
  //    gets TIGHT floors. This rejects skin, warm reflections and colored spill
  //    — which share the hue but are less saturated and less bright — so the
  //    detector anchors on the intense center of the light. (A hand lit red
  //    reads sat≈0.65/val≈0.69; a red LED core reads sat≈0.85/val≈0.9, so
  //    satMin≈0.70 + valMin≈0.62 keeps the LED and drops the hand entirely.)
  //  - A matte sample (tape: moderate value) keeps LOOSE floors so it still
  //    tracks as room light dims.
  const HUE_TOL = 15;
  // A blown-out peak (near-white core) marks a self-lit source (LED); matte
  // tape never clips, so its peak stays lower. A lit source gets a satMin very
  // close to its own ring saturation (×0.90): dimmer look-alikes like a red-lit
  // hand read ~0.05-0.15 less saturated, and that gap is enough to drop them
  // entirely while the LED survives. (Verified on the user's screenshot where
  // the red LED, satMin≈0.68, wins over a bigger red-lit hand.)
  const litSource = peakV > 0.9;
  const satMult = litSource ? 0.9 : avgS > 0.7 ? 0.82 : 0.66;
  return {
    hueMin: (hue - HUE_TOL + 360) % 360,
    hueMax: (hue + HUE_TOL) % 360,
    satMin: Math.max(0.35, avgS * satMult),
    valMin: litSource ? Math.max(0.3, avgV * 0.6) : Math.max(0.15, avgV * 0.4),
  };
}
