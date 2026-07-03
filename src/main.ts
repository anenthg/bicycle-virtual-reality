// Boot: title screen → (optional) camera + calibration wizard → game.
// Rapier's WASM lazy-loads behind the title screen (spec §3).

import type RAPIER from '@dimforge/rapier3d-compat';
import { assets } from './game/assets';
import { AudioEngine } from './game/audio';
import { Game, type GateSummary } from './game/game';
import { InputManager } from './game/input';
import { LS, TRACK_HZ_REDUCED } from './shared/types';
import { loadProfile } from './tracking/calibration';
import { Tracker } from './tracking/tracker';
import { DebugOverlay } from './ui/debug';
import { HUD } from './ui/hud';
import { PiP } from './ui/pip';
import { runWizard } from './ui/wizard';

const TITLE_STYLE = /* css */ `
.title {
  position: absolute; inset: 0; z-index: 60; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 14px; color: #fff; text-align: center;
  background: linear-gradient(180deg, #2a1a5e 0%, #6b3fa8 45%, #ff9e5e 100%);
}
.title h1 {
  font-size: clamp(44px, 9vw, 96px); margin: 0;
  text-shadow: 0 5px 0 rgba(0,0,0,0.25), 0 14px 40px rgba(0,0,0,0.35);
  animation: er-float 3s ease-in-out infinite;
}
.title .tag { font-size: clamp(18px, 2.6vw, 28px); opacity: 0.92; margin: 0 0 14px; }
.title button {
  font-size: clamp(22px, 3vw, 34px); font-weight: 800; min-width: min(76vw, 460px);
  padding: 18px 40px; border-radius: 26px; border: none; cursor: pointer; color: #3b2b00;
  background: linear-gradient(180deg, #ffe27a, #ffc93d);
  box-shadow: 0 6px 0 #c98f00, 0 14px 34px rgba(0,0,0,0.35);
}
.title button:active { transform: translateY(4px); box-shadow: 0 2px 0 #c98f00; }
.title button.secondary {
  background: rgba(255,255,255,0.16); color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  font-size: clamp(18px, 2.2vw, 26px); font-weight: 700;
}
.title .high { margin-top: 18px; font-size: clamp(16px, 2vw, 22px); opacity: 0.85; }
.title .loading { font-size: 15px; opacity: 0.7; margin-top: 8px; }
`;

async function boot(): Promise<void> {
  const app = document.getElementById('app')!;
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  const overlay2d = document.getElementById('overlay-2d') as HTMLCanvasElement;
  const camVideo = document.getElementById('cam-video') as HTMLVideoElement;

  // Kick off the WASM download immediately; await it only when starting.
  const rapierPromise: Promise<typeof RAPIER> = import('@dimforge/rapier3d-compat').then(
    async (mod) => {
      const R = mod.default;
      await R.init();
      return R;
    },
  );

  const audio = new AudioEngine();
  const input = new InputManager();
  const params = new URLSearchParams(location.search);

  // ---- title screen ----------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = TITLE_STYLE;
  document.head.appendChild(style);

  const savedProfile = loadProfile();
  const high = Number(localStorage.getItem(LS.highScore) ?? 0);

  const title = document.createElement('div');
  title.className = 'title';
  title.innerHTML = `
    <h1>🚲 Endless Rider</h1>
    <p class="tag">Steer with your real handlebars!</p>
    ${
      savedProfile
        ? `<button data-a="last">🎥 Ride! <small>(last calibration)</small></button>
           <button class="secondary" data-a="recal">🎯 Recalibrate camera</button>`
        : `<button data-a="recal">🎥 Ride with camera</button>`
    }
    <button class="secondary" data-a="kb">⌨️ Keyboard only</button>
    ${high > 0 ? `<div class="high">🏆 Best score: ${high}</div>` : ''}
    <div class="loading"></div>
  `;
  app.appendChild(title);
  const loading = title.querySelector<HTMLDivElement>('.loading')!;

  const choose = (): Promise<'last' | 'recal' | 'kb'> =>
    new Promise((res) => {
      title.querySelectorAll('button').forEach((b) =>
        b.addEventListener('click', () => res(b.dataset.a as 'last' | 'recal' | 'kb'), {
          once: true,
        }),
      );
    });

  // Dev/CI hook: ?autostart=kb|last|recal skips the title-screen click
  const auto = params.get('autostart');
  const mode =
    auto === 'kb' || auto === 'last' || auto === 'recal' ? auto : await choose();
  audio.init(); // first user gesture — audio may now start
  audio.click();

  // ---- camera path -------------------------------------------------------------
  let tracker: Tracker | null = null;
  let pip: PiP | null = null;
  let cameraMode = false;

  if (mode !== 'kb') {
    loading.textContent = '📷 starting camera…';
    tracker = new Tracker(camVideo);
    try {
      await tracker.start();
      cameraMode = true;
    } catch (err) {
      console.warn('camera unavailable', err);
      loading.textContent = '📷 Camera unavailable — riding with keyboard.';
      tracker = null;
      await new Promise((r) => setTimeout(r, 1400));
    }
  }

  if (tracker) {
    let profile = mode === 'last' ? savedProfile : null;
    if (profile) {
      tracker.setProfile(profile);
    } else {
      title.style.display = 'none';
      profile = await runWizard(app, tracker, savedProfile);
      title.style.display = 'flex';
      if (!profile) {
        // Wizard skipped: keyboard it is (camera keeps running for PiP fun)
        tracker.stop();
        tracker = null;
        cameraMode = false;
      }
    }
  }

  if (tracker) {
    input.enableCamera();
    tracker.onReport((r) => input.acceptReport(r));
  }

  loading.textContent = '🎮 loading physics…';
  // Preload GLB assets alongside the physics WASM. Missing meshes fall back to
  // procedural, so this never blocks the game from starting.
  const [rapier] = await Promise.all([rapierPromise, assets.preload()]);
  title.remove();

  // ---- game + UI ------------------------------------------------------------------
  const hud = new HUD(app, overlay2d);
  hud.setMuted(audio.muted);

  let debug: DebugOverlay | undefined; // assigned below (hooks close over it)

  const onGate = (summary: GateSummary): void => {
    input.suspended = true;
    hud.showGateBanner(summary, () => {
      input.suspended = false;
      game.restart();
    });
  };

  const game = new Game(canvas, rapier, input, audio, {
    onGate,
    onRunStart: () => hud.hideGateBanner(),
    onTierChange: (tier, msg) => {
      debug?.logTier(`tier ${tier}: ${msg}`);
      if (tier === 1) tracker?.setHz(TRACK_HZ_REDUCED);
    },
    onFrame: (snap) => {
      hud.update(
        game.score,
        game.starsCollected,
        game.magnetTimer,
        snap.trackingState,
        snap.quality,
        game.stats.speed,
      );
      debug?.update(snap.steer);
      // Tracking-lost UX: sticky toast until recovery
      if (cameraMode) {
        if (snap.trackingState === 'lost' && !lostToastShown) {
          lostToastShown = true;
          hud.stickyToast('📷 Tracking lost — can the camera see both stickers?');
        } else if (snap.trackingState === 'tracking' && lostToastShown) {
          lostToastShown = false;
          hud.hideToast();
        }
      }
    },
  });

  let lostToastShown = false;
  debug = new DebugOverlay(app, game, tracker);
  if (tracker) pip = new PiP(app, tracker);
  void pip;

  // ---- pause / restart / mute wiring ----------------------------------------------
  const openPause = (): void => {
    if (game.state === 'gate') return;
    game.pause();
    input.suspended = true;
    hud.showPauseMenu({
      cameraMode,
      onResume: () => {
        hud.hidePauseMenu();
        input.suspended = false;
        game.resume();
      },
      onRestart: () => {
        hud.hidePauseMenu();
        input.suspended = false;
        game.restart();
      },
      onRecalibrate: async () => {
        if (!tracker) return;
        hud.hidePauseMenu();
        const p = await runWizard(app, tracker, loadProfile());
        if (p) tracker.setProfile(p);
        input.suspended = false;
        game.resume();
      },
    });
  };

  input.onPause = () => {
    if (game.state === 'paused') {
      hud.hidePauseMenu();
      input.suspended = false;
      game.resume();
    } else {
      openPause();
    }
  };
  // While the pause MENU is up, Escape/P still closes it (input is suspended,
  // so InputManager won't see the key). Not during the wizard overlay.
  window.addEventListener('keydown', (e) => {
    if ((e.code === 'KeyP' || e.code === 'Escape') && hud.isPauseMenuOpen()) {
      hud.hidePauseMenu();
      input.suspended = false;
      game.resume();
    }
  });
  input.onRestart = () => {
    if (game.state === 'playing') game.restart();
  };
  const toggleMute = (): void => {
    audio.setMuted(!audio.muted);
    hud.setMuted(audio.muted);
  };
  input.onMute = toggleMute;
  hud.onMuteToggle = toggleMute;
  hud.onPause = openPause;

  // ---- dev fake input (?fake=sine|slider&delay=120) --------------------------------
  if (params.has('fake')) {
    const { setupFakeInput } = await import('../scripts/fake-input');
    setupFakeInput(input, params);
  }

  const warp = Number(params.get('warp') ?? 0);
  if (warp > 0) game.warpTo(warp);

  game.start();

  const sim = Number(params.get('sim') ?? 0);
  if (sim > 0) game.simulate(sim);
}

void boot();
