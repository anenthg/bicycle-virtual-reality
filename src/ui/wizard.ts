// Full-screen calibration wizard. Giant buttons, phrased so a parent can do
// it while the kid sits on the bike. Steps (spec §4):
//   1. tap left marker, tap right marker (live centroid dots confirm lock)
//   2. hold handlebars straight → Ready
//   3. turn all the way LEFT → Ready (needle must move left; flip if not)
//   4. turn all the way RIGHT → Ready
// Persists the profile to localStorage.

import type { CalibrationProfile } from '../shared/types';
import { wrapDeg } from '../shared/types';
import {
  draftToProvisionalProfile,
  finalizeDraft,
  newDraft,
  saveProfile,
  type DraftProfile,
} from '../tracking/calibration';
import type { Tracker } from '../tracking/tracker';

const STYLE = /* css */ `
.wiz {
  position: absolute; inset: 0; z-index: 50; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 18px; color: #fff;
  background: linear-gradient(180deg, #241a4d 0%, #4a2a6b 60%, #8a4a6b 100%);
}
.wiz h1 { font-size: clamp(26px, 4vw, 44px); margin: 0; text-align: center; padding: 0 20px;
  text-shadow: 0 3px 0 rgba(0,0,0,0.25); }
.wiz .sub { font-size: clamp(16px, 2vw, 22px); opacity: 0.85; margin: 0; text-align: center; padding: 0 24px; }
.wiz-stage { position: relative; border-radius: 20px; overflow: hidden;
  box-shadow: 0 10px 40px rgba(0,0,0,0.5), 0 0 0 4px rgba(255,255,255,0.2); }
.wiz-stage video { display: block; transform: scaleX(-1); } /* mirror like a mirror */
.wiz-stage canvas { position: absolute; inset: 0; }
.wiz-needle { width: min(70vw, 480px); height: 26px; border-radius: 13px;
  background: rgba(0,0,0,0.4); position: relative; }
.wiz-needle .pin { position: absolute; top: 3px; width: 20px; height: 20px; border-radius: 50%;
  background: #46e07d; box-shadow: 0 0 12px #46e07d; transform: translateX(-50%); left: 50%;
  transition: background 0.2s; }
.wiz-needle .tick { position: absolute; top: 0; bottom: 0; left: 50%; width: 2px; background: rgba(255,255,255,0.4); }
.wiz-row { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; }
.wiz button {
  font-size: clamp(20px, 2.6vw, 30px); font-weight: 800; padding: 16px 42px;
  border-radius: 22px; border: none; cursor: pointer; color: #06283f;
  background: linear-gradient(180deg, #6de3ff, #3db4ff);
  box-shadow: 0 5px 0 #1d7fbd, 0 10px 26px rgba(0,0,0,0.35);
}
.wiz button:active { transform: translateY(3px); box-shadow: 0 2px 0 #1d7fbd; }
.wiz button.secondary { background: rgba(255,255,255,0.16); color: #fff; box-shadow: 0 4px 14px rgba(0,0,0,0.3); font-size: clamp(16px,2vw,22px); }
.wiz button:disabled { opacity: 0.5; }
.wiz .close { position: absolute; top: 16px; right: 20px; font-size: 22px; padding: 10px 18px; }
.wiz .stepdots { display: flex; gap: 8px; }
.wiz .stepdots div { width: 12px; height: 12px; border-radius: 50%; background: rgba(255,255,255,0.3); }
.wiz .stepdots div.on { background: #ffd93d; }
`;

type Phase =
  | 'left-marker'
  | 'right-marker'
  | 'frame-marker'
  | 'center'
  | 'left-limit'
  | 'right-limit';
const PHASES: Phase[] = [
  'left-marker',
  'right-marker',
  'frame-marker',
  'center',
  'left-limit',
  'right-limit',
];

const COPY: Record<Phase, { title: string; sub: string; button: string | null }> = {
  'left-marker': {
    title: '1️⃣ Tap the LEFT marker 🟢',
    sub: 'Find the bright light/tape on the LEFT handlebar end and tap right on it.',
    button: null,
  },
  'right-marker': {
    title: '2️⃣ Now tap the RIGHT marker 🔴',
    sub: 'Tap the RIGHT handlebar light/tape. A ring means we can see it!',
    button: null,
  },
  'frame-marker': {
    title: '3️⃣ Tap the FRAME sticker 🟦 (optional)',
    sub: 'A sticker on the bike FRAME (stem or top tube — not the handlebars) lets us tell steering from leaning. Tap it, or press Skip.',
    button: null,
  },
  center: {
    title: '4️⃣ Hold the handlebars straight',
    sub: 'Sit upright, bike level, bars pointing forward — then press Ready.',
    button: '✅ Ready',
  },
  'left-limit': {
    title: '5️⃣ Turn all the way LEFT ⬅️',
    sub: 'Hold the bars all the way to the LEFT, then press Ready. (Direction is set automatically.)',
    button: '✅ Ready',
  },
  'right-limit': {
    title: '6️⃣ Turn all the way RIGHT ➡️',
    sub: 'Hold the bars at full right, then press Ready. Almost done!',
    button: '✅ Ready',
  },
};

export function runWizard(
  parent: HTMLElement,
  tracker: Tracker,
  prevProfile: CalibrationProfile | null,
): Promise<CalibrationProfile | null> {
  return new Promise((resolve) => {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    const draft: DraftProfile = newDraft(prevProfile);
    let phase: Phase = 'left-marker';
    let recording = false;

    const el = document.createElement('div');
    el.className = 'wiz';
    el.innerHTML = `
      <button class="secondary close">✕ Skip</button>
      <div class="stepdots">${PHASES.map(() => '<div></div>').join('')}</div>
      <h1></h1>
      <p class="sub"></p>
      <div class="wiz-stage">
        <video autoplay playsinline muted></video>
        <canvas></canvas>
      </div>
      <div class="wiz-needle" style="display:none"><div class="tick"></div><div class="pin"></div></div>
      <div class="wiz-row">
        <button class="ready" style="display:none">✅ Ready</button>
        <button class="secondary flip" style="display:none">🔄 Flip direction</button>
        <button class="secondary skipframe" style="display:none">⏭️ Skip (no frame sticker)</button>
      </div>
    `;
    parent.appendChild(el);

    const title = el.querySelector('h1')!;
    const sub = el.querySelector<HTMLParagraphElement>('.sub')!;
    const video = el.querySelector('video')!;
    const canvas = el.querySelector('canvas')!;
    const needle = el.querySelector<HTMLDivElement>('.wiz-needle')!;
    const pin = el.querySelector<HTMLDivElement>('.wiz-needle .pin')!;
    const readyBtn = el.querySelector<HTMLButtonElement>('.ready')!;
    const flipBtn = el.querySelector<HTMLButtonElement>('.flip')!;
    const skipFrameBtn = el.querySelector<HTMLButtonElement>('.skipframe')!;
    const dots = [...el.querySelectorAll<HTMLDivElement>('.stepdots div')];

    // Size the preview to viewport (4:3)
    const vw = Math.min(window.innerWidth * 0.62, 620);
    const vh = (vw * 3) / 4;
    video.width = vw;
    video.height = vh;
    video.style.width = `${vw}px`;
    video.style.height = `${vh}px`;
    canvas.width = vw;
    canvas.height = vh;
    video.srcObject = tracker.stream;

    const cleanup = (result: CalibrationProfile | null) => {
      cancelAnimationFrame(raf);
      el.remove();
      resolve(result);
    };

    el.querySelector('.close')!.addEventListener('click', () => cleanup(null));

    const setPhase = (p: Phase) => {
      phase = p;
      const copy = COPY[p];
      title.textContent = copy.title;
      sub.textContent = copy.sub;
      dots.forEach((d, i) => d.classList.toggle('on', PHASES[i] === p));
      readyBtn.style.display = copy.button ? 'inline-block' : 'none';
      readyBtn.textContent = copy.button ?? '';
      readyBtn.disabled = false;
      needle.style.display = p === 'center' || p === 'left-limit' || p === 'right-limit' ? 'block' : 'none';
      // Direction is auto-derived from the labeled left/right limits now, so the
      // manual flip step is retired (it would only re-introduce a reversal).
      flipBtn.style.display = 'none';
      skipFrameBtn.style.display = p === 'frame-marker' ? 'inline-block' : 'none';
    };
    setPhase('left-marker');

    // ---- marker tap sampling -------------------------------------------------
    canvas.addEventListener('click', (e) => {
      if (phase !== 'left-marker' && phase !== 'right-marker' && phase !== 'frame-marker') return;
      const rect = canvas.getBoundingClientRect();
      const dispX = (e.clientX - rect.left) / rect.width;
      const dispY = (e.clientY - rect.top) / rect.height;
      // Preview is mirrored → convert back to RAW sensor coords
      const rawX = 1 - dispX;
      const win = tracker.samplePatch(rawX, dispY);
      if (!win) return;
      if (phase === 'left-marker') {
        draft.left = win;
        setPhase('right-marker');
      } else if (phase === 'right-marker') {
        draft.right = win;
        setPhase('frame-marker');
      } else {
        draft.frame = win;
        setPhase('center');
      }
      tracker.setProfile(draftToProvisionalProfile(draft));
    });

    // ---- skip the (optional) frame marker → 2-marker mode ----------------------
    skipFrameBtn.addEventListener('click', () => {
      draft.frame = null;
      draft.leanRestDeg = null;
      setPhase('center');
      tracker.setProfile(draftToProvisionalProfile(draft));
    });

    // ---- flip direction --------------------------------------------------------
    flipBtn.addEventListener('click', () => {
      draft.steerSign = draft.steerSign === 1 ? -1 : 1;
      tracker.setProfile(draftToProvisionalProfile(draft));
    });

    // ---- Ready: average raw angle over ~600 ms ---------------------------------
    readyBtn.addEventListener('click', () => {
      if (recording) return;
      recording = true;
      readyBtn.disabled = true;
      readyBtn.textContent = '📸 Hold still…';
      const samples: number[] = [];
      const mids: number[] = [];
      const lens: number[] = [];
      const areas: number[] = [];
      const leans: number[] = []; // frame→bar-midpoint tilt, for leanRestDeg
      const un = tracker.onReport((r) => {
        if (r.left && r.right) {
          samples.push(r.steer.raw);
          const midX = (r.left.x + r.right.x) / 2;
          const midY = (r.left.y + r.right.y) / 2;
          mids.push(midX);
          lens.push(Math.abs(r.right.x - r.left.x));
          areas.push(Math.min(r.left.area, r.right.area));
          if (draft.frame && r.frame) {
            leans.push((Math.atan2(midY - r.frame.y, midX - r.frame.x) * 180) / Math.PI);
          }
        }
      });
      setTimeout(() => {
        un();
        recording = false;
        if (samples.length < 3) {
          readyBtn.disabled = false;
          readyBtn.textContent = '🙈 Can’t see both stickers — try again';
          setTimeout(() => (readyBtn.textContent = COPY[phase].button ?? ''), 1600);
          return;
        }
        // Average angles relative to the first sample (avoids wrap issues)
        const ref = samples[0];
        const avg = ref + samples.reduce((a, s) => a + wrapDeg(s - ref), 0) / samples.length;
        if (phase === 'center') {
          draft.centerDeg = avg;
          draft.centerMidX = mids.reduce((a, b) => a + b, 0) / mids.length;
          draft.barLength = lens.reduce((a, b) => a + b, 0) / lens.length;
          draft.expectedArea = areas.reduce((a, b) => a + b, 0) / areas.length;
          // Frame marker seen throughout the straight hold → record the lean
          // rest angle so runtime can cancel whole-bike lean. Otherwise drop
          // to 2-marker mode (frame stays null in the final profile).
          if (draft.frame && leans.length >= 3) {
            const lref = leans[0];
            draft.leanRestDeg =
              lref + leans.reduce((a, s) => a + wrapDeg(s - lref), 0) / leans.length;
          } else {
            draft.frame = null;
            draft.leanRestDeg = null;
          }
          setPhase('left-limit');
        } else if (phase === 'left-limit') {
          draft.leftMaxDeg = avg;
          setPhase('right-limit');
        } else if (phase === 'right-limit') {
          draft.rightMaxDeg = avg;
          const profile = finalizeDraft(draft);
          if (profile) {
            saveProfile(profile);
            tracker.setProfile(profile);
            cleanup(profile);
          } else {
            cleanup(null);
          }
        }
        tracker.setProfile(draftToProvisionalProfile(draft));
      }, 650);
    });

    // ---- live overlay: centroid rings + needle ---------------------------------
    const g = canvas.getContext('2d')!;
    let raf = 0;
    const drawLoop = () => {
      raf = requestAnimationFrame(drawLoop);
      g.clearRect(0, 0, vw, vh);
      const r = tracker.latest;
      if (!r) return;
      const ringz: [typeof r.left, string][] = [
        [r.left, '#39ff6a'],
        [r.right, '#ff5a5a'],
        [r.frame, '#4fb8ff'],
      ];
      for (const [pt, color] of ringz) {
        if (!pt) continue;
        g.beginPath();
        g.arc((1 - pt.x) * vw, pt.y * vh, 14, 0, Math.PI * 2);
        g.strokeStyle = color;
        g.lineWidth = 4;
        g.stroke();
      }

      // Needle: predicted steering direction with current steerSign
      if (needle.style.display !== 'none' && draft.centerDeg !== null) {
        const d = wrapDeg(r.steer.raw - draft.centerDeg);
        const n = Math.max(-1, Math.min(1, (d / 25) * draft.steerSign));
        pin.style.left = `${50 + n * 44}%`;
        pin.style.background = r.left && r.right ? '#46e07d' : '#ff5a5a';
      } else {
        pin.style.left = '50%';
      }
    };
    drawLoop();
  });
}
