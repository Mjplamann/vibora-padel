// Clothing shells grown from the baked body (MakeHuman topology): a short-sleeve sports shirt and
// loose shorts. Each shell copies the body faces of its region, offsets them along the smoothed
// normals (more where real fabric hangs loose: belly, lower back, the shorts' legs), drapes them with
// a constrained smoothing (the fabric bridges the hollows between the chest and the belly, the spine
// groove, the waist) and closes every opening with a rim folded back toward the skin, so no gap
// between cloth and body is ever visible. Shell vertices take the skin weights of the body point
// right under them (transfer.mjs), so cloth and skin deform together; the skin faces fully covered by a shell are removed (no poke-through, fewer
// triangles). Collar and sleeve hems are trim bands.
import * as V from './vec.mjs';
import { computeNormals } from './parts.mjs';
import { bodySurface, transferWeights, partSurface, followLayer, pokeTest } from './transfer.mjs';

/** Region tests per MakeHuman vertex. */
function classifier(base, opts) {
  const P = base.P;
  const pos = base.posed;
  const w = (i, b) => (base.gameW[i] && base.gameW[i].get(b)) || 0;
  const side = (i) => (pos[i * 3] < 0 ? 'R' : 'L');
  const p = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
  const armW = (i) => { const S = side(i); return w(i, `upperArm${S}`) + w(i, `foreArm${S}`) + w(i, `hand${S}`); };
  const legW = (i) => { const S = side(i); return w(i, `thigh${S}`) + w(i, `shin${S}`) + w(i, `foot${S}`) + w(i, `toe${S}`); };
  const headW = (i) => w(i, 'neck') + w(i, 'head');
  const hemY = P.hips[1] - opts.shirtHem;
  const waistY = P.hips[1] + opts.waist;
  const neck = P.neck;
  const along = (i, a, b) => { const q = p(i); const d = V.norm(V.sub(P[b], P[a])); return V.dot(V.sub(q, P[a]), d); };
  return {
    shirt(i) {
      const q = p(i);
      if (q[1] < hemY) return false;
      if (headW(i) > 0.3) return false;
      // Crew neck: lower in front (the sternal notch), higher at the back.
      const front = Math.max(0, q[2] - neck[2]);
      const ax = Math.abs(q[0]);
      if (ax < opts.collarHalf && q[1] > neck[1] - opts.collarBack - front * opts.collarDip) return false;
      if (armW(i) > 0.5) {
        const S = side(i);
        return along(i, `upperArm${S}`, `foreArm${S}`) < opts.sleeve;
      }
      if (legW(i) > 0.7) return false;
      return true;
    },
    shorts(i) {
      const q = p(i);
      if (q[1] > waistY) return false;
      if (armW(i) > 0.3 || headW(i) > 0.1) return false;
      const S = side(i);
      if (w(i, `shin${S}`) + w(i, `foot${S}`) + w(i, `toe${S}`) > 0.3) return false;
      if (w(i, `thigh${S}`) > 0.45) return along(i, `thigh${S}`, `shin${S}`) < opts.shortsLen;
      return q[1] > P.hips[1] - 0.3;
    },
    hemY, waistY,
  };
}

/**
 * Faces whose corners all pass `inside`, plus faces with three of four corners in that touch two
 * selected faces (closes one-face notches in the opening's outline).
 */
function closeSelection(faces, inside) {
  const sel = new Set(faces.filter((f) => f.v.every(inside)));
  const edgeFaces = new Map();
  for (const f of sel) for (let k = 0; k < f.v.length; k++) {
    const a = f.v[k], b = f.v[(k + 1) % f.v.length];
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    edgeFaces.set(key, (edgeFaces.get(key) || 0) + 1);
  }
  for (const f of faces) {
    if (sel.has(f)) continue;
    const n = f.v.filter(inside).length;
    if (n < f.v.length - 1) continue;
    let touch = 0;
    for (let k = 0; k < f.v.length; k++) {
      const a = f.v[k], b = f.v[(k + 1) % f.v.length];
      if (edgeFaces.has(a < b ? `${a},${b}` : `${b},${a}`)) touch++;
    }
    if (touch >= 2) sel.add(f);
  }
  return faces.filter((f) => sel.has(f));
}

/** Vertex adjacency (MakeHuman ids) of a face list. */
function adjacency(faces) {
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  };
  for (const f of faces) for (let k = 0; k < f.v.length; k++) { link(f.v[k], f.v[(k + 1) % f.v.length]); link(f.v[(k + 1) % f.v.length], f.v[k]); }
  return adj;
}

/** Boundary edges (used by exactly one face), as directed pairs following each face's winding. */
function boundary(faces) {
  const count = new Map();
  for (const f of faces) for (let k = 0; k < f.v.length; k++) {
    const a = f.v[k], b = f.v[(k + 1) % f.v.length];
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    count.set(key, (count.get(key) || 0) + 1);
  }
  const edges = [];
  for (const f of faces) for (let k = 0; k < f.v.length; k++) {
    const a = f.v[k], b = f.v[(k + 1) % f.v.length];
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (count.get(key) === 1) edges.push({ a, b, f });
  }
  return edges;
}

/**
 * Builds a shell for the faces in `sel` (body faces with MH ids and corner keys).
 * offFn(i, p) -> offset (m); trimFn(i, distToEdge) -> region.
 */
function shell(base, body, sel, { offFn, regionFn, partFn, iterations = 24, minScale = 0.65, lift = null, band = null, under = null }) {
  const pos = base.posed;
  // Smoothed normals per MH id from the body part normals.
  const nrm = new Map();
  for (let v = 0; v < body.src.length; v++) {
    const i = body.src[v];
    if (!nrm.has(i)) nrm.set(i, [body.normals[v * 3], body.normals[v * 3 + 1], body.normals[v * 3 + 2]]);
  }
  const adj = adjacency(sel);
  const edges = boundary(sel);
  const onEdge = new Set();
  for (const e of edges) { onEdge.add(e.a); onEdge.add(e.b); }
  const edgeAdj = new Map();
  for (const e of edges) {
    if (!edgeAdj.has(e.a)) edgeAdj.set(e.a, []);
    if (!edgeAdj.has(e.b)) edgeAdj.set(e.b, []);
    edgeAdj.get(e.a).push(e.b); edgeAdj.get(e.b).push(e.a);
  }
  // Distance (in rings) to the opening, for hem bands.
  const ring = new Map();
  let front = [...onEdge];
  for (const i of front) ring.set(i, 0);
  for (let r = 1; r < 6; r++) {
    const next = [];
    for (const i of front) for (const j of adj.get(i) || []) if (!ring.has(j)) { ring.set(j, r); next.push(j); }
    front = next;
  }
  const ids = [...adj.keys()];
  const P0 = new Map(), Q = new Map(), OFF = new Map();
  for (const i of ids) {
    const p = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    const off = offFn(i, p);
    P0.set(i, p); OFF.set(i, off);
    Q.set(i, V.add(p, nrm.get(i) || [0, 0, 1], off));
  }
  // A smoothed copy of the skin under the shell: small features (nipples, the navel, ribs, the
  // spine groove) do not print through the fabric.
  const S0 = new Map(P0);
  // Taubin (lambda / mu) smoothing: a low-pass that shaves small bumps without shrinking the body.
  for (let it = 0; it < 24; it++) {
    for (const f of [0.5, -0.53]) {
      const next = new Map();
      for (const i of ids) {
        if (onEdge.has(i)) { next.set(i, S0.get(i)); continue; }
        const p = S0.get(i);
        next.set(i, V.add(p, V.sub(V.mean([...adj.get(i)].map((j) => S0.get(j))), p), f));
      }
      for (const [i, q] of next) S0.set(i, q);
    }
  }
  for (const i of ids) Q.set(i, V.add(S0.get(i), nrm.get(i) || [0, 0, 1], OFF.get(i)));
  const clampShell = (i, q) => {
    const n = nrm.get(i) || [0, 0, 1];
    const lo = OFF.get(i) * minScale;
    let d = V.dot(V.sub(q, S0.get(i)), n);
    if (d < lo) q = V.add(q, n, lo - d);
    d = V.dot(V.sub(q, P0.get(i)), n);
    // Near an opening the skin is still drawn: never dip inside it (elsewhere it was removed).
    if ((ring.get(i) ?? 9) <= 2 && d < 0.0025) { q = V.add(q, n, 0.0025 - d); d = 0.0025; }
    // Over another garment (the shirt over the shorts' waistband): stay outside it.
    if (under && under.has(i)) {
      const du = V.dot(V.sub(under.get(i), P0.get(i)), n) + 0.008;
      if (d < du) { q = V.add(q, n, du - d); d = du; }
    }
    const hi = OFF.get(i) * 2.6 + 0.012;
    if (d > hi) q = V.add(q, n, hi - d);
    return q;
  };
  // Drape: smoothing with a minimum offset (a membrane over the hollows).
  for (let it = 0; it < iterations; it++) {
    const next = new Map();
    for (const i of ids) {
      const nb = onEdge.has(i) ? edgeAdj.get(i) : [...adj.get(i)];
      next.set(i, clampShell(i, V.lerp(Q.get(i), V.mean(nb.map((j) => Q.get(j))), 0.5)));
    }
    for (const [i, q] of next) Q.set(i, q);
  }
  // Openings: the selection outline follows the quads (a staircase); smooth it into a clean line.
  for (let it = 0; it < 40; it++) {
    const next = new Map();
    for (const i of onEdge) next.set(i, clampShell(i, V.lerp(Q.get(i), V.mean(edgeAdj.get(i).map((j) => Q.get(j))), 0.6)));
    for (const [i, q] of next) Q.set(i, q);
    // The ring behind the opening follows halfway (no crease right behind the hem).
    for (const i of ids) {
      if (ring.get(i) !== 1) continue;
      const nb = [...adj.get(i)];
      Q.set(i, clampShell(i, V.lerp(Q.get(i), V.mean(nb.map((j) => Q.get(j))), 0.3)));
    }
  }
  if (lift) for (const i of ids) Q.set(i, lift(i, Q.get(i), P0.get(i), nrm.get(i)));
  if (process.env.PEOPLE_DEBUG) {
    let pen = 0, deep = 0, bump = 0;
    for (const i of ids) {
      const n = nrm.get(i) || [0, 0, 1];
      const d = V.dot(V.sub(Q.get(i), P0.get(i)), n);
      if (d < 0) { pen++; if ((ring.get(i) ?? 9) <= 2) deep++; }
      bump = Math.max(bump, V.dot(V.sub(P0.get(i), S0.get(i)), n));
    }
    console.log(`    shell ${ids.length} verts: ${pen} inside the skin (${deep} near an opening), max skin bump over the smoothed base ${(bump * 1000).toFixed(1)} mm`);
  }
  // Shell vertices (split by body uv corner keys).
  const key = new Map();
  const out = { pos: [], uv: [], src: [], region: [], part: [], idx: [] };
  const vert = (i, ti, uvU, uvV, region, p = Q.get(i)) => {
    const k = `${i}/${ti}/${region}`;
    let o = key.get(k);
    if (o === undefined) {
      o = out.src.length;
      key.set(k, o);
      out.pos.push(...p); out.uv.push(uvU, uvV); out.src.push(i); out.region.push(region); out.part.push(partFn(i));
    }
    return o;
  };
  for (const f of sel) {
    const c = f.v.map((i, k) => vert(i, f.t[k], body.uv[f.c[k] * 2], body.uv[f.c[k] * 2 + 1], regionFn(i, ring.get(i) ?? 9)));
    out.idx.push(c[0], c[1], c[2]);
    if (c.length === 4) out.idx.push(c[0], c[2], c[3]);
  }
  // Openings: an optional band continues the surface past the outline (the shirt's hem hangs
  // straight down over the shorts; collar and sleeve cuffs are trim bands), then a rim folds back to
  // the skin (no visible gap between cloth and body).
  const outward = (i) => {
    // Direction along the surface away from the garment: from the next ring in, across the edge.
    const inside = [...adj.get(i)].filter((j) => (ring.get(j) ?? 9) >= 1);
    const n = nrm.get(i) || [0, 0, 1];
    let t = inside.length ? V.sub(Q.get(i), V.mean(inside.map((j) => Q.get(j)))) : [0, -1, 0];
    t = V.add(t, n, -V.dot(t, n));
    return V.norm(t);
  };
  const bandAt = new Map();
  for (const i of onEdge) {
    const bd = band ? band(i) : null;
    if (!bd) continue;
    const n = nrm.get(i) || [0, 0, 1];
    const dir = bd.down ? V.add([0, -1, 0], n, 0.18) : outward(i);
    bandAt.set(i, { ...bd, p: V.add(V.add(Q.get(i), dir, bd.len), n, bd.down ? 0 : 0.0015) });
  }
  // Smooth the band's free edge along the loop like the outline itself.
  for (let it = 0; it < 12; it++) {
    for (const [i, bd] of bandAt) {
      const nb = edgeAdj.get(i).filter((j) => bandAt.has(j)).map((j) => bandAt.get(j).p);
      if (nb.length) bd.p = V.lerp(bd.p, V.mean(nb), 0.5);
    }
  }
  for (const e of edges) {
    const k = e.f.v.indexOf(e.a);
    const uvA = [body.uv[e.f.c[k] * 2], body.uv[e.f.c[k] * 2 + 1]];
    const kb = e.f.v.indexOf(e.b);
    const uvB = [body.uv[e.f.c[kb] * 2], body.uv[e.f.c[kb] * 2 + 1]];
    let regA = regionFn(e.a, 0), regB = regionFn(e.b, 0);
    let a = vert(e.a, `${e.f.t[k]}`, uvA[0], uvA[1], regA);
    let b = vert(e.b, `${e.f.t[kb]}`, uvB[0], uvB[1], regB);
    let depthA = 0, depthB = 0;
    const BA = bandAt.get(e.a), BB = bandAt.get(e.b);
    if (BA && BB) {
      const ra = BA.region ?? regA, rb = BB.region ?? regB;
      // The band's own copies of the outline (its colour does not bleed into the shell).
      const a0 = ra === regA ? a : vert(e.a, `bo${e.f.t[k]}`, uvA[0], uvA[1], ra);
      const b0 = rb === regB ? b : vert(e.b, `bo${e.f.t[kb]}`, uvB[0], uvB[1], rb);
      const a2 = vert(e.a, `band${e.f.t[k]}`, uvA[0], uvA[1] - BA.len * 1.2, ra, BA.p);
      const b2 = vert(e.b, `band${e.f.t[kb]}`, uvB[0], uvB[1] - BB.len * 1.2, rb, BB.p);
      out.idx.push(a0, b2, b0, a0, a2, b2);
      a = a2; b = b2; regA = ra; regB = rb;
      depthA = BA.down ? BA.len : 0; depthB = BB.down ? BB.len : 0;
    }
    const innerOf = (i, pt, d) => V.add(V.add(pt, nrm.get(i) || [0, 0, 1], -Math.max(0.001, OFF.get(i) - 0.002)), [0, -1, 0], d * 0.0);
    const pa = out.pos.slice(a * 3, a * 3 + 3), pb = out.pos.slice(b * 3, b * 3 + 3);
    const ai = vert(e.a, `rim${e.f.t[k]}`, uvA[0], uvA[1], regA, innerOf(e.a, pa, depthA));
    const bi = vert(e.b, `rim${e.f.t[kb]}`, uvB[0], uvB[1], regB, innerOf(e.b, pb, depthB));
    // Outer edge a->b follows the face winding; the rim continues the surface outward-then-in.
    out.idx.push(b, a, ai, b, ai, bi);
  }
  const n = out.src.length;
  const part = {
    positions: Float64Array.from(out.pos), uv: Float64Array.from(out.uv), index: Uint32Array.from(out.idx), src: Int32Array.from(out.src),
    region: Uint8Array.from(out.region), part: Uint8Array.from(out.part), skinIndex: new Uint8Array(n * 4), skinWeight: new Float64Array(n * 4), aux: new Float64Array(n * 2).fill(1),
  };
  return { part, ids: new Set(ids), onEdge, ring, Q };
}

/**
 * @returns {{ body, shells: part[] }} body: the skin part minus the covered faces.
 */
export function buildClothes(base, body, { REGION, PART, BI }, { hide = null } = {}) {
  const female = base.name === 'female';
  const opts = female
    ? { shirtHem: 0.055, waist: 0.03, collarHalf: 0.075, collarBack: 0.035, collarDip: 0.55, sleeve: 0.1, shortsLen: 0.17, drop: 0.03 }
    : { shirtHem: 0.06, waist: 0.04, collarHalf: 0.085, collarBack: 0.04, collarDip: 0.5, sleeve: 0.135, shortsLen: 0.25, drop: 0.045 };
  const C = classifier(base, opts);
  const P = base.P;
  // Body faces with their MH ids, uv corner keys and output corners.
  const bodyFaces = body.faces.map((f) => ({ v: f.v, c: f.c, t: f.c.map((c) => c) }));
  const shirtSel = closeSelection(bodyFaces, (i) => C.shirt(i));
  const shortsSel = closeSelection(bodyFaces, (i) => C.shorts(i));
  const w = (i, b) => (base.gameW[i] && base.gameW[i].get(b)) || 0;
  const side = (i) => (base.posed[i * 3] < 0 ? 'R' : 'L');
  const isArm = (i) => { const S = side(i); return w(i, `upperArm${S}`) + w(i, `foreArm${S}`) > 0.5; };
  const shortsOff = (i, p) => {
    const S = side(i);
    const thigh = w(i, `thigh${S}`);
    // Waistband snug, legs flaring loose toward the hem.
    const down = V.clamp((C.waistY - p[1]) / 0.32, 0, 1);
    return 0.008 + (female ? 0.016 : 0.032) * Math.pow(down, 1.5) * (0.35 + 0.65 * V.clamp(thigh * 1.4, 0, 1));
  };
  const shirtOff = (i, p) => {
    if (isArm(i)) return female ? 0.006 : 0.009;
    const belly = V.smooth(P.chest[1] + 0.02, P.spine[1] - 0.05, p[1]); // 0 at the chest -> 1 below the ribs
    let off = (female ? 0.005 : 0.007) + (female ? 0.006 : 0.011) * belly;
    if (p[1] < C.waistY + 0.02) off = Math.max(off, shortsOff(i, p) + 0.007); // over the shorts' waistband
    return off;
  };
  const so = shell(base, body, shortsSel, {
    offFn: shortsOff,
    regionFn: () => REGION.SHORTS,
    partFn: () => PART.BODY,
    iterations: 40,
    minScale: 0.5,
  });
  const sh = shell(base, body, shirtSel, {
    offFn: shirtOff,
    regionFn: () => REGION.SHIRT,
    under: so.Q,
    partFn: (i) => (isArm(i) ? PART.ARMS : PART.BODY),
    // The hem hangs loose below the last ring (over the shorts' waistband); collar and sleeve cuffs
    // are ribbed trim bands.
    band: (i) => {
      if (isArm(i)) return { len: 0.016, region: REGION.TRIM };
      if (base.posed[i * 3 + 1] > P.chest[1] + 0.1) return { len: 0.014, region: REGION.TRIM };
      return { len: opts.drop, down: true };
    },
  });
  // Weights: the skin right under each shell vertex (the drape slid it off its source vertex).
  const surf = bodySurface(base, body.faces);
  for (const [name, s] of [['shirt', sh], ['shorts', so]]) {
    const ws = Array.from(s.part.src, (i) => base.gameW[i]);
    setW(s.part, ws, BI);
    computeNormals(s.part);
    if (!process.env.PEOPLE_SOURCE_WEIGHTS) {
      const r = transferWeights(s.part, surf, base);
      if (process.env.PEOPLE_DEBUG) console.log(`    ${name}: ${r.moved} vertices re-weighted from the skin under them, ${r.kept} kept`);
    }
  }
  // Where the shirt hangs over the shorts it bends with them (a crouch lifts the shorts' front
  // into the hem otherwise): full share from the waistband down, none 4 cm above it.
  if (!process.env.PEOPLE_SOURCE_WEIGHTS) {
    const lower = partSurface(so.part);
    const P2 = sh.part.positions;
    const top = C.waistY + 0.05;
    const m = followLayer(sh.part, lower, (i) => V.smooth(top, top - 0.04, P2[i * 3 + 1]), { maxDist: 0.06, minDot: 0.3 });
    if (process.env.PEOPLE_DEBUG) console.log(`    shirt: ${m} vertices follow the shorts under them`);
  }
  // Skin faces covered by a shell (all corners strictly inside it) or hidden by `hide` go.
  const covered = (i) => (sh.ids.has(i) && !sh.onEdge.has(i) && (sh.ring.get(i) ?? 9) >= 1) || (so.ids.has(i) && !so.onEdge.has(i) && (so.ring.get(i) ?? 9) >= 1);
  const keep = [];
  const I = body.index;
  let t = 0;
  for (const f of body.faces) {
    const nt = f.c.length === 4 ? 2 : 1;
    const gone = f.v.every((i) => covered(i) || (hide && hide(i)));
    if (!gone) for (let k = 0; k < nt * 3; k++) keep.push(I[t + k]);
    t += nt * 3;
  }
  const trimmed = { ...body, index: Uint32Array.from(keep) };
  if (process.env.PEOPLE_DEBUG) {
    if (!trimmed.normals) computeNormals(trimmed, body.src);
    console.log(`    poke-through (skin verts outside a shell / shorts verts outside the shirt): ${JSON.stringify(pokeTest(base, trimmed, [sh.part, so.part]))}`);
  }
  return { body: trimmed, shells: [sh.part, so.part], classify: C };
}

function setW(part, ws, BI) {
  const n = part.positions.length / 3;
  for (let i = 0; i < n; i++) {
    const w = ws[i];
    const list = w ? [...w.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4) : [['root', 1]];
    let sum = 0;
    for (const [, x] of list) sum += x;
    list.forEach(([b, x], k) => { part.skinIndex[i * 4 + k] = BI[b]; part.skinWeight[i * 4 + k] = x / sum; });
  }
}
