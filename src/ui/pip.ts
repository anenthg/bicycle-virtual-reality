// Picture-in-picture camera preview: small mirrored view with marker dots and
// a steering needle. This is the trust signal that tracking is alive.
// Default ON, click to collapse to a chip.

import type { Tracker } from '../tracking/tracker';
import { LS } from '../shared/types';

const STYLE = /* css */ `
.pip {
  position: absolute; left: 18px; bottom: 18px; z-index: 12;
  border-radius: 16px; overflow: hidden; cursor: pointer;
  box-shadow: 0 6px 24px rgba(0,0,0,0.45), 0 0 0 3px rgba(255,255,255,0.25);
  transition: transform 0.15s;
}
.pip:hover { transform: scale(1.03); }
.pip canvas { display: block; }
.pip-chip {
  position: absolute; left: 18px; bottom: 18px; z-index: 12;
  width: 54px; height: 54px; border-radius: 18px; border: none;
  font-size: 26px; background: rgba(20,16,40,0.75); color: #fff;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4); cursor: pointer;
}
`;

const W = 180;
const H = 135;

export class PiP {
  private el: HTMLDivElement;
  private chip: HTMLButtonElement;
  private canvas: HTMLCanvasElement;
  private tracker: Tracker;
  private visible: boolean;
  private raf = 0;

  constructor(parent: HTMLElement, tracker: Tracker) {
    this.tracker = tracker;
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.el = document.createElement('div');
    this.el.className = 'pip';
    this.el.title = 'Hide camera preview';
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.el.appendChild(this.canvas);

    this.chip = document.createElement('button');
    this.chip.className = 'pip-chip';
    this.chip.textContent = '📷';
    this.chip.title = 'Show camera preview';

    this.visible = localStorage.getItem(LS.pipHidden) !== '1';
    parent.appendChild(this.el);
    parent.appendChild(this.chip);
    this.applyVisibility();

    this.el.addEventListener('click', () => this.setVisible(false));
    this.chip.addEventListener('click', () => this.setVisible(true));

    const draw = () => {
      this.raf = requestAnimationFrame(draw);
      if (this.visible) this.draw();
    };
    draw();
  }

  setVisible(v: boolean): void {
    this.visible = v;
    localStorage.setItem(LS.pipHidden, v ? '0' : '1');
    this.applyVisibility();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.el.remove();
    this.chip.remove();
  }

  private applyVisibility(): void {
    this.el.style.display = this.visible ? 'block' : 'none';
    this.chip.style.display = this.visible ? 'none' : 'block';
  }

  private draw(): void {
    const g = this.canvas.getContext('2d');
    if (!g) return;
    const video = this.tracker.video;

    // Mirrored preview — users expect a mirror from a front camera
    g.save();
    g.scale(-1, 1);
    if (video.readyState >= 2) g.drawImage(video, -W, 0, W, H);
    else {
      g.fillStyle = '#222';
      g.fillRect(-W, 0, W, H);
    }
    g.restore();

    const report = this.tracker.latest;
    if (report) {
      // Marker dots (mirror x to match preview): lime left, pink right, blue frame
      const dots: [typeof report.left, string][] = [
        [report.left, '#a6e22e'],
        [report.right, '#ff5ec4'],
        [report.frame, '#4fb8ff'],
      ];
      for (const [pt, color] of dots) {
        if (!pt) continue;
        g.beginPath();
        g.arc((1 - pt.x) * W, pt.y * H, 6, 0, Math.PI * 2);
        g.strokeStyle = color;
        g.lineWidth = 3;
        g.stroke();
      }

      // Steering needle along the bottom
      const cx = W / 2;
      const y = H - 10;
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(10, y - 4, W - 20, 8);
      const a = report.steer.state === 'tracking' ? report.steer.angle : 0;
      g.fillStyle = report.steer.state === 'tracking' ? '#46e07d' : '#ff5a5a';
      g.beginPath();
      g.arc(cx + a * (W / 2 - 16), y, 6, 0, Math.PI * 2);
      g.fill();

      if (report.steer.state === 'lost') {
        g.fillStyle = 'rgba(255,90,90,0.9)';
        g.font = 'bold 14px sans-serif';
        g.textAlign = 'center';
        g.fillText('markers?', cx, 18);
      }
    }
  }
}
