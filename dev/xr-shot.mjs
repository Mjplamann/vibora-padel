// Dev check for the glasses mode: renders dev/xr.html headlessly in the configurations that
// matter and saves screenshots; exits 1 when the eyes are swapped, the head-yaw sweep does not
// drive the camera, or the page logged errors.
// Usage: node dev/xr-shot.mjs [outDir=tools/out] [--only=full|half|mono]
import { startServer } from '../tools/serve.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--')) || 'tools/out';
const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7);
let pw;
try {
  pw = await import('playwright');
} catch {
  pw = await import('/opt/node-tools/node_modules/playwright/index.mjs');
}
await mkdir(outDir, { recursive: true });

const CASES = [
  { id: 'full', w: 3840, h: 1200, q: 'stereo=on&sweep=1', expect: { layout: 'full', stereo: true } },
  { id: 'half', w: 1920, h: 1200, q: 'stereo=on&yaw=20', expect: { layout: 'half', stereo: true } },
  { id: 'mono', w: 1920, h: 1200, q: 'stereo=off&yaw=35&pitch=-10&sweep=1', expect: { stereo: false } },
  { id: 'legacy', w: 1920, h: 1200, q: 'stereo=off&protocol=legacy&yaw=-30&hud=0', expect: { stereo: false } },
].filter((c) => !only || c.id === only);

const server = await startServer(0);
const port = server.address().port;
const browser = await pw.chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let failed = 0;
for (const c of CASES) {
  const page = await browser.newPage({ viewport: { width: c.w, height: c.h }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()}`));
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/dev/xr.html?${c.q}`);
  try {
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
  } catch {
    errors.push('timeout waiting for __ready');
  }
  const r = await page.evaluate(() => window.__xr || null);
  const out = join(outDir, `xr-${c.id}.png`);
  await page.screenshot({ path: out, timeout: 240000 });
  const problems = [...errors];
  if (!r) problems.push('no result');
  else {
    if (c.expect.stereo && r.eyeOrder !== 'ok') problems.push(`eye order ${r.eyeOrder}`);
    if (c.expect.layout && r.layout !== c.expect.layout) problems.push(`layout ${r.layout}`);
    if (r.sweep && r.sweep.length) {
      if (!(r.sweepWorstDeg < 0.5)) problems.push(`sweep error ${r.sweepWorstDeg}`);
      if (!r.sweep.every((s) => s.head)) problems.push('head tracking not active during the sweep');
      if (!r.afterUnplug || r.afterUnplug.head !== null || r.afterUnplug.cameraHeadTracking) problems.push('unplugged glasses still drive the view');
      if (!r.afterReplug || r.afterReplug.status !== 'streaming') problems.push(`replug: ${JSON.stringify(r.afterReplug)}`);
    }
    if (!(Math.abs(r.cameraFov - 32.75) < 0.1)) problems.push(`fov ${r.cameraFov}`);
  }
  console.log(`${c.id} ${c.w}×${c.h} ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${out}`);
  console.log(`  ${JSON.stringify(r)}`);
  if (problems.length) {
    failed++;
    console.log(`  FAIL: ${problems.join('; ')}`);
  } else console.log('  ok');
  await page.close();
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
