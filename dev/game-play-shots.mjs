// In-play screenshots of the round-4 game modes in the REAL app (1920×1080, software WebGL, the
// autopilot playing): the arcade HUD (clock, combo, score pop, "Perfect timing!"), Glass Breaker
// targets on the far glass, a career match with the partner's callout, an automatic highlight
// replay, and the results screens (arcade leaderboard, career rewards, drill rewards + workout).
// Usage: node dev/game-play-shots.mjs [outDir] [filter]
import { mkdir } from 'node:fs/promises';
import { startServer } from '../tools/serve.mjs';

async function loadPlaywright() {
  try { return await import('playwright'); } catch { return await import('/opt/node-tools/node_modules/playwright/index.mjs'); }
}
const OUT = process.argv[2] || 'tools/out';
const filter = process.argv[3] ? new RegExp(process.argv[3]) : null;
await mkdir(OUT, { recursive: true });
const { chromium } = await loadPlaywright();
const server = await startServer(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const BASE = 'sw=0&mute=1&attract=0&quality=balanced&speed=2';

/** Waits (in the page) until fn() is true, polling every 250 ms, up to ms. */
const until = (page, fn, arg = null, ms = 240000) => page.waitForFunction(fn, arg, { timeout: ms, polling: 250 });

/** The results screen fully in: entrance class gone, then transitions frozen at their end state
 *  (software WebGL on a loaded machine can leave a 300 ms fade half-way at capture time). */
async function resultsSettled(page, ms = 240000) {
  await until(page, () => window.__vibora.screen === 'results' && !document.querySelector('.vp-screen .is-entering'), null, ms);
  await page.evaluate(() => {
    const st = document.createElement('style');
    st.textContent = '.vp *, .vp *::before, .vp *::after { transition: none !important; animation: none !important; }';
    document.head.appendChild(st);
  });
  await page.waitForTimeout(1500);
}

const SHOTS = [
  ['play-porTres', `autopilot=1&challenge=por-tres-party&${BASE}`, async (page) => {
    await until(page, () => window.__vibora.game && window.__vibora.game.mode.state.score > 0);
    await until(page, () => window.__vibora.game.mode.state.combo >= 2 || window.__vibora.game.mode.state.score > 2500);
    // Freeze the moment: no timers, no CSS animations, then the "Perfect ×3" callout.
    await page.evaluate(() => {
      window.__vibora.clock.pause();
      window.setTimeout = () => 0;
      const st = document.createElement('style');
      st.textContent = '.vp *, .vp *::before, .vp *::after { animation: none !important; transition: none !important; }';
      document.head.appendChild(st);
      window.__vibora.game.world.bus.emit('challenge:perfect', { streak: 3 });
    });
    await page.waitForTimeout(250);
  }],
  ['play-glass', `autopilot=1&challenge=glass-breaker&${BASE}`, async (page) => {
    await until(page, () => window.__vibora.game && window.__vibora.world.time - window.__vibora.game.mode.state.tStart > 3);
    await page.evaluate(() => window.__vibora.freezeOn('contact', 0.25));
    await until(page, () => window.__vibora.frozen);
    await page.waitForTimeout(1500);
  }],
  ['play-glass-shatter', `autopilot=1&challenge=glass-breaker&${BASE}`, async (page) => {
    await page.evaluate(() => {
      window.__shattered = 0;
      const hook = () => {
        if (!window.__vibora.world) return setTimeout(hook, 100);
        window.__vibora.world.bus.on('challenge:target-hit', () => { window.__shattered++; window.__vibora.clock.pause(); });
      };
      hook();
    });
    await until(page, () => window.__shattered > 0);
    await page.waitForTimeout(400);
  }],
  ['play-career', `autopilot=1&career=club-open&quick=1&${BASE}`, async (page) => {
    await page.evaluate(() => {
      // Keep the call chip on screen for the screenshot: no UI timers, no CSS animations.
      window.setTimeout = () => 0;
      const st = document.createElement('style');
      st.textContent = '.vp *, .vp *::before, .vp *::after { animation: none !important; transition: none !important; }';
      document.head.appendChild(st);
      window.__calls = 0;
      const hook = () => {
        if (!window.__vibora.world) return setTimeout(hook, 100);
        window.__vibora.world.bus.on('partner:call', (c) => { if (c.kind === 'mine' || c.kind === 'yours' || c.kind === 'switch' || c.kind === 'wall') { window.__calls++; window.__vibora.clock.pause(); } });
      };
      hook();
    });
    await until(page, () => window.__calls > 0);
    await page.waitForTimeout(500);
  }],
  ['replay-highlight', `autopilot=1&challenge=por-tres-party&${BASE}`, async (page) => {
    await until(page, () => window.__vibora.game && window.__vibora.game.mode.state.porTres > 0);
    await page.evaluate(() => window.__vibora.replayMoment('por-tres'));
    await page.waitForTimeout(6000);
  }],
  ['results-arcade', `autopilot=1&challenge=volley-wall&${BASE}`, async (page) => {
    await until(page, () => window.__vibora.game && window.__vibora.game.mode.state.score > 3000);
    await page.evaluate(() => window.__vibora.showResultsNow());
    await resultsSettled(page);
  }],
  ['results-career', `autopilot=1&career=club-open&quick=1&${BASE}`, async (page) => {
    // Seeded: the saved match resumes at 1-0, 40-0 (quick sets end 2-0), so one more point ends it.
    await until(page, () => window.__vibora.game && window.__vibora.game.isFinished(), null, 600000);
    await resultsSettled(page, 60000);
  }],
  ['results-drill', `autopilot=1&drill=fh-drive&speed=3&sw=0&mute=1&attract=0&quality=balanced`, async (page) => {
    await until(page, () => window.__vibora.stats.reps >= 6, null, 400000);
    await page.evaluate(() => window.__vibora.showResultsNow());
    await resultsSettled(page);
  }],
];

let failed = 0;
for (const [name, q, act] of SHOTS) {
  if (filter && !filter.test(name)) continue;
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()}`));
  page.setDefaultTimeout(240000);
  try {
    if (name === 'results-career') {
      await page.addInitScript(() => {
        try {
          if (!localStorage.getItem('vibora.career.v1')) {
            localStorage.setItem('vibora.career.v1', JSON.stringify({ v: 1, partner: 'lucia', events: {}, history: [], active: { eventId: 'club-open', matchIndex: 0, points: [0, 0, 0, 0, 0, 0, 0], startedAt: 0 } }));
          }
        } catch { /* ignore */ }
      });
    }
    await page.goto(`http://127.0.0.1:${port}/index.html?${q}`);
    await page.waitForFunction(() => window.__vibora && window.__vibora.ready, null, { timeout: 180000 });
    await act(page);
    const errs = await page.evaluate(() => window.__vibora.errors);
    await page.screenshot({ path: `${OUT}/game-${name}.png`, timeout: 180000 });
    const all = errors.concat(errs || []);
    if (all.length) { failed++; console.log(`✗ ${name}: ${all.slice(0, 4).join(' | ')}`); } else console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`✗ ${name}: ${err.message.split('\n')[0]} ${errors.slice(0, 3).join(' | ')}`);
    try { await page.screenshot({ path: `${OUT}/game-${name}-fail.png`, timeout: 60000 }); } catch { /* ignore */ }
  }
  await page.close();
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
