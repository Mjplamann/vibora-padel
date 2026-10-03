import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/game/session.js';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
  };
}

const throwingStorage = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
};

let nextId = 1;
function shot(o = {}) {
  return {
    id: nextId++,
    t: 0,
    by: 'player',
    stroke: 'forehand',
    contact: { x: 2, y: 0.9, z: 7 },
    contactU: null,
    racketSpeed: 18,
    speedIn: 15,
    speedOut: 20, // 72 km/h
    spinRpm: { top: 1200, side: 100, total: 1500 },
    offCenter: 0.02,
    quality: 0.8,
    assist: 'club',
    timing: 'good',
    spacing: 'good',
    netClearance: 0.5,
    predictedLanding: null,
    afterBounce: true,
    afterWall: false,
    ...o,
  };
}

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

describe('session: aggregates', () => {
  test('empty summary is well formed', () => {
    const s = createSession({ storage: null });
    const sum = s.summary();
    assert.equal(sum.shots, 0);
    assert.deepEqual(sum.byStroke, {});
    assert.deepEqual(sum.landings, []);
    assert.equal(sum.bestRally, 0);
    assert.equal(sum.longestStreak, 0);
    assert.equal(sum.avgReactionMs, null);
    assert.equal(sum.prepOnTimeRate, null);
    assert.equal(sum.activeSeconds, 0);
    assert.equal(sum.kcal, 0);
  });

  test('per-stroke count, km/h, rpm, success rate and quality', () => {
    const s = createSession({ storage: null });
    s.record(shot({ speedOut: 20, spinRpm: { top: 0, side: 0, total: 1000 }, quality: 0.6 }), { success: true });
    s.record(shot({ speedOut: 25, spinRpm: { top: 0, side: 0, total: 2000 }, quality: 1.0 }), { success: false });
    s.record(shot({ stroke: 'bandeja', speedOut: 15, spinRpm: { top: 0, side: 0, total: -800 }, quality: 0.5 }), { inTarget: true });
    const { byStroke, shots, successRate } = s.summary();
    assert.equal(shots, 3);
    assert.equal(byStroke.forehand.count, 2);
    close(byStroke.forehand.avgSpeedKmh, 81);
    close(byStroke.forehand.avgSpinRpm, 1500);
    close(byStroke.forehand.successRate, 0.5);
    close(byStroke.forehand.avgQuality, 0.8);
    assert.equal(byStroke.bandeja.count, 1);
    close(byStroke.bandeja.avgSpeedKmh, 54);
    close(byStroke.bandeja.avgSpinRpm, 800, 1e-9); // magnitude
    close(byStroke.bandeja.successRate, 1, 1e-9); // inTarget counts as success
    close(successRate, 2 / 3);
  });

  test('non-player shots are ignored', () => {
    const s = createSession({ storage: null });
    assert.equal(s.record(shot({ by: 'machine' }), { success: true }), null);
    assert.equal(s.record(shot({ by: 'coach' }), { success: true }), null);
    assert.equal(s.record(null), null);
    assert.equal(s.summary().shots, 0);
  });

  test('missing numeric fields do not poison the averages', () => {
    const s = createSession({ storage: null });
    s.record(shot({ speedOut: undefined, spinRpm: null, quality: NaN }), {});
    s.record(shot({ speedOut: 10 }), {});
    const fh = s.summary().byStroke.forehand;
    assert.equal(fh.count, 2);
    close(fh.avgSpeedKmh, 36);
    close(fh.avgSpinRpm, 1500);
    close(fh.avgQuality, 0.8);
  });

  test('landings keep x, z and success; null landings are skipped', () => {
    const s = createSession({ storage: null });
    s.record(shot(), { success: true, landing: { x: -2, y: 0, z: -8 } });
    s.record(shot(), { success: false, landing: null });
    s.record(shot(), { success: false, landing: { x: 1, z: -3 } });
    assert.deepEqual(s.summary().landings, [
      { x: -2, z: -8, success: true },
      { x: 1, z: -3, success: false },
    ]);
  });

  test('streaks: longest and current', () => {
    const s = createSession({ storage: null });
    const pattern = [1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
    for (const ok of pattern) s.record(shot(), { success: !!ok, points: ok ? 100 : 0 });
    const sum = s.summary();
    assert.equal(sum.longestStreak, 4);
    assert.equal(sum.currentStreak, 2);
    assert.equal(sum.points, 800);
  });

  test('best rally from results and rallyEnded()', () => {
    const s = createSession({ storage: null });
    s.record(shot(), { rallyLength: 5 });
    s.rallyEnded(12);
    s.rallyEnded(3);
    s.record(shot(), { rallyLength: 7 });
    assert.equal(s.summary().bestRally, 12);
  });

  test('reaction time and racket-prep punctuality', () => {
    const s = createSession({ storage: null });
    s.record(shot({ reactionMs: 400 }), { prepOnTime: true });
    s.record(shot(), { reactionMs: 600, prepOnTime: false });
    s.record(shot({ prepOnTime: true }), {});
    s.record(shot(), {}); // no data: excluded from both
    const sum = s.summary();
    close(sum.avgReactionMs, 500);
    close(sum.prepOnTimeRate, 2 / 3);
  });

  test('log entries and reset', () => {
    const s = createSession({ storage: null });
    const e = s.record(shot({ stroke: 'vibora', t: 3 }), { success: true, points: 250, notes: ['Contact further in front'] });
    assert.equal(e.stroke, 'vibora');
    assert.equal(e.points, 250);
    assert.deepEqual(e.notes, ['Contact further in front']);
    assert.equal(s.log.length, 1);
    s.tick(10, { inPlay: true });
    s.reset();
    const sum = s.summary();
    assert.equal(sum.shots, 0);
    assert.equal(sum.activeSeconds, 0);
    assert.equal(sum.longestStreak, 0);
  });
});

describe('session: active time and kcal', () => {
  test('one hour of ball in play at reference movement: MET 7 x 70 kg = 490 kcal', () => {
    const s = createSession({ storage: null });
    for (let i = 0; i < 3600; i++) s.tick(1, { inPlay: true });
    const sum = s.summary();
    close(sum.activeSeconds, 3600, 1e-6);
    close(sum.movementScale, 1);
    close(sum.kcal, 490, 1e-6);
  });

  test('time with the ball dead is not active', () => {
    const s = createSession({ storage: null });
    s.tick(600, { inPlay: true });
    s.tick(600, { inPlay: false });
    s.tick(-5, { inPlay: true });
    const sum = s.summary();
    close(sum.activeSeconds, 600);
    close(sum.kcal, 7 * 70 * (600 / 3600));
  });

  test('kcal scales with real movement, bounded', () => {
    const still = createSession({ storage: null });
    still.tick(1800, { inPlay: true, realSpeed: 0 });
    const ref = createSession({ storage: null });
    ref.tick(1800, { inPlay: true, realSpeed: 0.5 });
    const busy = createSession({ storage: null });
    busy.tick(1800, { inPlay: true, realSpeed: 3 });
    close(still.summary().movementScale, 0.6);
    close(ref.summary().movementScale, 1);
    close(busy.summary().movementScale, 1.25);
    close(ref.summary().kcal, 245, 1e-6);
    assert.ok(still.summary().kcal < ref.summary().kcal);
    assert.ok(busy.summary().kcal > ref.summary().kcal);
  });

  test('weight and MET are configurable', () => {
    const s = createSession({ storage: null, weightKg: 85, met: 6 });
    s.tick(3600, { inPlay: true });
    close(s.summary().kcal, 510, 1e-6);
  });

  test('without ticks, active time is estimated from shot timestamps', () => {
    const s = createSession({ storage: null });
    // A rally: shots at 0, 2.5, 5 s, then a long pause, then one shot at 60 s.
    for (const t of [0, 2.5, 5, 60]) s.record(shot({ t }), {});
    const sum = s.summary();
    // 2.5 + 2.5 + 1.5 (tail after the rally) + 1.5 (tail after the last shot)
    close(sum.activeSeconds, 8);
    close(sum.kcal, 7 * 70 * (8 / 3600));
  });
});

describe('session: bests through injected storage', () => {
  test('saveBest only improves, and persists to storage', () => {
    const st = fakeStorage();
    const s = createSession({ storage: st, now: () => 1234 });
    assert.equal(s.bests('fh-drive'), null);
    assert.deepEqual(s.saveBest('fh-drive', 1500), { isNew: true, best: 1500, previous: null });
    assert.deepEqual(JSON.parse(st.map.get('vibora.best.fh-drive')), { points: 1500, at: 1234 });
    assert.deepEqual(s.saveBest('fh-drive', 900), { isNew: false, best: 1500, previous: 1500 });
    assert.deepEqual(s.saveBest('fh-drive', 1500), { isNew: false, best: 1500, previous: 1500 });
    assert.deepEqual(s.saveBest('fh-drive', 2100), { isNew: true, best: 2100, previous: 1500 });
    assert.equal(s.bests('fh-drive'), 2100);
    assert.equal(s.bests('vibora'), null);
  });

  test('bests survive into a new session', () => {
    const st = fakeStorage();
    createSession({ storage: st }).saveBest('bandeja', 777);
    const s2 = createSession({ storage: st });
    assert.equal(s2.bests('bandeja'), 777);
    assert.equal(s2.saveBest('bandeja', 700).isNew, false);
  });

  test('legacy numeric values are read', () => {
    const s = createSession({ storage: fakeStorage({ 'vibora.best.serve': '420' }) });
    assert.equal(s.bests('serve'), 420);
  });

  test('corrupt stored JSON is treated as no best', () => {
    const s = createSession({ storage: fakeStorage({ 'vibora.best.serve': '{oops', 'vibora.best.lob-defense': '{"points":"x"}' }) });
    assert.equal(s.bests('serve'), null);
    assert.equal(s.bests('lob-defense'), null);
    assert.equal(s.saveBest('serve', 10).isNew, true);
  });

  test('throwing storage never throws out; bests live in memory for the session', () => {
    const s = createSession({ storage: throwingStorage });
    assert.equal(s.bests('volleys'), null);
    assert.doesNotThrow(() => s.saveBest('volleys', 300));
    assert.equal(s.bests('volleys'), 300);
    assert.equal(s.saveBest('volleys', 200).isNew, false);
  });

  test('null storage works in memory', () => {
    const s = createSession({ storage: null });
    s.saveBest('chiquita', 50);
    assert.equal(s.bests('chiquita'), 50);
  });

  test('non-finite points are rejected', () => {
    const s = createSession({ storage: fakeStorage() });
    assert.equal(s.saveBest('x', NaN).isNew, false);
    assert.equal(s.bests('x'), null);
  });
});
