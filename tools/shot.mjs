// Dev helper: open a page from this project in headless Chromium, collect console
// errors, optionally run a script, and save a screenshot.
// Usage: node tools/shot.mjs <path?query> <out.png> [waitMs=4000] [width=1600] [height=900]
// Exit code 1 if the page logged errors (console.error / pageerror / failed requests).
import { startServer } from './serve.mjs';

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    return await import('/opt/node-tools/node_modules/playwright/index.mjs');
  }
}

export async function shoot(path, out, { wait = 4000, width = 1600, height = 900, evaluate = null } = {}) {
  const { chromium } = await loadPlaywright();
  const server = await startServer(0);
  const port = server.address().port;
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  const logs = [];
  page.on('console', (m) => {
    const line = `[${m.type()}] ${m.text()}`;
    logs.push(line);
    if (m.type() === 'error') errors.push(line);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${e.stack || ''}`));
  page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`[http ${r.status()}] ${r.url()}`);
  });
  await page.goto(`http://127.0.0.1:${port}/${path.replace(/^\//, '')}`);
  await page.waitForTimeout(wait);
  let result = null;
  if (evaluate) result = await page.evaluate(evaluate);
  if (out) await page.screenshot({ path: out });
  await browser.close();
  server.close();
  return { errors, logs, result };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [path = 'index.html', out = 'tools/out/shot.png', wait = '4000', w = '1600', h = '900'] = process.argv.slice(2);
  const { mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(out), { recursive: true });
  const { errors, logs } = await shoot(path, out, { wait: Number(wait), width: Number(w), height: Number(h) });
  console.log(logs.slice(-40).join('\n'));
  if (errors.length) {
    console.error(`\n${errors.length} error(s):\n` + errors.join('\n'));
    process.exit(1);
  }
  console.log(`\nOK → ${out}`);
}
