// Single source of truth for real-world dimensions and tuning constants.
// Units: meters, seconds, kilograms, radians. Court frame: Y up, net plane z = 0,
// first-person ("near") half is z > 0 facing -z; the player's right is +x.
// Court figures follow the FIP regulations for a 20 x 10 m padel court.

export const COURT = {
  halfWidth: 5, // x in [-5, 5]
  halfLength: 10, // z in [-10, 10]
  serviceLine: 6.95, // |z| of each service line (measured from the net)
  centerLineOverrun: 0.2, // center service line extends 20 cm past the service line
  lineWidth: 0.05,
  net: {
    centerHeight: 0.88,
    postHeight: 0.92, // height at x = ±5
    cordRadius: 0.025, // top band modeled as a cylinder
    thickness: 0.02,
  },
  // Back walls at z = ±10, full width: glass 0–3 m, mesh 3–4 m, open above 4 m.
  backWall: { glassTop: 3, meshTop: 4 },
  // Side walls at x = ±5 by |z| band: glass up to glassTop, mesh up to meshTop, open above.
  sideWall: [
    { zMin: 8, zMax: 10, glassTop: 3, meshTop: 4 },
    { zMin: 6, zMax: 8, glassTop: 2, meshTop: 3 },
    { zMin: 0, zMax: 6, glassTop: 0, meshTop: 3 },
  ],
  ceiling: 10, // indoor hall ceiling height (ball touching it ends the point)
  surround: 3, // meters of floor modeled outside the enclosure
  postSpacing: 2, // steel posts every 2 m along the enclosure (visual)
};

/** Net height at lateral position x (linear sag between posts and center). */
export function netHeightAt(x) {
  const t = Math.min(1, Math.abs(x) / COURT.halfWidth);
  return COURT.net.centerHeight + (COURT.net.postHeight - COURT.net.centerHeight) * t;
}

export const BALL = {
  radius: 0.0325, // 6.35–6.77 cm diameter per FIP
  mass: 0.057, // 56.0–59.4 g
  inertiaFactor: 0.55, // I = k m r^2 (pressurised felt ball, measured for tennis balls)
  dragCoef: 0.55,
  airDensity: 1.2,
  maxLiftCoef: 0.35, // Magnus lift cap; CL = 1 / (2 + v / (r * |w_perp|))
  spinDecayTau: 6.0, // seconds, exponential spin decay in flight
  restSpeed: 0.08, // below this on the floor the ball is considered at rest
};

// Impact surfaces. Normal restitution e = clamp(e0 - eSlope * |v_n|, eMin, eMax).
// mu is the Coulomb friction coefficient used by the grip/slip (Brody) bounce model.
// Turf check: FIP drop test, 2.54 m drop must rebound 1.35–1.45 m.
export const SURFACES = {
  turf: { e0: 0.8, eSlope: 0.0065, eMin: 0.6, eMax: 0.8, mu: 0.55 },
  glass: { e0: 0.78, eSlope: 0.008, eMin: 0.55, eMax: 0.8, mu: 0.22 },
  mesh: { e0: 0.42, eSlope: 0.01, eMin: 0.15, eMax: 0.45, mu: 0.35, normalJitterDeg: 14, lossJitter: 0.18 },
  netBody: { e0: 0.12, eSlope: 0, eMin: 0.05, eMax: 0.15, mu: 0.8, absorb: 0.85 },
  netCord: { e0: 0.45, eSlope: 0.01, eMin: 0.2, eMax: 0.5, mu: 0.3 },
  outsideFloor: { e0: 0.72, eSlope: 0.008, eMin: 0.5, eMax: 0.75, mu: 0.6 },
  ceiling: { e0: 0.5, eSlope: 0.01, eMin: 0.3, eMax: 0.5, mu: 0.3 },
};

export const SIM = {
  tickRate: 240, // world ticks per second (fixed step)
  ballSubsteps: 4, // ball integrator substeps per tick (=> 960 Hz)
  gravity: 9.81,
  historySeconds: 1.5, // ball state history kept for lag-compensated hits
  maxFrameDt: 0.1,
};

// Padel racket (FIP: length <= 45.5 cm, width <= 26 cm, thickness <= 3.8 cm).
// Local racket frame: origin = grip point (center of the hand on the handle),
// +Y = handle -> tip, +Z = normal of the forehand face, +X = Y x Z (width axis).
export const RACKET = {
  length: 0.455,
  headWidth: 0.26,
  thickness: 0.038,
  mass: 0.36,
  buttY: -0.06, // butt cap position along +Y from the grip point
  handleTopY: 0.075,
  faceCenterY: 0.25, // center of the hitting surface ellipse
  faceSemiX: 0.122, // hitting-surface half width (inside the frame)
  faceSemiY: 0.135, // hitting-surface half length
  frameWidth: 0.012,
  sweetSpotY: 0.235,
  apparentCOR: 0.42, // ball out / ball in for a hand-held racket, at the sweet spot
  corFalloff: 0.6, // e_A(d) = e_A * (1 - corFalloff * (d / semi)^2), d = off-center distance
  minCOR: 0.18,
  mu: 0.45, // ball-face friction (sanded faces)
};

export const PLAYER = {
  defaultHeight: 1.75,
  eyeHeightRatio: 0.936, // eye height / standing height
  shoulderHeightRatio: 0.818,
  hipHeightRatio: 0.53,
  bodyRadius: 0.3, // keep-out distance from glass, mesh and net
  netKeepOut: 0.45, // min z distance from the net plane
  maxSpeed: 7.0, // m/s on court
  maxAccel: 30.0, // m/s^2
  followStiffness: 14, // critically damped follow of the locomotion target (rad/s)
};

export const TRACKING = {
  // Horizontal field-of-view presets for common Mac setups (degrees). captureOffsetMs:
  // typical sensor exposure + transfer delay before the browser sees a frame, used to
  // back-date the capture time when the browser has no metadata.captureTime (Safari):
  // built-in FaceTime camera ~50 ms, Continuity Camera (Wi-Fi/USB relay) ~120 ms, UVC ~70 ms.
  cameraPresets: {
    'macbook-builtin': { label: 'MacBook built-in camera', hfov: 68, captureOffsetMs: 50 },
    'iphone-continuity': { label: 'iPhone (Continuity Camera)', hfov: 74, captureOffsetMs: 120 },
    'iphone-ultrawide': { label: 'iPhone ultra-wide', hfov: 106, captureOffsetMs: 120 },
    'usb-webcam': { label: 'USB webcam', hfov: 78, captureOffsetMs: 70 },
    'usb-wide': { label: 'USB wide-angle webcam', hfov: 100, captureOffsetMs: 70 },
  },
  defaultCamera: 'macbook-builtin',
  model: 'full', // 'lite' | 'full' | 'heavy'
  minPoseConfidence: 0.5,
  latencyDefault: 0.11, // s, total motion-to-display rewind used for hit detection
  gainLateral: 2.6, // court meters per real meter, side to side
  gainDepth: 2.2, // court meters per real meter, toward / away from the TV
  deadzone: 0.04, // m of real movement ignored around the calibrated spot
  swingSpeedThreshold: 5.0, // m/s racket sweet-spot speed that counts as a swing
  handOffsetGrip: 0.03, // grip point sits this far beyond the wrist->knuckle midpoint
};

// Assist presets. Contact margin enlarges the racket face for hit detection,
// shotBlend pulls the outgoing velocity toward the intended shot, magnet nudges
// the player's court position toward the ideal contact spot.
//
// mode (round 3, first real-world session: "like hitting a fruit fly"): 'physical' hits need the
// tracked racket face to meet the ball; 'timing' hits need a swing on time (game/swingAssist.js):
// a detected swing (body-relative sweet-spot speed >= minSpeed m/s, moving forward) whose peak
// falls in [t* - early, t* + late] (s, t* = the ideal contact moment) and whose racket path passes
// within `reach` m of the ball strikes it where it is; the player is glided toward the ideal
// stance with weight `position` (1 = fully placed, own steps ignored during the ball).
export const ASSIST = {
  pro: { label: 'Pro', mode: 'physical', contactMargin: 0.02, shotBlend: 0.0, magnet: 0.0, netSafety: 0.0 },
  club: {
    label: 'Club', mode: 'timing', contactMargin: 0.1, shotBlend: 0.35, magnet: 0.35, netSafety: 0.5,
    timing: { early: 0.2, late: 0.22, reach: 0.75, minSpeed: 4.0, position: 0.75 },
  },
  rookie: {
    label: 'Rookie', mode: 'timing', contactMargin: 0.2, shotBlend: 0.65, magnet: 0.7, netSafety: 0.9,
    timing: { early: 0.32, late: 0.35, reach: Infinity, minSpeed: 3.0, position: 1.0 },
  },
};
export const DEFAULT_ASSIST = 'club';

export const SPEED_LABELS = { kmh: (v) => `${Math.round(v * 3.6)} km/h` };
