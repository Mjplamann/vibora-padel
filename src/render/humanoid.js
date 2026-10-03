// Procedural athletic humanoid (coach / AI players) with a hierarchical skeleton and
// procedural animation driven by actor state. Arms and legs are posed with two-bone IK
// toward keyframed racket / foot targets, so stroke paths are authored as racket paths.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { buildRacket } from './racket.js';
import { racketInHand } from './handPose.js';
import { createSkinMaterial, createFabricMaterial, limbGeometry, quatFromYZ, bakeRigidSkin } from './actorKit.js';

const H0 = 1.8; // proportions are authored for a 1.80 m adult
const DIM = {
  hipY: 0.95, hipHalf: 0.086, thigh: 0.44, shin: 0.43, ankleY: 0.075,
  spineY: 0.1, chestY: 0.2, neckY: 0.23, shoulderX: 0.172, shoulderY: 0.2,
  upper: 0.3, fore: 0.265, headY: 0.1,
};

// ------------------------------------------------------------------ stroke keyframes
// Body frame: x = actor's right, y up, z forward (toward the target), origin at the feet.
// g = grip point, a = racket axis (handle->tip), n = forehand face normal (palm),
// turn = shoulder turn to the racket side (deg), off = off-hand target or 'throat'.
const READY = { g: [0.1, 1.08, 0.36], a: [-0.3, 0.75, 0.55], n: [-0.9, 0.1, 0.35], turn: 0, off: 'throat', crouch: 0.6 };
const STROKES = {
  forehand: [
    { p: 0, ...READY },
    { p: 0.3, g: [0.5, 1.18, -0.22], a: [0.3, 0.8, -0.5], n: [0.35, -0.55, -0.7], turn: 70, off: [0.12, 1.25, 0.38], crouch: 0.55 },
    { p: 0.47, g: [0.52, 0.98, 0.12], a: [0.7, -0.25, -0.65], n: [0.45, 0.25, 0.85], turn: 35, off: [-0.1, 1.2, 0.35], crouch: 0.6 },
    { p: 0.55, g: [0.44, 1.0, 0.5], a: [0.85, 0.08, 0.5], n: [-0.45, 0.1, 0.88], turn: 0, off: [-0.35, 1.15, 0.2], crouch: 0.6 },
    { p: 0.75, g: [-0.18, 1.38, 0.42], a: [-0.4, 0.6, -0.65], n: [-0.6, 0.3, 0.5], turn: -45, off: [-0.32, 1.2, 0.05], crouch: 0.45 },
    { p: 1, g: [0.0, 1.22, 0.32], a: [-0.3, 0.8, 0.3], n: [-0.9, 0.0, 0.3], turn: -15, off: 'throat', crouch: 0.5 },
  ],
  backhand: [
    { p: 0, ...READY },
    { p: 0.3, g: [-0.42, 1.08, -0.12], a: [-0.3, 0.8, -0.5], n: [0.6, 0.0, -0.7], turn: -80, off: 'throat', crouch: 0.6 },
    { p: 0.47, g: [-0.45, 0.97, 0.2], a: [-0.75, -0.1, -0.55], n: [0.5, 0.1, -0.85], turn: -40, off: [-0.4, 1.05, -0.2], crouch: 0.6 },
    { p: 0.55, g: [-0.42, 1.0, 0.5], a: [-0.9, 0.1, 0.4], n: [0.4, -0.05, -0.9], turn: -5, off: [-0.45, 1.05, -0.3], crouch: 0.6 },
    { p: 0.75, g: [0.22, 1.42, 0.38], a: [0.4, 0.8, 0.2], n: [0.8, 0.0, -0.4], turn: 25, off: [-0.5, 1.1, -0.35], crouch: 0.45 },
    { p: 1, g: [0.0, 1.2, 0.35], a: [0.0, 0.85, 0.4], n: [-0.9, 0, 0.3], turn: 0, off: 'throat', crouch: 0.5 },
  ],
  'volley-fh': [
    { p: 0, ...READY, g: [0.12, 1.2, 0.38] },
    { p: 0.35, g: [0.42, 1.28, 0.15], a: [0.25, 0.9, -0.2], n: [-0.1, 0.2, 0.95], turn: 30, off: [-0.1, 1.25, 0.45], crouch: 0.5 },
    { p: 0.55, g: [0.4, 1.2, 0.6], a: [0.45, 0.75, 0.45], n: [-0.2, 0.3, 0.9], turn: 5, off: [-0.25, 1.2, 0.3], crouch: 0.5 },
    { p: 0.8, g: [0.25, 1.1, 0.6], a: [0.35, 0.6, 0.6], n: [-0.2, 0.45, 0.85], turn: 0, off: [-0.25, 1.15, 0.3], crouch: 0.5 },
    { p: 1, ...READY, g: [0.12, 1.2, 0.38] },
  ],
  'volley-bh': [
    { p: 0, ...READY, g: [0.12, 1.2, 0.38] },
    { p: 0.35, g: [-0.4, 1.28, 0.1], a: [-0.3, 0.9, -0.1], n: [0.1, -0.2, -0.95], turn: -40, off: 'throat', crouch: 0.5 },
    { p: 0.55, g: [-0.4, 1.2, 0.6], a: [-0.45, 0.75, 0.45], n: [0.2, -0.3, -0.9], turn: -10, off: [-0.4, 1.1, -0.1], crouch: 0.5 },
    { p: 0.8, g: [-0.35, 1.1, 0.58], a: [-0.4, 0.6, 0.6], n: [0.2, -0.45, -0.85], turn: -5, off: [-0.4, 1.1, -0.15], crouch: 0.5 },
    { p: 1, ...READY, g: [0.12, 1.2, 0.38] },
  ],
  bandeja: [
    { p: 0, ...READY },
    { p: 0.35, g: [0.28, 1.72, -0.05], a: [0.1, 0.6, -0.8], n: [-0.7, 0.3, 0.6], turn: 75, off: [-0.05, 1.85, 0.45], crouch: 0.25 },
    { p: 0.55, g: [0.25, 1.98, 0.42], a: [0.25, 0.85, 0.45], n: [-0.3, 0.3, 0.9], turn: 25, off: [-0.3, 1.35, 0.2], crouch: 0.2 },
    { p: 0.8, g: [-0.2, 1.3, 0.5], a: [-0.6, 0.25, 0.75], n: [-0.3, 0.6, 0.6], turn: -15, off: [-0.35, 1.2, 0.0], crouch: 0.35 },
    { p: 1, ...READY },
  ],
  vibora: [
    { p: 0, ...READY },
    { p: 0.35, g: [0.32, 1.7, -0.08], a: [0.2, 0.55, -0.8], n: [-0.7, 0.2, 0.6], turn: 80, off: [-0.05, 1.85, 0.45], crouch: 0.25 },
    { p: 0.55, g: [0.4, 1.9, 0.4], a: [0.6, 0.7, 0.35], n: [-0.65, -0.1, 0.75], turn: 25, off: [-0.3, 1.35, 0.2], crouch: 0.2 },
    { p: 0.82, g: [-0.25, 1.05, 0.45], a: [-0.7, -0.2, 0.6], n: [-0.4, -0.6, 0.6], turn: -30, off: [-0.4, 1.15, -0.05], crouch: 0.4 },
    { p: 1, ...READY },
  ],
  smash: [
    { p: 0, ...READY },
    { p: 0.35, g: [0.22, 1.66, -0.22], a: [0.05, -0.6, -0.8], n: [0.3, 0.6, -0.7], turn: 75, off: [-0.08, 2.0, 0.35], crouch: 0.3 },
    { p: 0.52, g: [0.15, 2.05, 0.2], a: [0.1, 0.95, 0.2], n: [-0.2, 0.2, 0.95], turn: 25, off: [-0.25, 1.5, 0.25], crouch: 0.1 },
    { p: 0.6, g: [0.15, 2.0, 0.5], a: [0.15, 0.8, 0.6], n: [-0.1, -0.4, 0.9], turn: 0, off: [-0.35, 1.25, 0.1], crouch: 0.1 },
    { p: 0.85, g: [-0.3, 0.98, 0.45], a: [-0.35, -0.6, 0.7], n: [-0.5, -0.6, -0.4], turn: -35, off: [-0.35, 1.15, -0.1], crouch: 0.45 },
    { p: 1, ...READY },
  ],
  lob: [
    { p: 0, ...READY },
    { p: 0.3, g: [0.5, 0.78, -0.15], a: [0.6, 0.05, -0.8], n: [0.0, 0.7, -0.7], turn: 50, off: [0.0, 1.1, 0.4], crouch: 0.9 },
    { p: 0.55, g: [0.45, 0.78, 0.45], a: [0.85, -0.05, 0.5], n: [-0.4, 0.6, 0.7], turn: 0, off: [-0.3, 1.0, 0.2], crouch: 0.85 },
    { p: 0.85, g: [0.1, 1.75, 0.5], a: [0.1, 0.7, 0.7], n: [-0.6, 0.6, 0.3], turn: -20, off: [-0.35, 1.2, 0.1], crouch: 0.4 },
    { p: 1, ...READY },
  ],
  chiquita: [
    { p: 0, ...READY },
    { p: 0.35, g: [0.45, 0.88, 0.05], a: [0.6, 0.3, -0.6], n: [-0.2, -0.2, 0.95], turn: 35, off: [0.0, 1.0, 0.4], crouch: 1 },
    { p: 0.55, g: [0.45, 0.82, 0.45], a: [0.8, 0.15, 0.55], n: [-0.45, 0.2, 0.85], turn: 5, off: [-0.25, 1.0, 0.25], crouch: 1 },
    { p: 0.8, g: [0.25, 0.98, 0.62], a: [0.5, 0.35, 0.8], n: [-0.5, 0.4, 0.75], turn: 0, off: [-0.3, 1.0, 0.2], crouch: 0.9 },
    { p: 1, ...READY },
  ],
  serve: [
    { p: 0, g: [0.32, 1.1, 0.12], a: [0.2, 0.9, 0.2], n: [-0.9, 0, 0.3], turn: 20, off: [-0.05, 1.0, 0.45], crouch: 0.2 },
    { p: 0.35, g: [0.5, 0.86, -0.38], a: [0.4, 0.4, -0.8], n: [0.2, -0.3, -0.9], turn: 45, off: [-0.05, 0.86, 0.45], crouch: 0.4 },
    { p: 0.6, g: [0.4, 0.76, 0.4], a: [0.9, 0.1, 0.4], n: [-0.4, 0.1, 0.9], turn: 0, off: [-0.3, 1.0, 0.25], crouch: 0.45 },
    { p: 0.85, g: [0.0, 1.25, 0.55], a: [-0.3, 0.6, 0.7], n: [-0.8, 0.3, 0.4], turn: -20, off: [-0.3, 1.1, 0.15], crouch: 0.3 },
    { p: 1, ...READY },
  ],
};
STROKES['glass-fh'] = STROKES.forehand;
STROKES['glass-bh'] = STROKES.backhand;

// Feet during strokes (body frame [x, z] for the racket-side foot R and the other foot L).
const STANCE = {
  ready: { R: [0.26, 0], L: [-0.26, 0] },
  forehand: { R: [0.3, -0.12], L: [-0.12, 0.34] },
  backhand: { R: [0.12, 0.34], L: [-0.3, -0.12] },
  overhead: { R: [0.22, -0.28], L: [-0.18, 0.25] },
  volley: { R: [0.22, 0.05], L: [-0.2, 0.2] },
};
function stanceFor(stroke) {
  if (!stroke) return STANCE.ready;
  if (stroke.includes('bh') || stroke === 'backhand') return STANCE.backhand;
  if (stroke === 'bandeja' || stroke === 'vibora' || stroke === 'smash') return STANCE.overhead;
  if (stroke.startsWith('volley')) return STANCE.volley;
  return STANCE.forehand;
}

function sampleStroke(keys, phase, out) {
  let i = 0;
  while (i < keys.length - 2 && phase > keys[i + 1].p) i++;
  const k0 = keys[i], k1 = keys[i + 1];
  const u = THREE.MathUtils.clamp((phase - k0.p) / Math.max(1e-6, k1.p - k0.p), 0, 1);
  const s = u * u * (3 - 2 * u);
  const lerp3 = (a, b, o) => o.set(a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s);
  lerp3(k0.g, k1.g, out.g);
  lerp3(k0.a, k1.a, out.a).normalize();
  lerp3(k0.n, k1.n, out.n).normalize();
  out.turn = k0.turn + (k1.turn - k0.turn) * s;
  out.crouch = k0.crouch + (k1.crouch - k0.crouch) * s;
  const offA = k0.off === 'throat' ? null : k0.off;
  const offB = k1.off === 'throat' ? null : k1.off;
  out.offThroat = offA === null && offB === null ? 1 : offA === null ? 1 - s : offB === null ? s : 0;
  if (offA && offB) lerp3(offA, offB, out.off);
  else if (offA || offB) out.off.set(...(offA || offB));
  return out;
}

// ------------------------------------------------------------------ geometry helpers

function torsoGeometry(profile, flatten, radial = 28) {
  const pts = profile.map(([y, r]) => new THREE.Vector2(Math.max(r, 1e-4), y));
  const g = new THREE.LatheGeometry(pts, radial);
  g.scale(1, 1, flatten);
  g.computeVertexNormals();
  return g;
}

function shoeGeometry() {
  const g = new RoundedBoxGeometry(0.1, 0.075, 0.27, 4, 0.03);
  // Taper the toe and lift it slightly.
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i), y = p.getY(i);
    const toe = THREE.MathUtils.smoothstep(z, 0.02, 0.135);
    p.setX(i, p.getX(i) * (1 - 0.25 * toe));
    p.setY(i, y * (1 - 0.3 * toe) + 0.012 * toe * toe);
  }
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ builder

/**
 * @param {{shirt?: string, shorts?: string, skin?: string, handed?: 'right'|'left', racket?: THREE.Group, height?: number, cap?: string, shoe?: string}} opts
 * @returns {{ root: THREE.Group, update(actorState, dt), setHanded(h), racket: THREE.Group }}
 */
export function createHumanoid({
  shirt = '#f2f2f2', shorts = '#1b2a44', skin = '#b07a5a', handed = 'right', racket = null, height = H0,
  cap = '#f4f4f2', shoe = '#f4f4f4', accent = '#e8572a',
} = {}) {
  const root = new THREE.Group();
  root.name = 'humanoid';
  const body = new THREE.Group(); // scaled skeleton
  body.scale.setScalar(height / H0);
  root.add(body);

  const mSkin = createSkinMaterial(skin, { normalRepeat: 3 });
  const mShirt = createFabricMaterial(shirt, { repeat: 14 });
  const mShorts = createFabricMaterial(shorts, { repeat: 14 });
  const mSock = createFabricMaterial('#f6f6f4', { repeat: 10 });
  const mCap = createFabricMaterial(cap, { repeat: 10 });
  const mShoe = new THREE.MeshPhysicalMaterial({ color: shoe, roughness: 0.55, clearcoat: 0.3, clearcoatRoughness: 0.5 });
  const mSole = new THREE.MeshStandardMaterial({ color: '#d8d8d6', roughness: 0.75 });
  const mHair = new THREE.MeshStandardMaterial({ color: '#2a1d16', roughness: 0.85 });
  const mAccent = new THREE.MeshPhysicalMaterial({ color: accent, roughness: 0.5 });

  const bone = (name, parent, x = 0, y = 0, z = 0) => {
    const b = new THREE.Object3D();
    b.name = name;
    b.position.set(x, y, z);
    parent.add(b);
    return b;
  };
  const mesh = (geo, mat, parent, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  // Skeleton (model faces +z; the actor's right side is -x).
  const hips = bone('hips', body, 0, DIM.hipY, 0);
  const spine = bone('spine', hips, 0, DIM.spineY, 0);
  const chest = bone('chest', spine, 0, DIM.chestY, 0);
  const neck = bone('neck', chest, 0, DIM.neckY, 0);
  const head = bone('head', neck, 0, DIM.headY, 0.01);
  const side = {};
  for (const s of ['R', 'L']) {
    const sx = s === 'R' ? -1 : 1;
    const shoulder = bone(`shoulder${s}`, chest, sx * DIM.shoulderX, DIM.shoulderY, -0.01);
    const upper = bone(`upperArm${s}`, shoulder);
    const fore = bone(`foreArm${s}`, upper, 0, -DIM.upper, 0);
    const hand = bone(`hand${s}`, body); // hand orientation is solved in body space
    const thigh = bone(`thigh${s}`, hips, sx * DIM.hipHalf, -0.03, 0);
    const shin = bone(`shin${s}`, thigh, 0, -DIM.thigh, 0);
    const foot = bone(`foot${s}`, body);
    side[s] = { shoulder, upper, fore, hand, thigh, shin, foot, sx };
  }

  // --- meshes
  // Pelvis / shorts
  mesh(torsoGeometry([[-0.13, 0.0], [-0.125, 0.085], [-0.09, 0.142], [-0.01, 0.154], [0.07, 0.15], [0.11, 0.149], [0.111, 0]], 0.7), mShorts, hips);
  // Shirt torso (one piece on the spine; the chest bone only carries shoulders and neck).
  mesh(torsoGeometry([[-0.075, 0], [-0.07, 0.16], [0.02, 0.152], [0.12, 0.158], [0.24, 0.172], [0.31, 0.176], [0.37, 0.165],
    [0.41, 0.14], [0.44, 0.1], [0.455, 0.07], [0.46, 0]], 0.62), mShirt, spine);
  // Collar trim
  const collar = mesh(new THREE.TorusGeometry(0.064, 0.008, 8, 28), mAccent, chest, 0, 0.255, 0.0);
  collar.rotation.x = Math.PI / 2;
  collar.scale.set(1, 0.8, 1);
  // Neck + head
  mesh(limbGeometry(0.11, [[0, 0.052], [1, 0.054]], { radial: 16 }), mSkin, neck, 0, 0.09, 0);
  const skull = mesh(new THREE.SphereGeometry(1, 32, 24), mSkin, head, 0, 0.02, 0);
  skull.scale.set(0.078, 0.105, 0.095);
  const jaw = mesh(new THREE.SphereGeometry(1, 24, 16), mSkin, head, 0, -0.045, 0.02);
  jaw.scale.set(0.062, 0.055, 0.07);
  const nose = mesh(new THREE.ConeGeometry(0.014, 0.035, 10), mSkin, head, 0, 0.0, 0.098);
  nose.rotation.x = Math.PI / 2 + 0.25;
  for (const sx of [-1, 1]) {
    const ear = mesh(new THREE.SphereGeometry(1, 12, 10), mSkin, head, sx * 0.077, 0.005, -0.005);
    ear.scale.set(0.012, 0.028, 0.018);
  }
  for (const sx of [-1, 1]) {
    const eye = mesh(new THREE.SphereGeometry(0.0085, 10, 8), mHair, head, sx * 0.03, 0.012, 0.083);
    eye.scale.set(1, 0.7, 0.6);
    const brow = mesh(new THREE.CapsuleGeometry(0.004, 0.022, 2, 6), mHair, head, sx * 0.031, 0.03, 0.087);
    brow.rotation.z = Math.PI / 2 + sx * 0.12;
  }
  const hair = mesh(new THREE.SphereGeometry(1, 28, 20, 0, Math.PI * 2, 0, Math.PI * 0.62), mHair, head, 0, 0.025, -0.008);
  hair.scale.set(0.082, 0.108, 0.098);
  // Cap: crown + brim
  const crown = mesh(new THREE.SphereGeometry(1, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.5), mCap, head, 0, 0.038, -0.004);
  crown.scale.set(0.084, 0.092, 0.1);
  const brim = mesh(new THREE.CylinderGeometry(0.068, 0.068, 0.007, 24, 1, false, -Math.PI / 2, Math.PI), mCap, head, 0, 0.042, 0.07);
  brim.scale.set(1.0, 1, 1.0);
  brim.rotation.x = 0.18;
  mesh(new THREE.SphereGeometry(0.01, 10, 8), mCap, head, 0, 0.128, -0.004);

  for (const s of ['R', 'L']) {
    const S = side[s];
    // Deltoid / sleeve cap, upper arm, sleeve
    const delt = mesh(new THREE.SphereGeometry(1, 20, 14), mShirt, S.upper, 0, -0.025, 0);
    delt.scale.set(0.054, 0.062, 0.056);
    mesh(limbGeometry(DIM.upper, [[0, 0.047], [0.4, 0.046], [0.75, 0.041], [1, 0.037]], { flatten: 0.9 }), mSkin, S.upper);
    mesh(limbGeometry(0.13, [[0, 0.056], [1, 0.054]], { flatten: 0.92, capSegments: 2 }), mShirt, S.upper, 0, -0.01, 0);
    // Forearm + wristband
    mesh(limbGeometry(DIM.fore, [[0, 0.04], [0.2, 0.043], [0.6, 0.034], [1, 0.026]], { flatten: 0.8 }), mSkin, S.fore);
    mesh(limbGeometry(0.06, [[0, 0.031], [1, 0.03]], { flatten: 0.82, capSegments: 1 }), mSock, S.fore, 0, -DIM.fore + 0.065, 0);
    // Hand: fist in canonical hand space (+Y fingers, +Z palm).
    const palm = mesh(new RoundedBoxGeometry(0.082, 0.1, 0.042, 3, 0.018), mSkin, S.hand, 0, 0.055, 0.008);
    palm.scale.set(1, 1, 1);
    const fingers = mesh(new THREE.CapsuleGeometry(0.02, 0.06, 4, 10), mSkin, S.hand, 0, 0.098, 0.028);
    fingers.rotation.z = Math.PI / 2;
    const thumb = mesh(new THREE.CapsuleGeometry(0.011, 0.035, 4, 8), mSkin, S.hand, 0.034 * (s === 'R' ? 1 : -1), 0.06, 0.03);
    thumb.rotation.set(0.6, 0, 0.5 * (s === 'R' ? -1 : 1));
    S.thumbMesh = thumb;
    // Thigh with shorts leg, shin with sock, shoe
    mesh(limbGeometry(DIM.thigh, [[0, 0.09], [0.45, 0.08], [0.85, 0.062], [1, 0.057]], { flatten: 0.95 }), mSkin, S.thigh);
    mesh(limbGeometry(0.24, [[0, 0.094], [0.6, 0.088], [1, 0.085]], { flatten: 0.93, capSegments: 2 }), mShorts, S.thigh, 0, 0.0, 0);
    mesh(limbGeometry(DIM.shin, [[0, 0.056], [0.25, 0.062], [0.6, 0.048], [1, 0.036]], { flatten: 0.95 }), mSkin, S.shin);
    mesh(limbGeometry(0.12, [[0, 0.04], [1, 0.039]], { flatten: 0.95, capSegments: 2 }), mSock, S.shin, 0, -DIM.shin + 0.11, 0);
    const shoeM = mesh(shoeGeometry(), mShoe, S.foot, 0, -0.035, 0.055);
    const sole = mesh(new RoundedBoxGeometry(0.104, 0.018, 0.272, 3, 0.008), mSole, S.foot, 0, -0.068, 0.055);
    const stripe = mesh(new THREE.BoxGeometry(0.106, 0.012, 0.09), mAccent, S.foot, 0, -0.04, 0.03);
    stripe.rotation.x = -0.35;
    S.shoe = shoeM;
    void sole;
  }

  // One skinned mesh per material over the whole skeleton (rigid weights): ~9 draw calls.
  const boneList = [hips, spine, chest, neck, head];
  for (const s of ['R', 'L']) {
    const S = side[s];
    boneList.push(S.shoulder, S.upper, S.fore, S.hand, S.thigh, S.shin, S.foot);
  }
  bakeRigidSkin(body, boneList, { center: new THREE.Vector3(0, 1.0, 0), boundingRadius: 1.9 });

  // Racket attached to the racket hand through the canonical grip.
  const racketMesh = racket || buildRacket({ handed });
  racketMesh.traverse((o) => { if (o.isMesh) o.castShadow = true; });

  let hand = handed === 'left' ? 'left' : 'right';
  const attachRacket = () => {
    const S = side[hand === 'left' ? 'L' : 'R'];
    const r = racketInHand(hand);
    S.hand.add(racketMesh);
    racketMesh.position.copy(r.pos);
    racketMesh.quaternion.copy(r.quat);
    racketMesh.userData.setHanded?.(hand);
  };
  attachRacket();

  // ---------------------------------------------------------------- animation state
  const cur = {
    g: new THREE.Vector3(...READY.g), a: new THREE.Vector3(...READY.a).normalize(), n: new THREE.Vector3(...READY.n).normalize(),
    off: new THREE.Vector3(-0.1, 1.1, 0.4), offThroat: 1, turn: 0, crouch: 0.6, lean: 0, feet: { R: new THREE.Vector3(), L: new THREE.Vector3() },
  };
  const tgt = { g: new THREE.Vector3(), a: new THREE.Vector3(), n: new THREE.Vector3(), off: new THREE.Vector3(), offThroat: 1, turn: 0, crouch: 0 };
  let gaitPhase = 0;
  let time = 0;
  let gaitBlend = 0;
  const vBody = new THREE.Vector3();
  const gaitDir = new THREE.Vector3();

  // Converts a body-frame vector (x = actor's right) to model space for the current handedness.
  const toModel = (v, out) => out.set(-(hand === 'left' ? -1 : 1) * v.x, v.y, v.z);
  const handSide = () => (hand === 'left' ? 'L' : 'R');
  const offSide = () => (hand === 'left' ? 'R' : 'L');

  // Scratch
  const tA = new THREE.Vector3(), tB = new THREE.Vector3(), tC = new THREE.Vector3(), tD = new THREE.Vector3();
  const qA = new THREE.Quaternion(), qB = new THREE.Quaternion();
  const mA = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);

  function aimBone(b, from, to, zHint) {
    // Local -Y of b points from -> to (all in body space); twist from zHint.
    tA.subVectors(from, to).normalize();
    quatFromYZ(tA, zHint, qA);
    b.parent.getWorldQuaternion(qB);
    body.getWorldQuaternion(tmpQ);
    // qA is in body space -> world = bodyQ * qA; local = parentWorld^-1 * world
    qB.invert().multiply(tmpQ).multiply(qA);
    b.quaternion.copy(qB);
    b.updateMatrixWorld(true);
  }
  const tmpQ = new THREE.Quaternion();
  const invBody = new THREE.Matrix4();
  const bodyPos = (obj, out) => obj.getWorldPosition(out).applyMatrix4(invBody);

  function solveIK(S, T, l1, l2, pole, out) {
    const d = tB.subVectors(T, S);
    const dist = THREE.MathUtils.clamp(d.length(), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
    d.normalize();
    const a = Math.acos(THREE.MathUtils.clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1));
    const perp = tC.copy(pole).addScaledVector(d, -pole.dot(d)).normalize();
    out.copy(S).addScaledVector(d, Math.cos(a) * l1).addScaledVector(perp, Math.sin(a) * l1);
    return dist;
  }

  const wristT = new THREE.Vector3(), elbowP = new THREE.Vector3(), shoulderP = new THREE.Vector3(), wristP = new THREE.Vector3();
  const handQ = new THREE.Quaternion();
  const handInR = new THREE.Matrix4();
  const racketM = new THREE.Matrix4();

  function poseArm(S, wristTarget, handQuat, poleBody) {
    bodyPos(S.shoulder, shoulderP);
    solveIK(shoulderP, wristTarget, DIM.upper, DIM.fore, poleBody, elbowP);
    tD.copy(poleBody);
    aimBone(S.upper, shoulderP, elbowP, tD);
    // Forearm reaches as far as it can toward the target.
    tB.subVectors(wristTarget, elbowP).normalize();
    wristP.copy(elbowP).addScaledVector(tB, DIM.fore);
    tD.set(0, 0, 1).applyQuaternion(handQuat);
    aimBone(S.fore, elbowP, wristP, tD);
    S.hand.position.copy(wristP);
    S.hand.quaternion.copy(handQuat);
  }

  function poseLeg(S, footTarget, footYaw, toePitch, kneePole) {
    bodyPos(S.thigh, shoulderP);
    const ankle = tA.copy(footTarget);
    solveIK(shoulderP, ankle, DIM.thigh, DIM.shin, kneePole, elbowP);
    const ank = new THREE.Vector3().copy(footTarget);
    aimBone(S.thigh, shoulderP, elbowP, kneePole);
    tB.subVectors(ank, elbowP).normalize();
    wristP.copy(elbowP).addScaledVector(tB, DIM.shin);
    aimBone(S.shin, elbowP, wristP, kneePole);
    S.foot.position.copy(wristP);
    S.foot.rotation.set(toePitch, footYaw, 0, 'YXZ');
  }

  /**
   * actorState: { pos, vel, facing, stroke, swingPhase, holding, handed }
   */
  function update(state, dt = 1 / 60) {
    if (!state) return;
    time += dt;
    if (state.handed && state.handed !== hand) setHanded(state.handed);
    root.position.set(state.pos.x, 0, state.pos.z);
    root.rotation.set(0, state.facing || 0, 0);
    root.updateMatrixWorld(true);
    invBody.copy(body.matrixWorld).invert();

    // Velocity in the body frame (x = actor's right, z = forward).
    const f = state.facing || 0;
    const vx = state.vel?.x || 0, vz = state.vel?.z || 0;
    const fwdX = Math.sin(f), fwdZ = Math.cos(f);
    const vF = vx * fwdX + vz * fwdZ;
    const vR = vx * -fwdZ + vz * fwdX;
    vBody.set(vR, 0, vF);
    const speed = Math.hypot(vF, vR);
    const holding = state.holding || 'ready';
    const swinging = holding === 'swing' && state.stroke && STROKES[state.stroke];

    // ---- upper body target
    if (swinging) {
      sampleStroke(STROKES[state.stroke], THREE.MathUtils.clamp(state.swingPhase || 0, 0, 1), tgt);
    } else {
      tgt.g.set(...READY.g);
      tgt.a.set(...READY.a).normalize();
      tgt.n.set(...READY.n).normalize();
      tgt.turn = 0;
      tgt.crouch = READY.crouch;
      tgt.offThroat = 1;
      if (speed > 0.6) {
        // Running: racket carried up at the side, off arm swings with the stride.
        const r = THREE.MathUtils.smoothstep(speed, 0.6, 3);
        tgt.g.lerp(tA.set(0.28, 1.05, 0.22), r);
        tgt.a.lerp(tA.set(0.05, 0.85, 0.5), r).normalize();
        tgt.n.lerp(tA.set(-0.95, 0, 0.1), r).normalize();
        tgt.offThroat = 1 - r;
        tgt.off.set(-0.22, 1.0 + 0.08 * Math.sin(gaitPhase * Math.PI * 2), 0.1 + 0.22 * Math.sin(gaitPhase * Math.PI * 2));
        tgt.crouch = READY.crouch * (1 - r) + 0.5 * r;
      }
    }
    const lam = swinging ? 60 : 12;
    const k = 1 - Math.exp(-lam * dt);
    cur.g.lerp(tgt.g, k);
    cur.a.lerp(tgt.a, k).normalize();
    cur.n.lerp(tgt.n, k).normalize();
    cur.turn += (tgt.turn - cur.turn) * k;
    cur.crouch += (tgt.crouch - cur.crouch) * k;
    cur.offThroat += (tgt.offThroat - cur.offThroat) * k;
    cur.off.lerp(tgt.off, k);

    // ---- gait
    const moving = speed > 0.25 && !swinging;
    gaitBlend += ((moving ? 1 : 0) - gaitBlend) * (1 - Math.exp(-10 * dt));
    const lateral = Math.abs(vR) > Math.abs(vF) * 1.2 && speed < 4.5;
    const freq = lateral ? 2.2 + 0.3 * speed : 1.35 + 0.22 * speed;
    gaitPhase = (gaitPhase + freq * dt) % 1;
    const stride = speed / (2 * freq);
    const dir = speed > 1e-3 ? gaitDir.set(vR / speed, 0, vF / speed) : gaitDir.set(0, 0, 1);
    const stance = stanceFor(swinging ? state.stroke : null);
    const lift = lateral ? 0.06 : 0.1 + 0.035 * speed;

    // Split-step bounce in ready.
    const bounce = holding === 'ready' && !moving ? 0.018 * Math.abs(Math.sin(time * Math.PI * 1.7)) : 0;
    const runBob = moving ? 0.025 * Math.cos(gaitPhase * Math.PI * 4) : 0;
    const crouchDrop = cur.crouch * 0.11;
    hips.position.y = DIM.hipY - crouchDrop + bounce + runBob * gaitBlend;
    const leanFwd = moving && !lateral ? 0.16 * Math.min(1, speed / 6) : 0;
    cur.lean += (leanFwd + cur.crouch * 0.12 - cur.lean) * (1 - Math.exp(-8 * dt));

    const sx = hand === 'left' ? -1 : 1;
    const turnRad = cur.turn * THREE.MathUtils.DEG2RAD * -sx;
    hips.rotation.set(cur.lean * 0.5, turnRad * 0.4, 0, 'YXZ');
    spine.rotation.set(cur.lean * 0.5, turnRad * 0.6, 0, 'YXZ');
    chest.rotation.set(0.04, 0, 0, 'YXZ');
    head.rotation.set(-cur.lean * 0.6 + 0.08, -turnRad * 0.8, 0, 'YXZ');
    body.updateMatrixWorld(true);

    // ---- legs
    for (const s of ['R', 'L']) {
      const S = side[s];
      const isRacketSide = s === handSide();
      const st = stance[isRacketSide ? 'R' : 'L'];
      const base = tA.set(st[0], 0, st[1]);
      toModel(base, tD);
      const p = (gaitPhase + (s === 'R' ? 0 : 0.5)) % 1;
      let disp, up;
      if (p < 0.5) { disp = stride * (0.5 - 2 * p) * 1; up = 0; } else {
        const u = (p - 0.5) * 2;
        disp = -stride / 2 + stride * (u * u * (3 - 2 * u));
        up = Math.sin(Math.PI * u) * lift;
      }
      toModel(tB.copy(dir).multiplyScalar(disp * gaitBlend), tB);
      const foot = cur.feet[s].copy(tD).add(tB);
      // Narrower track while running.
      if (gaitBlend > 0) foot.x *= 1 - 0.45 * gaitBlend * (lateral ? 0 : 1);
      foot.y = DIM.ankleY + up * gaitBlend;
      const toe = p >= 0.5 ? -0.35 * Math.sin(Math.PI * (p - 0.5) * 2) * gaitBlend : 0;
      const yaw = (isRacketSide ? -0.25 : 0.2) * (swinging ? 1 : 0.4) * -sx;
      const pole = tC.set(0, 0, 1).applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw).add(tB.set(foot.x * 0.6, 0, 0)).normalize();
      poseLeg(S, foot, yaw, toe, pole);
    }

    // ---- arms
    const gM = toModel(cur.g, new THREE.Vector3());
    const aM = toModel(cur.a, new THREE.Vector3());
    const nM = toModel(cur.n, new THREE.Vector3());
    quatFromYZ(aM, nM, qA);
    racketM.compose(gM, qA, one);
    handInR.copy(mA.compose(racketInHand(hand).pos, racketInHand(hand).quat, one).invert());
    const handM = new THREE.Matrix4().multiplyMatrices(racketM, handInR);
    handM.decompose(wristT, handQ, tB);
    const RS = side[handSide()];
    const outward = new THREE.Vector3(-sx, 0, 0);
    poseArm(RS, wristT, handQ, new THREE.Vector3().copy(outward).multiplyScalar(0.7).add(new THREE.Vector3(0, -1, -0.4)).normalize());

    // Off hand: cradles the throat in ready / backswing, otherwise follows its target.
    const OS = side[offSide()];
    const throat = new THREE.Vector3(0, 0.115, 0.03).applyMatrix4(racketM);
    const offT = toModel(cur.off, new THREE.Vector3());
    const offPos = offT.lerp(throat, cur.offThroat);
    const offFwd = new THREE.Vector3().copy(aM).multiplyScalar(cur.offThroat).add(tA.set(0, -0.3, 1).multiplyScalar(1 - cur.offThroat)).normalize();
    const offN = new THREE.Vector3().copy(nM).negate().lerp(tB.set(sx, 0, 0), 1 - cur.offThroat).normalize();
    quatFromYZ(offFwd, offN, qB);
    // Offset so the palm (not the wrist) sits on the target.
    const offWrist = offPos.clone().addScaledVector(offFwd, -0.06).addScaledVector(tC.set(0, 0, 1).applyQuaternion(qB), -0.02);
    poseArm(OS, offWrist, qB, new THREE.Vector3(sx * 0.7, -1, -0.4).normalize());
  }

  function setHanded(h) {
    hand = h === 'left' ? 'left' : 'right';
    attachRacket();
  }

  return { root, update, setHanded, racket: racketMesh, get handed() { return hand; } };
}

export const HUMANOID_STROKES = Object.keys(STROKES);
