// Screenshots of the venues (dev/venues.html): one page load per venue, several views.
// Usage: node dev/venues-shot.mjs <outDir> [venues=club,sunset,stadium] [views=baseline,net,overview] [quality=high] [w=1920] [h=1080]
// Prints draw calls / triangles per view as JSON lines; exit 1 on console errors.
import { startServer } from '../tools/serve.mjs';
import { mkdir } from 'node:fs/promises';

const [outDir = 'tools/out/venues', vs = 'club,sunset,stadium', views = 'baseline,net,overview', quality = 'high', w = '1920', h = '1080', extra = ''] = process.argv.slice(2);
let pw;
try {
  pw = await import('playwright');
} catch {
  pw = await import('/opt/node-tools/node_modules/playwright/index.mjs');
}
await mkdir(outDir, { recursive: true });
const server = await startServer(0);
const port = server.address().port;
const browser = await pw.chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const results = [];
for (const venue of vs.split(',')) {
  const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${venue}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${venue}: [pageerror] ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/dev/venues.html?venue=${venue}&quality=${quality}&frames=2${extra ? '&' + extra : ''}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
  for (const spec of views.split(',')) {
    const [view, react, t] = spec.split(':');
    const r = await page.evaluate(([v, rr, tt]) => window.shot(v, { react: rr || null, t: Number(tt || 0) }), [view, react, t]);
    const file = `${outDir}/${venue}-${view}${react ? '-' + react : ''}.png`;
    await page.screenshot({ path: file, timeout: 240000 });
    results.push({ ...r, file });
    console.log(JSON.stringify({ ...r, file }));
  }
  await page.close();
}
await browser.close();
server.close();
if (errors.length) {
  console.error(`${errors.length} error(s):\n${errors.join('\n')}`);
  process.exit(1);
}
