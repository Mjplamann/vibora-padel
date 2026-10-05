// Round 6 (clarity): screenshots of dev/hud-clean.html — the play HUD in each layout (clean, standard,
// coach) with every transient element forced on — at the user's MacBook size (1710x876 @2x) and
// 1920x1080, plus the DOM rects of every visible HUD block tested against the central play region.
// Usage: node dev/hud-shots.mjs [outDir] [filter]
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from '../tools/serve.mjs';
import { intrudesPlayRegion } from '../src/ui/playRegion.js';

async function loadPlaywright() {
  try { return await import('playwright'); } catch { return await import('/opt/node-tools/node_modules/playwright/index.mjs'); }
}
const OUT = process.argv[2] || 'tools/out/hud';
const filter = process.argv[3] ? new RegExp(process.argv[3]) : null;
await mkdir(OUT, { recursive: true });
const { chromium } = await loadPlaywright();
const server = await startServer(0);
const port = server.address().port;
const browser = await chromium.launch();
const SEL = '.vp-hud > :not(.hud-tl):not(.hud-tr):not(.hud-bar), .vp-hud .hud-bar > *, .vp-hud .hud-tl > *, .vp-hud .hud-tr > *, .vp-banner .banner, .vp-toasts .toast, .vp-achievements .ach-toast';
const report = {};
let bad = 0;
for (const hud of ['clean', 'standard', 'coach']) {
  for (const mode of ['drill', 'rally', 'match', 'challenge']) {
    for (const live of [1, 0]) {
      const name = `${hud}-${mode}-${live ? 'live' : 'between'}`;
      if (filter && !filter.test(name)) continue;
      for (const [w, h, dpr] of [[1710, 876, 2], [1920, 1080, 1]]) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        await page.goto(`http://127.0.0.1:${port}/dev/hud-clean.html?hud=${hud}&mode=${mode}&live=${live}&region=1`);
        await page.waitForFunction(() => window.__hudReady, null, { timeout: 30000 });
        await page.waitForTimeout(300);
        const blocks = await page.evaluate((sel) => {
          const out = [];
          for (const el of document.querySelectorAll(sel)) {
            if (el.hidden || el.closest('[hidden]')) continue;
            let o = 1, shown = true;
            for (let e = el; e && e !== document.body; e = e.parentElement) {
              const cs = getComputedStyle(e);
              if (cs.display === 'none' || cs.visibility === 'hidden') { shown = false; break; }
              o *= Number(cs.opacity);
            }
            if (!shown || o < 0.06) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4 || (r.width > innerWidth * 0.98 && r.height > innerHeight * 0.98)) continue;
            out.push({ cls: String(el.className).split(' ').slice(0, 2).join('.'), x0: r.left, y0: r.top, x1: r.right, y1: r.bottom, text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70) });
          }
          return { blocks: out, feed: window.__feedLine ? window.__feedLine() : null };
        }, SEL);
        const intr = blocks.blocks.filter((b) => intrudesPlayRegion(b, w, h, { margin: 1 }));
        report[`${name}-${w}`] = { ...blocks, intruding: intr.map((b) => b.cls), errors };
        if (live && intr.length) bad++;
        await page.screenshot({ path: `${OUT}/${name}-${w}.png` });
        console.log(`${name} ${w}x${h}: ${blocks.blocks.length} blocks, ${intr.length} in the play region${intr.length ? ` (${intr.map((b) => b.cls).join(', ')})` : ''}; line: ${blocks.feed ? JSON.stringify(blocks.feed.text) : '—'}${errors.length ? ` ERR ${errors.join(' | ')}` : ''}`);
        await ctx.close();
      }
    }
  }
}
await writeFile(`${OUT}/hud-blocks.json`, JSON.stringify(report, null, 1));
await browser.close();
server.close();
console.log(bad ? `${bad} live layouts put a block in the play region` : 'no HUD block in the play region while the ball is live');
process.exit(bad ? 1 : 0);
