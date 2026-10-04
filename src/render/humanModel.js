// Procedural athlete template (pure: no three, no DOM). An athletic 1.80 m body is modelled as
// signed-distance primitives (muscles as smooth-blended ellipsoids and round cones over the
// skeleton), clothes as hard-unioned shells (a shirt grown over the torso and cut at the hem, sleeves,
// loose shorts), shoes, head, hands, hair and headwear as their own finer meshes, and polygonized
// with surface nets (sdfMesh.js). Every vertex gets smooth skin weights from the bone its
// nearest primitive belongs to (blended across joints), a kit region (skin, shirt, shorts, sock,
// shoe…), a body part (body / head / arms: the first-person body hides the last two) and baked SDF
// ambient occlusion. skinnedHuman.js turns the parts into one SkinnedMesh per person.
//
// Model space: metres, y up, the body faces +z, the actor's right side is -x; bind pose is a
// relaxed A-pose (arms 20 degrees out, palms in, thumbs forward).
import { sdPrim, compileModel, polygonize } from './sdfMesh.js';

export const REF_HEIGHT = 1.8;

const ARM_DIR = (sx) => {
  const a = (20 * Math.PI) / 180;
  return [sx * Math.sin(a), -Math.cos(a), 0];
};
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------------ skeleton

const UPPER_ARM = 0.285;
const FOREARM = 0.255;
const SHOULDER = (sx) => [sx * 0.185, 1.445, -0.025];
const ELBOW = (sx) => add(SHOULDER(sx), ARM_DIR(sx), UPPER_ARM);
const WRIST = (sx) => add(ELBOW(sx), ARM_DIR(sx), FOREARM);
const HIP = (sx) => [sx * 0.09, 0.93, 0.0];
const KNEE = (sx) => [sx * 0.1, 0.505, 0.015];
const ANKLE = (sx) => [sx * 0.105, 0.085, -0.01];
const TOE = (sx) => [sx * 0.11, 0.02, 0.125];

/** Bones: name, parent index, bind position (model space). Bind rotations are identity. */
export const BONES = (() => {
  const list = [];
  const push = (name, parent, pos) => list.push({ name, parent: parent === null ? -1 : list.findIndex((b) => b.name === parent), pos });
  push('root', null, [0, 0, 0]);
  push('hips', 'root', [0, 0.98, -0.005]);
  push('spine', 'hips', [0, 1.1, -0.012]);
  push('chest', 'spine', [0, 1.26, -0.018]);
  push('neck', 'chest', [0, 1.49, -0.035]);
  push('head', 'neck', [0, 1.6, -0.012]);
  for (const [s, sx] of [['R', -1], ['L', 1]]) {
    push(`clavicle${s}`, 'chest', [sx * 0.025, 1.45, 0.005]);
    push(`upperArm${s}`, `clavicle${s}`, SHOULDER(sx));
    push(`foreArm${s}`, `upperArm${s}`, ELBOW(sx));
    push(`hand${s}`, `foreArm${s}`, WRIST(sx));
  }
  for (const [s, sx] of [['R', -1], ['L', 1]]) {
    push(`thigh${s}`, 'hips', HIP(sx));
    push(`shin${s}`, `thigh${s}`, KNEE(sx));
    push(`foot${s}`, `shin${s}`, ANKLE(sx));
    push(`toe${s}`, `foot${s}`, TOE(sx));
  }
  return list;
})();
export const BONE_INDEX = Object.fromEntries(BONES.map((b, i) => [b.name, i]));
const BI = BONE_INDEX;

/**
 * Canonical hand frame of a hand bone in bind pose (columns X, Y, Z): origin = wrist, +Y = toward
 * the knuckles, +Z = palm normal, +X = Y x Z (thumb side for the right hand; handPose.js
 * racketInHand uses the same frame).
 */
export function handBindBasis(side) {
  const sx = side === 'R' ? -1 : 1;
  const Y = ARM_DIR(sx);
  const Z = norm([-sx * Math.cos((20 * Math.PI) / 180), -Math.sin((20 * Math.PI) / 180), 0]); // palm faces the thigh
  const X = cross(Y, Z);
  return { X, Y, Z };
}

/** Lengths used by the animation IK (model metres). */
export const LIMBS = Object.freeze({
  upperArm: UPPER_ARM,
  foreArm: FOREARM,
  thigh: len(sub(KNEE(1), HIP(1))),
  shin: len(sub(ANKLE(1), KNEE(1))),
  hipY: 0.98,
  ankleY: 0.085,
});

// ------------------------------------------------------------------ regions and parts

export const REGION = Object.freeze({
  SKIN: 0, SHIRT: 1, TRIM: 2, SHORTS: 3, SHORTS_TRIM: 4, SOCK: 5, SHOE: 6, SOLE: 7, SHOE_ACCENT: 8,
  HAIR: 9, HEADWEAR: 10, HEADWEAR_ACCENT: 11, EYE: 12, IRIS: 13, BAND: 14, LACE: 15, PUPIL: 16,
});
export const PART = Object.freeze({ BODY: 0, HEAD: 1, ARMS: 2 });

// ------------------------------------------------------------------ body model

/** Owner rules for skin weights, stored on primitives as p.w. */
const torso = () => ({ rule: 'torso' });
const limb = (bone, parent, child, j0, j1, r0, r1) => ({ rule: 'limb', bone: BI[bone], parent: parent ? BI[parent] : -1, child: child ? BI[child] : -1, j0, j1, r0, r1 });

/** fp: the first-person torso — no neck and no arms (the camera sits where the neck would be,
 * and the first-person rig draws the forearms), so the eye is outside the closed surface. */
function bodyModel({ fp = false } = {}) {
  const prims = [];
  const P = (p, w, part = PART.BODY) => { p.w = w; p.part = part; prims.push(p); return prims.length - 1; };
  const E = sdPrim.ellipsoid;
  const C = sdPrim.roundCone;
  const T = {};
  // Torso.
  T.pelvis = P(E([0, 0.955, -0.008], [0.148, 0.112, 0.104]), torso());
  T.abdomen = P(E([0, 1.09, 0.004], [0.133, 0.13, 0.098], { k: 0.06 }), torso());
  T.ribs = P(E([0, 1.28, -0.012], [0.158, 0.17, 0.104], { k: 0.06 }), torso());
  T.back = P(E([0, 1.395, -0.045], [0.125, 0.085, 0.066], { k: 0.04 }), torso());
  T.neckBase = P(E([0, 1.475, -0.03], [0.082, 0.045, 0.062], { k: 0.04 }), torso());
  const pecs = [], scap = [], traps = [], lats = [], glutes = [];
  for (const sx of [-1, 1]) {
    pecs.push(P(E([sx * 0.07, 1.34, 0.035], [0.08, 0.055, 0.046], { k: 0.035 }), torso()));
    scap.push(P(E([sx * 0.085, 1.33, -0.07], [0.065, 0.09, 0.04], { k: 0.03 }), torso()));
    traps.push(P(E([sx * 0.072, 1.455, -0.032], [0.07, 0.042, 0.048], { k: 0.04 }), torso()));
    lats.push(P(E([sx * 0.11, 1.245, -0.03], [0.055, 0.12, 0.075], { k: 0.04 }), torso()));
    glutes.push(P(E([sx * 0.064, 0.915, -0.058], [0.076, 0.095, 0.07], { k: 0.035 }), torso()));
  }
  const torsoList = [T.pelvis, T.abdomen, T.ribs, T.back, T.neckBase, ...pecs, ...scap, ...traps, ...lats, ...glutes];
  // Neck.
  if (!fp) P(C([0, 1.44, -0.03], [0, 1.635, -0.006], 0.062, 0.054, { k: 0.04 }), limb('neck', 'chest', 'head', BONES[BI.neck].pos, BONES[BI.head].pos, 0.05, 0.04), PART.HEAD);
  // Arms.
  const arm = { R: {}, L: {} };
  for (const [s, sx] of fp ? [] : [['R', -1], ['L', 1]]) {
    const S = SHOULDER(sx), El = ELBOW(sx), W = WRIST(sx), d = ARM_DIR(sx);
    const fwd = [0, 0, 1];
    const lat = norm(cross(d, fwd));
    const wU = limb(`upperArm${s}`, `clavicle${s}`, `foreArm${s}`, S, El, 0.06, 0.045);
    const wF = limb(`foreArm${s}`, `upperArm${s}`, `hand${s}`, El, W, 0.045, 0.02);
    const A = arm[s];
    A.delt = P(E([sx * 0.192, 1.43, -0.02], [0.052, 0.07, 0.056], { k: 0.035 }), wU, PART.ARMS);
    A.upper = P(C(S, El, 0.047, 0.037, { k: 0.02 }), wU, PART.ARMS);
    A.biceps = P(C(add(add(S, d, 0.08), fwd, 0.012), add(add(S, d, 0.22), fwd, 0.012), 0.034, 0.029, { k: 0.03 }), wU, PART.ARMS);
    A.triceps = P(C(add(add(S, d, 0.06), fwd, -0.014), add(add(S, d, 0.2), fwd, -0.01), 0.038, 0.029, { k: 0.03 }), wU, PART.ARMS);
    A.fore = P(C(El, W, 0.039, 0.026, { k: 0.025, flat: 0.84, flatAxis: lat }), wF, PART.ARMS);
    A.foreMuscle = P(C(add(El, d, 0.02), add(El, d, 0.13), 0.043, 0.031, { k: 0.03, flat: 0.86, flatAxis: lat }), wF, PART.ARMS);
  }
  // Legs.
  const leg = { R: {}, L: {} };
  for (const [s, sx] of [['R', -1], ['L', 1]]) {
    const H = HIP(sx), K = KNEE(sx), A = ANKLE(sx);
    const wT = limb(`thigh${s}`, 'hips', `shin${s}`, H, K, 0.07, 0.05);
    const wS = limb(`shin${s}`, `thigh${s}`, `foot${s}`, K, A, 0.05, 0.03);
    const L = leg[s];
    L.thigh = P(C(H, K, 0.082, 0.052, { k: 0.03 }), wT);
    L.quads = P(C(add(H, [sx * 0.004, -0.08, 0.022]), add(K, [0, 0.09, 0.032]), 0.07, 0.045, { k: 0.04 }), wT);
    L.ham = P(C(add(H, [0, -0.06, -0.03]), add(K, [0, 0.1, -0.025]), 0.065, 0.04, { k: 0.04 }), wT);
    L.knee = P(E(add(K, [0, 0, 0.012]), [0.048, 0.05, 0.045], { k: 0.02 }), wS);
    L.shin = P(C(K, A, 0.048, 0.03, { k: 0.02 }), wS);
    L.calf = P(C(add(K, [sx * 0.004, -0.06, -0.028]), add(K, [0, -0.2, -0.024]), 0.052, 0.037, { k: 0.04 }), wS);
    L.ankle = P(sdPrim.sphere(A, 0.032, { k: 0.015 }), wS);
  }
  const all = prims.map((_, i) => i);
  // Clothes.
  const shirtBase = [T.pelvis, T.abdomen, T.ribs, T.back, ...pecs, ...scap, ...traps, ...lats];
  const neckC = [0, 1.47, -0.012];
  const groups = [
    { id: 'skin', prims: all },
    {
      id: 'shirt', base: shirtBase, ownerFrom: shirtBase, clipK: 0.018, unionK: 0.009,
      inflate: (x, y) => 0.0065 + 0.011 * smooth(1.2, 0.99, y),
      clip: [
        (x, y) => 0.982 - y, // hem
        // Collar opening (the first-person torso has no neck: its shirt closes over the top).
        ...(fp ? [] : [(x, y, z) => 0.074 - Math.hypot(x / 1.05, (y - neckC[1]) * 1.25, (z - neckC[2]) / 0.9)]),
      ],
    },
  ];
  for (const [s, sx] of fp ? [] : [['R', -1], ['L', 1]]) {
    const A = arm[s];
    const S = SHOULDER(sx), d = ARM_DIR(sx);
    groups.push({
      id: `sleeve${s}`, base: [A.delt, A.upper, A.biceps, A.triceps], ownerFrom: [A.delt, A.upper, A.biceps, A.triceps], clipK: 0.018, unionK: 0.009,
      inflate: (x, y, z) => 0.0068 + 0.006 * smooth(0.06, 0.13, (x - S[0]) * d[0] + (y - S[1]) * d[1] + (z - S[2]) * d[2]),
      clip: [(x, y, z) => {
        const t = (x - S[0]) * d[0] + (y - S[1]) * d[1] + (z - S[2]) * d[2];
        return t - 0.135;
      }],
    });
  }
  const shortsBase = [T.pelvis, ...glutes, leg.R.thigh, leg.R.quads, leg.R.ham, leg.L.thigh, leg.L.quads, leg.L.ham];
  groups.push({
    id: 'shorts', base: shortsBase, ownerFrom: shortsBase, clipK: 0.018, unionK: 0.009,
    inflate: (x, y) => 0.009 + 0.011 * smooth(0.86, 0.62, y),
    clip: [(x, y) => y - 1.055, (x, y) => 0.6 - y],
  });
  return {
    prims, groups, arm, leg, torsoList,
    regionOf: { skin: REGION.SKIN, shirt: REGION.SHIRT, sleeveR: REGION.SHIRT, sleeveL: REGION.SHIRT, shorts: REGION.SHORTS },
  };
}

// ------------------------------------------------------------------ skin weights

/** Up to 4 (bone, weight) pairs for a vertex owned by primitive p (rules above). */
function weightsFor(p, x, y, z, out) {
  out.length = 0;
  const w = p.w;
  if (w.rule === 'rigid') {
    out.push([w.bone, 1]);
    return out;
  }
  if (w.rule === 'torso') {
    // Height bands over hips / spine / chest; the upper sides ride the clavicles, the lower sides
    // of the pelvis follow the thighs a little (hip flexion), the glutes more.
    const yh = BONES[BI.hips].pos[1], ys = BONES[BI.spine].pos[1], yc = BONES[BI.chest].pos[1] + 0.02;
    let wh = 0, ws = 0, wc = 0;
    if (y <= yh) wh = 1;
    else if (y <= ys) { const t = smooth(yh, ys, y); wh = 1 - t; ws = t; } else if (y <= yc) { const t = smooth(ys, yc, y); ws = 1 - t; wc = t; } else wc = 1;
    const side = x < 0 ? 'R' : 'L';
    const ax = Math.abs(x);
    const wClav = wc * smooth(0.085, 0.16, ax) * smooth(1.36, 1.44, y) * 0.85;
    wc -= wClav;
    const back = z < -0.02 ? 1 : 0;
    const wThigh = wh * smooth(0.97, 0.86, y) * smooth(0.015, 0.075, ax) * (0.32 + 0.18 * back);
    wh -= wThigh;
    if (wh > 1e-4) out.push([BI.hips, wh]);
    if (ws > 1e-4) out.push([BI.spine, ws]);
    if (wc > 1e-4) out.push([BI.chest, wc]);
    if (wClav > 1e-4) out.push([BI[`clavicle${side}`], wClav]);
    if (wThigh > 1e-4) out.push([BI[`thigh${side}`], wThigh]);
    return out;
  }
  // Limb: blend toward the parent within r0 of the proximal joint, toward the child within r1 of
  // the distal joint (50/50 on the joint).
  const ax = w.j1[0] - w.j0[0], ay = w.j1[1] - w.j0[1], az = w.j1[2] - w.j0[2];
  const L = Math.hypot(ax, ay, az);
  const s = ((x - w.j0[0]) * ax + (y - w.j0[1]) * ay + (z - w.j0[2]) * az) / L;
  let wp = w.parent >= 0 ? 1 - smooth(-w.r0, w.r0, s) : 0;
  let wc = w.child >= 0 ? 1 - smooth(-w.r1, w.r1, L - s) : 0;
  if (wp + wc > 1) {
    const k = 1 / (wp + wc);
    wp *= k; wc *= k;
  }
  const wb = 1 - wp - wc;
  if (wb > 1e-4) out.push([w.bone, wb]);
  if (wp > 1e-4) out.push([w.parent, wp]);
  if (wc > 1e-4) out.push([w.child, wc]);
  return out;
}

// ------------------------------------------------------------------ part assembly

/**
 * Packs a polygonized mesh into a template part: skin indices / weights (4 per vertex), region,
 * body part, uv (cylindrical, metres / 0.06 for fabric detail), aux (paint channels).
 * spec: { regionOf(groupIndex, vertex) -> region, weights(v, x,y,z, owner, groupIndex, out),
 *         partOf(owner, groupIndex) -> PART, uvAxis(owner, groupIndex) -> { c, d } | null, aux(v...) }
 */
function packPart(mesh, spec) {
  const n = mesh.positions.length / 3;
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  const region = new Uint8Array(n);
  const part = new Uint8Array(n);
  const uv = new Float32Array(n * 2);
  const aux = new Float32Array(n * 2);
  const period = new Float32Array(n);
  const tmp = [];
  for (let v = 0; v < n; v++) {
    const x = mesh.positions[v * 3], y = mesh.positions[v * 3 + 1], z = mesh.positions[v * 3 + 2];
    const g = mesh.group[v], o = mesh.owner[v];
    spec.weights(x, y, z, o, g, tmp);
    tmp.sort((a, b) => b[1] - a[1]);
    let sum = 0;
    for (let i = 0; i < 4 && i < tmp.length; i++) sum += tmp[i][1];
    for (let i = 0; i < 4; i++) {
      if (i < tmp.length && sum > 0) {
        skinIndex[v * 4 + i] = tmp[i][0];
        skinWeight[v * 4 + i] = tmp[i][1] / sum;
      }
    }
    if (!tmp.length) { skinIndex[v * 4] = BI.root; skinWeight[v * 4] = 1; }
    region[v] = spec.regionOf(g, x, y, z, o);
    part[v] = spec.partOf(o, g, x, y, z);
    const ax = spec.uvAxis ? spec.uvAxis(o, g) : null;
    if (ax) {
      const { c, d } = ax;
      const px = x - c[0], py = y - c[1], pz = z - c[2];
      const along = px * d[0] + py * d[1] + pz * d[2];
      // Reference frame around the axis: 'front' = +z projected, seam at the back.
      let fx = 0, fy = 0, fz = 1;
      const fd = fz * d[2];
      fx -= d[0] * fd; fy -= d[1] * fd; fz -= d[2] * fd;
      const fl = Math.hypot(fx, fy, fz) || 1;
      fx /= fl; fy /= fl; fz /= fl;
      const sxv = d[1] * fz - d[2] * fy, syv = d[2] * fx - d[0] * fz, szv = d[0] * fy - d[1] * fx;
      const qx = px - d[0] * along, qy = py - d[1] * along, qz = pz - d[2] * along;
      const ang = Math.atan2(qx * sxv + qy * syv + qz * szv, qx * fx + qy * fy + qz * fz);
      const r = ax.r || 0.1;
      uv[v * 2] = (ang * r) / 0.06;
      uv[v * 2 + 1] = along / 0.06;
      period[v] = (Math.PI * 2 * r) / 0.06;
    }
    if (spec.aux) spec.aux(x, y, z, o, g, aux, v);
  }
  const out = {
    positions: mesh.positions, normals: mesh.normals, index: mesh.index, ao: mesh.ao,
    skinIndex, skinWeight, region, part, uv, aux, stats: mesh.stats,
  };
  if (spec.uvAxis) fixUvSeams(out, period);
  return out;
}

/**
 * Cylindrical uv seams: a triangle whose u values wrap around (spread > half a period) gets copies
 * of its low-u vertices shifted by one period, so the knit pattern is not smeared across it.
 */
function fixUvSeams(p, period) {
  const n0 = p.positions.length / 3;
  const extra = [];
  const idx = p.index;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const P = period[a];
    if (!(P > 0) || period[b] !== P || period[c] !== P) continue;
    const ua = p.uv[a * 2], ub = p.uv[b * 2], uc = p.uv[c * 2];
    const lo = Math.min(ua, ub, uc), hi = Math.max(ua, ub, uc);
    if (hi - lo < P / 2) continue;
    const mid = (lo + hi) / 2;
    for (let k = 0; k < 3; k++) {
      const v = idx[t + k];
      if (p.uv[v * 2] < mid) extra.push({ src: v, shift: P, t: t + k });
    }
  }
  if (!extra.length) return;
  const m = extra.length;
  const grow = (arr, size) => {
    const out = new arr.constructor((n0 + m) * size);
    out.set(arr);
    return out;
  };
  const pos = grow(p.positions, 3), nrm = grow(p.normals, 3), ao = grow(p.ao, 1), si = grow(p.skinIndex, 4), sw = grow(p.skinWeight, 4);
  const reg = grow(p.region, 1), part = grow(p.part, 1), uv = grow(p.uv, 2), aux = grow(p.aux, 2);
  const index = p.index.slice();
  extra.forEach((e, i) => {
    const d = n0 + i, s = e.src;
    for (let k = 0; k < 3; k++) { pos[d * 3 + k] = p.positions[s * 3 + k]; nrm[d * 3 + k] = p.normals[s * 3 + k]; }
    for (let k = 0; k < 4; k++) { si[d * 4 + k] = p.skinIndex[s * 4 + k]; sw[d * 4 + k] = p.skinWeight[s * 4 + k]; }
    ao[d] = p.ao[s]; reg[d] = p.region[s]; part[d] = p.part[s];
    uv[d * 2] = p.uv[s * 2] + e.shift; uv[d * 2 + 1] = p.uv[s * 2 + 1];
    aux[d * 2] = p.aux[s * 2]; aux[d * 2 + 1] = p.aux[s * 2 + 1];
    index[e.t] = d;
  });
  Object.assign(p, { positions: pos, normals: nrm, ao, skinIndex: si, skinWeight: sw, region: reg, part, uv, aux, index });
}

// ------------------------------------------------------------------ head, hair, headwear, eyes

/** The head sits this much lower than first authored (the neck read too long). */
const HEAD_DY = -0.016;
const hy = (y) => y + HEAD_DY;
const HEAD_C = [0, hy(1.715), -0.012];

function headPrims() {
  const prims = [];
  const P = (p) => { prims.push(p); return prims.length - 1; };
  const E = sdPrim.ellipsoid;
  P(E(HEAD_C, [0.076, 0.096, 0.098]));
  P(E([0, hy(1.655), 0.03], [0.06, 0.075, 0.065], { k: 0.03 }));
  P(E([0, hy(1.615), 0.04], [0.052, 0.036, 0.055], { k: 0.025 }));
  P(E([0, hy(1.598), 0.075], [0.025, 0.02, 0.02], { k: 0.015 }));
  for (const sx of [-1, 1]) P(E([sx * 0.042, hy(1.678), 0.062], [0.024, 0.018, 0.022], { k: 0.02 }));
  P(sdPrim.roundCone([0, hy(1.708), 0.088], [0, hy(1.672), 0.106], 0.009, 0.013, { k: 0.01 }));
  P(E([0, hy(1.665), 0.1], [0.018, 0.011, 0.013], { k: 0.01 }));
  P(E([0, hy(1.722), 0.075], [0.054, 0.012, 0.024], { k: 0.02 }));
  P(E([0, hy(1.632), 0.088], [0.021, 0.011, 0.01], { k: 0.008 }));
  for (const sx of [-1, 1]) P(E([sx * 0.078, hy(1.688), -0.008], [0.012, 0.029, 0.019], { k: 0.008 }));
  P(sdPrim.roundCone([0, hy(1.565), -0.02], [0, hy(1.63), -0.01], 0.048, 0.049, { k: 0.02 }));
  for (const sx of [-1, 1]) P(sdPrim.ellipsoid([sx * 0.031, hy(1.6995), 0.0935], [0.0128, 0.0056, 0.011], { k: 0.0035, op: 'sub' }));
  return prims;
}

/** Hairline height around the head (theta: 0 = front, +-PI = back). */
export const HEAD_OFFSET = HEAD_DY;
export function hairlineY(x, z) {
  const th = Math.abs(Math.atan2(x, z));
  if (th < 0.55) return hy(1.738);
  if (th < 1.35) return hy(1.738 - 0.012 * smooth(0.55, 1.35, th));
  if (th < 1.85) return hy(1.726); // above the ears
  return hy(1.726 - 0.1 * smooth(1.85, 2.7, th));
}

const HAIR_STYLES = {
  buzz: { inflate: 0.0028, top: 0 },
  short: { inflate: 0.0065, top: 0.006 },
  medium: { inflate: 0.01, top: 0.012, back: 0.006 },
  ponytail: { inflate: 0.008, top: 0.006, tail: true },
  bun: { inflate: 0.008, top: 0.004, bun: true },
};
export const HAIR_STYLE_NAMES = Object.keys(HAIR_STYLES);
export const HEADWEAR_NAMES = ['none', 'cap', 'visor', 'headband'];

function hairModel(style) {
  const st = HAIR_STYLES[style] || HAIR_STYLES.short;
  const prims = [sdPrim.ellipsoid(HEAD_C, [0.076, 0.096, 0.098])];
  const extra = [];
  if (st.tail) {
    prims.push(sdPrim.ellipsoid([0, hy(1.69), -0.106], [0.026, 0.03, 0.026]));
    prims.push(sdPrim.roundCone([0, hy(1.68), -0.115], [0, hy(1.54), -0.13], 0.021, 0.009));
    extra.push(1, 2);
  }
  if (st.bun) {
    prims.push(sdPrim.sphere([0, hy(1.79), -0.075], 0.036));
    extra.push(1);
  }
  const groups = [{
    id: 'hair', prims: [0], extra, clipK: 0.008,
    // Zero thickness at the hairline, full volume 2.5 cm above it: hair grows out of the scalp
    // instead of sitting on it like a cap.
    inflate: (x, y, z) => (st.inflate + st.top * smooth(hy(1.74), hy(1.81), y) + (st.back || 0) * smooth(-0.03, -0.09, z)) * smooth(hairlineY(x, z) - 0.004, hairlineY(x, z) + 0.026, y) - 0.0015,
    clip: [(x, y, z) => (extra.length && z < -0.07 ? -1 : hairlineY(x, z) - 0.003 - y)],
  }];
  return compileModel({ prims, groups });
}

function headwearModel(kind) {
  const prims = [sdPrim.ellipsoid(HEAD_C, [0.076, 0.096, 0.098])];
  const groups = [];
  if (kind === 'cap' || kind === 'visor') {
    // Brim: a thin rounded slab over the eyes, tilted down a little.
    const a = -0.16;
    const basis = [[1, 0, 0], [0, Math.cos(a), Math.sin(a)], [0, -Math.sin(a), Math.cos(a)]];
    prims.push(sdPrim.roundBox([0, hy(1.738), 0.112], [0.064, 0.0045, 0.052], 0.004, basis));
    prims.push(sdPrim.sphere([0, hy(1.818), -0.008], 0.009));
    if (kind === 'cap') {
      groups.push({ id: 'crown', prims: [0], inflate: () => 0.013, clipK: 0.006, clip: [(x, y, z) => hy(1.733) - 0.012 * smooth(0.0, -0.09, z) - y] });
      groups.push({ id: 'button', prims: [2] });
    } else {
      groups.push({ id: 'band', prims: [0], inflate: () => 0.009, clipK: 0.005, clip: [(x, y) => Math.max(hy(1.722) - y, y - hy(1.756))] });
    }
    groups.push({ id: 'brim', prims: [1] });
  } else if (kind === 'headband') {
    groups.push({ id: 'band', prims: [0], inflate: () => 0.0085, clipK: 0.005, clip: [(x, y, z) => Math.max(hy(1.708) - 0.01 * smooth(0, -0.1, z) - y, y - hy(1.742) + 0.01 * smooth(0, -0.1, z))] });
  }
  return groups.length ? compileModel({ prims, groups }) : null;
}

/** Analytic eyeball (sclera with iris and pupil regions), in model space. */
function eyeMesh(sx, seg) {
  const c = [sx * 0.031, hy(1.6995), 0.0768];
  const r = 0.0115;
  const rows = seg, cols = seg * 2;
  const pos = [], nrm = [], idx = [], reg = [], ao = [];
  for (let i = 0; i <= rows; i++) {
    const th = (i / rows) * Math.PI;
    for (let j = 0; j <= cols; j++) {
      const ph = (j / cols) * Math.PI * 2;
      // Pole on +z (looking forward): iris and pupil around the pole.
      const nx = Math.sin(th) * Math.cos(ph), ny = Math.sin(th) * Math.sin(ph), nz = Math.cos(th);
      pos.push(c[0] + nx * r, c[1] + ny * r, c[2] + nz * r);
      nrm.push(nx, ny, nz);
      reg.push(nz > 0.975 ? REGION.PUPIL : nz > 0.87 ? REGION.IRIS : REGION.EYE);
      // The upper lid shades the top of the eye.
      ao.push(ny > 0.35 ? 0.45 : 0.85 - 0.2 * Math.max(0, ny));
    }
  }
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const a = i * (cols + 1) + j, b = a + cols + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nrm), index: new Uint32Array(idx), regions: new Uint8Array(reg), ao: new Float32Array(ao) };
}

// ------------------------------------------------------------------ hands and shoes

/** Hand primitives in canonical hand space (origin wrist, +Y knuckles, +Z palm, +X thumb for R). */
function handModel(side, kind) {
  const th = side === 'R' ? 1 : -1;
  const prims = [];
  const P = (p) => { prims.push(p); return prims.length - 1; };
  const C = sdPrim.roundCone;
  P(sdPrim.roundBox([0, 0.05, 0.002], [0.04, 0.047, 0.0155], 0.013));
  P(sdPrim.ellipsoid([th * 0.022, 0.034, 0.011], [0.021, 0.03, 0.015], { k: 0.015 }));
  P(C([0, -0.02, 0], [0, 0.012, 0.001], 0.027, 0.029, { k: 0.015 }));
  if (kind === 'fist') {
    P(C([-th * 0.036, 0.098, 0.011], [th * 0.03, 0.1, 0.011], 0.019, 0.02, { k: 0.012 }));
    P(C([-th * 0.034, 0.086, 0.046], [th * 0.027, 0.088, 0.048], 0.017, 0.018, { k: 0.012 }));
    P(C([-th * 0.03, 0.062, 0.054], [th * 0.016, 0.066, 0.056], 0.0135, 0.0145, { k: 0.01 }));
    P(C([th * 0.03, 0.028, 0.016], [th * 0.036, 0.064, 0.044], 0.0135, 0.0115, { k: 0.01 }));
    P(C([th * 0.036, 0.064, 0.044], [th * 0.022, 0.086, 0.059], 0.0115, 0.0095, { k: 0.006 }));
  } else {
    // Relaxed hand, fingers together and gently curled (a mitten reads cleanly at play distance).
    P(sdPrim.roundBox([-th * 0.002, 0.118, 0.012], [0.037, 0.03, 0.0105], 0.0095, null, { k: 0.012 }));
    P(C([-th * 0.003, 0.142, 0.016], [-th * 0.004, 0.168, 0.034], 0.013, 0.0105, { k: 0.012 }));
    P(C([th * 0.022, 0.155, 0.02], [th * 0.022, 0.172, 0.036], 0.0105, 0.009, { k: 0.01 }));
    P(C([-th * 0.026, 0.148, 0.02], [-th * 0.026, 0.163, 0.034], 0.0098, 0.0085, { k: 0.01 }));
    P(C([th * 0.032, 0.026, 0.013], [th * 0.05, 0.056, 0.03], 0.0125, 0.0108, { k: 0.01 }));
    P(C([th * 0.05, 0.056, 0.03], [th * 0.056, 0.081, 0.044], 0.0108, 0.0092, { k: 0.005 }));
  }
  return compileModel({ prims, groups: [{ id: 'hand', prims: prims.map((_, i) => i) }] });
}

function shoeModel(sx) {
  const x = sx * 0.108;
  const prims = [];
  const P = (p) => { prims.push(p); return prims.length - 1; };
  const sole = P(sdPrim.roundBox([x, 0.0135, 0.045], [0.047, 0.0135, 0.136], 0.012));
  const toeSole = P(sdPrim.ellipsoid([x, 0.014, 0.15], [0.046, 0.014, 0.05], { k: 0.02 }));
  const up = P(sdPrim.roundBox([x, 0.05, 0.03], [0.042, 0.034, 0.115], 0.03));
  const toeBox = P(sdPrim.ellipsoid([x, 0.042, 0.128], [0.044, 0.03, 0.058], { k: 0.025 }));
  const heel = P(sdPrim.ellipsoid([x - sx * 0.001, 0.062, -0.058], [0.041, 0.05, 0.036], { k: 0.025 }));
  const collar = P(sdPrim.roundCone([x - sx * 0.003, 0.07, -0.028], [x - sx * 0.003, 0.118, -0.024], 0.046, 0.043, { k: 0.02 }));
  const tongue = P(sdPrim.ellipsoid([x, 0.098, 0.03], [0.03, 0.03, 0.05], { k: 0.02 }));
  const hole = P(sdPrim.roundCone([x - sx * 0.003, 0.098, -0.02], [x - sx * 0.003, 0.25, -0.02], 0.0335, 0.0335, { k: 0.008, op: 'sub' }));
  return {
    model: compileModel({
      prims,
      groups: [
        { id: 'sole', prims: [sole, toeSole] },
        { id: 'upper', prims: [up, toeBox, heel, collar, tongue, hole] },
      ],
    }),
    x,
  };
}

// ------------------------------------------------------------------ transforms

/** Transforms a polygonized mesh from canonical hand space into bind model space. */
function toBindHand(mesh, side) {
  const { X, Y, Z } = handBindBasis(side);
  const W = WRIST(side === 'R' ? -1 : 1);
  const n = mesh.positions.length / 3;
  for (let v = 0; v < n; v++) {
    const x = mesh.positions[v * 3], y = mesh.positions[v * 3 + 1], z = mesh.positions[v * 3 + 2];
    mesh.positions[v * 3] = W[0] + X[0] * x + Y[0] * y + Z[0] * z;
    mesh.positions[v * 3 + 1] = W[1] + X[1] * x + Y[1] * y + Z[1] * z;
    mesh.positions[v * 3 + 2] = W[2] + X[2] * x + Y[2] * y + Z[2] * z;
    const a = mesh.normals[v * 3], b = mesh.normals[v * 3 + 1], c = mesh.normals[v * 3 + 2];
    mesh.normals[v * 3] = X[0] * a + Y[0] * b + Z[0] * c;
    mesh.normals[v * 3 + 1] = X[1] * a + Y[1] * b + Z[1] * c;
    mesh.normals[v * 3 + 2] = X[2] * a + Y[2] * b + Z[2] * c;
  }
  return mesh;
}

// ------------------------------------------------------------------ template

/** Mesh resolution (cell size, m) per part and level of detail. */
export const LOD_CELLS = Object.freeze({
  0: { body: 0.015, head: 0.0075, hand: 0.0078, shoe: 0.0095, hair: 0.0105, eyeSeg: 8 },
  1: { body: 0.028, head: 0.013, hand: 0.014, shoe: 0.016, hair: 0.016, eyeSeg: 5 },
});

const rigid = (bone) => (x, y, z, o, g, out) => { out.length = 0; out.push([BI[bone], 1]); return out; };

function buildBody(cell, opts = {}) {
  const M = bodyModel(opts);
  const model = compileModel(M);
  const mesh = polygonize(model, { cell, aabb: [-0.44, 0.06, -0.16, 0.44, 1.7, 0.17] });
  const groupRegion = M.groups.map((g) => M.regionOf[g.id] ?? REGION.SKIN);
  const shinS = { R: [KNEE(-1), ANKLE(-1)], L: [KNEE(1), ANKLE(1)] };
  return packPart(mesh, {
    weights: (x, y, z, o, g, out) => weightsFor(M.prims[o], x, y, z, out),
    regionOf: (g) => groupRegion[g],
    partOf: (o) => M.prims[o].part ?? PART.BODY,
    uvAxis: (o) => {
      const w = M.prims[o].w;
      if (w.rule === 'torso') return { c: [0, 0, -0.01], d: [0, 1, 0], r: 0.14 };
      return { c: w.j0, d: norm(sub(w.j1, w.j0)), r: 0.06 };
    },
    aux: (x, y, z, o, g, aux, v) => {
      // aux.x: height above the ankle along the shin (socks) or distance up from the wrist
      // (wristbands); aux.y: unused here.
      const w = M.prims[o].w;
      aux[v * 2] = 9;
      if (w.rule === 'limb' && (w.bone === BI.shinR || w.bone === BI.shinL)) {
        const side = w.bone === BI.shinR ? 'R' : 'L';
        const [K, A] = shinS[side];
        const d = norm(sub(K, A));
        aux[v * 2] = (x - A[0]) * d[0] + (y - A[1]) * d[1] + (z - A[2]) * d[2];
      } else if (w.rule === 'limb' && (w.bone === BI.foreArmR || w.bone === BI.foreArmL || w.bone === BI.handR || w.bone === BI.handL)) {
        const side = w.bone === BI.foreArmR || w.bone === BI.handR ? -1 : 1;
        const W = WRIST(side), d = ARM_DIR(side);
        aux[v * 2] = 5 + -((x - W[0]) * d[0] + (y - W[1]) * d[1] + (z - W[2]) * d[2]); // 5 + metres up the forearm
      }
    },
  });
}

function buildHead(cell) {
  const prims = headPrims();
  const model = compileModel({ prims, groups: [{ id: 'head', prims: prims.map((_, i) => i) }] });
  const mesh = polygonize(model, { cell, aabb: [-0.1, hy(1.53), -0.12, 0.1, hy(1.83), 0.13] });
  return packPart(mesh, {
    weights: rigid('head'),
    regionOf: () => REGION.SKIN,
    partOf: () => PART.HEAD,
    aux: (x, y, z, o, g, aux, v) => {
      // Paint: eyebrows (x) and lips (y), soft-edged.
      let brow = 0;
      const ax = Math.abs(x);
      if (z > 0.055 && ax > 0.01 && ax < 0.058) {
        const yc = hy(1.7245) + 0.004 * smooth(0.012, 0.03, ax) - 0.006 * smooth(0.035, 0.058, ax);
        brow = smooth(0.0055, 0.0018, Math.abs(y - yc)) * smooth(0.01, 0.017, ax) * smooth(0.06, 0.052, ax);
      }
      let lip = 0;
      if (z > 0.07) {
        const dx = x / 0.022, dy = (y - hy(1.6325)) / 0.0105;
        lip = smooth(1.15, 0.75, Math.hypot(dx, dy));
      }
      aux[v * 2] = brow;
      aux[v * 2 + 1] = lip;
    },
  });
}

function buildHand(side, kind, cell) {
  const model = handModel(side, kind);
  const mesh = polygonize(model, { cell, aabb: [-0.075, -0.035, -0.035, 0.075, 0.18, 0.08] });
  toBindHand(mesh, side);
  return packPart(mesh, { weights: rigid(`hand${side}`), regionOf: () => REGION.SKIN, partOf: () => PART.ARMS });
}

function buildShoe(side, cell) {
  const sx = side === 'R' ? -1 : 1;
  const { model, x: sxc } = shoeModel(sx);
  const mesh = polygonize(model, { cell, aabb: [sxc - 0.07, -0.005, -0.12, sxc + 0.07, 0.15, 0.22] });
  const T = TOE(sx);
  return packPart(mesh, {
    weights: (x, y, z, o, g, out) => {
      out.length = 0;
      const t = smooth(T[2] - 0.035, T[2] + 0.02, z);
      if (1 - t > 1e-4) out.push([BI[`foot${side}`], 1 - t]);
      if (t > 1e-4) out.push([BI[`toe${side}`], t]);
      return out;
    },
    regionOf: (g, x, y, z) => {
      if (g === 0) return REGION.SOLE;
      const lx = (x - sxc) * -sx; // + = outside of the foot... any side
      void lx;
      if (y > 0.066 && z > -0.005 && z < 0.112 && Math.abs(x - sxc) < 0.024) return REGION.LACE;
      const band = (z - 0.0) + 1.15 * (y - 0.045);
      if (y > 0.028 && y < 0.09 && Math.abs(band - 0.02) < 0.014 && Math.abs(x - sxc) > 0.03) return REGION.SHOE_ACCENT;
      if (z < -0.07 && y > 0.03) return REGION.SHOE_ACCENT; // heel tab
      return REGION.SHOE;
    },
    partOf: () => PART.BODY,
  });
}

function buildHair(style, cell) {
  const model = hairModel(style);
  const mesh = polygonize(model, { cell, aabb: [-0.1, 1.5, -0.16, 0.1, 1.85, 0.12] });
  return packPart(mesh, { weights: rigid('head'), regionOf: () => REGION.HAIR, partOf: () => PART.HEAD });
}

function buildHeadwear(kind, cell) {
  const model = headwearModel(kind);
  if (!model) return null;
  const mesh = polygonize(model, { cell, aabb: [-0.1, 1.68, -0.12, 0.1, 1.84, 0.18] });
  const ids = model.groups.map((g) => g.id);
  return packPart(mesh, {
    weights: rigid('head'),
    regionOf: (g, x, y, z) => {
      const id = ids[g];
      if (id === 'brim' || id === 'button') return REGION.HEADWEAR_ACCENT;
      if (id === 'crown' && z > 0.06 && Math.abs(x) < 0.026 && y > 1.748 && y < 1.782) return REGION.HEADWEAR_ACCENT; // logo patch
      return REGION.HEADWEAR;
    },
    partOf: () => PART.HEAD,
  });
}

function buildEyes(seg) {
  const parts = [];
  for (const sx of [-1, 1]) {
    const e = eyeMesh(sx, seg);
    const n = e.positions.length / 3;
    const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4);
    for (let v = 0; v < n; v++) { skinIndex[v * 4] = BI.head; skinWeight[v * 4] = 1; }
    parts.push({
      positions: e.positions, normals: e.normals, index: e.index, ao: e.ao,
      skinIndex, skinWeight, region: e.regions, part: new Uint8Array(n).fill(PART.HEAD), uv: new Float32Array(n * 2), aux: new Float32Array(n * 2),
    });
  }
  return mergeParts(parts);
}

/** Concatenates packed parts (any subset of the same attribute set). */
export function mergeParts(parts) {
  const list = parts.filter(Boolean);
  let nv = 0, ni = 0;
  for (const p of list) { nv += p.positions.length / 3; ni += p.index.length; }
  const out = {
    positions: new Float32Array(nv * 3), normals: new Float32Array(nv * 3), ao: new Float32Array(nv),
    skinIndex: new Uint16Array(nv * 4), skinWeight: new Float32Array(nv * 4), region: new Uint8Array(nv),
    part: new Uint8Array(nv), uv: new Float32Array(nv * 2), aux: new Float32Array(nv * 2), index: new Uint32Array(ni),
  };
  let ov = 0, oi = 0;
  for (const p of list) {
    const n = p.positions.length / 3;
    out.positions.set(p.positions, ov * 3);
    out.normals.set(p.normals, ov * 3);
    out.ao.set(p.ao, ov);
    out.skinIndex.set(p.skinIndex, ov * 4);
    out.skinWeight.set(p.skinWeight, ov * 4);
    out.region.set(p.region, ov);
    out.part.set(p.part, ov);
    out.uv.set(p.uv, ov * 2);
    out.aux.set(p.aux, ov * 2);
    for (let i = 0; i < p.index.length; i++) out.index[oi + i] = p.index[i] + ov;
    ov += n;
    oi += p.index.length;
  }
  return out;
}

const templates = new Map();

/**
 * The athlete template for a level of detail (cached): { lod, body, head, eyes, hands: { fistR,
 * fistL, openR, openL }, shoes: { R, L }, hair: { style: part }, headwear: { kind: part|null },
 * stats: { ms, triangles } }. Hair and headwear variants are built lazily via hairPart / headwearPart.
 */
export function humanTemplate(lod = 0) {
  const key = lod ? 1 : 0;
  if (templates.has(key)) return templates.get(key);
  const c = LOD_CELLS[key];
  const t0 = nowMs();
  const tpl = {
    lod: key,
    body: buildBody(c.body),
    head: buildHead(c.head),
    eyes: buildEyes(c.eyeSeg),
    hands: { fistR: buildHand('R', 'fist', c.hand), fistL: buildHand('L', 'fist', c.hand), openR: buildHand('R', 'open', c.hand), openL: buildHand('L', 'open', c.hand) },
    shoes: { R: buildShoe('R', c.shoe), L: buildShoe('L', c.shoe) },
    hair: {},
    headwear: {},
    cells: c,
  };
  tpl.stats = { ms: nowMs() - t0 };
  templates.set(key, tpl);
  return tpl;
}

/** The first-person torso (no neck, no arms) for a template (cached on it). */
export function fpBodyPart(tpl) {
  if (!tpl.fpBody) tpl.fpBody = buildBody(tpl.cells.body, { fp: true });
  return tpl.fpBody;
}

/** Hair part of a style for a template (cached on it). */
export function hairPart(tpl, style) {
  const s = HAIR_STYLES[style] ? style : 'short';
  if (!(s in tpl.hair)) tpl.hair[s] = buildHair(s, tpl.cells.hair);
  return tpl.hair[s];
}
/** Headwear part ('none' | 'cap' | 'visor' | 'headband') for a template (cached), or null. */
export function headwearPart(tpl, kind) {
  const k = HEADWEAR_NAMES.includes(kind) ? kind : 'none';
  if (!(k in tpl.headwear)) tpl.headwear[k] = k === 'none' ? null : buildHeadwear(k, tpl.cells.hair);
  return tpl.headwear[k];
}

/**
 * The parts of one person: body + head + eyes + the racket hand closed (fist) and the other open
 * + shoes + hair + headwear, merged. handed: 'right' | 'left'.
 */
export function assembleHuman(tpl, { handed = 'right', hair = 'short', headwear = 'none', fp = false } = {}) {
  if (fp) return mergeParts([fpBodyPart(tpl), tpl.shoes.R, tpl.shoes.L]);
  const racketSide = handed === 'left' ? 'L' : 'R';
  const hands = racketSide === 'R' ? [tpl.hands.fistR, tpl.hands.openL] : [tpl.hands.openR, tpl.hands.fistL];
  const hw = headwearPart(tpl, headwear);
  // A cap hides the top of the hair; long styles keep their tail / bun under it.
  return mergeParts([tpl.body, tpl.head, tpl.eyes, ...hands, tpl.shoes.R, tpl.shoes.L, hairPart(tpl, hair), hw]);
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
