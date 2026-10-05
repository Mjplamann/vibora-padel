// Screenshots of dev/look.html: one page load per venue, several views / tone mappings.
// Usage: node dev/look-shot.mjs <outDir> [venues=club,sunset,stadium] [specs=baseline,net] [w=1920] [h=1080] [query] [root]
//   spec: view[@tm][@exp]  e.g. baseline@agx, net@neutral@1.1, perf (times 5 synced frames)
//   root: serve another checkout (e.g. a before-snapshot) instead of this one; LOOK_PAGE=dev/venues.html
//   shoots an older checkout's venue page.
// Prints one JSON line per shot; exit 1 on console errors.
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [outDir = 'tools/out/look', vs = 'club,sunset,stadium', specs = 'baseline,net', w = '1920', h = '1080', extra = '', rootArg = ''] = process.argv.slice(2);
const ROOT = resolve(rootArg || fileURLToPath(new URL('..', import.meta.url)));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.glb': 'model/gltf-binary', '.exr': 'image/x-exr', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) throw new Error('outside');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404).end('nf');
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
let pw;
try {
  pw = await import('playwright');
} catch {
  pw = await import('/opt/node-tools/node_modules/playwright/index.mjs');
}
await mkdir(outDir, { recursive: true });
const browser = await pw.chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const page0 = process.env.LOOK_PAGE || 'dev/look.html';
for (const venue of vs.split(',')) {
  const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${venue}: ${m.text()}`);
    if (process.env.LOOK_VERBOSE) console.error(`[${venue}] ${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => {
    errors.push(`${venue}: [pageerror] ${e.message}`);
    console.error(`[${venue}] PAGEERROR ${e.message}\n${e.stack || ''}`);
  });
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${server.address().port}/${page0}?venue=${venue}&frames=2&hud=0${extra ? '&' + extra : ''}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: Number(process.env.LOOK_TIMEOUT || 1200000), polling: 500 });
  const loadS = Math.round((Date.now() - t0) / 1000);
  for (const spec of specs.split(',')) {
    const [view, tm, exp] = spec.split('@');
    if (view === 'perf') {
      const r = await page.evaluate(() => (window.perf ? window.perf(5) : null));
      console.log(JSON.stringify({ venue, perf: r, loadS }));
      continue;
    }
    const r = await page.evaluate(([v, t, e]) => window.shot(v, { ...(t ? { tm: t } : {}), ...(e ? { exp: Number(e) } : {}) }), [view, tm, exp]);
    const file = `${outDir}/${venue}-${view}${tm ? '-' + tm : ''}${exp ? '-' + exp : ''}.png`;
    await page.screenshot({ path: file, timeout: 300000 });
    console.log(JSON.stringify({ ...r, file, loadS }));
  }
  await page.close();
}
await browser.close();
server.close();
if (errors.length) {
  console.error(`${errors.length} error(s):\n${errors.join('\n')}`);
  process.exit(1);
}
