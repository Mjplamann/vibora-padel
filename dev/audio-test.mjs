// Headless check of the audio engine: renders every sound through an OfflineAudioContext
// (dev/audio.html), asserts non-silent / no NaN / peak < 1.0, prints peak and RMS per sound,
// and saves a screenshot of the waveforms and spectrograms.
// Usage: node dev/audio-test.mjs [out.png=tools/out/audio.png]
import { startServer } from '../tools/serve.mjs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const out = process.argv[2] || 'tools/out/audio.png';
let pw;
try {
  pw = await import('playwright');
} catch {
  pw = await import('/opt/node-tools/node_modules/playwright/index.mjs');
}
await mkdir(dirname(out), { recursive: true });
const server = await startServer(0);
const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1500 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('response', (r) => r.status() >= 400 && errors.push(`[http ${r.status()}] ${r.url()}`));
await page.goto(`http://127.0.0.1:${server.address().port}/dev/audio.html`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
const { results, ok } = await page.evaluate(() => ({ results: window.__audioResults, ok: window.__audioOk }));
await page.screenshot({ path: out, fullPage: true });
await browser.close();
server.close();

console.log('sound'.padEnd(14), 'peak'.padStart(7), 'peak dB'.padStart(8), 'rms'.padStart(9), 'rms dB'.padStart(7), ' nan  ok  ms');
for (const r of results) {
  console.log(r.name.padEnd(14), String(r.peak).padStart(7), String(r.peakDb).padStart(8), String(r.rms).padStart(9), String(r.rmsDb).padStart(7), String(r.nan).padStart(4), r.ok ? ' ok' : ' FAIL', String(r.renderMs).padStart(4));
}
if (errors.length) console.error('console errors:\n' + errors.join('\n'));
console.log(ok && !errors.length ? `\nPASS → ${out}` : '\nFAIL');
process.exit(ok && !errors.length ? 0 : 1);
