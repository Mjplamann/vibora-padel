// Integration helpers (src/app/*): sim clock, settings store, session runner with the
// autopilot and the mouse fallback, training aids, instant-replay recorder, privacy guard.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createSimClock } from '../src/app/clock.js';
import { loadSettings, createSettingsStore, STORAGE_KEY, VIEW_DEFAULTS } from '../src/app/settings.js';
import { createGame, STEP } from '../src/app/game.js';
import { createAids } from '../src/app/aids.js';
import { createRecorder, createReplayPlayer } from '../src/app/replay.js';
import { installPrivacyGuard } from '../src/app/privacy.js';
import { parseParams } from '../src/app/params.js';
import { createFallbackControls } from '../src/input/fallback.js';

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

describe('sim clock', () => {
  test('maps capture ms to sim seconds in lockstep, freezes while paused, scales with speed', () => {
    let now = 1000;
    const c = createSimClock({ speed: 1, now: () => now });
    assert.equal(c.simTimeOf(1000), 0);
    assert.equal(c.simTimeOf(1500), 0.5);
    now = 2000;
    c.pause();
    assert.equal(c.now(), 1);
    now = 5000;
    assert.equal(c.now(), 1, 'frozen while paused');
    c.resume();
    now = 5250;
    assert.equal(c.now(), 1.25, 'continues from the paused value');
    c.shift(-0.25);
    assert.equal(c.now(), 1);
    const fast = createSimClock({ speed: 3, now: () => now });
    now += 1000;
    assert.equal(fast.now(), 3);
  });
});

describe('settings', () => {
  test('defaults include the first-person framing; stored values survive; bad values are clamped', () => {
    const st = memStorage();
    const s = loadSettings(st);
    assert.equal(s.fov, VIEW_DEFAULTS.fov);
    assert.equal(s.viewPitch, VIEW_DEFAULTS.viewPitch);
    st.setItem(STORAGE_KEY, JSON.stringify({ fov: 400, handed: 'left', cameraPreset: 'iphone-continuity', volumes: { sfx: 0.2 } }));
    const t = loadSettings(st);
    assert.equal(t.fov, 100);
    assert.equal(t.handed, 'left');
    assert.equal(t.hfovDeg, 74);
    assert.equal(t.volumes.sfx, 0.2);
    assert.equal(t.volumes.master, 0.9);
    st.setItem(STORAGE_KEY, '{not json');
    assert.equal(loadSettings(st).handed, 'right', 'corrupt storage falls back to defaults');
  });

  test('patch reports changed keys and persists', async () => {
    const st = memStorage();
    const store = createSettingsStore(st);
    assert.deepEqual(store.patch({ assist: 'pro', fov: store.value.fov }), ['assist']);
    store.save();
    assert.equal(JSON.parse(st.getItem(STORAGE_KEY)).assist, 'pro');
    assert.deepEqual(store.patch({}), []);
  });

  test('URL flags', () => {
    const p = parseParams('?autopilot=1&speed=3&drill=volleys&mode=nope&quality=balanced&pitch=-15');
    assert.equal(p.autopilot, true);
    assert.equal(p.speed, 3);
    assert.equal(p.drill, 'volleys');
    assert.equal(p.mode, null);
    assert.equal(p.quality, 'balanced');
    assert.equal(p.pitch, -15);
    assert.equal(parseParams('').speed, 1);
  });
});

describe('session runner (createGame)', () => {
  test('autopilot drives the real pipeline from a non-zero clock time: hits and lands drives', () => {
    const s = loadSettings(null);
    const g = createGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings: s, input: 'autopilot', startTime: 4321.5, seed: 3 });
    assert.ok(Math.abs(g.world.time - 4321.5) < STEP, 'world continues the global clock');
    const rec = createRecorder({ seconds: 6 });
    g.world.bus.on('ball:hit', ({ shot }) => rec.onHit(shot));
    let t = g.world.time;
    // Feeds wait for the previous rep to be judged (about 4.5-5 s apart for drives).
    const end = t + 45;
    while (t < end) {
      t += 0.1;
      g.advanceTo(t, (w) => rec.record(w));
    }
    assert.ok(g.stats.playerHits >= 7, `hits ${g.stats.playerHits}`);
    assert.ok(g.stats.inCourt / Math.max(1, g.stats.judgedShots) >= 0.6, `in court ${g.stats.inCourt}/${g.stats.judgedShots}`);
    // Replay of the last seconds: world-shaped frames, the player's stroke keyed to the contact.
    const snap = rec.snapshot();
    assert.ok(snap && snap.t1 - snap.t0 > 5.5 && snap.frames.length > 300);
    assert.ok(snap.hits.length >= 1);
    const last = snap.hits[snap.hits.length - 1].t;
    const rp = createReplayPlayer(snap, { rate: 0.4, from: last - 1 });
    rp.seek(last);
    const f = rp.frame();
    assert.equal(f.selfActor.holding, 'swing');
    assert.ok(Math.abs(f.selfActor.swingPhase - 0.55) < 0.02);
    assert.ok(f.world.ball, 'ball recorded');
    assert.ok(f.racketPath.length > 5, 'tracked racket path');
    assert.ok(rp.step(0.5));
    g.dispose();
  });

  test('mouse fallback: the Space auto-swing returns machine feeds into the court (Club assist)', () => {
    const s = loadSettings(null);
    const fb = createFallbackControls({ canvas: null, keyTarget: null, handed: 'right' });
    const g = createGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings: s, input: 'fallback', fallback: fb, startTime: 10, seed: 5 });
    const w = g.world;
    let armed = true;
    w.bus.on('ball:launch', () => { armed = true; });
    let t = w.time;
    // Feeds wait for each rep's ruling (about 4.5-5 s apart): 50 s gives 10-11 feeds.
    while (t < 60) {
      t += 0.05;
      if (armed && w.ball && w.flight.by === 'machine' && w.ball.vel.z > 0 && w.ball.pos.z > -4) {
        fb.triggerAutoSwing();
        armed = false;
      }
      g.advanceTo(t);
    }
    assert.ok(g.stats.playerHits >= 8, `hits ${g.stats.playerHits}`);
    assert.ok(g.stats.playerHits >= g.stats.feeds * 0.75, `hits ${g.stats.playerHits} of ${g.stats.feeds} feeds`);
    assert.ok(g.stats.inCourt / Math.max(1, g.stats.judgedShots) >= 0.7, `in court ${g.stats.inCourt}/${g.stats.judgedShots}`);
  });

  test('rally and match modes run with the autopilot', () => {
    const s = loadSettings(null);
    for (const spec of [{ kind: 'rally', level: 'club' }, { kind: 'match', level: 'club' }]) {
      const g = createGame({ spec, settings: s, input: 'autopilot', startTime: 50, seed: 11 });
      let t = g.world.time;
      while (t < 75) { t += 0.1; g.advanceTo(t); }
      assert.ok(g.stats.playerHits >= 2, `${spec.kind}: ${g.stats.playerHits} hits`);
      g.dispose();
    }
  });
});

describe('training aids', () => {
  test('landing marker predicts the first bounce of an incoming machine feed on the near side', () => {
    const s = loadSettings(null);
    const g = createGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings: s, input: 'autopilot', startTime: 0, seed: 2 });
    const aids = createAids();
    let landing = null, ghost = null;
    let bounce = null;
    g.world.bus.on('ball:bounce', ({ evt }) => { if (!bounce && evt.side === 'near') bounce = evt.pos.clone(); });
    let t = g.world.time;
    while (!bounce && t < 20) {
      t += 0.05;
      g.advanceTo(t);
      const a = aids.update(g.world, { wantLanding: true, wantGhost: true });
      if (a.landing && !landing) landing = { ...a.landing };
      if (a.ghost && !ghost) ghost = { ...a.ghost };
    }
    assert.ok(bounce && landing, 'marker shown before the bounce');
    assert.ok(Math.hypot(landing.x - bounce.x, landing.z - bounce.z) < 0.25, `marker ${JSON.stringify(landing)} vs bounce ${JSON.stringify(bounce)}`);
    assert.ok(ghost && ghost.z > 0 && ghost.y > 0.3, 'ideal contact on the near side');
  });
});

describe('privacy guard', () => {
  test('MediaPipe usage logging is answered locally; other requests pass through', async () => {
    const calls = [];
    const target = { fetch: async (u) => { calls.push(u); return new Response('ok', { status: 200 }); } };
    installPrivacyGuard(target);
    const r = await target.fetch('https://odml.pa.googleapis.com/v1/log', { method: 'POST' });
    assert.equal(r.status, 204);
    assert.equal(calls.length, 0);
    const ok = await target.fetch('./models/pose_landmarker_full.task');
    assert.equal(ok.status, 200);
    assert.deepEqual(calls, ['./models/pose_landmarker_full.task']);
  });
});

describe('out-of-frame watch', () => {
  test('warns after the body or the feet leave the picture, not on a single dropped frame', async () => {
    const { createFrameWatch, FRAME_WARN } = await import('../src/app/tracking.js');
    const { createSyntheticCamera, standingBody } = await import('../src/tracking/synthetic.js');
    const cam = createSyntheticCamera({ hfovDeg: 68 });
    const watch = createFrameWatch();
    const at = (d, x, t) => watch.update(cam.frame(t, [standingBody({ room: { x, d } })]));
    assert.equal(at(2.6, 0, 0), null, 'calibrated spot: fully in frame');
    // Too close: the feet drop out of the picture (camera 1 m high, 68° lens).
    assert.equal(at(1.85, 0, 100), null);
    const feet = at(1.85, 0, 100 + FRAME_WARN.feet * 1000 + 50);
    assert.ok(feet && feet.kind === 'feet', JSON.stringify(feet));
    // Far off to the side: the body leaves the picture.
    at(2.6, 2.2, 3000);
    const body = at(2.6, 2.2, 3000 + FRAME_WARN.body * 1000 + 50);
    assert.ok(body && body.kind === 'body', JSON.stringify(body));
    // Nobody in the picture.
    watch.update({ t: 5000, people: [] });
    const none = watch.update({ t: 5000 + FRAME_WARN.body * 1000 + 50, people: [] });
    assert.ok(none && none.kind === 'none');
    assert.equal(at(2.6, 0, 7000), null, 'back on the spot: no warning');
  });
});
