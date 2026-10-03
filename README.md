# Víbora Padel

A first-person padel **training simulator** for a Mac plugged into a TV. A webcam watches you; you see
the court through your own eyes, VR style: your forearms, hands and racket are in front of you and
follow your real arms. Step sideways or toward/away from the TV to move on court (amplified). The ball
is a real physics simulation: drag and Magnus lift, spin, grip–slip bounces on turf, lively glass,
dead wire mesh, net cord trickles and *por tres* exits.

It runs in the browser (Chrome or Safari on an Apple-silicon MacBook). No install, no account, no
upload: pose tracking runs on the Mac with MediaPipe and nothing leaves the device (MediaPipe's
built-in usage logging to Google is blocked locally by `src/app/privacy.js`).

- **13 drills** with a ball machine (drives, walls, volleys, bandeja, víbora, smash, lob, chiquita,
  serve, return, live mix), scored with real padel rules
- **Rally with Coach** (an AI coach that plays drives, lobs, chiquitas and balls off the glass)
- **2 v 2 Match** with an AI partner, real serves, golden point and tie-break
- Per-shot feedback: stroke, km/h, rpm (topspin / slice), net clearance, sweet spot, timing and spacing
- **Instant replay** (R) in slow motion from the broadcast camera, with your tracked racket path
- Voice coach (English / Spanish), spatial sound, hand-cursor menus usable from 3 m away

---

## 1. What you need

| | |
|---|---|
| Computer | MacBook with Apple silicon (M1 or newer). Intel Macs work at lower quality. |
| Browser | Google Chrome (recommended) or Safari 17+ |
| Display | Any TV. HDMI cable; a **MacBook Air needs a USB‑C (Thunderbolt) to HDMI adapter**. MacBook Pro 14/16" has an HDMI port. |
| Camera | One of: **iPhone via Continuity Camera** (best), a USB webcam, or the MacBook's own camera (lid open, facing you) |
| Space | About 3 × 3 m clear floor in front of the TV |

## 2. Set up the Mac, TV and camera

1. **Connect the TV** with HDMI. In *System Settings → Displays* either mirror the displays or use the
   TV as an extended display and drag the browser window onto it. Make the browser full screen
   (⌃⌘F, or *View → Enter Full Screen*).
2. **Turn on the TV's Game Mode** (often under *Picture → Picture Mode* or *Input settings*). It cuts
   the TV's processing delay from ~100 ms to ~20 ms, which you will feel when you swing. Run the
   latency test (calibration step 4) after changing it.
3. **Place the camera on top of or just under the TV, at about chest height**, pointing straight at
   you, and stand **2.5–3 m** away. The camera must see you from head to ankles; the calibration
   screen tells you when it does.
4. **iPhone (Continuity Camera)** — macOS 13+, iOS 16+, same Apple ID, Wi‑Fi and Bluetooth on. Mount
   the iPhone in landscape on the TV with the **rear camera facing you**, screen locked. It appears in
   the camera list as "iPhone Camera". Open *Control Centre → Video Effects* and turn **Center Stage
   off** so the framing stays fixed (Center Stage zooms and pans, which the tracker reads as movement).
   Do not pick "Desk View".
5. **MacBook camera** — the lid must be open and the Mac placed near the TV facing you; the camera then
   sits low, so step back until your ankles are in frame.
6. Good, even light on you; avoid a bright window behind you. Wear clothes that contrast with the wall.

## 3. Start playing

- **Online:** open `https://<your-user>.github.io/vibora-padel/` in Chrome. (Camera access needs
  `https://` or `localhost`.)
- **Locally:** `npm start`, then open <http://localhost:5173>. (Node 18+; there are no dependencies.)

Press **Enter** (or click) on the title screen. The first click / key press also unlocks sound.
Allow camera access when the browser asks.

### Calibration (2 minutes, saved for next time)

1. **Full body** — move until head, shoulders, hips, knees and ankles are ticked and the distance meter
   is in the green (2.2–3.5 m).
2. **Your spot** — stand still in a ready position for 2 s. This becomes your home position on court.
3. **Profile** — racket hand and height (sets eye height, reach and your forehand side).
4. **Latency test** (optional, recommended) — swing your racket hand **down** on each of 6 flashes.
   The measured delay is used to rewind time when judging your hits.
5. **Play area** — take one step left, right, forward and back and watch the live readout.

### Controls

| Action | How |
|---|---|
| Hit | Swing your real arm. Your hand is the racket grip; the face follows your palm (palm side = forehand face). |
| Move on court | Step sideways (×2.6) and toward / away from the TV (×2.2). Toward the TV = toward the net. A living room only allows about ±0.6 m of steps, so the game moves your court spot for the big moves (a short ball at your feet, a lob over your head; in rally and match it follows padel tactics and keeps you at the net after a volley, lob or serve) and your own steps do the rest. If the camera loses your head, hips or feet, the HUD tells you to step back. |
| Menus | Raise a hand: a cursor appears; hover 1 s to click. Or arrows + Enter, or the mouse. On the title screen the hand works as soon as the camera is on (straight away if the browser already allows the camera). |
| Start a drill | "Start drill", or raise your racket hand above your head for a moment |
| Pause | Both hands above your head for 1.5 s, or Esc / P |
| Instant replay | R (or *Pause → Instant replay*, or *Watch replay* on the results). V changes the view. |
| Camera picture-in-picture / skeleton | C / K during play |
| No camera? | "Play with mouse": the mouse moves the racket; flick the mouse (or press Space) as the ball comes and a timed swing plays it; WASD moves (otherwise Rookie/Club walk you to the ball) |

### How strokes are read

| Stroke | Read when |
|---|---|
| Forehand / backhand | Groundstroke after the bounce, by the face you hit with (palm face = forehand) |
| Volley (fh / bh) | Contact before the bounce |
| Glass forehand / backhand | Contact after the ball came off the glass (*salida de pared*) |
| Bandeja | Overhead contact (above ~1.7 m for a 1.75 m player), controlled |
| Víbora | Overhead with a strong sideways cut and the face open |
| Smash | Overhead with racket speed > 17 m/s, steeply downward |
| Lob | Racket path rising more than 35° |
| Chiquita | Soft (< 8 m/s), low contact, ball dropped at the opponents' feet |
| Serve | Ball dropped, bounced, struck at or below the waist |

Ideal contact for groundstrokes: 0.25–0.75 m in front of your hips, 0.5–0.9 m to the side, 0.6–1.3 m
high. The shot card tells you if you were *early / late* and *cramped / stretched*.

## 4. Drills

| Drill | Skill | What you practise |
|---|---|---|
| Forehand Drive · *Derecha* | Groundstrokes | Deep cross-court drives; bonus for a flat, low net clearance |
| Backhand Drive · *Revés* | Groundstrokes | The same on the backhand side |
| Off the Back Glass · *Salida de pared* | Walls | Let a deep ball rebound off the back glass, then drive it deep |
| Corner Exit · *Doble pared* | Walls | Back glass, then side glass, in the forehand corner |
| Net Volleys · *Voleas* | Net | Chest-high feeds alternating sides; punch them deep |
| Bandeja | Overheads | Defensive lobs; controlled overhead deep (pace above 85 km/h is penalised) |
| Víbora | Overheads | Cut overhead into the far side-glass corner |
| Smash Por Tres · *Remate por tres* | Overheads | Short lobs; smash so the ball bounces and exits over the back wall |
| Defensive Lob · *Globo* | Tactics | Opponents at the net: lob over them, deep, apex > 4.5 m |
| Chiquita | Tactics | Opponents at the net: soft, low ball at their feet |
| Serve · *Saque* | Serve | Drop, bounce, serve below the waist into the diagonal box |
| Return of Serve · *Resto* | Serve | The machine serves; return cross-court deep or lob |
| Live Ball Mix · *Bola viva* | Tactics | Random feeds from all of the above |

Every rep is judged by the referee with real padel rules (own glass is legal before the ball crosses;
the ball must bounce on the far side before touching a wall; touching your own wire mesh loses the
point; exits after the bounce are *por tres* / *por cuatro*). The machine never fires while your ball is
still in play: the next feed comes about a second after the ruling (the drill's interval is the
minimum). Stars and personal bests are saved in the browser.

## 5. Settings

- **Assist** (Settings → Play):
  - **Pro** — real physics only: the hit must meet the 2 cm face margin, no aim help, no movement help.
  - **Club** (default) — 10 cm face margin, outgoing direction blended 35 % toward the shot you were
    going for, half net-safety lift, and a gentle "magnet" that nudges you toward the ideal contact spot.
  - **Rookie** — 20 cm margin, 65 % blend, 90 % net safety, strong magnet.
- **Movement gains** (sideways / forward), **field of view**, **gaze follows the ball**, **latency**.
  The default view is tuned for a TV: a 74° vertical field of view, the head pitched 14° down and the
  viewpoint 12 cm behind / 6 cm below your tracked eyes, so in a ready position the hand holding the
  racket and your other hand sit at the bottom of the picture (like a VR headset's wider view) while the
  far glass stays in frame. Your real body faces the TV, so the view only turns a little: it follows the
  ball by up to ±30° around your strokes, turns up to 80° to watch a ball go to the back glass, comes
  back as soon as the ball rebounds and never turns faster than 150°/s (an arrow points at a ball
  outside the picture). An arm passing right in front of your eyes is hidden for those frames, and the
  racket fades when it comes within ~35 cm of your eyes without the ball nearby.
- **Latency**: hits are rewound by the latency you set plus the measured camera pipeline delay, and
  the referee waits for that window before ruling. When a hit is detected the ball's path is
  rewritten; on screen it blends onto the new path in ~0.14 s instead of jumping, and the instant
  replay shows the corrected path. `?debug=1` lists contacts that came in too late.
- **Landing marker** (predicted first bounce, Rookie/Club), **ideal contact ghost**, **ball halo**.
- Handedness, height, skin tone, racket colour, graphics quality (Ultra / High / Balanced), voice coach
  (English / Español / off) and volumes. Everything is saved in this browser.

## 6. Physics notes

All constants live in `src/config.js` (plus two documented local values in `src/physics/court.js`).

| Quantity | Value | Source / check |
|---|---|---|
| Court | 20 × 10 m, net 0.88 m centre / 0.92 m posts, service line 6.95 m, back glass 3 m + mesh to 4 m, stepped side walls (glass 3 m at 8–10 m, 2 m at 6–8 m) | FIP Rules of Padel |
| Ball | Ø 6.5 cm (r = 3.25 cm), 57 g, I = 0.55 m r² | FIP ball rules (6.35–6.77 cm, 56–59.4 g) |
| Drag | F = −½ ρ C<sub>d</sub> A \|v\| v, C<sub>d</sub> = 0.55, ρ = 1.2 kg/m³ | wind-tunnel data for felt balls (Mehta & Pallis 2001; Goodwill, Chin & Haake 2004). Check: 30 m/s → 25 m/s after 10 m |
| Magnus lift | F = ½ ρ C<sub>L</sub> A \|v\|² · (ω × v)/\|ω × v\|, C<sub>L</sub> = min(0.35, 1/(2 + v/(r ω⊥))) | Štěpánek (1988) lift fit for felt balls; topspin dips, slice floats |
| Spin decay | τ = 6 s | — |
| Integration | 960 Hz RK2 substeps, 240 Hz world ticks, swept collisions (no tunnelling at 60 m/s) | — |
| Bounces | Brody / Cross grip–slip model: normal impulse with speed-dependent restitution e = e₀ − k\|v<sub>n</sub>\|, tangential impulse rolls the ball (grip) or slides it with Coulomb friction (slip) | Brody (1984) "That's how the ball bounces"; Cross (2002) "Grip-slip behavior of a bouncing ball" |
| Turf | e₀ = 0.815, μ = 0.55 | FIP drop test: 2.54 m drop must rebound 1.35–1.45 m → simulated 1.398 m (with drag) |
| Glass | e₀ = 0.78, μ = 0.22 | 10 m/s normal impact rebounds at 0.70 × — backspin comes off lower and dies close to the glass, topspin floats out |
| Wire mesh | e₀ = 0.42 with ±14° normal jitter and up to 18 % random loss | dead, unpredictable rebounds |
| Net | body absorbs 85 % (ball drops on the hitter's side); top band is a 2.5 cm cylinder → cord trickles | — |
| Racket | apparent COR 0.42 at the sweet spot, falling off toward the frame (min 0.18), face friction μ 0.45, off-centre twist | apparent-COR model (Brody, Cross & Lindsey, *The Physics and Technology of Tennis*, 2002). Check: 15 m/s ball × 15 m/s racket → 99 km/h |

Hits are **lag compensated**: each racket movement seen by the camera is swept against the ball as it
was `latency` seconds earlier (the ball history is rewound, the impact applied, and the flight
re-simulated to the present). Referee decisions wait for the same window so a late-detected hit never
contradicts a call.

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| "macOS is blocking the camera" | *System Settings → Privacy & Security → Camera* → enable Chrome/Safari, then quit the browser (⌘Q) and reopen. |
| "Camera permission was denied" | Click the camera icon in the address bar → Allow, reload. |
| iPhone not in the camera list | Same Apple ID on both, Wi‑Fi + Bluetooth on, iPhone locked, landscape and still, near the Mac. Press "Try again". |
| "Camera is busy" | Quit FaceTime, Zoom, Teams, Photo Booth or other tabs using the camera. |
| Hits feel late or early | Turn on the TV's Game Mode, then redo the latency test (Settings → Recalibrate). |
| You move when standing still | Turn off Center Stage; make sure your whole body is in frame; recalibrate your spot. |
| Racket jitters | More light on you; contrasting clothes; keep the camera still. |
| Low frame rate | Settings → Graphics quality → Balanced. Close other tabs. Use Chrome. |
| No sound / voice | Click or press a key once (browsers only start audio after a user gesture). Check the volume sliders. |
| Nothing works without a camera | Use "Play with mouse" on the title screen, or open `?fallback=1`. |

## 8. Developer notes

```
npm start          # static server on http://localhost:5173
npm test           # 297 unit / end-to-end tests (node --test), deterministic
npm run smoke      # headless Chromium (SwiftShader) smoke test + screenshots in tools/out/smoke-*.png
```

The smoke test runs the real app six ways: `?autopilot=1&drill=fh-drive&speed=3` for 60 s of sim time
(no console errors or failed requests, ≥ 8 player hits, ≥ 50 % in court, instant replay, results), the
same drill with a realistic Mac pipeline (`&aplatency=0.11&apdelivery=0.15`: same hit rate, no contact
rejected as late),
`?fallback=1` with Space auto-swings, the camera path with Chromium's fake camera and a synthetic person
driving the calibration (and no external network requests), a browser with no camera at all (readable
error + mouse option) and the site served from a `/vibora-padel/` sub-path like GitHub Pages.
Software WebGL renders the full scene at only ~1–2 fps, so the smoke test freezes the simulation at
chosen moments (`__vibora.freezeOn('contact' | 'hit')`) to take its screenshots.

URL flags: `?autopilot=1` (a virtual player drives the real tracking pipeline through a synthetic
camera; also the title-screen demo), `?drill=<id>`, `?mode=rally|match&level=rookie|club|pro`,
`?fallback=1`, `?debug=1` (fps, draw calls, pose inference ms, latency), `?quality=ultra|high|balanced`,
`?speed=N` (sim seconds per real second, for headless tests), `?fov=` / `?pitch=` / `?eyeback=` /
`?eyedown=` (view tuning), `?aplatency=` / `?apdelivery=` (the autopilot's display latency and
capture-to-result delay, to test a realistic Mac pipeline), `?attract=0`, `?mute=1`.

Code map: `src/physics` (ball, court, racket impact, prediction), `src/rules` (referee, scoring),
`src/tracking` (camera, MediaPipe, body model, locomotion, racket track, strokes, synthetic camera,
autopilot), `src/game` (world, human controller, machine, coach, drills, modes, session),
`src/render` (three.js scene, hall, rackets, hands, humanoids, effects), `src/audio`, `src/ui`, and
`src/main.js` + `src/app/*` (boot, loop, flow, wiring, replay). The contract between modules is
`docs/SPEC.md`. Every runtime path is relative, so the site works from any sub-path (GitHub Pages).

**Deploy:** push to `main`; `.github/workflows/pages.yml` publishes the repository root. In the
repository settings choose *Pages → Source: GitHub Actions*.

## 9. Credits and licences

Víbora Padel is MIT licensed (`LICENSE`). It bundles three.js (MIT), MediaPipe Tasks Vision and the
pose landmarker models (Apache-2.0), the WebXR Input Profiles generic hand models (MIT, © Amazon) and
the Big Shoulders Display and Barlow Semi Condensed fonts (SIL OFL 1.1). Details and licence files:
`THIRD_PARTY_NOTICES.md`. Everything else — the club, court, glass, rackets, ball, players, textures
and all sounds — is generated procedurally. "VÍBORA" is a made-up club; no real brand is shown.
