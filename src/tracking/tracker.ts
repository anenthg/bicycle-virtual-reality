// Main-thread side of the tracking pipeline:
//  - getUserMedia (front camera, 640x480)
//  - ships frames to the worker as transferable ImageBitmaps at ~30 Hz
//    (requestVideoFrameCallback where available, setInterval fallback)
//  - main-thread detection fallback when OffscreenCanvas is unavailable
//  - patch sampling for the calibration wizard

import type {
  CalibrationProfile,
  FromWorkerMsg,
  HSVWindow,
  ToWorkerMsg,
  TrackerReport,
} from '../shared/types';
import {
  CAPTURE_H,
  CAPTURE_W,
  PROC_H,
  PROC_W,
  TRACK_HZ,
} from '../shared/types';
import { patchToWindow } from './detect';
import { SteerPipeline } from './pipeline';

export type ReportListener = (report: TrackerReport) => void;

export class Tracker {
  readonly video: HTMLVideoElement;
  stream: MediaStream | null = null;

  /** Latest report — the game polls this every tick. */
  latest: TrackerReport | null = null;

  private worker: Worker | null = null;
  private fallbackPipeline: SteerPipeline | null = null;
  private fallbackCanvas: HTMLCanvasElement | null = null;
  private sampleCanvas: HTMLCanvasElement | null = null;

  private listeners = new Set<ReportListener>();
  private hz = TRACK_HZ;
  private lastSentTs = 0;
  private inFlight = 0;
  private running = false;
  private intervalId: number | null = null;
  private rvfcSupported = false;
  private profile: CalibrationProfile | null = null;

  constructor(video: HTMLVideoElement) {
    this.video = video;
    this.rvfcSupported = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  }

  get usingWorker(): boolean {
    return this.worker !== null;
  }

  onReport(fn: ReportListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async start(): Promise<void> {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: CAPTURE_W },
        height: { ideal: CAPTURE_H },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();

    if (typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined') {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker.onmessage = (ev: MessageEvent<FromWorkerMsg>) => {
        if (ev.data.type === 'report') {
          this.inFlight = Math.max(0, this.inFlight - 1);
          this.deliver(ev.data.report);
        }
      };
      this.worker.onerror = (e) => {
        console.warn('Tracking worker failed, falling back to main thread', e);
        this.worker?.terminate();
        this.worker = null;
        this.setupFallback();
      };
      this.post({ type: 'profile', profile: this.profile });
    } else {
      this.setupFallback();
    }

    this.running = true;
    this.scheduleCapture();
  }

  stop(): void {
    this.running = false;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.worker?.terminate();
    this.worker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  setProfile(profile: CalibrationProfile | null): void {
    this.profile = profile;
    this.post({ type: 'profile', profile });
    this.fallbackPipeline?.setProfile(profile);
  }

  setFilterParams(minCutoff: number, beta: number): void {
    this.post({ type: 'filter', minCutoff, beta });
    this.fallbackPipeline?.setFilterParams(minCutoff, beta);
  }

  /** Perf tiering hook: drop to 20 Hz when the main thread is squeezed. */
  setHz(hz: number): void {
    this.hz = hz;
  }

  getHz(): number {
    return this.hz;
  }

  /**
   * Sample a 15x15 patch around a point (normalized RAW coords, 0..1) from the
   * live video into a generous HSV window. Used by wizard step 1.
   */
  samplePatch(nx: number, ny: number): HSVWindow | null {
    if (this.video.readyState < 2) return null;
    if (!this.sampleCanvas) {
      this.sampleCanvas = document.createElement('canvas');
      this.sampleCanvas.width = CAPTURE_W;
      this.sampleCanvas.height = CAPTURE_H;
    }
    const c2d = this.sampleCanvas.getContext('2d', { willReadFrequently: true });
    if (!c2d) return null;
    c2d.drawImage(this.video, 0, 0, CAPTURE_W, CAPTURE_H);
    const half = 7; // 15x15 patch
    const cx = Math.round(nx * CAPTURE_W);
    const cy = Math.round(ny * CAPTURE_H);
    const x = Math.max(0, Math.min(CAPTURE_W - 15, cx - half));
    const y = Math.max(0, Math.min(CAPTURE_H - 15, cy - half));
    const patch = c2d.getImageData(x, y, 15, 15);
    return patchToWindow(patch.data);
  }

  // -------------------------------------------------------------------------

  private post(msg: ToWorkerMsg, transfer?: Transferable[]): void {
    this.worker?.postMessage(msg, transfer ?? []);
  }

  private deliver(report: TrackerReport): void {
    this.latest = report;
    for (const fn of this.listeners) fn(report);
  }

  private setupFallback(): void {
    this.fallbackPipeline = new SteerPipeline();
    this.fallbackPipeline.setProfile(this.profile);
    this.fallbackCanvas = document.createElement('canvas');
    this.fallbackCanvas.width = PROC_W;
    this.fallbackCanvas.height = PROC_H;
  }

  private scheduleCapture(): void {
    if (this.rvfcSupported) {
      const onFrame = () => {
        if (!this.running) return;
        this.maybeCapture();
        this.video.requestVideoFrameCallback(onFrame);
      };
      this.video.requestVideoFrameCallback(onFrame);
    } else {
      this.intervalId = window.setInterval(() => this.maybeCapture(), 1000 / 30);
    }
  }

  private maybeCapture(): void {
    if (!this.running || this.video.readyState < 2) return;
    const now = performance.now();
    if (now - this.lastSentTs < 1000 / this.hz - 4) return; // hz throttle
    if (this.worker && this.inFlight >= 2) return; // backpressure: drop frame
    this.lastSentTs = now;

    if (this.worker) {
      // Downsample during bitmap creation — the worker never touches 640x480.
      createImageBitmap(this.video, {
        resizeWidth: PROC_W,
        resizeHeight: PROC_H,
      })
        .then((bitmap) => {
          if (!this.worker || !this.running) {
            bitmap.close();
            return;
          }
          this.inFlight++;
          this.post({ type: 'frame', bitmap, ts: now }, [bitmap]);
        })
        .catch(() => {
          /* video not ready — skip frame */
        });
    } else if (this.fallbackPipeline && this.fallbackCanvas) {
      const t0 = performance.now();
      const c2d = this.fallbackCanvas.getContext('2d', { willReadFrequently: true });
      if (!c2d) return;
      c2d.drawImage(this.video, 0, 0, PROC_W, PROC_H);
      const img = c2d.getImageData(0, 0, PROC_W, PROC_H);
      const report = this.fallbackPipeline.process(
        img.data,
        PROC_W,
        PROC_H,
        now,
        () => performance.now() - t0,
      );
      this.deliver(report);
    }
  }
}
