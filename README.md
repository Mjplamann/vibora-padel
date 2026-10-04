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
- **Timing-based hitting** (Club and Rookie): swing on time and you hit it. Swing speed sets the pace,
  early / late sets the direction, the swing path sets topspin or slice, and the ball flies with full
  physics. Pro keeps true racket-on-ball contact.
- **The ball is easy to see**: a minimum on-screen size, a glow, a shadow and a drop-line to the floor,
  and a ring around the ball in reach that turns **green at the moment to swing**
- **A reason for every miss**, on screen and by voice ("Swing was 0.3 s late", "No swing detected —
  swing a bit faster", "Racket was 50 cm below the ball"), and **Copy diagnostics** to send a session's
  numbers
- Balls off the back glass: a **rear-view mirror** shows them while your view stays on the net, with a
  "Let it come off the glass… now!" cue and an optional learning slow motion
- Per-shot feedback: stroke, km/h, rpm (topspin / slice), net clearance, sweet spot, timing and spacing
- **VITURE glasses mode** (experimental): true-scale view, compact HUD, head tracking from the glasses
  in Chrome, optional 3D side-by-side
- **Instant replay** (R) in slow motion from the broadcast camera, with your tracked racket path
- **You have a body**: on a TV, your full-body shadow falls on the court in front of you as you step
  and swing. With the VITURE glasses' head tracking you can look down at your torso, legs and shoes
  stepping with you (upper body from the camera, so standing close to the TV works; split-steps as
  the ball is struck). The replays show your whole body.
- **Lifelike players**: skinned athletes with varied kits, skin tones and hair, real padel strokes,
  split-steps, planted-foot footwork, celebrations and partner high fives; the instant replay shows you too
- **Stand close or far**: close (1.3–2.2 m, head, shoulders and arms in the picture: a small room works)
  or full body (2.2–3.5 m); the tracker switches by itself
- **Smooth swings**: the racket you see is drawn at the screen's refresh rate between camera frames,
  steady at rest, with a faint motion trail on fast swings and a follow-through that carries on
- **Three venues**: the indoor club at night, **Costa Sunset Courts** (outdoor, golden-hour sun with
  long shadows, palms and the sea) and the **Arena Central** stadium (3,300 spectators who applaud, ooh,
  groan, roar on a *por tres* and start waves, LED boards, umpire chair, ball kids)
- **Sound of the game**: a modelled padel *pock* (sweet spot vs frame), glass thunks tuned to each
  panel, mesh rattle, swing whoosh, venue acoustics, a chair umpire calling the score in Spanish or
  English, and your partner's *¡Mía!* / *¡Tuya!* / *¡Pared!*
- **Circuito Víbora career**: eight tournaments from the Club Open to the Pro Tour Finals (1–3 knockout
  matches each) against named AI pairs whose personalities change how they play — the lobber, the big
  hitter, the wall master, the net rusher, the chiquita artist, the all-rounder — at the three venues.
  Pick your partner (each has a personality and calls the ball). Matches save after every point and
  resume exactly where you left them.
- **Arcade**: 60–90 s scored challenges with combos (×2…×5), *Perfect timing!* bonuses and local
  leaderboards against the circuit's players — **Por Tres Party**, **Glass Breaker** (glowing targets on
  the far glass: bounce first, then shatter them), **Rally Marathon** (three lives, the coach speeds up),
  **Volley Wall** — and a **Daily Challenge** with a twist, the same for everyone on that date.
- **Progression**: XP and levels, trophies, 24 achievements, five rackets with real trade-offs (power,
  control, sweet-spot size, spin — the racket changes the impact physics and the timing hits) and six
  outfits to unlock; a workout recap (active minutes, swings, kcal) and a daily streak.
- **Automatic slow-motion replays** of the great moments (por tres, winners, 15-shot rallies, streaks of
  perfect timing, a shattered target) from broadcast angles — any key or a raised racket skips them.
- Voice coach (English / Spanish), spatial sound, hand-cursor menus usable from 3 m away

### What's new

- **Close mode for small rooms.** Stand 1.3–2.2 m from the camera with only your head, shoulders and
  arms in the picture. Overheads (bandeja, víbora, smash, serve) still register when your hand goes
  above the top of the picture: the tracker rebuilds the arm from the shoulder and elbow. If it keeps
  happening, a hint tells you to step back or tilt the camera up.
- **The camera's tilt is learned.** A MacBook lid tilted back (or a camera aimed up or down) no longer
  skews your height and steps. The play-area calibration step measures the tilt and the camera height
  and shows them. You can also set the tilt by hand in Settings → Movement & view → *Camera tilt*.
- **Smooth swings, and the racket stays on screen.** The racket is drawn at the screen's refresh rate
  and holds steady at rest (a noisy webcam picture still makes it shimmer a little). In the last
  0.4 s before a contact, a faint cyan **racket ghost** marks where your racket will meet the ball.
  For low balls the view dips slightly so your racket is in the picture as it comes through. Turn the
  ghost off in Settings → Ball & aids. Forearms close to your eyes are cut off cleanly instead of
  fading into a see-through disc.
- **Three venues**: the club at night, Costa Sunset Courts and the Arena Central stadium. On a TV, a
  light behind you casts your **full-body shadow forward onto the court**, so you can see yourself move.
- **The career adapts to you.** Opponents get stronger as you win and ease off as you lose, within each
  event's range. The event card shows the current level (*Rivals: Club−*). If you are stuck, the next
  event opens after three tries, and a lost tournament still earns XP.
- **Arcade**: in *Glass Breaker* the brightest target is your aim. A drive hit on time flies at it; early
  pulls the ball cross-court and late sends it down the line. Targets start big and shrink as your combo
  grows.
- **Fewer, better replays.** In matches you get at most one automatic replay per game, only for points
  you won (a winner, a smash, a *por tres*, a rally of 20+ shots), and never within 45 s of the last
  one. In rally mode they are at least 2 minutes apart. The first replay shows where to turn them off.
- **First hits are guided.** Until your first five hits, the HUD tells you when to swing: as the ring
  around the ball turns green.
- **Spacing feedback** on the shot card (*stretched 25 cm, step closer*; *cramped, give it room*), a
  clearer *Volley too soft — punch forward* miss reason, and a workout recap that counts one swing per
  stroke.

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

Two ways to stand. **Close (1.3–2.2 m):** the camera only needs your head, shoulders and arms. Put it at
chest height (about 1.2–1.4 m: a MacBook on a shelf or a stack of books, screen upright) and stand an
arm's length or two away; the game boosts your movement so a smaller room still covers the court. For
overheads, your hand raised high above your head should still be in the picture. The calibration's
*Play area* step warns you if it isn't. Standing 1.7–2 m away, rather than
1.3 m, keeps it in frame. If the camera points up or down (a MacBook lid tilted back), calibration
measures the angle. Otherwise set it in Settings → Movement & view → *Camera tilt*.
**Full body (2.2–3.5 m):** head to ankles in the picture, about 3 × 3 m of floor. The tracker switches
between the two by itself (it watches whether your legs are really in view), and the calibration screen
shows which one it is using. Point the camera straight at you, just under, on top of or in front of the
TV.

- **MacBook built-in camera:** lid open, the Mac **under or in front of the TV at chest height** (on a
  stool, shelf or TV stand) with its screen facing you. Stand about 1.5–2 m away for close mode, or step
  back until your ankles are in frame for full body.
- **iPhone (Continuity Camera, best):** macOS 13+ / iOS 16+, same Apple ID, Wi‑Fi and Bluetooth on.
  **Mount the iPhone on the TV** (a MagSafe or clip mount) in landscape with the **rear camera facing
  you**, screen locked. It shows up as "iPhone Camera". In **Control Centre → Video Effects** turn
  **Center Stage off** (it zooms and pans, which the tracker reads as movement) and don't pick "Desk
  View".
- **USB webcam:** on top of the TV, centred.
- Even light on you; avoid a bright window behind you. Clothes that contrast with the wall help.

## Play with VITURE Beast glasses (experimental)

Plug VITURE XR glasses (Beast, Luma, Pro, One) into the Mac's USB‑C port and they become a display. In
**Settings → VITURE glasses** turn on **Glasses mode**: the view switches to true scale (33° × 50°:
things appear their real size), and the HUD becomes compact. In **Chrome or Edge**, **Connect glasses**
reads the glasses' motion sensor over WebHID: turn your head to look around the court, including back
to the glass, or look down at your own body and feet (on a TV the view can't look down that far, so
there you see your shadow on the court instead). Safari has no WebHID, so you get the true-scale view
without head tracking.

1. On the glasses use the standard, head-locked display: turn off their own 3DoF / anchored screen and
   **Smooth Follow**. Víbora turns the view itself.
2. **System Settings → Displays**: select the glasses, *Use as: Main display*, 1920 × 1200, 60 Hz.
3. The cable keeps the Mac next to you, so use an **iPhone as a wireless Continuity Camera** 2.5–3 m
   away at chest height (or a USB webcam on a long active cable).
4. Set dimming to maximum. Clear the play area: you will not see the furniture.
5. Face where you play, press **C** (or Home) to recentre. Every drill recentres by itself.
6. If left / right is reversed, run **Axis test** (turn left, look up, tilt left) or press *Flip left /
   right*.
7. **3D (experimental):** switch the glasses to 3D side-by-side (3840 × 1200) and set *3D* to Auto or
   On. The court then has real depth, with a small in-world HUD. Menus look split in 3D, so set up in 2D.

Head tracking is new and untested on real Beast hardware. If it misbehaves, use *Copy glasses
diagnostics* and send it.

- "No data from the glasses": unplug, replug and *Connect* again, and close VITURE's own apps, which can
  hold the device.
- The view slides back to centre by itself: the glasses are in Smooth Follow; turn it off.

Developer notes: `?glasses=1` (glasses mode for this visit), `?xrsim=1` (simulated glasses sweeping the
head ±25°; `?xrsim=legacy` for the older protocol), `?stereo=1`; `node dev/xr-shot.mjs` (stereo eye
order, layouts, head sweep); `node dev/xr-app-shot.mjs` (the real app with glasses).

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

1. **In frame** — the head and shoulders ticks (close mode) or all five (full body) turn on and the
   distance marker sits in the band for that mode: *Close* 1.3–2.2 m or *Full body* 2.2–3.5 m. The
   *Tracking* line says which mode the tracker is using.
2. **Your spot** — stand still in a ready position for 2 s. This becomes your home position on court.
3. **Profile** — racket hand and height (sets eye height, reach and your forehand side).
4. **Latency test** (optional, recommended; marked *recommended* in Safari, which doesn't report when
   the camera captured each frame) — swing your racket hand **down** on each of 6 flashes. The measured
   delay is used to rewind time when judging your hits.
5. **Play area** — take one step left, right, forward and back and watch the live readout (close mode
   asks for smaller steps, 20 cm, and shows the boosted movement gains). While you step, the game
   learns the camera's **tilt and height** from how your body moves in the picture and shows them
   (*Camera tilted ~9° up · corrected*). It also asks you to raise your racket hand high above your
   head, as for a smash: if it leaves the top of the picture, step back a little or tilt the camera up.

### Controls

| Action | How |
|---|---|
| Hit | Swing your real arm as the ball comes. Your hand is the racket grip; the face follows your palm (palm side = forehand face). On Club and Rookie a swing **on time** hits (the ring around the ball turns green: swing now); on Pro the racket must meet the ball. |
| Move on court | Step sideways (×2.6) and toward / away from the TV (×2.2). Toward the TV = toward the net. A living room only allows about ±0.6 m of steps, so the game moves your court spot for the big moves (a short ball at your feet, a lob over your head; in rally and match it follows padel tactics and keeps you at the net after a volley, lob or serve) and your own steps do the rest. If the camera loses your head or shoulders, the HUD tells you to step back (your legs may be out of the picture: close mode). |
| Menus | Raise a hand: a cursor appears; hover 1 s to click. Or arrows + Enter, or the mouse. On the title screen the hand works as soon as the camera is on (straight away if the browser already allows the camera). |
| Start a drill | "Start drill", or raise your racket hand above your head for a moment |
| Pause | Both hands above your head for 2 s (not while a ball is live), or Esc / P |
| Instant replay | R (or *Pause → Instant replay*, or *Watch replay* on the results). V changes the view. |
| Camera picture-in-picture / skeleton | C / K during play (with glasses head tracking, C recentres the view: Shift+C toggles the picture-in-picture) |
| Glasses: recentre view | C or Home while glasses head tracking runs (every drill also recentres) |
| Copy diagnostics | *Pause → Copy diagnostics*, *Settings → Copy diagnostics*, or **D** on the pause screen. Paste it into a message when you report a problem. |
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

The racket you see is drawn at the screen's refresh rate between camera frames and kept steady at rest;
a fast swing leaves a faint motion trail, and the follow-through carries on smoothly when the camera's
view of your wrist blurs. Hits are judged from the camera's own frames, not from this drawn racket.

## 3. Drills

| Drill | Skill | What you practise |
|---|---|---|
| Forehand Drive · *Derecha* | Groundstrokes | Deep cross-court drives; bonus for a flat, low net clearance |
| Backhand Drive · *Revés* | Groundstrokes | The same on the backhand side |
| Off the Back Glass · *Salida de pared* | Walls | Let a deep ball rebound off the back glass, then drive it deep |
| Corner Exit · *Doble pared* | Walls | The ball comes off both glasses in the corner (back, then side) |
| Net Volleys · *Voleas* | Net | Chest-high feeds alternating sides; punch them deep |
| Bandeja | Overheads | Defensive lobs; controlled overhead deep (pace above 85 km/h is penalised) |
| Víbora | Overheads | Cut overhead into the far side-glass corner |
| Smash Por Tres · *Remate por tres* | Overheads | Short lobs; smash so the ball bounces and exits over the back wall |
| Defensive Lob · *Globo* | Tactics | Opponents at the net: lob over them, deep, apex > 4.5 m |
| Chiquita | Tactics | Opponents at the net: soft, low ball at their feet |
| Serve · *Saque* | Serve | Drop, bounce, serve below the waist into the diagonal box |
| Return of Serve · *Resto* | Serve | The machine serves; return cross-court deep or lob |
| Live Ball Mix · *Bola viva* | Tactics | Random feeds from all of the above |

The glass drills are fed so the ball comes back off the glass to a comfortable contact: 0.6–1.3 m high
and at least 1 m out of the glass. A *"Let it come off the glass… now!"* cue tells you when to swing.

Every rep is judged by the referee with real padel rules (own glass is legal before the ball crosses;
the ball must bounce on the far side before touching a wall; touching your own wire mesh loses the
point; exits after the bounce are *por tres* / *por cuatro*). The machine never fires while your ball is
still in play: the next feed comes about a second after the ruling (the drill's interval is the
minimum). Stars and personal bests are saved in the browser.

## 3b. Career, Arcade and progress

The hub has five tiles: **Career**, **Arcade**, **Drills** (the training curriculum), **Rally** and
**Match** (free play: pick the opponent level, the venue and, for a match, its length), plus Trophies,
Settings, Recalibrate and Help.

| | |
|---|---|
| Career | 8 events: Club Open, Liga Social (club) · Torneo Atardecer, Regional Open, Copa Costa (sunset) · National Championship, Víbora Masters, Pro Tour Finals (stadium). Rookie → Club → Pro opponents; one set first to 2–6 games, golden point. Win an event to open the next, or play it three times (the card says *opened after 3 tries*). Losing a round ends the run (finalist / semifinalist trophies count, and every tournament played earns XP). Leaving a match saves it point by point. **Opponents adapt to your form**: each event has a range of rival strength. Points and matches you win move it up, losses move it down, and the event card shows the current level (*Rivals: Club−*, recommended player level). |
| Opponents | Lobber (high deep lobs, pushes you off the net) · Big hitter (flat 15 % faster drives and smashes, more errors) · Wall master (plays to your glass, rarely misses off its own) · Net rusher (follows attacking shots in, angled volleys) · Chiquita artist (soft dipping balls at your feet) · All-rounder. Each pair wears its own kit; players celebrate a won point and hang their heads after a lost one. The event intro shows each card and a tip. |
| Partner | Lucía (wall master), Nico (net rusher) or Pablo (lobber): plays the left side, covers the middle and calls the ball (*¡Mía!*, *¡Tuya!*, *¡Pared!*, *¡Vamos!*): a chip on the left of the picture, and spoken in Spanish by their own voice. |
| Umpire | In matches a chair umpire calls the score after every point (*Quince – nada*, *Iguales. Punto de oro*, *Juego, Víbora*; or in English), in the language set under Settings → Game & venue → *Umpire*. |
| Arcade | Combos: 3 good shots in a row ×2, 6 ×3, 10 ×4, 15 ×5; a miss resets it. Perfect timing (within 50 ms of the ideal moment, or a sweet-spot hit on time) adds 50 %. Leaderboards are kept on this Mac. |
| Rackets | Víbora Fang (teardrop, balanced) · Orbit Round (control, biggest sweet spot and a wider timing window, level 3) · Grit 3D Spin (rough face, spin, level 6) · Cobra Diamond (power, small sweet spot, more scatter; win the Regional Open) · Mamba Pro 18K (tour racket; win the National Championship). The racket changes both contact hits (Pro) and timing hits (pace, scatter, spin, timing tolerance). |
| Outfits | Six kits (Club navy, Court blue, Sunset coral, Optic, Tour white, Finals black): your sleeves, wristbands, shirt and shorts in first person, in your shadow and in replays. |
| Replays | Played only once the ball is dead (between points / reps), never mid-rally. Drills: at most one per 45 s (por tres, perfect-timing streaks). Arcade runs: one or two (por cuatro, a shattered target, a long rally). Matches: at most one per game and 45 s apart, only for a point you won (*por tres*, smash winner, winner, a rally of 20+ shots). Rally mode: at most one every 2 minutes. The first one shows a hint; turn them off in Settings → Game & venue → *Replays of great moments*. Not with the autopilot (`?autoreplay=1` forces them). |

### Venues

| Venue | What it is |
|---|---|
| **Víbora Padel Club** (indoor, night) | The training hall: LED fixtures, a lounge bar behind the far court, a dozen spectators, neighbouring courts. |
| **Costa Sunset Courts** (outdoor) | Golden hour: a physically based sky with a low sun casting long shadows (the glass and wire mesh too), palms, the sea with sun glitter, warm colour grade, dusty turf, sea breeze and birds. |
| **Arena Central** (stadium, *Víbora Tour Finals*) | A show court with ~3,300 spectators, animated LED boards (original graphics only), camera towers, an umpire chair, ball kids and benches; the crowd hushes for the serve, oohs off the glass, roars on a *por tres* and starts waves. Big-hall reverb. |

Free play and the arcade use the venue picked in the Match / Rally setup (or Settings → Game & venue);
career events have their own. The 3D court behind the menus shows the venue you are choosing.

### Sound

Every sound is synthesised: the racket *pock* (bright at the sweet spot, dull off the frame), the glass
thunk at each panel's resonance, mesh rattle, turf bounce, the swing whoosh (bigger for smashes), and the
venue's acoustics (club hall, open air, arena). The crowd reacts to the play (crowd volume in Settings →
Game & venue) and ducks under speech; one speech queue carries the voice coach, the umpire and the
players' calls, so nothing talks over anything else. *Voice coach: off* silences the coach only.

## 4. Settings

- **Assist** (Settings → Play):
  - **Pro** — real physics only: the racket must meet the ball within the 2 cm face margin, no aim
    help, no movement help.
  - **Club** (default) — **timing hitting** (below), outgoing direction blended 35 % toward the shot
    you were going for, half net-safety lift, and auto-positioning that takes you 75 % of the way to a
    good stance (your own steps do the rest).
  - **Rookie** — timing hitting with a wider window and any reach, 65 % blend, 90 % net safety, and
    auto-positioning all the way to the stance.
- **Hitting** (Settings → Play → *Hitting: Auto / Timing / Contact*). *Auto* follows the assist (Club and
  Rookie: timing, Pro: contact). With **timing**, a swing whose racket peak comes within the window
  around the ideal contact moment hits the ball where it really is at that moment: the swing speed sets
  the pace, early / late sets the direction (early pulls it cross-court, late pushes it down the line),
  the swing path sets topspin (brushing up) or slice (cutting down), and the ball then flies with the
  full physics. *Contact* needs the racket to meet the ball, as on Pro.

  | Assist | Early | Late | Reach (racket to ball) | Swing speed to count |
  |---|---|---|---|---|
  | Club | −0.20 s | +0.22 s | 0.75 m | 4 m/s (volleys and chiquitas 2.4 m/s, serves 3 m/s) |
  | Rookie | −0.32 s | +0.35 s | any | 3 m/s (volleys and chiquitas 1.8 m/s, serves 2.25 m/s) |

  A swing is read from your tracked racket hand's speed relative to your body, so walking does not
  count as a swing.
- **Misses are explained.** Every ball you do not hit gets a reason at the top of the picture, under the
  mirror, and from the voice coach: *Swing was 0.3 s late*, *No swing detected — swing a bit faster*,
  *Racket was 50 cm below the ball*, *Ball was 30 cm out of reach — step left*, *Let it come off the
  glass first*, *Let the serve bounce* or *Lost you on camera*. A timing meter shows how early or late each
  swing was. The results screen lists your misses by reason.
- **Ball & aids** (Settings → Ball & aids):
  - **Ball visibility**: *Real*, *Enhanced* (default: the ball is never drawn smaller than 0.45° across,
    with a glow, a contact shadow and a drop-line to the floor) or *Max* (0.8°).
  - **Reach ring**: a ring around the ball when it is coming into your reach; it is yellow, then turns
    **green at the moment to swing**. For a ball off the glass a marker shows the contact point.
  - **Learning slow motion** off the glass (*Rookie* = on for Rookie only, *On*, *Off*): the game slows
    to 0.7× around the glass rebound so you can read it.
  - **Timing tick**: a short tick 0.15 s before the moment to swing on every ball (glass balls always
    get the *now!* cue).
  - **Racket ghost** (on by default): a faint cyan racket at the planned contact in the last 0.4 s
    before you hit, so you can see where the racket will meet the ball even while your real racket is
    still out of the picture.
  - **Landing marker** (predicted first bounce, Rookie/Club), **ideal contact ghost**, **ball halo**.
- **Copy diagnostics** (Pause, Settings, or D on the pause screen) copies a compact report of your
  setup (browser, display, camera, tracker, calibration, settings) and your last 40 swings (speed,
  timing error, distance to the ball, result) and the misses per drill. If the browser blocks the
  clipboard, a text box opens: select all, copy, and paste it into a message.
- **Movement gains** (sideways / forward), **field of view**, **gaze follows the ball**, **latency**.
  The default view is tuned for a TV: a 74° vertical field of view, the head pitched 14° down and the
  viewpoint 12 cm behind / 6 cm below your tracked eyes, so in a ready position the hand holding the
  racket and your other hand sit at the bottom of the picture (like a VR headset's wider view) while the
  far glass stays in frame. Your real body faces the TV, so the view only turns a little: it follows the
  ball gently (up to ±25°). When a ball goes past you to the back or side glass, a rear-view mirror at
  the top of the picture shows the rebound (Settings → Movement & view → *Balls behind you*: **Mirror**
  · **Turn the view**, a smooth head turn of up to 75° · **Fixed**). In the last 0.8 s before a contact
  the view frames the contact point in the lower middle of the picture (overheads: it never looks more than 25° up). Forearms fade out where
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
- **Camera tilt** (Settings → Movement & view): *Auto* (learned in the calibration's play-area step) or a
  fixed angle for a camera that points up or down. A wrong tilt makes you taller or shorter on court and
  turns steps toward the TV into steps up or down.
- **Off-axis arm correction** (experimental, off): when you stand well to one side of the camera,
  rotates the tracked arms back toward the camera's axis. Leave it off unless your racket face looks
  turned when you step sideways.
- **VITURE glasses** (experimental): glasses mode, head tracking, 3D side-by-side, IPD, axis test and
  flips; see [Play with VITURE Beast glasses](#play-with-viture-beast-glasses-experimental).
- **Game & venue**: free-play venue (Club / Sunset / Stadium), umpire language (Español / English /
  off), crowd volume, partner callouts, automatic replays of great moments.
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
| Hits feel late or early | Turn on the TV's Game Mode, then redo the latency test (Settings → Recalibrate). The timing meter and the miss reason tell you how early or late each swing was. |
| You swing but never hit | Check the miss reason at the top of the picture. *No swing detected*: swing a little faster and fuller. *Too far / below*: take a step (or use Rookie, which reaches any ball). Use *Copy diagnostics* and send it if it keeps happening. |
| The 3D view goes black when you turn sideways (HUD still visible) | Fixed in this version: bad tracking data can no longer reach the 3D view. If it ever happens, open `?debug=1` and copy the *safety* line (or *Copy diagnostics*) into a bug report. |
| You move when standing still | Turn off Center Stage; keep your head and shoulders (close) or your whole body (full) in frame; recalibrate your spot. |
| The room is too small to stand 2.5 m back | Stand 1.3–2.2 m from the camera with it at chest height (close mode): only your head, shoulders and arms need to be in the picture, and your steps are amplified a little more. The calibration's *Tracking* line says *Close · upper body*. |
| "Head out of view" during play | You are too close for the camera's height: step back a little, or raise the camera to chest height. |
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
npm test           # 547 unit / end-to-end tests (node --test), deterministic
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
and *Restart* activates it (`--only=pwa` runs just that part). It ends with the black-screen check
(`tools/blackscreen.mjs`: a degenerate mesh in view and the autopilot turning side-on to ±95° with
hidden arms, label swaps and NaN / Infinity landmarks never black out the picture; `--only=blackscreen`)
and the glasses checks (`dev/xr-shot.mjs`, `dev/xr-app-shot.mjs`: stereo eye order, a simulated head
sweep driving the camera, the real app in 3D side-by-side; `--only=xr`). Round 4 adds close mode
(`--only=close`: the human-like autopilot 1.7 m from a chest-height camera with its legs out of the
picture plays the drill on the upper-body tracker), a stadium match (`--only=match`: four skinned
players, the crowd venue), a close-mode calibration with a synthetic person at 1.7 m in the camera
stage, and a first-person-body check in the autopilot stage.
Software WebGL renders the full scene at only ~1–2 fps, so the smoke test freezes the simulation at
chosen moments (`__vibora.freezeOn('contact' | 'hit')`) to take its screenshots.

URL flags: `?autopilot=1` (a virtual player drives the real tracking pipeline through a synthetic
camera; also the title-screen demo), `?drill=<id>`, `?mode=rally|match&level=rookie|club|pro`,
`?fallback=1`, `?debug=1` (fps, draw calls, pose inference ms, latency, safety net, tracker guards),
`?quality=ultra|high|balanced`, `?assist=rookie|club|pro` (this visit only),
`?speed=N` (sim seconds per real second, for headless tests), `?fov=` / `?pitch=` / `?eyeback=` /
`?eyedown=` (view tuning), `?aplatency=` / `?apdelivery=` (the autopilot's display latency and
capture-to-result delay, to test a realistic Mac pipeline), `?approfile=human` (the autopilot plays like
a person: timing spread σ 90 ms, racket position error, partial steps, 5 % of balls with no swing),
`?apjitter=` (extra random delivery delay of a 30 fps webcam-like feed) and `?apnoise=` (landmark noise,
1 = a MacBook camera at 2.5 m), `?apclose=1` (the autopilot stands 1.7 m from a camera at chest height
with its legs out of the picture: close mode), `?glasses=1` / `?stereo=1` / `?xrsim=1` (glasses mode),
`?attract=0`, `?mute=1`, `?sw=0` (no service worker), `?source=app` (the installed app's start URL).
Round 4: `?venue=club|sunset|stadium`, `?challenge=<id>|daily`, `?career=<eventId>` (`&quick=1`: sets
to one game — 2-0 or a tie-break at 1-1), `?autoreplay=1|0`, `?firsthits=1` (the first-time timing prompt), `?screen=career|arcade|trophies|training|freeplay|event-intro|settings`
(with `&event=`, `&tab=`, `&fpmode=`).

Round 4 developer pages and harnesses: `dev/calibrate.html` (the close-mode body check),
`dev/humans.html` (skinned players, strokes, kits), `dev/venues.html` + `node dev/venues-shot.mjs` /
`node dev/venues-app-shot.mjs` (the three venues), `dev/audio-venues.html` (venue sound, umpire),
`dev/game-ui.html`, `node dev/game-shots.mjs` / `node dev/game-play-shots.mjs` (career, arcade, HUD,
results), `dev/rackets.html` (the five racket models).

**App packaging (PWA):** `manifest.webmanifest` (name, `start_url ./?source=app`, scope `./`, display
`fullscreen` → `standalone`, icons), `sw.js` (versioned caches: the precache list from
`tools/precache.mjs` with a content hash per file, so an update only downloads what changed; network
first for the page, `src/` and `styles/` so updates arrive; cache first for the immutable `vendor/`,
`models/`, `assets/`, `fonts/`, `icons/`; same-origin requests only) and `src/app/pwa.js` (registration,
*Update ready* notice, install button / Safari hint, display-mode detection, F full screen with Keyboard
Lock for Esc). Icons are original artwork generated by `tools/icons.mjs` (a padel racket whose holes form
a V, and a ball, on court blue).

Code map: `src/physics` (ball, court, racket impact, prediction), `src/rules` (referee, scoring),
`src/tracking` (camera, MediaPipe, body model with close mode, locomotion, racket track, strokes,
synthetic camera, autopilot), `src/game` (world, human controller, drawn swing, machine, coach, drills,
modes, session, career, arcade challenges, progression, achievements, callouts),
`src/render` (three.js scene, court kit and venues (`render/venues`), crowd, rackets, hands, your own
body, skinned humans and their animation (`render/animation`), effects, rear-view mirror, render
safety net), `src/xr` (glasses mode: WebHID driver, stereo renderer, panel), `src/audio` (synthesis, venue sound,
crowd, voices, umpire), `src/ui` (screens, HUD, calibration, career / arcade screens), and
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
`THIRD_PARTY_NOTICES.md`. Everything else — the club and the other venues, court, glass, crowd,
rackets, ball, players, textures and all sounds — is generated procedurally (spoken lines use the system's voices). "VÍBORA" is a made-up club; no real brand is shown.
