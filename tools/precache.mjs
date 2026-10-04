// Builds the service worker's precache list (sw.js) from the source tree: the app shell, every
// module reachable from src/ (three.js addons resolved through the import map), the MediaPipe
// runtime (SIMD build) with the default 'full' pose model, the hand models, fonts and icons.
// Each entry carries a content hash, so a deploy only re-downloads files that changed, and the
// cache version is the hash of the whole list.
//
// Usage: node tools/precache.mjs           check: exit 1 if sw.js is out of date
//        node tools/precache.mjs --write   rewrite the list and version in sw.js
// The Pages workflow runs --write before uploading, so a deploy always ships a fresh list.
import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Files needed offline that no static import reaches (loaded by URL at runtime). */
export const EXTRA = [
  'index.html',
  'manifest.webmanifest',
  'styles/app.css',
  'vendor/mediapipe/vision_bundle.mjs',
  'vendor/mediapipe/wasm/vision_wasm_internal.js',
  'vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  'models/pose_landmarker_full.task',
];
/** Whole directories precached as-is (relative paths). */
const DIRS = ['src', 'fonts', 'assets/hands', 'icons'];
const DIR_EXT = /\.(js|mjs|woff2|glb|png|svg)$/i;

const IMPORT_MAP = { three: 'vendor/three/three.module.js', 'three/addons/': 'vendor/three/addons/' };
const IMPORT_RE = /(?:^|[;\s}])(?:import|export)\s*(?:[\w*{}\s,$]+\s*from\s*)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

async function walk(dir) {
  const out = [];
  let items = [];
  try {
    items = await readdir(join(ROOT, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items) {
    const rel = posix.join(dir, it.name);
    if (it.isDirectory()) out.push(...(await walk(rel)));
    else if (DIR_EXT.test(it.name)) out.push(rel);
  }
  return out;
}

function resolveSpec(spec, from) {
  if (spec === 'three') return IMPORT_MAP.three;
  if (spec.startsWith('three/addons/')) return IMPORT_MAP['three/addons/'] + spec.slice('three/addons/'.length);
  if (spec.startsWith('./') || spec.startsWith('../')) return posix.normalize(posix.join(posix.dirname(from), spec));
  return null; // bare or absolute URL: not ours
}

/** Static module graph from the given entry modules (vendor files included, src/ already listed). */
async function moduleGraph(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    let text;
    try {
      text = await readFile(join(ROOT, f), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(IMPORT_RE)) {
      const r = resolveSpec(m[1] || m[2], f);
      if (r && /\.m?js$/.test(r) && !seen.has(r)) queue.push(r);
    }
  }
  return seen;
}

const sha = (buf, n = 12) => createHash('sha256').update(buf).digest('hex').slice(0, n);

/** -> { version, entries: [[path, hash]], bytes } */
export async function buildPrecache() {
  const files = new Set(EXTRA);
  for (const d of DIRS) for (const f of await walk(d)) files.add(f);
  const mods = [...files].filter((f) => /\.m?js$/.test(f));
  for (const f of await moduleGraph(mods)) files.add(f);
  const entries = [];
  let bytes = 0;
  for (const f of [...files].sort()) {
    let buf;
    try {
      buf = await readFile(join(ROOT, f));
    } catch {
      continue; // listed but missing: leave it out
    }
    bytes += buf.length;
    entries.push([f, sha(buf)]);
  }
  const version = sha(entries.map((e) => e.join(':')).join('\n'), 10);
  return { version, entries, bytes };
}

const START = '/* PRECACHE:START */';
const END = '/* PRECACHE:END */';
const VER_RE = /const VERSION = '[^']*';/;

export function renderList(entries) {
  return `${START}\n${entries.map(([p, h]) => `  ['${p}', '${h}'],`).join('\n')}\n  ${END}`;
}

export async function swState() {
  const path = join(ROOT, 'sw.js');
  const text = await readFile(path, 'utf8');
  const a = text.indexOf(START), b = text.indexOf(END);
  if (a < 0 || b < 0 || !VER_RE.test(text)) throw new Error('sw.js has no PRECACHE markers / VERSION line');
  return { path, text, a, b: b + END.length };
}

async function main() {
  const write = process.argv.includes('--write');
  const built = await buildPrecache();
  const { entries, bytes } = built;
  const sw = await swState();
  // The worker's own code counts too: a change to its logic is a new version.
  const code = (sw.text.slice(0, sw.a) + sw.text.slice(sw.b)).replace(VER_RE, '');
  const version = sha(`${built.version}:${sha(code)}`, 10);
  const next = sw.text.slice(0, sw.a) + renderList(entries) + sw.text.slice(sw.b);
  const out = next.replace(VER_RE, `const VERSION = '${version}';`);
  const mb = (bytes / 1048576).toFixed(1);
  if (out === sw.text) {
    console.log(`sw.js precache is up to date: ${entries.length} files, ${mb} MB, version ${version}`);
    return;
  }
  if (write) {
    await writeFile(sw.path, out);
    const info = await stat(sw.path);
    console.log(`sw.js updated: ${entries.length} files, ${mb} MB, version ${version} (${info.size} bytes)`);
  } else {
    console.error(`sw.js precache is out of date (expected version ${version}). Run: node tools/precache.mjs --write`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
