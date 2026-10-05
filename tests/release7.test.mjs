// Round 5 final merge: realistic graphics (HDRI lighting, MakeHuman athletes) and iPhone swipe mode
// wired into the app — the integration points the separate workflows could not test on their own.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ASSIST } from '../src/config.js';
import { timingConfig } from '../src/game/swingAssist.js';
import { TOUCH_OVERRIDES } from '../src/input/touch.js';
import { EXTRA, buildPrecache } from '../tools/precache.mjs';
import { createMobile, decideInput, detectDevice } from '../src/app/mobile.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFile(join(ROOT, f), 'utf8');

describe('swipe mode wiring (main.js, index.html, manifest, precache)', () => {
  test('index.html links styles/mobile.css after app.css; the manifest allows portrait and has a Swipe shortcut', async () => {
    const html = await read('index.html');
    const a = html.indexOf('href="./styles/app.css"');
    const m = html.indexOf('href="./styles/mobile.css"');
    assert.ok(a > 0 && m > a, 'mobile.css after app.css');
    const man = JSON.parse(await read('manifest.webmanifest'));
    assert.equal(man.orientation, 'any');
    const sc = man.shortcuts.find((s) => s.short_name === 'Swipe');
    assert.ok(sc && sc.url === './?source=app&input=swipe', 'Swipe shortcut');
  });

  test('main.js wires the mobile layer at every play-view entry and around syncWorld', async () => {
    const src = await read('src/main.js');
    for (const s of [
      "import { createMobile, savePrefs } from './app/mobile.js'",
      "const mobile = createMobile({ storage, QUALITY })",
      "if (mobile.input === 'touch' && inputMode === 'camera') inputMode = 'touch'",
      'mobile.attachGame(g, { clock })',
      'mobile.detachGame()',
      'wctx.stage = mobile.playStage(stage)',
      'mobile.selfActor(w)',
      'mobile.afterSync(w, dtReal)',
      'mobile.listener(game.world)',
      'mobile.frame({',
      'if (mobile.swipe || mobile.device.touchPrimary) mobile.install({',
      'mobile.applyBudget(stage)',
      'mobile.needsTutorial()',
      "inputMode === 'touch' ? 'Swipe controls'",
      'quality: P.quality ? S.quality : (mobile.quality || S.quality)',
    ]) assert.ok(src.includes(s), s);
    // Every entry into the play view goes through playView() (the swipe player's behind / first-person choice).
    assert.equal((src.match(/stage\.setView\('fp'\)/g) || []).length, 1, "only playView() calls stage.setView('fp')");
  });

  test('swipe mode is the default on iPhone / iPad and with ?input=swipe; the Mac keeps the camera', () => {
    const mm = (coarse) => (q) => ({ matches: q.includes('coarse') ? coarse : q.includes('fine') ? !coarse : false });
    const iphone = detectDevice({ nav: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)', maxTouchPoints: 5 }, win: { innerWidth: 844, innerHeight: 390, devicePixelRatio: 3, matchMedia: mm(true) } });
    const ipad = detectDevice({ nav: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 }, win: { innerWidth: 1180, innerHeight: 820, matchMedia: mm(true) } });
    const mac = detectDevice({ nav: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 }, win: { innerWidth: 1710, innerHeight: 1000, matchMedia: mm(false) } });
    assert.equal(decideInput({ search: '', device: iphone }), 'touch');
    assert.equal(decideInput({ search: '', device: ipad }), 'touch');
    assert.equal(decideInput({ search: '', device: mac }), null);
    assert.equal(decideInput({ search: '?input=swipe', device: mac }), 'touch');
    assert.equal(decideInput({ search: '?autopilot=1', device: iphone }), null);
    // The phone gets the mobile render tier (pixel ratio 1.5, one shadow light), registered on QUALITY.
    const Q = { balanced: { msaa: 0, smaa: false, maxPixelRatio: 1, turfShells: 0 } };
    const m = createMobile({ search: '', QUALITY: Q, nav: { userAgent: 'iPhone', maxTouchPoints: 5 }, win: { innerWidth: 844, innerHeight: 390, devicePixelRatio: 3, matchMedia: mm(true) } });
    assert.equal(m.input, 'touch');
    assert.equal(m.quality, 'mobile');
    assert.equal(Q.mobile.maxPixelRatio, 1.5);
    assert.equal(Q.mobile.maxShadowLights, 1);
    assert.equal(Q.mobile.smaa, false);
  });

  test('precache: mobile.css, the swipe modules, the athletes, HDRIs and detail maps are cached for offline play', async () => {
    assert.ok(EXTRA.includes('styles/mobile.css'));
    const { entries } = await buildPrecache();
    const files = new Set(entries.map((e) => e[0]));
    for (const f of [
      'styles/mobile.css', 'src/app/mobile.js', 'src/input/swipe.js', 'src/input/touch.js', 'src/render/chaseCam.js',
      'src/render/ibl.js', 'src/render/peopleAssets.js', 'vendor/three/addons/loaders/EXRLoader.js', 'vendor/three/addons/libs/fflate.module.js',
      'assets/people/athletes.glb', 'assets/people/skin.webp', 'assets/env/warehouse.exr', 'assets/env/sunset.exr', 'assets/env/esplanade.exr',
      'assets/tex/grit-normal.webp',
    ]) assert.ok(files.has(f), f);
  });
});

describe('swipe-only tuning never reaches camera play', () => {
  const world = (input, assist, hitMode = 'timing') => ({ input, settings: { assist, hitMode } });

  test('Pro in swipe mode has narrow timing windows; camera play with Hitting = Timing keeps the old ones', () => {
    assert.equal(ASSIST.pro.mode, 'physical');
    assert.equal(ASSIST.pro.timing, undefined);
    assert.deepEqual(timingConfig(world('touch', 'pro')), ASSIST.pro.swipeTiming);
    assert.ok(ASSIST.pro.swipeTiming.early < ASSIST.club.timing.early);
    assert.deepEqual(timingConfig(world('camera', 'pro')), ASSIST.club.timing);
    assert.equal(timingConfig(world('camera', 'pro', 'auto')), null, 'camera Pro stays physical');
    assert.deepEqual(timingConfig(world('touch', 'club')), ASSIST.club.timing);
  });

  test('the swipe aim weight is a touch override only', () => {
    assert.equal(TOUCH_OVERRIDES.swingDirWeight, 0.35);
    assert.equal(TOUCH_OVERRIDES.hitMode, 'timing');
  });
});

describe('graphics merge hooks', () => {
  test('scene warm-up re-runs when the realistic people rebuild (peopleVersion)', async () => {
    const src = await read('src/render/scene.js');
    assert.ok(src.includes('scene.userData.peopleVersion'), 'warm key includes peopleVersion');
    const pa = await read('src/render/peopleAssets.js');
    assert.ok(pa.includes('userData.peopleVersion'));
  });

  test('third-party notices credit the CC0 athletes, panoramas and normal maps, and fflate', async () => {
    const n = await read('THIRD_PARTY_NOTICES.md');
    for (const s of ['MakeHuman', 'assets/people/athletes.glb', 'Poly Haven', 'assets/env/warehouse.exr', 'assets/tex/grit-normal.webp', 'fflate', 'AGPL']) assert.ok(n.includes(s), s);
  });
});
