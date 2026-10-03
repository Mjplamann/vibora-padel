// Hand skeleton posing shared by the first-person rig: bind-pose analysis of the WebXR
// generic hands, canonical hand frame, and a contact solver that wraps fingers around a
// racket handle. The GLB joints are flat siblings under the Armature, so forward kinematics
// along each finger chain is done here and written back to every bone.
import * as THREE from 'three';
import { RACKET } from '../config.js';
import { RACKET_HANDLE_RADIUS } from './racket.js';

export const FINGERS = ['index', 'middle', 'ring', 'pinky'];
const FINGER_BONES = ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'];
const THUMB_BONES = ['metacarpal', 'phalanx-proximal', 'phalanx-distal', 'tip'];

export function chainNames() {
  const chains = { thumb: THUMB_BONES.map((b) => `thumb-${b}`) };
  for (const f of FINGERS) chains[f] = FINGER_BONES.map((b) => `${f}-finger-${b}`);
  return chains;
}

// Right-hand bind pose of the WebXR generic hand (armature space, meters), used by the
// procedural fallback hand so it shares one posing path with the GLB.
export const RIGHT_BIND = {
  wrist: [0.0391, 0.0558, 0.0092],
  'thumb-metacarpal': [0.02, 0.0198, -0.0189], 'thumb-phalanx-proximal': [0.0048, -0.0034, -0.0358],
  'thumb-phalanx-distal': [-0.0046, -0.0273, -0.0578], 'thumb-tip': [-0.0098, -0.0359, -0.0687],
  'index-finger-metacarpal': [0.0321, 0.0266, -0.001], 'index-finger-phalanx-proximal': [0.0318, -0.0328, -0.0144],
  'index-finger-phalanx-intermediate': [0.0286, -0.078, -0.0129], 'index-finger-phalanx-distal': [0.0264, -0.1021, -0.0115],
  'index-finger-tip': [0.027, -0.1136, -0.0103],
  'middle-finger-metacarpal': [0.0331, 0.0267, 0.0057], 'middle-finger-phalanx-proximal': [0.0366, -0.0359, 0.0074],
  'middle-finger-phalanx-intermediate': [0.0321, -0.0823, 0.0118], 'middle-finger-phalanx-distal': [0.0293, -0.1096, 0.0148],
  'middle-finger-tip': [0.0304, -0.1216, 0.0165],
  'ring-finger-metacarpal': [0.0331, 0.0288, 0.0173], 'ring-finger-phalanx-proximal': [0.0326, -0.0289, 0.0266],
  'ring-finger-phalanx-intermediate': [0.0282, -0.0705, 0.0359], 'ring-finger-phalanx-distal': [0.025, -0.0961, 0.0423],
  'ring-finger-tip': [0.0242, -0.1078, 0.0447],
  'pinky-finger-metacarpal': [0.0297, 0.0217, 0.0322], 'pinky-finger-phalanx-proximal': [0.0254, -0.0181, 0.0442],
  'pinky-finger-phalanx-intermediate': [0.021, -0.0516, 0.0515], 'pinky-finger-phalanx-distal': [0.0182, -0.0706, 0.0581],
  'pinky-finger-tip': [0.0174, -0.0821, 0.0611],
};

/**
 * Canonical racket placement in CANONICAL HAND SPACE (origin = wrist, +Y = wrist->knuckles,
 * +Z = palm normal, +X = Y x Z). The handle crosses the palm diagonally from the heel of the
 * hand to the base of the index finger (eastern/continental grip): forehand face normal = palm.
 */
export const GRIP = {
  forward: 0.071, // grip point distance from the wrist along the hand
  palm: 0.037, // handle axis offset in front of the metacarpal plane (palm skin at ~0.02)
  lateral: 0, // toward the thumb side
  angleDeg: 47, // handle angle from the finger direction toward the thumb
  // Thumb targets in the racket frame (x toward the thumb side, y along the handle, z face normal).
  thumbIP: [0.017, 0.026, 0.036],
  thumbTip: [-0.004, 0.036, 0.033],
};

/** Racket frame (position + quaternion) in canonical hand space for a hand. */
export function racketInHand(handed, out = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() }) {
  const thumb = handed === 'left' ? -1 : 1; // thumb lies on +X for the right hand
  const a = GRIP.angleDeg * THREE.MathUtils.DEG2RAD;
  const y = new THREE.Vector3(Math.sin(a) * thumb, Math.cos(a), 0);
  const z = new THREE.Vector3(0, 0, 1);
  const x = new THREE.Vector3().crossVectors(y, z);
  out.quat.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  out.pos.set(GRIP.lateral * thumb, GRIP.forward, GRIP.palm);
  return out;
}

/** Hand placement in the racket frame (inverse of racketInHand) as a Matrix4. */
export function handInRacketMatrix(handed) {
  const r = racketInHand(handed);
  return new THREE.Matrix4().compose(r.pos, r.quat, new THREE.Vector3(1, 1, 1)).invert();
}

/**
 * Bind-pose analysis. bind: { name: {pos: Vector3, quat: Quaternion} } in armature space.
 * Returns the canonical frame and a matrix mapping armature space -> canonical hand space.
 */
export function analyzeBind(bind, handed) {
  const P = (n) => bind[n].pos;
  const W = P('wrist').clone();
  const knuckles = P('middle-finger-phalanx-proximal').clone()
    .add(P('index-finger-phalanx-proximal')).add(P('ring-finger-phalanx-proximal')).multiplyScalar(1 / 3);
  const f = knuckles.clone().sub(W).normalize();
  const l = P('index-finger-phalanx-proximal').clone().sub(P('pinky-finger-phalanx-proximal')).normalize(); // thumb side
  // Palm normal: right hand n = l x f, left hand n = f x l.
  const n = handed === 'left' ? new THREE.Vector3().crossVectors(f, l) : new THREE.Vector3().crossVectors(l, f);
  n.addScaledVector(f, -n.dot(f)).normalize();
  const x = new THREE.Vector3().crossVectors(f, n).normalize();
  const basis = new THREE.Matrix4().makeBasis(x, f, n).setPosition(W);
  const toCanon = basis.clone().invert();
  return { wrist: W, forward: f, normal: n, lateral: l, x, basis, toCanon };
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();

function distToLine(p, o, d) {
  _v.subVectors(p, o);
  const s = _v.dot(d);
  _v.addScaledVector(d, -s);
  return { dist: _v.length(), s };
}

function segDistToLine(a, b, o, d, steps = 6) {
  let best = Infinity;
  for (let i = 0; i <= steps; i++) {
    _w.lerpVectors(a, b, i / steps);
    const { dist } = distToLine(_w, o, d);
    if (dist < best) best = dist;
  }
  return best;
}

/**
 * Computes posed bone transforms (armature space) for a hand.
 * spec: { mode: 'grip'|'relaxed'|'open', handle?: { origin: Vector3, dir: Vector3 } (armature space) }
 * Returns { name: {pos, quat} }.
 */
export function poseHand(bind, frame, spec) {
  const out = {};
  for (const name of Object.keys(bind)) out[name] = { pos: bind[name].pos.clone(), quat: bind[name].quat.clone() };
  const chains = chainNames();
  const n = frame.normal;
  const l = frame.lateral;
  const handle = spec.handle;
  const handleR = spec.handleRadius ?? RACKET_HANDLE_RADIUS;
  const fingerR = { index: 0.0092, middle: 0.0095, ring: 0.009, pinky: 0.0082, thumb: 0.0105 };

  // Relaxed / open curl presets per finger: [cmc, mcp, pip, dip] degrees.
  const relaxed = {
    index: [0, 14, 22, 10], middle: [0, 18, 27, 12], ring: [2, 22, 30, 14], pinky: [4, 26, 32, 15],
  };
  const open = { index: [0, 3, 4, 2], middle: [0, 3, 4, 2], ring: [0, 4, 5, 2], pinky: [0, 5, 6, 3] };
  const limits = [12, 95, 110, 80];
  const deg = THREE.MathUtils.DEG2RAD;

  // Hinge axes are fixed in each bone: computed once from the (nearly straight) bind pose and
  // carried along by every rotation further up the chain.
  let axes = null;
  const rotateChain = (pts, quats, k, axis, angle) => {
    _q.setFromAxisAngle(axis, angle);
    for (let j = k + 1; j < pts.length; j++) pts[j].sub(pts[k]).applyQuaternion(_q).add(pts[k]);
    for (let j = k; j < quats.length; j++) quats[j].premultiply(_q);
    for (let j = k + 1; j < axes.length; j++) axes[j].applyQuaternion(_q);
  };
  const flexAxis = (pts, k) => axes[k].clone();

  for (const [finger, names] of Object.entries(chains)) {
    const pts = names.map((nm) => out[nm].pos);
    const quats = names.map((nm) => out[nm].quat);
    axes = pts.map((p, k) => {
      if (k === pts.length - 1) return new THREE.Vector3(1, 0, 0);
      const d = _w.subVectors(pts[k + 1], pts[k]).normalize();
      return new THREE.Vector3().crossVectors(d, n).normalize();
    });
    if (finger === 'thumb') {
      if (spec.mode === 'grip' && handle && spec.thumb !== 'relaxed') {
        // Aim the thumb across the front (forehand side) of the handle, pad on the grip,
        // overlapping the middle finger: CMC aims the IP joint, MCP aims the tip.
        const T = (x, y, z) => handle.origin.clone().addScaledVector(handle.xAxis, x * handle.thumbX)
          .addScaledVector(handle.dir, y).addScaledVector(handle.zAxis, z);
        aimJoint(pts, quats, 0, 2, T(GRIP.thumbIP[0], GRIP.thumbIP[1], GRIP.thumbIP[2]), rotateChain);
        aimJoint(pts, quats, 1, 3, T(GRIP.thumbTip[0], GRIP.thumbTip[1], GRIP.thumbTip[2]), rotateChain);
        aimJoint(pts, quats, 2, 3, T(GRIP.thumbTip[0] - 0.004, GRIP.thumbTip[1] + 0.001, GRIP.thumbTip[2] - 0.006), rotateChain);
      } else {
        const d0 = new THREE.Vector3().subVectors(pts[3], pts[0]).normalize();
        const axisN = n.clone();
        if (_v.crossVectors(axisN, d0).dot(l) > 0) axisN.negate(); // must move the tip toward the pinky
        const plan = spec.mode === 'open' ? [4, 2, 2, 2] : [14, 10, 12, 14];
        rotateChain(pts, quats, 0, axisN, plan[0] * deg);
        rotateChain(pts, quats, 0, flexAxis(pts, 0), plan[1] * deg);
        rotateChain(pts, quats, 1, flexAxis(pts, 1), plan[2] * deg);
        rotateChain(pts, quats, 2, flexAxis(pts, 2), plan[3] * deg);
      }
      continue;
    }
    if (spec.mode === 'grip' && handle) {
      // Slight palm cupping at the CMC for ring and pinky, then wrap each phalanx.
      const cup = finger === 'pinky' ? 12 : finger === 'ring' ? 6 : 0;
      if (cup) rotateChain(pts, quats, 0, flexAxis(pts, 0), cup * deg);
      const rc = handleR + fingerR[finger];
      for (let k = 1; k <= 3; k++) solveContact(pts, quats, k, handle, rc * (k === 3 ? 0.95 : 1), limits[k] * deg, rotateChain, flexAxis);
    } else {
      const preset = (spec.mode === 'relaxed' ? relaxed : open)[finger];
      for (let k = 0; k <= 3; k++) if (preset[k]) rotateChain(pts, quats, k, flexAxis(pts, k), preset[k] * deg);
    }
  }
  return out;
}

/** Rotates the chain at joint k (minimal rotation) so joint `end` points at target. */
function aimJoint(pts, quats, k, end, target, rotateChain) {
  const from = new THREE.Vector3().subVectors(pts[end], pts[k]).normalize();
  const to = new THREE.Vector3().subVectors(target, pts[k]).normalize();
  const axis = new THREE.Vector3().crossVectors(from, to);
  const s = axis.length();
  if (s < 1e-6) return;
  const ang = Math.atan2(s, from.dot(to));
  rotateChain(pts, quats, k, axis.normalize(), ang);
}

/**
 * Flexes joint k so its phalanx closes onto the handle cylinder (radius rc): stop at first
 * contact of the distal 70% of the segment, otherwise aim the next joint at the surface.
 */
function solveContact(pts, quats, k, handle, rc, limit, rotateChain, flexAxis) {
  const axis = flexAxis(pts, k);
  const step = 1 * THREE.MathUtils.DEG2RAD;
  const a = pts[k].clone();
  const rel = pts[k + 1].clone().sub(a);
  const qq = new THREE.Quaternion();
  const e = new THREE.Vector3();
  const s0 = new THREE.Vector3();
  let best = 0, bestErr = Infinity, chosen = null;
  for (let th = 0; th <= limit + 1e-6; th += step) {
    qq.setFromAxisAngle(axis, th);
    e.copy(rel).applyQuaternion(qq).add(a);
    s0.lerpVectors(a, e, 0.3);
    const dmin = segDistToLine(s0, e, handle.origin, handle.dir, 8);
    if (dmin <= rc) {
      chosen = Math.max(0, th - step);
      break;
    }
    const err = Math.abs(distToLine(e, handle.origin, handle.dir).dist - rc);
    if (err < bestErr) { bestErr = err; best = th; }
  }
  if (chosen === null) chosen = best;
  rotateChain(pts, quats, k, axis, chosen);
  if (DEBUG.on) DEBUG.log.push(`k${k} ${(chosen * 57.3).toFixed(0)}deg`);
}
export const DEBUG = { on: false, log: [] };

/**
 * Off-hand cradle in the racket frame (ready position: palm on the throat from the forehand
 * side, fingers wrapping the far throat arm). Returns hand canonical -> racket Matrix4.
 * handed = the PLAYER's handedness (the dominant hand holds the grip).
 */
export function cradleInRacketMatrix(handed) {
  const s = handed === 'left' ? -1 : 1;
  // Fingers run diagonally up across the throat toward the far arm; palm faces the racket.
  const f = new THREE.Vector3(-0.62 * s, 0.78, 0).normalize();
  const n = new THREE.Vector3(0, 0, -1);
  const x = new THREE.Vector3().crossVectors(f, n);
  const m = new THREE.Matrix4().makeBasis(x, f, n);
  const palm = new THREE.Vector3(0.004 * s, 0.112, 0.04);
  m.setPosition(palm.addScaledVector(f, -0.058));
  return m;
}

/** Throat arm line the cradling fingers wrap (armature space of the off hand). */
export function cradleHandleInArmature(frame, handed) {
  const s = handed === 'left' ? -1 : 1;
  const toCanon = cradleInRacketMatrix(handed).invert();
  const toArm = new THREE.Matrix4().multiplyMatrices(frame.basis, toCanon);
  const origin = new THREE.Vector3(-0.047 * s, 0.12, 0).applyMatrix4(toArm);
  const m3 = new THREE.Matrix3().setFromMatrix4(toArm);
  const dir = new THREE.Vector3(0, 1, 0).applyMatrix3(m3).normalize();
  return { origin, dir, xAxis: new THREE.Vector3(1, 0, 0).applyMatrix3(m3).normalize(), zAxis: new THREE.Vector3(0, 0, 1).applyMatrix3(m3).normalize(), thumbX: 1 };
}

/** Per-bone blend of two poses into out (lerp positions, slerp rotations). */
export function blendPoses(a, b, w, out = {}) {
  for (const name of Object.keys(a)) {
    const o = out[name] || (out[name] = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() });
    o.pos.lerpVectors(a[name].pos, b[name].pos, w);
    o.quat.slerpQuaternions(a[name].quat, b[name].quat, w);
  }
  return out;
}

/** Handle line (origin at grip point, direction toward the tip) in armature space. */
export function handleInArmature(frame, handed) {
  const r = racketInHand(handed);
  const m3 = new THREE.Matrix3().setFromMatrix4(frame.basis);
  const axis = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(r.quat).applyMatrix3(m3).normalize();
  const origin = r.pos.clone().applyMatrix4(frame.basis);
  return {
    origin, dir: axis(0, 1, 0), xAxis: axis(1, 0, 0), zAxis: axis(0, 0, 1),
    thumbX: handed === 'left' ? -1 : 1, buttY: RACKET.buttY, topY: RACKET.handleTopY,
  };
}
