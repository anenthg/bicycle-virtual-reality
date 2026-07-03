// Backtick debug overlay: fps, worker frame time, camera→game latency,
// angle sparkline, One Euro sliders, god mode, perf-tier log.

import type { Game } from '../game/game';
import type { Tracker } from '../tracking/tracker';
import { ONE_EURO_BETA, ONE_EURO_MIN_CUTOFF } from '../shared/types';

const STYLE = /* css */ `
.dbg {
  position: absolute; top: 90px; right: 16px; z-index: 40; width: 280px;
  background: rgba(10,8,24,0.88); border-radius: 14px; padding: 14px;
  color: #9fe8c5; font: 12px/1.5 ui-monospace, Menlo, monospace;
  box-shadow: 0 8px 30px rgba(0,0,0,0.5); display: none;
  pointer-events: auto;
}
.dbg.show { display: block; }
.dbg h3 { margin: 0 0 6px; font-size: 13px; color: #fff; }
.dbg .row { display: flex; justify-content: space-between; }
.dbg canvas { width: 100%; height: 44px; background: rgba(255,255,255,0.06); border-radius: 6px; margin: 6px 0; }
.dbg label { display: block; margin-top: 6px; color: #cfd6e4; }
.dbg input[type=range] { width: 100%; }
.dbg .log { max-height: 60px; overflow-y: auto; color: #ffce3d; font-size: 11px; }
`;

export class DebugOverlay {
  private el: HTMLDivElement;
  private spark: HTMLCanvasElement;
  private history: number[] = [];
  private game: Game;
  private tracker: Tracker | null;
  private logEl: HTMLDivElement;
  private visible = false;

  constructor(parent: HTMLElement, game: Game, tracker: Tracker | null) {
    this.game = game;
    this.tracker = tracker;
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.el = document.createElement('div');
    this.el.className = 'dbg';
    this.el.innerHTML = `
      <h3>debug (\`)</h3>
      <div class="row"><span>fps</span><b data-k="fps"></b></div>
      <div class="row"><span>frame ms</span><b data-k="frame"></b></div>
      <div class="row"><span>phys ms</span><b data-k="phys"></b></div>
      <div class="row"><span>worker ms</span><b data-k="worker"></b></div>
      <div class="row"><span>cam→game ms</span><b data-k="lat"></b></div>
      <div class="row"><span>track hz</span><b data-k="hz"></b></div>
      <div class="row"><span>tier</span><b data-k="tier"></b></div>
      <div class="row"><span>speed</span><b data-k="speed"></b></div>
      <canvas width="252" height="44"></canvas>
      <label>One Euro minCutoff <span data-k="mc"></span>
        <input type="range" min="0.1" max="4" step="0.05" value="${ONE_EURO_MIN_CUTOFF}" data-s="mc"></label>
      <label>One Euro beta <span data-k="beta"></span>
        <input type="range" min="0" max="0.05" step="0.001" value="${ONE_EURO_BETA}" data-s="beta"></label>
      <label><input type="checkbox" data-s="god"> god mode (no collisions)</label>
      <div class="log"></div>
    `;
    parent.appendChild(this.el);
    this.spark = this.el.querySelector('canvas')!;
    this.logEl = this.el.querySelector('.log')!;

    const mc = this.el.querySelector<HTMLInputElement>('[data-s="mc"]')!;
    const beta = this.el.querySelector<HTMLInputElement>('[data-s="beta"]')!;
    const push = () => {
      this.set('mc', mc.value);
      this.set('beta', beta.value);
      this.tracker?.setFilterParams(Number(mc.value), Number(beta.value));
    };
    mc.addEventListener('input', push);
    beta.addEventListener('input', push);
    push();

    this.el
      .querySelector<HTMLInputElement>('[data-s="god"]')!
      .addEventListener('change', (e) => {
        this.game.godMode = (e.target as HTMLInputElement).checked;
      });

    window.addEventListener('keydown', (e) => {
      if (e.key === '`') {
        this.visible = !this.visible;
        this.el.classList.toggle('show', this.visible);
      }
    });
  }

  logTier(msg: string): void {
    const line = document.createElement('div');
    line.textContent = `⚠ ${msg}`;
    this.logEl.appendChild(line);
  }

  /** Call every frame (cheap when hidden). */
  update(steer: number): void {
    this.history.push(steer);
    if (this.history.length > 126) this.history.shift();
    if (!this.visible) return;

    const s = this.game.stats;
    this.set('fps', s.fps.toFixed(0));
    this.set('frame', s.frameMs.toFixed(1));
    this.set('phys', s.physMs.toFixed(1));
    const rep = this.tracker?.latest;
    this.set('worker', rep ? rep.workerMs.toFixed(1) : '—');
    this.set('lat', rep ? (performance.now() - rep.steer.ts).toFixed(0) : '—');
    this.set('hz', this.tracker ? String(this.tracker.getHz()) : '—');
    this.set('tier', String(s.tier));
    this.set('speed', `${s.speed.toFixed(1)} m/s`);

    // Angle sparkline
    const g = this.spark.getContext('2d')!;
    const w = this.spark.width;
    const h = this.spark.height;
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,255,255,0.2)';
    g.beginPath();
    g.moveTo(0, h / 2);
    g.lineTo(w, h / 2);
    g.stroke();
    g.strokeStyle = '#46e07d';
    g.lineWidth = 1.5;
    g.beginPath();
    this.history.forEach((v, i) => {
      const x = (i / 125) * w;
      const y = h / 2 - v * (h / 2 - 3);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.stroke();
  }

  private set(key: string, val: string): void {
    const el = this.el.querySelector(`[data-k="${key}"]`);
    if (el) el.textContent = val;
  }
}
