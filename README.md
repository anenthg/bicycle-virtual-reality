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
   - **left** end: neon **lime-green**
   - **right** end: neon **pink / magenta**
4. *(Optional but recommended)* Add a **third neon-blue** sticker on the bike
   **frame** — the stem or top tube, somewhere that does **not** turn with the
   handlebars. This lets the tracker tell *steering* apart from *leaning the
   whole bike*, so a wobble/lean is no longer misread as a turn. Skip it and the
   game runs in plain 2-marker mode (leaning will read as steering).

   **Pick colors your bike and room don't already have.** The tracker locks onto
   a color, so a marker that matches your frame (e.g. a yellow sticker on a
   yellow bike) or the furniture behind it (warm wood ≈ orange/red) will confuse
   it. Red / green / blue are the defaults because they're far apart and rare in
   bikes and rooms. Any three distinct, saturated colors work — calibration
   samples whatever you tap.
5. Check the camera view during calibration: all markers must stay in frame
   with margin when the bars turn fully left and right.

## Calibration (under a minute)

Click **🎥 Ride with camera** and follow the giant buttons:

1. **Tap the left sticker, then the right one** in the picture. A colored ring
   appears on each when it's locked.
2. **Tap the blue frame sticker** (or press **⏭️ Skip** if you didn't add one).
3. **Hold the handlebars straight, bike level** → Ready. This records the
   "upright" reference used to cancel out leaning.
4. **Turn all the way left** → Ready. Watch the green dot: if it moves the
   *wrong* way, press **🔄 Flip direction** first.
5. **Turn all the way right** → Ready. Done — ride!

> **How lean cancellation works:** the tracker measures the tilt of the line
> between the two grip stickers. Both *steering* and *leaning the whole bike*
> tilt that line, so they're ambiguous with two markers. The frame sticker gives
> a fixed "level" reference: the tracker subtracts the frame's roll, leaving pure
> steering. Keep the bike upright during calibration so the reference is honest.

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
| Leaning/wobbling the bike steers it | Add the neon-blue **frame** sticker and recalibrate (enables lean cancellation) |
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

### 3D art assets

The player, bike, trees, houses, obstacles and props are **HD GLB models** in
`public/models/`, loaded at runtime by `src/game/assets.ts` (Meshopt-compressed,
~0.3–0.7 MB each). Every model is optional: if a `.glb` is missing, the game
falls back to the procedural mesh it shipped with, so it always runs.

Assets were generated with the Higgsfield MCP (`generate_image` →
`image_to_3d`) and compressed for the web:

```bash
node scripts/fetch-asset.mjs <glb-url> /tmp/raw/pine.glb        # download
node scripts/optimize-glb.mjs /tmp/raw/pine.glb public/models/pine.glb 1024
```

`optimize-glb.mjs` wraps `gltf-transform optimize` (WebP textures + Meshopt),
turning the raw ~10 MB exports into web-ready GLBs. To swap in a new model,
drop a replacement `.glb` under `public/models/` using the same filename.
