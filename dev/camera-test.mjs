// Headless camera + pose + fallback check. Chromium's fake capture device stands in for the
// webcam: openCamera must succeed, the MediaPipe tracker must load and produce frames
// (0 people on the test pattern is fine), stats must populate, and no console errors.
// Usage: node dev/camera-test.mjs [out.png=tools/out/camera.png]
import { startServer } from '../tools/serve.mjs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const out = process.argv[2] || 'tools/out/camera.png';
let pw;
try {
  pw = await import('playwright');
} catch {
  pw = await import('/opt/node-tools/node_modules/playwright/index.mjs');
}
await mkdir(dirname(out), { recursive: true });
const server = await startServer(0);
const browser = await pw.chromium.launch({
  args: [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  ],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
await context.grantPermissions(['camera']);
const page = await context.newPage();
const errors = [];
const logs = [];
page.on('console', (m) => {
  logs.push(`[${m.type()}] ${m.text()}`);
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => r.status() >= 400 && errors.push(`[http ${r.status()}] ${r.url()}`));
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${server.address().port}/dev/camera.html?auto=1${process.env.QS ? '&' + process.env.QS : ''}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 150000, polling: 250 });
const res = await page.evaluate(() => window.__camResult);
await page.screenshot({ path: out });
await browser.close();
server.close();

console.log(`ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(logs.filter((l) => !l.startsWith('[debug]')).slice(-15).join('\n'));
const filtered = logs.filter((l) => l.startsWith('[debug] [mediapipe]'));
if (filtered.length) console.log(`(${filtered.length} MediaPipe glog line(s) routed from console.error to console.debug)`);
console.log(JSON.stringify(res, null, 2));
const checks = [
  ['cameras listed', res.cameras.length > 0],
  ['camera opened', !!res.camera && res.camera.settings.width > 0],
  ['tracker frames', res.stats && res.stats.frames >= 20],
  ['stats populated', res.stats && res.stats.fps > 0 && res.stats.inferMs > 0 && res.stats.latencyMs > 0],
  ['PoseFrame shape', res.lastFrame && res.lastFrame.width > 0 && res.lastFrame.height > 0 && Number.isFinite(res.lastFrame.t)],
  ['fallback auto-swing contact', !!res.fallback.contact],
  ['no console errors', errors.length === 0],
];
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
if (errors.length) console.error(errors.join('\n'));
const ok = checks.every(([, o]) => o);
console.log(ok ? `\nPASS → ${out}` : '\nFAIL');
process.exit(ok ? 0 : 1);
