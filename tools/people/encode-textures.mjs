// PNG -> WebP for the baked athlete textures (libwebp through @jsquash/webp's WASM build, bake time
// only; `exact` keeps the colour bled under transparent hair texels, so filtering never darkens
// strand edges), plus the two detail normal maps from @pmndrs/assets (CC0; decoded from its base64
// modules into real files).
// Usage: node tools/people/encode-textures.mjs [--dir assets/people] [--pmndrs <@pmndrs/assets package dir>]
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { need } from './deps.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DIR = arg('--dir', join(ROOT, 'assets', 'people'));
const PMNDRS = arg('--pmndrs', null);
const KEEP = process.argv.includes('--keep-png');

/** Detail normals taken from @pmndrs/assets/normals (emmelleppi/normal-maps, CC0). */
const NORMALS = { pores: '0021', wrinkles: '0014' };
const JOBS = [
  // [png, webp, options]
  ['skin.png', 'skin.webp', { quality: 92, use_sharp_yuv: 1 }],
  ['hair.png', 'hair.webp', { quality: 84, exact: 1, alpha_quality: 90, use_sharp_yuv: 1 }],
];

const { PNG } = await need('pngjs');
const enc = await need('@jsquash/webp/encode.js');
// Node: hand the codec its WASM module directly.
const req = createRequire(process.env.PEOPLE_DEPS ? join(process.env.PEOPLE_DEPS, 'noop.js') : import.meta.url);
const wasmPath = join(dirname(req.resolve('@jsquash/webp/encode.js')), 'codec', 'enc', 'webp_enc.wasm');
await enc.init(await WebAssembly.compile(readFileSync(wasmPath)));

for (const [src, dst, opts] of JOBS) {
  const file = join(DIR, src);
  if (!existsSync(file)) { console.log(`skip ${src}`); continue; }
  const png = PNG.sync.read(readFileSync(file));
  const out = await enc.default({ data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height }, opts);
  writeFileSync(join(DIR, dst), Buffer.from(out));
  if (!KEEP) unlinkSync(file);
  console.log(`${dst} ${(out.byteLength / 1024).toFixed(0)} KB`);
}
if (PMNDRS) {
  for (const [name, id] of Object.entries(NORMALS)) {
    const s = readFileSync(join(PMNDRS, 'normals', `${id}.webp.js`), 'utf8');
    const m = s.match(/data:image\/webp;base64,([A-Za-z0-9+/=]+)/);
    if (!m) throw new Error(`no webp in normals/${id}`);
    writeFileSync(join(DIR, `${name}.webp`), Buffer.from(m[1], 'base64'));
    console.log(`${name}.webp from @pmndrs/assets normals/${id}`);
  }
}
