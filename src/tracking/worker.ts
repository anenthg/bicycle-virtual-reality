// Tracking Web Worker: receives ImageBitmap frames, runs color-blob detection
// + One Euro smoothing on an OffscreenCanvas, posts back compact SteerState
// reports. Runs off the main thread so CV never steals render time.

import type { FromWorkerMsg, ToWorkerMsg } from '../shared/types';
import { PROC_H, PROC_W } from '../shared/types';
import { SteerPipeline } from './pipeline';

// Typed handle on the worker global without pulling in the webworker lib
// (which conflicts with DOM types in a single tsconfig).
const ctx = self as unknown as {
  postMessage(msg: FromWorkerMsg, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<ToWorkerMsg>) => void) | null;
};

const pipeline = new SteerPipeline();

let canvas: OffscreenCanvas | null = null;
let c2d: OffscreenCanvasRenderingContext2D | null = null;

ctx.onmessage = (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'profile':
      pipeline.setProfile(msg.profile);
      break;
    case 'filter':
      pipeline.setFilterParams(msg.minCutoff, msg.beta);
      break;
    case 'frame': {
      const t0 = performance.now();
      if (!canvas) {
        canvas = new OffscreenCanvas(PROC_W, PROC_H);
        c2d = canvas.getContext('2d', { willReadFrequently: true });
      }
      if (!c2d) return;
      c2d.drawImage(msg.bitmap, 0, 0, PROC_W, PROC_H);
      msg.bitmap.close();
      const img = c2d.getImageData(0, 0, PROC_W, PROC_H);
      const report = pipeline.process(
        img.data,
        PROC_W,
        PROC_H,
        msg.ts,
        () => performance.now() - t0,
      );
      ctx.postMessage({ type: 'report', report });
      break;
    }
  }
};
