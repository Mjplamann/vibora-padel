// Pure helpers for the image-based lighting panoramas (render/ibl.js): IEEE half-float conversion
// and the panorama normalisation (no three.js, no DOM: runs under node --test).

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** Half-float bits -> number. */
export function fromHalf(h) {
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** Number -> half-float bits (round to nearest, clamped to the largest finite half). */
export function toHalf(v) {
  if (Number.isNaN(v)) return 0;
  f32[0] = Math.max(-65504, Math.min(65504, v));
  const x = u32[0];
  const sign = (x >> 16) & 0x8000;
  let e = ((x >> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (e <= 0) {
    if (e < -10) return sign;
    m = (m | 0x800000) >> (1 - e);
    return sign | ((m + 0x1000) >> 13);
  }
  if (e >= 31) return sign | 0x7bff;
  const h = sign | (e << 10) | (m >> 13);
  return (m & 0x1000) && (h & 0x7fff) < 0x7bff ? h + 1 : h;
}

/** Peak radiance kept, relative to the mean: the venue's own key lights / sun carry the highlights. */
export const CLAMP_REL = 32;

/**
 * Normalises an RGBA half-float equirectangular panorama in place: non-finite texels zeroed,
 * highlights clamped to CLAMP_REL x the mean luminance, then scaled to a mean luminance of 1 with
 * a neutral average colour (solid-angle weighted). Returns the stats before normalisation.
 * @param {Uint16Array} data RGBA half floats
 */
export function normalizeHalfPanorama(data, width, height, clampRel = CLAMP_REL) {
  const n = width * height;
  const rowW = new Float64Array(height);
  for (let y = 0; y < height; y++) rowW[y] = Math.cos(((y + 0.5) / height - 0.5) * Math.PI);
  const read = (i) => {
    const h = data[i];
    if ((h & 0x7c00) === 0x7c00) return 0; // Inf / NaN
    const v = fromHalf(h);
    return v > 0 ? v : 0;
  };
  const sum = [0, 0, 0];
  let wsum = 0;
  for (let y = 0; y < height; y++) {
    const w = rowW[y];
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      sum[0] += read(i) * w; sum[1] += read(i + 1) * w; sum[2] += read(i + 2) * w;
      wsum += w;
    }
  }
  const mean0 = sum.map((v) => v / Math.max(wsum, 1e-12));
  const lum0 = Math.max(1e-6, 0.2126 * mean0[0] + 0.7152 * mean0[1] + 0.0722 * mean0[2]);
  // Robust reference level: the sun itself inflates the plain mean, so the clamp level is refined
  // against the mean of the already-clamped image (three passes converge).
  let ref = lum0;
  for (let it = 0; it < 3; it++) {
    const c = ref * clampRel;
    let ls = 0;
    for (let y = 0; y < height; y++) {
      const w = rowW[y];
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const l = 0.2126 * read(i) + 0.7152 * read(i + 1) + 0.0722 * read(i + 2);
        ls += Math.min(l, c) * w;
      }
    }
    ref = Math.max(1e-6, ls / Math.max(wsum, 1e-12));
  }
  const cap = ref * clampRel;
  const sum2 = [0, 0, 0];
  const lin = new Float32Array(n * 3);
  for (let y = 0; y < height; y++) {
    const w = rowW[y];
    for (let x = 0; x < width; x++) {
      const p = y * width + x, i = p * 4;
      const r = read(i), g = read(i + 1), b = read(i + 2);
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const k = l > cap ? cap / l : 1;
      lin[p * 3] = r * k; lin[p * 3 + 1] = g * k; lin[p * 3 + 2] = b * k;
      sum2[0] += r * k * w; sum2[1] += g * k * w; sum2[2] += b * k * w;
    }
  }
  const mean = sum2.map((v) => v / Math.max(wsum, 1e-12));
  const lum = Math.max(1e-6, 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2]);
  const gain = mean.map((m) => (m > 1e-9 ? 1 / m : 1 / lum));
  const one = toHalf(1);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    data[i] = toHalf(lin[p * 3] * gain[0]);
    data[i + 1] = toHalf(lin[p * 3 + 1] * gain[1]);
    data[i + 2] = toHalf(lin[p * 3 + 2] * gain[2]);
    data[i + 3] = one;
  }
  return { mean: mean0, luminance: lum0, clampedLuminance: lum, gain };
}
