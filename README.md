# 🚲 Endless Rider

An endless-runner cycling game for kids (~4–8) steered with a **real bicycle's
handlebars**, tracked by your **laptop's front camera**. No phone, no server,
no accounts, no downloads — one page does everything.

- **Embodied play** — the kid rides a bike, the avatar rides a bike.
- **No fail frustration** — collisions are funny and cost speed, never the run.
- **Physics as delight** — ramps, tumbling hay bales, scattering cones,
  chickens that always escape in time.
- Fully procedural graphics + synthesized audio. Zero asset files.

## Quick start

```bash
npm install
npm run dev
```

Open the printed URL (usually `http://localhost:5173`) in **Chrome or Edge**.
Localhost is a secure context, so the camera works without any HTTPS setup.

> No bike handy? Click **⌨️ Keyboard only** — arrow keys steer, Space hops,
> R restarts, P pauses. The game is fully playable with keyboard alone.

## Physical setup (2 minutes)

```
                 ~0.8 – 1.5 m
   ┌──────────┐ ◀──────────────▶   🚲  (stationary bike / trainer)
   │  laptop  │
   │  screen  │      🟩━━━━━━━━━🟪   ← neon tape on the handlebar ENDS
   │ (camera) │       handlebars
   └──────────┘
    on a table/stand — RAISE IT so the camera sees
    the handlebars roughly HEAD-ON, not from below
```

1. Put the bike on a stationary trainer (or have an adult hold it steady).
2. Place the laptop on a table ~1 m in front, screen facing the rider.
   **Raise the laptop** (books work) until the camera sees the bars head-on.
3. Wrap **two bands of bright neon tape (~3–4 cm wide)** around the very ends
   of the handlebars, outside the grips:
   - **left** end: neon **green**
   - **right** end: neon **pink or orange**
4. Check the camera view during calibration: both markers must stay in frame
   with margin when the bars turn fully left and right.

## Calibration (under a minute)

Click **🎥 Ride with camera** and follow the giant buttons:

1. **Tap the left sticker, then the right one** in the picture. A colored ring
   appears on each when it's locked.
2. **Hold the handlebars straight** → Ready.
3. **Turn all the way left** → Ready. Watch the green dot: if it moves the
   *wrong* way, press **🔄 Flip direction** first.
4. **Turn all the way right** → Ready. Done — ride!

The calibration is saved in your browser. Next time you can press
**🎥 Ride! (last calibration)** and skip straight to the game. You can
recalibrate anytime from the pause menu (P).

## Playing

- **Steer** by turning the handlebars — dodge hay bales, puddles, cones and
  parked scooters; collect ⭐ star trails; hit orange **ramps** for air time.
- **Nothing ends the run.** Hits just slow you down (and look funny).
- Every ~90 seconds you reach a **FINISH gate**: confetti, score, and
  "Ride again?" (auto-restarts after 5 s).
- The little camera picture (bottom-left) shows what tracking sees — green and
  pink rings on the markers and a dot that mirrors your steering. Click it to
  hide it.
- Cover the camera and the bike gently coasts to center + a toast appears;
  uncover and it recovers by itself.

### Controls (always active)

| Key | Action |
|---|---|
| ← / → | steer |
| Space | side-hop |
| R | restart run |
| P / Esc | pause / calibrate |
| M | mute |
| ` (backtick) | debug overlay (fps, worker ms, latency, One Euro sliders, god mode) |

### Dev tools

```
http://localhost:5173/?fake=sine            # sine-wave steering (no camera needed)
http://localhost:5173/?fake=sine&delay=120  # + simulated 120 ms camera latency
http://localhost:5173/?fake=slider          # on-screen steering slider
```

## Troubleshooting

| Problem | Fix |
|---|---|
| Steering feels reversed | Pause → Recalibrate → at step "turn left", press **Flip direction** |
| "Tracking lost" keeps appearing | More light on the handlebars; move the laptop closer; re-tap the markers (colors change at dusk) |
| Ring only on one marker | That tape is out of frame or too dark — raise the laptop, re-run calibration |
| Markers confused with the game screen colors | Use *saturated neon* tape and avoid colors close to the game's dominant hues (sky orange, grass green is OK if tape is neon) |
| Jittery steering at rest | Debug overlay (\`) → raise One Euro `minCutoff` slightly |
| Sluggish steering in fast turns | Debug overlay → raise One Euro `beta` slightly |
| Choppy on an older laptop | The game auto-drops tracking to 20 Hz and shrinks shadows; close other tabs for more headroom |
| Camera permission denied | Reload and allow the camera, or play **Keyboard only** |

## Tech (for the curious)

TypeScript + Vite + Three.js + Rapier (`@dimforge/rapier3d-compat`, WASM
lazy-loaded behind the title screen). Marker tracking is plain color-blob
detection over 320×240 pixels in a **Web Worker** (One Euro filtered),
posting a compact `SteerState` at ~30 Hz while the game renders at 60 fps.
Safari falls back to main-thread tracking when `OffscreenCanvas` is missing.
No OpenCV, no MediaPipe, no external assets.

```bash
npm run build      # production build (dist/)
npm run typecheck  # strict TS check
```
