# Víbora Padel — build spec

A first-person, camera-tracked padel **training** simulator. It runs in Chrome or Safari on a MacBook (M-series) plugged into a TV over HDMI. A webcam (MacBook camera, iPhone via Continuity Camera, or a USB webcam) watches the player. The player sees the court **through their own eyes**, as in VR: their forearms, hands and padel racket are rendered in front of them and driven by their real arms. Stepping side to side or toward/away from the TV moves them on court (amplified). Ball physics must be realistic: glass rebounds, mesh deadening, spin, drag and Magnus.

This spec is the contract between modules that are built in parallel. **Follow signatures and data shapes exactly.** If you need something another module doesn't export, write a small local helper in your own file rather than editing someone else's file, and mention it in your final report.

---

## 0. Ground rules

- **Language:** plain modern JavaScript ES modules (no TypeScript, no bundler, no npm runtime deps). JSDoc types are welcome.
- **Purity:** modules under `src/util`, `src/config.js`, `src/physics`, `src/rules`, `src/tracking/{body,locomotion,swing,racketTrack,synthetic,autopilot}.js` and `src/game` must be **pure**. They must not touch `window`, `document`, `three` or browser APIs, so they run under `node --test`. Inject storage, time and RNG.
- **Three.js:** browser modules import `three` and `three/addons/...` via the import map in `index.html`:
  `{"imports": {"three": "./vendor/three/three.module.js", "three/addons/": "./vendor/three/addons/"}}`.
  Available addons are under `vendor/three/addons/` (environments/RoomEnvironment, loaders/GLTFLoader, utils/BufferGeometryUtils, utils/SkeletonUtils, postprocessing/*, shaders/*, geometries/RoundedBoxGeometry, math/SimplexNoise, math/ImprovedNoise). Do not add others.
- **MediaPipe:** `vendor/mediapipe/vision_bundle.mjs` exports `FilesetResolver` and `PoseLandmarker`. WASM is in `vendor/mediapipe/wasm/`. Models: `models/pose_landmarker_{lite,full,heavy}.task`.
- **Assets:** `assets/hands/{left,right}.glb` are WebXR generic hands (MIT). They are skinned with joints named `wrist, thumb-metacarpal, thumb-phalanx-proximal, thumb-phalanx-distal, thumb-tip, index-finger-metacarpal, index-finger-phalanx-proximal, index-finger-phalanx-intermediate, index-finger-phalanx-distal, index-finger-tip, middle-finger-…, ring-finger-…, pinky-finger-…`, plus a mesh node. They are about 20 cm long and sit in meters. Fonts are in `fonts/` (Big Shoulders Display 800/900, Barlow Semi Condensed 400/600/700). Everything else is procedural: no external images or sounds.
- **Shared code already written:** `src/util/vec3.js` (`Vec3`, `v3`), `src/util/math.js` (`clamp, lerp, invLerp, remap, smoothstep, damp, angleDiff, DEG, msToKmh, radsToRpm, rpmToRads, createRng, OneEuro, OneEuro3, RingBuffer, hermite, createBus`), and `src/config.js` (`COURT, netHeightAt, BALL, SURFACES, SIM, RACKET, PLAYER, TRACKING, ASSIST, DEFAULT_ASSIST`). **Read them first. Do not modify them.** If a constant is missing, define it locally and report it.
- **Tests:** `node --test tests/` (Node 22). Each pure-module owner writes `tests/<area>.test.mjs` using `node:test` and `node:assert/strict`. Tests must be deterministic: seed RNGs and give mesh jitter a seed.
- **Style:** 2-space indent, single quotes, semicolons, small focused functions, comments only where intent isn't obvious. No `console.log` in shipped code except behind a `debug` flag.
- **Performance:** physics must step one ball at 960 Hz in well under 1 ms per frame. Avoid allocations in hot loops: reuse `Vec3` scratch objects at module scope.

## 1. Coordinate frames and units

- **Court/world frame:** meters, Y up, net plane at z = 0, court interior x ∈ [-5, 5], z ∈ [-10, 10]. The human player lives on the **near half (z > 0)** and faces **-z**. The player's right is **+x**. The far half (z < 0) holds the ball machine, coach and opponents. "Cross-court" from the near right side (x > 0) means the far left (x < 0).
- **Side naming:** `'near'` when z > 0, `'far'` when z < 0.
- **User frame U** (tracking output): origin on the floor under the user's hip center. +x is the user's right, +y up, +z **toward the TV/camera**. This is "forward", and maps to court -z.
- **U → court mapping** for the near player standing at court position (px, pz): `court = (px + u.x, u.y, pz - u.z)`.
- **Time:** the simulation's `world.time` is in seconds. Camera and pose timestamps are `performance.now()` milliseconds; convert to seconds via `simTimeOf(ms)`, which is defined in `main.js` and passed into modules that need it.
- **Display units:** speed in km/h (`msToKmh`), spin in rpm (`radsToRpm`), distances in m/cm.

## 2. Physics (`src/physics/`)

### 2.1 `ball.js`

```js
export function createBall(pos = v3(0,1,0), vel = v3(), spin = v3()) // -> BallState
export function cloneBall(ball) // deep copy
export function copyBallInto(dst, src)
export function stepBall(ball, dt, court, rng, events /* array, push */, opts = {}) // advances ball.t by dt using SIM.ballSubsteps-equivalent internal steps (step size dt/ceil(dt*960))
export function ballSpeed(ball)
export function ballAccel(ball, out /*Vec3*/) // gravity + drag + Magnus, for tests
```

`BallState = { pos: Vec3, vel: Vec3, spin: Vec3 /* rad/s, world */, t: number, outside: boolean, atRest: boolean, lastSurface: string|null, id: number }`

- **Forces:** gravity `SIM.gravity`. Drag `F = -½ρ Cd A |v| v`. Magnus lift `F = ½ρ C_L A |v|² · unit(ω × v)`, with `C_L = min(maxLiftCoef, 1/(2 + |v|/(r|ω⊥|)))` where ω⊥ is the spin component perpendicular to v. Spin decays with `exp(-dt/spinDecayTau)`.
- **Integrator:** semi-implicit with a midpoint velocity (RK2) per substep.
- **Collisions** are delegated to `court.collide(ball, prevPos, rng, events, dtRemaining)` after each substep. That call uses **swept** sphere tests so nothing tunnels at 60 m/s.
- Once `atRest` is set, the ball sits still on the floor and stepping is a no-op except for `t`.

### 2.2 `court.js`

```js
export function createCourt(opts = {}) // -> Court
export function resolveImpact(ball, normal /*unit Vec3, pointing out of the surface toward the ball*/, surface /*SURFACES entry*/, rng /*optional*/) // -> { impactSpeed, e, slip: boolean }
export function surfaceAt(kind /*'back'|'side'*/, y, absZ) // -> 'glass'|'mesh'|null  (null = open, above the wall)
export function sideOf(z) // 'near' | 'far'
export function inServiceBox(x, z, receivingSide /*'near'|'far'*/, boxHalf /*'left'|'right'*/) // per §2.6 semantics
```

`Court = { collide(ball, prevPos, rng, events, dtRemaining), colliders: [...], dims: COURT }`

**Geometry**, all from `COURT`:
- **Floor** at y = 0 everywhere. Inside the enclosure (|x| ≤ 5 and |z| ≤ 10) it's `turf`; outside it's `outsideFloor`.
- **Back walls** at z = ±10 for |x| ≤ 5: glass for y ∈ [0, 3], mesh for y ∈ [3, 4], open above.
- **Side walls** at x = ±5, banded by |z| as in `COURT.sideWall`. A ball crossing a wall plane above `meshTop` leaves the enclosure: emit `exit`, set `outside = true`, and from then on walls no longer collide (the floor still does).
- The walls are treated as planes, with the normal pointing into the court.
- **Corners:** sequential plane resolution within the same substep handles double-wall shots (back glass, then side glass).
- **Net** at z = 0 for |x| ≤ 5, from y = 0 to `netHeightAt(x) - cordRadius`. The body is a thin slab with `netBody`: absorb `absorb` of the speed, reflect the normal component with low e, and the ball drops on the hitter's side. The top band is a horizontal cylinder along x at height `netHeightAt(x)` with radius `cordRadius`, colliding with `netCord`. That gives realistic cord trickles.
- **Ceiling** at y = `COURT.ceiling`: emits `ceiling` and reflects.

**Impact model** (`resolveImpact`, Brody/Cross grip–slip): contact offset `rc = -r n`; contact velocity `vc = v + ω × rc`; normal speed `vn = v·n` (< 0 approaching); tangential slip `vt = vc - (vc·n) n`. Normal impulse `Jn = -(1+e) m vn` with `e = clamp(e0 - eSlope|vn|, eMin, eMax)`. Rolling impulse `Jroll = -m vt · α/(1+α)` with `α = inertiaFactor`. If `|Jroll| ≤ mu·Jn` the ball grips (`J_t = Jroll`); otherwise it slips (`J_t = -mu·Jn·unit(vt)`). Then `v += (Jn n + J_t)/m` and `ω += (rc × J_t)/(α m r²)`. For mesh, jitter the normal by up to `normalJitterDeg` (seeded rng) and scale outgoing speed by `1 - rng()*lossJitter`. Backspin balls must come off glass lower and slower than topspin balls. Add a test for this.

**Turf crater** (revision, `export const TURF_CRATER = { craterK: 0.01, craterMax: 15 }`): a fast, oblique ball dents the sand-filled turf (compliant-surface model, Penner 2002, "The run of a golf ball"). For turf impacts the contact normal tilts back toward the incoming ball by `craterK·|v_n|·|v_t|` degrees (speeds in m/s), capped at `craterMax`; `e` is still computed from the normal speed on the true surface, so the FIP drop test (no tangential speed) is unchanged at 1.398 m. Effect: a 140 km/h flat smash bouncing ~3 m past the net rebounds at ~41° (rigid model 30°) and clears the 4 m back wall (*por tres*); 100 km/h smashes, bandejas and drives stay in. Tests: `tests/realism.test.mjs`.

**Events**, pushed into `events[]`:
```js
{ type: 'bounce'|'wall'|'net'|'netcord'|'exit'|'ceiling'|'outside-bounce'|'rest',
  t, pos: Vec3 (contact point), vel: Vec3 (post-impact), side: 'near'|'far',
  surface: 'turf'|'glass'|'mesh'|'netBody'|'netCord'|'outsideFloor'|'ceiling'|null,
  wall: 'back'|'side'|null, impactSpeed /* m/s normal */ ,
  via: 'back'|'side'|null /* exit only */ }
```

### 2.3 `racket.js`: racket–ball contact and response

```js
export function racketFace(pose, out = {}) // -> { center, normal, xAxis, yAxis, semiX, semiY }  world-space face ellipse (center at RACKET.faceCenterY along axis)
export function pointOnRacket(pose, localX, localY, out) // world point
export function sweptContact(poseA, poseB, ballA, ballB, margin) // -> null | { u, point: Vec3, local: {x,y}, offCenter, approachSpeed }
export function racketImpact(ball /*mutated*/, poseAtContact, contact, opts = {}) // -> ImpactInfo
export function blendTowardIntent(physVel, intentVel, w, out) // -> Vec3
```

`RacketPose = { grip: Vec3, axis: Vec3 /*unit, grip->tip*/, normal: Vec3 /*unit, forehand face normal*/, vel: Vec3 /*sweet-spot linear velocity, m/s*/, angVel: Vec3 /*rad/s, optional*/, t }`

- **`sweptContact`** samples racket poses linearly between A and B (interpolate grip, renormalize axis and normal) and the ball linearly between ballA.pos and ballB.pos at matching u. It uses ≥ 12 sub-samples plus a final refinement. A hit happens when the ball center is within `r + thickness/2 + margin` of the face plane, **its projection falls inside the face ellipse grown by `margin`**, and the ball is approaching the face (relative velocity · face normal < 0), on either face. Return the earliest contact. If the ball came at the back face, report a negated normal so the impact uses the face actually hit.
- **`racketImpact`:** let `n` be the face normal facing the incoming ball's side. Relative velocity `vrel = vBall - vRacketPoint`, where the racket point velocity is `pose.vel + angVel × (point - sweet)` (just `pose.vel` if there's no angVel). Apparent COR `eA = max(minCOR, apparentCOR*(1 - corFalloff*(d/semi)^2))`. Reflect the normal component of `vrel` with `eA`. Apply tangential friction with the grip/slip rule, using `RACKET.mu` against the face, to change both tangential velocity and spin. Then add the racket point velocity back. Return
  `{ speedIn, speedOut, racketSpeed, offCenter, eA, spinRpm: { top, side, total }, quality /* 0..1 from offCenter */ }`.
  **Sanity targets** (put them in tests): with an incoming ball at 15 m/s and a sweet-spot racket at 15 m/s head-on, the ball leaves at about 26–29 m/s (≈100 km/h). An upward-brushing racket (velocity rotated 25° up relative to the face normal) gives 900–2500 rpm of topspin. A ball hitting the frame edge loses speed.
- **`blendTowardIntent(phys, intent, w)`** blends the directions by slerping unit vectors by w. The speed comes out as `lerp(|phys|, |intent|, w*0.6)`, which keeps most of the player's own power.

### 2.4 `predict.js`

```js
export function predict(ball, court, opts = { maxTime: 4, dt: 1/240, stopOn: ['exit','rest'], deterministic: true }) // -> { samples: [{t,pos,vel}], events: [...] }
export function solveShot({ from: Vec3, target: Vec3 /* landing point, y=0 */, spin = v3(), flightTime = null, apex = null, court }) // -> { vel, landing, flightTime, netClearance, apex, ok, error }
export function interceptCandidates(prediction, { playerPos /*court x,z*/, maxSpeed, reachRadius, minHeight, maxHeight, side: 'near'|'far', fromTime = 0 }) // -> [{ t, pos, vel, kind: 'volley'|'after-bounce'|'after-wall', travel, slack }]
export function netClearance(prediction) // min (y - netHeightAt(x)) when crossing z=0, or null
export function firstBounce(prediction) // first 'bounce' event or null
```

- `predict` clones the ball and simulates. With `deterministic`, mesh jitter is disabled so it gives the expected value.
- `solveShot` targets a landing point, the first floor bounce, with **full drag and Magnus**. Start from a drag-free ballistic guess for the given flight time; if `apex` is given, take the flight time from the apex instead; with neither, use 1.0 s. Then run secant/Newton iterations (≤ 10) on the landing error in x and z (and on the apex when one is requested). `ok` means the landing is within 5 cm. `netClearance` is reported. Tests: solve 20 random shots from the near and far sides and assert they land within 5 cm.
- `interceptCandidates` walks the samples on the player's side. It returns reachable contact points, with `travel` as the horizontal distance and `slack = t - travel/maxSpeed - 0.15`. A candidate is reachable when `slack >= 0` and `minHeight <= y <= maxHeight`. Label each candidate `volley` (before the first bounce on that side), `after-bounce`, or `after-wall` (after a wall event that followed the bounce). Sort by preference: after-bounce/after-wall with comfortable height (0.6–1.3 m) first, then volleys.

### 2.5 `history.js`

```js
export function createBallHistory(seconds = SIM.historySeconds, tickRate = SIM.tickRate) // -> { push(ball), at(t) -> BallState|null (interpolated), indexAt(t), rewindTo(t) -> BallState (exact copy at tick <= t), truncateAfter(t), clear(), latest() }
```
This ring buffer of ball snapshots supports lag-compensated hits: rewind to the contact time, apply the impact, then re-simulate forward to the present.

### 2.6 Service boxes

The near receiving boxes cover 0 < z ≤ 6.95. `'right'` and `'left'` are from the receiving player's own view. For a near receiver (facing -z), the right box is x > 0. For a far receiver (facing +z), the right box is x < 0. A serve from the server's right side goes cross-court into the receiver's right box. Lines count as in.

## 3. Rules (`src/rules/`)

### 3.1 `referee.js`: rally legality

```js
export function createReferee({ serving = null /* {team:0|1, box:'right'|'left'} or null for a fed ball */, onOutcome }) // -> Referee
// Referee API:
ref.onHit(team /*0 near,1 far*/, { isServe = false, volley = false })
ref.onEvent(evt) // physics events (§2.2)
ref.canHit(team) // whether that team may legally strike now
ref.state // { lastHitter, phase: 'serve'|'rally'|'dead', bouncesOnSide, wallBeforeBounce, ... }
```
`onOutcome({ winner: team, reason, label, pos })` fires once per rally. Reasons and labels:
- `double-bounce` ("Second bounce")
- `net` ("Net")
- `out` ("Out", wall or fence before the bounce)
- `own-side` ("Own side")
- `serve-fault` ("Fault")
- `double-fault` ("Double fault")
- `volleyed-serve` ("Volleyed the serve")
- `por-tres` ("¡Por tres!", exits over the back wall after a legal bounce)
- `por-cuatro` ("¡Por cuatro!", exits over the side)
- `ceiling` ("Ceiling")
- `winner` ("Winner")

The padel rules:
1. After team T hits, the ball may touch **T's own** glass or mesh before crossing the net.
2. It must then **first bounce on the opponent's floor** before touching any opponent wall, fence or anything outside. Touching the opponent's wall first, or exiting, is a point for the opponent.
3. A bounce on T's own floor after T's hit is a point for the opponent.
4. After the legal bounce, the ball may hit any walls. A second floor bounce, or an exit after the bounce, is a point for T, with labels per above.
5. Mesh after the bounce is legal in a rally.
6. **Serve:** the ball must bounce in the diagonal box. It may then hit glass. Mesh before the second bounce, or a bounce outside the box, is a fault. A net touch that then lands in the box is a let: replay the serve with no fault. Two faults is a double fault. The receiver must let the serve bounce.
7. A rally ending in the net on the hitter's side is a point to the other team.

Write exhaustive tests for every reason.

### 3.2 `scoring.js`: match score

```js
export function createMatch({ gamesPerSet = 6, setsToWin = 1, goldenPoint = true, tiebreakAt = 6, tiebreakTo = 7, firstServer = { team: 0, player: 0 } }) // -> Match
match.pointWonBy(team) // -> { gameWon, setWon, matchWon }
match.display() // -> { points: ['15','40'] | ['AD',''] | tiebreak digits, games: [a,b], sets: [[6,4],...], server: {team,player}, box: 'right'|'left', flags: { goldenPoint, gamePoint: team|null, setPoint, matchPoint, tiebreak } }
match.server() // -> { team, player, box }
match.isOver, match.winner
```
Serving alternates teams every game. Within a team, the two players alternate on that team's turns (A, C, B, D). Each game's first point is served from the right box, then the box alternates. In a tiebreak, the first point is a single serve, then two points per server; the box alternates by point parity within each server's turn. Golden point at 40–40 (*punto de oro*): next point wins. With `goldenPoint` off, use advantage scoring. Test both modes thoroughly.

## 4. Tracking (`src/tracking/`)

### 4.1 Input format (MediaPipe `PoseLandmarker` VIDEO mode)

```js
PoseFrame = { t /*ms, capture time estimate*/, width, height,
  people: [ { landmarks: [33 x {x,y,z,visibility}] /* normalized image coords, unmirrored */,
              world: [33 x {x,y,z,visibility}] /* meters, hip-centered, x→image right, y down, z smaller = closer to camera */ } ] }
```
These are the BlazePose indices used. Nose 0. Eyes: left 2, right 5. Ears: left 7, right 8. Shoulders: 11 (left), 12 (right). Elbows: 13, 14. Wrists: 15, 16. Pinky: 17, 18. Index: 19, 20. Thumb: 21, 22. Hips: 23, 24. Knees: 25, 26. Ankles: 27, 28. Heels: 29, 30. Foot index: 31, 32. "Left" means the *person's* left.

### 4.2 `body.js`: PoseFrame → BodySample

```js
export function createBodyTracker({ hfovDeg, userHeight = PLAYER.defaultHeight, handed = 'right' }) // -> BodyTracker
tracker.update(frame) // -> BodySample | null
tracker.calibrate(sample) // stores neutral room position, standing eye height and body scale
tracker.setOptions({ hfovDeg, userHeight, handed })
tracker.calibration // { x0, d0, eyeHeight, scale, ok }
export function selectPerson(frame, prevSample) // index of the person to follow: closest hip center to the previous one, otherwise the largest/most central body
export function roomPosition(landmarks, world, hfovDeg, aspect, scale) // -> { x, d } meters (x = user's right, d = distance from camera)
export function toUserFrame(world, scale, hipHeight) // -> map of joint name -> Vec3 in U
```
`BodySample = { t, valid, confidence, room: {x, d}, offset: {x, d} /* relative to calibration, meters */, hipHeight, eyeHeight, crouch /*0..1*/, joints: { nose, eyeL, eyeR, earL, earR, shoulderL, shoulderR, elbowL, elbowR, wristL, wristR, indexL, indexR, pinkyL, pinkyR, thumbL, thumbR, hipL, hipR, kneeL, kneeR, ankleL, ankleR } /* Vec3 in U */, handFrames: { L: HandFrame, R: HandFrame }, dominant: 'L'|'R', jump: boolean }`

`HandFrame = { grip: Vec3, axis: Vec3, normal: Vec3 }`, all in U:
- `grip`: the wrist→(index+pinky)/2 midpoint, extended by `TRACKING.handOffsetGrip`.
- `axis`: the racket handle direction, the normalized hand direction (wrist→knuckle midpoint) tilted 20° toward the forearm direction for stability, then rotated 15° "up" (radial deviation in a continental grip).
- `normal`: the palm normal `normalize((index - wrist) × (pinky - wrist))`. The sign is set so that for the **right** hand the forehand face normal points away from the palm's thumb side. Choose a consistent convention, document it, and test it with synthetic frames. Then make it orthogonal to `axis`.

**Distance estimate:** for segments (shoulders, hips, left torso, right torso, left thigh, right thigh), take the ratio of the world length projected to x and y (meters, × scale) over the image length (normalized by width, with y scaled by height/width). Then `d_i = f_n * ratio` with `f_n = 0.5 / tan(hfov/2)`. Use the visibility-weighted median, and smooth with `OneEuro(0.6, 0.3)`. **Lateral:** `x = -(u_hip - 0.5) * d / f_n`, smoothed with `OneEuro(1.2, 0.8)`. Joints use `OneEuro3(2.0, 1.5)` normally. Wrists, index, pinky and thumb use a more responsive `OneEuro3(4.0, 8.0)`, because swings must not be smeared.

**Scale:** `scale = userHeight / modelHeight`, where `modelHeight` is the world-landmark nose→mid-ankle height + 0.11 m, taken during calibration.

**Crouch:** `1 - hipHeight/hipHeightCalibrated`, clamped to 0..1. **Jump:** hip y velocity > 1.2 m/s upward.

Tests: build frames with `synthetic.js` for a known user at a known position and check that `room` comes back within 10% and the joints within 3 cm.

**Side-on robustness** (`ROBUST`, round 3: the first real player saw a black screen when turning side-on). Before any filter, landmarks are sanitised:
- non-finite or out-of-range landmarks (|world| ≥ 2.5, |image − 0.5| ≥ 2.5) are held at the last accepted value with visibility 0;
- left/right label swaps are undone per group (face, arms, legs) when the swapped assignment fits the previous frame at least 2× better (`groupSwapped`), and by the facing-camera prior (`frontalSwapped`);
- single-frame jumps beyond 0.45 m (body) / 1.5 m (hands) in world, or 0.3 / 0.9 in the image, are held for up to 2 frames;
- a landmark further from its parent joint than any body allows (`BONES`) is held or pulled in.

Torso yaw is `torsoYawDeg(world)`; with |yaw| > 55° the shoulder and hip widths leave the distance median (`estimateDistance(..., { sideOn })`). Room x and d reject jumps above 0.3 m + 3 m/s·dt for up to 2 frames. Arm landmarks hidden inside the picture are followed with `landmarkTrust` (down to `OCCLUDED_TRUST` = 0.25 of the smoothing factor). `computeHandFrame(side, w, i, p, t, e, out, { prevNormal, palmVis, handLength })` falls back to the forearm direction and the previous palm direction when the palm is degenerate (`HAND_DEGENERATE`), and sets `out.degenerate`. Filters never ingest non-finite values. A sample that would be non-finite is not returned (null). BodySample gains `yawDeg` and `sideOn`; `tracker.stats` = { frames, dropped, rejectedLandmarks, spikes, swaps, frontalSwaps, degenerateHands, roomHeld, sideOnFrames, nonFinite }.

**Close mode** (round 4: the first real player stood very far back because calibration wanted head to ankles; a MacBook camera at 1.3–2.2 m sees only the head, shoulders and arms). The tracker picks the estimator every frame (`CLOSE`):
- Legs are usable when hips, knees and ankles have visibility ≥ 0.5 inside the picture. The mode switches to `'full'` after 0.35 s of usable legs and back to `'upper'` after 0.15 s without; frame gaps count at most 67 ms; the two estimates crossfade over 0.45 s.
- Upper-body distance comes from shoulder width, ear–eye spacing and shoulder→hip length, weighted by visibility and foreshortening, with minimum lengths of 0.04 m (world) and 0.012 (image); the torso and shoulder ratios (0.3328 / 0.2377 of the height) are learnt online while the legs are visible. Lateral position from the shoulder centre (the hip centre when the legs are visible); crouch and jump from head and shoulder height with distance compensation.
- A camera-pitch estimator (`TILT`) learns the tilt from the standing envelope; `setUpright(on)` gates its updates (off while a ball is played). Calibration succeeds from the upper body alone (`calibration.mode` 'upper' | 'full'); `DISTANCE_RANGES` = { upper: [1.3, 2.2], full: [2.2, 3.5] }.
- BodySample gains `trackMode` ('full' | 'upper'), `modeBlend`, `legsVisible`, `upperVisible`, `camHeight`, `tiltDeg`, `handVis`. Tracker API: `mode`, `tilt` ({ deg, confidence, locked }), `setTilt(deg, { lock })`, `setUpright(on)`, `setCalibrating(on)`, `refreshCamHeight()`; `stats` adds `upperFrames`, `modeSwitches`, `armRebuilt`.

**Round 5 (QA r5).** *Tilt in calibration* (`TILT_CAL`): while the calibration screen is open (`setCalibrating(true)`, main.js on the `calibrate` screen) the estimator runs fast and learns from the play-area steps (at least 3 standing samples over a 0.15 m depth span, full confidence at 0.3 m; frames moving faster than 0.12 m/s in depth are skipped). Its result is kept in play unless a wider depth span is seen; a manual tilt (Settings → Camera tilt, `setTilt(deg, { lock: true })`) is locked. A MacBook-like camera at 0.95 m pitched 10° up now reads 8.3–9.5° and its height within 3–6 cm (was 7.9° / 1.21 m). *Arms beyond the frame* (`ARM_OUT`, close mode): an elbow / wrist / hand landmark clamped at the image edge (within 0.004) with visibility below 0.5 is rebuilt from the shoulder → elbow chain in the torso frame (`rebuildArms`) with the last trusted segment directions, for up to 1.5 s. The synthetic camera models it (`armOut: { mode: 'drift' | 'clamp' }`). Overhead drills from 1.7 m with clamped arms: bandeja 80 → 96 %, smash 83 → 97 %. `app/tracking.js createFrameWatch({ handsTop })` hints *Hands leave the top of the picture* after 2 episodes in 40 s.

### 4.3 `racketTrack.js`

```js
export function createRacketTrack({ capacity = 240 }) // -> RacketTrack
track.push(t /*seconds, capture-time in sim clock*/, pose /*RacketPose in COURT frame without vel*/) // computes vel at the sweet spot by central/backward differences of the sweet-spot position
track.sample(t, out) // -> RacketPose at time t: Hermite on the sweet spot, normalized lerp on axis and normal; clamps to the ends
track.segmentsSince(t) // -> [[poseA, poseB], ...] consecutive pairs with poseB.t > t
track.peakSpeed(t0, t1)
track.latest()
// Display / prediction helpers (predictive hitting, §5.1):
export function rotateAboutAxis(v, axis /*unit*/, angle, out) // Rodrigues; out may alias v
export const EXTRAPOLATE = { damping: 6, maxTravel: 0.35, maxAngle: 1.2 }
export function extrapolatePose(src, E /*s*/, out, { damping, maxTravel, maxAngle }) // rigid screw motion along the swing arc (vel + angVel), both decaying as exp(-damping·t); sweet-spot travel capped at maxTravel, rotation at maxAngle
export function blendRacketPose(a, b, w, out) // sweet-spot lerp, nlerp of axis / normal, lerp of velocities
```

### 4.4 `locomotion.js`

```js
export function createLocomotion(cfg = { gainLateral, gainDepth, deadzone }) // -> Locomotion
loco.setHome({ x, z })
loco.update(sample /*BodySample|null*/, dt, ctx /* { bounds:{xMin,xMax,zMin,zMax}, magnet: {x,z}|null, magnetStrength 0..1 } */) // -> { target: {x,z} }
```
- `target = home + (gainLateral * dz(offset.x), gainDepth * dz(offset.d))`, where `dz` applies the deadzone with a soft knee. Stepping **toward the TV** (offset.d < 0) moves the player **toward the net** (court z decreases).
- The magnet shifts the target toward the magnet point by `min(dist, 1.2 m) * magnetStrength`.
- Clamp to `bounds`: the court half, inset by `ENCLOSURE_MARGIN` (0.6 m off the back glass, 0.45 m off the side glass: `defaultBounds()` gives |x| ≤ 4.55, z ≤ 9.4), with z ≥ `PLAYER.netKeepOut`. (QA2 revision: the old `PLAYER.bodyRadius` inset pinned players against the glass with the racket swinging through it.)
- With no sample, keep the last target.
- Unit tests cover mapping, deadzone, clamping and magnet.

- **Close-range boost** (round 4): `closeRangeBoost(d0)` = (2.6 / d0)^0.75, clamped to [1, 1.45], applied to both gains when the calibration was made in close mode (`loco.setBoost({ lateral, depth })`; `loco.gains()` gives the effective gains; `config.boost`), so a smaller room still covers the court.

### 4.5 `swing.js`: stroke analysis

```js
export function classifyStroke({ contactU /* contact point in user frame U */, racketVelU, handed, ballBounced, ballAfterWall, playerZ, isServe }) // -> 'forehand'|'backhand'|'volley-fh'|'volley-bh'|'bandeja'|'vibora'|'smash'|'lob'|'chiquita'|'serve'|'glass-fh'|'glass-bh'
export function contactQuality({ contactU, handed, stroke }) // -> { front /*m in front of hips (+ = toward net)*/, side /*m to dominant side*/, height, timing: 'early'|'good'|'late', spacing: 'cramped'|'good'|'stretched', score 0..1 }
export function createSwingDetector({ threshold }) // fed racket speeds; emits { tStart, tPeak, peakSpeed, prepTime } for analytics
```
- Above-shoulder contact (y > 1.7 m for a 1.75 m player, scaled) is overhead: `smash` if the racket speed is > 17 m/s and steeply downward; `vibora` if strong sideways velocity with the face open; otherwise `bandeja`.
- `lob`: the racket path rises > 35°. `classifyStroke({ ..., noLob: true })` skips this rule. After the impact the label is corrected from the ball that left the racket: `relabelByTrajectory(stroke, { apex, launchDeg, speed }, groundStroke)` returns `'lob'` for a free-flight apex above 4 m, or a launch above 25° at ≤ 70 km/h, and the groundstroke label (`groundStroke`, from `noLob: true`) for a fast flat ball the racket path called a lob. Within narrow bands around the thresholds (`LOB_TRAJECTORY`) the racket-path rule decides. Overheads and serves are never relabelled. The assist's intended shot (`world.js intendedShot`) is chosen with the same rule applied to the physical outgoing ball (before the blend), so a flat drive from a rising racket path is never blended toward a lob.
- `chiquita`: racket speed < 8 m/s and low contact.
- `volley-*`: contact before the bounce.
- `glass-*`: after a wall rebound.
- `serve`: when `isServe`.
- **Ideal contact** for groundstrokes: 0.25–0.75 m in front of the hip line, 0.5–0.9 m to the side, 0.6–1.3 m high. Earlier is `early`, later is `late`.

### 4.6 `synthetic.js`: synthetic MediaPipe frames

```js
export function createSyntheticCamera({ hfovDeg, width = 1280, height = 720 })
cam.frame(t, bodies /* [SyntheticBody] */) // -> PoseFrame  (projects 3D joints to normalized landmarks with a pinhole model; world landmarks hip-centred in MediaPipe axes)
export function standingBody({ height = 1.75, room = {x:0, d:2.6}, handed = 'right' }) // -> SyntheticBody { joints in U + room }
export function poseArm(body, side /*'L'|'R'*/, { shoulderAngles, elbowFlex, wristRot }) // forward-kinematics helper
export function setHandTarget(body, side, gripTargetU, axisU, normalU) // simple 2-bone IK so the grip lands on a target in U with the requested racket orientation
```
This must be the exact inverse of `body.js`, so that `body.update(cam.frame(...))` recovers the synthetic joints, room position and hand frames.

Round 4: `createSyntheticCamera({ hfovDeg, cameraHeight, crop, blur, pitchDeg, worldFrame })`: `crop` produces MediaPipe-style guesses for body parts below the picture (low visibility, plausible but wrong legs), `blur` motion-blurred / lagging wrists on fast swings, `pitchDeg` a camera tilted up (MacBook lid; world landmarks in the camera frame unless `worldFrame: 'gravity'`); `cam.stats` = { blurred, cropped }.

### 4.7 `autopilot.js`: the virtual player (tests and attract mode)

```js
export function createAutopilot({ handed = 'right', skill = 0.9, rng })
ap.update(world, simTime) // -> SyntheticBody for the synthetic camera at this time
```
The autopilot reads `world.ball` and `predict()`. It picks an intercept on the near side and moves its room position so that locomotion takes the avatar there. It inverts the gains: room offset = (court target − home) / gain. It schedules a swing so that the racket sweet spot passes through the predicted ball position at contact time **+ `world.settings.latency`**, because the game rewinds by that latency. Swing paths:
- groundstroke: a back-to-front horizontal arc with a slight upward lift
- volley: a short punch
- overhead: a high downward arc

Its goal is to return ≥ 70% of machine feeds in the forehand drill with assist `club`. The smoke test relies on this.

**Human-like profile** (round 3): `ap.setProfile(name = 'precise', { seed, overrides })` switches between the precise player (default; tests, attract mode) and `'human'` = `HUMAN_PROFILE` (optionally overridden per field), which plays like a person: timing error N(+20 ms, σ 90 ms) clamped to ±0.4 s, racket position error σ (0.17, 0.14, 0.14) m, swing speeds by stroke (forehand 8–16 m/s, backhand 8–15, volleys 5–9, overheads 8–14, smash 15–24, serve 8–12, touch 4.5–8), only part of the steps (30% none, otherwise 0–50% of the way, ±0.18 m), 5% of balls with no swing, and a 0.18–0.32 s reaction delay. It uses its own rng, so the precise stream is unchanged. `app/game.js installRealisticFeed(feed, { delivery, jitter, noise, fps = 30 })` replaces the feed's delivery with a webcam-like one: 30 fps capture, each result `delivery + U(0, jitter)` s later (in order), landmark noise `WEBCAM_NOISE × noise` (1 = a MacBook camera at 2.5 m). `createGame({ apProfile, apJitter, apNoise })` and the URL flags `?approfile=human&apjitter=0.02&apnoise=1` use them.

**Close-mode feed** (round 4): `createAutopilot({ ..., envelope })` with `CLOSE_ENVELOPE` keeps the virtual player inside the smaller room of a close camera; `ap.racketTruth` is the true racket pose (measurement). `app/closeFeed.js installCloseFeed(feed, { handed, height, hfovDeg, seed, delivery, jitter, noise, profile, distance = 1.7, cameraHeight = 1.25, pitchDeg = 0, blur })` replaces a feed's player and camera with a close-mode one (legs out of the picture), 30 fps with the realistic delivery; `createGame({ apClose })` / `?apclose=1` use it (before the calibration stand-still).

### 4.8 `camera.js` and `pose.js` (browser)

```js
// camera.js
export async function listCameras() // -> [{deviceId, label, kind:'builtin'|'continuity'|'usb'|'unknown', presetKey}]
export async function openCamera({ deviceId, width = 1280, height = 720, fps = 60 }) // -> { video: HTMLVideoElement, stream, settings: {width,height,frameRate}, stop() }
// pose.js
export async function createPoseTracker({ video, model = 'full', numPoses = 1, onFrame /* (PoseFrame) */, onStatus })
tracker.start(); tracker.stop(); tracker.stats // { fps, inferMs, latencyMs }
```
- `openCamera` prefers the requested fps and falls back gracefully. It maps labels: "FaceTime"/"MacBook" → `macbook-builtin`, "iPhone" → `iphone-continuity`, anything else → `usb-webcam`.
- `pose.js` loads `FilesetResolver.forVisionTasks('./vendor/mediapipe/wasm')` and `PoseLandmarker.createFromOptions` with `delegate: 'GPU'`, falling back to CPU on error. It uses `runningMode: 'VIDEO'` and drives from `video.requestVideoFrameCallback`. Use `metadata.captureTime` when present, else `expectedDisplayTime - 1000/fps` minus the camera preset's `captureOffsetMs` (sensor exposure + transfer; `TRACKING.cameraPresets[*].captureOffsetMs`: built-in 50, Continuity / ultrawide 120, USB 70). The pure `estimateCaptureTime({ perfNow, now, md, fps, offsetMs }) -> { t, real }` does this. `tracker.stats` adds `needsLatencyTest` (true after 5 frames without a capture time: the calibration then marks the latency step *recommended*) and `captureOffsetMs`; `tracker.setCaptureOffset(ms)`. Then call `detectForVideo(video, ts)`. Report `onStatus({ phase: 'loading'|'ready'|'error', message })`.

## 5. Game (`src/game/`)

### 5.1 `world.js`

```js
export function createWorld({ settings, rng = createRng(1) }) // -> World
World = {
  time: 0, rng, court, bus /* createBus() */, settings,
  ball: BallState | null,       // single live ball
  ballHistory,                  // §2.5
  ballEvents: [],               // events produced this tick (cleared by step)
  player: Player,               // first-person human
  coach: Coach | null, machine: Machine | null, ai: [],  // AI actors
  mode: ModeController | null,
  referee: Referee | null,
  shots: [],                    // ShotRecord log for this session
}
Player = { pos: Vec3 /*feet, court*/, vel: Vec3, home: {x,z}, height, handed, eye: Vec3, body: BodySample|null,
           bodyCourt: { joints in COURT frame } | null, racket: RacketPose|null, lastHitAt: -Infinity, team: 0 }
export function stepWorld(world, dt) // one fixed tick: actors -> ball physics -> events to bus/referee/mode -> AI hits -> history.push
export function launchBall(world, { pos, vel, spin, by /* 'machine'|'coach'|'ai'|'player' */ }) // replaces ball, resets history, emits 'ball:launch'
export function applyPlayerHit(world, contact, poseAtContact, contactTime) // rewind to contactTime, impact, assist blend, resimulate to world.time; emits 'ball:hit' with ShotRecord; returns ShotRecord
// Predictive hitting (revision; settings.hitPrediction, default true):
export function mayStrikeSpeculatively(world, t) // live incoming ball, no pending prediction, cooldown and rules allow a player contact at t
export function applySpeculativeHit(world, contact, poseAtContact, t, extra) // strikes a COPY of the ball (same impact, intent blend, net safety) and flies it to now; sets world.spec; emits 'ball:hit' { shot: { ...ShotRecord, provisional: true } } on the bus only
export function revertSpeculative(world, reason = 'whiff') // undoes world.spec; emits 'ball:unhit' { shot, reason }
export function viewBall(world) // the ball to draw: world.spec.ball while a prediction is pending, else world.ball
export function emitView(world, type, payload) // presentation-only bus emit (never forwarded to the mode)
export function detectionDelay(world) // settings.latency + measured pipeline delay + 2 camera frames
```
- **Predictive hitting.** The camera sees a swing ~0.25 s late on a Mac + TV. `src/game/swingPredict.js` (driven by `human.afterStep`) completes the swing the tracked racket has started toward the contact the player is going for (`CONTACT_OFFSETS`, drill hints), and the shown racket is swept against the shown ball every tick. On contact, `applySpeculativeHit` plays the strike at once. The authoritative `world.ball`, its history and the judge stay on the unhit path; the lag-compensated detector then confirms the hit (the confirming `ShotRecord` carries `shot.confirms` = the provisional shot id, and the shown ball blends onto the real path) or, with no contact by 0.1 s past the predicted one, `revertSpeculative` undoes it.
- **World fields added:** `spec` (pending prediction `{ ball, shot, t, ballId, ... }` or null), `viewCorrection { seq, kind: 'strike'|'confirm'|'revert'|'late', ballId, contactT, at, contact }` (the renderer's cue for discontinuities of the shown ball), `held` (bus events of the incoming ball near the player held for at most the judge margin and dropped if a hit erases them), `specStats { strikes, confirmed, reverted, cancelled, lateOnly, heldDropped, dirDiffDeg[], dtContact[] }`, and `player.renderRacket` (the racket to draw this frame).
- **Bus contract additions:** `ball:hit` with `shot.provisional` is presentation only: it never reaches `mode.onBus`, `world.shots`, the judge or session stats; listeners that count hits filter `!shot.provisional`. A confirming hit carries `shot.confirms`; audio and effects already played at the strike, so they skip it (`app/wiring.js` binds audio through a filtered bus). `ball:unhit { shot, reason }` cancels a provisional shot. Events of the shown (speculatively struck) ball carry `evt.speculative`.
- **Timing hitting** (round 3, `src/game/swingAssist.js`; `config.ASSIST[level].mode` = `'timing'` for Club and Rookie, `'physical'` for Pro, with `ASSIST[level].timing = { early, late, reach, minSpeed, position }`: Club 0.20 / 0.22 s, 0.75 m, 4 m/s, 0.75; Rookie 0.32 / 0.35 s, any reach, 3 m/s, 1.0). `timingConfig(world)` gives the active window, or null for physical hitting (`settings.hitMode` 'physical', Pro on 'auto', or mouse input: `world.input === 'fallback'`). For each playable incoming ball `planTiming` sets the plan `world.timing.plan` = { key, tStar, pStar, family, glass, wallT, closed, … }: the ideal contact moment t* and point p* (§5.4b rules) and the stance; `autoTarget(world, own, dt)` glides the player toward the stance (critically damped; weight `position`: Rookie all the way, Club 75%, own steps add; never deeper than 9.2 m). A swing (`createSwingWatch`: the racket's sweet-spot velocity relative to the body, above `minSpeedFor(world, cfg, P)` = minSpeed × 0.6 for volleys / chiquitas, × 0.75 for serves, raised over the camera's jitter, with a minimum travel and a preparation check) whose peak, mapped to ball time, falls in [t* − early, t* + late] within `reach` of the ball is a hit at t_c = t* + 0.35·e: the ball where it really is then, pace from the swing speed, direction from the timing error (20% blended with the swing direction), spin from the swing path, quality from timing and spacing, then normal flight and net safety. It runs inside the predictive pipeline: the predicted strike at t* (display racket magnetised onto the contact for 120 ms) is confirmed through `applyPlayerHit` or reverted. `contact.timing` and `shot.timingHit = { e, dist, speed, … }` carry the evaluation.
- **World fields added (round 3):** `world.input` ('camera' | 'autopilot' | 'fallback'), `world.timing = createTimingState()` ({ plan, auto, decided, lastSwing, lastMiss, swings[≤40], log: { plans, hits, misses, strikes, reverted, noStrike: { tracking, prep, early } }, byMode, hold, learned, cue, flight, timeScale }).
- **Judge hold** `judgeHoldOf(world, untilClosed = false)`: rulings after the earliest possible contact wait until the swing is decided or the miss reason is known, with a failsafe at t* + late + 1.2 s. Presentation events (sounds, glass marks) after the earliest contact are held until the window closes (`untilClosed`), only while pose frames arrive (`human.lastFrameAt`); events older than 0.35 s are dropped.
- **Learning slow motion** (`learningSlowmoOn(settings)`: 'on' / 'off' / 'auto' = Rookie): `world.timing.timeScale` eases to 0.7 around a glass contact; the app clock runs at speed × `game.timeScale()` (§10 `clock.setRate`).
- **Miss reasons:** every playable ball not hit is reported once by `reportMiss` → `world.timing.lastMiss` and the bus event `'player:miss' { reason: 'no-swing'|'early'|'late'|'below'|'above'|'too-far'|'too-close'|'behind'|'in-front'|'rules'|'out-of-reach'|'tracking'|'late-detect', ms, cm, step, rule, speed, text, es, tStar, family, glass }` (`missText` gives the EN / ES text). Coaching cues of glass balls: `'timing:cue' { kind: 'glass'|'now-voice'|'tick'|'now', t, text?, es? }` (presentation only; 'tick' also on every ball with `settings.timingTick`). `reachRing(world)` → { progress, green (|now − t*| ≤ 60 ms), inWindow, after, fade, tStar, pStar } | null for the renderer.

- **Smooth swings** (round 4, `src/game/swingView.js`, driven by `human.afterStep`): `player.renderRacket` is drawn every tick from the camera's racket track — the render anchor sits 0.6 frame behind the newest pose, extrapolation ≤ 50 ms, a lead along the arc about the hitting shoulder soft-capped at 0.35 m / 1.1 rad, the predictor's planned stroke blended in with its own weight. Jumps between camera poses are absorbed by a critically damped offset (8 rad/s at rest, 40 in a swing). Follow-through: after a planned or timing strike, or a blurred / stale camera pose (judged against the swing's speed trend), the racket coasts along its arc (decay 2.5/s, sweep ≤ 2.6 rad) and hands back once the camera has shown the real swing. Arm joints are carried forward ≤ 50 ms and smoothed. `'player:swing' { t, phase: 'start'|'peak'|'end', speed (m/s, sweet spot, body-relative), pos }` events come from the drawn racket (`emitView`); no events for 0.4 s after a reset (session start / teleport) or a snap. Hits never read the drawn racket. `swingAssist.stampFromShown` draws the strike frame from the shown racket turned 35% toward the striking face.
- **Timing hitting, round 4:** a fast take-back (the racket dropping, or going back to the hitting side, while moving toward the net < 0.5 m/s: `isBackswing`, `TIMING.backswing` drop 0.6 / side 0.6) is not a swing for groundstrokes and volleys (overheads unfiltered); a too-short swing candidate leaves the detection armed; `TIMING.lobPathPace` = 20 (a fast steep swing is a topspin drive, not a lob); drive / glass / volley flights that would read as lobs (`DRIVE_FLIGHT`, `lobLike`) are struck up to 10% harder. The equipped racket (`physics/racket.js racketProfile().timing` = { pace, scatter, window, spin }) scales the pace, the landing scatter, the spin and the timing-quality window (and the 'good' band) of timing hits.

- **Timing hitting, round 6** (second real session: MacBook Air camera, close mode at 1.23 m, Rookie; misses mostly 0.34–0.82 s early, webcam swing speeds 2–12 m/s):
  - **Contact out in front.** Timing plans put the ideal contact p* at `human.js TIMING_CONTACT_OFFSETS` (fh 0.56 m, bh 0.58, volleys 0.68, overheads 0.4–0.5 m in front of the hips), so t* is when the ball reaches that point; Pro (physical) keeps `CONTACT_OFFSETS` (hip line). The approach circle (§6.6) and the gaze (§6.8) use this P.tStar / P.pStar as-is.
  - **Personal timing** (`src/game/timingProfile.js`, pure; storage injected): `createTimingProfile({ storage, key })` → { bias, n, addTiming(e), addSwing(kind, speed), effort(kind, speed), range(kind), speedQuantile(kind, q), reset(), summary(), save() }. `bias` = the mode of the main cluster of the last `TIMING_ADAPT.window` (24) timing errors (flat-kernel mean shift ±0.2 s from the median, shrunk by 2 pseudo-samples at 0, clamped ±0.35 s; |e| > 1 s ignored). Stored as JSON under `vibora.timing.v1` = { [cameraPreset]: { e[], v: { ground, volley, overhead, serve }[], at } }. `sharedTimingProfile(storage, key)` (the camera player's, one per key: `app/game.js timingKey(settings)` = cameraPreset; never learned from the autopilot), `resetTimingProfile(storage, key|null)`, `timingProfileSummary(key)`, `tunedText(bias)` → "Timing tuned to you: −0.14 s". `world.timingProfile` (createGame), else `profileOf(world)` makes one per world. `timingBias(world)` = the profile's bias unless `settings.timingAdapt === false`.
  - **Windows** (`config.ASSIST[*].timing` adds `bufferEarly`, `bufferLate`, `minSpeedFloor`): Rookie clean −0.32/+0.35 s, held early to −0.6, late hits to +0.45, floor 1.6 m/s; Club −0.2/+0.22, −0.4, +0.3, floor 1.7. The judge centres them on t* + bias; `windowsAround(cfg, bias)` widens the outer (held / late) limits by |bias| on the side away from it, so tuning never narrows what the default window plays. `windowsOf(cfg)`; `activeHitting({ world, settings, input, profile })` → { mode: 'timing'|'physical', windows, active: { bufferEarly, bufferLate }, bias, text, profile } for diagnostics and Settings, with or without a world.
  - **Held early / late hits:** an early swing (to −bufferEarly) is held and strikes when the ball arrives (quality ×0.75, pace ×0.85, pulled cross-court); a late one (to +bufferLate) still hits (down the line). An early swing at a ball in the air within `TIMING.volleyReach` is played as a volley. A swing whose hand left the picture is reconstructed on re-entry (`TIMING.reentry`). The personal swing threshold is ≤ `TIMING.personal` (0.5) × the player's own p25 swing speed, never below `minSpeedFloor`.
  - **Effort and pace:** `effort` 0..1 = the swing's measured speed against the player's own recent swings of that kind (p10 → 0, p90 → 1, blended with `EFFORT.prior` by 6 pseudo-swings). Pace = lo + (hi − lo)·effort^0.9 from `TIMING.pace` (ground 45–115 km/h, glass 40–100, volley 30–85, bandeja 45–85, víbora 55–100, smash 70–150, lob 40–70, chiquita 25–45, serve 45–85); spin ×(0.6 + 0.6·effort). A strike shown before the swing is seen uses `TIMING.predictedEffort` (0.5); the confirmation carries the real effort. `ShotRecord.effort` (0..1 or null, physical hits too).
  - **Bus:** `'player:hit' { shot, effort, kmh, stroke, provisional, confirms }` (presentation, next to `ball:hit`; a confirmation carries `confirms`).
  - The workout recap groups a stroke's swing peaks over `SWING_COUNT.group` = 1.1 s (`app/game.js`).

Bus event names are the contract with render, audio and UI:
- `ball:launch {ball, by}`
- `ball:hit {shot: ShotRecord}`
- `ball:bounce|ball:wall|ball:net|ball:netcord|ball:exit|ball:ceiling {evt}`
- `rally:outcome {winner, reason, label, pos}`
- `shot:result {shotId, landing, inTarget, points, notes[]}`
- `drill:rep {index, total, points, total points, streak}`
- `drill:end {summary}`
- `coach:cue {text, es, priority}`
- `player:step {pos, speed}`
- `mode:hud {...}` (see §5.6)
- `player:miss {reason, ms, cm, text, es, …}` and `timing:cue {kind, t}` (round 3, above)
- `player:hit {shot, effort, kmh, stroke, provisional, confirms}` (round 6, above)

`ShotRecord = { id, t, by: 'player'|'coach'|'machine'|'ai', stroke, contact: Vec3, contactU: Vec3|null, racketSpeed, speedIn, speedOut, spinRpm:{top,side,total}, offCenter, quality, assist, timing, spacing, netClearance, predictedLanding: Vec3|null, afterBounce, afterWall, effort /* round 6: 0..1 | null */ }`

### 5.2 `machine.js`: ball machine on the far side

```js
export function createMachine({ pos = v3(0, 1.0, -9.2) })
machine.load(program /* Feed[] or generator(i, world) => Feed */, { interval = 3.2, count = 20, startDelay = 1.5 })
machine.update(world, dt) // when due: choose a Feed, solveShot from a launch point on the machine's oscillating head toward feed.target, apply small variance, launchBall
machine.gate // optional (world) => boolean; false holds the next feed (QA revision: drills never feed over a ball the player struck before it is judged; the next feed comes ~1 s after the ruling, the interval is the minimum)
machine.state // { fed, total, nextIn, headYaw, headPitch, feeding }
```
`Feed = { target: {x, z} /* first-bounce point */, speedKmh? , flightTime?, apex?, spinRpm: { top /* + topspin, - backspin */, side }, launchHeight? }`. The launch spin vector comes from the direction: topspin about the horizontal axis perpendicular to the flight direction, sidespin about the vertical axis.

Feeds are never perfectly flat (QA2 revision): machine heads add ±`FEED_SIDE_RPM` (200 rpm) of sidespin taken from `feedJitter(i, salt)` (a deterministic hash of the feed index in [-1, 1], so the drill rng stream that places the feeds is unchanged); both are exported from `drills.js`.

### 5.3 `coach.js`: AI hitting partner (far side)

```js
export function createCoach({ level = 'club' /* 'rookie'|'club'|'pro' */, rng })
coach.update(world, dt) // positioning (ready position ~(0, -7.5)), reads ball with predict+interceptCandidates when ball heads to far side, moves (max 5.5 m/s), triggers hit at contact via solveShot to a chosen target with level-based error, emits ball:hit (by:'coach'); recovers
coach.state // { pos: Vec3, vel, facing, stroke, swingPhase 0..1, swingT, holding: 'ready'|'run'|'swing'|'recover', racket: RacketPose (for rendering) }
```
- **Shot selection:** if the player is at the net (z < 4.5), lob deep 45% of the time or chiquita at the feet 35%. Otherwise drive deep, or to the glass, so the player practices *salida de pared*.
- **Level errors:** `pro` σ 0.25 m, 85–100 km/h. `club` σ 0.5 m, 60–80 km/h. `rookie` σ 0.8 m, 45–60 km/h.
- **Spin variety** (revision): serves are sliced with level-based slice and sidespin of random sign, `export const SERVE_SPIN = { rookie: { slice: [200, 400], side: [300, 600] }, club: { slice: [250, 600], side: [300, 900] }, pro: { slice: [300, 800], side: [500, 1200] } }` (rpm); hand feeds carry ±`FEED_SIDE_RPM` (200 rpm). Near the net (|z| < 4) the Pro coach goes for a *por tres* 40% of the time: 135–150 km/h landing 2.4–3.4 m past the net.
- The coach must respect padel rules: it only hits after the ball has bounced on the far side, or as a volley before the bounce, and it can play off its own glass.

- **Round 4:** `createCoach({ ..., personality, kit, displayName })` (§5.7 personalities); `state.serveAt` is the sim time of a scheduled serve's contact (presentation: the server's ball-bounce routine in render/animation/director.js leads into the swing), null otherwise; `state.mood` = { kind: 'celebrate' | 'dejected', at } after each match point.

### 5.4 `drills.js`

```js
export const DRILLS = [ DrillDef... ]
DrillDef = { id, name, es, skill: 'Groundstrokes'|'Walls'|'Net'|'Overheads'|'Tactics'|'Serve', level: 1..3,
  home: { x, z } /* for right-handed player; mirror x for left-handed when drill.mirrorForLefty */, side: 'right'|'left',
  reps, interval, feeds: (i, rng, ctx) => Feed, targets: [ Zone ], scoring: (shot, result, ctx) => { points, success, notes[] },
  cues: { intro, tips[] }, opponentsAtNet?: boolean }
Zone = { id, label, x0, x1, z0, z1, points, kind: 'land'|'glass-after'|'exit' }
export function scoreShot(drill, shotRecord, outcomeInfo) // -> { points, success, notes }
export function starsFor(drill, totalPoints) // 0..3
```
Drills (realistic padel curriculum; speeds in km/h, z positive = near side):
1. `fh-drive`: "Forehand Drive" / *Derecha*. Home (2.3, 7.8). Feeds land around (2.6±0.6, 5.5–6.5) at 55–70 km/h with light topspin. Targets: deep cross-court (x −5..0, z −9.5..−6.95). Bonus for net clearance < 0.9 m.
2. `bh-drive`: "Backhand Drive" / *Revés*. Home (−2.3, 7.8), mirrored.
3. `back-glass`: "Off the Back Glass" / *Salida de pared*. Deep feeds land at z 7.6–8.6 with pace, so the ball rebounds off the back glass at 0.8–1.6 m. Points only for returns hit after the wall that land deep.
4. `double-wall`: "Corner Exit" / *Doble pared*. Feeds hit the back glass, then the side glass, in the forehand corner.
5. `volleys`: "Net Volleys" / *Voleas*. Home (1.6, 3.2). Flat 50–65 km/h feeds at chest height, alternating sides. Targets deep corners.
6. `bandeja`: "Bandeja". Home (1.6, 4.4). Defensive lobs from the far baseline with apex 6–7 m, landing near z 7.5. Contact must be overhead. Targets deep (z −9.5..−7). Penalize pace above 85 km/h, because the bandeja is about control.
7. `vibora`: "Víbora". The same lobs, slightly shorter. Targets the far side-glass corner (x −5..−3, z −9.5..−6.5). Bonus if the ball hits the side glass after the bounce.
8. `smash-x3`: "Smash Por Tres". Short lobs (apex 5–5.5 m) land near z 4.5. Target the zone between the service line and net (z −6.95..−2.5). +500 for an exit over the back wall after the bounce.
9. `lob-defense`: "Defensive Lob" / *Globo*. `opponentsAtNet`. Feeds drives to the baseline. Target deep (z −9.5..−7.5) with apex > 4.5 m. Hitting the far glass on the full is a fault.
10. `chiquita`: "Chiquita". `opponentsAtNet`. Target soft (< 45 km/h), landing z −4.5..−1.5 with net clearance < 0.5 m.
11. `serve`: "Serve" / *Saque*. Home (2.0, 7.4) behind the service line, right box. The ball is dropped and bounces (auto). Contact must be at or below the hip. Target the diagonal box (x −5..0, z −6.95..0). Bonus for landing within 1 m of the service line, and for "side glass after bounce".
12. `return`: "Return of Serve" / *Resto*. The machine serves underhand from the far right (≈60 km/h) into the near right box. Target cross-court deep, or a lob.
13. `live-mix`: "Live Ball Mix". Random feeds from all of the above.

Glass feeds (round 3) are tuned so the contact after the glass is comfortable: 0.6–1.3 m high and at least 1 m out of the glass (`back-glass`, `double-wall`: "comes off both glasses in the corner"). Each drill carries `ap = { contact: 'ground'|'glass'|'volley'|'overhead'|'serve'|'any', family, shot, aim, speedKmh, top, … }`: the intended stroke, used by the autopilot, the swing predictor and the timing hit (`ap.shot` sets the stroke type and pace range, e.g. 'chiquita' lowers the swing threshold).

Each rep's outcome comes from the ball's subsequent events. Use the referee with the player as the hitter. Notes are human-readable coaching cues, for example: "Contact further in front", "Let it come off the glass", "Get lower for the low ball", "Racket back earlier".

### 5.4b `intercept.js` and `tactics.js`: contact planning near the enclosure (QA2 revision)

```js
// intercept.js (pure)
export const STANCE_Z_MAX = 9.2 // deepest stance a plan may ask for (court z of the feet)
export const GLASS_CLEAR = { ground: 1.1, glass: 1.2, volley: 0.8, side: 0.45 } // min contact distance from the back glass by candidate kind, and from the side glass (m)
export const GLASS_WINDOW = { near: 1.2, far: 2.8, maxHeight: 1.72, minHeight: 0.55 } // salida de pared window off the back glass (heights × height/1.75)
export function stanceBounds() // defaultBounds() with zMax ≤ STANCE_Z_MAX
export function playableCandidates(cands) // interceptCandidates that are not jammed against the back or side glass (order kept)
export function pickGlassContact(cands, height = 1.75) // first after-wall contact in GLASS_WINDOW (nearest waist-to-chest height within 0.25 s), else the first comfortable after-wall one
// tactics.js (pure)
export function planIntercept(world, { maxTime = 3 }) // -> { x, z (stance), t, family, contact } | null
export function createTacticalHome({ netGame }) // gliding home: moves the player's home by the part of the stance beyond their own reach; rally / match follow padel net / back tactics
```
A padel player lets the ball come off the glass: the tactical home (`planIntercept`), the assist magnet (`human.interceptStance`), the autopilot, the contact ghost (`app/aids.js`) and the mouse auto-swing all use these rules, so nothing plans a contact within ~1.1 m of the back glass or a stance deeper than 9.2 m.

### 5.5 `session.js`

```js
export function createSession({ storage /* {getItem,setItem} or null */ })
session.record(shot, result)
session.summary() // -> { shots, byStroke: { stroke: { count, avgSpeedKmh, avgSpinRpm, successRate, avgQuality } }, landings: [{x,z,success}], bestRally, longestStreak, avgReactionMs, prepOnTimeRate, activeSeconds, kcal }
session.bests(drillId) / session.saveBest(drillId, points)
```
**kcal** = MET 7.0 × 70 kg × active hours, scaled by the user's movement. (Active time = time with the ball in play.)

### 5.6 `modes.js`

```js
export function createDrillMode(drill, opts) // ModeController
export function createRallyMode({ level }) // free rally with coach; counts rally length; coach plays a realistic variety
export function createMatchMode({ level, games }) // 2v2: AI partner on near left/right + 2 AI opponents (reuse coach brain), real scoring via scoring.js and referee with serves
ModeController = { id, start(world), update(world, dt), onBus(type, payload, world), hud(world) /* -> HudState */, isFinished(world), summary(world) }
HudState = { title, subtitle, repIndex, repTotal, points, streak, timer, score /* match display or null */, lastShot: { stroke, speedKmh, spinRpm, netClearance, quality, timing, spacing, notes[] } | null, banner: { text, kind } | null, prompt: string|null , rally?: number /* rally / match: current rally length (points and streak are null) */, bestRally?: number, live?: boolean /* set by main: ball in play */,
  miss?: { reason, text, es, ms, cm } | null /* round 3: last miss reason while recent */,
  meter?: { e, early, late, hit, label, at } | null /* timing meter of the last swing */,
  ballIndicator?: { angle } | null /* set by main: hidden while the rear-view mirror shows the ball */ }
```
Drill, rally and match summaries carry `misses: { reason: count }` (the results screen lists them).

### 5.7 Game modes (round 4)

```js
// game/progression.js (pure; storage 'vibora.profile.v1')
export function xpForLevel(L), levelOf(xp) -> { level, into, need, progress }, rankTitle(level)
export const RACKETS /* 5: { id, name, shape: 'teardrop'|'round'|'diamond', color, stats {power, control, sweetSpot, spin} 1..10,
  physics { apparentCOR, corFalloff, minCOR, mu }, timing { pace, scatter, window, spin }, unlock { level } | { trophy } } */
export const OUTFITS /* 6: { id, name, shirt, sleeve, band, shorts, unlock } */
export function xpForSession({ kind, stars, points, won, gamesWon, bestRally, playerHits, score, daily, newBest, activeSeconds, career }) -> { xp, parts[] }
export function createProgress({ storage, now }) -> { data, level, racket, outfit, addXp(n) -> { gained, before, after, levelUps, unlocks },
  awardTrophy(eventId, place 1..4), unlockAchievement(id), equip(kind, id), isUnlocked, isNew, markSeen(), recordSession(stats) -> { streak }, reset() }
// game/career.js (pure; storage 'vibora.career.v1')
export const VENUES, PLAYERS, PAIRS, PARTNERS, EVENTS /* 8: { id, name, tier, venue, level, games, matches: [{ round, pair }] } */
export function matchSpec(eventId, matchIndex, partnerId, { resume, quick }) -> match spec for app/game.js
export function createCareer({ storage, now }) -> { events(), current(), startEvent(id) -> spec|null, saveMidMatch(winners[]),
  recordMatch({ won, score }) -> { eventDone, eventWon, place, nextRound, nextMatch, unlockedEvent }, setPartner(id), abandon(), trophies(), reset() }
// game/coach.js
export const PERSONALITIES // 'all-rounder' | 'lobber' | 'big-hitter' | 'wall-master' | 'net-rusher' | 'chiquita'
export function tunedLevel(level, personality, pace) // level preset × personality × pace
createCoach({ ..., personality, kit, displayName }) // + setPace(k), pace, tuning; state.personality / displayName / kit / mood / serveAt
// game/callouts.js
export function createCallouts({ partner, who, talk, rng }) -> { update(world), onPoint(world, outcome, lastHit, { gameWon }), beforePoint(world, display, server) }
// game/challenges.js (storage 'vibora.arcade.v1')
export const CHALLENGES /* por-tres-party 75 s, glass-breaker 60 s, rally-marathon 90 s (3 lives), volley-wall 60 s */
export function createChallengeMode(id | 'daily:YYYY-MM-DD', { rng, session, daily }) // ModeController + challenge, boardId, targets, timeLeft(world)
export function multiplierFor(combo), isPerfectHit(shot), dailyChallenge(dateKey), dateKey(date), createLeaderboards({ storage, now })
export const GLASS_TARGET // far back glass, 5 panels, 3 lit; hit within the target's radius + 0.1 m after the legal bounce
export function glassTargetRadius(combo) // round 5: 0.95 m at combo 0 down to 0.7 m at combo 8; targets[0] is the aim (`aim: true`)
// game/achievements.js
export const ACHIEVEMENTS // 24 { id, name, es, desc, xp, tier, icon }
export function createAchievementTracker({ has }) -> { onBus(type, payload) -> earned[], onSession(summary, profile, drillCount), onCareer(result) }
// app/replay.js
export function createReplayDirector({ minGap, kinds, perGame }) -> { onBus(type, payload, world), take(world) -> moment|null, pending }
// round 5: kinds add 'smash' (smash / víbora winner); 'long-rally' needs LONG_RALLY = 20 shots and a point the player won;
// perGame: at most one replay per game (matches: { minGap: 45, perGame: true }; rally: { minGap: 120 })
createReplayPlayer(snap, { rate, from, to }) // `to`: end of a highlight clip
// physics/racket.js
export function makeRacketProfile(racket), setRacketProfile(profile|null), racketProfile() // racketImpact uses the active profile's COR / falloff / minCOR / mu; timing hits its timing factors (§5.1)
// render/racket.js
export const RACKET_SHAPES, RACKET_MODELS; buildRacket({ model }); group.userData.setModel(id, color)
// render/glassTargets.js
export function createGlassTargets(scene) -> { set(targets), hit(id, pos), update(dt), clear(), dispose() }
```
- Match mode options: `opponents`, `partner`, `teamNames`, `resume: { points }` (point winners replayed through scoring.js; a match already won ends at once), `callouts`, `title`, `subtitle`. Rally outcomes carry `rallyLength`, `lastBy`, `lastTeam`, `gameWon`, `cleanSheet`, `golden`; each point emits `match:point { points, score }`; actors get `state.mood`.
- Rally and match modes log the player's shots into the session (`createRallyShotLog(session)` in modes.js: a shot is *in* once the other side plays it or the point is won on it, *out* when the point is lost on it), so their results show the stroke table, the landing map and the in-play rate; match results lead with the final score (`scoreline`), points won and the best rally. `session.swing()` ignores peaks above `MAX_SWING_SPEED` (50 m/s: tracking jumps) for the speeds.
- Drill mode options: `quiet`, `gate(world)`, `resolveOnLanding`, `resolveWhen(info, evt)`; `stopFeeding()`, `settled`, `machine`. `shotOutcomeInfo` walls carry `pos`; it returns `landingT`.
- Bus events: `partner:call { text, es, en, who, kind, priority, at }` (text = es), `challenge:score { points, base, mult, perfect, combo, total, label, es, kind }`, `challenge:perfect { streak }`, `challenge:combo { combo, mult }`, `challenge:targets { targets }`, `challenge:target-hit { id, pos, points }`, `challenge:end { summary }`, `timing:perfect { streak }` (presentation, outside the arcade), `match:point`. The app consumes `player:swing` peaks for the workout recap (`session.swing(speed)`; summary `swings, avgSwingKmh, peakSwingKmh, sessionSeconds`) and the audio engine for the whoosh.
- HudState adds `challenge: { id, timeLeft, duration, combo, mult, lives, maxLives, perfectStreak, lastAward, targets, rally }`; `score.names`.
- **Round 5 (QA r5 fixes).**
  - *Adaptive career* (`career.js`): every event has a rival skill (`EVENTS[].skill`, a continuous 0..2 scale: 0 Rookie, 1 Club, 2 Pro; −1 is a beginner preset) and a recommended player level. `career.form` (−0.9..+0.3, `ADAPT`) moves by `gain × (points won share − 0.5)` per match, clamped to −0.3..+0.15 (−0.08 more for a lost match), and offsets the skill (`eventSkill`, capped at 1.45 except in the last two events). `matchSpec` returns `skill`, `partnerSkill` (≥ 1) and `skillLabel`. An event opens after 3 attempts at the one before (`openedByAttempts`); `recordMatch` takes `pointsWon / pointsPlayed` and returns `form`, `formChange`, `unlockedByAttempts`. Progression awards *Tournament played* XP (60 + 20 × tier) for an event lost.
  - *Coach skill* (`coach.js`): `presetForSkill(x)` interpolates the level presets (`COACH_LEVELS` gain `feed`: the share of rookie drives aimed back at the player; rookie `err` 0.065), `tunedLevel(level, personality, pace, skill)`; `createMatchMode({ skill, partnerSkill })`.
  - *Workout recap*: `player:swing` peaks closer than 0.8 s count as one swing (`SWING_COUNT`, app/game.js; `session.swingUpdate(speed)` raises the last swing's speed).
  - *Spacing feedback*: `spacingNote(tm, dom, back, overhead)` in swingAssist.js; timing hits carry `spacingText / spacingTextEs`, shown first on the shot card.
- UI (§8): screens `training`, `career`, `event-intro`, `trophies` (tabs trophies / rackets / outfits / achievements / fitness), `arcade`, `freeplay`; results gain `rewards`, `fitness`, `careerResult` and the arcade layout (`mode: 'challenge'`, `leaderboard`). New UI API: `partnerCall(c)`, `achievement(a)`, `perfect(streak)`, `callout(text, sub, kind)`, `setCalibrationScreen(factory)`, `registerScreen(name, render)`. Handlers: `onStartCareer(eventId)`, `onAbandonEvent()`, `onCareerPartner(id)`, `onStartChallenge(id)`, `onEquip(kind, id)`, `onStartFree({ mode, level, venue, games })`, `onPreviewVenue(venue)`. Settings: `venue`, `umpireLang`, `volumes.crowd`, `callouts`, `autoReplay`, `racketModel`, `outfit` (validated by `app/settings.js`).

## 6. Rendering (`src/render/`, three.js)

All visual decisions aim at **photographic realism**: an indoor premium padel club at night, and (round 4) an outdoor court at golden hour and a pro-tour stadium (§6.3 venues). Use PBR materials, ACES or AgX tone mapping, an environment map from `RoomEnvironment` through PMREM, and soft shadows from the main lights. Everything is procedurally generated.

### 6.1 `scene.js`

```js
export function createRenderer(canvas, { quality = 'high' /* 'ultra'|'high'|'balanced' */ }) // -> { renderer, scene, camera, setQuality(q), resize(w,h), render(dt), composer, stats: {fps, drawCalls}, dynamicResolution: boolean }
```
- Use physically correct lights, `renderer.toneMapping = THREE.ACESFilmicToneMapping`, exposure ~1.0, `outputColorSpace = SRGBColorSpace`, and soft PCF shadows.
- The bloom pass is subtle and only catches the LED panels. Use `OutputPass`.
- Dynamic resolution keeps 60 fps by scaling the pixel ratio between 0.6 and `min(devicePixelRatio, 2)`.
- A finite guard pass (`FINITE_GUARD_SHADER`) after the RenderPass zeroes non-finite pixels (float-bit test), so one NaN fragment cannot be smeared over the picture by the bloom.
- The camera is a PerspectiveCamera (default vertical FOV 70°, near 0.02, far 120). Near 0.02 matters so the hands render.

- **Round 4 chain:** `ScenePass` renders the linear HDR scene into its own MSAA half-float target with a resolved depth texture; the contact AO (`ContactAOPass`, screen-space from depth: ultra 0.85, high 0.7, balanced off) and the NaN guard are folded into that single resolve; the passes after it (subtle bloom that only catches emissive LEDs) are single-sample; `GradedOutputPass` = OutputPass (ACES + sRGB) with the venue grade (`scene.userData.grade` / `gradeVersion`, `applyGradeUniforms(u, grade, aspect)`: lift / gamma / gain, saturation, contrast, warmth, vignette) in the same pass; FXAA on balanced.
- **Shader warm-up:** every scene material, hidden pools included, is compiled in one batch against the scene target on frame 1, again on frames 3 and 30, and after every venue change (no compile hitch during play); the app reports ready after the first rendered frame (§10).

### 6.2 `textures.js`: procedural canvas textures (cached)

```js
export function turfTextures(renderer) // -> { map, normalMap, roughnessMap } blue artificial turf, fibre noise, sand speckle, slight wear patches near the baselines and service boxes, 2048² tiling
export function lineMaskTexture() // white playing lines 5 cm, exact court geometry, drawn on a 2048x4096 canvas covering 10x20 m (or build lines as meshes in environment.js — choose one, keep 5 cm accurate)
export function meshAlphaTexture() // welded square mesh 50x50 mm, 4 mm wire, alpha map
export function ballFeltTexture() // optic yellow felt + white seam curve
export function carbonTexture(), gripTexture(), concreteTexture(), panelTexture(), logoTexture(text)
```

### 6.3 `environment.js`

```js
export function buildEnvironment(scene, renderer, { quality }) // -> { root, glassPanels: [...], meshPanels: [...], net, lights, addBallMark(pos, normal), update(dt), setOpponentsVisible(bool) }
```
- **Court:** turf, lines, and glass panels 2 m wide × 3 m (back) or the side heights, about 12 mm thick. Glass uses `MeshPhysicalMaterial` with transmission 0 + transparent opacity ~0.14, roughness 0.04, `envMapIntensity` 1.5, and slightly visible green-tinted edges (thin edge boxes).
- **Structure:** black powder-coated steel posts every 2 m, and top rails.
- **Mesh panels:** alpha mesh texture, double-sided, alphaTest.
- **Net:** a mesh texture with a white top band, the correct sag, and side posts.
- **Hall:** a dark concrete floor around the court, a perimeter wall with sponsor-free panels (club name "VÍBORA PADEL CLUB" in one spot), a 10 m ceiling with steel trusses, and **LED linear light panels** (emissive). There are 4–8 SpotLights or RectAreaLights over the court (shadows from 2), plus a soft hemisphere fill.
- **Neighbors:** two neighboring courts, built as instanced copies at x = ±13, add depth.
- **Ball marks:** `addBallMark` leaves faint felt marks on glass that fade over 20 s (pooled decals).

**Venues** (round 4, `src/render/venues/*`): `buildEnvironment(scene, renderer, { quality, venue = 'club' })` builds the FIP court kit once (turf, glass, mesh, steel, net, ball marks) and a swappable venue layer — surroundings, lights (≤ 2 shadow-casting), sky / hall, the image-based lighting capture, the colour grade and the crowd:
- `'club'`: the indoor hall (LED fixtures, a lounge bar behind the far court, 12 spectators, floor contact shading).
- `'sunset'`: outdoor golden hour — a physically based sky (`venues/skyModel.js`, `sky.js`: Rayleigh / Mie scattering, ozone, airmass reddening, sun disc), a 9.5° sun with long shadows, glass and mesh shadows through an analytic overlay with sun-size blur (`venues/veil.js`), palms, village and cypress silhouettes, sea with sun glitter, dusty turf, glass water spots, haze, warm grade. One shadow light.
- `'stadium'` ("Víbora Tour Finals"): ~3,300 spectators in one instanced draw call (`render/crowd.js createCrowd`: billboard figures drawn from signed distances, idle sway, applause, cheer, roar, ooh, groan, hush, waves), animated LED boards with original graphics only, camera towers with operators, umpire chair and umpire, 6 ball kids, benches, broadcast lighting.
- API: `env.setVenue(id)` swaps the layer live (a no-op when it is up; the reflection capture reruns, ~0.3 s on a GPU), `env.venue` = `venueMeta(id)` (`venues/meta.js`, pure: `VENUE_IDS`, `DEFAULT_VENUE`, `venueId`, `venueOptions(lang)`; { id, name, es, blurb, kind, acoustics { kind, rt60, wet, predelay, damp, early }, crowd { level, bed, sources }, ambience, exposure, grade }), `env.crowd`, `env.react(kind, level, info)` ('applause' | 'cheer' | 'roar' | 'ooh' | 'groan' | 'wave' | 'hush' | 'murmur'), `env.lights`, `env.sign`; `stage.setVenue(v)` calls it. The court has holes in the venue floor (`floorAround`).
- Realism: turf fibre-grain sheen, sand / dust film, wear and contact shading; glass Fresnel reflections with smudges (finger grease, wipe arcs, felt marks, water spots) that roughen and haze it.
- Round 5 (QA r5): every venue has a shadow-casting light **behind the player** (club: a flood at (0, 6.4, 13.4) on the back wall; stadium: a spot at (0, 8.5, 16.5); sunset: a warm flood at (0, 7, 14.5) next to the sun), so in TV mode the player's full-body shadow falls forward into the picture; the near key light no longer casts (still ≤ 2 shadow lights). Venue teardown (`disposeTree`) disposes lights, so their shadow maps are freed (before: +8 GPU textures per club ↔ stadium cycle; now flat). A venue switch compiles the new layer's programs against a 4×4 half-float target before the reflection capture (`issueCompiles`), and `rearView.warm()` compiles the mirror composite at boot.

### 6.4 `racket.js`

```js
export function buildRacket({ style = 'carbon', color = '#e8572a' }) // -> THREE.Group  (origin = grip point, local frame per RACKET in config: +Y handle->tip, +Z forehand face normal)
```
A realistic padel racket:
- Teardrop/round head (ExtrudeGeometry with bevel), 38 mm profile.
- About 40 drilled holes (Shape holes) in the hitting area.
- An open throat "heart" bridge, and a frame with a carbon texture.
- Face graphics: our own design, a "VÍBORA" wordmark and stripes, never a real brand.
- A handle with a grip-tape spiral texture, a butt cap, and a **wrist cord**.

### 6.5 `fpRig.js`: first-person arms, hands and racket

```js
export function createFirstPersonRig({ handed = 'right', skinTone = '#c58c6a', sleeveColor = '#1d2b4a', racket /* THREE.Group from buildRacket */ }) // -> { root, update(player /*World.player*/, dt, renderOpts), setHanded(h), setSkin(c), racketMesh }
```
- **Joints** come from `player.bodyCourt.joints` (court frame), produced by `main.js` via the U→court mapping. Render the upper arms and forearms as tapered capsules: skin with a short sleeve, wristbands, and sport-shirt sleeves on the upper arms.
- **Hands:** load `assets/hands/{left,right}.glb` with GLTFLoader and give them a skin material. Pose the dominant hand's fingers **curled around the grip** by rotating the phalanx joints (a closed fist with the thumb wrapped) and the off hand relaxed and slightly open. Orient each hand from its HandFrame.
- **Racket:** attach it to the dominant hand so its world transform equals `player.racket` (grip position, +Y = axis, +Z = normal).
- **Fallback:** if the GLB fails to load, use a procedural capsule hand.
- **Extrapolation:** render with the pose extrapolated by `renderOpts.extrapolate` seconds (≤ 0.06) using the racket track velocity to hide latency. Hit detection does not use this. (Revision: live worlds draw `player.renderRacket`, already predicted for the frame by §5.1 predictive hitting, with `extrapolate: 0`; the 0.06 s extrapolation only applies to replay frames. `stage.js` re-solves the elbow so the arm follows the shown racket with the tracked segment lengths.)
- **Near-eye fading** (QA2 revision, `src/render/armFade.js`): arm segments fade per pixel by angular size (solid below 0.12 rad, gone at 0.2 rad), the upper arm is only a 9 cm stub above the elbow that fades as the elbow rises to shoulder height, no sleeve is drawn, and faded limbs cast no shadow. The drawn racket is kept inside the back / side glass with a soft knee (`src/render/viewClamp.js`, visual only).
- **Round 4:** the forearm fades along its length toward the elbow when the elbow is within 0.65 m of the eye (fully at 0.42 m; `ALONG_FADE`), the upper-arm stub with (1 − k)² and also as the view looks down at the body (pitch −27° to −40°, `renderOpts.viewDir`); a racket trail (`racketTrail.js`, `racketTrailMath.js`): a faint additive ribbon behind the head over 0.11 s, opacity 0.32 × a speed ramp 6 → 15 m/s, one draw call only while visible, hidden within 0.3 m of the eye, aged by sim time (`rig.trail`); `rig.setOutfit({ shirt, sleeve, band })` tints the sleeves and both wristbands (game/progression.js OUTFITS).
- **Round 5 cut model** (replaces `ALONG_FADE`; QA r5 saw a translucent "ghost bulb" where the faded forearm met the wristband): limbs are cut, not faded. `ALONG_CUT` cuts the forearm from the elbow end over a 16 cm band once the elbow is within 0.42 m of the eye (all but a 2 cm cap kept up to the wrist cuff); `NEAR_CUT` cuts any limb pixel within 0.2 m of the eye (±9 mm band); the upper-arm stub is shown or hidden as a whole with hysteresis (`stubShown`: on above 0.66 m, off below 0.6 m elbow distance, hidden when the view looks down past −0.34); the drawn forearm is never longer than 1.12× the tracked one. Cut limbs cast no shadow.
- **Racket ghost** (round 5): `swingAssist.contactGhostPose(world, out)` gives the planned contact pose for the last 0.4 s before t* (full from 0.25 s, gone 0.08 s after); `ballView` draws it as one additive cyan outline quad (not in the mirror). Setting `racketGhost` (default on). The gaze dips toward a contact below the shoulders in the last ~0.6 s (`SWING_NOD` 16°, `SWING_YAW` 9°, `gaze.js`) so the racket is on screen in the 50 ms before contact (forehand 14 → 56 %, backhand 21 → 82 % of strikes).
- **Safety** (round 3): racket poses that are not a valid frame (`safeView.frameOk`) are not drawn. Arm segments outside 0.4–1.8× their nominal length (`segmentOk`) are hidden. Segments with a zero axis keep their last orientation. A racket face within 0.58 m and less than 38° from the view axis fades (to 0.3 at 0.32 m) unless the ball is near. With the torso turned more than 45°, arm segments fade by their nearest point (`armFade.sideOnAlpha`: gone within 0.3 m, solid beyond 0.48 m). `rig.stats` = { racketRejected, segmentsHidden }.

### 6.5b `fpBody.js`: the player's own body and shadow (round 4)

```js
export function createFirstPersonBody({ handed, height, kit }) // -> { root, human, update(player, dt, { visible, racket, time, cue, viewDir, camPos }), setKit, setHanded, setHeight, stats, pose }
export function createTrackedPoser(human, { keepBehindEye }) // -> { update(player, dt, { racket, time, cue }), stats, pose }
```
- Torso, shorts, legs and shoes under the camera (a dedicated torso without neck or arms, so the eye is outside the surface; the rig draws forearms and hands). Upper body from `player.bodyCourt` (shoulder line → chest yaw / roll; hips when plausible, else a crouch-dependent lean; wrists / elbows → arms; the shown racket for the racket hand); lower body procedural from the court movement (stepper), split-step on the director's cue, small jumps from `body.jump` — no tracked legs needed (standing close to the TV works).
- The chest is kept ≥ 7 cm behind the eye (VR-style); surfaces within 0.14–0.24 m below the eye dissolve with a screen-space dither; interior faces draw dark (the inside of the shirt). The visible mesh is only drawn while the view looks down (pitch < −17°). The rear-view mirror hides it.
- Full-body shadow: a LOD1 copy (head, arms and all) casts the player's shadow from the key lights (≤ 2 shadow lights unchanged); in the main pass its vertices are clipped, so it costs one empty draw call.
- Kit: the player's outfit (`setKit({ shirt, trim, shorts, shortsTrim, skin })`, main.js `applyOutfit`).
- Instant replay: the stand-in body is posed by `createTrackedPoser` from the recorded upper body (`app/replay.js` records `REPLAY_JOINTS` per frame; `frame.player.bodyCourt = { joints, dominant }`), its racket hand on the recorded racket (the cyan ghost racket).
- `stage.presence` = { humans, humanTriangles, fpBody: { frames, tracked, hipsTracked, splits, visible }, director: { outcomes, hits, splits, fives } }.

### 6.6 `ballView.js`

```js
export function createBallView(scene, { halo, trail, shadows } = {}) // -> { update(ball, dt, alpha), setVisible(b), flash(kind), setHalo(b), bind({ visibility, ring }), setVisibility(mode), ringVisible }
```
The ball uses the felt texture and rotates with `ball.spin`, integrated visually. Add a soft contact shadow, an analytic blob decal projected on the floor (and on glass when close). Add a subtle motion trail ribbon (last ~0.12 s, additive, very faint) and a tiny emissive lift, so it reads against the dark hall on a TV. The optional `halo` setting is a soft sprite for visibility training.

**Round 4:** a felt fuzz shell (alpha rising toward the silhouette, broken into fibres) and, at speed, a motion-blur capsule (the ball swept over a 1/120 s exposure). The drop-line fades out within 0.35–0.8 m (horizontal) of the camera, so a ball overhead never draws it through the eye.

**Visibility** (round 3): `createBallView(scene, { halo, trail, shadows })` adds `bind({ visibility: () => mode, ring: () => reachRing state | null })`, `setVisibility(mode)` and `ringVisible`. `BALL_VISIBILITY` = { realistic, enhanced (default: minimum angular size 0.45°, glow, contact shadow, drop-line to the floor), max (0.8°) }; `ballDisplayScale(d, minDeg)` is the drawn-size factor. The reach ring (yellow, green within ±60 ms of t*) and the contact marker at p* for glass balls are drawn in the player's view only: the ring is hidden for a camera with `camera.userData.isMirror` (the rear-view mirror, §6.10).

**Round 6 (clarity):** `bind({ visibility, ring, ghost, frame })`: `frame(dt)` is called once per rendered frame (app/wiring.js ticks the approach circle's audio cue from it); `ring()` returns the **approach circle** state `render/approach.js approachCue(world, out)` = { key, tau (t* − now), k (0..1, linear in tau), alpha, green, inWindow, perfect, after, glass, tStar, pStar, early, late, bias } or null. The circle is one camera-facing quad (two rings, fixed on-screen line width, no depth test) that appears `APPROACH.lead` = 0.8 s before t* and closes at a constant rate onto the drawn ball's outline exactly at t* (`approachRadius(k, ballFrac)`). White while closing; green only inside `greenWindow(cfg, bias)` = the assist window around t* ∩ the judge's window around t* + bias (so green always means a clean hit and never drifts toward the player's habit); a flash within ±`TIMING.green` (60 ms). `approachTickOn(settings)`: `settings.approachTick` 'auto' (Rookie) | 'on' | 'off' (legacy `timingTick: true` = 'on'); the tick sounds `APPROACH.tickLead` = 0.2 s before t*, glass balls always. **Visibility** moved to the pure `render/ballVisibility.js`: 'enhanced' draws the true size within `ENHANCED_TRUE_SIZE_WITHIN` = 14 m (it used to hold 0.45° out to 8.3 m: the ball stopped shrinking with distance, an early-swing cue) with a soft glow of at least 0.85°; 'max' keeps 0.8°. `swingAssist.reachRing()` is no longer drawn.

### 6.7 `humanoid.js`: coach and AI players (round 4: skinned athletes)

```js
export function createHumanoid({ kit, seed, handed = 'right', height = 1.8, lod = 'auto', racket, racketColor,
  /* legacy */ shirt, shorts, skin, cap, shoe, accent }) // -> { root, update(actorState, dt, ctx?), setHanded(h), setKit(k), setLodFor(camPos), racket, human, animator }
```
- **Body** (`render/humanModel.js`, pure; `render/sdfMesh.js`, pure): an athletic 1.80 m body modelled as signed-distance primitives (muscles as smooth-blended ellipsoids / round cones over a 22-bone skeleton), clothes as hard-unioned shells (shirt grown over the torso and cut at the hem and collar, sleeves, loose shorts), separate finer meshes for head (eye slits, nose, ears), eyes, hands (racket fist / relaxed hand), shoes, 5 hair styles and cap / visor / headband, polygonized once at load with narrow-band surface nets. Each vertex has smooth skin weights (blended across every joint), a kit region, a body part (body / head / arms) and baked SDF ambient occlusion. LOD0 ≈ 45k triangles, LOD1 ≈ 15k.
- **Person** (`render/skinnedHuman.js`): one `SkinnedMesh` per LOD sharing one `MeshPhysicalMaterial` (vertex kit colours; roughness, fabric sheen + knit normal, skin wrap lighting per region from a vertex attribute) → one draw call per person (+1 for the merged actor racket `render/actorRacket.js`). LOD by camera distance (< 8 m LOD0, > 10 m LOD1); near people cast their shadow from a LOD1 copy whose main-pass material clips every vertex. `kitFor(seed, base)` generates skin tone, hair colour and style, headwear, shirt / shorts / shoes and wristbands; role colours (coach orange, partner white, rivals red) and a career player's `state.kit` ({ shirt, shorts, cap, skin, hair }) override; the seed is the role plus the display name (`partner-Lucía`, `rival-Paco`), so a player looks the same in every match; `state.handed` sets the racket hand.
- **Animation** (`render/animation/`): `strokes.js` (pure) — 12 padel strokes as racket paths in the body frame with shoulder / hip turn, crouch, lean, jump (smash) and off hand, sampled with Catmull-Rom by `swingPhase`; `stepper.js` (pure) — foot planting (planted feet never slide; shuffles with the lead foot first and no crossing, gallop at speed, sprint strides, split-step hop, jump); `director.js` (pure) — cues from the world and the bus: split-step landing as the other side strikes, `celebrate` / `frustrate` after `rally:outcome` (1.5 s; a match player's `state.mood` extends it to 2.5 s from the point), partners' high five between points, the server's ball-bounce routine while a serve is awaited (timed to `state.serveAt`); `animator.js` — the pose solver (pelvis, spine twist and lean, look-at, clavicle shrug and reach, two-bone IK arms with the hand on the racket grip, two-bone IK legs onto the stepper's feet). Late-starting swings ease in over 0.2 s.

### 6.8 `fpCamera.js`

```js
export function createFirstPersonCamera(camera, settings, { getXR } = {}) // -> { update(world, dt, dtReal), setFov(deg), mode: 'fp'|'replay'|'orbit', setReplayView(kind), snap(), gaze, rear, headTracking, safety }
```
- **Position:** `player.eye`, which `main.js` computes as player.pos + head offset from tracking + eye height.
- **Base orientation:** looking at the far court, pitch −6°.
- **Gaze assist:** follow the ball with a critically damped yaw/pitch (λ ≈ 6) when `settings.gazeFollow` is on. In 'turn' mode yaw is limited to ±70° while the ball is in front, and to ±30° while it is within 2.5 m (the stroke); 'mirror' and 'fixed' follow 45% of the ball's bearing within ±25° (λ 4). A ball going past the player to the glass follows `settings.glassView`:
  - 'mirror' (default): yaw ≤ ±25° with a gentle follow; the rear-view mirror inset (§6.10) shows balls behind the eye.
  - 'turn': an anticipatory head turn ≤ 75° toward the ball's glass impact. It starts when the ball is < 0.55 s from the eye plane and releases toward the contact from 0.38 s before the glass. The yaw target is low-passed at 7/s (14/s at the stroke) and followed by a critically damped spring (6/s), with a 150°/s cap as a last resort.
  - 'fixed': like mirror, without the inset.

  `gaze.update(..., { glassView })` returns `{ yaw, pitch, phase, rear }`; non-finite ball, eye or contact inputs are ignored. In the last 0.8 s before the predicted contact (tactical home) the view frames that contact up to 17° below centre, never tilting up past a chest-high contact; upward pitch is capped at +25° except while the ball is going out. (QA revision: the player's real body and arms face the TV, so a ±150° view left them aiming 90–130° away from their arms at contact.) The logic lives in the pure `src/render/gaze.js` and is tested against the real drills.
- **Round 6 (ball visible at contact):** the contact framing uses `gaze.js framingContact(world)` = the timing plan's p* at t* (out in front), also for glass returns (stiffer pitch spring). `gaze.update(..., { vHalf })` (fpCamera passes the vertical half-fov): the pitch target keeps a ball ≥ `GAZE.KEEP_MIN_AHEAD` (0.6 m) in front within `GAZE.KEEP_MARGIN` (0.82) of the half-height, with a stiffer spring while that binds (a high ball dropping onto a low contact used to sit above the picture while the view looked at the feet). `fpCam.kick(effort)` (round 6 swing power, `render/viewKick.js`): an effort ≥ 0.85 nudges the pitch up 0.3–0.6°, decaying with τ = 80 ms (not with head tracking); `fpCam.kickDeg`.
- **XR integration** (`stage.app.xr`, set with `stage.setXR(x)`):
  - `x.getHeadQuaternion()` → {x,y,z,w} | null: the head rotation since recenter, in the three.js camera convention (yaw about +Y, pitch about +X).
  - While it returns a quaternion, the view orientation is base·head, with base = body forward (looking −z, level). The gaze assist and the mirror inset are off.
  - `x.fov` (deg, optional) overrides the vertical fov.
  - `x.stereo = { enabled, ipd, render(renderer, scene, camera, composer) }`: when enabled, `stage.render` calls it instead of the composer (the frame-rate stats keep updating; the mirror inset is off).
- **Safety net:** fpCamera never applies a non-finite eye or camera pose (last good pose restored; `fpCam.safety`). `stage.render` hides, for that frame, any visible dynamic mesh whose world matrix is non-finite or singular (`safeView.matrixOk`), and skips non-finite balls. Counters: `stage.safety` = { ballHidden, rigHidden, meshesHidden, framesWithHidden, lastHidden, camera: { eyeRestored, cameraRestored }, rig: { racketRejected, segmentsHidden }, mirrorFrames } (`__vibora.stats.safety`, the `?debug=1` safety line, Copy diagnostics).
- **Comfort:** no roll, and no bob beyond the real head motion.
- **Orbit mode** (menus): a slow cinematic orbit around the court.
- **Replay mode:** broadcast (behind and above the near baseline), side (2.6 m outside the side wall, round 4: clear of the neighbouring court and the stadium stands), and ball-cam views. Entering / leaving a replay and switching its angle are cuts (round 4: the 0.6 s flight from the eye crossed the back wall's mesh). The stage clips the enclosure wall between the replay camera and the court (`setCutaway`); an alpha-to-coverage wire mesh blends while it is clipped (a2c clipping left dotted noise over the court).

### 6.9 `effects.js`

```js
export function createEffects(scene) // -> { bounce(pos, surface, speed, vel?), glassHit(pos, normal, speed), meshHit(pos, normal, speed), netShake(x, speed), racketHit(pos, quality), landingMarker(pos|null), targets(zones|null, highlightId), contactGhost(pos|null), update(dt) }
```
- Round 4: a bounce with its velocity leaves a turf skid mark; `meshHit` shakes and sparks the wire mesh (`app/wiring.js` on `ball:wall` with `surface 'mesh'`); racket contacts add a felt shock ring, glass contacts a specular glint. Pools are preallocated (no per-frame allocation).
- Sand puffs on turf, a glass shimmer ripple, and a net shake (vertex wobble on the net mesh via `environment.net`).
- **Drill target zones:** glowing floor rectangles with labels drawn in canvas textures.
- **Landing marker:** a predicted bounce ring, used in Rookie/Club.
- **Ideal contact ghost:** a soft glowing sphere at the best contact point for the current incoming ball, a training aid toggled in settings.
- **Round 6:** `effects.bindLive(fn | null)` (app/wiring.js: `() => ball live`): while it returns true the 3D zone labels hide and the floor zones dim by 55 %; `setLabelOccluders(rects)` takes `ui.hudRects()`.
- **Racket trail** (`render/racketTrail.js`, drawn by fpRig): `racketTrailMath.js setTrailPower(effort)` (app/wiring.js on the strike's `'player:hit'`) scales the ribbon's opacity and length ×(0.6 + 0.8·effort) for `TRAIL_POWER.hold` = 0.35 s, and an effort above 0.5 shows a ribbon (up to 0.55) even for a slow drawn racket.

### 6.8b Glasses (`src/xr/`, experimental)

VITURE XR glasses (Beast, Luma, Pro, One) plugged into the Mac as a display. `boot.js installGlasses({ stage, settings, storage, uiRoot, toast, search })` (called once by main.js after the stage) → `{ glasses, sim, frame({ playing }), hud(hudState), onSessionStart(), onScreen(name), diagnostics() }`:
- `glasses.js createGlasses()` owns its settings (localStorage `vibora.xr.v1`: `{ enabled: false, profile: 'auto', headTracking: true, stereo: 'off', layout: 'auto', ipdMm: 63, compactHud: true, autoRecenter: true, autoConnect: true, stereoPost: true }`; not in the app settings store, the panel owns the controls) and exposes the stage's `app.xr` object: `getHeadQuaternion()`, `fov` (true-scale profile: 32.7° × 50.3° from the 58° diagonal at 16:10), `stereo`, `eyeOffset` (the true eye position while head tracking), `hud`, `headTracking`. `stage.setXR(glasses.active)` follows every change.
- `viture.js createVitureDriver()`: WebHID (Chrome / Edge; vendor 0x35CA), tries the V2 pose stream (0x7308) then the legacy IMU stream, axis remap + flips (persisted under `vibora.xr.viture.v1`), recentre (yaw / full), prediction ≤ 20 ms, stall and unplug / replug handling, diagnostics.
- `stereo.js`: side-by-side full (3840 × 1200) or half, per-eye cameras ±IPD/2 (63 mm), optional post-processing per eye, shadows rendered once, an in-world HUD drawn per eye (`hudText.js`). Only during play (menus are DOM and cannot be drawn per eye).
- `panel.js` (Settings and Help, mounted by `onScreen`; `data-xr-*` controls the UI's binders ignore), `axis.js` (guided axis test), `display.js` (field of view, layouts), `protocol.js` (packet formats), `quat.js`, `sim.js` (simulated glasses for `?xrsim=1|legacy`), `styles.js` (CSS: `xr-glasses`, `xr-compact`, `xr-stereo` classes on `<html>`).
- Keys: C (no modifiers) or Home recentre while head tracking runs (capture phase, stopped so the UI's C picture-in-picture toggle does not also fire; Shift+C still toggles it; Home is ignored in sliders and text fields). Every drill / rally / match start recentres (`autoRecenter`).
- URL flags: `?glasses=1` (glasses mode for this visit), `?stereo=1`, `?xrsim=1|legacy`.

### 6.10 `rearView.js`: rear-view mirror

`createRearView(app)` → { update(dt, { want, eye, ball }), render(hidden[]), rect(), camera, opacity, visible, stats }. A second camera at the eye looking back (92° horizontal fov, aimed toward the ball), rendered into a half-float target at 0.75× the inset's resolution with no post-processing and the shadow maps reused. Drawn top centre at 30% of the width (`REAR_VIEW` TOP 0.02, WIDTH 0.3, ASPECT 2.4; the HUD's `--rear-view-bottom: calc(2vh + 12.5vw)` in `styles/app.css` must stay in step), rounded, mirrored left/right, with ACES + sRGB applied. Fades in over 0.12 s, holds for at least 0.5 s, fades out over 0.3 s; the hold is released once the returning ball is back at the eye plane (≤ 0.1 m behind the eye, moving toward the net at > 1 m/s) and the inset then fades in 0.15 s, so it is gone at the moment to swing off the glass (the contact is only ~0.25 m in front of the eye). Wanted in the first-person view with `glassView` 'mirror' while the ball is behind the eye, never with head tracking or stereo. The mirror camera has `userData.isMirror = true`. While it is visible the HUD's off-screen ball arrow is hidden.

## 7. Audio (`src/audio/`)

```js
// engine.js
export function createAudio() // -> { unlock(), setListener(pos, forward, up), racket(pos, {speed, quality}), bounce(pos, surface, speed), wall(pos, surface, speed), net(pos, speed), cord(pos), machine(pos), footstep(pos, speed), cheer(level), ui(kind), ambience(on), setVolume({master, sfx, ambience}) }
// voice.js
export function createVoice({ lang = 'en' }) // -> { say(text, { priority, es }), setEnabled(b), setLang(l) }  // speechSynthesis; rate-limited; never overlaps; picks a natural voice
```
- **Physical synthesis**, no samples:
  - Padel racket "pock": a short broadband transient plus two damped resonances (~1.1 kHz and ~2.6 kHz from the foam core). Its brightness follows speed and its dullness follows off-center hits.
  - Turf bounce: a low thud plus sand hiss.
  - Glass: a bright "tonk" plus a low panel boom (~140 Hz) with a 250 ms ring.
  - Mesh: a metallic rattle made of many tiny jittered noise bursts through a bandpass, plus a clang.
  - Net: a soft rustle. Footsteps: gritty sand scuffs.
  - Ball machine: a pneumatic thump.
- **Spatialization:** every one-shot runs through an HRTF `PannerNode` at the event position. The listener sits at the player's eye.
- **Hall reverb:** a ConvolverNode with a generated 1.4 s IR, 15% wet.
- **Ambience:** distant pocks from neighboring courts at random intervals, an HVAC hum, and faint chatter (filtered noise formants).
- `unlock()` must be called from a user gesture (a click or the first detected wave).

**Round 4 audio:**
- **Impacts** (`venueSynth.js`, `dsp.js`, pure): the padel *pock* modelled on the EVA-core racket (brighter at the sweet spot, clackier off the frame), the glass thunk at each panel's own modes (`glassPane(pos)`), mesh rattle, turf bounce. `swing(evt)` plays the racket whoosh from `'player:swing'` (louder with speed, bigger for smashes).
- **Venue acoustics:** `setVenue(meta)` (venues/meta.js `acoustics`) crossfades the reverb (club hall 1.4 s, open air 0.32 s, arena 2.3 s) and swaps the ambience bed (HVAC + chatter + neighbouring courts / sea, breeze and birds / arena murmur); main.js calls it at boot and on every venue change.
- **Crowd:** `crowd(kind, level)` ('applause' | 'cheer' | 'roar' | 'ooh' | 'aah' | 'groan' | 'hush' | 'murmur') from the venue's stand positions, scaled by the venue's crowd level; on the crowd bus, whose gain follows `settings.volumes.crowd` (`setVolume({ crowd })`, 0.7 → 0.8 = `CROWD_TRIM`). `duck(amount)` lowers the crowd and the ambience under speech. `cheer(level)` routes to the crowd outside the club.
- **Crowd director** (`crowdDirector.js`, pure): turns bus events into reactions — hush before a serve, murmur back between points, ooh at a retrieve off the glass or a long rally, aah at a por tres exit, applause for winners, cheer / roar for great points, groan for the player's errors (never in drills); the crowd backs the player's pair, a rival's winner gets polite applause.
- **Voices** (`voice.js`): one priority queue for the coach, the umpire and the players (`SPEAKERS` coach / umpire / partner / opponent / opponent2 / crowd: each its own installed voice, pitch and rate); `say(text, { priority, es, speaker, lang, expireMs, cut })` never overlaps, may cut a lower-priority line, drops stale and duplicate lines; `onSpeaking(fn)`, `setVolume(v)` (follows the master volume), `setCoach(on)` (Settings → Voice coach: off silences the coach only).
- **Umpire** (`umpire.js`): score calls in Spanish or English with padel phrasing (*Quince – nada*, *Iguales. Punto de oro*, *Juego, Víbora. Cuatro juegos a dos*, tie-break numbers, *Falta*, *Let*), an opening call, and the players' `'partner:call'` callouts (quick calls in Spanish, may cut a tip, worthless after 1 s). `createUmpire({ voice, lang, teams, enabled, callouts })` → { onOutcome, open, callout, setLang, setEnabled, setCallouts, bindBus(bus, { isMatch, display }) }.
- **Glue** (`venueAudio.js`): `bindVenue({ world, bus, audio, voice, env, lang, umpire, callouts, quiet, teams })` → { director, umpire, update, unbind } binds the crowd director (stands via `env.react`, sound via `audio.crowd`), the umpire (matches only) and the speech ducking; `app/wiring.js bindWorld` calls it for every session with `settings.umpireLang` ('es' | 'en' | 'off'), `settings.callouts` and, in a career match, the rival pair's name (`ctx.umpireTeams`); main.js applies umpire / callout setting changes to the running binding.

**Round 6 (swing power):** the pock of a player's stroke follows `shot.effort` (`engine.js effortPock(speed, effort)`: gain ×(0.7 + 0.6·effort), a brighter crack above 0.8; the predicted 0.5 of a strike shown before the swing is seen is neutral). The racket whoosh is voiced from the swing's effort, not raw m/s: app/wiring.js maps each `'player:swing'` speed through the player's profile (`whooshSpeed(profile, speed, y)` → 4–24 m/s, `WHOOSH`) before the engine (`measured` keeps the raw speed), so a webcam that measures 2–9 m/s is no longer near-silent.

## 8. UI (`index.html`, `styles/app.css`, `src/ui/`)

A **10-foot TV interface**. It is readable from 3 m: base size `clamp(18px, 1.6vw, 40px)`, with a 5% overscan-safe inset. It is single-theme dark: an indoor club at night. The palette is court blue, glass cyan for structure, and optic ball-yellow used only for live ball, score and "go" moments. Display type is *Big Shoulders Display*; UI and body type is *Barlow Semi Condensed*. Everything works with three inputs:
1. The **hand cursor**: raise a hand, then hover 1.0 s to click, with a radial dwell ring.
2. Keyboard, arrows and Enter (spatial focus navigation).
3. Mouse or trackpad.

```js
// ui/ui.js
export function createUI(root, handlers) // -> UIApi
UIApi = { show(screen, data), hud(HudState), shotCard(ShotRecord & result), banner(text, kind), toast(text), results(summary), setLoading(p, text), setCameraPreview(videoEl|null), setSkeleton(PoseFrame|null), setCursor({x,y,visible,progress}), calibration(status /* + needsLatencyTest */), settings(current), setInstall({ kind: 'prompt'|'chrome'|'safari'|'installed'|'done'|'none', onInstall }), updateReady(onRestart),
  /* round 6 */ bindPlay({ live(), incoming() } | null), hudRects() /* [[x0,y0,x1,y1] 0..1] of visible play-HUD blocks */, feedLine /* the feedback line's message or null */, hudMode /* 'clean'|'standard'|'coach' */ }
handlers = { onStartDrill(id), onStartRally(level), onStartMatch(level), onCalibrate(), onCameraSelect(deviceId, presetKey), onSettings(patch), onPause(), onResume(), onQuit(), onRestart(), onReplay(), onUseFallbackControls(), onScreen?(name, data), onDiagnostics?(), onTimingInfo?() /* { text, n, adapt, mode } */, onResetTiming?() /* round 6 */ }
// ui/cursor.js
export function createHandCursor({ root, ui, onPause, isLive /* () => boolean: ball in play, pause gesture ignored */ }) // -> { update(sample /*BodySample*/, screenRect), click handling: dispatches synthetic click on dwell, setEnabled(b), setLiveGate(fn) }
// ui/charts.js
export function landingMap(canvas, landings, targets) // top-down court heatmap
export function strokeBars(el, byStroke)
```
**Screens:**
- `loading`
- `title`: the live 3D court in orbit mode behind a big "VÍBORA" wordmark, with "Raise a hand or press Enter".
- `camera`: pick the camera and preset, with a live preview and "Continuity Camera tip: mount your iPhone on top of the TV; turn off Center Stage".
- `calibrate` (round 4: `src/ui/calibrate.js`, panels and pure decisions; `dev/calibrate.html` shows the body panel's states):
  1. **In frame** (`CAL_STEPS_CLOSE`): `bodyCheck(status)` accepts the upper body (head + shoulders, close mode 1.3–2.2 m) or the full body (head to ankles, 2.2–3.5 m); the distance meter shows both bands (*Close*, *Full body*) and highlights the mode in use, the legs are dimmed while optional, a "camera at chest height" tip; `updateBodyPanel(scope, status, calib, now)` auto-advances after 1.5 s in the band. The status from main.js carries `visible`, `bodyInFrame`, `upper`, `distance`, `trackMode`, `tiltDeg`, `boost`.
  2. "Stand on your spot" for 2 s (sets neutral; `spotCheck`: in frame, close mode accepted, and still).
  3. Handedness and height.
  4. Optional latency test: swing down on each of 6 flashes; measures the motion-to-display offset.
  5. A play-area check: a step left, right, forward and back with a live readout (`areaReadout(offset, settings, boost)`: court offsets with the boosted gains; `areaStep(mode)`: 0.2 m steps close, 0.3 m full).
- `hub`: drill cards grouped by skill, with stars and bests; Rally with Coach; Match; Settings; Help.
- `drill-intro`: the coaching focus, a picture made of simple court diagrams (canvas), and "Raise your racket to start".
- `play`: the HUD.
  - Top-centre (under the rear-view mirror): the last miss reason and a timing meter (round 3).
  - Top-left: drill name and reps (e.g. "7 / 20").
  - Top-right: points and streak.
  - Bottom-center: the last-shot card with stroke, km/h, rpm, net clearance and timing chips (early/good/late).
  - A small camera PiP with the skeleton (toggle).
  - An off-screen ball indicator arrow when the ball is behind the player.
  - Point banners such as "¡Por tres!".
  - **Round 6 (clean HUD, `settings.hud`: 'clean' (default) | 'standard' | 'coach'; H cycles):** *clean* is a slim top bar (left: tracking dot, mode, reps / score; right: points, streak, clock, lives, multiplier) and ONE feedback line under it (`src/ui/feedback.js createFeedbackQueue`: messages queued by priority and merged by key, ≤ 1.6 s each (banners 1.2 s), stale after 4 s; hidden at once and held while the ball is coming to the player (`bindPlay().incoming()`), except urgent camera warnings; a new hit drops a queued miss of the ball before). Miss reasons (+ hint), the shot (stroke · km/h · power pips from `ShotRecord.effort`, gold ≥ 0.85 · On time / Early / Late / +points chips), coaching notes, achievements, toasts, perfect streaks and point banners all go to it. *standard* adds the shot card between points; *coach* is the round-5 HUD (cards, timing meter, callouts, prompt strip, camera picture). **Central play region** (`src/ui/playRegion.js PLAY_REGION` x 0.15–0.85, y 0.2–1): `guardRegion()` hides, every frame in every layout, any HUD block inside it while `bindPlay().live()`. The camera picture-in-picture is off by default (`pip: false`; saves without a `hud` key are migrated to it) with a tracking dot instead; it shows itself after 1 s of lost tracking and hides 1.5 s after tracking returns. The rear-view mirror is 25 % wide × 2.7 aspect (top 20 %); the off-screen ball arrow sits at the side edges.
- `pause`: raise both hands above your head for 2 s, or press Esc. The gesture is ignored while a ball is live (`createHandCursor({ ..., isLive })`, QA2: overhead preparation held the old 1.5 s gesture).
- `results`: stars, points, a landing map, stroke bars, three coaching tips, and buttons for retry, next drill and hub.
- `settings`:
  - Assist (Pro/Club/Rookie), hitting (`hitMode`: 'auto' | 'timing' | 'physical', labelled Auto / Timing / Contact), predictive hitting (`hitPrediction`), movement gains, field of view, gaze follow, balls behind you (`glassView`: 'mirror' | 'turn' | 'fixed'), latency, off-axis arm correction (`offAxisYaw`, experimental, off).
  - Ball & aids: screen text (`hud`, round 6), ball visibility (`ballVisibility`: 'realistic' | 'enhanced' | 'max'), learning slow motion off the glass (`learningSlowmo`: 'auto' (Rookie) | 'on' | 'off'), timing tick (`approachTick`: 'auto' (Rookie) | 'on' | 'off'; replaces `timingTick`), landing marker, racket ghost, contact ghost, ball halo.
  - Play (round 6): *Adapt timing to me* (`timingAdapt`, default true) and *Your timing*: `handlers.onTimingInfo()` text ("Timing tuned to you: −0.14 s" / learning / off) with **Reset timing** (`handlers.onResetTiming()` → `resetTimingProfile(storage, timingKey(settings))`).
  - VITURE glasses (§6.8b): the glasses panel, mounted by `installGlasses().onScreen`.
  - **Copy diagnostics** (also on Pause, and D on the pause screen): `handlers.onDiagnostics()` returns `app/diagnostics.js buildDiagnostics({ world, settings, tracking: { camera, stats }, calibration, pwa, stats, params, env: browserEnv(), glasses, safety, robust, input, timingProfile })` (round 6: `hitting` = `activeHitting(...)` { mode, windows, active, bias, tuned, adapt, profile } — correct with no game running: a copy from Settings reported 'physical' for a Rookie player) (setup, settings, hitting windows, per-drill hits / misses, the last 40 swings, glasses status, safety-net counters, tracker guards); `copyText` copies it, or a selectable text box opens when the clipboard refuses.
  - Handedness, height, skin tone and racket color.
  - Graphics quality.
  - Voice coach EN/ES, and volumes.
- `help`: how to set up the Mac, TV and camera, and how each stroke is read.

The design tokens live in `:root` in `styles/app.css`. Focus states must be visible. Respect `prefers-reduced-motion`.

## 9. Fallback controls (`src/input/fallback.js`)

```js
export function createFallbackControls({ canvas, handed }) // -> { enabled, update(dt, world) -> { moveTarget: {x,z}|null, racket: RacketPose(court) }, dispose() }
```
- **Mouse/trackpad:** the racket's sweet spot follows the pointer projected onto a vertical plane 0.65 m in front of the player's eyes.
- **Velocity** comes from pointer motion with 3× gain. A fast flick through the ball hits it. The face normal points along the flick direction, and the axis is tilted by the pointer's horizontal position: forehand to the right of the body, backhand to the left.
- **Keys:** WASD/arrows move. Space does an auto-swing toward the ball, an accessibility helper.
- This mode is used by the artifact demo and by testing in browsers without a camera.
- **Aimed auto-swing** (QA2 revision, `FALLBACK.autoAim`, default on): the Space / flick swing plans on the real flight model (`predictCourtPath(ball, court)`), skips contacts within `GLASS_CLEAR` of the back and side glass, aims at the drill's target blended 0.6 toward `intendedShot` with Rookie net safety (`aimedShot(world, c, eye, handed)`), and inverts the racket impact for the face normal and sweet-spot velocity that produce it (`invertImpact(P, vin, spinIn, vDes, { lat })`). `controls.autoPlan` is the active plan (`live` while it swings); a swing under way is never restarted, and `app/game.js` does not re-trigger it from the swing's own racket speed. Keyboard movement uses the same body bounds as camera play (`defaultBounds()`).

## 10. App wiring (`src/main.js`), owned by the integration step

1. Boot: load fonts and settings (localStorage, try/catch).
2. `createRenderer` → environment → rig, ball view, effects and audio → the title screen in orbit mode.
3. Camera setup → `createPoseTracker` → `bodyTracker.update(frame)` → `world.player.body` → `locomotion` → `racketTrack.push` → lag-compensated contact check.
4. **Each new racket segment [A, B] in capture time:** map it to sim times `tA - latency`, `tB - latency`. Sample the ball history at those times. If `sweptContact` hits and `referee.canHit(0)`, and the player hasn't hit in the last 0.25 s, call `applyPlayerHit(world, contact, pose, simTimeOfContact)`.
5. **Fixed-step loop:** `SIM.tickRate`, accumulator, `stepWorld`. Render interpolation, HUD at 10 Hz, audio listener per frame.
6. **URL flags:**
   - `?autopilot=1`: the synthetic camera plus autopilot drive the real pipeline, for the smoke test and attract mode.
   - `?debug=1`: overlays for fps, inference ms, latency and colliders.
   - `?drill=<id>`: jump straight in.
   - `?fallback=1`: mouse controls.
   - `?speed=N` (sim seconds per real second), `?aplatency=` / `?apdelivery=` (the autopilot's display latency and capture-to-result delay), `?mode=rally|match&level=`, `?seed=`, `?attract=0`, `?mute=1`, `?quality=`, `?fov=` / `?pitch=` / `?eyeback=` / `?eyedown=`.
   - `?sw=0`: no service worker. `?source=app`: the installed app's start URL.
   - `?assist=rookie|club|pro` (this visit only), `?approfile=human|precise|user1`, `?apjitter=<s>`, `?apnoise=<k>` (the autopilot plays like a person through a webcam-like feed, §4.7); `?glasses=1`, `?stereo=1`, `?xrsim=1|legacy` (glasses mode, §6.8b).
7. **App packaging:** `initPwa({ ui, isPlaying, onFullscreenExit })` (`src/app/pwa.js`) right after `createUI`: registers `./sw.js` (scope `./`, `updateViaCache: 'none'`), shows *Update ready — Restart* when a new worker waits (Restart sends `SKIP_WAITING`, the page reloads on `controllerchange`), offers *Install Víbora* from `beforeinstallprompt` (Safari: *File → Add to Dock* hint), detects installed display modes (`data-display`, `data-app="installed"` on `<html>`), and toggles full screen with **F** (Keyboard Lock keeps a short Esc for the game; leaving full screen during play pauses). Pure helpers: `displayModeOf`, `browserOf`, `installKindOf`, `isInstalledApp`.
8. **Camera tracking options:** the play HUD's out-of-frame watch is `createFrameWatch({ upperBody: true })` (round 4: only the head and shoulders must be in the picture; a cut-off head reads "Head out of view · step back or raise the camera"; the legs are never asked for).
    `createTracking({ video, onFrame, onStatus, model, cameraPreset, yawCorrection })` (`src/app/tracking.js`); `applySettings` calls `tracking.setCameraPreset(S.cameraPreset)` (capture offset, §4.8) and `tracking.setYawCorrection(S.offAxisYaw)`. `correctOffAxisYaw(frame, hfovDeg)` rotates each person's world landmarks about +y by their bearing `offAxisBearing(frame, hfovDeg)` (experimental, off by default: unverified on real footage). `captureOffsetFor(presetKey)` gives the preset's capture offset.
9. **Test hooks** (`window.__vibora`): `stats` (incl. `speculative`: predictive-hitting counters, `safety`: render safety net, `tracker`: side-on tracker guards, `timeRate`), `freezeOn('contact'|'hit'|'strike', offset)` ('strike': the tick a predicted hit is shown), `freezeAt(t)`, `resume()`, `nextContact()`, `injectPoseFrame(frame)`, `replaySeek(dt)`, `pwa`, `tracking`, `glasses` (glasses diagnostics), `xr` (the `installGlasses` object), `diagnostics()` (the Copy diagnostics object).
10. **Sim clock** (`src/app/clock.js`): `createSimClock({ speed })` → { simTimeOf(ms), now(), pause(), resume(), shift(dSim), setRate(r), rate, speed, running }. `setRate` (learning slow motion: main.js calls `clock.setRate(game.timeScale())` before each frame's advance, 1 for the attract demo and after a session) re-anchors at now(); the anchors of the last ~3 s are kept so a pose frame's capture time maps with the rate of the segment it falls in.
11. **Round 3 wiring:** `createGame({ apProfile, apJitter, apNoise })` from `?approfile=` / `?apjitter=` / `?apnoise=`; results carry `misses`; the 10 Hz HUD block hides `ballIndicator` while `stage.rearView.visible`, then feeds `xrBoot.hud(h)`; `frame()` calls `xrBoot.frame({ playing })` before `syncWorld`; `startGame` calls `xrBoot.onSessionStart()`; `handlers.onScreen` calls `xrBoot.onScreen(name)`.
12. **Round 4 wiring:**
   - URL flags (all in `app/params.js`): `?apclose=1` (close-mode autopilot, `createGame({ apClose })`, §4.7), `?venue=club|sunset|stadium`, `?challenge=<id>|daily|daily:<date>`, `?career=<eventId>` (`&quick=1`), `?autoreplay=1|0`, `?screen=<name>` (`&event=`, `&tab=`, `&fpmode=`).
   - Venues: `setVenue(v)` → `stage.setVenue(v)` + `audio.setVenue(stage.env.venue)`; the free-play venue (`settings.venue`) is built at boot, career events and the daily challenge bring their own (`spec.venue`), the menus preview the venue being picked (`onPreviewVenue`).
   - Audio: `bindWorld` binds `bindVenue` (§7) per session (`ctx.venue`); the engine's crowd volume follows `volumes.crowd`, the voice follows the master volume; *Voice coach: off* → `voice.setCoach(false)`.
   - Progression: the equipped racket sets `setRacketProfile` per session (physical and timing hits) and the racket model (`racketMesh.userData.setModel`); the outfit tints `stage.fpBody`, `stage.self` (`setKit`) and the rig's sleeves / wristbands (`rig.setOutfit`).
   - Calibration status adds `trackMode`, `upper`, `tiltDeg`, `boost`; Copy diagnostics adds `bodyTracker` { mode, tilt, ...stats }.
   - `__vibora.ready` is set after the first rendered frame (its shader batch belongs to the start-up); hooks add `progress`, `career`, `leaderboards`, `director`, `glassTargets`, `handlers`, `replayMoment(kind)`, `stage.presence`.

13. **Round 6 wiring:**
   - `bindWorld` sets `ctx.play = { live(), incoming() }` and hands it to `ui.bindPlay` and `stage.effects.bindLive`. `live()`: a ball in play until the ruling (a ball fed before the referee resets for the next rep is live again: the ruling's flight key is noted the first time it is seen). `incoming()`: live, coming to the player, swing not decided yet.
   - The approach circle's tick (`ballView` source `frame`) replaces swingAssist's `'timing:cue'` 'tick' (ignored); glass and voice cues are unchanged.
   - `'player:hit'` (strike, not `confirms`): `setTrailPower(effort)` and `stage.fpCam.kick(effort)`; the audio bus rescales `'player:swing'` speeds (`whooshSpeed`).
   - main.js: zone-label occluders from `ui.hudRects()`; the first-hits prompt talks about the closing circle; `diagnosticsData()` passes `input` and the camera player's `timingProfile`; handlers `onTimingInfo` / `onResetTiming`.
   - URL flag `?approfile=user1` (with `?apclose=1`): `tracking/autopilot.js USER1_PROFILE` fitted to the real session (timing mixture 67 % on time around −0.09 s, 29 % anticipation around −0.62 s, 4 % late around +0.5 s; 40 % re-swing after an early swing; log-normal slow swings measured 2–9 m/s; 4 % no swing) and `USER1_SETUP` (1.23 m from a MacBook Air camera, 1280×720, wrists leave the frame on wide swings).

## 11. Tooling

- `tools/serve.mjs`: a static server for `npm start`, on port 5173. Correct MIME types for `.wasm .mjs .js .task .glb .woff2 .webmanifest`, and `Cache-Control: no-cache`.
- `tools/smoke.mjs`: a Playwright smoke test against Chromium at `/opt/pw-browsers`, or the default. It loads `?autopilot=1&drill=fh-drive`, runs for 40 s of sim time (accelerated if supported), and asserts no console errors, ≥ 8 player hits, and ≥ 50% of reps landing in the court. It saves screenshots to `tools/out/`. It also runs a realistic Mac latency pass (`&aplatency=0.11&apdelivery=0.15`), the mouse fallback, the fake-camera calibration, the no-camera path, the `/vibora-padel/` sub-path and the installable app (`--only=pwa`): manifest and installability via the DevTools Protocol, service-worker precache, an **offline** relaunch (drill and pose model), and the *Update ready* flow.
- **App packaging:** `manifest.webmanifest` (name, `id`/`scope` `./`, `start_url ./?source=app`, display `fullscreen` → `standalone`, landscape, icons, shortcuts); `sw.js` (versioned caches `vibora-precache-<version>` + `vibora-runtime-v1`; the precache list between its markers, with a content hash per file, is generated by `node tools/precache.mjs --write` and refreshed by the deploy workflow; network first for pages, `src/`, `styles/`, the manifest; cache first for `vendor/`, `models/`, `assets/`, `fonts/`, `icons/`; same-origin GET requests in scope only; messages `SKIP_WAITING`, `CACHE_URLS`, `STATUS`); `icons/` (original artwork, generated by `node tools/icons.mjs`).
- Round 4 smoke stages: `--only=close` (the human autopilot in close mode at Mac latency: upper-body tracker, the drill is played), `--only=match` (a match in the stadium: ≥ 3 skinned players), the camera stage also calibrates a synthetic person at 1.7 m from a chest-height camera (close mode: "Close · upper body", spot saved, tracker 'upper'), and the autopilot stage checks the first-person body is drawn. Screenshots wait up to 120 s for a frame (software GL under load).
- Round 4 tests: `tests/close.test.mjs`, `swingView.test.mjs`, `glassReturn.test.mjs`, `backswing.test.mjs` (+ `tests/helpers/closeGame.mjs`), `presence.test.mjs`, `venues.test.mjs`, `career.test.mjs`, `arcade.test.mjs`, `round4.test.mjs` (the merge: settings validation, flags, close mode from createGame, racket profiles in timing hits, moods, serveAt, replay joints, umpire team names, coach-only voice toggle, swing events after a teleport). Dev pages: `dev/calibrate.html`, `dev/humans.html`, `dev/venues.html`, `dev/audio-venues.html`, `dev/game-ui.html`, `dev/rackets.html`; harnesses `dev/venues-shot.mjs`, `dev/venues-app-shot.mjs`, `dev/game-shots.mjs`, `dev/game-play-shots.mjs`.
- Round 6 smoke stage `--only=user1` (`?autopilot=1&apclose=1&approfile=user1&aplatency=0.142&apdelivery=0.15&drill=fh-drive&assist=rookie`): ≥ 6 hits, no `ui.hudRects()` block inside `PLAY_REGION` while `game.inPlay()`, every shot carries `effort` ∈ [0, 1], `diagnostics().hitting.mode === 'timing'`. Round 6 harness `dev/hud-audit.mjs` (`--profile=user1 --aplatency=0.142 --reps=3 --after=1`); tests `tests/clarity.test.mjs`, `timing6.test.mjs`, `release6.test.mjs`.
- `tools/blackscreen.mjs`: a browser check that a degenerate mesh and side-on MediaPipe corruptions never black out the picture (smoke stage `--only=blackscreen`).
- `dev/xr-shot.mjs` (stereo eye order, layouts, head sweep on `dev/xr.html`) and `dev/xr-app-shot.mjs` (the real app with simulated glasses via `?xrsim=1&stereo=1`, and the Settings / Help panels); smoke stage `--only=xr` runs `xr-shot --only=full` and `xr-app-shot --only=stereo`.
- `package.json` scripts: `start`, `test` (`node --test tests/`), `smoke`.
- `.github/workflows/pages.yml`: run `npm test`, refresh the precache list (`node tools/precache.mjs --write`), check the key app files, and deploy the repo root to GitHub Pages.
- `README.md`: the Mac + TV + camera setup, controls, drills, troubleshooting, and the physics notes with sources of the constants.
