// Kid-legible HUD: giant score, star counter, tracking-status dot, toasts,
// magnet timer, speed lines, finish-gate banner and pause menu.

import type { GateSummary } from '../game/game';
import { MAX_SPEED, clamp } from '../shared/types';

const STYLE = /* css */ `
.hud { position: absolute; inset: 0; pointer-events: none; z-index: 10; color: #fff; }
.hud * { pointer-events: none; }
.hud .clickable { pointer-events: auto; cursor: pointer; }

.hud-score {
  position: absolute; top: 18px; left: 50%; transform: translateX(-50%);
  font-size: clamp(38px, 6vw, 64px); font-weight: 800;
  text-shadow: 0 3px 0 rgba(0,0,0,0.25), 0 6px 18px rgba(0,0,0,0.3);
  letter-spacing: 0.02em;
}
.hud-stars {
  position: absolute; top: 22px; left: 24px;
  font-size: clamp(26px, 3.6vw, 40px); font-weight: 800;
  text-shadow: 0 2px 0 rgba(0,0,0,0.25), 0 4px 12px rgba(0,0,0,0.3);
}
.hud-stars .bump { display: inline-block; animation: er-pop 0.35s ease; }
.hud-magnet {
  position: absolute; top: calc(22px + clamp(30px, 4vw, 46px)); left: 24px;
  font-size: clamp(18px, 2.2vw, 26px); font-weight: 700;
  text-shadow: 0 2px 6px rgba(0,0,0,0.4); opacity: 0; transition: opacity 0.2s;
}
.hud-topright { position: absolute; top: 20px; right: 20px; display: flex; gap: 12px; align-items: center; }
.hud-dot { width: 16px; height: 16px; border-radius: 50%; background: #888;
  box-shadow: 0 0 10px rgba(0,0,0,0.4); transition: background 0.25s; }
.hud-dot.ok { background: #46e07d; box-shadow: 0 0 12px #46e07d; }
.hud-dot.warn { background: #ffce3d; box-shadow: 0 0 12px #ffce3d; }
.hud-dot.bad { background: #ff5a5a; box-shadow: 0 0 12px #ff5a5a; }
.hud-btn {
  font-size: 24px; width: 52px; height: 52px; border-radius: 16px;
  border: none; background: rgba(255,255,255,0.18); color: #fff;
  backdrop-filter: blur(6px); box-shadow: 0 3px 10px rgba(0,0,0,0.25);
}
.hud-btn:active { transform: scale(0.94); }
.hud-toast {
  position: absolute; top: 16%; left: 50%; transform: translateX(-50%);
  background: rgba(20,16,40,0.82); padding: 14px 26px; border-radius: 20px;
  font-size: clamp(20px, 2.6vw, 30px); font-weight: 700; white-space: nowrap;
  box-shadow: 0 8px 30px rgba(0,0,0,0.4); opacity: 0; transition: opacity 0.3s;
}
.hud-banner {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 10px;
  background: radial-gradient(ellipse at center, rgba(30,20,60,0.55), rgba(30,20,60,0.85));
  opacity: 0; transition: opacity 0.4s; visibility: hidden;
}
.hud-banner.show { opacity: 1; visibility: visible; }
.hud-banner h1 {
  font-size: clamp(44px, 8vw, 90px); margin: 0; animation: er-pop 0.5s ease;
  text-shadow: 0 4px 0 rgba(0,0,0,0.3), 0 10px 30px rgba(0,0,0,0.4);
}
.hud-banner .big-score { font-size: clamp(60px, 10vw, 120px); font-weight: 800; color: #ffd93d;
  text-shadow: 0 4px 0 rgba(120,80,0,0.5), 0 10px 30px rgba(0,0,0,0.5); animation: er-float 2.2s ease-in-out infinite; }
.hud-banner .detail { font-size: clamp(22px, 3vw, 34px); font-weight: 700; opacity: 0.95; }
.hud-banner .newhigh { color: #7dffb0; font-weight: 800; font-size: clamp(24px, 3.4vw, 38px); animation: er-pop 0.6s ease; }
.hud-banner button {
  margin-top: 18px; font-size: clamp(26px, 3.4vw, 40px); font-weight: 800;
  padding: 18px 48px; border-radius: 26px; border: none; color: #3b2b00;
  background: linear-gradient(180deg, #ffe27a, #ffc93d);
  box-shadow: 0 6px 0 #c98f00, 0 12px 30px rgba(0,0,0,0.4);
}
.hud-banner button:active { transform: translateY(4px); box-shadow: 0 2px 0 #c98f00; }
.hud-banner .countdown { font-size: 20px; opacity: 0.8; margin-top: 10px; }

.hud-pause {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 16px;
  background: rgba(15,12,32,0.8); backdrop-filter: blur(6px);
  opacity: 0; visibility: hidden; transition: opacity 0.25s;
}
.hud-pause.show { opacity: 1; visibility: visible; }
.hud-pause h2 { font-size: clamp(34px, 5vw, 54px); margin: 0 0 10px; }
.hud-pause button {
  font-size: clamp(20px, 2.6vw, 28px); font-weight: 700; min-width: 320px;
  padding: 16px 34px; border-radius: 20px; border: none;
  background: rgba(255,255,255,0.14); color: #fff;
  box-shadow: 0 4px 14px rgba(0,0,0,0.3);
}
.hud-pause button.primary { background: linear-gradient(180deg, #6de3ff, #3db4ff); color: #06283f; }
.hud-pause button:active { transform: scale(0.97); }
`;

export class HUD {
  onPause: (() => void) | null = null;
  onMuteToggle: (() => void) | null = null;

  private root: HTMLDivElement;
  private scoreEl: HTMLDivElement;
  private starsEl: HTMLDivElement;
  private magnetEl: HTMLDivElement;
  private dotEl: HTMLDivElement;
  private muteBtn: HTMLButtonElement;
  private toastEl: HTMLDivElement;
  private banner: HTMLDivElement;
  private pauseMenu: HTMLDivElement;
  private overlay: HTMLCanvasElement;
  private lastStars = -1;
  private toastHideAt = 0;
  private countdownTimer: number | null = null;

  constructor(parent: HTMLElement, overlayCanvas: HTMLCanvasElement) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.overlay = overlayCanvas;
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud-score">0</div>
      <div class="hud-stars">⭐ <span>0</span></div>
      <div class="hud-magnet">🧲 <span></span></div>
      <div class="hud-topright">
        <div class="hud-dot" title="tracking status"></div>
        <button class="hud-btn clickable" data-act="mute">🔊</button>
        <button class="hud-btn clickable" data-act="pause">⏸️</button>
      </div>
      <div class="hud-toast"></div>
      <div class="hud-banner"></div>
      <div class="hud-pause"></div>
    `;
    parent.appendChild(this.root);

    this.scoreEl = this.root.querySelector('.hud-score')!;
    this.starsEl = this.root.querySelector('.hud-stars span')!;
    this.magnetEl = this.root.querySelector('.hud-magnet')!;
    this.dotEl = this.root.querySelector('.hud-dot')!;
    this.muteBtn = this.root.querySelector('[data-act="mute"]')!;
    this.toastEl = this.root.querySelector('.hud-toast')!;
    this.banner = this.root.querySelector('.hud-banner')!;
    this.pauseMenu = this.root.querySelector('.hud-pause')!;

    this.muteBtn.addEventListener('click', () => this.onMuteToggle?.());
    this.root
      .querySelector('[data-act="pause"]')!
      .addEventListener('click', () => this.onPause?.());
  }

  update(
    score: number,
    stars: number,
    magnetTimer: number,
    trackingState: 'tracking' | 'lost' | 'calibrating' | 'off',
    quality: number,
    speed: number,
  ): void {
    this.scoreEl.textContent = String(score);
    if (stars !== this.lastStars) {
      this.lastStars = stars;
      this.starsEl.textContent = String(stars);
      this.starsEl.classList.remove('bump');
      void this.starsEl.offsetWidth; // restart animation
      this.starsEl.classList.add('bump');
    }
    this.magnetEl.style.opacity = magnetTimer > 0 ? '1' : '0';
    if (magnetTimer > 0) {
      this.magnetEl.querySelector('span')!.textContent = `${Math.ceil(magnetTimer)}s`;
    }

    this.dotEl.className = 'hud-dot';
    if (trackingState === 'tracking') {
      this.dotEl.classList.add(quality > 0.4 ? 'ok' : 'warn');
    } else if (trackingState === 'calibrating') {
      this.dotEl.classList.add('warn');
    } else if (trackingState === 'lost') {
      this.dotEl.classList.add('bad');
    }

    // Tracking-lost toast handled by caller via toast(); expire stale ones
    if (this.toastHideAt && performance.now() > this.toastHideAt) {
      this.toastEl.style.opacity = '0';
      this.toastHideAt = 0;
    }

    this.drawSpeedLines(speed / MAX_SPEED);
  }

  toast(msg: string, ms = 2500): void {
    this.toastEl.textContent = msg;
    this.toastEl.style.opacity = '1';
    this.toastHideAt = ms === Infinity ? 0 : performance.now() + ms;
    if (ms === Infinity) this.toastHideAt = 0; // sticky — call hideToast()
  }

  stickyToast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.style.opacity = '1';
    this.toastHideAt = 0;
  }

  hideToast(): void {
    this.toastEl.style.opacity = '0';
    this.toastHideAt = 0;
  }

  setMuted(muted: boolean): void {
    this.muteBtn.textContent = muted ? '🔇' : '🔊';
  }

  showGateBanner(summary: GateSummary, onAgain: () => void): void {
    this.banner.innerHTML = `
      <h1>🎉 FINISH! 🎉</h1>
      <div class="big-score">${summary.score}</div>
      <div class="detail">🚴 ${summary.distance} m &nbsp;·&nbsp; ⭐ ${summary.stars}</div>
      ${summary.isNewHigh ? '<div class="newhigh">🏆 New best score!</div>' : `<div class="detail" style="opacity:0.7">Best: ${summary.highScore}</div>`}
      <button class="clickable">Ride again? 🚲</button>
      <div class="countdown"></div>
    `;
    this.banner.classList.add('show');
    const btn = this.banner.querySelector('button')!;
    const countdown = this.banner.querySelector('.countdown')!;
    const go = () => {
      this.hideGateBanner();
      onAgain();
    };
    btn.addEventListener('click', go, { once: true });
    // Auto-restart after 5 s idle (spec §5)
    let left = 5;
    countdown.textContent = `starting again in ${left}…`;
    this.countdownTimer = window.setInterval(() => {
      left--;
      if (left <= 0) go();
      else countdown.textContent = `starting again in ${left}…`;
    }, 1000);
  }

  hideGateBanner(): void {
    this.banner.classList.remove('show');
    if (this.countdownTimer !== null) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  showPauseMenu(opts: {
    cameraMode: boolean;
    onResume: () => void;
    onRestart: () => void;
    onRecalibrate: () => void;
  }): void {
    this.pauseMenu.innerHTML = `
      <h2>⏸️ Paused</h2>
      <button class="primary clickable" data-a="resume">▶️ Keep riding</button>
      <button class="clickable" data-a="restart">🔁 Restart run</button>
      ${opts.cameraMode ? '<button class="clickable" data-a="recal">🎯 Recalibrate camera</button>' : ''}
    `;
    this.pauseMenu.classList.add('show');
    this.pauseMenu.querySelector('[data-a="resume"]')!.addEventListener('click', opts.onResume);
    this.pauseMenu.querySelector('[data-a="restart"]')!.addEventListener('click', opts.onRestart);
    this.pauseMenu.querySelector('[data-a="recal"]')?.addEventListener('click', opts.onRecalibrate);
  }

  hidePauseMenu(): void {
    this.pauseMenu.classList.remove('show');
  }

  isPauseMenuOpen(): boolean {
    return this.pauseMenu.classList.contains('show');
  }

  /** Radial speed lines on the 2D overlay canvas when going fast. */
  private drawSpeedLines(speedNorm: number): void {
    const c = this.overlay;
    if (c.width !== c.clientWidth || c.height !== c.clientHeight) {
      c.width = c.clientWidth;
      c.height = c.clientHeight;
    }
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, c.width, c.height);
    const intensity = clamp((speedNorm - 0.6) / 0.4, 0, 1);
    if (intensity <= 0) return;
    const cx = c.width / 2;
    const cy = c.height / 2;
    const n = Math.floor(intensity * 14);
    g.strokeStyle = `rgba(255,255,255,${0.28 * intensity})`;
    g.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + ((performance.now() * 0.003 + i * 7) % 0.6);
      // keep lines near the edges, out of the play view
      const r0 = Math.min(cx, cy) * (0.82 + (i % 3) * 0.06);
      const r1 = r0 + 60 + intensity * 90;
      g.lineWidth = 2 + (i % 3);
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      g.stroke();
    }
  }
}
