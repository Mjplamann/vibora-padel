// Dev helper: render dev/world.html headlessly, wait for window.__ready, screenshot.
// Usage: node dev/world-shot.mjs "<page?query>" <out.png> [timeoutMs=180000] [w=1600] [h=900]
import { startServer } from '../tools/serve.mjs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const [path = 'dev/world.html', out = 'tools/out/world.png', timeout = '180000', w = '1600', h = '900'] = process.argv.slice(2);
let pw;
try {
  pw = await import('playwright');
} catch {
  pw = await import('/opt/node-tools/node_modules/playwright/index.mjs');
}
await mkdir(dirname(out), { recursive: true });
const server = await startServer(0);
const port = server.address().port;
const browser = await pw.chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
const errors = [];
const logs = [];
page.on('console', (m) => {
  logs.push(`[${m.type()}] ${m.text()}`);
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()}`));
page.on('response', (r) => r.status() >= 400 && errors.push(`[http ${r.status()}] ${r.url()}`));
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${port}/${path.replace(/^\//, '')}`);
try {
  await page.waitForFunction(() => window.__ready === true, null, { timeout: Number(timeout), polling: 250 });
} catch {
  errors.push('timeout waiting for __ready');
}
await page.waitForTimeout(300);
console.log(`ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(logs.slice(-30).join("\n"));
const clip = process.env.CLIP ? (([x, y, cw, ch]) => ({ x, y, width: cw, height: ch }))(process.env.CLIP.split(',').map(Number)) : undefined;
await page.screenshot({ path: out, timeout: 240000, clip });
console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await browser.close();
server.close();
if (errors.length) {
  console.error(`${errors.length} error(s):\n${errors.join('\n')}`);
  process.exit(1);
}
console.log(`OK -> ${out}`);
