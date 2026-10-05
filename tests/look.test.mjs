// Round 6 look (lighting, materials, pipeline): the pure parts that run under node — panorama
// normalisation for the image-based lighting, the venue metadata that picks the panorama and the
// tone mapping, and the shipped assets (formats, provenance files, payload budget).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { fromHalf, toHalf, normalizeHalfPanorama, CLAMP_REL } from '../src/render/iblMath.js';
import { VENUE_IDS, venueMeta } from '../src/render/venues/meta.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('iblMath: half floats round-trip within half precision; overflow clamps, NaN zeroes', () => {
  for (const v of [0, 1, 0.5, 0.1, 2.75, 3.14159, 100, 1000, 20000]) {
    const back = fromHalf(toHalf(v));
    assert.ok(Math.abs(back - v) <= Math.max(1e-7, Math.abs(v) * 1e-3), `${v} -> ${back}`);
  }
  assert.equal(fromHalf(toHalf(1e9)), 65504);
  assert.equal(toHalf(NaN), 0);
  assert.equal(fromHalf(0x7c00), Infinity);
});

test('iblMath: a panorama is normalised to unit mean luminance, neutral colour, finite, sun clamped', () => {
  const W = 64, H = 32;
  const d = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const sky = y > H / 2;
      d[i] = toHalf(sky ? 0.6 : 0.4); d[i + 1] = toHalf(sky ? 0.8 : 0.35); d[i + 2] = toHalf(sky ? 1.4 : 0.3); d[i + 3] = toHalf(1);
    }
  }
  // A blazing sun, an Inf and a NaN texel.
  d[(28 * W + 10) * 4] = toHalf(50000); d[(28 * W + 10) * 4 + 1] = toHalf(48000); d[(28 * W + 10) * 4 + 2] = toHalf(45000);
  d[(5 * W + 3) * 4 + 1] = 0x7c00;
  d[(6 * W + 3) * 4 + 2] = 0x7e00;
  const st = normalizeHalfPanorama(d, W, H);
  assert.ok(st.luminance > 0 && Number.isFinite(st.luminance));
  const sum = [0, 0, 0];
  let ws = 0, peak = 0;
  for (let y = 0; y < H; y++) {
    const w = Math.cos(((y + 0.5) / H - 0.5) * Math.PI);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) {
        const v = fromHalf(d[i + k]);
        assert.ok(Number.isFinite(v) && v >= 0, `texel ${x},${y} channel ${k} = ${v}`);
        sum[k] += v * w;
        peak = Math.max(peak, v);
      }
      ws += w;
    }
  }
  for (const k of [0, 1, 2]) assert.ok(Math.abs(sum[k] / ws - 1) < 0.01, `channel ${k} mean ${sum[k] / ws}`);
  assert.ok(peak < CLAMP_REL * 2.5, `the sun is clamped (peak ${peak})`);
});

test('venues: each names a shipped panorama (OpenEXR) and a tone mapping; the payload stays modest', () => {
  for (const id of VENUE_IDS) {
    const m = venueMeta(id);
    assert.ok(['aces', 'agx', 'neutral'].includes(m.toneMapping), `${id} tone mapping ${m.toneMapping}`);
    assert.ok(m.exposure > 0.5 && m.exposure < 2, `${id} exposure`);
    const f = join(ROOT, 'assets/env', `${m.hdri}.exr`);
    const b = readFileSync(f);
    assert.deepEqual([...b.subarray(0, 4)], [0x76, 0x2f, 0x31, 0x01], `${m.hdri}.exr is OpenEXR`);
  }
  let bytes = 0;
  for (const dir of ['assets/env', 'assets/tex']) {
    for (const f of readdirSync(join(ROOT, dir))) {
      if (/\.(exr|webp)$/.test(f)) bytes += statSync(join(ROOT, dir, f)).size;
    }
  }
  assert.ok(bytes < 1.0e6, `added image payload ${bytes} bytes`);
});

test('assets: detail normal maps are WebP; every shipped image file is listed with its licence', () => {
  for (const dir of ['assets/env', 'assets/tex']) {
    const lic = readFileSync(join(ROOT, dir, 'LICENSE.md'), 'utf8');
    assert.match(lic, /CC0/);
    for (const f of readdirSync(join(ROOT, dir))) {
      if (!/\.(exr|webp)$/.test(f)) continue;
      assert.ok(lic.includes(`\`${f}\``), `${dir}/${f} listed in LICENSE.md`);
      if (f.endsWith('.webp')) {
        const b = readFileSync(join(ROOT, dir, f));
        assert.equal(b.subarray(0, 4).toString('latin1'), 'RIFF');
        assert.equal(b.subarray(8, 12).toString('latin1'), 'WEBP');
      }
    }
  }
  // No JS-wrapped base64 payloads in the shipped tree.
  for (const dir of ['assets/env', 'assets/tex']) for (const f of readdirSync(join(ROOT, dir))) assert.ok(!f.endsWith('.js'), f);
});
