// Bakes the realistic athletes (assets/people/athletes.glb + textures) from MakeHuman 1.1 assets
// (CC0 1.0, see THIRD_PARTY_NOTICES.md). Offline build step; the app only loads the output.
//
//   node tools/people/fetch-sources.mjs [cacheDir]          # once: MakeHuman base mesh, targets, rig, proxies
//   npm i --no-save meshoptimizer@0.22 pngjs@7               # bake-time only (LOD simplification, PNG I/O)
//   node tools/people/bake.mjs [--src cacheDir] [--out assets/people]
//   node tools/people/encode-textures.mjs                     # PNG -> WebP through headless Chromium
//
// Per body (athletic male, athletic female): the hm08 base mesh morphed with the macro targets,
// scaled to metres (male 1.80 m), lifted by the shoe sole; skin weights from MakeHuman's default
// weights folded onto the game's 22-bone skeleton (render/humanModel.js BONES order) with bind
// joints taken from the morphed skeleton helpers; the racket hand's fingers wrapped around a padel
// grip (the off hand relaxed) at bake time; clothing shells (shirt, shorts) grown from the body
// with the skin under them removed; shoes; eyes, eyebrows and eyelashes fitted from the MakeHuman
// proxies; hair styles as alpha cards; per-vertex region, part, ambient occlusion; an LOD1 by
// attribute-aware simplification. Right-handed; the runtime mirrors for left-handers.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMH, morph, joints } from './mh.mjs';
import { writeGlb } from './glb.mjs';
import { DEFAULT_SRC } from './fetch-sources.mjs';
import * as V from './vec.mjs';
import { REF_HEIGHT, SOLE, BONE_NAMES, BONE_PARENT, BI, REGION, PART, mergeParts, setWeights, computeNormals } from './parts.mjs';
import { buildClothes } from './clothes.mjs';
import { fitProxy, PROXY_SETS } from './proxies.mjs';
import { bakeAO } from './ao.mjs';
import { simplifyPart } from './lod.mjs';
import { buildTextures } from './textures.mjs';
import { buildShoes, buildHeadwear } from './gear.mjs';
import { buildFpArm } from './fparm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SRC = arg('--src', DEFAULT_SRC);
const OUT = arg('--out', join(ROOT, 'assets', 'people'));

/** Athletic presets (MakeHuman macro sliders, 0..1). */
const PRESETS = {
  male: { gender: 1, age: 0.5, muscle: 0.8, weight: 0.4, height: 0.62, proportions: 0.9, race: { african: 0.12, asian: 0.08, caucasian: 0.8 } },
  female: { gender: 0, age: 0.5, muscle: 0.66, weight: 0.4, height: 0.7, proportions: 0.9, race: { african: 0.12, asian: 0.08, caucasian: 0.8 } },
};

/** MakeHuman bone -> game bones with shares. */
export function mapBone(mhName) {
  const side = mhName.endsWith('.L') ? 'L' : mhName.endsWith('.R') ? 'R' : '';
  const b = mhName.replace(/\.(L|R)$/, '');
  if (b === 'root' || b === 'spine05' || b === 'pelvis') return [['hips', 1]];
  if (b === 'spine04') return [['spine', 1]];
  if (b === 'spine03') return [['spine', 0.6], ['chest', 0.4]];
  if (b === 'spine02' || b === 'spine01' || b === 'breast') return [['chest', 1]];
  if (b === 'clavicle') return [[`clavicle${side}`, 1]];
  if (b === 'shoulder01') return [[`clavicle${side}`, 0.35], [`upperArm${side}`, 0.65]];
  if (b.startsWith('upperarm')) return [[`upperArm${side}`, 1]];
  if (b.startsWith('lowerarm')) return [[`foreArm${side}`, 1]];
  if (b === 'wrist' || b.startsWith('metacarpal') || b.startsWith('finger')) return [[`hand${side}`, 1]];
  if (b === 'neck01' || b === 'neck02') return [['neck', 1]];
  if (b === 'neck03') return [['neck', 0.5], ['head', 0.5]];
  if (b.startsWith('upperleg')) return [[`thigh${side}`, 1]];
  if (b.startsWith('lowerleg')) return [[`shin${side}`, 1]];
  if (b === 'foot') return [[`foot${side}`, 1]];
  if (b.startsWith('toe')) return [[`toe${side}`, 1]];
  return [['head', 1]]; // head, jaw, eyes, face muscles, tongue
}

// ------------------------------------------------------------------ base body

function buildBase(mh, name, params, unit) {
  const { pos: P0, used } = morph(mh, params);
  const nAll = P0.length / 3;
  const groups = mh.obj.groups;
  const bodyG = groups.indexOf('body');
  let ymin = Infinity, ymax = -Infinity;
  for (const f of mh.obj.faces) if (f.g === bodyG) for (const i of f.v) { ymin = Math.min(ymin, P0[i * 3 + 1]); ymax = Math.max(ymax, P0[i * 3 + 1]); }
  const s = unit || REF_HEIGHT / (ymax - ymin);
  const pos = new Float64Array(nAll * 3);
  for (let i = 0; i < nAll; i++) {
    pos[i * 3] = P0[i * 3] * s;
    pos[i * 3 + 1] = (P0[i * 3 + 1] - ymin) * s + SOLE;
    pos[i * 3 + 2] = P0[i * 3 + 2] * s;
  }
  const J0 = joints(mh, pos);
  const bone = (b) => mh.skel.bones[b];
  const head = (b) => J0[bone(b).head];
  const tail = (b) => J0[bone(b).tail];
  const P = {
    root: [0, 0, 0], hips: head('spine05'), spine: head('spine04'), chest: head('spine02'), neck: head('neck01'), head: head('head'),
  };
  for (const [S, mhS] of [['R', 'R'], ['L', 'L']]) {
    P[`clavicle${S}`] = head(`clavicle.${mhS}`);
    P[`upperArm${S}`] = head(`upperarm01.${mhS}`);
    P[`foreArm${S}`] = head(`lowerarm01.${mhS}`);
    P[`hand${S}`] = head(`wrist.${mhS}`);
    P[`thigh${S}`] = V.lerp(head(`upperleg01.${mhS}`), head(`upperleg02.${mhS}`), 0.55);
    P[`shin${S}`] = head(`lowerleg01.${mhS}`);
    P[`foot${S}`] = head(`foot.${mhS}`);
    P[`toe${S}`] = V.mean([1, 2, 3, 4, 5].map((k) => head(`toe${k}-1.${mhS}`)));
  }
  // Raw MakeHuman weights per vertex (bone name -> weight) and the game-bone weights.
  const mhW = Array.from({ length: nAll }, () => new Map());
  for (const [b, list] of Object.entries(mh.weights.weights)) for (const [i, w] of list) mhW[i].set(b, (mhW[i].get(b) || 0) + w);
  const gameW = mhW.map((m) => {
    const acc = new Map();
    let sum = 0;
    for (const [b, w] of m) for (const [g, k] of mapBone(b)) { acc.set(g, (acc.get(g) || 0) + w * k); sum += w * k; }
    if (sum <= 0) return null;
    for (const [g, w] of acc) acc.set(g, w / sum);
    return acc;
  });
  const hand = {};
  for (const S of ['R', 'L']) hand[S] = handFrame(J0, mh, S);
  return { name, params, used, s, ymin, pos, J: J0, P, mhW, gameW, hand, mh };
}

/** Canonical hand frame (origin wrist, +Y to the knuckles, +Z palm normal, +X = Y x Z) from MH joints. */
function handFrame(J, mh, S) {
  const h = (b) => J[mh.skel.bones[b].head];
  const W = h(`wrist.${S}`);
  const knuck = V.mean([h(`finger2-1.${S}`), h(`finger3-1.${S}`), h(`finger4-1.${S}`)]);
  const f = V.norm(V.sub(knuck, W));
  const l = V.norm(V.sub(h(`finger2-1.${S}`), h(`finger5-1.${S}`))); // toward the thumb side
  let n = S === 'L' ? V.cross(f, l) : V.cross(l, f);
  n = V.norm(V.add(n, f, -V.dot(n, f)));
  const X = V.norm(V.cross(f, n));
  return { W, Y: f, Z: n, X };
}

// ------------------------------------------------------------------ finger posing (bake time)

const GRIP = { forward: 0.071, palm: 0.037, angleDeg: 47, thumbIP: [0.017, 0.026, 0.036], thumbTip: [-0.004, 0.036, 0.033] };
const HANDLE_R = 0.0172;

/** Racket handle line in world (bind) space for a hand frame (handPose.racketInHand, right hand). */
function handleLine(hf, side) {
  const thumb = side === 'R' ? 1 : -1; // the canonical +X is the thumb side for the right hand
  const a = (GRIP.angleDeg * Math.PI) / 180;
  const yl = [Math.sin(a) * thumb, Math.cos(a), 0];
  const toW = (p) => V.add(V.add(V.add(hf.W, hf.X, p[0]), hf.Y, p[1]), hf.Z, p[2]);
  const dirW = (d) => V.norm(V.add(V.add(V.scale(hf.X, d[0]), hf.Y, d[1]), hf.Z, d[2]));
  const origin = toW([0, GRIP.forward, GRIP.palm]);
  const dir = dirW(yl);
  const zAxis = hf.Z;
  const xAxis = V.norm(V.cross(dir, zAxis));
  return { origin, dir, xAxis, zAxis, toW, thumbX: thumb };
}

function distToLine(p, o, d) {
  const v = V.sub(p, o);
  const s = V.dot(v, d);
  return V.len(V.add(v, d, -s));
}

/**
 * Finger chain transforms for a hand: { boneName: 3x4 matrix } for the MH finger bones.
 * mode: 'grip' (wrapped around the handle) | 'relaxed'.
 */
function fingerPose(base, S, mode) {
  const { J, mh } = base;
  const hf = base.hand[S];
  const n = hf.Z;
  const h = (b) => J[mh.skel.bones[b].head];
  const t = (b) => J[mh.skel.bones[b].tail];
  const M = {};
  const handle = mode === 'grip' ? handleLine(hf, S) : null;
  const fingerR = { 2: 0.0092, 3: 0.0095, 4: 0.009, 5: 0.0082 };
  const relaxed = { 2: [14, 22, 10], 3: [18, 27, 12], 4: [22, 30, 14], 5: [26, 32, 15] };
  for (const f of [1, 2, 3, 4, 5]) {
    const names = [1, 2, 3].map((k) => `finger${f}-${k}.${S}`);
    // Joint points (chain) in bind space: heads and the tip.
    let pts = [h(names[0]), h(names[1]), h(names[2]), t(names[2])];
    let acc = V.IDENT();
    const mats = [];
    // Hinge axes carried along the chain.
    let axes = [0, 1, 2].map((k) => V.norm(V.cross(V.norm(V.sub(pts[k + 1], pts[k])), n)));
    const rotate = (k, axis, ang) => {
      const R = V.rotAbout(axis, ang, pts[k]);
      for (let j = k + 1; j < 4; j++) pts[j] = V.apply(R, pts[j]);
      for (let j = k + 1; j < 3; j++) axes[j] = V.norm(V.applyDir(R, axes[j]));
      for (let j = k; j < 3; j++) mats[j] = V.mul(R, mats[j] || V.IDENT());
    };
    for (let j = 0; j < 3; j++) mats[j] = V.IDENT();
    if (f === 1) {
      if (mode === 'grip') {
        const T = (x, y, z) => V.add(V.add(V.add(handle.origin, handle.xAxis, x * handle.thumbX), handle.dir, y), handle.zAxis, z);
        aim(pts, 0, 2, T(GRIP.thumbIP[0], GRIP.thumbIP[1], GRIP.thumbIP[2]), rotate);
        aim(pts, 1, 3, T(GRIP.thumbTip[0], GRIP.thumbTip[1], GRIP.thumbTip[2]), rotate);
      } else {
        rotate(1, axes[1], (8 * Math.PI) / 180);
        rotate(2, axes[2], (14 * Math.PI) / 180);
      }
    } else if (mode === 'grip') {
      const rc = HANDLE_R + fingerR[f];
      const limits = [95, 110, 80];
      for (let k = 0; k < 3; k++) {
        const axis = axes[k];
        const a = pts[k];
        const rel = V.sub(pts[k + 1], a);
        let chosen = null, best = 0, bestErr = Infinity;
        for (let th = 0; th <= limits[k]; th += 1) {
          const R = V.rotAbout(axis, (th * Math.PI) / 180, [0, 0, 0]);
          const e = V.add(a, V.apply(R, rel));
          let dmin = Infinity;
          for (let i = 0; i <= 8; i++) dmin = Math.min(dmin, distToLine(V.lerp(V.lerp(a, e, 0.3), e, i / 8), handle.origin, handle.dir));
          if (dmin <= rc * (k === 2 ? 0.95 : 1)) { chosen = Math.max(0, th - 1); break; }
          const err = Math.abs(distToLine(e, handle.origin, handle.dir) - rc);
          if (err < bestErr) { bestErr = err; best = th; }
        }
        rotate(k, axis, (((chosen ?? best)) * Math.PI) / 180);
      }
    } else {
      const pr = relaxed[f];
      for (let k = 0; k < 3; k++) rotate(k, axes[k], (pr[k] * Math.PI) / 180);
    }
    names.forEach((nm, k) => { M[nm] = mats[k]; });
    void acc;
  }
  return M;
}

function aim(pts, k, end, target, rotate) {
  const from = V.norm(V.sub(pts[end], pts[k]));
  const to = V.norm(V.sub(target, pts[k]));
  const axis = V.cross(from, to);
  const s = V.len(axis);
  if (s < 1e-6) return;
  rotate(k, V.norm(axis), Math.atan2(s, V.dot(from, to)));
}

/** Posed positions of every vertex with the finger transforms (linear blend over MH bones). */
function poseFingers(base, mats) {
  const out = Float64Array.from(base.pos);
  const names = Object.keys(mats);
  for (let i = 0; i < out.length / 3; i++) {
    const m = base.mhW[i];
    let touched = false;
    for (const nm of names) if (m.has(nm)) { touched = true; break; }
    if (!touched) continue;
    let sum = 0;
    for (const w of m.values()) sum += w;
    const p = [base.pos[i * 3], base.pos[i * 3 + 1], base.pos[i * 3 + 2]];
    const o = [0, 0, 0];
    for (const [b, w] of m) {
      const q = mats[b] ? V.apply(mats[b], p) : p;
      o[0] += q[0] * w / sum; o[1] += q[1] * w / sum; o[2] += q[2] * w / sum;
    }
    out[i * 3] = o[0]; out[i * 3 + 1] = o[1]; out[i * 3 + 2] = o[2];
  }
  return out;
}

// ------------------------------------------------------------------ main

function main() {
  if (!existsSync(join(SRC, 'base.obj'))) {
    console.error(`MakeHuman sources not found in ${SRC}: run node tools/people/fetch-sources.mjs first`);
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const mh = loadMH(SRC);
  const NPM = join(SRC, 'npm', 'package', 'public', 'data');
  const male = buildBase(mh, 'male', PRESETS.male);
  const female = buildBase(mh, 'female', PRESETS.female, male.s);
  const textures = buildTextures({ npm: NPM, out: OUT });
  const meshes = [];
  const templates = {};
  for (const base of [male, female]) {
    // Racket hand (right) wrapped around the grip, off hand relaxed.
    const mats = { ...fingerPose(base, 'R', 'grip'), ...fingerPose(base, 'L', 'relaxed') };
    base.posed = poseFingers(base, mats);
    const parts = assembleTemplate(base, textures, NPM);
    const tpl = describeTemplate(base, parts);
    templates[base.name] = tpl;
    for (const p of parts.meshes) meshes.push(p);
    console.log(`${base.name}: ${tpl.stats.map((s) => `${s.name} ${s.tris}`).join(', ')}`);
  }
  const glb = writeGlb({ meshes, extras: { version: 1, templates, textures: textures.manifest, regions: REGION, parts: PART, bones: BONE_NAMES, parents: BONE_NAMES.map((n) => (BONE_PARENT[n] ? BI[BONE_PARENT[n]] : -1)) } });
  writeFileSync(join(OUT, 'athletes.glb'), glb);
  console.log(`wrote ${join(OUT, 'athletes.glb')} (${(glb.length / 1024).toFixed(0)} KB)`);
}

/** Template description stored in the GLB extras (skeleton, hand frames, limb lengths, parts). */
function describeTemplate(base, parts) {
  const P = base.P;
  const d = (a, b) => V.len(V.sub(P[a], P[b]));
  const r = (v) => v.map((x) => +x.toFixed(5));
  return {
    name: base.name,
    refHeight: +((Math.max(...base.bodyTop) || REF_HEIGHT + SOLE) - SOLE).toFixed(4),
    bones: BONE_NAMES.map((n) => r(P[n])),
    hand: Object.fromEntries(['R', 'L'].map((S) => [S, { X: r(base.hand[S].X), Y: r(base.hand[S].Y), Z: r(base.hand[S].Z) }])),
    limbs: {
      upperArm: +d('upperArmR', 'foreArmR').toFixed(4), foreArm: +d('foreArmR', 'handR').toFixed(4),
      thigh: +d('thighR', 'shinR').toFixed(4), shin: +d('shinR', 'footR').toFixed(4),
      hipY: +P.hips[1].toFixed(4), ankleY: +P.footR[1].toFixed(4), hipX: +Math.abs(P.thighR[0]).toFixed(4),
      shoulderY: +P.upperArmR[1].toFixed(4),
    },
    head: parts.headInfo,
    fparm: parts.fparm,
    meshes: parts.index,
    stats: parts.stats,
  };
}

/** Builds every mesh of a template (body LOD0/1, hair styles, headwear) -> { meshes, index, stats, headInfo }. */
function assembleTemplate(base, textures, npm) {
  const out = { meshes: [], index: {}, stats: [] };
  const C = { REGION, PART, BI };
  const body = bodyPart(base, textures);
  const shoes = buildShoes(base, C);
  // SDF meshes are evenly dense: the shoes simplify very well.
  bakeAO(shoes.part, { reach: 0.04 });
  const shoesLod0 = simplifyPart(shoes.part, { ratio: 0.28, error: 0.0015 });
  const shoesLod1 = simplifyPart(shoes.part, { ratio: 0.07, error: 0.004 });
  const clothes = buildClothes(base, body, C, { hide: shoes.inside });
  const face = PROXY_SETS.face.map((p) => fitProxy(base, npm, p, textures, C)).filter(Boolean);
  const lod0 = mergeParts([clothes.body, ...clothes.shells, shoesLod0, ...face]);
  const tri = (p) => (p ? p.index.length / 3 : 0);
  console.log(`  ${base.name} parts: skin ${tri(clothes.body)}, shirt ${tri(clothes.shells[0])}, shorts ${tri(clothes.shells[1])}, shoes ${tri(shoesLod0)}, face ${face.map(tri).join('/')}`);
  bakeAO(lod0, { exclude: (v) => lod0.region[v] === REGION.LASH || lod0.region[v] === REGION.BROW || lod0.region[v] === REGION.EYE });
  // LOD1: the same surfaces simplified (AO carried over), low-poly eyes.
  const core = mergeParts([clothes.body, ...clothes.shells]);
  core.ao = lod0.ao.slice(0, core.positions.length / 3);
  const eyesLow = fitProxy(base, npm, PROXY_SETS.eyesLow, textures, C);
  const lod1 = mergeParts([simplifyPart(core, { ratio: 0.24, error: 0.004 }), shoesLod1, eyesLow]);
  push(out, `${base.name}/body/0`, lod0);
  push(out, `${base.name}/body/1`, lod1);
  for (const style of PROXY_SETS.hair) {
    if (style.bodies && !style.bodies.includes(base.name)) continue;
    const h = fitProxy(base, npm, style, textures, C);
    if (!h) continue;
    bakeAO(h, { strength: 0.55, reach: 0.06 });
    push(out, `${base.name}/hair/${style.id}/0`, h);
    if (style.lod1) push(out, `${base.name}/hair/${style.id}/1`, simplifyPart(h, { ratio: style.lod1, error: 0.01, cards: true }));
  }
  const hw = buildHeadwear(base, C);
  for (const [kind, part] of Object.entries(hw.parts)) {
    push(out, `${base.name}/headwear/${kind}/0`, part);
    push(out, `${base.name}/headwear/${kind}/1`, simplifyPart(part, { ratio: 0.3, error: 0.003 }));
  }
  out.headInfo = hw.headInfo;
  // First-person forearms and hands (rest pose, WebXR-style hand joints).
  out.fparm = {};
  // The player's own arms: the male body (the player's kit has no body choice yet).
  for (const S of base.name === 'male' ? ['R', 'L'] : []) {
    const arm = buildFpArm(base, body, S, textures);
    out.fparm[S] = { joints: arm.joints, upperDir: arm.upperDir, length: arm.length };
    const name = `${base.name}/fparm/${S}`;
    out.index[name] = out.meshes.length;
    out.meshes.push(armMesh(name, arm.part));
    out.stats.push({ name: `fparm/${S}`, tris: arm.part.index.length / 3, verts: arm.part.positions.length / 3 });
  }
  let top = 0;
  for (let i = 1; i < lod0.positions.length; i += 3) top = Math.max(top, lod0.positions[i]);
  base.bodyTop = [top];
  return out;
}

function push(out, name, part) {
  out.index[name] = out.meshes.length;
  out.meshes.push(toMesh(name, part));
  out.stats.push({ name: name.split('/').slice(1).join('/'), tris: part.index.length / 3, verts: part.positions.length / 3 });
}

/** Packs a part into glTF attributes (quantized where lossless enough). */
function toMesh(name, p) {
  const n = p.positions.length / 3;
  const si = new Uint8Array(n * 4), sw = new Uint8Array(n * 4);
  for (let i = 0; i < n * 4; i++) si[i] = p.skinIndex[i];
  for (let v = 0; v < n; v++) {
    // Quantize weights to bytes that still sum to 255.
    let rest = 255;
    let maxK = 0;
    for (let k = 0; k < 4; k++) {
      const q = Math.round(p.skinWeight[v * 4 + k] * 255);
      sw[v * 4 + k] = q;
      rest -= q;
      if (p.skinWeight[v * 4 + k] > p.skinWeight[v * 4 + maxK]) maxK = k;
    }
    sw[v * 4 + maxK] = Math.max(0, Math.min(255, sw[v * 4 + maxK] + rest));
  }
  const nrm = new Int8Array(n * 3);
  for (let i = 0; i < n * 3; i++) nrm[i] = Math.max(-127, Math.min(127, Math.round(p.normals[i] * 127)));
  const uv = new Uint16Array(n * 2);
  for (let i = 0; i < n * 2; i++) uv[i] = Math.max(0, Math.min(65535, Math.round(p.uv[i] * 65535)));
  const ao = new Uint8Array(n);
  for (let i = 0; i < n; i++) ao[i] = Math.round(Math.max(0, Math.min(1, p.ao ? p.ao[i] : 1)) * 255);
  const aux = new Uint8Array(n * 2);
  for (let i = 0; i < n * 2; i++) aux[i] = Math.round(Math.max(0, Math.min(1, p.aux ? p.aux[i] : 1)) * 255);
  const pos = Float32Array.from(p.positions);
  const index = n < 65536 ? Uint16Array.from(p.index) : Uint32Array.from(p.index);
  return {
    name,
    attributes: {
      POSITION: { array: pos, itemSize: 3 },
      NORMAL: { array: nrm, itemSize: 3, normalized: true },
      TEXCOORD_0: { array: uv, itemSize: 2, normalized: true },
      JOINTS_0: { array: si, itemSize: 4 },
      WEIGHTS_0: { array: sw, itemSize: 4, normalized: true },
      _REGION: { array: Uint8Array.from(p.region), itemSize: 1 },
      _PART: { array: Uint8Array.from(p.part), itemSize: 1 },
      _AO: { array: ao, itemSize: 1, normalized: true },
      _AUX: { array: aux, itemSize: 2, normalized: true },
    },
    index,
  };
}

/** First-person arm mesh: skin attributes, hand-joint skinning, the along-the-forearm parameter. */
function armMesh(name, p) {
  const n = p.positions.length / 3;
  const sw = new Uint8Array(n * 4);
  for (let v = 0; v < n; v++) {
    let rest = 255, maxK = 0;
    for (let k = 0; k < 4; k++) {
      sw[v * 4 + k] = Math.round(p.skinWeight[v * 4 + k] * 255);
      rest -= sw[v * 4 + k];
      if (p.skinWeight[v * 4 + k] > p.skinWeight[v * 4 + maxK]) maxK = k;
    }
    sw[v * 4 + maxK] += rest;
  }
  const q = (arr, k) => Uint8Array.from(arr, (x) => Math.round(Math.max(0, Math.min(1, x)) * k));
  return {
    name,
    attributes: {
      POSITION: { array: Float32Array.from(p.positions), itemSize: 3 },
      NORMAL: { array: Int8Array.from(p.normals, (x) => Math.max(-127, Math.min(127, Math.round(x * 127)))), itemSize: 3, normalized: true },
      TEXCOORD_0: { array: Uint16Array.from(p.uv, (x) => Math.round(Math.max(0, Math.min(1, x)) * 65535)), itemSize: 2, normalized: true },
      JOINTS_0: { array: Uint8Array.from(p.skinIndex), itemSize: 4 },
      WEIGHTS_0: { array: sw, itemSize: 4, normalized: true },
      _LIMBT: { array: Uint8Array.from(p.limbT, (x) => Math.round(Math.max(0, Math.min(1.5, x)) / 1.5 * 255)), itemSize: 1, normalized: true },
      _AO: { array: q(p.ao, 255), itemSize: 1, normalized: true },
    },
    index: n < 65536 ? Uint16Array.from(p.index) : Uint32Array.from(p.index),
  };
}

// ------------------------------------------------------------------ body part

/**
 * The skin mesh (body group of hm08), split at uv seams, posed fingers, game weights, region SKIN,
 * part HEAD / ARMS / BODY, aux = [shin height above the ankle / 0.5, forearm distance from the wrist / 0.4].
 * Keeps the MakeHuman vertex index per output vertex (src) for the clothing pass.
 */
function bodyPart(base, textures) {
  const { mh } = base;
  const bodyG = mh.obj.groups.indexOf('body');
  const key = new Map();
  const src = [], uvs = [], idx = [];
  const faces = [];
  for (const f of mh.obj.faces) {
    if (f.g !== bodyG) continue;
    const corner = f.v.map((vi, k) => {
      const ti = f.t[k];
      const kk = `${vi}/${ti}`;
      let o = key.get(kk);
      if (o === undefined) {
        o = src.length;
        key.set(kk, o);
        src.push(vi);
        uvs.push(mh.obj.vt[ti * 2], mh.obj.vt[ti * 2 + 1]);
      }
      return o;
    });
    faces.push({ c: corner, v: f.v });
    idx.push(corner[0], corner[1], corner[2]);
    if (corner.length === 4) idx.push(corner[0], corner[2], corner[3]);
  }
  const n = src.length;
  const positions = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) positions[i * 3 + k] = base.posed[src[i] * 3 + k];
  const part = {
    positions, uv: Float64Array.from(uvs), index: Uint32Array.from(idx), src: Int32Array.from(src), faces,
    region: new Uint8Array(n).fill(REGION.SKIN), part: new Uint8Array(n), skinIndex: new Uint8Array(n * 4), skinWeight: new Float64Array(n * 4), aux: new Float64Array(n * 2).fill(1),
  };
  // Skin texture atlas: male in the left half, female in the right one.
  const half = base.name === 'female' ? 1 : 0;
  for (let i = 0; i < n; i++) part.uv[i * 2] = textures.skinU(part.uv[i * 2], half);
  setWeights(part, base, (i) => base.gameW[src[i]]);
  computeNormals(part, src);
  // Parts and aux.
  const P = base.P;
  for (let i = 0; i < n; i++) {
    const w = base.gameW[src[i]];
    const get = (b) => (w && w.get(b)) || 0;
    const head = get('neck') + get('head');
    const arms = ['R', 'L'].reduce((a, S) => a + get(`upperArm${S}`) + get(`foreArm${S}`) + get(`hand${S}`), 0);
    part.part[i] = head > 0.5 ? PART.HEAD : arms > 0.5 ? PART.ARMS : PART.BODY;
    const p = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    const S = p[0] < 0 ? 'R' : 'L';
    // Height above the ankle along the shin (socks), 0..0.5 m -> 0..1.
    const K = P[`shin${S}`], A = P[`foot${S}`];
    const shinD = V.norm(V.sub(K, A));
    const hShin = V.dot(V.sub(p, A), shinD);
    part.aux[i * 2] = get(`shin${S}`) + get(`foot${S}`) + get(`toe${S}`) > 0.3 ? V.clamp(hShin / 0.5, 0, 1) : 1;
    // Distance up the forearm from the wrist (wristbands), 0..0.4 m -> 0..1.
    const E = P[`foreArm${S}`], W = P[`hand${S}`];
    const foreD = V.norm(V.sub(E, W));
    const dW = V.dot(V.sub(p, W), foreD);
    // Only the forearm side of the wrist (the hand itself is never a wristband).
    part.aux[i * 2 + 1] = get(`foreArm${S}`) + get(`hand${S}`) > 0.3 && dW > 0.004 ? V.clamp(dW / 0.4, 0, 1) : 1;
  }
  return part;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
