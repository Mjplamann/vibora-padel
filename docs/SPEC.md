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

`ShotRecord = { id, t, by: 'player'|'coach'|'machine'|'ai', stroke, contact: Vec3, contactU: Vec3|null, racketSpeed, speedIn, speedOut, spinRpm:{top,side,total}, offCenter, quality, assist, timing, spacing, netClearance, predictedLanding: Vec3|null, afterBounce, afterWall }`

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
HudState = { title, subtitle, repIndex, repTotal, points, streak, timer, score /* match display or null */, lastShot: { stroke, speedKmh, spinRpm, netClearance, quality, timing, spacing, notes[] } | null, banner: { text, kind } | null, prompt: string|null , rally?: number /* rally / match: current rally length (points and streak are null) */, bestRally?: number, live?: boolean /* set by main: ball in play */ }
```

## 6. Rendering (`src/render/`, three.js)

All visual decisions aim at **photographic realism of an indoor premium padel club at night**. Use PBR materials, ACES or AgX tone mapping, an environment map from `RoomEnvironment` through PMREM, and soft shadows from the main lights. Everything is procedurally generated.

### 6.1 `scene.js`

```js
export function createRenderer(canvas, { quality = 'high' /* 'ultra'|'high'|'balanced' */ }) // -> { renderer, scene, camera, setQuality(q), resize(w,h), render(dt), composer, stats: {fps, drawCalls}, dynamicResolution: boolean }
```
- Use physically correct lights, `renderer.toneMapping = THREE.ACESFilmicToneMapping`, exposure ~1.0, `outputColorSpace = SRGBColorSpace`, and soft PCF shadows.
- The bloom pass is subtle and only catches the LED panels. Use `OutputPass`.
- Dynamic resolution keeps 60 fps by scaling the pixel ratio between 0.6 and `min(devicePixelRatio, 2)`.
- The camera is a PerspectiveCamera (default vertical FOV 70°, near 0.02, far 120). Near 0.02 matters so the hands render.

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

### 6.6 `ballView.js`

```js
export function createBallView(scene) // -> { update(ball, dt, alpha), setVisible(b), flash(kind) }
```
The ball uses the felt texture and rotates with `ball.spin`, integrated visually. Add a soft contact shadow, an analytic blob decal projected on the floor (and on glass when close). Add a subtle motion trail ribbon (last ~0.12 s, additive, very faint) and a tiny emissive lift, so it reads against the dark hall on a TV. The optional `halo` setting is a soft sprite for visibility training.

### 6.7 `humanoid.js`: coach and AI players

```js
export function createHumanoid({ shirt = '#f2f2f2', shorts = '#1b2a44', skin = '#b07a5a', handed = 'right', racket }) // -> { root, update(actorState, dt) }
```
Build a realistic athletic mannequin procedurally, with proper proportions for a 1.80 m adult:
- Lathe/capsule body parts with smooth normals, shoes and a cap.
- A hierarchical skeleton (hips → spine → chest → shoulders → upper arm → forearm → hand, hips → thigh → shin → foot).
- Animation is procedural and driven by `actorState`: idle split-step bounce, shuffle steps, run cycle scaled by speed, and stroke animations (forehand, backhand, volley, bandeja/overhead, lob) keyed by `swingPhase`.
- The racket sits in the hand.
- It faces its `facing` yaw.

### 6.8 `fpCamera.js`

```js
export function createFirstPersonCamera(camera, settings) // -> { update(world, dt), setFov(deg), mode: 'fp'|'replay'|'orbit', setReplayView(kind) }
```
- **Position:** `player.eye`, which `main.js` computes as player.pos + head offset from tracking + eye height.
- **Base orientation:** looking at the far court, pitch −6°.
- **Gaze assist:** follow the ball with a critically damped yaw/pitch (λ ≈ 6) when `settings.gazeFollow` is on. Limit yaw to ±70° while the ball is in front, and to ±30° while it is within 2.5 m (the stroke). When the ball is behind the player heading for the back glass, allow up to ±80° (a head turn; the off-screen arrow covers the rest). As soon as it comes back off the glass, return to ±30° with a stiffer spring (λ ≈ 14). Yaw rate is capped at 150°/s. In the last 0.8 s before the predicted contact (tactical home) the view frames that contact up to 17° below centre, never tilting up past a chest-high contact; upward pitch is capped at +25° except while the ball is going out. (QA revision: the player's real body and arms face the TV, so a ±150° view left them aiming 90–130° away from their arms at contact.) The logic lives in the pure `src/render/gaze.js` and is tested against the real drills.
- **Comfort:** no roll, and no bob beyond the real head motion.
- **Orbit mode** (menus): a slow cinematic orbit around the court.
- **Replay mode:** broadcast (behind and above the near baseline), side, and ball-cam views.

### 6.9 `effects.js`

```js
export function createEffects(scene) // -> { bounce(pos, surface, speed), glassHit(pos, normal, speed), netShake(x, speed), racketHit(pos, quality), landingMarker(pos|null), targets(zones|null, highlightId), contactGhost(pos|null), update(dt) }
```
- Sand puffs on turf, a glass shimmer ripple, and a net shake (vertex wobble on the net mesh via `environment.net`).
- **Drill target zones:** glowing floor rectangles with labels drawn in canvas textures.
- **Landing marker:** a predicted bounce ring, used in Rookie/Club.
- **Ideal contact ghost:** a soft glowing sphere at the best contact point for the current incoming ball, a training aid toggled in settings.

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

## 8. UI (`index.html`, `styles/app.css`, `src/ui/`)

A **10-foot TV interface**. It is readable from 3 m: base size `clamp(18px, 1.6vw, 40px)`, with a 5% overscan-safe inset. It is single-theme dark: an indoor club at night. The palette is court blue, glass cyan for structure, and optic ball-yellow used only for live ball, score and "go" moments. Display type is *Big Shoulders Display*; UI and body type is *Barlow Semi Condensed*. Everything works with three inputs:
1. The **hand cursor**: raise a hand, then hover 1.0 s to click, with a radial dwell ring.
2. Keyboard, arrows and Enter (spatial focus navigation).
3. Mouse or trackpad.

```js
// ui/ui.js
export function createUI(root, handlers) // -> UIApi
UIApi = { show(screen, data), hud(HudState), shotCard(ShotRecord & result), banner(text, kind), toast(text), results(summary), setLoading(p, text), setCameraPreview(videoEl|null), setSkeleton(PoseFrame|null), setCursor({x,y,visible,progress}), calibration(status /* + needsLatencyTest */), settings(current), setInstall({ kind: 'prompt'|'chrome'|'safari'|'installed'|'done'|'none', onInstall }), updateReady(onRestart) }
handlers = { onStartDrill(id), onStartRally(level), onStartMatch(level), onCalibrate(), onCameraSelect(deviceId, presetKey), onSettings(patch), onPause(), onResume(), onQuit(), onRestart(), onReplay(), onUseFallbackControls() }
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
- `calibrate`:
  1. A full-body check (head to ankles visible), with a distance meter (2.2–3.5 m ideal).
  2. "Stand on your spot" for 2 s (sets neutral).
  3. Handedness and height.
  4. Optional latency test: swing down on each of 6 flashes; measures the motion-to-display offset.
  5. A play-area check: a step left, right, forward and back with a live readout.
- `hub`: drill cards grouped by skill, with stars and bests; Rally with Coach; Match; Settings; Help.
- `drill-intro`: the coaching focus, a picture made of simple court diagrams (canvas), and "Raise your racket to start".
- `play`: the HUD.
  - Top-left: drill name and reps (e.g. "7 / 20").
  - Top-right: points and streak.
  - Bottom-center: the last-shot card with stroke, km/h, rpm, net clearance and timing chips (early/good/late).
  - A small camera PiP with the skeleton (toggle).
  - An off-screen ball indicator arrow when the ball is behind the player.
  - Point banners such as "¡Por tres!".
- `pause`: raise both hands above your head for 2 s, or press Esc. The gesture is ignored while a ball is live (`createHandCursor({ ..., isLive })`, QA2: overhead preparation held the old 1.5 s gesture).
- `results`: stars, points, a landing map, stroke bars, three coaching tips, and buttons for retry, next drill and hub.
- `settings`:
  - Assist (Pro/Club/Rookie), predictive hitting (`hitPrediction`), movement gains, field of view, gaze follow, latency, off-axis arm correction (`offAxisYaw`, experimental, off).
  - Handedness, height, skin tone and racket color.
  - Graphics quality, landing marker, contact ghost, ball halo.
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
7. **App packaging:** `initPwa({ ui, isPlaying, onFullscreenExit })` (`src/app/pwa.js`) right after `createUI`: registers `./sw.js` (scope `./`, `updateViaCache: 'none'`), shows *Update ready — Restart* when a new worker waits (Restart sends `SKIP_WAITING`, the page reloads on `controllerchange`), offers *Install Víbora* from `beforeinstallprompt` (Safari: *File → Add to Dock* hint), detects installed display modes (`data-display`, `data-app="installed"` on `<html>`), and toggles full screen with **F** (Keyboard Lock keeps a short Esc for the game; leaving full screen during play pauses). Pure helpers: `displayModeOf`, `browserOf`, `installKindOf`, `isInstalledApp`.
8. **Camera tracking options:** `createTracking({ video, onFrame, onStatus, model, cameraPreset, yawCorrection })` (`src/app/tracking.js`); `applySettings` calls `tracking.setCameraPreset(S.cameraPreset)` (capture offset, §4.8) and `tracking.setYawCorrection(S.offAxisYaw)`. `correctOffAxisYaw(frame, hfovDeg)` rotates each person's world landmarks about +y by their bearing `offAxisBearing(frame, hfovDeg)` (experimental, off by default: unverified on real footage). `captureOffsetFor(presetKey)` gives the preset's capture offset.
9. **Test hooks** (`window.__vibora`): `stats` (incl. `speculative`: predictive-hitting counters), `freezeOn('contact'|'hit'|'strike', offset)` ('strike': the tick a predicted hit is shown), `freezeAt(t)`, `resume()`, `nextContact()`, `injectPoseFrame(frame)`, `replaySeek(dt)`, `pwa`.

## 11. Tooling

- `tools/serve.mjs`: a static server for `npm start`, on port 5173. Correct MIME types for `.wasm .mjs .js .task .glb .woff2 .webmanifest`, and `Cache-Control: no-cache`.
- `tools/smoke.mjs`: a Playwright smoke test against Chromium at `/opt/pw-browsers`, or the default. It loads `?autopilot=1&drill=fh-drive`, runs for 40 s of sim time (accelerated if supported), and asserts no console errors, ≥ 8 player hits, and ≥ 50% of reps landing in the court. It saves screenshots to `tools/out/`. It also runs a realistic Mac latency pass (`&aplatency=0.11&apdelivery=0.15`), the mouse fallback, the fake-camera calibration, the no-camera path, the `/vibora-padel/` sub-path and the installable app (`--only=pwa`): manifest and installability via the DevTools Protocol, service-worker precache, an **offline** relaunch (drill and pose model), and the *Update ready* flow.
- **App packaging:** `manifest.webmanifest` (name, `id`/`scope` `./`, `start_url ./?source=app`, display `fullscreen` → `standalone`, landscape, icons, shortcuts); `sw.js` (versioned caches `vibora-precache-<version>` + `vibora-runtime-v1`; the precache list between its markers, with a content hash per file, is generated by `node tools/precache.mjs --write` and refreshed by the deploy workflow; network first for pages, `src/`, `styles/`, the manifest; cache first for `vendor/`, `models/`, `assets/`, `fonts/`, `icons/`; same-origin GET requests in scope only; messages `SKIP_WAITING`, `CACHE_URLS`, `STATUS`); `icons/` (original artwork, generated by `node tools/icons.mjs`).
- `package.json` scripts: `start`, `test` (`node --test tests/`), `smoke`.
- `.github/workflows/pages.yml`: run `npm test`, refresh the precache list (`node tools/precache.mjs --write`), check the key app files, and deploy the repo root to GitHub Pages.
- `README.md`: the Mac + TV + camera setup, controls, drills, troubleshooting, and the physics notes with sources of the constants.
