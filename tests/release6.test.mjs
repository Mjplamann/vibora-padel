// Round 6 merge: the handoffs between the clarity (HUD, approach circle, gaze) and timing / power
// (personal timing, effort) work — diagnostics' hitting section with no game running, the 'user1'
// autopilot flag, the timingAdapt setting and Reset timing, and the swing-power presentation (pock,
// trail, view kick, whoosh) driven by 'player:hit' / 'player:swing'.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildDiagnostics } from '../src/app/diagnostics.js';
import { parseParams } from '../src/app/params.js';
import { loadSettings, APP_DEFAULTS } from '../src/app/settings.js';
import { createTimingProfile, sharedTimingProfile, resetTimingProfile, TIMING_STORE_KEY } from '../src/game/timingProfile.js';
import { activeHitting } from '../src/game/swingAssist.js';
import { effortPock } from '../src/audio/engine.js';
import { trailPowerOf, setTrailPower, trailPower, TRAIL_POWER } from '../src/render/racketTrailMath.js';
import { KICK, kickDegOf, createViewKick } from '../src/render/viewKick.js';
import { whooshSpeed, WHOOSH } from '../src/app/wiring.js';
import { createGame, timingKey } from '../src/app/game.js';

const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};

/** A profile whose learned timing bias is about `bias` s. */
function biasedProfile(bias, storage = null, key = 'default') {
  const p = storage ? sharedTimingProfile(storage, key) : createTimingProfile();
  for (let i = 0; i < 12; i++) p.addTiming(bias + ((i % 3) - 1) * 0.02);
  return p;
}

describe('Copy diagnostics: hitting with no game running (round 6 user report: "physical" on Rookie)', () => {
  test('Rookie from Settings (no world) reports timing hitting with its windows', () => {
    const s = { ...loadSettings(null), assist: 'rookie' };
    const d = buildDiagnostics({ settings: s, input: 'camera' });
    assert.equal(d.hitting.mode, 'timing');
    assert.equal(d.hitting.assist, 'rookie');
    assert.ok(d.hitting.windows && d.hitting.windows.early === 0.32 && d.hitting.windows.late === 0.35, JSON.stringify(d.hitting.windows));
    assert.equal(d.hitting.windows.bufferEarly, 0.6);
    assert.equal(d.hitting.bias, 0);
    assert.equal(d.hitting.adapt, true);
    JSON.parse(JSON.stringify(d)); // JSON-safe (reach Infinity -> 'any')
    assert.equal(d.hitting.windows.reach, 'any');
  });
  test('Pro and mouse play are physical; Club follows the hitMode override', () => {
    const base = loadSettings(null);
    assert.equal(buildDiagnostics({ settings: { ...base, assist: 'pro' }, input: 'camera' }).hitting.mode, 'physical');
    assert.equal(buildDiagnostics({ settings: { ...base, assist: 'rookie' }, input: 'fallback' }).hitting.mode, 'physical');
    assert.equal(buildDiagnostics({ settings: { ...base, assist: 'club', hitMode: 'physical' }, input: 'camera' }).hitting.mode, 'physical');
    assert.equal(buildDiagnostics({ settings: { ...base, assist: 'pro', hitMode: 'timing' }, input: 'camera' }).hitting.mode, 'timing');
  });
  test('the learned timing bias, its text and the widened limits are reported; timingAdapt false reports none', () => {
    const s = { ...loadSettings(null), assist: 'club' };
    const prof = biasedProfile(-0.14);
    const d = buildDiagnostics({ settings: s, input: 'camera', timingProfile: prof });
    assert.ok(d.hitting.bias < -0.05 && d.hitting.bias >= -0.35, `bias ${d.hitting.bias}`);
    assert.match(d.hitting.tuned, /^Timing tuned to you: −0\.\d\d s$/);
    // windowsAround: an early bias widens the late limit (relative to t* + bias) by |bias|.
    assert.ok(Math.abs(d.hitting.active.bufferLate - (0.3 - d.hitting.bias)) < 2e-3, JSON.stringify(d.hitting.active));
    assert.ok(d.hitting.profile && d.hitting.profile.n === 12);
    const off = buildDiagnostics({ settings: { ...s, timingAdapt: false }, input: 'camera', timingProfile: prof });
    assert.equal(off.hitting.bias, 0);
    assert.equal(off.hitting.adapt, false);
  });
  test('with a running world the diagnostics read the world (as before)', () => {
    const S = { ...loadSettings(null), assist: 'rookie' };
    const g = createGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings: S, input: 'autopilot', startTime: 10, seed: 2 });
    try {
      const d = buildDiagnostics({ world: g.world, settings: S, input: 'camera' });
      assert.equal(d.hitting.mode, 'timing');
      assert.ok(d.session && d.session.mode);
    } finally {
      g.dispose();
    }
  });
});

describe('URL flags and settings', () => {
  test('?approfile=user1 is accepted (with ?apclose=1), unknown profiles are not', () => {
    const p = parseParams('?autopilot=1&approfile=user1&apclose=1&drill=fh-drive&aplatency=0.142');
    assert.equal(p.apProfile, 'user1');
    assert.equal(p.apClose, true);
    assert.equal(p.apLatency, 0.142);
    assert.equal(parseParams('?approfile=robot').apProfile, null);
  });
  test('timingAdapt defaults on, a stored false is kept, junk becomes true', () => {
    assert.equal(APP_DEFAULTS.timingAdapt, true);
    assert.equal(loadSettings(null).timingAdapt, true);
    const st = memStorage();
    st.setItem('vibora.settings.v1', JSON.stringify({ hud: 'clean', timingAdapt: false }));
    assert.equal(loadSettings(st).timingAdapt, false);
    st.setItem('vibora.settings.v1', JSON.stringify({ hud: 'clean', timingAdapt: 'maybe' }));
    assert.equal(loadSettings(st).timingAdapt, true);
  });
  test('Reset timing forgets this camera\'s bias (the running game\'s shared profile too), not another camera\'s', () => {
    const st = memStorage();
    const S = { ...loadSettings(null), assist: 'club', cameraPreset: 'macbook-builtin' };
    const key = timingKey(S);
    const mine = biasedProfile(-0.12, st, key);
    const other = biasedProfile(0.1, st, 'continuity-iphone');
    assert.ok(mine.bias < -0.05 && other.bias > 0.05);
    assert.ok(activeHitting({ settings: S, input: 'camera', profile: mine }).text);
    resetTimingProfile(st, key);
    assert.equal(sharedTimingProfile(st, key).bias, 0);
    assert.equal(sharedTimingProfile(st, key), mine, 'the same shared object a camera game uses');
    assert.equal(activeHitting({ settings: S, input: 'camera', profile: mine }).text, null);
    assert.ok(other.bias > 0.05, 'the other camera keeps its timing');
    const stored = JSON.parse(st.getItem(TIMING_STORE_KEY));
    assert.equal(stored[key].e.length, 0);
    assert.ok(stored['continuity-iphone'].e.length > 0);
  });
});

describe('swing power presentation', () => {
  test('pock: gain 0.7 + 0.6 effort, brighter above 0.8, unchanged without an effort', () => {
    assert.deepEqual(effortPock(9, null), { speed: 9, gain: 1 });
    assert.ok(Math.abs(effortPock(9, 0).gain - 0.7) < 1e-9);
    assert.ok(Math.abs(effortPock(9, 0.5).gain - 1.0) < 1e-9, 'the predicted (median) effort is neutral');
    assert.ok(Math.abs(effortPock(9, 1).gain - 1.3) < 1e-9);
    assert.equal(effortPock(9, 0.8).speed, 9);
    assert.ok(effortPock(9, 1).speed > 9 * 1.1);
    assert.equal(effortPock(9, 7).gain, effortPock(9, 1).gain, 'clamped');
  });
  test('trail: x(0.6 + 0.8 effort) for TRAIL_POWER.hold s; a full swing shows a ribbon even when slow', () => {
    assert.deepEqual(trailPowerOf(null), { k: 1, floor: 0 });
    assert.ok(Math.abs(trailPowerOf(0).k - 0.6) < 1e-9 && trailPowerOf(0).floor === 0);
    assert.ok(Math.abs(trailPowerOf(0.5).k - 1.0) < 1e-9 && trailPowerOf(0.5).floor === 0);
    assert.ok(Math.abs(trailPowerOf(1).k - 1.4) < 1e-9 && Math.abs(trailPowerOf(1).floor - TRAIL_POWER.floor) < 1e-9);
    setTrailPower(0.9);
    assert.equal(trailPower.left, TRAIL_POWER.hold);
    setTrailPower(null);
    assert.equal(trailPower.left, 0);
  });
  test('view kick: none below 0.85, at most 0.6 deg, gone within ~0.4 s', () => {
    assert.equal(kickDegOf(0.84), 0);
    assert.equal(kickDegOf(null), 0);
    assert.ok(Math.abs(kickDegOf(0.85) - KICK.maxDeg / 2) < 1e-9);
    assert.ok(Math.abs(kickDegOf(1) - KICK.maxDeg) < 1e-9);
    const k = createViewKick();
    assert.equal(k.add(0.5), 0);
    assert.equal(k.rad, 0);
    k.add(1);
    assert.ok(Math.abs(k.deg - 0.6) < 1e-9);
    for (let i = 0; i < 24; i++) k.step(1 / 60);
    assert.ok(k.deg < 0.6 * 0.01, `${k.deg} deg after 0.4 s`);
  });
  test('whoosh: voiced from the player\'s own effort (a slow webcam is not silent), raw speed without a profile', () => {
    const p = createTimingProfile();
    for (let i = 0; i < 30; i++) p.addSwing('ground', 2 + (i % 8)); // a slow camera: 2-9 m/s
    const lo = whooshSpeed(p, 2.2), mid = whooshSpeed(p, 5.5), hi = whooshSpeed(p, 9);
    assert.ok(lo < mid && mid < hi, `${lo} ${mid} ${hi}`);
    assert.ok(lo >= WHOOSH.lo - 1e-9 && hi <= WHOOSH.hi + 1e-9);
    assert.ok(hi > 16, `a hard swing of a slow camera is voiced loud (${hi.toFixed(1)} m/s)`);
    const fresh = createTimingProfile();
    assert.ok(whooshSpeed(fresh, 13, 2.2) > whooshSpeed(fresh, 13, 1), 'a full overhead swing gets the bigger voice');
    assert.equal(whooshSpeed(null, 7), 7);
  });
  test('wiring: one trail / kick per stroke at the strike; the confirmation is skipped; the whoosh is rescaled', async () => {
    const { bindWorld } = await import('../src/app/wiring.js');
    const fake = (over = {}) => new Proxy(Object.assign(function noop() {}, over), {
      get: (t, k) => (Object.prototype.hasOwnProperty.call(over, k) ? over[k] : k === 'then' ? undefined : fake()),
    });
    const S = { ...loadSettings(null), assist: 'rookie' };
    const g = createGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings: S, input: 'autopilot', startTime: 10, seed: 3, apLatency: 0.11, apDelivery: 0.15 });
    const w = g.world;
    const kicks = [];
    const swings = [];
    let audioBus = null;
    const stage = fake({ view: 'fp', fpCam: fake({ kick(e) { kicks.push(e); return 0; } }), ballView: fake({ bind() {} }), effects: fake({ bindLive() {} }), env: fake(), machine: fake() });
    const audio = fake({ bindBus(b) { audioBus = b; return () => {}; } });
    const off = bindWorld(w, { audio, voice: null, stage, ui: fake(), recorder: null });
    try {
      audioBus.on('player:swing', (e) => swings.push(e));
      const shot = { id: 7, by: 'player', effort: 0.95, speedOut: 30, stroke: 'forehand' };
      w.bus.emit('player:hit', { shot, effort: 0.95, kmh: 108, stroke: 'forehand', provisional: true, confirms: null });
      w.bus.emit('player:hit', { shot: { ...shot, id: 8, confirms: 7 }, effort: 0.95, kmh: 108, stroke: 'forehand', provisional: false, confirms: 7 });
      assert.deepEqual(kicks, [0.95]);
      assert.equal(trailPower.left, TRAIL_POWER.hold);
      w.bus.emit('player:swing', { t: w.time, phase: 'peak', speed: 6, pos: { x: 0, y: 1, z: 8 } });
      assert.equal(swings.length, 1);
      assert.equal(swings[0].measured, 6);
      assert.ok(swings[0].speed >= WHOOSH.lo && swings[0].speed <= WHOOSH.hi);
    } finally {
      off();
      g.dispose();
      setTrailPower(null);
    }
  });
});
