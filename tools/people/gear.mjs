// Shoes and headwear for the baked athletes, modelled as signed distances (render/sdfMesh.js) in a
// local frame fitted to the MakeHuman foot / head, polygonized at bake time.
import { sdPrim, compileModel, polygonize } from '../../src/render/sdfMesh.js';
import * as V from './vec.mjs';
import { SOLE } from './parts.mjs';

const smooth = V.smooth;

/** Foot frame from the body: origin under the heel on the floor, +Z along the foot, +X lateral (outside). */
function footFrame(base, S) {
  const pos = base.posed;
  const P = base.P;
  const ankle = P[`foot${S}`], ball = P[`toe${S}`];
  const fwd = V.norm([ball[0] - ankle[0], 0, ball[2] - ankle[2]]);
  const up = [0, 1, 0];
  let lat = V.norm(V.cross(up, fwd)); // left of the foot direction
  if (S === 'R') lat = V.scale(lat, -1); // +X = outside of each foot
  let zMin = Infinity, zMax = -Infinity, xMin = Infinity, xMax = -Infinity;
  const w = (i, b) => (base.gameW[i] && base.gameW[i].get(b)) || 0;
  for (let i = 0; i < pos.length / 3; i++) {
    if (w(i, `foot${S}`) + w(i, `toe${S}`) < 0.5) continue;
    const p = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    if (p[1] > ankle[1] + 0.02) continue;
    const r = V.sub(p, [ankle[0], 0, ankle[2]]);
    const z = V.dot(r, fwd), x = V.dot(r, lat);
    zMin = Math.min(zMin, z); zMax = Math.max(zMax, z); xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
  }
  const O = V.add([ankle[0], 0, ankle[2]], fwd, zMin);
  return { O, fwd, lat, up, len: zMax - zMin, xMin, xMax, ankleY: ankle[1], ballZ: V.dot(V.sub([ball[0], 0, ball[2]], O), fwd) };
}

/**
 * Shoe SDF in the local foot frame (metres; z 0 = heel, z L = toe, x + = outside, y up from the
 * floor): a cupsole with a slight toe spring, a low-cut upper (heel counter, quarters, vamp, toe
 * box), a padded collar around the foot opening and a tongue. L = shoe length, Wo / Wi = half widths
 * outside / inside at the ball.
 */
function shoeModel(L, Wo, Wi, ankleY) {
  const prims = [];
  const P = (p) => { prims.push(p); return prims.length - 1; };
  const xc = (Wo - Wi) * 0.5;
  const hw = (Wo + Wi) * 0.5 + 0.006; // half width of the upper at the ball
  const S = SOLE;
  // Sole: heel and forefoot pads blended (narrower heel), the toe lifted a little.
  const soleHeel = P(sdPrim.ellipsoid([xc * 0.4, S * 0.5, L * 0.2], [hw * 0.82, S * 0.5, L * 0.23], { k: 0.0 }));
  const soleMid = P(sdPrim.roundBox([xc * 0.7, S * 0.5, L * 0.5], [hw * 0.84, S * 0.5, L * 0.22], 0.008, null, { k: 0.03 }));
  const soleToe = P(sdPrim.ellipsoid([xc, S * 0.55 + 0.003, L * 0.78], [hw + 0.002, S * 0.55, L * 0.22], { k: 0.03 }));
  // Upper.
  const heel = P(sdPrim.ellipsoid([xc * 0.3, S + 0.03, L * 0.17], [hw * 0.8, 0.048, L * 0.17], { k: 0.0 }));
  const quarter = P(sdPrim.ellipsoid([xc * 0.5, S + 0.026, L * 0.42], [hw * 0.93, 0.042, L * 0.26], { k: 0.035 }));
  const vamp = P(sdPrim.ellipsoid([xc * 0.8, S + 0.021, L * 0.66], [hw * 0.98, 0.036, L * 0.22], { k: 0.035 }));
  const toe = P(sdPrim.ellipsoid([xc, S + 0.014, L * 0.86], [hw * 0.92, 0.024, L * 0.14], { k: 0.03 }));
  const instep = P(sdPrim.ellipsoid([xc * 0.4, S + 0.045, L * 0.48], [hw * 0.62, 0.03, L * 0.16], { k: 0.03 }));
  const collarY = Math.min(S + 0.068, ankleY + 0.005);
  const collar = P(sdPrim.roundCone([xc * 0.3, S + 0.035, L * 0.13], [xc * 0.3, collarY, L * 0.14], hw * 0.78, hw * 0.74, { k: 0.02 }));
  const tongue = P(sdPrim.roundCone([xc * 0.35, S + 0.05, L * 0.42], [xc * 0.3, collarY + 0.012, L * 0.31], 0.022, 0.018, { k: 0.02 }));
  const hole = P(sdPrim.roundCone([xc * 0.3, S + 0.05, L * 0.2], [xc * 0.3, S + 0.3, L * 0.2], hw * 0.62, hw * 0.62, { k: 0.01, op: 'sub' }));
  return compileModel({
    prims,
    groups: [
      { id: 'sole', prims: [soleHeel, soleMid, soleToe] },
      { id: 'upper', prims: [heel, quarter, vamp, toe, instep, collar, tongue, hole] },
    ],
  });
}

/** Both shoes as one part (foot / toe weights), and a hide test for the body vertices inside them. */
export function buildShoes(base, { REGION, PART, BI }, { cell = 0.0062 } = {}) {
  const parts = [];
  const models = {};
  for (const S of ['R', 'L']) {
    const F = footFrame(base, S);
    const Wo = Math.max(0.03, F.xMax), Wi = Math.max(0.025, -F.xMin);
    const model = shoeModel(F.len + 0.012, Wo, Wi, F.ankleY);
    models[S] = { F, model };
    const mesh = polygonize(model, { cell, aabb: [-0.08, -0.004, -0.03, 0.08, 0.2, F.len + 0.06] });
    const n = mesh.positions.length / 3;
    const part = {
      positions: new Float64Array(n * 3), normals: new Float64Array(n * 3), uv: new Float64Array(n * 2), index: mesh.index,
      region: new Uint8Array(n), part: new Uint8Array(n).fill(PART.BODY), skinIndex: new Uint8Array(n * 4), skinWeight: new Float64Array(n * 4),
      aux: new Float64Array(n * 2).fill(1), ao: Float64Array.from(mesh.ao),
    };
    const toLocal = (x, y, z) => V.add(V.add(V.add(F.O, F.lat, x), F.up, y), F.fwd, z);
    for (let v = 0; v < n; v++) {
      const x = mesh.positions[v * 3], y = mesh.positions[v * 3 + 1], z = mesh.positions[v * 3 + 2];
      const p = toLocal(x, y, z);
      part.positions.set(p, v * 3);
      const nx = mesh.normals[v * 3], ny = mesh.normals[v * 3 + 1], nz = mesh.normals[v * 3 + 2];
      const nn = V.norm(V.add(V.add(V.scale(F.lat, nx), F.up, ny), F.fwd, nz));
      part.normals.set(nn, v * 3);
      part.uv[v * 2] = (z / 0.06) % 1; part.uv[v * 2 + 1] = (y / 0.06) % 1;
      // Regions: the sole, a midsole band and the heel counter in the accent colour, laces on top.
      const g = mesh.group[v];
      let reg = REGION.SHOE;
      if (g === 0) reg = y > SOLE * 0.72 ? REGION.SHOE_ACCENT : REGION.SOLE;
      else if (y > SOLE + 0.04 && z > F.len * 0.3 && z < F.len * 0.62 && Math.abs(x - 0.003) < 0.017) reg = REGION.LACE;
      else if (z < F.len * 0.12 && y > SOLE + 0.012) reg = REGION.SHOE_ACCENT;
      part.region[v] = reg;
      const t = smooth(F.ballZ - 0.03, F.ballZ + 0.02, z);
      const list = [[`foot${S}`, 1 - t], [`toe${S}`, t]].filter(([, x2]) => x2 > 1e-4);
      list.forEach(([b, x2], k) => { part.skinIndex[v * 4 + k] = BI[b]; part.skinWeight[v * 4 + k] = x2; });
    }
    parts.push(part);
  }
  const merged = mergeSimple(parts);
  // Body vertices inside a shoe (with a 2 mm margin) are hidden.
  const inside = (i) => {
    const p = [base.posed[i * 3], base.posed[i * 3 + 1], base.posed[i * 3 + 2]];
    for (const S of ['R', 'L']) {
      const { F, model } = models[S];
      const r = V.sub(p, F.O);
      const d = model.eval(V.dot(r, F.lat), r[1], V.dot(r, F.fwd), null);
      if (d < -0.002) return true;
    }
    return false;
  };
  return { part: merged, inside };
}

function mergeSimple(parts) {
  let nv = 0, ni = 0;
  for (const p of parts) { nv += p.positions.length / 3; ni += p.index.length; }
  const o = {
    positions: new Float64Array(nv * 3), normals: new Float64Array(nv * 3), uv: new Float64Array(nv * 2), index: new Uint32Array(ni),
    region: new Uint8Array(nv), part: new Uint8Array(nv), skinIndex: new Uint8Array(nv * 4), skinWeight: new Float64Array(nv * 4), aux: new Float64Array(nv * 2).fill(1), ao: new Float64Array(nv).fill(1),
  };
  let ov = 0, oi = 0;
  for (const p of parts) {
    const n = p.positions.length / 3;
    o.positions.set(p.positions, ov * 3); o.normals.set(p.normals, ov * 3); o.uv.set(p.uv, ov * 2);
    o.region.set(p.region, ov); o.part.set(p.part, ov); o.skinIndex.set(p.skinIndex, ov * 4); o.skinWeight.set(p.skinWeight, ov * 4);
    if (p.ao) o.ao.set(p.ao, ov);
    for (let i = 0; i < p.index.length; i++) o.index[oi + i] = p.index[i] + ov;
    ov += n; oi += p.index.length;
  }
  return o;
}

// ------------------------------------------------------------------ headwear

/** Skull ellipsoid of the posed head (above the eyes): center, radii, the brow line height. */
export function headInfo(base) {
  const pos = base.posed;
  const w = (i, b) => (base.gameW[i] && base.gameW[i].get(b)) || 0;
  const eyeY = (base.J[base.mh.skel.bones['eye.R'].head][1] + base.J[base.mh.skel.bones['eye.L'].head][1]) / 2;
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length / 3; i++) {
    if (w(i, 'head') < 0.95 || pos[i * 3 + 1] < eyeY) continue;
    for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], pos[i * 3 + k]); mx[k] = Math.max(mx[k], pos[i * 3 + k]); }
  }
  const r = [(mx[0] - mn[0]) / 2, mx[1] - eyeY, (mx[2] - mn[2]) / 2];
  const c = [(mx[0] + mn[0]) / 2, eyeY, (mx[2] + mn[2]) / 2];
  return { center: c.map((x) => +x.toFixed(4)), radii: r.map((x) => +x.toFixed(4)), eyeY: +eyeY.toFixed(4), top: +mx[1].toFixed(4) };
}

/** Cap, visor and headband parts around the posed head (rigid to the head bone). */
export function buildHeadwear(base, { REGION, PART, BI }, { cell = 0.0085 } = {}) {
  const H = headInfo(base);
  const [cx, cy, cz] = H.center;
  const [rx, ry, rz] = H.radii;
  // Skull ellipsoid centred at the brow level, a little above it in z-centre.
  const skull = () => sdPrim.ellipsoid([cx, cy, cz], [rx * 1.0, ry * 1.0, rz * 1.0]);
  const browY = cy + ry * 0.22; // where a cap brim sits (just above the eyebrows)
  const out = {};
  const kinds = {
    cap: () => {
      const a = -0.18;
      const basis = [[1, 0, 0], [0, Math.cos(a), Math.sin(a)], [0, -Math.sin(a), Math.cos(a)]];
      const prims = [skull(), sdPrim.roundBox([cx, browY + 0.002, cz + rz * 0.98 + 0.03], [rx * 0.82, 0.0045, 0.055], 0.004, basis), sdPrim.sphere([cx, cy + ry + 0.018, cz - 0.006], 0.009)];
      return {
        prims,
        groups: [
          { id: 'crown', prims: [0], inflate: () => 0.021, clipK: 0.006, clip: [(x, y, z) => browY - 0.004 - 0.014 * smooth(cz, cz - rz * 0.9, z) - y] },
          { id: 'brim', prims: [1] },
          { id: 'button', prims: [2] },
        ],
      };
    },
    visor: () => {
      const a = -0.18;
      const basis = [[1, 0, 0], [0, Math.cos(a), Math.sin(a)], [0, -Math.sin(a), Math.cos(a)]];
      const prims = [skull(), sdPrim.roundBox([cx, browY + 0.002, cz + rz * 0.98 + 0.03], [rx * 0.82, 0.0045, 0.055], 0.004, basis)];
      return {
        prims,
        groups: [
          { id: 'band', prims: [0], inflate: () => 0.016, clipK: 0.005, clip: [(x, y) => Math.max(browY - 0.012 - y, y - browY - 0.022)] },
          { id: 'brim', prims: [1] },
        ],
      };
    },
    headband: () => ({
      prims: [skull()],
      groups: [{ id: 'band', prims: [0], inflate: () => 0.015, clipK: 0.005, clip: [(x, y, z) => Math.max(browY - 0.008 - 0.012 * smooth(cz, cz - rz, z) - y, y - browY - 0.03 + 0.012 * smooth(cz, cz - rz, z))] }],
    }),
  };
  for (const [kind, make] of Object.entries(kinds)) {
    const m = make();
    const model = compileModel(m);
    const mesh = polygonize(model, { cell, aabb: [cx - rx - 0.05, browY - 0.04, cz - rz - 0.05, cx + rx + 0.05, cy + ry + 0.06, cz + rz + 0.1] });
    const n = mesh.positions.length / 3;
    const ids = m.groups.map((g) => g.id);
    const part = {
      positions: Float64Array.from(mesh.positions), normals: Float64Array.from(mesh.normals), uv: new Float64Array(n * 2), index: mesh.index,
      region: new Uint8Array(n), part: new Uint8Array(n).fill(PART.HEAD), skinIndex: new Uint8Array(n * 4), skinWeight: new Float64Array(n * 4),
      aux: new Float64Array(n * 2).fill(1), ao: Float64Array.from(mesh.ao),
    };
    for (let v = 0; v < n; v++) {
      const id = ids[mesh.group[v]];
      const x = mesh.positions[v * 3], y = mesh.positions[v * 3 + 1], z = mesh.positions[v * 3 + 2];
      let reg = id === 'brim' || id === 'button' ? REGION.HEADWEAR_ACCENT : REGION.HEADWEAR;
      if (id === 'crown' && z > cz + rz * 0.75 && Math.abs(x - cx) < 0.026 && y > browY + 0.012 && y < browY + 0.045) reg = REGION.HEADWEAR_ACCENT;
      part.region[v] = reg;
      part.skinIndex[v * 4] = BI.head; part.skinWeight[v * 4] = 1;
      part.uv[v * 2] = ((x + z) / 0.05) % 1; part.uv[v * 2 + 1] = (y / 0.05) % 1;
    }
    out[kind] = part;
  }
  return { parts: out, headInfo: H };
}
