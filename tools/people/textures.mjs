// Texture atlases for the baked athletes (PNG; tools/people/encode-textures.mjs makes the WebPs):
//   skin.png  1024x512, linear: MakeHuman young male (left) and female (right) skin albedo divided by
//             its median colour and stored x0.5 (128 = the median), so any skin tone (a vertex colour)
//             keeps the painted detail: lips, nipples, nails, knuckles, eyelids.
//   hair.png  2048x1024 RGBA (sRGB): hair styles as luminance normalised to their mean (x0.5; the
//             vertex colour tints them), the eye (true colour), eyebrows and eyelashes; colour bled
//             into transparent texels so filtering never greys the strand edges.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { need } from './deps.mjs';

const { PNG } = await need('pngjs');

const readPng = (file) => PNG.sync.read(readFileSync(file));

/** Hair atlas slots: [x, y, w, h] in pixels of a 2048x1024 image (y down). */
export const HAIR_SLOTS = {
  short02: [0, 0, 512, 512], short04: [512, 0, 512, 512], short03: [1024, 0, 512, 512], ponytail01: [1536, 0, 512, 512],
  bob02: [0, 512, 512, 512], afro01: [512, 512, 512, 512], eye: [1024, 512, 512, 512],
  brow: [1536, 512, 256, 256], lash: [1792, 512, 256, 256], spare: [1536, 768, 512, 256],
};
const HAIR_FILES = {
  short02: 'proxies/hair/short02/textures/short02_diffuse.png', short04: 'proxies/hair/short04/textures/short04_diffuse.png',
  short03: 'proxies/hair/short03/textures/short03_diffuse.png', ponytail01: 'proxies/hair/ponytail01/textures/ponytail01_diffuse.png',
  bob02: 'proxies/hair/bob02/textures/bob02_diffuse.png', afro01: 'proxies/hair/afro01/textures/afro_diffuse.png',
  eye: 'proxies/eyes/HighPolyEyes/textures/brown_eye.png', brow: 'proxies/eyebrows/eyebrow010/textures/eyebrow010.png',
  lash: 'proxies/eyelashes/Eyelashes01/textures/eyelashes01.png',
};
const SKIN_FILES = ['skins/young_caucasian_male/textures/young_lightskinned_male_diffuse.png', 'skins/young_caucasian_female/textures/young_lightskinned_female_diffuse.png'];

function sample(img, u, v) {
  // Bilinear sample (u, v in 0..1, v down) -> [r, g, b, a] 0..255.
  const x = u * img.width - 0.5, y = v * img.height - 0.5;
  const x0 = Math.max(0, Math.min(img.width - 1, Math.floor(x))), y0 = Math.max(0, Math.min(img.height - 1, Math.floor(y)));
  const x1 = Math.min(img.width - 1, x0 + 1), y1 = Math.min(img.height - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0)), fy = Math.max(0, Math.min(1, y - y0));
  const o = [0, 0, 0, 0];
  for (const [xx, yy, w] of [[x0, y0, (1 - fx) * (1 - fy)], [x1, y0, fx * (1 - fy)], [x0, y1, (1 - fx) * fy], [x1, y1, fx * fy]]) {
    const i = (yy * img.width + xx) * 4;
    for (let k = 0; k < 4; k++) o[k] += img.data[i + k] * w;
  }
  return o;
}

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Pushes colour from opaque texels into transparent ones (n dilation passes). */
function bleed(data, W, H, rect, passes = 12) {
  const [X, Y, w, h] = rect;
  const ok = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ok[y * w + x] = data[((Y + y) * W + X + x) * 4 + 3] > 96 ? 1 : 0;
  for (let p = 0; p < passes; p++) {
    const next = ok.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (ok[y * w + x]) continue;
        let r = 0, g = 0, b = 0, c = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || !ok[yy * w + xx]) continue;
          const i = ((Y + yy) * W + X + xx) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; c++;
        }
        if (c) {
          const i = ((Y + y) * W + X + x) * 4;
          data[i] = r / c; data[i + 1] = g / c; data[i + 2] = b / c;
          next[y * w + x] = 1;
        }
      }
    }
    ok.set(next);
  }
}

export function buildTextures({ npm, out }) {
  // ---- skin atlas
  const SW = 1024, SH = 512;
  const skin = new PNG({ width: SW, height: SH });
  const medians = [];
  SKIN_FILES.forEach((f, half) => {
    const img = readPng(join(npm, f));
    const ch = [[], [], []];
    for (let i = 0; i < img.width * img.height; i += 3) for (let k = 0; k < 3; k++) ch[k].push(img.data[i * 4 + k]);
    const med = ch.map((c) => c.sort((a, b) => a - b)[c.length >> 1]);
    medians.push(med);
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < 512; x++) {
        const s = sample(img, (x + 0.5) / 512, (y + 0.5) / SH);
        const o = (y * SW + half * 512 + x) * 4;
        for (let k = 0; k < 3; k++) skin.data[o + k] = Math.max(0, Math.min(255, Math.round((s[k] / med[k]) * 128)));
        skin.data[o + 3] = 255;
      }
    }
  });
  writeFileSync(join(out, 'skin.png'), PNG.sync.write(skin));
  // ---- hair atlas
  const HW = 2048, HH = 1024;
  const hair = new PNG({ width: HW, height: HH });
  hair.data.fill(0);
  const means = {};
  for (const [slot, f] of Object.entries(HAIR_FILES)) {
    const img = readPng(join(npm, f));
    const [X, Y, w, h] = HAIR_SLOTS[slot];
    const keepColour = slot === 'eye';
    let m = 0, c = 0;
    for (let i = 0; i < img.width * img.height; i++) {
      if (img.data[i * 4 + 3] > 128) { m += lum(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]); c++; }
    }
    m = c ? m / c : 128;
    means[slot] = +(m / 255).toFixed(4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = sample(img, (x + 0.5) / w, (y + 0.5) / h);
        const o = ((Y + y) * HW + X + x) * 4;
        if (keepColour) for (let k = 0; k < 3; k++) hair.data[o + k] = s[k];
        else {
          const L = Math.max(0, Math.min(255, Math.round((lum(s[0], s[1], s[2]) / m) * 128)));
          hair.data[o] = hair.data[o + 1] = hair.data[o + 2] = L;
        }
        hair.data[o + 3] = s[3];
      }
    }
    bleed(hair.data, HW, HH, HAIR_SLOTS[slot]);
  }
  writeFileSync(join(out, 'hair.png'), PNG.sync.write(hair));
  return {
    manifest: { skin: { file: 'skin', size: [SW, SH], medians }, hair: { file: 'hair', size: [HW, HH], slots: HAIR_SLOTS, means } },
    /** Body uv -> skin atlas u (half 0 male, 1 female; a 2-texel guard at the split). */
    skinU(u, half) {
      const g = 2 / SW;
      return half * 0.5 + Math.max(g, Math.min(0.5 - g, u * 0.5));
    },
    /** Proxy uv (v up) -> hair atlas uv (v up, flipY texture). */
    slotUV(slot, u, v) {
      const [X, Y, w, h] = HAIR_SLOTS[slot];
      const uu = Math.max(0.002, Math.min(0.998, u)), vv = Math.max(0.002, Math.min(0.998, v));
      return [(X + uu * w) / HW, 1 - (Y + (1 - vv) * h) / HH];
    },
  };
}
