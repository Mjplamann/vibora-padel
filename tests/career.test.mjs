// Round 4 (game design): progression (XP, levels, unlocks, trophies, streak), the Circuito Víbora
// career (ladder, knockout rounds, resumable matches), AI personalities, partner callouts, racket
// profiles, and a career run end to end: simulated matches finish and XP / unlocks persist.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createRng } from '../src/util/math.js';
import { Vec3 } from '../src/util/vec3.js';
import { createWorld, stepWorld, resolveSettings } from '../src/game/world.js';
import { createMatchMode } from '../src/game/modes.js';
import { createMatch } from '../src/rules/scoring.js';
import { tunedLevel, PERSONALITIES, COACH_LEVELS, createCoach } from '../src/game/coach.js';
import {
  createProgress, xpForLevel, levelOf, xpForSession, RACKETS, OUTFITS, racketById, PROFILE_KEY, unlockMet,
} from '../src/game/progression.js';
import { createCareer, EVENTS, EVENT_BY_ID, PAIRS, PLAYERS, PARTNERS, matchSpec, CAREER_KEY, playerCard } from '../src/game/career.js';
import { CALL_GAP } from '../src/game/callouts.js';
import { racketImpact, setRacketProfile, makeRacketProfile, racketProfile } from '../src/physics/racket.js';
import { createGame, STEP } from '../src/app/game.js';

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

describe('progression', () => {
  test('XP curve rises, levels map back, titles and awards are sane', () => {
    let prev = -1;
    for (let l = 1; l <= 50; l++) {
      const x = xpForLevel(l);
      assert.ok(x > prev, `level ${l}`);
      prev = x;
      assert.equal(levelOf(x).level, l);
      if (l > 1) assert.equal(levelOf(x - 1).level, l - 1);
    }
    assert.equal(xpForLevel(1), 0);
    const drill = xpForSession({ kind: 'drill', stars: 3, points: 1600, activeSeconds: 300 });
    const lazy = xpForSession({ kind: 'drill', stars: 0, points: 0, activeSeconds: 30 });
    assert.ok(drill.xp > lazy.xp && drill.parts.length >= 3);
    const won = xpForSession({ kind: 'match', won: true, gamesWon: 4, career: { eventWon: true, tier: 3 } });
    const lost = xpForSession({ kind: 'match', won: false, gamesWon: 1 });
    assert.ok(won.xp > lost.xp + 500, `tournament win is worth more (${won.xp} vs ${lost.xp})`);
    // A few good sessions take you to level 3 (the first new racket), not one.
    assert.ok(drill.xp < xpForLevel(3) && 4 * drill.xp > xpForLevel(3));
  });

  test('level-ups unlock rackets and outfits; trophies unlock the rest; equips and saves persist', () => {
    const st = memStorage();
    let now = Date.parse('2026-10-01T10:00:00');
    const p = createProgress({ storage: st, now: () => now });
    assert.equal(p.data.racket, 'fang');
    assert.equal(p.equip('racket', 'orbit'), false, 'locked racket cannot be equipped');
    const r = p.addXp(xpForLevel(3) + 10);
    assert.deepEqual(r.levelUps, [2, 3]);
    assert.ok(r.unlocks.some((u) => u.id === 'orbit'), 'Orbit Round unlocks at level 3');
    assert.ok(r.unlocks.some((u) => u.id === 'court'), 'Court blue outfit at level 2');
    assert.equal(p.equip('racket', 'orbit'), true);
    assert.ok(p.isNew('racket', 'orbit'));
    p.markSeen();
    assert.ok(!p.isNew('racket', 'orbit'));
    // Trophy unlocks: Cobra Diamond for winning the Regional Open (a final loss is not enough).
    assert.ok(!p.awardTrophy('regional', 2).unlocks.some((u) => u.id === 'cobra'));
    assert.ok(p.awardTrophy('regional', 1).unlocks.some((u) => u.id === 'cobra'));
    assert.equal(p.awardTrophy('regional', 3).isNew, false, 'keeps the best place');
    assert.equal(p.unlockAchievement('por-tres'), true);
    assert.equal(p.unlockAchievement('por-tres'), false, 'once');
    // Daily streak: consecutive days count, a gap restarts it.
    assert.equal(p.recordSession({ activeSeconds: 600, kcal: 80, swings: 120 }).streak, 1);
    now += 86400000;
    assert.equal(p.recordSession({ activeSeconds: 300 }).streak, 2);
    now += 3 * 86400000;
    assert.equal(p.recordSession({}).streak, 1);
    assert.equal(p.data.streak.best, 2);
    // Reload from storage.
    const q = createProgress({ storage: st, now: () => now });
    assert.equal(q.data.racket, 'orbit');
    assert.equal(q.level.level, 3);
    assert.ok(q.isUnlocked('racket', 'cobra'));
    assert.equal(q.data.trophies.regional.place, 1);
    assert.ok(q.data.achievements['por-tres']);
    assert.equal(q.data.lifetime.sessions, 3);
    assert.equal(q.data.lifetime.swings, 120);
  });

  test('corrupt or hostile storage never breaks the profile', () => {
    const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
    const p = createProgress({ storage: bad });
    assert.equal(p.addXp(500).gained, 500);
    const junk = memStorage();
    junk.setItem(PROFILE_KEY, '{"xp": -5, "racket": "nope", "unlocked": {"rackets": ["mamba", "x"]}, "trophies": 4}');
    const q = createProgress({ storage: junk });
    assert.equal(q.data.xp, 0);
    assert.equal(q.data.racket, 'fang');
    assert.deepEqual(q.data.unlocked.rackets.sort(), ['fang', 'mamba']);
    assert.deepEqual(q.data.trophies, {});
    junk.setItem(PROFILE_KEY, 'not json');
    assert.equal(createProgress({ storage: junk }).data.xp, 0);
  });

  test('every racket and outfit has a reachable unlock rule', () => {
    const trophyIds = new Set(EVENTS.map((e) => e.id));
    for (const r of [...RACKETS, ...OUTFITS]) {
      if (r.unlock.trophy) assert.ok(trophyIds.has(r.unlock.trophy), r.id);
      else assert.ok(r.unlock.level >= 1 && r.unlock.level <= 50, r.id);
    }
    const p = { xp: xpForLevel(50), trophies: Object.fromEntries(EVENTS.map((e) => [e.id, { place: 1 }])), achievements: {} };
    for (const r of [...RACKETS, ...OUTFITS]) assert.ok(unlockMet(r.unlock, p), r.id);
  });
});

describe('racket profiles', () => {
  const hit = (off, profile) => {
    setRacketProfile(profile);
    const ball = { pos: new Vec3(off, 1, 0.04), vel: new Vec3(0, 0, -15), spin: new Vec3(), atRest: false };
    const pose = { grip: new Vec3(0, 1 - 0.235, 0), axis: new Vec3(0, 1, 0), normal: new Vec3(0, 0, 1), vel: new Vec3(0, 0, 15) };
    return racketImpact(ball, pose, { local: { x: off, y: 0.235 }, face: 'front' }).speedOut * 3.6;
  };
  test('power vs sweet-spot trade-offs: the diamond hits hardest, the round forgives off-centre hits', () => {
    const P = Object.fromEntries(RACKETS.map((r) => [r.id, makeRacketProfile(r)]));
    const base = hit(0, null);
    assert.ok(base > 95 && base < 103, `starter racket at the sweet spot ${base}`);
    assert.ok(Math.abs(hit(0, P.fang) - base) < 1e-9, 'the starter racket is the config racket');
    assert.ok(hit(0, P.cobra) > hit(0, P.fang) + 3, 'diamond: more power in the sweet spot');
    assert.ok(hit(0, P.orbit) < hit(0, P.fang), 'round: less power');
    const drop = (id) => hit(0, P[id]) - hit(0.1, P[id]);
    assert.ok(drop('orbit') < drop('fang') && drop('fang') < drop('cobra'), 'sweet-spot size: round > teardrop > diamond');
    assert.ok(P.grit.mu > P.fang.mu, 'rough face grips more');
    setRacketProfile(null);
    assert.equal(racketProfile().id, 'base');
    assert.equal(makeRacketProfile({ physics: { apparentCOR: 9, mu: -1 } }).apparentCOR, 0.55, 'clamped to physical bounds');
  });

  test('createGame applies the equipped racket for the session', () => {
    const g = createGame({ spec: { kind: 'rally', level: 'club' }, settings: { ...resolveSettings({}), racketModel: 'cobra' }, input: 'fallback', fallback: null, seed: 3, attract: true });
    assert.equal(racketProfile().id, 'cobra');
    g.dispose();
    createGame({ spec: { kind: 'rally' }, settings: resolveSettings({}), input: 'fallback', fallback: null, seed: 3, attract: true }).dispose();
    assert.equal(racketProfile().id, 'fang');
    assert.equal(racketById('nope').id, 'fang');
  });
});

describe('personalities', () => {
  test('tuned levels: the default keeps the level preset; each personality changes the brain', () => {
    const base = tunedLevel('club');
    for (const k of ['lob', 'chiquita', 'kill', 'smash', 'err', 'sigma', 'maxSpeed']) assert.equal(base[k], COACH_LEVELS.club[k], k);
    assert.deepEqual(base.kmh, [...COACH_LEVELS.club.kmh]);
    assert.ok(tunedLevel('club', 'lobber').lob > base.lob && tunedLevel('club', 'lobber').lobBack > 0);
    assert.ok(tunedLevel('club', 'big-hitter').kmh[1] > base.kmh[1] && tunedLevel('club', 'big-hitter').err > base.err);
    assert.ok(tunedLevel('club', 'wall-master').glass > 0.6 && tunedLevel('club', 'wall-master').glassSkill > 0);
    assert.ok(tunedLevel('club', 'net-rusher').netRush > 0.5);
    assert.ok(tunedLevel('club', 'chiquita').chiquita > base.chiquita);
    assert.ok(tunedLevel('club', null, 1.3).kmh[0] > base.kmh[0] * 1.29, 'pace factor (rally marathon)');
    const c = createCoach({ level: 'pro', personality: 'lobber', displayName: 'Toni', kit: { shirt: '#c9302c' } });
    assert.equal(c.state.personality, 'lobber');
    assert.equal(c.state.displayName, 'Toni');
    c.setPace(1.2);
    assert.ok(Math.abs(c.pace - 1.2) < 1e-9);
    for (const id of Object.keys(PERSONALITIES)) assert.ok(PERSONALITIES[id].desc.length > 20, id);
  });

  test('a lobber pair lobs more and a wall master plays to the glass more than all-rounders (same seeds)', () => {
    const run = (pers) => {
      const w = createWorld({ rng: createRng(4) });
      const opp = [{ name: 'A', personality: pers }, { name: 'B', personality: pers }];
      const mode = createMatchMode({ level: 'club', games: 2, rng: createRng(9), autoPlayer: true, opponents: opp, callouts: false });
      w.mode = mode;
      mode.start(w);
      let n = 0;
      while (!mode.isFinished() && n++ < 240 * 900) stepWorld(w, 1 / 240);
      const far = w.shots.filter((s) => s.team === 1 && !s.isServe);
      const share = (k) => far.filter((s) => s.choice === k).length / Math.max(1, far.length);
      const drives = far.filter((s) => s.choice === 'drive');
      // Drives aimed at the back glass (8.4-9 m deep): the player practises salida de pared.
      const deep = drives.filter((s) => s.aim && s.aim.z > 8.3).length / Math.max(1, drives.length);
      return { lobs: share('lob'), chiq: share('chiquita'), deep, n: far.length };
    };
    const ar = run('all-rounder');
    const lob = run('lobber');
    const wall = run('wall-master');
    const chiq = run('chiquita');
    assert.ok(ar.n > 20 && lob.n > 20 && wall.n > 20 && chiq.n > 20, JSON.stringify({ ar, lob, wall, chiq }));
    assert.ok(lob.lobs > ar.lobs + 0.08, `lobs ${lob.lobs.toFixed(2)} vs ${ar.lobs.toFixed(2)}`);
    assert.ok(wall.deep > ar.deep + 0.12, `to the glass ${wall.deep.toFixed(2)} vs ${ar.deep.toFixed(2)}`);
    assert.ok(chiq.chiq > ar.chiq + 0.15, `chiquitas ${chiq.chiq.toFixed(2)} vs ${ar.chiq.toFixed(2)}`);
  });
});

describe('career', () => {
  test('the ladder opens one event at a time; knockout rounds; places; persistence', () => {
    const st = memStorage();
    const c = createCareer({ storage: st, now: () => 1 });
    assert.equal(EVENTS.length, 8);
    assert.equal(c.events()[0].status, 'open');
    assert.ok(c.events().slice(1).every((e) => e.status === 'locked'));
    assert.equal(c.startEvent('liga'), null, 'locked');
    const spec = c.startEvent('club-open');
    assert.equal(spec.kind, 'match');
    assert.equal(spec.venue, 'club');
    assert.equal(spec.opponents.length, 2);
    assert.ok(spec.opponents.every((o) => PERSONALITIES[o.personality]));
    assert.equal(spec.partner.id, 'lucia');
    assert.equal(spec.teamNames[1][1], PAIRS.vecinos.name);
    const r = c.recordMatch({ won: true });
    assert.equal(r.eventDone, true);
    assert.equal(r.place, 1);
    assert.equal(r.unlockedEvent, 'liga');
    assert.equal(c.events()[1].status, 'open');
    // Two rounds: win the semi, lose the final -> finalist (2).
    c.startEvent('liga');
    const semi = c.recordMatch({ won: true });
    assert.equal(semi.eventDone, false);
    assert.equal(semi.nextRound, 'Final');
    assert.equal(semi.nextMatch.career.matchIndex, 1);
    assert.equal(c.events()[1].status, 'in-progress');
    const fin = c.recordMatch({ won: false });
    assert.equal(fin.place, 2);
    assert.equal(fin.unlockedEvent, null);
    assert.equal(c.events()[1].status, 'retry');
    assert.equal(c.events()[2].status, 'locked');
    // Three rounds: losing the quarterfinal = place 4.
    for (const id of ['liga', 'atardecer', 'regional']) {
      c.startEvent(id);
      while (c.active) c.recordMatch({ won: true });
    }
    c.startEvent('copa-costa');
    assert.equal(c.recordMatch({ won: false }).place, 4);
    assert.equal(c.setPartner('nico'), true);
    assert.equal(c.setPartner('nobody'), false);
    const d = createCareer({ storage: st });
    assert.equal(d.partner, 'nico');
    assert.equal(d.events().find((e) => e.id === 'regional').status, 'won');
    assert.equal(d.trophies().length, 5);
    assert.ok(st.map.has(CAREER_KEY));
  });

  test('every event has named pairs with personalities and a venue; partners are distinct personalities', () => {
    for (const e of EVENTS) {
      assert.ok(['club', 'sunset', 'stadium'].includes(e.venue), e.id);
      assert.ok(e.matches.length >= 1 && e.matches.length <= 3, e.id);
      for (const m of e.matches) {
        const pair = PAIRS[m.pair];
        assert.ok(pair && pair.players.every((id) => PLAYERS[id] && PERSONALITIES[PLAYERS[id].personality]), `${e.id} ${m.pair}`);
      }
    }
    assert.equal(new Set(EVENTS.map((e) => e.venue)).size, 3, 'all three venues');
    assert.equal(new Set(PARTNERS.map((id) => PLAYERS[id].personality)).size, PARTNERS.length);
    assert.ok(playerCard('toni').personalityInfo.name === 'Lobber');
    assert.equal(EVENT_BY_ID.finals.level, 'pro');
  });

  test('a match is resumable mid-event: saved point winners replay into the same score', () => {
    const st = memStorage();
    const c = createCareer({ storage: st });
    c.startEvent('club-open');
    const winners = [0, 0, 1, 0, 0, 1, 1, 0, 1, 0];
    c.saveMidMatch(winners);
    const c2 = createCareer({ storage: st });
    const spec = c2.startEvent('club-open');
    assert.deepEqual(spec.resume.points, winners);
    const w = createWorld({ rng: createRng(2) });
    const mode = createMatchMode({ level: spec.level, games: spec.games, rng: createRng(3), opponents: spec.opponents, partner: spec.partner, teamNames: spec.teamNames, resume: spec.resume });
    w.mode = mode;
    mode.start(w);
    const ref = createMatch({ gamesPerSet: spec.games, setsToWin: 1, goldenPoint: true, tiebreakAt: spec.games, firstServer: { team: 1, player: 0 } });
    for (const x of winners) ref.pointWonBy(x);
    assert.deepEqual(mode.match.display().games, ref.display().games);
    assert.deepEqual(mode.match.display().points, ref.display().points);
    assert.deepEqual(mode.match.server(), ref.server(), 'server rotation resumes too');
    assert.equal(mode.state.resumed, winners.length);
    assert.deepEqual(mode.hud(w).score.names, spec.teamNames);
    // A saved match that was already won (quit during its results) ends at once with its summary.
    const w2 = createWorld({ rng: createRng(2) });
    const done = createMatchMode({ level: 'rookie', games: 2, rng: createRng(3), resume: { points: Array(8).fill(0) } });
    w2.mode = done;
    done.start(w2);
    const ends = [];
    w2.bus.on('match:end', (p) => ends.push(p));
    stepWorld(w2, 1 / 240);
    assert.ok(done.isFinished());
    assert.equal(ends.length, 1);
    assert.equal(ends[0].summary.winner, 0);
  });
});

describe('partner callouts', () => {
  test('a match with a partner produces real padel calls, rate-limited, with who and a translation', () => {
    const spec = matchSpec('club-open', 0, 'nico');
    const w = createWorld({ rng: createRng(3) });
    const mode = createMatchMode({ level: 'club', games: 2, rng: createRng(9), autoPlayer: true, opponents: spec.opponents, partner: spec.partner, teamNames: spec.teamNames });
    w.mode = mode;
    mode.start(w);
    const calls = [];
    const points = [];
    w.bus.on('partner:call', (c) => calls.push(c));
    w.bus.on('rally:outcome', (o) => { if (o.score) points.push(o); });
    let n = 0;
    while (!mode.isFinished() && n++ < 240 * 900) stepWorld(w, 1 / 240);
    assert.ok(mode.isFinished());
    assert.ok(calls.length >= points.length * 0.8, `${calls.length} calls in ${points.length} points`);
    assert.ok(calls.length <= points.length * 5, 'not chattering');
    for (let i = 1; i < calls.length; i++) assert.ok(calls[i].at - calls[i - 1].at >= CALL_GAP - 1e-9, 'rate limited');
    // audio/umpire.js voices { es, en } in the umpire language: the court's Spanish is always there.
    assert.ok(calls.every((c) => c.who === 'Nico' && c.text && c.en && c.es === c.text));
    const kinds = new Set(calls.map((c) => c.kind));
    assert.ok(kinds.has('mine') || kinds.has('yours'), [...kinds].join());
    assert.ok([...kinds].some((k) => ['vamos', 'great', 'game', 'calm', 'sorry', 'theirs'].includes(k)), 'calls after points');
    const golden = points.findIndex((o, i) => i > 0 && points[i - 1].score.points[0] === '40' && points[i - 1].score.points[1] === '40');
    if (golden >= 0) assert.ok(kinds.has('golden'), 'golden point called');
    // Moods for the renderer after each point.
    assert.ok(['celebrate', 'dejected'].includes(mode.actors.partner.state.mood.kind));
  });
});

describe('career end to end', () => {
  test('the precise autopilot plays career matches through the real pipeline; XP, trophies and unlocks persist', () => {
    const st = memStorage();
    const settings = resolveSettings({ assist: 'club' });
    let career = createCareer({ storage: st });
    let prog = createProgress({ storage: st });
    const played = [];
    let seed = 41;
    // Club Open (1 match) and the Liga Social (semi + final), one-game matches (?quick=1).
    for (const evId of ['club-open', 'liga']) {
      let guard = 0;
      while (guard++ < 6) {
        const spec = career.startEvent(evId, { quick: true });
        assert.ok(spec, `${evId} open`);
        const g = createGame({ spec, settings, input: 'autopilot', storage: st, seed: seed++, startTime: 0 });
        let t = g.world.time;
        while (!g.isFinished() && g.world.time < t + 900) {
          g.advanceTo(g.world.time + 1);
        }
        assert.ok(g.isFinished(), `${evId} match finished (${g.world.time.toFixed(0)} s)`);
        const sum = g.mode.summary(g.world);
        const won = sum.winner === 0;
        const ses = g.session.summary();
        assert.ok(g.stats.playerHits >= 1, 'the autopilot hit the ball');
        const res = career.recordMatch({ won, score: sum.score });
        if (res.eventDone) prog.awardTrophy(res.eventId, res.place);
        prog.recordSession({ activeSeconds: ses.activeSeconds, kcal: ses.kcal, swings: ses.swings || g.stats.playerHits, shots: g.stats.playerHits });
        prog.addXp(xpForSession({ kind: 'match', won, gamesWon: sum.score.games[0], activeSeconds: ses.activeSeconds, career: res.eventDone ? { eventWon: res.eventWon, tier: EVENT_BY_ID[evId].tier } : null }).xp);
        played.push({ evId, won, games: sum.score.games, place: res.place });
        g.dispose();
        if (res.eventDone && res.eventWon) break;
      }
    }
    // Reload everything from storage: the progress is there.
    career = createCareer({ storage: st });
    prog = createProgress({ storage: st });
    assert.ok(played.length >= 3, JSON.stringify(played));
    assert.ok(prog.data.xp > 500, `xp ${prog.data.xp}`);
    assert.ok(prog.data.lifetime.sessions === played.length);
    assert.ok(prog.data.lifetime.shots > 0);
    const evs = career.events();
    const wonAny = played.some((p) => p.won);
    assert.ok(wonAny, `won at least one match: ${JSON.stringify(played)}`);
    if (prog.data.trophies['club-open'] && prog.data.trophies['club-open'].place === 1) assert.equal(evs[1].status === 'locked', false);
    assert.ok(prog.level.level >= 2, `level ${prog.level.level}`);
    assert.ok(prog.isUnlocked('outfit', 'court'), 'level 2 outfit unlocked and saved');
    console.log('[career e2e]', JSON.stringify({ played, xp: prog.data.xp, level: prog.level.level, trophies: prog.data.trophies }));
  });
});
