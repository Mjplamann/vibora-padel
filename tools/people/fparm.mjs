// First-person arms: the forearm and hand of a baked body (MakeHuman topology, rest pose, fingers
// straight) skinned to a WebXR-style hand skeleton (joint names as the WebXR generic hands, flat
// joints in model space; render/handPose.js poses them around the racket grip) plus two forearm
// joints (elbow, mid) so pronation spreads along the forearm instead of twisting it rigidly.
// Attributes: skin uv (atlas), limbT (0 at the elbow .. 1 at the wrist, the rig's along-the-limb
// cut), ambient occlusion.
import * as V from './vec.mjs';
import { computeNormals } from './parts.mjs';
import { bakeAO } from './ao.mjs';

/** WebXR joint names (handPose.js chainNames order) -> MakeHuman joints [bone, 'head'|'tail']. */
function jointMap(S) {
  const m = { wrist: [`wrist.${S}`, 'head'] };
  const th = ['metacarpal', 'phalanx-proximal', 'phalanx-distal'];
  th.forEach((n, k) => { m[`thumb-${n}`] = [`finger1-${k + 1}.${S}`, 'head']; });
  m['thumb-tip'] = [`finger1-3.${S}`, 'tail'];
  ['index', 'middle', 'ring', 'pinky'].forEach((f, fi) => {
    m[`${f}-finger-metacarpal`] = [`metacarpal${fi + 1}.${S}`, 'head'];
    ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal'].forEach((n, k) => { m[`${f}-finger-${n}`] = [`finger${fi + 2}-${k + 1}.${S}`, 'head']; });
    m[`${f}-finger-tip`] = [`finger${fi + 2}-3.${S}`, 'tail'];
  });
  m.elbow = [`lowerarm01.${S}`, 'head'];
  return m;
}

/** MakeHuman bone weight -> the joint that carries it (null: the forearm chain). */
function mhToJoint(b, S) {
  const s = `.${S}`;
  if (!b.endsWith(s)) return undefined;
  const n = b.slice(0, -2);
  if (n === 'wrist') return 'wrist';
  let m = n.match(/^metacarpal(\d)$/);
  if (m) return `${['index', 'middle', 'ring', 'pinky'][+m[1] - 1]}-finger-metacarpal`;
  m = n.match(/^finger(\d)-(\d)$/);
  if (m) {
    const f = +m[1], k = +m[2];
    if (f === 1) return `thumb-${['metacarpal', 'phalanx-proximal', 'phalanx-distal'][k - 1]}`;
    return `${['index', 'middle', 'ring', 'pinky'][f - 2]}-finger-${['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal'][k - 1]}`;
  }
  if (n.startsWith('lowerarm') || n.startsWith('upperarm') || n === 'shoulder01') return null;
  return undefined;
}

/**
 * @returns {{ part, joints: { names: string[], pos: number[][] }, upperDir: number[] }} for side S.
 * part: positions, normals, uv, index, skinIndex (into joints.names), skinWeight, limbT, ao.
 */
export function buildFpArm(base, body, S, textures) {
  const { mh } = base;
  const J = base.J;
  const jm = jointMap(S);
  const names = [...Object.keys(jm), 'forearm-mid'];
  const jpos = {};
  for (const [n, [b, end]] of Object.entries(jm)) jpos[n] = J[mh.skel.bones[b][end]];
  const E0 = jpos.elbow, W0 = jpos.wrist;
  jpos['forearm-mid'] = V.lerp(E0, W0, 0.5);
  const fore = V.sub(W0, E0);
  const L = V.len(fore);
  const d0 = V.scale(fore, 1 / L);
  const upperDir = V.norm(V.sub(E0, J[mh.skel.bones[`upperarm01.${S}`].head]));
  // Vertices: forearm and hand of the rest pose (fingers straight), from just below the elbow.
  const pos = base.pos;
  const take = new Set();
  for (let i = 0; i < pos.length / 3; i++) {
    const w = base.mhW[i];
    let hand = 0, foreW = 0, other = 0;
    for (const [b, x] of w) {
      const j = mhToJoint(b, S);
      if (j === undefined) other += x;
      else if (j === null) foreW += x;
      else hand += x;
    }
    const p = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    const t = V.dot(V.sub(p, E0), d0) / L;
    if (hand + foreW > 0.55 && t > -0.06 && other < 0.4) take.add(i);
  }
  const bodyG = mh.obj.groups.indexOf('body');
  const key = new Map();
  const src = [], uvs = [], idx = [];
  for (const f of mh.obj.faces) {
    if (f.g !== bodyG || !f.v.every((i) => take.has(i))) continue;
    const c = f.v.map((vi, k) => {
      const ti = f.t[k];
      const kk = `${vi}/${ti}`;
      let o = key.get(kk);
      if (o === undefined) {
        o = src.length;
        key.set(kk, o);
        src.push(vi);
        uvs.push(textures.skinU(mh.obj.vt[ti * 2], base.name === 'female' ? 1 : 0), mh.obj.vt[ti * 2 + 1]);
      }
      return o;
    });
    idx.push(c[0], c[1], c[2]);
    if (c.length === 4) idx.push(c[0], c[2], c[3]);
  }
  const n = src.length;
  const part = {
    positions: new Float64Array(n * 3), uv: Float64Array.from(uvs), index: Uint32Array.from(idx),
    skinIndex: new Uint8Array(n * 4), skinWeight: new Float64Array(n * 4), limbT: new Float64Array(n),
  };
  const JI = Object.fromEntries(names.map((nm, i) => [nm, i]));
  for (let v = 0; v < n; v++) {
    const i = src[v];
    const p = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    part.positions.set(p, v * 3);
    const t = V.dot(V.sub(p, E0), d0) / L;
    // Hand joints from the MakeHuman weights; the forearm share spreads over elbow / mid / wrist.
    const acc = new Map();
    let foreW = 0;
    for (const [b, x] of base.mhW[i]) {
      const j = mhToJoint(b, S);
      if (j === undefined) continue;
      if (j === null) foreW += x;
      else acc.set(j, (acc.get(j) || 0) + x);
    }
    if (foreW > 0) {
      const tt = V.clamp(t, 0, 1);
      const we = Math.max(0, 1 - tt / 0.5), wm = 1 - Math.abs(tt - 0.5) / 0.5, ww = Math.max(0, (tt - 0.5) / 0.5);
      for (const [j, k] of [['elbow', we], ['forearm-mid', wm], ['wrist', ww]]) if (k > 0) acc.set(j, (acc.get(j) || 0) + foreW * k);
    }
    // The along-the-forearm cut never reaches the hand (t = 1.5: a clean cut at the wrist).
    let mhHand = 0;
    for (const [b, x] of base.mhW[i]) { const j = mhToJoint(b, S); if (j) mhHand += x; }
    part.limbT[v] = mhHand > foreW && t > 0.9 ? 1.5 : V.clamp(t, 0, 1);
    const list = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    let sum = 0;
    for (const [, x] of list) sum += x;
    if (!list.length) { part.skinIndex[v * 4] = JI.wrist; part.skinWeight[v * 4] = 1; continue; }
    list.forEach(([j, x], k) => { part.skinIndex[v * 4 + k] = JI[j]; part.skinWeight[v * 4 + k] = x / sum; });
  }
  computeNormals(part, Int32Array.from(src));
  bakeAO(part, { reach: 0.03, voxel: 0.004, strength: 0.8 });
  return { part, joints: { names, pos: names.map((nm) => jpos[nm].map((x) => +x.toFixed(5))) }, upperDir: upperDir.map((x) => +x.toFixed(5)), length: +L.toFixed(4) };
}
