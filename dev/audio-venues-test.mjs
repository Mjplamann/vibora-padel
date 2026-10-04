// Headless check of the venue audio (round 4): renders every new sound through an OfflineAudioContext
// (dev/audio-venues.html), asserts non-silent / no NaN / peak < 1.0, prints peak and RMS per sound,
// and saves a screenshot of the waveforms and spectrograms.
// Usage: node dev/audio-test.mjs [out.png=tools/out/audio-venues.png]
import { startServer } from '../tools/serve.mjs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const out = process.argv[2] || 'tools/out/audio-venues.png';
let pw;
try {
  pw = await import('playwright');
} catch {
  pw = await import('/opt/node-tools/node_modules/playwright/index.mjs');
}
await mkdir(dirname(out), { recursive: true });
const server = await startServer(0);
const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1700 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('response', (r) => r.status() >= 400 && errors.push(`[http ${r.status()}] ${r.url()}`));
await page.goto(`http://127.0.0.1:${server.address().port}/dev/audio-venues.html`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 400000 });
const { results, ok } = await page.evaluate(() => ({ results: window.__audioResults, ok: window.__audioOk }));
await page.screenshot({ path: out, fullPage: true });
await browser.close();
server.close();

console.log('sound'.padEnd(16), 'venue'.padEnd(8), 'peak dB'.padStart(8), 'rms dB'.padStart(7), 'tail dB'.padStart(8), ' nan  ok  ms');
for (const r of results) {
  console.log(r.name.padEnd(16), r.venue.padEnd(8), String(r.peakDb).padStart(8), String(r.rmsDb).padStart(7), String(r.tailDb).padStart(8), String(r.nan).padStart(4), r.ok ? ' ok' : ' FAIL', String(r.renderMs).padStart(5));
}
if (errors.length) console.error('console errors:\n' + errors.join('\n'));
console.log(ok && !errors.length ? `\nPASS → ${out}` : '\nFAIL');
process.exit(ok && !errors.length ? 0 : 1);
