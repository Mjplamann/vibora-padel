// Screenshot of any dev page with generous timeouts (software WebGL on a busy machine).
// Usage: node dev/page-shot.mjs <path?query> <out.png> [waitForGlobal=__ready] [width=1920] [height=1080]
import { startServer } from '../tools/serve.mjs';

async function loadPlaywright() {
  try { return await import('playwright'); } catch { return await import('/opt/node-tools/node_modules/playwright/index.mjs'); }
}
const [path, out, flag = '__ready', w = '1920', h = '1080'] = process.argv.slice(2);
const { chromium } = await loadPlaywright();
const server = await startServer(0);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${server.address().port}/${path}`);
await page.waitForFunction((f) => !!window[f], flag, { timeout: 240000 });
const info = await page.evaluate((f) => window[f], flag);
await page.screenshot({ path: out, timeout: 240000 });
console.log(JSON.stringify(info), errors.length ? `ERRORS: ${errors.join(' | ')}` : 'no errors');
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
