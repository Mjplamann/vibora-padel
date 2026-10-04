# Víbora Padel

A first-person padel **training simulator** for a Mac plugged into a TV. A webcam watches you; you see
the court through your own eyes, VR style: your forearms, hands and racket are in front of you and
follow your real arms. Step sideways or toward/away from the TV to move on court (amplified). The ball
is a real physics simulation: drag and Magnus lift, spin, grip–slip bounces on turf, lively glass,
dead wire mesh, net cord trickles and *por tres* exits.

It runs on an Apple-silicon MacBook in Chrome or Safari, and installs as a Mac app with its own Dock
icon that works offline. No account, no upload: pose tracking runs on the Mac with MediaPipe and nothing
leaves the device (MediaPipe's built-in usage logging to Google is blocked locally by
`src/app/privacy.js`, and the offline cache only ever stores the app's own files).

- **13 drills** with a ball machine (drives, walls, volleys, bandeja, víbora, smash, lob, chiquita,
  serve, return, live mix), scored with real padel rules
- **Rally with Coach** (an AI coach that plays drives, lobs, chiquitas and balls off the glass)
- **2 v 2 Match** with an AI partner, real serves, golden point and tie-break
- Per-shot feedback: stroke, km/h, rpm (topspin / slice), net clearance, sweet spot, timing and spacing
- **Instant replay** (R) in slow motion from the broadcast camera, with your tracked racket path
- Voice coach (English / Spanish), spatial sound, hand-cursor menus usable from 3 m away

---

## Play

### **[mjplamann.github.io/vibora-padel](https://mjplamann.github.io/vibora-padel/)**

Open the link in **Google Chrome** (recommended) or **Safari** on your Mac, then install it so it opens
like any other app:

| Browser | Install as an app |
|---|---|
| **Chrome** | Click the **install icon** at the right end of the address bar (a screen with a down arrow), or **⋮ → Cast, save and share → Install page as app**, or the **Install Víbora** button on the title screen. |
| **Safari** (macOS Sonoma 14 or later) | **File → Add to Dock**. |

From then on open **Víbora** from the Dock, Launchpad or Spotlight (⌘ Space, "Víbora"). It runs in its
own window without browser bars; press **F** (or ⌃⌘F) for full screen. While it is full screen, a short
**Esc** still pauses / goes back in the game; hold **Esc** to leave full screen.

- **Works offline.** The first launch (online) saves everything the app needs, about 25 MB: the 3D
  engine, the pose-tracking runtime and model, hands, fonts. After that it starts and plays with no
  internet connection, camera tracking included. Optional extras (the *lite* / *heavy* pose models) are
  saved the first time you use them.
- **Updates** arrive by themselves. When a new version is published, a small **Update ready — Restart**
  notice appears in the menus (never during play); click Restart, or just keep playing and the new
  version loads the next time you open the app.
- The first time, allow camera access. Your settings, calibration and personal bests are kept on this
  Mac.
- No camera to hand? Choose **Play with mouse** on the title screen.

## Connect your Mac to the TV

1. **Cable.**
   - **MacBook Air** (M1–M4) has no HDMI port: use a **USB‑C to HDMI adapter or cable that supports
     4K at 60 Hz** (HDMI 2.0), for example Apple's **USB‑C Digital AV Multiport Adapter** with a
     High Speed HDMI cable, or a single USB‑C→HDMI 4K60 cable. Plug it into either USB‑C /
     Thunderbolt port.
   - **MacBook Pro** 14" / 16" (M1 Pro and later, including M4) has **HDMI built in**: a plain HDMI
     cable (Premium High Speed for 4K60) from the Mac's HDMI port to the TV.
2. **TV input.** Turn the TV on and pick that HDMI input with the remote (*Source* / *Input*).
3. **Displays.** On the Mac open **System Settings → Displays**:
   - simplest: select the TV and set **Use as → Mirror for Built-in Display**, or
   - better picture: **Use as → Main display** for the TV (the Mac's screen becomes the second display),
     then open Víbora on the TV.
   Keep *Resolution: Default for display* and *Refresh rate: 60 Hz*.
4. **Sound.** **System Settings → Sound → Output** → the TV (or Control Centre → Sound → the TV), so the
   ball, the glass and the voice coach come out of the TV speakers in sync with the picture.
5. **TV Game Mode.** Turn on the TV's **Game Mode** (often *Picture → Picture Mode → Game*, *Input
   settings* or "ALLM"; some TVs call it *PC mode*). It cuts the TV's processing delay from ~100 ms to
   ~20 ms, which you will feel when you swing. Run the latency test (calibration step 4) after changing
   it.
6. **Power.** Keep the Mac on its **charger**, and in **System Settings → Lock Screen** set *Turn display
   off on power adapter when inactive* to **Never** (or 30 minutes) so it doesn't sleep between drills.
   Closing the lid turns the built-in camera off; then use an iPhone or USB camera.

### Place the camera

The camera must see you from **head to ankles**. Put it **just under, on top of or in front of the TV, at
about chest height**, pointing straight at you, and stand **2.5–3 m** back with about 3 × 3 m of clear
floor. The calibration screen tells you when the framing and distance are right.

- **MacBook built-in camera:** lid open, the Mac **under or in front of the TV at chest height** (on a
  stool, shelf or TV stand) with its screen facing you. It sits lower than the TV, so step back until
  your ankles are in frame.
- **iPhone (Continuity Camera, best):** macOS 13+ / iOS 16+, same Apple ID, Wi‑Fi and Bluetooth on.
  **Mount the iPhone on the TV** (a MagSafe or clip mount) in landscape with the **rear camera facing
  you**, screen locked. It shows up as "iPhone Camera". In **Control Centre → Video Effects** turn
  **Center Stage off** (it zooms and pans, which the tracker reads as movement) and don't pick "Desk
  View".
- **USB webcam:** on top of the TV, centred.
- Even light on you; avoid a bright window behind you. Clothes that contrast with the wall help.

## 1. What you need

| | |
|---|---|
| Computer | MacBook with Apple silicon (M1 or newer). Intel Macs work at lower quality. |
| Browser | Google Chrome (recommended) or Safari 17+ (macOS Sonoma for *Add to Dock*) |
| Display | Any TV, connected as above (MacBook Air: USB‑C → HDMI 4K60 adapter; MacBook Pro: HDMI port) |
| Camera | One of: **iPhone via Continuity Camera** (best), a USB webcam, or the MacBook's own camera (lid open, facing you) |
| Space | About 3 × 3 m clear floor in front of the TV |

## 2. Start playing

- **The app:** open Víbora from the Dock (see [Play](#play)), or the link in Chrome / Safari.
- **Locally:** `npm start`, then open <http://localhost:5173>. (Node 18+; there are no dependencies.
  Camera access needs `https://` or `localhost`.)

Press **Enter** (or click) on the title screen. The first click / key press also unlocks sound.
Allow camera access when the browser asks.

### Calibration (2 minutes, saved for next time)

1. **Full body** — move until head, shoulders, hips, knees and ankles are ticked and the distance meter
   is in the green (2.2–3.5 m).
2. **Your spot** — stand still in a ready position for 2 s. This becomes your home position on court.
3. **Profile** — racket hand and height (sets eye height, reach and your forehand side).
4. **Latency test** (optional, recommended; marked *recommended* in Safari, which doesn't report when
   the camera captured each frame) — swing your racket hand **down** on each of 6 flashes. The measured
   delay is used to rewind time when judging your hits.
5. **Play area** — take one step left, right, forward and back and watch the live readout.

### Controls

| Action | How |
|---|---|
| Hit | Swing your real arm. Your hand is the racket grip; the face follows your palm (palm side = forehand face). |
| Move on court | Step sideways (×2.6) and toward / away from the TV (×2.2). Toward the TV = toward the net. A living room only allows about ±0.6 m of steps, so the game moves your court spot for the big moves (a short ball at your feet, a lob over your head; in rally and match it follows padel tactics and keeps you at the net after a volley, lob or serve) and your own steps do the rest. If the camera loses your head, hips or feet, the HUD tells you to step back. |
| Menus | Raise a hand: a cursor appears; hover 1 s to click. Or arrows + Enter, or the mouse. On the title screen the hand works as soon as the camera is on (straight away if the browser already allows the camera). |
| Start a drill | "Start drill", or raise your racket hand above your head for a moment |
| Pause | Both hands above your head for 2 s (not while a ball is live), or Esc / P |
| Instant replay | R (or *Pause → Instant replay*, or *Watch replay* on the results). V changes the view. |
| Camera picture-in-picture / skeleton | C / K during play |
| Full screen | F (or ⌃⌘F). In full screen a short Esc still pauses; hold Esc to leave full screen. Leaving full screen during play pauses the game. |
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
| Lob | Read from the ball that left the racket: apex above 4 m, or climbing more than 25° at 70 km/h or less (a fast flat ball is a drive whatever the swing; the racket path rising more than 35° only decides borderline cases) |
| Chiquita | Soft (< 8 m/s), low contact, ball dropped at the opponents' feet |
| Serve | Ball dropped, bounced, struck at or below the waist |

Ideal contact for groundstrokes: 0.25–0.75 m in front of your hips, 0.5–0.9 m to the side, 0.6–1.3 m
high. The shot card tells you if you were *early / late* and *cramped / stretched*.

## 3. Drills

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

## 4. Settings

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
  outside the picture). In the last 0.8 s before a contact the view frames the contact point in the
  lower middle of the picture (overheads: it never looks more than 25° up). Forearms fade out where
  they would fill the picture (close to your eyes), the upper arm is only a short stub above the
  elbow, and the racket fades when it comes within ~35 cm of your eyes without the ball nearby. The
  racket is never drawn through the glass, and the game keeps you about 0.6 m off the back glass: a
  ball off the glass is played once it has come 1.2–2.8 m out of it (*salida de pared*).
- **Latency / predictive hitting** (on by default; Settings → Play → *Predictive hitting*): the camera
  sees your swing about 0.25 s late on a Mac and TV, so the racket you see completes your swing and
  meets the ball on screen; the pock, effects and ball leave the strings at that moment. The camera
  confirms the hit about 0.3 s later (the ball eases onto the exact lag-compensated path) or undoes it
  if you stopped short. Sounds and glass marks of a path that a late hit erases are held back and
  dropped. Scoring and the shot card use the confirmed hit only. Hits are rewound by the latency you
  set plus the measured camera pipeline delay, and the referee waits for that window before ruling.
  `?debug=1` lists contacts that came in too late.
- **Camera timing**: Chrome reports when each camera frame was captured; Safari doesn't, so the app
  subtracts a typical capture delay for your camera preset (MacBook 50 ms, iPhone 120 ms, USB 70 ms)
  and the calibration recommends the latency test.
- **Off-axis arm correction** (experimental, off): when you stand well to one side of the camera,
  rotates the tracked arms back toward the camera's axis. Leave it off unless your racket face looks
  turned when you step sideways.
- **Landing marker** (predicted first bounce, Rookie/Club), **ideal contact ghost**, **ball halo**.
- Handedness, height, skin tone, racket colour, graphics quality (Ultra / High / Balanced), voice coach
  (English / Español / off) and volumes. Everything is saved in this browser.

## 5. Physics notes

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
| Turf "crater" | a fast, oblique ball dents the sand-filled turf: the contact normal tilts back toward the incoming ball by 0.01·\|v<sub>n</sub>\|·\|v<sub>t</sub>\| degrees (≤ 15°); e still uses the true normal speed | compliant-surface model of Penner (2002) "The run of a golf ball". Check: a 140 km/h flat smash bouncing ~3 m past the net rebounds at ~41° and clears the 4 m back wall (*por tres*); 100 km/h smashes and drives stay in |
| Glass | e₀ = 0.78, μ = 0.22 | 10 m/s normal impact rebounds at 0.70 × — backspin comes off lower and dies close to the glass, topspin floats out |
| Wire mesh | e₀ = 0.42 with ±14° normal jitter and up to 18 % random loss | dead, unpredictable rebounds |
| Net | body absorbs 85 % (ball drops on the hitter's side); top band is a 2.5 cm cylinder → cord trickles | — |
| Racket | apparent COR 0.42 at the sweet spot, falling off toward the frame (min 0.18), face friction μ 0.45, off-centre twist | apparent-COR model (Brody, Cross & Lindsey, *The Physics and Technology of Tennis*, 2002). Check: 15 m/s ball × 15 m/s racket → 99 km/h |

Hits are **lag compensated**: each racket movement seen by the camera is swept against the ball as it
was `latency` seconds earlier (the ball history is rewound, the impact applied, and the flight
re-simulated to the present). Referee decisions wait for the same window so a late-detected hit never
contradicts a call. On top of that, **predictive hitting** (`src/game/swingPredict.js`) completes the
swing you have started so the racket you see meets the ball you see: the strike is shown at once with
the same impact physics, then confirmed (or undone) by the lag-compensated detector.

## 6. Troubleshooting

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
| No install icon in Chrome | It appears once the page has loaded fully over `https://` (not in a Guest or Incognito window). Use *⋮ → Cast, save and share → Install page as app*. If Víbora is already installed, Chrome offers *Open in Víbora* instead. |
| No *Add to Dock* in Safari | It needs macOS Sonoma 14 or later. |
| The TV shows nothing / wrong size | Check the TV input; in *System Settings → Displays* pick the TV and *Default for display*; try another USB‑C port or a 4K60-rated adapter. |
| The app looks out of date | Click *Restart* on the *Update ready* notice, or quit the app (⌘Q) and open it again. |
| Remove the app | Chrome: in the app window *⋮ → Uninstall Víbora*. Safari: drag Víbora out of the Dock and delete it from *~/Applications*. |

## 7. Developer notes

```
npm start          # static server on http://localhost:5173
npm test           # unit / end-to-end tests (node --test), deterministic
npm run smoke      # headless Chromium (SwiftShader) smoke test + screenshots in tools/out/smoke-*.png
node tools/precache.mjs [--write]   # check / regenerate the service worker's precache list in sw.js
node tools/icons.mjs                # regenerate icons/*.svg and every PNG size (headless Chromium)
```

The smoke test runs the real app six ways: `?autopilot=1&drill=fh-drive&speed=3` for 60 s of sim time
(no console errors or failed requests, ≥ 8 player hits, ≥ 50 % in court, instant replay, results), the
same drill with a realistic Mac pipeline (`&aplatency=0.11&apdelivery=0.15`: same hit rate, no contact
rejected as late),
`?fallback=1` with Space auto-swings (≥ 80 % in court), the camera path with Chromium's fake camera and a synthetic person
driving the calibration (and no external network requests), a browser with no camera at all (readable
error + mouse option), the site served from a `/vibora-padel/` sub-path like GitHub Pages, and the
installable app from that sub-path in a real Chrome profile: the manifest parses and Chrome reports no
installability errors (DevTools Protocol `Page.getAppManifest` / `Page.getInstallabilityErrors`), the
service worker precaches the app, then **offline** a relaunch boots with zero errors and a drill runs
and the camera path loads the pose model, and finally a new service-worker version shows *Update ready*
and *Restart* activates it (`--only=pwa` runs just that part).
Software WebGL renders the full scene at only ~1–2 fps, so the smoke test freezes the simulation at
chosen moments (`__vibora.freezeOn('contact' | 'hit')`) to take its screenshots.

URL flags: `?autopilot=1` (a virtual player drives the real tracking pipeline through a synthetic
camera; also the title-screen demo), `?drill=<id>`, `?mode=rally|match&level=rookie|club|pro`,
`?fallback=1`, `?debug=1` (fps, draw calls, pose inference ms, latency), `?quality=ultra|high|balanced`,
`?speed=N` (sim seconds per real second, for headless tests), `?fov=` / `?pitch=` / `?eyeback=` /
`?eyedown=` (view tuning), `?aplatency=` / `?apdelivery=` (the autopilot's display latency and
capture-to-result delay, to test a realistic Mac pipeline), `?attract=0`, `?mute=1`, `?sw=0` (no
service worker), `?source=app` (the installed app's start URL).

**App packaging (PWA):** `manifest.webmanifest` (name, `start_url ./?source=app`, scope `./`, display
`fullscreen` → `standalone`, icons), `sw.js` (versioned caches: the precache list from
`tools/precache.mjs` with a content hash per file, so an update only downloads what changed; network
first for the page, `src/` and `styles/` so updates arrive; cache first for the immutable `vendor/`,
`models/`, `assets/`, `fonts/`, `icons/`; same-origin requests only) and `src/app/pwa.js` (registration,
*Update ready* notice, install button / Safari hint, display-mode detection, F full screen with Keyboard
Lock for Esc). Icons are original artwork generated by `tools/icons.mjs` (a padel racket whose holes form
a V, and a ball, on court blue).

Code map: `src/physics` (ball, court, racket impact, prediction), `src/rules` (referee, scoring),
`src/tracking` (camera, MediaPipe, body model, locomotion, racket track, strokes, synthetic camera,
autopilot), `src/game` (world, human controller, machine, coach, drills, modes, session),
`src/render` (three.js scene, hall, rackets, hands, humanoids, effects), `src/audio`, `src/ui`, and
`src/main.js` + `src/app/*` (boot, loop, flow, wiring, replay). The contract between modules is
`docs/SPEC.md`. Every runtime path is relative, so the site works from any sub-path (GitHub Pages).

**Deploy:** push to `main`; `.github/workflows/pages.yml` runs the unit tests, refreshes the precache
list and version in `sw.js` (`node tools/precache.mjs --write`) and publishes the repository root to
<https://mjplamann.github.io/vibora-padel/>. In the repository settings choose *Pages → Source: GitHub
Actions*. Installed apps pick the new version up as an *Update ready* notice.

## 8. Credits and licences

Víbora Padel is MIT licensed (`LICENSE`). It bundles three.js (MIT), MediaPipe Tasks Vision and the
pose landmarker models (Apache-2.0), the WebXR Input Profiles generic hand models (MIT, © Amazon) and
the Big Shoulders Display and Barlow Semi Condensed fonts (SIL OFL 1.1). Details and licence files:
`THIRD_PARTY_NOTICES.md`. Everything else — the club, court, glass, rackets, ball, players, textures
and all sounds — is generated procedurally. "VÍBORA" is a made-up club; no real brand is shown.
