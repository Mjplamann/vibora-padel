// Round 4 (game design): arcade challenges (scoring, combos, perfect timing, timer, leaderboards,
// daily challenge), achievements and the automatic-replay director. The challenges run through the
// real pipeline (synthetic camera + autopilot -> tracking -> timing hits -> physics -> referee).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createRng } from '../src/util/math.js';
import { createWorld, stepWorld, resolveSettings } from '../src/game/world.js';
import { createHumanController } from '../src/game/human.js';
import { createAutopilot } from '../src/tracking/autopilot.js';
import { createSyntheticCamera } from '../src/tracking/synthetic.js';
import { shotOutcomeInfo, createRallyShotLog } from '../src/game/modes.js';
import {
  CHALLENGES, CHALLENGE_BY_ID, createChallengeMode, createLeaderboards, dailyChallenge, dateKey, multiplierFor, isPerfectHit,
  PERFECT_TIMING_S, ARCADE_KEY,
} from '../src/game/challenges.js';
import { ACHIEVEMENTS, ACHIEVEMENT_BY_ID, createAchievementTracker } from '../src/game/achievements.js';
import { createReplayDirector, createRecorder, createReplayPlayer, REPLAY_MOMENTS } from '../src/app/replay.js';
import { createSession, MAX_SWING_SPEED } from '../src/game/session.js';

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

/** A challenge through the full pipeline with the autopilot (precise or human-like). */
function runChallenge(id, { profile = 'precise', seed = 7, opts = {}, onTick = null } = {}) {
  const settings = resolveSettings({ assist: 'club' });
  const world = createWorld({ settings, rng: createRng(seed) });
  const human = createHumanController({ settings: world.settings });
  world.human = human;
  world.input = 'autopilot';
  const cam = createSyntheticCamera({ hfovDeg: settings.hfovDeg });
  const ap = createAutopilot({ rng: createRng(seed + 1) });
  if (profile !== 'precise') ap.setProfile(profile, { seed: seed * 3 });
  let next = 0;
  const pending = [];
  const tick = () => {
    if (world.time >= next - 1e-9) {
      pending.push({ at: world.time + 0.045, frame: cam.frame(world.time * 1000, [ap.update(world, world.time)]), t: world.time });
      next += 1 / 30;
    }
    while (pending.length && pending[0].at <= world.time + 1e-9) {
      const f = pending.shift();
      human.onPoseFrame(world, f.frame, f.t);
    }
    stepWorld(world, 1 / 240);
  };
  while (world.time < 1) tick();
  human.calibrate();
  const mode = createChallengeMode(id, { rng: createRng(seed + 4), session: createSession(), ...opts });
  world.mode = mode;
  mode.start(world);
  const ev = {};
  for (const t of ['challenge:score', 'challenge:perfect', 'challenge:combo', 'challenge:targets', 'challenge:target-hit', 'challenge:end', 'rally:outcome', 'shot:result']) {
    world.bus.on(t, (p) => { (ev[t] = ev[t] || []).push(p); });
  }
  const t0 = world.time;
  while (!mode.isFinished() && world.time < t0 + 200) {
    tick();
    if (onTick) onTick(world, mode);
  }
  return { world, mode, ev, t0, summary: mode.summary(world) };
}

describe('arcade scoring rules', () => {
  test('multiplier steps, perfect hits, daily challenge determinism', () => {
    assert.deepEqual([0, 2, 3, 5, 6, 9, 10, 14, 15, 40].map(multiplierFor), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    assert.equal(isPerfectHit({ by: 'player', timingHit: { e: 0.03 } }), true);
    assert.equal(isPerfectHit({ by: 'player', timingHit: { e: -PERFECT_TIMING_S - 0.01 } }), false);
    assert.equal(isPerfectHit({ by: 'player', quality: 0.9, timing: 'good' }), true, 'physical: sweet spot on time');
    assert.equal(isPerfectHit({ by: 'player', quality: 0.9, timing: 'late' }), false);
    assert.equal(isPerfectHit({ by: 'coach', timingHit: { e: 0 } }), false);
    const a = dailyChallenge('2026-10-04');
    assert.deepEqual(a, dailyChallenge('2026-10-04'), 'same day, same challenge');
    assert.ok(CHALLENGE_BY_ID[a.base] && a.id === 'daily:2026-10-04' && a.twist.en && ['club', 'sunset', 'stadium'].includes(a.venue));
    const week = new Set(Array.from({ length: 14 }, (_, i) => dailyChallenge(`2026-11-${String(i + 1).padStart(2, '0')}`).base));
    assert.ok(week.size >= 3, 'the daily rotates through the challenges');
    assert.equal(dateKey(new Date(2026, 0, 5)), '2026-01-05');
    assert.equal(CHALLENGES.length, 4);
    for (const c of CHALLENGES) assert.ok(c.duration >= 60 && c.duration <= 90, c.id);
  });

  test('leaderboards: rivals to beat, your runs ranked, bests, persistence, bad storage', () => {
    const st = memStorage();
    const lb = createLeaderboards({ storage: st, now: () => 1000 });
    const before = lb.board('glass-breaker');
    assert.equal(before.length, 5);
    assert.ok(before.every((r) => !r.you));
    const r1 = lb.submit('glass-breaker', { score: 5000, combo: 4 });
    assert.equal(r1.isBest, true);
    assert.equal(r1.previousBest, null);
    assert.equal(r1.rank, 4, 'between the rivals');
    const r2 = lb.submit('glass-breaker', { score: 3000 });
    assert.equal(r2.isBest, false);
    assert.equal(r2.previousBest, 5000);
    assert.equal(lb.best('glass-breaker'), 5000);
    assert.ok(lb.board('glass-breaker').some((r) => r.you && r.score === 5000));
    const again = createLeaderboards({ storage: st });
    assert.equal(again.best('glass-breaker'), 5000);
    assert.ok(st.map.has(ARCADE_KEY));
    const day = createLeaderboards({ storage: st }).submit('daily:2026-10-04', { score: 1200 });
    assert.equal(day.rank, 1, 'a daily board has no rivals');
    const broken = createLeaderboards({ storage: { getItem: () => '{bad', setItem: () => { throw new Error('quota'); } } });
    assert.equal(broken.submit('volley-wall', { score: 10 }).score, 10);
  });

  test('walls after the legal bounce carry their contact point (Glass Breaker)', () => {
    const ev = (type, t, x, y, z, o = {}) => ({ type, t, pos: { x, y, z }, side: z >= 0 ? 'near' : 'far', surface: o.surface ?? 'turf', wall: o.wall ?? null });
    const info = shotOutcomeInfo([ev('bounce', 2.0, -1, 0, -8), ev('wall', 2.3, -1.2, 1.1, -10, { surface: 'glass', wall: 'back' })], 1.5, null);
    assert.equal(info.legal, true);
    assert.deepEqual(info.walls[0].pos, { x: -1.2, y: 1.1, z: -10 });
    assert.equal(info.landingT, 2.0);
  });
});

describe('arcade challenges through the real pipeline', () => {
  test('Por Tres Party: smashes por tres, combos multiply, the clock ends it, the summary adds up', () => {
    const { mode, ev, summary, world, t0 } = runChallenge('por-tres-party');
    assert.ok(mode.isFinished());
    assert.equal((ev['challenge:end'] || []).length, 1, 'ends once');
    assert.ok(world.time - t0 >= 75 && world.time - t0 < 75 + 2.5 + 10, `ends after the 75 s clock (${(world.time - t0).toFixed(1)})`);
    const scores = ev['challenge:score'] || [];
    assert.equal(scores.reduce((a, s) => a + s.points, 0), summary.score, 'score = sum of awards');
    assert.ok(summary.porTres >= 3, `por tres / cuatro ${summary.porTres}`);
    assert.ok(summary.maxCombo >= 3 && scores.some((s) => s.mult >= 2), 'combos multiply');
    for (const s of scores) assert.equal(s.points, Math.round(s.base * s.mult * (s.perfect ? 1.5 : 1)));
    assert.ok(scores.some((s) => s.label === '¡Por tres!' && s.base === 1000));
    assert.ok((ev['challenge:combo'] || []).length >= 1);
    const hud = mode.hud(world);
    assert.equal(hud.challenge.timeLeft, 0);
    assert.equal(hud.points, summary.score);
  });

  test('Glass Breaker: targets on the far back glass shatter only after a legal bounce; new ones light up', () => {
    const { ev, summary } = runChallenge('glass-breaker', { profile: 'human', seed: 9 });
    const hits = ev['challenge:target-hit'] || [];
    assert.ok(summary.shattered >= 3, `shattered ${summary.shattered}`);
    assert.equal(hits.length, summary.shattered);
    for (const h of hits) {
      assert.ok(h.pos && Math.abs(h.pos.z + 10) < 0.1, 'on the far back glass');
      assert.ok(h.points >= 300);
    }
    const sets = ev['challenge:targets'] || [];
    assert.ok(sets.length >= hits.length, 'a new target after each shattered one');
    assert.ok(sets.every((s) => s.targets.length === 3));
    // Every target hit came from a ruled-legal shot.
    const results = ev['shot:result'] || [];
    assert.ok(results.filter((r) => r.points >= 300).every((r) => r.legal && r.success));
    assert.ok(summary.hits >= 10, `balls hit ${summary.hits}`);
  });

  test('Rally Marathon: returns score by rally level, the coach speeds up, lives run out or the clock ends it', () => {
    let maxPace = 1;
    const { mode, ev, summary } = runChallenge('rally-marathon', {
      profile: 'human', seed: 7,
      onTick: (w, m) => { if (m.coach) maxPace = Math.max(maxPace, m.coach.pace); },
    });
    assert.ok(mode.isFinished());
    assert.ok(summary.score > 200, `score ${summary.score}`);
    assert.ok(summary.longestRally >= 6, `longest rally ${summary.longestRally}`);
    const lost = (ev['rally:outcome'] || []).filter((o) => o.winner === 1).length;
    assert.equal(summary.lives, 3 - lost);
    const pts = (ev['challenge:score'] || []).filter((s) => s.kind === 'shot').map((s) => s.base);
    assert.ok(pts.includes(10) && pts.some((p) => p >= 20), 'deeper into a rally, each return is worth more');
    assert.ok(maxPace > 1.1 && maxPace <= 1.5, `the coach sped up to ×${maxPace.toFixed(2)} (capped at 1.5)`);
    assert.ok(mode.coach.pace >= 1 && mode.coach.pace <= 1.5);
  });

  test('Volley Wall: fast volleys, landed returns settle the rep at once, pace rises', () => {
    const { ev, summary } = runChallenge('volley-wall');
    const shots = ev['shot:result'] || [];
    assert.ok(shots.length >= 16, `balls ${shots.length}`);
    assert.ok(summary.score >= 3000, `score ${summary.score}`);
    assert.ok(summary.maxCombo >= 8);
    assert.equal(summary.challengeId, 'volley-wall');
  });

  test('daily challenge: the base challenge with the twist of the day (and its own board id)', () => {
    const d = dailyChallenge('2026-10-04');
    const m = createChallengeMode(d.id, { rng: createRng(1) });
    assert.equal(m.challenge.id, d.base);
    assert.equal(m.boardId, d.id);
    assert.equal(m.hud(null).challenge.duration, d.duration);
    assert.ok(m.hud(null).title.startsWith('Daily'));
  });
});

describe('achievements', () => {
  const shot = (o = {}) => ({ by: 'player', id: o.id ?? 1, stroke: 'forehand', speedOut: 20, spinRpm: { top: 800 }, ...o });
  test('earned once each, from real game events', () => {
    const have = new Set(['first-hit']);
    const tr = createAchievementTracker({ has: (id) => have.has(id) });
    const got = (type, p) => tr.onBus(type, p).map((a) => a.id);
    assert.deepEqual(got('ball:hit', { shot: shot() }), [], 'already earned before');
    assert.deepEqual(got('ball:hit', { shot: shot({ provisional: true, stroke: 'smash', speedOut: 40 }) }), [], 'provisional hits never count');
    assert.deepEqual(got('ball:hit', { shot: shot({ id: 2, stroke: 'smash', speedOut: 125 / 3.6 }) }), ['cannon']);
    assert.deepEqual(got('ball:hit', { shot: shot({ id: 3, spinRpm: { top: 2600 } }) }), ['heavy-topspin']);
    // 10 perfect volleys in a row; a late one restarts the count.
    let ids = [];
    for (let i = 0; i < 9; i++) ids = ids.concat(got('ball:hit', { shot: shot({ id: 10 + i, stroke: 'volley-fh', timingHit: { e: 0.01 } }) }));
    assert.ok(ids.includes('perfect-5'));
    got('ball:hit', { shot: shot({ id: 30, stroke: 'volley-bh', timingHit: { e: 0.2 } }) });
    for (let i = 0; i < 9; i++) assert.ok(!got('ball:hit', { shot: shot({ id: 40 + i, stroke: 'volley-bh', timingHit: { e: 0 } }) }).includes('perfect-volleys-10'));
    assert.deepEqual(got('ball:hit', { shot: shot({ id: 49, stroke: 'volley-fh', timingHit: { e: 0 } }) }), ['perfect-volleys-10']);
    assert.deepEqual(got('rally:outcome', { winner: 0, reason: 'por-tres', lastBy: 'player', rallyLength: 3 }), ['por-tres']);
    assert.deepEqual(got('rally:outcome', { winner: 0, reason: 'por-tres', lastBy: 'ai' }), [], 'the partner\'s por tres is not yours');
    assert.deepEqual(got('rally:outcome', { winner: 1, reason: 'double-bounce', rallyLength: 21 }), ['rally-10', 'rally-20']);
    assert.deepEqual(got('rally:outcome', { winner: 0, reason: 'net', cleanSheet: true, golden: true, rallyLength: 2 }), ['clean-sheet', 'golden-point']);
    // Back-glass master: 10 good returns off the glass.
    let out = [];
    for (let i = 0; i < 10; i++) {
      got('ball:hit', { shot: shot({ id: 100 + i, afterWall: true }) });
      out = out.concat(got('shot:result', { shotId: 100 + i, success: true }));
    }
    assert.deepEqual(out, ['back-glass-master']);
    assert.deepEqual(got('match:end', { summary: { winner: 0 } }), ['first-win']);
    assert.deepEqual(got('challenge:end', { summary: { score: 12000, shattered: 11 } }), ['arcade-ace', 'glass-smasher']);
    assert.deepEqual(got('drill:end', { summary: { stars: 3 } }), ['star-pupil']);
    assert.deepEqual(tr.onSession({ activeSeconds: 1300 }, { drillsPlayed: Array(13).fill('x'), streak: { days: 3 } }).map((a) => a.id), ['sweat', 'curriculum', 'habit']);
    assert.deepEqual(tr.onCareer({ eventWon: true, eventId: 'finals' }).map((a) => a.id), ['tour-champion']);
    assert.deepEqual(tr.onCareer({ eventWon: true, eventId: 'finals' }), [], 'once per session too');
  });

  test('catalogue: unique ids, XP, tiers, bilingual', () => {
    assert.equal(new Set(ACHIEVEMENTS.map((a) => a.id)).size, ACHIEVEMENTS.length);
    for (const a of ACHIEVEMENTS) {
      assert.ok(a.xp > 0 && ['bronze', 'silver', 'gold'].includes(a.tier) && a.es && a.descEs, a.id);
    }
    assert.ok(ACHIEVEMENT_BY_ID['perfect-volleys-10'] && ACHIEVEMENT_BY_ID['back-glass-master'] && ACHIEVEMENT_BY_ID['clean-sheet']);
  });
});

describe('automatic replays', () => {
  test('the director picks special moments by priority, spaces them out and drops stale ones', () => {
    const d = createReplayDirector({ minGap: 20 });
    const w = { time: 10 };
    d.onBus('ball:hit', { shot: { by: 'player', t: 9.2 } }, w);
    d.onBus('rally:outcome', { winner: 0, reason: 'double-bounce', lastBy: 'player', rallyLength: 4 }, w);
    assert.equal(d.pending.kind, 'winner');
    d.onBus('rally:outcome', { winner: 0, reason: 'por-tres', lastBy: 'player', rallyLength: 4 }, w);
    assert.equal(d.pending.kind, 'por-tres', 'higher priority wins');
    const m = d.take(w);
    assert.equal(m.kind, 'por-tres');
    assert.equal(m.t, 9.2);
    assert.deepEqual([...m.views], [...REPLAY_MOMENTS['por-tres'].views]);
    // Within minGap: dropped.
    w.time = 20;
    d.onBus('ball:hit', { shot: { by: 'player', t: 19.5 } }, w);
    d.onBus('rally:outcome', { winner: 0, reason: 'double-bounce', rallyLength: 22, lastBy: 'ai' }, w);
    assert.equal(d.pending.kind, 'long-rally');
    assert.equal(d.take(w), null, 'too soon after the last replay');
    // Stale: more than 5.5 s after the moment.
    w.time = 40;
    d.onBus('ball:hit', { shot: { by: 'player', t: 33 } }, w);
    d.onBus('challenge:target-hit', { id: 't1' }, w);
    assert.equal(d.take(w), null);
    // Perfect streak of 3.
    w.time = 60;
    d.onBus('ball:hit', { shot: { by: 'player', t: 59.5 } }, w);
    for (let i = 1; i <= 3; i++) d.onBus('challenge:perfect', { streak: i }, w);
    const p = d.take(w);
    assert.equal(p.kind, 'perfect');
    assert.ok(p.label.includes('×3'));
    // Provisional hits and the opponents' winners never trigger.
    const e = createReplayDirector({ minGap: 0 });
    e.onBus('ball:hit', { shot: { by: 'player', t: 1, provisional: true } }, w);
    e.onBus('rally:outcome', { winner: 1, reason: 'double-bounce', rallyLength: 3 }, w);
    assert.equal(e.pending, null);
    // QA r5: the opponents' long rallies, 15-shot rallies and partner winners never trigger.
    e.onBus('rally:outcome', { winner: 1, reason: 'double-bounce', rallyLength: 25 }, w);
    e.onBus('rally:outcome', { winner: 0, reason: 'double-bounce', rallyLength: 16, lastBy: 'ai' }, w);
    assert.equal(e.pending, null);
  });

  test('match replays: at most one per game, smash winners above long rallies (QA r5)', () => {
    const d = createReplayDirector({ minGap: 0, perGame: true });
    const w = { time: 10 };
    d.onBus('ball:hit', { shot: { by: 'player', t: 9.5, stroke: 'forehand' } }, w);
    d.onBus('rally:outcome', { winner: 0, reason: 'double-bounce', lastBy: 'player', rallyLength: 3 }, w);
    assert.equal(d.take(w).kind, 'winner');
    // The same game: nothing more, even a por tres.
    w.time = 20;
    d.onBus('ball:hit', { shot: { by: 'player', t: 19.5, stroke: 'smash' } }, w);
    d.onBus('rally:outcome', { winner: 0, reason: 'por-tres', lastBy: 'player', rallyLength: 5, gameWon: true }, w);
    assert.equal(d.pending, null, 'one replay per game');
    // Next game: a smash winner outranks a long rally in the same window.
    w.time = 30;
    d.onBus('ball:hit', { shot: { by: 'player', t: 29.6, stroke: 'smash' } }, w);
    d.onBus('rally:outcome', { winner: 0, reason: 'double-bounce', lastBy: 'player', rallyLength: 24 }, w);
    const m = d.take(w);
    assert.equal(m.kind, 'smash');
    assert.ok(REPLAY_MOMENTS.smash.priority > REPLAY_MOMENTS['long-rally'].priority);
  });

  test('a highlight clip ends shortly after its moment', () => {
    const rec = createRecorder({ seconds: 6, hz: 60 });
    const w = { time: 0, ball: null, player: { pos: { x: 0, z: 8 }, vel: { x: 0, z: 0 }, eye: { x: 0, y: 1.6, z: 8 }, height: 1.75, handed: 'right', racket: null }, ai: [], coach: null, machine: null };
    for (let i = 0; i < 300; i++) {
      w.time = i / 60;
      rec.record(w);
    }
    const snap = rec.snapshot();
    const p = createReplayPlayer(snap, { rate: 0.5, from: 1.0, to: 3.0 });
    assert.ok(Math.abs(p.duration - 2.0) < 1e-9);
    let steps = 0;
    while (p.step(1 / 60, 1) && steps < 1000) steps++;
    assert.ok(Math.abs(steps - 240) <= 2, `2 s of clip at half speed = 4 s (${steps} frames)`);
  });
});

describe('fitness recap', () => {
  test('swings from the tracking, active minutes and kcal', () => {
    const s = createSession();
    s.tick(60, { inPlay: true, realSpeed: 0.5 });
    s.tick(30, { inPlay: false });
    for (const v of [8, 12, 15]) s.swing(v);
    s.swing(MAX_SWING_SPEED * 6); // a tracking jump: a swing, not a 1,000 km/h one
    s.swing();
    const sum = s.summary();
    assert.equal(sum.swings, 5);
    assert.ok(Math.abs(sum.peakSwingKmh - 54) < 1e-9);
    assert.ok(Math.abs(sum.avgSwingKmh - (35 / 3) * 3.6) < 1e-9);
    assert.equal(sum.activeSeconds, 60);
    assert.equal(sum.sessionSeconds, 90);
    assert.ok(sum.kcal > 0);
  });
});

describe('rally / match shot log (results stroke table and landing map)', () => {
  test('a shot is in when the other side plays it or the point is won; out / net when the point is lost on it', () => {
    const s = createSession();
    const log = createRallyShotLog(s);
    const shot = (t, stroke) => ({ by: 'player', t, stroke, speedOut: 20, spinRpm: { total: 1500 }, quality: 0.8 });
    const ev = (type, t, extra = {}) => log.onBus('judge:event', { evt: { type, t, ...extra } });
    // 1. Drive, lands deep on the far side, the rival returns it: in, with its landing.
    log.onBus('ball:hit', { shot: shot(1, 'forehand') });
    ev('bounce', 1.6, { side: 'far', pos: { x: -2, y: 0, z: -8 } });
    log.onBus('judge:hit', { team: 1, t: 2 });
    // 2. Volley intercepted by the rival before any bounce: in, no landing.
    log.onBus('ball:hit', { shot: shot(3, 'volley-fh') });
    log.onBus('judge:hit', { team: 1, t: 3.4 });
    // 3. Into the net (bounces on the player's own side): point lost on it -> out.
    log.onBus('ball:hit', { shot: shot(5, 'backhand') });
    ev('bounce', 5.3, { side: 'near', pos: { x: 1, y: 0, z: 1 } });
    log.onOutcome({ winner: 1, reason: 'net', pointOver: true });
    // 4. A winner (double bounce on the far side): in.
    log.onBus('ball:hit', { shot: shot(7, 'smash') });
    ev('bounce', 7.5, { side: 'far', pos: { x: 2, y: 0, z: -5 } });
    ev('bounce', 7.9, { side: 'far', pos: { x: 2.4, y: 0, z: -7 } });
    log.onOutcome({ winner: 0, reason: 'double-bounce', pointOver: true });
    // 5. Long, straight into the back glass: lost -> out.
    log.onBus('ball:hit', { shot: shot(9, 'forehand') });
    ev('wall', 9.6, { side: 'far', wall: 'back', surface: 'glass' });
    log.onOutcome({ winner: 1, reason: 'wall-first', pointOver: true });
    // A serve fault is not a shot of the rally (nothing pending): no record.
    log.onOutcome({ winner: null, reason: 'serve-fault', pointOver: false });
    const sum = s.summary();
    assert.equal(sum.shots, 5);
    assert.equal(sum.byStroke.forehand.count, 2);
    assert.equal(sum.byStroke.forehand.successRate, 0.5);
    assert.equal(sum.byStroke['volley-fh'].successRate, 1);
    assert.equal(sum.byStroke.backhand.successRate, 0);
    assert.equal(sum.byStroke.smash.successRate, 1);
    assert.equal(sum.landings.length, 2, 'landings only for legal bounces on the far side');
    assert.ok(Math.abs(sum.successRate - 3 / 5) < 1e-9);
  });
});
