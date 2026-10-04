// The real app with each venue (switched live through __vibora.stage.env.setVenue), first person.
// Usage: node dev/venues-app-shot.mjs <outDir> [query=autopilot=1&mode=match] [venues=club,sunset,stadium] [waitS=10]
// Prints draw calls / triangles / frame ms per venue and any console errors (exit 1 on errors).
import { startServer } from '../tools/serve.mjs';
import { mkdir } from 'node:fs/promises';

const [outDir = 'tools/out/venues-app', query = 'autopilot=1&mode=match', venues = 'club,sunset,stadium', waitS = '10'] = process.argv.slice(2);
let pw;
try {
  pw = await import('playwright');
} catch {
  pw = await import('/opt/node-tools/node_modules/playwright/index.mjs');
}
await mkdir(outDir, { recursive: true });
const server = await startServer(0);
const browser = await pw.chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?${query}&sw=0`);
await page.waitForFunction(() => window.__vibora && window.__vibora.ready, null, { timeout: 300000, polling: 500 });
for (const v of venues.split(',')) {
  const t0 = Date.now();
  await page.evaluate((id) => window.__vibora.stage.env.setVenue(id), v);
  const switchMs = Date.now() - t0;
  await page.waitForTimeout(Number(waitS) * 1000);
  const st = await page.evaluate(() => {
    const s = window.__vibora.stage.app.stats;
    return { drawCalls: s.drawCalls, triangles: s.triangles, frameMs: Math.round(s.frameMs * 10) / 10, venue: window.__vibora.stage.env.venue.id, errors: window.__vibora.errors.length, simTime: window.__vibora.stats.simTime };
  });
  await page.screenshot({ path: `${outDir}/app-${v}.png`, timeout: 300000 });
  console.log(JSON.stringify({ ...st, switchMs }));
}
await browser.close();
server.close();
if (errors.length) {
  console.error(`${errors.length} console error(s):\n${errors.slice(0, 20).join('\n')}`);
  process.exit(1);
}
