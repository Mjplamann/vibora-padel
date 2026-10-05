// MakeHuman data access (pure Node): base mesh, targets, macro weights, skeleton joints, weights.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function parseObj(text) {
  const v = [], vt = [], faces = [], groups = [];
  let g = -1;
  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) { const p = line.split(/\s+/); v.push(+p[1], +p[2], +p[3]); }
    else if (line.startsWith('vt ')) { const p = line.split(/\s+/); vt.push(+p[1], +p[2]); }
    else if (line.startsWith('g ')) { groups.push(line.slice(2).trim()); g = groups.length - 1; }
    else if (line.startsWith('f ')) {
      const p = line.trim().split(/\s+/).slice(1);
      const fv = [], ft = [];
      for (const s of p) { const [a, b] = s.split('/'); fv.push(+a - 1); ft.push(b ? +b - 1 : -1); }
      faces.push({ v: fv, t: ft, g });
    }
  }
  return { v: Float64Array.from(v), vt: Float64Array.from(vt), faces, groups };
}

export function parseTarget(text) {
  const idx = [], d = [];
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const p = line.trim().split(/\s+/);
    if (p.length < 4) continue;
    idx.push(+p[0]); d.push(+p[1], +p[2], +p[3]);
  }
  return { idx: Int32Array.from(idx), d: Float64Array.from(d) };
}

const lerp3 = (x) => (x < 0.5 ? { min: Math.max(0, 1 - x * 2), average: 1 - Math.max(0, 1 - x * 2), max: 0 } : { min: 0, average: 1 - Math.max(0, x * 2 - 1), max: Math.max(0, x * 2 - 1) });

/**
 * Macro target weights (MakeHuman 1.1 human.py): { file: weight }.
 * p: { gender 0..1, age (young only: 0.5), muscle, weight, height, proportions, race: {african, asian, caucasian} }
 */
export function macroTargets(p) {
  const out = {};
  const add = (f, w) => { if (w > 1e-6) out[f] = (out[f] || 0) + w; };
  const G = { female: 1 - p.gender, male: p.gender };
  const M = lerp3(p.muscle), W = lerp3(p.weight);
  const H = p.height < 0.5 ? { minheight: Math.max(0, 1 - p.height * 2) } : { maxheight: Math.max(0, p.height * 2 - 1) };
  const P = p.proportions > 0.5 ? Math.max(0, p.proportions * 2 - 1) : 0;
  const rs = p.race.african + p.race.asian + p.race.caucasian;
  for (const [g, gw] of Object.entries(G)) {
    for (const r of ['african', 'asian', 'caucasian']) add(`${r}-${g}-young.target`, gw * p.race[r] / rs);
    for (const [m, mw] of Object.entries(M)) for (const [w, ww] of Object.entries(W)) {
      const base = `${g}-young-${m}muscle-${w}weight`;
      add(`universal-${base}.target`, gw * mw * ww);
      for (const [h, hw] of Object.entries(H)) add(`${base}-${h}.target`, gw * mw * ww * hw);
      add(`${base}-idealproportions.target`, gw * mw * ww * P);
    }
  }
  return out;
}

export function loadMH(src) {
  const obj = parseObj(readFileSync(join(src, 'base.obj'), 'utf8'));
  const skel = JSON.parse(readFileSync(join(src, 'default.mhskel'), 'utf8'));
  const weights = JSON.parse(readFileSync(join(src, 'default_weights.mhw'), 'utf8'));
  const cache = new Map();
  const target = (f) => {
    if (!cache.has(f)) {
      const path = join(src, 'targets', f);
      cache.set(f, existsSync(path) ? parseTarget(readFileSync(path, 'utf8')) : null);
    }
    return cache.get(f);
  };
  return { obj, skel, weights, target };
}

/** Morphed positions (MakeHuman units, decimetres) for macro parameters. */
export function morph(mh, params) {
  const pos = Float64Array.from(mh.obj.v);
  const used = [];
  for (const [f, w] of Object.entries(macroTargets(params))) {
    const t = mh.target(f);
    if (!t) { used.push(`MISSING ${f}`); continue; }
    used.push(`${f} ${w.toFixed(3)}`);
    for (let i = 0; i < t.idx.length; i++) {
      const k = t.idx[i] * 3;
      pos[k] += t.d[i * 3] * w; pos[k + 1] += t.d[i * 3 + 1] * w; pos[k + 2] += t.d[i * 3 + 2] * w;
    }
  }
  return { pos, used };
}

/** Joint positions (mean of the joint helper vertices) by joint name. */
export function joints(mh, pos) {
  const out = {};
  for (const [name, list] of Object.entries(mh.skel.joints)) {
    let x = 0, y = 0, z = 0;
    for (const i of list) { x += pos[i * 3]; y += pos[i * 3 + 1]; z += pos[i * 3 + 2]; }
    out[name] = [x / list.length, y / list.length, z / list.length];
  }
  return out;
}
