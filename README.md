# 🚲 Endless Rider

An endless-runner cycling game for kids (~4–8) that you steer with a **real
bicycle's handlebars**, tracked live by your **laptop's webcam**. The child sits
on a stationary bike, turns the bars, and the on-screen rider dodges obstacles,
collects stars, and hits ramps. No phone, no server, no accounts, no downloads —
one web page does everything.

- **Embodied play** — the kid rides a bike, the avatar rides a bike.
- **No-fail** — collisions are funny and cost a little speed, never the run.
- **Physics as delight** — ramps, tumbling hay bales, scattering cones, chickens
  that always flap away in time.
- **Fully self-contained** — HD 3D models are bundled; audio is synthesized in
  the browser. Runs offline after install.

There are two things to set up: the **code** (this repo) and the **bike +
camera** in the room. Both are below, plus a best-practices checklist.

---

## Part 1 — Code setup (install from the repo)

### Prerequisites

- **Node.js 18+** (20 LTS recommended) and npm — check with `node -v`.
- A **Chromium browser: Chrome or Edge** (primary). Safari works as a fallback
  but is less tested (it uses a slower main-thread tracking path).
- A **webcam** (built-in laptop cam is fine) for the camera controls. Not needed
  for keyboard-only play.

### Install and run

```bash
git clone https://github.com/anenth-civix/advaith-game.git
cd advaith-game
npm install
npm run dev
```

Open the printed URL (usually **http://localhost:5173**) in Chrome or Edge.
`localhost` counts as a secure context, so the webcam works with **no HTTPS
setup or certificates**.

> **Just want to see it?** Click **⌨️ Keyboard only** on the title screen — no
> camera needed. Arrows steer, Space hops, R restarts, P pauses.

### Other commands

```bash
npm run build      # production build → dist/ (static; host anywhere)
npm run preview    # serve the production build locally
npm run typecheck  # strict TypeScript check
```

Deploying the built `dist/` to any static HTTPS host (Netlify, GitHub Pages, an
S3 bucket) also works — the camera needs either `localhost` or HTTPS.

---

## Part 2 — The bike + camera setup

### How the steering works (30-second version)

You put **two bright markers on the handlebar ends** and (optionally) **one on
the frame**. The webcam watches them. As the child turns the bars, the line
between the two grip markers **tilts**, and that tilt drives the steering. The
optional frame marker lets the game tell *steering* apart from *leaning the whole
bike*.

Because the markers are found **by color**, the whole game lives or dies on
**marker contrast** and **camera angle**. Get those right and it's rock-solid.

### What you need

- A **stationary bike** — a bike on a trainer/stand, or an adult holding it
  steady. (The child steers the bars; the bike shouldn't roll around.)
- A **laptop** (or laptop feeding a TV) with a webcam, on a **stand/stack of
  books** so it can look at the handlebars.
- **Three markers.** Two options, in order of preference:

#### Option A — Bright LEDs (most consistent) ✅

Small battery LED lights (bike lights, clip-on LEDs) in **three distinct
colors**. LEDs don't care about room lighting, which makes them very stable.

- The tracker locks onto the **bright, saturated core** of each light, so
  **brighter + more saturated is better**.
- Point each LED **toward the camera** so the camera sees its color, not just a
  white blob from the side.
- If an LED looks white/washed-out on camera (its core "blows out"), it's too
  intense/bare — **diffuse it** with a bit of frosted tape or a translucent cap
  so it reads as a colored glow, and/or angle it slightly off-axis.

#### Option B — Neon tape

Bands of **matte fluorescent tape ~3–4 cm wide** wrapped around the bar ends
(outside the grips) and the frame. Cheap and reliable in **good, even light**.
Avoid glossy/metallic tape — glare turns it white and loses the color.

### Marker colors (this matters a lot)

Use **three distinct, saturated colors** that are far apart on the color wheel.
The app's defaults are:

| Marker | Default color | Goes on |
|---|---|---|
| Grip A | **Green** | one handlebar end |
| Grip B | **Red** | the other handlebar end |
| Frame *(optional)* | **Blue** | the stem / top tube (a part that does **not** turn) |

**It does not matter which grip color is on the left vs the right** — the game
figures out direction automatically during calibration (see Part 3). Any three
distinct saturated colors work; calibration samples whatever you point at.

**Rules for picking colors — learned the hard way:**

- **Don't reuse a color your bike already is.** A yellow marker on a yellow bike
  is invisible to the tracker (it can't tell them apart). Glance at your frame,
  fork, and tires first.
- **Avoid warm colors (red/orange/pink) if warm things share the view** — wooden
  furniture, skin, and warm lighting all live in the red/orange range and can
  out-vote a small red marker. Bright, saturated LEDs mostly beat this; pale tape
  does not.
- **Keep the two grip colors far apart in hue** and far from the frame color.
  Don't use two blues (a cyan grip + a blue frame will be confused). Green + red
  + blue is a good, well-separated trio.
- **White doesn't work as a marker** — it has no color to lock onto and blends
  with reflections, glare, and bright walls. If you want the frame reference, use
  a *colored* light/tape, not a white one.

### Camera placement (the single biggest factor for good steering)

```
        RAISE + TILT DOWN                    ~0.8 – 1.5 m
      ┌──────────┐                     ◀───────────────────▶     🚲
      │  laptop  │  ╲  looks DOWN                          ( stationary bike )
      │  webcam  │    ╲  at the bars      🟢━━━━━━━━●━━━━━━━━🔴
      └──────────┘      ╲___________▶      green   blue    red
       on books/stand                      grip    frame   grip
```

1. Place the laptop **~1 m in front** of the bike, screen facing the rider.
2. **Raise the camera above the handlebars and angle it down at them.** This is
   the most important tip: looking *down* on the bars, turning them clearly
   **rotates** the marker line in the image → a strong, clean steering signal.
   A camera that's *level/head-on* barely sees the bars tilt when you steer, so
   steering feels weak and mushy. If steering is unresponsive, raise/tilt more.
3. Frame it so **all markers stay in view with margin** when the bars turn fully
   left and right.
4. **Keep the background plain** behind the bars — a wall or floor, not a busy
   sofa, a poster (a blue sky or orange bridge poster is a classic false match),
   or people. **Keep other people out of frame**, especially near a red marker
   (a red light reflecting off a face becomes a big red blob).

---

## Part 3 — Calibration (under a minute)

Click **🎥 Ride with camera** and follow the big buttons:

1. **Tap the first grip marker, then the second**, in the live picture. A
   colored ring snaps onto each when it's locked — that's your confirmation.
2. **Tap the frame marker** (or press **⏭️ Skip** to run without lean
   cancellation).
3. **Hold the bars straight, bike upright** → Ready. (Records the "straight and
   level" reference.)
4. **Turn all the way LEFT** → Ready.
5. **Turn all the way RIGHT** → Ready. Done!

> **Direction is automatic.** Because steps 4 and 5 are labeled, the game learns
> which way is left/right from *your* setup — you don't need to match colors to
> sides, and there's no "flip direction" step. Whichever way the bars physically
> move at "turn left" becomes game-left.

> **Turn the bars *fully* at steps 4 and 5.** The wider the range you record, the
> smoother and less twitchy the steering.

Calibration is saved in your browser. Next time, press **🎥 Ride! (last
calibration)** to skip straight in. Recalibrate anytime from the pause menu
(**P**) — do this if you move the camera or the lighting changes a lot.

---

## Best-practices checklist

Print-and-stick version of everything above:

- ✅ **Three distinct, saturated colors** — not on your bike, not in the room.
- ✅ **Bright LEDs pointed at the camera** (diffuse any that blow out to white),
  or matte neon tape in good light.
- ✅ **Camera raised and tilted DOWN** onto the bars — the #1 fix for weak
  steering.
- ✅ **Plain background** behind the bars; **no people** in frame.
- ✅ **Bike stationary**; child steers the bars, doesn't wrestle the frame.
- ✅ Add the **frame marker** (a colored one) if leaning the bike is reading as a
  turn.
- ✅ **Turn the bars fully** during the left/right calibration steps.
- ✅ **Recalibrate** after moving the camera or big lighting changes.
- 🔎 Press **`** (backtick) for the debug overlay and watch the **angle
  sparkline** while turning the bars — a big swing means a strong signal; a tiny
  wiggle means raise/tilt the camera more.

---

## Playing

- **Steer** by turning the handlebars — dodge hay bales, puddles, cones, and
  parked scooters; collect ⭐ star trails; hit orange **ramps** for airtime.
- **Nothing ends the run.** Hits just slow you down (and look funny).
- Every ~90 seconds you reach a **FINISH gate**: confetti, score, and "Ride
  again?" (auto-restarts after 5 s).
- The **camera preview** (bottom-left) shows what tracking sees — colored rings
  on each marker and a needle mirroring your steering. It's the trust signal that
  tracking is alive. Click it to hide.
- **Cover the camera** and the bike gently coasts to center with a toast;
  uncover and it recovers on its own.

### Controls (always available, even with the camera on)

| Key | Action |
|---|---|
| ← / → | steer |
| Space | side-hop |
| R | restart run |
| P / Esc | pause / calibrate |
| M | mute |
| `` ` `` (backtick) | debug overlay: fps, worker ms, camera→game latency, angle sparkline, One Euro sliders, god mode |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| **Steering feels weak / mushy** | Raise the camera and **tilt it down** onto the bars; recalibrate turning the bars *fully*. Check the debug (`` ` ``) sparkline swings widely. |
| **Steering is reversed** | Recalibrate — direction is now auto from the "turn left/right" steps, so a fresh calibration fixes it. |
| **A marker jumps to the wrong object (hand, poster, furniture)** | That object shares the marker's color. Use a more saturated marker, remove the object / people from frame, plainer background, or change that marker's color. |
| **Leaning/wobbling the bike steers it** | Add a **colored frame marker** (not white) on the stem/top tube and recalibrate — enables lean cancellation. |
| **"Tracking lost" keeps appearing** | Marker out of frame or too dim — brighter LED / more light, move the camera closer, re-run calibration. |
| **Ring only on one marker** | The other is out of frame, too dim, or the same color as something nearby. Fix contrast and recalibrate. |
| **Marker reads white / washed-out (LED)** | LED core is blown out — diffuse it (frosted tape / translucent cap) or angle it off-axis so its color shows. |
| **Jittery at rest** | Debug overlay (`` ` ``) → lower One Euro `minCutoff` a touch. |
| **Sluggish in fast turns** | Debug overlay → raise One Euro `beta` a touch. |
| **Choppy on an older laptop** | The game auto-drops tracking to 20 Hz and shrinks shadows under load; close other tabs. |
| **Camera permission denied** | Reload and allow the camera, or play **⌨️ Keyboard only**. |

### Dev / testing tools (no camera needed)

```
http://localhost:5173/?fake=sine            # sine-wave auto-steering
http://localhost:5173/?fake=sine&delay=120  # + simulated 120 ms camera latency
http://localhost:5173/?fake=slider          # on-screen steering slider
http://localhost:5173/?autostart=kb         # skip title → keyboard mode
http://localhost:5173/?autostart=kb&warp=1500   # start 1500 m in (later themes)
http://localhost:5173/?autostart=kb&sim=45      # fast-forward 45 s of play
```

---

## How it works (for the curious)

**Stack:** TypeScript (strict) · Vite · Three.js · Rapier physics
(`@dimforge/rapier3d-compat`, WASM lazy-loaded behind the title screen).

**Tracking:** plain color-blob detection over a downsampled **320×240** webcam
frame, run in a **Web Worker** (an `OffscreenCanvas`) so computer-vision work
never steals from the 60 fps render loop. For each color it takes the **largest
connected blob** (so scattered background pixels of the same color are ignored),
then One Euro–filters the steering angle and posts a compact `SteerState` at
~30 Hz. Calibration adapts each color window to the marker's saturation and
brightness, so a bright LED locks onto its saturated core and rejects dimmer
look-alikes. Safari falls back to a main-thread canvas when `OffscreenCanvas`
isn't available.

**Game:** fixed 60 Hz Rapier step with interpolated rendering; a kinematic rider
controller; procedurally streamed road/world; no-fail collisions; finish gates.

Key source:

```
src/
  main.ts                 boot: camera → calibration → game
  shared/types.ts         shared types + all tuning constants
  tracking/
    tracker.ts            webcam capture + worker plumbing (+ Safari fallback)
    worker.ts             runs the detector off the main thread
    detect.ts             color-blob + largest-connected-component + patch sampling
    pipeline.ts           blob positions → steering angle (auto-direction mapping)
    oneEuro.ts            One Euro smoothing filter
    calibration.ts        calibration profile persistence
  game/                   game loop, rider, world, obstacles, collectibles, audio, assets
  ui/                     hud, calibration wizard, camera PiP, debug overlay
```

### 3D art assets

The player, bike, trees, houses, obstacles, and props are **HD GLB models** in
`public/models/`, loaded at runtime by `src/game/assets.ts` (Meshopt-compressed,
~0.3–0.7 MB each). **Every model is optional** — if a `.glb` is missing, the game
falls back to a built-in procedural mesh, so it always runs.

To regenerate or swap an asset, drop a replacement `.glb` under `public/models/`
using the same filename. The models were generated from images and compressed
for the web:

```bash
node scripts/fetch-asset.mjs <glb-url> /tmp/raw/pine.glb          # download
node scripts/optimize-glb.mjs /tmp/raw/pine.glb public/models/pine.glb 1024
```

`optimize-glb.mjs` wraps `gltf-transform optimize` (WebP textures + Meshopt),
turning raw ~10 MB exports into web-ready GLBs.

---

## License

Personal / educational project. Use it, remix it, ride it.
