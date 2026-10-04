// Procedural canvas textures for the club. Everything is generated at runtime (no image files)
// and cached, so calling a factory twice returns the same THREE.Texture.
//
// Conventions:
// - Colour maps are sRGB; data maps (normal / roughness / alpha / masks) use NoColorSpace.
// - Factories that produce several maps return a primary Texture with the companions on
//   `texture.userData` ({ normalMap, roughnessMap }) unless the SPEC defines a shape.
import * as THREE from 'three';
import { COURT } from '../config.js';
import { createRng, clamp } from '../util/math.js';

const cache = new Map();
const cached = (key, make) => {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key);
};

/** Physical size (m) covered by one repeat of the turf tile. */
export const TURF_TILE_M = 1.0;
/** Physical size (m) covered by one repeat of the mesh alpha tile (10 x 50 mm cells). */
export const MESH_TILE_M = 0.5;
/** Physical size (m) covered by one repeat of the concrete tile (joints on its border). */
export const CONCRETE_TILE_M = 4.0;
/** Physical size (m) covered by one repeat of the wall panel tile. */
export const PANEL_TILE_M = 1.0;

// ---------------------------------------------------------------------------------------------
// Small helpers

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function canvasTexture(canvas, { srgb = true, repeat = true, aniso = 16 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

function dataTextureFromRGBA(data, w, h, { srgb = false, repeat = true, aniso = 16 } = {}) {
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  img.data.set(data);
  ctx.putImageData(img, 0, 0);
  return canvasTexture(canvas, { srgb, repeat, aniso });
}

/** Tileable value-noise lattice: returns sample(x, y) for x, y in lattice units. */
function valueNoise(rng, period) {
  const g = new Float32Array(period * period);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const x0 = ((xi % period) + period) % period, y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
    const a = g[y0 * period + x0], b = g[y0 * period + x1];
    const c = g[y1 * period + x0], d = g[y1 * period + x1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

/** Tileable fBm grid of size w x h, values roughly 0..1. */
function fbmGrid(w, h, { seed = 1, basePeriod = 4, octaves = 5, gain = 0.5 } = {}) {
  const rng = createRng(seed);
  const layers = [];
  for (let o = 0; o < octaves; o++) layers.push(valueNoise(rng, basePeriod << o));
  const out = new Float32Array(w * h);
  let norm = 0;
  for (let o = 0, a = 1; o < octaves; o++, a *= gain) norm += a;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0, amp = 1;
      for (let o = 0; o < octaves; o++) {
        const p = basePeriod << o;
        v += amp * layers[o]((x / w) * p, (y / h) * p);
        amp *= gain;
      }
      out[y * w + x] = v / norm;
    }
  }
  return out;
}

/** Height field (0..1, wrap) -> RGBA tangent-space normal map bytes. */
function heightToNormal(height, w, h, strength) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ym = ((y - 1 + h) % h) * w, yp = ((y + 1) % h) * w, yc = y * w;
    for (let x = 0; x < w; x++) {
      const xm = (x - 1 + w) % w, xp = (x + 1) % w;
      // Sobel
      const tl = height[ym + xm], t = height[ym + x], tr = height[ym + xp];
      const l = height[yc + xm], r = height[yc + xp];
      const bl = height[yp + xm], b = height[yp + x], br = height[yp + xp];
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength, ny = dy * strength, nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (yc + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}


// ---------------------------------------------------------------------------------------------
// Fonts (shared with labels and the club sign)

const FONT_FILES = [
  ['Big Shoulders Display', 'big-shoulders-display-latin-800-normal.woff2', '800'],
  ['Big Shoulders Display', 'big-shoulders-display-latin-900-normal.woff2', '900'],
  ['Barlow Semi Condensed', 'barlow-semi-condensed-latin-400-normal.woff2', '400'],
  ['Barlow Semi Condensed', 'barlow-semi-condensed-latin-600-normal.woff2', '600'],
  ['Barlow Semi Condensed', 'barlow-semi-condensed-latin-700-normal.woff2', '700'],
];
let fontsPromise = null;

/** Loads the project fonts into document.fonts once. Resolves even if a font fails. */
export function loadFonts() {
  if (fontsPromise) return fontsPromise;
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') {
    fontsPromise = Promise.resolve([]);
    return fontsPromise;
  }
  fontsPromise = Promise.all(
    FONT_FILES.map(([family, file, weight]) => {
      const url = new URL(`../../fonts/${file}`, import.meta.url).href;
      const face = new FontFace(family, `url(${url})`, { weight, style: 'normal' });
      return face
        .load()
        .then((f) => {
          document.fonts.add(f);
          return f;
        })
        .catch(() => null);
    }),
  );
  return fontsPromise;
}

/** Creates a canvas texture whose drawing is replayed once the fonts are available. */
function fontCanvasTexture(w, h, draw, opts) {
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  draw(ctx, w, h);
  const tex = canvasTexture(canvas, opts);
  loadFonts().then(() => {
    ctx.clearRect(0, 0, w, h);
    draw(ctx, w, h);
    tex.needsUpdate = true;
  });
  return tex;
}

export const DISPLAY_FONT = '"Big Shoulders Display", "Barlow Semi Condensed", "Arial Narrow", sans-serif';
export const UI_FONT = '"Barlow Semi Condensed", "Arial Narrow", "Helvetica Neue", sans-serif';

// ---------------------------------------------------------------------------------------------
// Turf

/**
 * Blue sand-filled artificial turf tile covering TURF_TILE_M x TURF_TILE_M.
 * Tufted monofilament fibres in 3/8" gauge rows, laid with a grain, over quartz sand infill.
 * roughnessMap packs: R = sand-visible mask (1 = sand), G = roughness (three reads G).
 * @returns {{map: THREE.Texture, normalMap: THREE.Texture, roughnessMap: THREE.Texture, tileMeters: number}}
 */
export function turfTextures(renderer, { size = 2048, seed = 7 } = {}) {
  const S = 2 ** Math.round(Math.log2(size)); // power of two: wrapped indexing uses a bit mask
  return cached(`turf:${S}:${seed}`, () => {
    const k = S / 2048; // pixel scale relative to the reference resolution (0.49 mm / px)
    const rng = createRng(seed);
    const aniso = renderer?.capabilities?.getMaxAnisotropy?.() || 16;

    // Low-frequency clump / dye variation, tileable.
    const LN = 128;
    const clump = fbmGrid(LN, LN, { seed: seed + 11, basePeriod: 8, octaves: 4, gain: 0.55 });
    const wrapL = (v) => ((Math.floor((v / S) * LN) % LN) + LN) % LN;
    const clumpAt = (x, y) => clump[wrapL(y) * LN + wrapL(x)];

    // Sand layer, written straight into pixel buffers.
    const color = new Uint8ClampedArray(S * S * 4);
    const height = new Float32Array(S * S);
    const rough = new Uint8ClampedArray(S * S * 4);
    for (let i = 0, p = 0; i < S * S; i++, p += 4) {
      const g = rng();
      const dark = g < 0.12 ? 0.62 : g > 0.93 ? 1.22 : 1;
      const tone = (0.86 + rng() * 0.22) * dark;
      color[p] = clamp(124 * tone, 0, 255);
      color[p + 1] = clamp(116 * tone, 0, 255);
      color[p + 2] = clamp(103 * tone, 0, 255);
      color[p + 3] = 255;
      height[i] = 0.12 + rng() * 0.12;
      rough[p] = 255;
      rough[p + 1] = 238;
      rough[p + 2] = 0;
      rough[p + 3] = 255;
    }
    // Blue fibre dust stains part of the sand.
    for (let i = 0, p = 0; i < S * S; i++, p += 4) {
      if (rng() < 0.3) {
        color[p] *= 0.62;
        color[p + 1] *= 0.72;
        color[p + 2] = Math.min(255, color[p + 2] * 0.98 + 18);
      }
    }

    // Rasterise fibres straight into the buffers (tileable via wrapped indices). Each fibre is a
    // tapered ribbon from its tuft to the tip: darker and lower at the base, lighter and higher
    // at the tip, with a rounded cross-section in the height field for the normal map.
    const gauge = S / Math.round(S / (19.5 * k)); // ~9.5 mm row spacing, integral rows per tile (seamless)
    const stitch = 10.5 * k; // ~5 mm stitch spacing along a row
    const SH = 24;
    const pal = [];
    const tmpC = new THREE.Color();
    for (let i = 0; i < SH; i++) {
      const b = i / (SH - 1);
      tmpC.setHSL((212 + b * 5) / 360, 0.6 + b * 0.1, 0.25 + b * 0.16, THREE.LinearSRGBColorSpace); // plain HSL->RGB, no transfer
      pal.push([tmpC.r * 255, tmpC.g * 255, tmpC.b * 255]);
    }
    const mask = S - 1; // S is a power of two
    const splatFibre = (ax, ay, bx, by, shade, width) => {
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      const steps = Math.max(2, Math.ceil(len / 0.6));
      const p0 = pal[(shade * (SH - 1)) | 0];
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = ax + dx * t, py = ay + dy * t;
        const r = (width * (1 - 0.35 * t)) * 0.5;
        const light = 0.78 + 0.42 * t; // tip catches more light
        const hTop = 0.45 + 0.5 * t;
        const x0 = Math.floor(px - r - 0.5), x1 = Math.ceil(px + r + 0.5);
        const y0 = Math.floor(py - r - 0.5), y1 = Math.ceil(py + r + 0.5);
        for (let y = y0; y <= y1; y++) {
          const row = (y & mask) * S;
          const ddy = y + 0.5 - py;
          for (let x = x0; x <= x1; x++) {
            const ddx = x + 0.5 - px;
            const d = Math.sqrt(ddx * ddx + ddy * ddy);
            const cov = r + 0.5 - d;
            if (cov <= 0) continue;
            const c = cov > 1 ? 1 : cov;
            const i = row + (x & mask);
            const q4 = i * 4;
            color[q4] += (p0[0] * light - color[q4]) * c;
            color[q4 + 1] += (p0[1] * light - color[q4 + 1]) * c;
            color[q4 + 2] += (p0[2] * light - color[q4 + 2]) * c;
            const prof = Math.sqrt(Math.max(0, 1 - (d * d) / ((r + 0.3) * (r + 0.3))));
            const h = hTop * (0.75 + 0.25 * prof);
            if (h > height[i]) height[i] += (h - height[i]) * c;
            rough[q4] += (0 - rough[q4]) * c;
            rough[q4 + 1] += ((150 + 30 * (1 - t)) - rough[q4 + 1]) * c;
          }
        }
      }
    };
    const width = Math.max(1.2, 2.3 * k);
    for (let y0 = 0; y0 < S - 1e-6; y0 += gauge) {
      for (let x0 = rng() * stitch; x0 < S; x0 += stitch * (0.8 + rng() * 0.4)) {
        const cx = x0 + (rng() - 0.5) * 3 * k;
        const cy = y0 + (rng() - 0.5) * gauge * 0.7; // break up the tuft rows (no corduroy)
        const cl = clumpAt(cx, cy);
        const lean = Math.PI * 0.5 + (cl - 0.5) * 1.6; // grain direction (+v), wandering by clumps
        const n = 6 + ((rng() * 4) | 0);
        for (let f = 0; f < n; f++) {
          const a = lean + (rng() - 0.5) * 2.4;
          const len = (9 + rng() * 11) * k;
          const shade = clamp(0.25 + 0.5 * cl + (rng() - 0.5) * 0.7, 0, 0.999);
          splatFibre(cx, cy, cx + Math.cos(a) * len, cy + Math.sin(a) * len, shade, width);
        }
      }
    }

    const normalBytes = heightToNormal(height, S, S, 1.6 / k);
    const map = dataTextureFromRGBA(color, S, S, { srgb: true, aniso });
    const normalMap = dataTextureFromRGBA(normalBytes, S, S, { aniso });
    const roughnessMap = dataTextureFromRGBA(rough, S, S, { aniso });
    return { map, normalMap, roughnessMap, tileMeters: TURF_TILE_M };
  });
}

/**
 * Court-scale wear/sand/roll-variation map covering the 10 x 20 m court (u = x, v = z, v=0 at z=-10).
 * R = fibre wear (0..1), G = loose sand accumulation, B = roll / dye-lot variation (0.5 neutral).
 */
export function courtWearTexture({ width = 512, height = 1024, seed = 3 } = {}) {
  return cached(`wear:${width}:${height}:${seed}`, () => {
    const W = width, H = height;
    const rng = createRng(seed);
    const n1 = fbmGrid(W / 4, H / 4, { seed: seed + 1, basePeriod: 6, octaves: 4 });
    const n2 = fbmGrid(W / 4, H / 4, { seed: seed + 2, basePeriod: 12, octaves: 3 });
    const sampleLow = (grid, x, y) => {
      const gw = W / 4, gh = H / 4;
      const gx = Math.min(gw - 1, (x / 4) | 0), gy = Math.min(gh - 1, (y / 4) | 0);
      return grid[gy * gw + gx];
    };
    // Wear hot spots: [x, |z|, sx, sz, strength]; mirrored onto both halves.
    const spots = [
      [1.9, 8.4, 1.1, 0.9, 0.85], [-1.9, 8.4, 1.1, 0.9, 0.85], [0, 8.8, 2.4, 0.7, 0.4],
      [2.2, 6.6, 0.8, 0.7, 0.35], [-2.2, 6.6, 0.8, 0.7, 0.35], [0, 6.95, 0.6, 0.5, 0.45],
      [1.6, 3.0, 1.0, 0.9, 0.55], [-1.6, 3.0, 1.0, 0.9, 0.55], [0, 1.6, 2.8, 0.6, 0.25],
      [3.9, 9.1, 0.7, 0.6, 0.45], [-3.9, 9.1, 0.7, 0.6, 0.45],
    ];
    // Scuffs (footwork marks) cluster in the same zones.
    const scuffs = [];
    for (let i = 0; i < 260; i++) {
      const s = spots[(rng() * spots.length) | 0];
      scuffs.push({
        x: s[0] + (rng() - 0.5) * s[2] * 2.2,
        z: (s[1] + (rng() - 0.5) * s[3] * 2.2) * (rng() < 0.5 ? -1 : 1),
        r: 0.06 + rng() * 0.16,
        a: rng() * Math.PI,
        e: 1.6 + rng() * 2.2,
        w: 0.15 + rng() * 0.3,
      });
    }
    const out = new Uint8ClampedArray(W * H * 4);
    for (let py = 0; py < H; py++) {
      const z = -COURT.halfLength + ((py + 0.5) / H) * COURT.halfLength * 2;
      const az = Math.abs(z);
      for (let px = 0; px < W; px++) {
        const x = -COURT.halfWidth + ((px + 0.5) / W) * COURT.halfWidth * 2;
        let wear = 0;
        for (const s of spots) {
          const dx = (x - s[0]) / s[2], dz = (az - s[1]) / s[3];
          wear += s[4] * Math.exp(-(dx * dx + dz * dz));
        }
        const nn = sampleLow(n1, px, py);
        wear *= (0.55 + nn * 0.9) * 0.75;
        // Sand drifts against the walls and into the corners.
        const dWall = Math.min(COURT.halfWidth - Math.abs(x), COURT.halfLength - az);
        let sand = Math.exp(-dWall / 0.12) * (0.4 + 0.6 * sampleLow(n2, px, py));
        const corner = Math.exp(-((COURT.halfWidth - Math.abs(x)) ** 2 + (COURT.halfLength - az) ** 2) / 0.12);
        sand += corner * 0.35;
        sand += Math.exp(-Math.abs(z) / 0.25) * 0.25 * nn; // under the net
        // 4 m wide rolls laid along z; alternate lay direction reads as faint stripes.
        const roll = Math.floor((x + COURT.halfWidth) / 4);
        const seam = Math.abs(((x + COURT.halfWidth) % 4) - 0) < 0.02 || Math.abs(((x + COURT.halfWidth) % 4) - 4) < 0.02;
        let rollVar = 0.5 + (roll % 2 === 0 ? 0.035 : -0.035) + (sampleLow(n2, px, py) - 0.5) * 0.08;
        if (seam && Math.abs(x) < COURT.halfWidth - 0.05) rollVar -= 0.06;
        const i = (py * W + px) * 4;
        out[i] = clamp(wear, 0, 1) * 255;
        out[i + 1] = clamp(sand, 0, 1) * 255;
        out[i + 2] = clamp(rollVar, 0, 1) * 255;
        out[i + 3] = 255;
      }
    }
    // Stamp scuffs (elliptical, additive wear + a little sand).
    for (const s of scuffs) {
      const cx = ((s.x + COURT.halfWidth) / (COURT.halfWidth * 2)) * W;
      const cy = ((s.z + COURT.halfLength) / (COURT.halfLength * 2)) * H;
      const rp = (s.r * s.e / (COURT.halfWidth * 2)) * W;
      const ca = Math.cos(s.a), sa = Math.sin(s.a);
      for (let y = Math.max(0, (cy - rp) | 0); y < Math.min(H, cy + rp + 1); y++) {
        for (let x = Math.max(0, (cx - rp) | 0); x < Math.min(W, cx + rp + 1); x++) {
          const dx = ((x - cx) / W) * COURT.halfWidth * 2, dy = ((y - cy) / H) * COURT.halfLength * 2;
          const u = (dx * ca + dy * sa) / (s.r * s.e), v = (-dx * sa + dy * ca) / s.r;
          const d = u * u + v * v;
          if (d < 1) {
            const i = (y * W + x) * 4;
            out[i] = Math.min(255, out[i] + (1 - d) * s.w * 150);
          }
        }
      }
    }
    const tex = dataTextureFromRGBA(out, W, H, { repeat: false, aniso: 4 });
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.flipY = false; // v = (z + 10) / 20
    return tex;
  });
}

/**
 * White playing lines (5 cm) on a 2048 x 4096 canvas covering the 10 x 20 m court
 * (u = x from -5..5, v = z from -10..10 with canvas row 0 at z = -10 -> flipY off).
 * The environment renders lines analytically in the turf shader for exact, alias-free edges;
 * this mask is provided for other consumers (minimaps, debugging).
 */
export function lineMaskTexture() {
  return cached('lines', () => {
    const W = 2048, H = 4096;
    const c = makeCanvas(W, H);
    const ctx = c.getContext('2d');
    const sx = W / (COURT.halfWidth * 2), sz = H / (COURT.halfLength * 2);
    const X = (x) => (x + COURT.halfWidth) * sx;
    const Z = (z) => (z + COURT.halfLength) * sz;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    for (const lines of courtLineRects()) {
      const [x0, x1, z0, z1] = lines;
      ctx.fillRect(X(x0), Z(z0), (x1 - x0) * sx, (z1 - z0) * sz);
    }
    const t = canvasTexture(c, { srgb: false, repeat: false, aniso: 16 });
    t.flipY = false;
    return t;
  });
}

/**
 * Court line rectangles [x0, x1, z0, z1] in court metres. Lines belong to the area they bound,
 * so service lines sit inside the service boxes (|z| from 6.90 to 6.95) and the centre line
 * straddles x = 0, running from the net to 20 cm past each service line.
 */
export function courtLineRects() {
  const w = COURT.lineWidth;
  const s = COURT.serviceLine;
  const over = COURT.centerLineOverrun;
  return [
    [-COURT.halfWidth, COURT.halfWidth, s - w, s],
    [-COURT.halfWidth, COURT.halfWidth, -s, -s + w],
    [-w / 2, w / 2, 0, s + over],
    [-w / 2, w / 2, -s - over, 0],
  ];
}

// ---------------------------------------------------------------------------------------------
// Mesh, felt, carbon, grip

/** Welded square mesh, 50 x 50 mm cells with 4 mm wire, 10 x 10 cells per tile (MESH_TILE_M). */
export function meshAlphaTexture({ size = 512 } = {}) {
  return cached(`mesh:${size}`, () => {
    const S = size;
    const c = makeCanvas(S, S);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, S, S);
    const cell = S / 10;
    const wire = (S / (MESH_TILE_M * 1000)) * 4; // px for 4 mm
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 10; i++) {
      const p = i * cell;
      ctx.fillRect(p - wire / 2, 0, wire, S);
      ctx.fillRect(0, p - wire / 2, S, wire);
    }
    // Wrap the half-wires on the far edges.
    ctx.fillRect(S - wire / 2, 0, wire / 2, S);
    ctx.fillRect(0, S - wire / 2, S, wire / 2);
    // Weld nodes.
    for (let i = 0; i <= 10; i++) {
      for (let j = 0; j <= 10; j++) {
        ctx.beginPath();
        ctx.arc(i * cell, j * cell, wire * 0.85, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    return canvasTexture(c, { srgb: false, aniso: 16 });
  });
}

/** Knotted padel net (≈45 mm squares, 3 mm twine); alpha map, 1 m tile. */
export function netAlphaTexture({ size = 512 } = {}) {
  return cached(`net:${size}`, () => {
    const S = size;
    const c = makeCanvas(S, S);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, S, S);
    const cells = 22;
    const cell = S / cells;
    const tw = Math.max(1.5, (S / 1000) * 3.2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = tw;
    ctx.beginPath();
    for (let i = 0; i <= cells; i++) {
      ctx.moveTo(i * cell, 0);
      ctx.lineTo(i * cell, S);
      ctx.moveTo(0, i * cell);
      ctx.lineTo(S, i * cell);
    }
    ctx.stroke();
    ctx.fillStyle = '#fff';
    for (let i = 0; i <= cells; i++) {
      for (let j = 0; j <= cells; j++) {
        ctx.beginPath();
        ctx.arc(i * cell, j * cell, tw * 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    return canvasTexture(c, { srgb: false, aniso: 16 });
  });
}

/**
 * Optic-yellow felt with the white seam, equirectangular for THREE.SphereGeometry UVs.
 * userData.bumpMap carries a felt-fuzz / seam-groove height map.
 */
export function ballFeltTexture({ width = 1024, height = 512 } = {}) {
  return cached(`felt:${width}`, () => {
    const W = width, H = height;
    const rng = createRng(21);
    const c = makeCanvas(W, H);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(W, H);
    const bump = new Uint8ClampedArray(W * H * 4);
    const fuzz = fbmGrid(W / 2, H / 2, { seed: 5, basePeriod: 16, octaves: 3 });
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const f = fuzz[((y >> 1) * (W >> 1)) + (x >> 1)];
        const g = 0.86 + f * 0.18 + (rng() - 0.5) * 0.12;
        img.data[i] = clamp(206 * g, 0, 255);
        img.data[i + 1] = clamp(226 * g, 0, 255);
        img.data[i + 2] = clamp(58 * g, 0, 255);
        img.data[i + 3] = 255;
        const b = 150 + (f - 0.5) * 60 + (rng() - 0.5) * 70;
        bump[i] = bump[i + 1] = bump[i + 2] = b;
        bump[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const bc = makeCanvas(W, H);
    const bctx = bc.getContext('2d');
    const bimg = bctx.createImageData(W, H);
    bimg.data.set(bump);
    bctx.putImageData(bimg, 0, 0);

    // Seam: x = a cos t + b cos 3t, y = a sin t - b sin 3t, z = 2 sqrt(ab) sin 2t (unit sphere).
    const a = 0.75, b = 0.25, cz = 2 * Math.sqrt(a * b);
    const toUV = (px, py, pz) => {
      // Map the seam's z to sphere +y (poles) so the seam wraps like a real ball.
      const X = px, Y = pz, Z = py;
      const theta = Math.acos(clamp(Y, -1, 1));
      const phi = Math.atan2(Z, -X);
      return [((phi / (Math.PI * 2)) + 1) % 1 * W, (theta / Math.PI) * H, theta];
    };
    const seamW = W * 0.0075;
    for (const [cctx, col, wMul] of [
      [ctx, 'rgba(244,246,236,1)', 1],
      [bctx, 'rgb(60,60,60)', 1.25],
    ]) {
      cctx.fillStyle = col;
      for (let i = 0; i < 4000; i++) {
        const t = (i / 4000) * Math.PI * 2;
        const [u, v, theta] = toUV(a * Math.cos(t) + b * Math.cos(3 * t), a * Math.sin(t) - b * Math.sin(3 * t), cz * Math.sin(2 * t));
        const rx = (seamW * wMul) / Math.max(0.15, Math.sin(theta));
        for (const du of [-W, 0, W]) {
          cctx.beginPath();
          cctx.ellipse(u + du, v, rx, seamW * wMul, 0, 0, Math.PI * 2);
          cctx.fill();
        }
      }
    }
    const tex = canvasTexture(c, { srgb: true, repeat: false });
    tex.wrapS = THREE.RepeatWrapping;
    tex.userData.bumpMap = canvasTexture(bc, { srgb: false, repeat: false });
    tex.userData.bumpMap.wrapS = THREE.RepeatWrapping;
    return tex;
  });
}

/** 2x2 twill carbon weave (12K look). userData: { normalMap, roughnessMap }. */
export function carbonTexture({ size = 512, tows = 16 } = {}) {
  return cached(`carbon:${size}:${tows}`, () => {
    const S = size;
    const rng = createRng(31);
    const cell = S / tows;
    const col = new Uint8ClampedArray(S * S * 4);
    const hgt = new Float32Array(S * S);
    const rgh = new Uint8ClampedArray(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const ci = Math.floor(x / cell), cj = Math.floor(y / cell);
        const warp = ((ci + cj) & 3) < 2;
        const fx = (x % cell) / cell, fy = (y % cell) / cell;
        const across = warp ? fx : fy; // position across the tow
        const along = warp ? fy : fx;
        const crown = Math.sin(across * Math.PI); // tow cross-section
        const fibre = 0.5 + 0.5 * Math.sin((warp ? x : y) * 2.9 + rng() * 0.6);
        const sheen = warp ? 1.0 : 0.62; // fibres along vs across the light read differently
        const v = (16 + 26 * crown * sheen + 7 * fibre) * (0.92 + 0.08 * Math.sin(along * Math.PI));
        const i = (y * S + x) * 4;
        col[i] = v;
        col[i + 1] = v * 1.02;
        col[i + 2] = v * 1.08;
        col[i + 3] = 255;
        hgt[y * S + x] = crown * 0.8 + fibre * 0.05;
        rgh[i] = 0;
        rgh[i + 1] = 70 + (1 - crown) * 60;
        rgh[i + 2] = 0;
        rgh[i + 3] = 255;
      }
    }
    const map = dataTextureFromRGBA(col, S, S, { srgb: true });
    map.userData.normalMap = dataTextureFromRGBA(heightToNormal(hgt, S, S, 1.2), S, S);
    map.userData.roughnessMap = dataTextureFromRGBA(rgh, S, S);
    return map;
  });
}

/**
 * Overgrip wrap: u around the handle, v along it (one repeat ≈ 6 cm of handle).
 * userData.normalMap carries the overlap ridges and perforations.
 */
export function gripTexture({ width = 256, height = 512, color = '#f1efe8' } = {}) {
  return cached(`grip:${width}:${color}`, () => {
    const W = width, H = height;
    const rng = createRng(41);
    const base = new THREE.Color(color);
    const col = new Uint8ClampedArray(W * H * 4);
    const hgt = new Float32Array(W * H);
    const bands = 2; // tape turns per repeat
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // Helical coordinate: tape edges run diagonally.
        const s = ((y / H) * bands + (x / W)) % 1;
        const overlap = s > 0.82 ? (s - 0.82) / 0.18 : 0;
        const ridge = Math.exp(-((s - 0.82) ** 2) / 0.0006);
        const perf = (Math.floor(x / 9) + Math.floor(y / 9)) % 2 === 0 && ((x % 9) - 4) ** 2 + ((y % 9) - 4) ** 2 < 3 ? 1 : 0;
        const shade = 0.9 + rng() * 0.08 - overlap * 0.1 - perf * 0.18;
        const i = (y * W + x) * 4;
        col[i] = base.r * 255 * shade;
        col[i + 1] = base.g * 255 * shade;
        col[i + 2] = base.b * 255 * shade;
        col[i + 3] = 255;
        hgt[y * W + x] = 0.5 + overlap * 0.4 + ridge * 0.3 - perf * 0.4;
      }
    }
    const map = dataTextureFromRGBA(col, W, H, { srgb: true });
    map.userData.normalMap = dataTextureFromRGBA(heightToNormal(hgt, W, H, 2.5), W, H);
    return map;
  });
}

// ---------------------------------------------------------------------------------------------
// Hall surfaces

/**
 * Dark polished concrete, CONCRETE_TILE_M per repeat with saw-cut joints on the border.
 * userData: { normalMap, roughnessMap }.
 */
export function concreteTexture({ size = 1024 } = {}) {
  return cached(`concrete:${size}`, () => {
    const S = size;
    const rng = createRng(51);
    const mott = fbmGrid(S / 2, S / 2, { seed: 52, basePeriod: 4, octaves: 6, gain: 0.55 });
    const stain = fbmGrid(S / 4, S / 4, { seed: 53, basePeriod: 3, octaves: 4 });
    const col = new Uint8ClampedArray(S * S * 4);
    const hgt = new Float32Array(S * S);
    const rgh = new Uint8ClampedArray(S * S * 4);
    const joint = Math.max(2, S / 512);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const m = mott[((y >> 1) * (S >> 1)) + (x >> 1)];
        const st = stain[((y >> 2) * (S >> 2)) + (x >> 2)];
        const agg = rng() < 0.035 ? (rng() - 0.3) * 0.5 : 0;
        let v = 0.5 + (m - 0.5) * 0.55 + agg + (rng() - 0.5) * 0.05;
        const isJoint = x < joint || y < joint;
        if (isJoint) v *= 0.35;
        const i = (y * S + x) * 4;
        const g = 78 * v + 8 * st;
        col[i] = g * 0.97;
        col[i + 1] = g * 0.99;
        col[i + 2] = g * 1.04;
        col[i + 3] = 255;
        hgt[y * S + x] = isJoint ? 0 : 0.6 + (m - 0.5) * 0.05 + agg * 0.2;
        rgh[i] = 0;
        rgh[i + 1] = clamp(255 * (0.32 + st * 0.35 + (isJoint ? 0.4 : 0)), 0, 255);
        rgh[i + 2] = 0;
        rgh[i + 3] = 255;
      }
    }
    const map = dataTextureFromRGBA(col, S, S, { srgb: true });
    map.userData.normalMap = dataTextureFromRGBA(heightToNormal(hgt, S, S, 0.8), S, S);
    map.userData.roughnessMap = dataTextureFromRGBA(rgh, S, S);
    return map;
  });
}

/**
 * Anthracite insulated sandwich wall panel (1 m module, micro-ribbed with a deep joint).
 * userData: { normalMap, roughnessMap }.
 */
export function panelTexture({ size = 512 } = {}) {
  return cached(`panel:${size}`, () => {
    const S = size;
    const rng = createRng(61);
    const col = new Uint8ClampedArray(S * S * 4);
    const hgt = new Float32Array(S * S);
    const rgh = new Uint8ClampedArray(S * S * 4);
    const noise = fbmGrid(S / 4, S / 4, { seed: 62, basePeriod: 4, octaves: 4 });
    for (let y = 0; y < S; y++) {
      const fy = y / S;
      const rib = 0.5 + 0.5 * Math.cos(fy * Math.PI * 2 * 8); // 8 micro ribs per module
      const joint = fy < 0.012 ? 0 : fy < 0.03 ? (fy - 0.012) / 0.018 : 1;
      for (let x = 0; x < S; x++) {
        const n = noise[((y >> 2) * (S >> 2)) + (x >> 2)];
        const v = (44 + rib * 6 + n * 8 + (rng() - 0.5) * 2) * (0.35 + 0.65 * joint);
        const i = (y * S + x) * 4;
        col[i] = v;
        col[i + 1] = v * 1.02;
        col[i + 2] = v * 1.07;
        col[i + 3] = 255;
        hgt[y * S + x] = rib * 0.25 * joint + joint * 0.75;
        rgh[i] = 0;
        rgh[i + 1] = 120 + n * 60;
        rgh[i + 2] = 0;
        rgh[i + 3] = 255;
      }
    }
    const map = dataTextureFromRGBA(col, S, S, { srgb: true });
    map.userData.normalMap = dataTextureFromRGBA(heightToNormal(hgt, S, S, 3.0), S, S);
    map.userData.roughnessMap = dataTextureFromRGBA(rgh, S, S);
    return map;
  });
}

/**
 * Club wordmark on a transparent canvas (white letters; the accent is optic yellow).
 * Default text "VÍBORA PADEL CLUB": a serpent-V mark, VÍBORA in display type, PADEL CLUB tracked out.
 * Returns an sRGB texture (aspect 4:1) suitable as map/emissiveMap with alpha.
 */
export function logoTexture(text = 'VÍBORA PADEL CLUB', { width = 2048, height = 512, accent = '#d9f03a' } = {}) {
  return cached(`logo:${text}:${width}:${accent}`, () => {
    const words = text.trim().split(/\s+/);
    const main = words[0] || '';
    const sub = words.slice(1).join(' ');
    return fontCanvasTexture(width, height, (ctx, W, H) => {
      ctx.clearRect(0, 0, W, H);
      // Mark: a ring with an S-curve (a serpent cutting a ball seam).
      const r = H * 0.36, cx = H * 0.5, cy = H * 0.5;
      ctx.lineWidth = H * 0.045;
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = accent;
      ctx.lineWidth = H * 0.06;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.62, cy - r * 0.55);
      ctx.bezierCurveTo(cx + r * 0.9, cy - r * 0.75, cx - r * 0.9, cy + r * 0.75, cx + r * 0.62, cy + r * 0.55);
      ctx.stroke();
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(cx + r * 0.62, cy + r * 0.55, H * 0.045, 0, Math.PI * 2);
      ctx.fill();
      // Wordmark.
      const left = H * 1.04;
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'alphabetic';
      ctx.font = `900 ${Math.round(H * 0.62)}px ${DISPLAY_FONT}`;
      ctx.fillText(main, left, H * 0.66);
      const mainW = ctx.measureText(main).width;
      if (sub) {
        ctx.font = `600 ${Math.round(H * 0.17)}px ${UI_FONT}`;
        const letters = sub.toUpperCase().split('');
        const natural = ctx.measureText(sub.toUpperCase()).width;
        const spacing = Math.max(0, (mainW - natural) / Math.max(1, letters.length - 1));
        let x = left + 4;
        for (const ch of letters) {
          ctx.fillText(ch, x, H * 0.9);
          x += ctx.measureText(ch).width + spacing;
        }
      }
    }, { srgb: true, repeat: false, aniso: 8 });
  });
}

/**
 * Generic label texture for in-world signage (target zones, etc.). Not cached: one per label.
 * lines: [{ text, size (fraction of height), weight, font: 'display'|'ui', color }]
 */
export function labelTexture(lines, { width = 1024, height = 256, background = null, align = 'center' } = {}) {
  return fontCanvasTexture(width, height, (ctx, W, H) => {
    ctx.clearRect(0, 0, W, H);
    if (background) {
      ctx.fillStyle = background;
      const r = H * 0.16;
      ctx.beginPath();
      ctx.roundRect(4, 4, W - 8, H - 8, r);
      ctx.fill();
    }
    const total = lines.reduce((s, l) => s + l.size, 0);
    let y = (H - total * H) / 2;
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    for (const l of lines) {
      const px = Math.round(l.size * H);
      const family = l.font === 'ui' ? UI_FONT : DISPLAY_FONT;
      ctx.font = `${l.weight || 700} ${px}px ${family}`;
      // Shrink a line that would overflow the label (long zone names were cut at both ends).
      const maxW = W - 48;
      const w = ctx.measureText(l.text).width;
      if (w > maxW) ctx.font = `${l.weight || 700} ${Math.max(8, Math.floor((px * maxW) / w))}px ${family}`;
      ctx.fillStyle = l.color || '#ffffff';
      if (l.shadow !== false) {
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = px * 0.12;
      }
      ctx.fillText(l.text, align === 'center' ? W / 2 : 24, y + px * 0.04);
      ctx.shadowBlur = 0;
      y += px;
    }
  }, { srgb: true, repeat: false, aniso: 8 });
}

/** Soft round sprite (white, alpha falloff) used by particles and glows. */
export function softSpriteTexture({ size = 128, hardness = 0.0 } = {}) {
  return cached(`sprite:${size}:${hardness}`, () => {
    const c = makeCanvas(size, size);
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(clamp(hardness, 0, 0.95), 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return canvasTexture(c, { srgb: false, repeat: false, aniso: 1 });
  });
}

// ---------------------------------------------------------------------------------------------
// Glass smudges, LED board graphics, stone paving (venues, round 4)

/**
 * Smudges on a 2 x 3 m glass pane, two variants side by side (u 0..0.5, 0.5..1; v = height / 3 m).
 * R = grease (finger and palm prints near the corners and doors, cleaning-cloth arcs, haze),
 * G = ball felt marks (round, some smeared by the skid), B = water spots and drip streaks (outdoor).
 * Data texture (NoColorSpace), linear filtered with mipmaps; shared (never disposed by a venue).
 */
export function glassSmudgeTexture({ width = 1024, height = 768, seed = 91 } = {}) {
  return cached(`smudge:${width}:${seed}`, () => {
    const W = width, H = height;
    const PW = W / 2; // one pane: 2 m wide
    const ppm = PW / 2; // pixels per metre
    const rng = createRng(seed);
    const layer = () => {
      const c = makeCanvas(W, H);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      return { c, ctx };
    };
    const R = layer(), G = layer(), B = layer();
    const Y = (m) => H - m * ppm; // canvas y of a height in metres
    const blob = (ctx, x, y, rx, ry, a, rot = 0) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.scale(rx, ry);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(0.55, `rgba(255,255,255,${a * 0.6})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };
    for (let v = 0; v < 2; v++) {
      const x0 = v * PW;
      // Haze blotches.
      for (let i = 0; i < 9; i++) blob(R.ctx, x0 + rng() * PW, Y(0.3 + rng() * 2.4), 40 + rng() * 90, 30 + rng() * 70, 0.05 + rng() * 0.08, rng() * 3);
      // Hand / finger prints: near a vertical edge (the corners, the door) at 0.9–1.8 m.
      const hands = 1 + Math.floor(rng() * 3);
      for (let h = 0; h < hands; h++) {
        const edge = rng() < 0.5 ? 0.12 + rng() * 0.35 : 2 - 0.12 - rng() * 0.35;
        const hx = x0 + edge * ppm, hy = Y(0.95 + rng() * 0.85);
        const rot = (rng() - 0.5) * 0.8;
        const s = ppm * (0.9 + rng() * 0.2);
        blob(R.ctx, hx, hy, 0.045 * s, 0.055 * s, 0.32, rot); // palm
        for (let f = 0; f < 4; f++) {
          const ang = rot - 0.45 + f * 0.3;
          blob(R.ctx, hx + Math.sin(ang) * 0.09 * s, hy - Math.cos(ang) * 0.09 * s, 0.011 * s, 0.017 * s, 0.4, ang);
        }
        blob(R.ctx, hx + 0.07 * s * Math.cos(rot), hy + 0.02 * s, 0.012 * s, 0.018 * s, 0.35, rot + 1.1); // thumb
        for (let k = 0; k < 5; k++) blob(R.ctx, hx + (rng() - 0.5) * 0.4 * ppm, hy + (rng() - 0.5) * 0.4 * ppm, 0.012 * ppm, 0.016 * ppm, 0.3, rng() * 3);
      }
      // Cleaning-cloth arcs.
      R.ctx.lineCap = 'round';
      for (let i = 0; i < 6; i++) {
        const cx = x0 + rng() * PW, cy = Y(0.6 + rng() * 2.0), r = (0.25 + rng() * 0.5) * ppm;
        const a0 = rng() * Math.PI * 2;
        R.ctx.strokeStyle = `rgba(255,255,255,${0.05 + rng() * 0.07})`;
        R.ctx.lineWidth = 0.08 * ppm + rng() * 0.08 * ppm;
        R.ctx.beginPath();
        R.ctx.arc(cx, cy, r, a0, a0 + 1.2 + rng() * 1.8);
        R.ctx.stroke();
      }
      // Ball felt marks: where balls strike the glass (0.35–2.6 m), some smeared sideways.
      const n = 12 + Math.floor(rng() * 16);
      for (let i = 0; i < n; i++) {
        const bx = x0 + (0.1 + rng() * 1.8) * ppm, by = Y(0.35 + rng() ** 1.3 * 2.25);
        const smear = rng() < 0.35 ? 1.6 + rng() * 2 : 1;
        blob(G.ctx, bx, by, 0.036 * ppm * smear, 0.034 * ppm, 0.25 + rng() * 0.35, (rng() - 0.5) * 0.5);
        blob(G.ctx, bx, by, 0.018 * ppm, 0.018 * ppm, 0.25, 0);
      }
      // Water spots (rings) and drip streaks from the top rail.
      for (let i = 0; i < 260; i++) {
        const sx = x0 + rng() * PW, sy = Y(rng() ** 0.8 * 3);
        const r = 1.5 + rng() * 4.5;
        B.ctx.strokeStyle = `rgba(255,255,255,${0.2 + rng() * 0.35})`;
        B.ctx.lineWidth = 0.8 + rng();
        B.ctx.beginPath();
        B.ctx.arc(sx, sy, r, 0, Math.PI * 2);
        B.ctx.stroke();
      }
      for (let i = 0; i < 14; i++) {
        const sx = x0 + rng() * PW, len = (0.3 + rng() * 1.4) * ppm;
        const g = B.ctx.createLinearGradient(sx, Y(3), sx, Y(3) + len);
        g.addColorStop(0, 'rgba(255,255,255,0.35)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        B.ctx.strokeStyle = g;
        B.ctx.lineWidth = 2 + rng() * 3;
        B.ctx.beginPath();
        B.ctx.moveTo(sx, Y(3));
        B.ctx.bezierCurveTo(sx + (rng() - 0.5) * 8, Y(3) + len * 0.3, sx + (rng() - 0.5) * 12, Y(3) + len * 0.7, sx + (rng() - 0.5) * 10, Y(3) + len);
        B.ctx.stroke();
      }
    }
    const out = new Uint8ClampedArray(W * H * 4);
    const dr = R.ctx.getImageData(0, 0, W, H).data, dg = G.ctx.getImageData(0, 0, W, H).data, db = B.ctx.getImageData(0, 0, W, H).data;
    for (let i = 0; i < W * H; i++) {
      out[i * 4] = dr[i * 4];
      out[i * 4 + 1] = dg[i * 4];
      out[i * 4 + 2] = db[i * 4];
      out[i * 4 + 3] = 255;
    }
    const tex = dataTextureFromRGBA(out, W, H, { repeat: false, aniso: 8 });
    tex.wrapS = THREE.RepeatWrapping;
    tex.userData.shared = true;
    return tex;
  });
}

/**
 * LED board graphics: 8 banner rows (2048 x 128 each) of original artwork on transparent black,
 * white / brand-coloured. The board shader scrolls a row and tints it. Rows:
 * 0 VÍBORA TOUR wordmark, 1 ¡VAMOS!, 2 PUNTO DE ORO · GOLDEN POINT, 3 WORLD FINALS chevrons,
 * 4 ¡PUNTO!, 5 POR TRES, 6 ball + snake icons, 7 MÍA · TUYA · ¡VAMOS!
 */
export function ledBannerTexture() {
  return cached('led-banners', () => sharedTex(fontCanvasTexture(2048, 1024, (ctx, W) => {
    ctx.clearRect(0, 0, W, 1024);
    const RH = 128;
    const row = (i, draw) => {
      ctx.save();
      ctx.translate(0, i * RH);
      ctx.beginPath();
      ctx.rect(0, 0, W, RH);
      ctx.clip();
      draw(ctx);
      ctx.restore();
    };
    const snake = (c, x, y, r, col) => {
      c.lineWidth = r * 0.16;
      c.strokeStyle = '#ffffff';
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.stroke();
      c.strokeStyle = col;
      c.lineWidth = r * 0.2;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(x - r * 0.62, y - r * 0.55);
      c.bezierCurveTo(x + r * 0.9, y - r * 0.75, x - r * 0.9, y + r * 0.75, x + r * 0.62, y + r * 0.55);
      c.stroke();
    };
    const text = (c, s, x, size, color, weight = 900, font = DISPLAY_FONT) => {
      c.font = `${weight} ${size}px ${font}`;
      c.fillStyle = color;
      c.textBaseline = 'middle';
      c.fillText(s, x, RH / 2 + 4);
      return c.measureText(s).width;
    };
    row(0, (c) => {
      let x = 40;
      for (let k = 0; k < 3; k++) {
        snake(c, x + 50, RH / 2, 42, '#d9f03a');
        x += 120;
        x += text(c, 'VÍBORA', x, 104, '#ffffff') + 24;
        x += text(c, 'TOUR', x, 104, '#d9f03a') + 110;
      }
    });
    row(1, (c) => {
      let x = 30;
      for (let k = 0; k < 4; k++) x += text(c, '¡VAMOS!', x, 112, k % 2 ? '#5fd8ff' : '#ffffff') + 120;
    });
    row(2, (c) => {
      let x = 30;
      x += text(c, 'PUNTO DE ORO', x, 96, '#ffd84a') + 60;
      x += text(c, '·', x, 96, '#ffffff') + 60;
      x += text(c, 'GOLDEN POINT', x, 96, '#ffffff') + 120;
      text(c, 'PUNTO DE ORO', x, 96, '#ffd84a');
    });
    row(3, (c) => {
      let x = 20;
      for (let k = 0; k < 2; k++) {
        for (let j = 0; j < 4; j++) {
          c.fillStyle = j % 2 ? '#5fd8ff' : '#d9f03a';
          c.beginPath();
          c.moveTo(x, 20); c.lineTo(x + 36, 20); c.lineTo(x + 76, RH / 2); c.lineTo(x + 36, RH - 20); c.lineTo(x, RH - 20); c.lineTo(x + 40, RH / 2);
          c.fill();
          x += 58;
        }
        x += 40;
        x += text(c, 'WORLD FINALS', x, 100, '#ffffff') + 140;
      }
    });
    row(4, (c) => {
      let x = 40;
      for (let k = 0; k < 4; k++) x += text(c, '¡PUNTO!', x, 112, '#ffffff') + 140;
    });
    row(5, (c) => {
      let x = 40;
      for (let k = 0; k < 3; k++) x += text(c, '¡POR TRES!', x, 112, k % 2 ? '#ff9a3c' : '#ffd84a') + 140;
    });
    row(6, (c) => {
      for (let k = 0; k < 10; k++) {
        const x = 100 + k * 200;
        if (k % 2) snake(c, x, RH / 2, 44, '#5fd8ff');
        else {
          const g = c.createRadialGradient(x - 12, RH / 2 - 14, 4, x, RH / 2, 46);
          g.addColorStop(0, '#f6ff9a');
          g.addColorStop(1, '#c6e21a');
          c.fillStyle = g;
          c.beginPath();
          c.arc(x, RH / 2, 44, 0, Math.PI * 2);
          c.fill();
          c.strokeStyle = 'rgba(255,255,255,0.9)';
          c.lineWidth = 5;
          c.beginPath();
          c.arc(x - 60, RH / 2, 60, -0.75, 0.75);
          c.stroke();
          c.beginPath();
          c.arc(x + 60, RH / 2, 60, Math.PI - 0.75, Math.PI + 0.75);
          c.stroke();
        }
      }
    });
    row(7, (c) => {
      let x = 40;
      for (const [s, col] of [['¡MÍA!', '#ffffff'], ['¡TUYA!', '#5fd8ff'], ['¡VAMOS!', '#d9f03a'], ['¡MÍA!', '#ffffff'], ['¡TUYA!', '#5fd8ff']]) x += text(c, s, x, 104, col) + 110;
    });
  }, { srgb: true, repeat: true, aniso: 8 })));
}

/** Marks a cached texture as shared so a venue teardown never disposes it. */
function sharedTex(t) {
  t.userData.shared = true;
  return t;
}

/**
 * Warm limestone terrace tiles (60 x 40 cm, staggered) with grout, wear and dust. 2.4 m per repeat.
 * userData: { normalMap, roughnessMap }.
 */
export const PAVING_TILE_M = 2.4;
export function pavingTexture({ size = 1024 } = {}) {
  return cached(`paving:${size}`, () => {
    const S = size;
    const ppm = S / PAVING_TILE_M;
    const rng = createRng(71);
    const mott = fbmGrid(S / 4, S / 4, { seed: 72, basePeriod: 4, octaves: 5, gain: 0.55 });
    const col = new Uint8ClampedArray(S * S * 4);
    const hgt = new Float32Array(S * S);
    const rgh = new Uint8ClampedArray(S * S * 4);
    const tw = 0.6 * ppm, th = 0.4 * ppm, grout = Math.max(2, 0.008 * ppm);
    const tileTone = [];
    for (let i = 0; i < 64; i++) tileTone.push(0.88 + rng() * 0.2);
    for (let y = 0; y < S; y++) {
      const ry = Math.floor(y / th);
      const fy = y - ry * th;
      const off = (ry % 2) * tw * 0.5;
      for (let x = 0; x < S; x++) {
        const xx = (x + off) % S;
        const rx = Math.floor(xx / tw);
        const fx = xx - rx * tw;
        const edge = Math.min(fx, tw - fx, fy, th - fy);
        const isGrout = edge < grout * 0.5;
        const m = mott[((y >> 2) * (S >> 2)) + (x >> 2)];
        const tone = tileTone[(rx * 7 + ry * 13) & 63];
        const v = isGrout ? 0.55 : tone * (0.86 + (m - 0.5) * 0.4 + (rng() - 0.5) * 0.05);
        const i = (y * S + x) * 4;
        col[i] = 214 * v;
        col[i + 1] = 196 * v;
        col[i + 2] = 168 * v;
        col[i + 3] = 255;
        const bevel = Math.min(1, edge / (grout * 1.6));
        hgt[y * S + x] = isGrout ? 0 : 0.5 + 0.5 * bevel + (m - 0.5) * 0.08;
        rgh[i] = 0;
        rgh[i + 1] = clamp(255 * (isGrout ? 0.95 : 0.62 + m * 0.25), 0, 255);
        rgh[i + 2] = 0;
        rgh[i + 3] = 255;
      }
    }
    const map = dataTextureFromRGBA(col, S, S, { srgb: true });
    map.userData.normalMap = dataTextureFromRGBA(heightToNormal(hgt, S, S, 1.4), S, S);
    map.userData.roughnessMap = dataTextureFromRGBA(rgh, S, S);
    map.userData.shared = true;
    map.userData.normalMap.userData.shared = true;
    map.userData.roughnessMap.userData.shared = true;
    return map;
  });
}

/** Frees every cached texture (for teardown in tests / hot reload). */
export function disposeTextures() {
  for (const v of cache.values()) {
    if (v?.isTexture) {
      v.userData?.normalMap?.dispose?.();
      v.userData?.roughnessMap?.dispose?.();
      v.userData?.bumpMap?.dispose?.();
      v.dispose();
    } else if (v && typeof v === 'object') {
      for (const t of Object.values(v)) t?.isTexture && t.dispose();
    }
  }
  cache.clear();
}
