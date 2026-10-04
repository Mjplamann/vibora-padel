// Screenshots of the round-4 game screens in the REAL app (1920×1080, software WebGL):
// hub, training, career, event intro, trophies (tabs), arcade, free play, settings, and a
// challenge in play (HUD) with ?autopilot=1. Reports console errors per shot.
// Usage: node dev/game-shots.mjs [outDir] [filter]
import { mkdir } from 'node:fs/promises';
import { startServer } from '../tools/serve.mjs';
import { createProgress, xpForLevel } from '../src/game/progression.js';
import { createCareer } from '../src/game/career.js';
import { createLeaderboards } from '../src/game/challenges.js';
import { ACHIEVEMENTS } from '../src/game/achievements.js';

/** A mid-career profile (localStorage contents) for the "after" screenshots. */
function seededStorage() {
  const m = new Map();
  const st = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
  let now = Date.parse('2026-10-01T18:00:00');
  const p = createProgress({ storage: st, now: () => now });
  p.addXp(xpForLevel(9) + 900);
  for (const [id, place] of [['club-open', 1], ['liga', 1], ['atardecer', 1], ['regional', 1]]) p.awardTrophy(id, place);
  p.equip('racket', 'cobra');
  p.equip('outfit', 'sunset');
  for (const a of ACHIEVEMENTS.slice(0, 11)) p.unlockAchievement(a.id);
  for (let d = 0; d < 4; d++) {
    p.recordSession({ activeSeconds: 1500, kcal: 190, swings: 420, shots: 300, bestRally: 23, drillId: ['fh-drive', 'bh-drive', 'back-glass', 'volleys'][d] });
    now += 86400000;
  }
  const c = createCareer({ storage: st, now: () => now });
  c.setPartner('nico');
  for (const id of ['club-open', 'liga', 'atardecer', 'regional']) {
    c.startEvent(id);
    while (c.active) c.recordMatch({ won: true });
  }
  c.startEvent('copa-costa');
  c.recordMatch({ won: true });
  c.saveMidMatch([0, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0]);
  const lb = createLeaderboards({ storage: st, now: () => now });
  lb.submit('por-tres-party', { score: 33600, combo: 14, perfect: 9 });
  lb.submit('glass-breaker', { score: 7590, combo: 8, perfect: 7 });
  lb.submit('rally-marathon', { score: 4415, combo: 25 });
  lb.submit('volley-wall', { score: 13400, combo: 18 });
  st.setItem('vibora.best.fh-drive', JSON.stringify({ points: 1480, at: now }));
  st.setItem('vibora.best.back-glass', JSON.stringify({ points: 610, at: now }));
  st.setItem('vibora.best.volleys', JSON.stringify({ points: 1210, at: now }));
  return Object.fromEntries(m);
}
const SEED = seededStorage();

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

const BASE = 'sw=0&mute=1&attract=0&quality=balanced';
const SHOTS = [
  ['hub', `fallback=1&${BASE}`, null],
  ['training', `fallback=1&screen=training&${BASE}`, null],
  ['career', `fallback=1&screen=career&${BASE}`, null],
  ['event-intro', `fallback=1&screen=event-intro&event=club-open&${BASE}`, null],
  ['trophies', `fallback=1&screen=trophies&${BASE}`, null],
  ['trophies-rackets', `fallback=1&screen=trophies&tab=rackets&${BASE}`, null],
  ['trophies-outfits', `fallback=1&screen=trophies&tab=outfits&${BASE}`, null],
  ['trophies-achievements', `fallback=1&screen=trophies&tab=achievements&${BASE}`, null],
  ['trophies-stats', `fallback=1&screen=trophies&tab=stats&${BASE}`, null],
  ['arcade', `fallback=1&screen=arcade&${BASE}`, null],
  ['freeplay', `fallback=1&screen=freeplay&fpmode=match&${BASE}`, null],
  ['settings', `fallback=1&screen=settings&${BASE}`, null],
  // Mid-career profile: trophies won, rackets unlocked, achievements, a match to resume.
  ['hub-seeded', `fallback=1&${BASE}`, null, true],
  ['career-seeded', `fallback=1&screen=career&${BASE}`, null, true],
  ['event-resume', `fallback=1&screen=event-intro&event=copa-costa&${BASE}`, null, true],
  ['trophies-seeded', `fallback=1&screen=trophies&${BASE}`, null, true],
  ['rackets-seeded', `fallback=1&screen=trophies&tab=rackets&${BASE}`, null, true],
  ['outfits-seeded', `fallback=1&screen=trophies&tab=outfits&${BASE}`, null, true],
  ['achievements-seeded', `fallback=1&screen=trophies&tab=achievements&${BASE}`, null, true],
  ['fitness-seeded', `fallback=1&screen=trophies&tab=stats&${BASE}`, null, true],
  ['arcade-seeded', `fallback=1&screen=arcade&${BASE}`, async (page) => {
    await page.click('[data-challenge="por-tres-party"]');
    await page.waitForTimeout(500);
  }, true],
];

let failed = 0;
for (const [name, q, act, seeded] of SHOTS) {
  if (filter && !filter.test(name)) continue;
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  if (seeded) await page.addInitScript((data) => { for (const [k, v] of Object.entries(data)) localStorage.setItem(k, v); }, SEED);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()}`));
  page.setDefaultTimeout(180000);
  await page.goto(`http://127.0.0.1:${port}/index.html?${q}`);
  await page.waitForFunction(() => window.__vibora && window.__vibora.ready, null, { timeout: 180000 });
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => !document.querySelector('.vp-screen .is-entering'), null, { timeout: 120000, polling: 250 });
  if (act) await act(page);
  await page.waitForFunction(() => !document.querySelector('.vp-screen .is-entering'), null, { timeout: 120000, polling: 250 });
  // Freeze transitions at their end state (a loaded machine can catch a fade half-way).
  await page.evaluate(() => {
    const st = document.createElement('style');
    st.textContent = '.vp *, .vp *::before, .vp *::after { transition: none !important; animation: none !important; }';
    document.head.appendChild(st);
  });
  await page.waitForTimeout(800);
  const errs = await page.evaluate(() => window.__vibora.errors);
  await page.screenshot({ path: `${OUT}/game-${name}.png`, timeout: 180000 });
  const all = errors.concat(errs || []);
  if (all.length) { failed++; console.log(`✗ ${name}: ${all.slice(0, 4).join(' | ')}`); } else console.log(`✓ ${name}`);
  await page.close();
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
