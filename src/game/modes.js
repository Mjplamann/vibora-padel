// Mode controllers (SPEC §5.6): drills (ball machine + neutral-feed referee + drill
// scoring), rally with the coach, and 2v2 matches with real scoring and serves.
// World forwards every bus emission to mode.onBus(type, payload, world); judged physics
// (after the lag-compensation window) arrives as 'judge:event' | 'judge:hit' | 'judge:launch'.
// Pure module.

import { v3 } from '../util/vec3.js';
import { createRng } from '../util/math.js';
import { PLAYER } from '../config.js';
import { createReferee, OUTCOME_LABELS } from '../rules/referee.js';
import { createMatch } from '../rules/scoring.js';
import { createMachine } from './machine.js';
import { createCoach } from './coach.js';
import { DRILL_BY_ID, mirrorDrill, scoreShot, starsFor, noteEs } from './drills.js';
import { launchBall, emit } from './world.js';
import { createTacticalHome } from './tactics.js';

const BANNER_S = 1.8;
const REP_TIMEOUT = 9; // s after a feed without any ruling
/** s after the player's stroke without any ruling (a lob lands and dies well inside this). */
export const HIT_TIMEOUT = 6;
/**
 * Feeds are event-driven: the next ball comes only once the current rep has been judged, plus
 * FEED_GAP (and the machine's HOLD_LEAD re-aim), with the drill interval as a lower bound
 * between launches. A drop (serve drill) waits DROP_GAP after the ruling.
 */
export const FEED_GAP = 0.4;
export const DROP_GAP = 1.0;

const kmh = (v) => Math.round(v * 3.6);

function lastShotHud(shot, notes = []) {
  if (!shot) return null;
  return {
    stroke: shot.stroke,
    speedKmh: kmh(shot.speedOut),
    spinRpm: Math.round(Math.abs(shot.spinRpm?.total ?? 0)),
    topRpm: Math.round(shot.spinRpm?.top ?? 0),
    netClearance: shot.netClearance,
    quality: shot.quality,
    timing: shot.timing,
    spacing: shot.spacing,
    notes,
  };
}

/** A motionless actor for the renderer (opponents standing at the net in some drills). */
export function createStaticActor({ pos, facing = 0, handed = 'right', name = null }) {
  const state = { pos: v3(pos.x, 0, pos.z), vel: v3(), facing, stroke: null, swingPhase: 0, swingT: 0, holding: 'ready', handed, name };
  return { update() {}, get state() { return state; }, static: true };
}

/**
 * Builds the outcome information for one shot from the judged events after it.
 * events: judged physics events (with t); hitT: contact time; outcome: referee outcome|null.
 */
export function shotOutcomeInfo(events, hitT, outcome, { team = 0, feed = null } = {}) {
  const oppSide = team === 0 ? 'far' : 'near';
  let landing = null, landT = Infinity, illegalBefore = false;
  let sideGlass = false, backGlass = false, exitVia = null;
  const walls = [];
  for (const e of events) {
    if (e.t < hitT - 1e-9) continue;
    if (landing === null) {
      if (e.type === 'bounce' && e.side === oppSide) {
        landing = { x: e.pos.x, z: e.pos.z };
        landT = e.t;
      } else if ((e.type === 'wall' && e.side === oppSide) || e.type === 'exit' || e.type === 'outside-bounce' || e.type === 'ceiling'
        || (e.type === 'bounce' && e.side !== oppSide)) {
        illegalBefore = true;
        break;
      }
      continue;
    }
    if (e.type === 'wall') {
      walls.push({ surface: e.surface, wall: e.wall, side: e.side, t: e.t });
      if (e.wall === 'side' && e.surface === 'glass' && e.side === oppSide) sideGlass = true;
      if (e.wall === 'back' && e.surface === 'glass' && e.side === oppSide) backGlass = true;
    } else if (e.type === 'exit' && exitVia === null) exitVia = e.via || null;
    else if (e.type === 'bounce' && e.t > landT) break;
  }
  const lost = outcome && outcome.winner !== null && outcome.winner !== team && outcome.pointOver !== false;
  const fault = outcome && (outcome.reason === 'serve-fault' || outcome.reason === 'double-fault' || outcome.reason === 'let');
  const legal = !!landing && !illegalBefore && !lost && !fault;
  return {
    outcome: outcome || null,
    reason: outcome ? outcome.reason : null,
    detail: outcome ? outcome.detail : null,
    winner: outcome ? outcome.winner : null,
    legal,
    landing,
    walls,
    sideGlassAfterBounce: legal && sideGlass,
    backGlassAfterBounce: legal && backGlass,
    exitVia: legal ? exitVia : null,
    feed,
  };
}

// ---------------------------------------------------------------------------
// Drill mode

/**
 * @param drill DrillDef (right-handed; mirrored at start for a left-hander) or a drill id
 * @param opts { rng?, session?, startDelay = 2, machineSigma?, reps? }
 */
export function createDrillMode(drill, opts = {}) {
  const base = typeof drill === 'string' ? DRILL_BY_ID[drill] : drill;
  const rng = opts.rng || createRng(0xd1d1);
  const session = opts.session || null;
  const startDelay = opts.startDelay ?? 2.0;
  let d = base;
  let reps = opts.reps ?? base.reps;
  let referee = null;
  let machine = null;
  let rep = null;
  let launched = 0;
  let dropAt = Infinity;
  let lastLaunchT = -Infinity;
  let lastResolveT = -Infinity;
  const st = {
    points: 0, streak: 0, bestStreak: 0, results: [], lastShot: null, lastNotes: [], banner: null, bannerUntil: 0,
    finished: false, ended: false, hits: 0, successes: 0, counted: 0, opened: 0,
  };
  const tactics = createTacticalHome();

  const isServeDrill = () => d.serving && d.serving.team === 0;

  function setBanner(world, text, kind) {
    st.banner = { text, kind };
    st.bannerUntil = world.time + BANNER_S;
  }

  function start(world) {
    const handed = world.settings.handed || 'right';
    d = handed === 'left' && base.mirrorForLefty && !base.mirrored ? mirrorDrill(base) : base;
    tactics.setBase(world, d.home);
    referee = createReferee({ serving: d.serving || null, feedIsNeutral: !d.serving, onOutcome: (o) => onOutcome(world, o) });
    world.referee = referee;
    world.coach = null;
    world.ai = (d.opponentsAtNet && d.opponents ? d.opponents : []).map((p) => createStaticActor({ pos: p, facing: 0 }));
    if (isServeDrill()) {
      world.machine = null;
      dropAt = world.time + startDelay;
    } else {
      machine = createMachine({ pos: v3(0, 1.0, -9.2), rng: createRng((rng() * 2 ** 32) >>> 0), landingSigma: opts.machineSigma });
      machine.load((i, w) => d.feeds(i, rng, { home: d.home, world: w, player: w.player.pos }), { interval: d.interval, count: reps, startDelay });
      machine.gate = (w) => feedGateOpen(w, FEED_GAP);
      world.machine = machine;
    }
    emit(world, 'coach:cue', { text: d.cues.intro, es: d.cues.introEs, priority: 2 });
  }

  function dropBall(world) {
    const f = d.feeds(launched, rng, { home: d.home, world, player: world.player.pos });
    const p = world.player.pos;
    const k = (world.settings.height || PLAYER.defaultHeight) / PLAYER.defaultHeight;
    const at = f.at || { dx: 0.62, dz: -0.36 };
    const pos = v3(p.x + at.dx * k, f.height ?? 1.0, p.z + at.dz * k);
    pendingFeed = f;
    launchBall(world, { pos, vel: v3(0, -0.2, 0), spin: v3(), by: 'drop' });
  }
  let pendingFeed = null;

  /** No rep open or waiting for its launch to be judged, and `gap` s since the last ruling. */
  function feedGateOpen(world, gap) {
    if (rep) return false;
    const launchedCount = isServeDrill() ? launched : machine ? machine.state.fed : 0;
    if (launchedCount > st.opened) return false;
    return world.time - lastResolveT >= gap;
  }

  function update(world, dt) {
    tactics.update(world, dt);
    if (isServeDrill() && launched < reps && world.time >= dropAt && feedGateOpen(world, DROP_GAP)) {
      launched++;
      dropBall(world);
      dropAt = world.time + d.interval;
    }
    if (rep && world.time - rep.launchT > Math.max(REP_TIMEOUT, d.interval + 3)) resolveRep(world, null);
    else if (rep && rep.hitT !== null && world.time - rep.hitT > HIT_TIMEOUT) resolveRep(world, null);
    // A dropped ball that was never served (the referee ignores it until the serve).
    else if (rep && !rep.shot && isServeDrill() && world.time - rep.launchT > d.interval + 0.5) resolveRep(world, null);
    if (st.banner && world.time > st.bannerUntil) st.banner = null;
    // Every rep has been launched AND judged (the launch reaches the mode after the judge delay).
    if (!st.finished && st.opened >= reps && !rep && world.time - lastLaunchT > 1.0) {
      st.finished = true;
      finish(world);
    }
  }

  function finish(world) {
    if (st.ended) return;
    st.ended = true;
    let best = null;
    if (session) best = session.saveBest(base.id, st.points);
    emit(world, 'drill:end', { summary: summary(world), best });
  }

  function openRep(world, by, t) {
    if (rep) resolveRep(world, null);
    const feed = by === 'drop' ? pendingFeed : machine && machine.lastFeed ? machine.lastFeed.feed : null;
    rep = { index: st.results.length, feed, launchT: t, shot: null, hitT: null, events: [], void: false };
    st.opened++;
    lastLaunchT = world.time;
    // The machine's serve in the return drill is a struck launch: its referee hit follows this launch.
    if (d.serving) referee.reset({ serving: d.serving });
    else referee.reset({ serving: null, feedIsNeutral: true });
  }

  function onBus(type, p, world) {
    switch (type) {
      case 'judge:launch':
        if (p.by === 'machine' || p.by === 'drop') openRep(world, p.by, p.t);
        break;
      case 'judge:hit':
        if (rep && p.team === 0 && !rep.shot) {
          rep.shot = p.shot;
          rep.hitT = p.t;
        }
        break;
      case 'judge:event':
        if (rep) rep.events.push(p.evt);
        break;
      case 'ball:hit':
        if (p.shot.by === 'player') {
          st.hits++;
          st.lastShot = p.shot;
          st.lastNotes = [];
        }
        break;
      default:
    }
  }

  function onOutcome(world, o) {
    if (!rep) return;
    if (o.reason === 'dead-feed') rep.void = true;
    if (d.serving && d.serving.team === 1 && !rep.shot && (o.reason === 'serve-fault' || o.reason === 'double-fault' || o.reason === 'let')) rep.void = true;
    resolveRep(world, o);
  }

  function resolveRep(world, outcome) {
    const r = rep;
    if (!r) return;
    rep = null;
    lastResolveT = world.time;
    const info = shotOutcomeInfo(r.events, r.hitT ?? Infinity, outcome, { team: 0, feed: r.feed });
    const ctx = { height: world.settings.height, hipHeight: world.player.body ? world.player.body.hipHeight : null, drill: d };
    let res;
    if (r.void) res = { points: 0, success: false, notes: ['No play – free rep'], zone: null };
    else res = scoreShot(d, r.shot, info, ctx);
    if (!r.void) {
      st.counted++;
      st.points += res.points;
      if (res.success) {
        st.successes++;
        st.streak++;
        st.bestStreak = Math.max(st.bestStreak, st.streak);
      } else st.streak = 0;
    }
    const entry = { index: r.index, shot: r.shot, landing: info.landing, legal: info.legal, reason: info.reason, void: r.void, ...res };
    st.results.push(entry);
    st.lastNotes = res.notes;
    if (session && r.shot) {
      session.record(r.shot, { success: res.success, points: res.points, landing: info.landing, rallyLength: 1, notes: res.notes });
    }
    if (outcome) emit(world, 'rally:outcome', { winner: outcome.winner, reason: outcome.reason, label: outcome.label, pos: outcome.pos });
    emit(world, 'shot:result', {
      shotId: r.shot ? r.shot.id : null, landing: info.landing, inTarget: !!res.zone && res.success, points: res.points,
      notes: res.notes, success: res.success, zone: res.zone, reason: info.reason, legal: info.legal,
    });
    emit(world, 'drill:rep', { index: r.index, total: reps, points: res.points, totalPoints: st.points, streak: st.streak });
    if (outcome && (outcome.reason === 'por-tres' || outcome.reason === 'por-cuatro')) setBanner(world, outcome.label, 'great');
    else if (res.points > 0) setBanner(world, `+${res.points}`, res.success ? 'good' : 'info');
    else if (outcome && outcome.winner === 1) setBanner(world, outcome.label, 'bad');
    if (res.notes.length) emit(world, 'coach:cue', { text: res.notes[0], es: noteEs(res.notes[0]), priority: res.success ? 0 : 1 });
  }

  function hud(world) {
    const total = reps;
    const idx = isServeDrill() ? launched : machine ? machine.state.fed : 0;
    let prompt = null;
    if (idx === 0) prompt = isServeDrill() ? 'Get ready to serve' : 'Get ready';
    else if (isServeDrill() && rep && !rep.shot) prompt = 'Let it bounce, then serve at waist height';
    return {
      title: d.name,
      subtitle: `${d.es} · ${d.skill}`,
      repIndex: Math.min(idx, total),
      repTotal: total,
      points: st.points,
      streak: st.streak,
      timer: machine && machine.state.feeding && !machine.state.held && !rep ? Math.max(0, machine.state.nextIn) : null,
      score: null,
      lastShot: lastShotHud(st.lastShot, st.lastNotes),
      banner: st.banner,
      prompt,
    };
  }

  function summary() {
    const counted = st.counted;
    return {
      drillId: base.id,
      name: d.name,
      reps: total(),
      points: st.points,
      stars: starsFor(d, st.points, reps),
      successRate: counted ? st.successes / counted : 0,
      hits: st.hits,
      bestStreak: st.bestStreak,
      results: st.results.map((r) => ({ index: r.index, points: r.points, success: r.success, landing: r.landing, reason: r.reason, notes: r.notes, stroke: r.shot ? r.shot.stroke : null, void: r.void })),
      tips: topTips(st.results),
      targets: d.targets,
      session: session ? session.summary() : null,
    };
  }
  const total = () => reps;

  return {
    id: `drill:${base.id}`,
    drill: base,
    get activeDrill() { return d; },
    /** Autopilot hints for the ball in play (the live mix uses the feeding drill's hints). */
    get apHints() {
      const lf = machine && machine.lastFeed;
      const id = lf && lf.feed && lf.feed.drillId;
      const sub = id && DRILL_BY_ID[id];
      if (!sub) return d.ap;
      return d.mirrored && sub.mirrorForLefty ? mirrorDrill(sub).ap : sub.ap;
    },
    start,
    update,
    onBus,
    hud,
    isFinished: () => st.finished,
    summary,
    get state() { return st; },
    get referee() { return referee; },
    get tactics() { return tactics; },
  };
}

/** Three most frequent coaching notes of a drill run. */
function topTips(results) {
  const count = new Map();
  for (const r of results) for (const n of r.notes || []) count.set(n, (count.get(n) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);
}

// ---------------------------------------------------------------------------
// Rally mode

/**
 * Free rally with the coach: the coach feeds, you rally; counts rally length.
 * opts: { level = 'club', rng?, session?, rallies = Infinity (finish after this many) }
 */
export function createRallyMode({ level = 'club', rng = createRng(0x7a11), session = null, rallies = Infinity } = {}) {
  let coach = null;
  let referee = null;
  let nextFeedAt = Infinity;
  let rallyStartT = 0;
  let lastActivity = 0;
  const tactics = createTacticalHome({ netGame: true });
  const RALLY_HOME = { x: 0.8, z: 7.8 };
  const st = {
    rallies: 0, current: 0, playerHits: 0, best: 0, lastShot: null, banner: null, bannerUntil: 0, lastOutcome: null,
    won: 0, lost: 0, finished: false,
  };

  function start(world) {
    tactics.setBase(world, RALLY_HOME);
    coach = createCoach({ level, rng, side: 'far', by: 'coach', home: { x: 0, z: -7.5 } });
    world.coach = coach;
    world.machine = null;
    world.ai = [];
    referee = createReferee({ serving: null, feedTeam: 1, onOutcome: (o) => onOutcome(world, o) });
    world.referee = referee;
    nextFeedAt = world.time + 2.0;
    lastActivity = world.time; // world.time continues the global clock: never 0 here
    emit(world, 'coach:cue', { text: 'Rally with the coach: keep it deep and cross-court. Let the glass work for you.', es: 'Peloteo con el entrenador: profundo y cruzado. Usa los cristales.', priority: 2 });
  }

  function update(world, dt) {
    tactics.update(world, dt);
    if (world.time >= nextFeedAt && !st.finished) {
      nextFeedAt = Infinity;
      lastActivity = world.time;
      coach.feed(world, { kmh: level === 'pro' ? 60 : level === 'rookie' ? 40 : 50 });
    }
    if (st.banner && world.time > st.bannerUntil) st.banner = null;
    // Failsafe: a rally without any ruling for a long time is restarted.
    if (nextFeedAt === Infinity && world.time - lastActivity > 15) {
      referee.reset({ serving: null, feedTeam: 1 });
      nextFeedAt = world.time + 1.0;
      lastActivity = world.time;
    }
  }

  function onBus(type, p, world) {
    if (type === 'judge:launch' && p.by === 'coach') {
      referee.reset({ serving: null, feedTeam: 1 });
      st.current = 0;
      rallyStartT = p.t;
      lastActivity = world.time;
    } else if (type === 'judge:hit') {
      st.current = referee.state.hits;
      lastActivity = world.time;
    } else if (type === 'ball:hit' && p.shot.by === 'player') {
      st.playerHits++;
      st.lastShot = p.shot;
      tactics.onPlayerShot(world, p.shot);
    }
  }

  function onOutcome(world, o) {
    const len = o.rallyLength;
    tactics.setBase(world, RALLY_HOME, { snap: false }); // walk back for the next feed
    st.rallies++;
    st.best = Math.max(st.best, len);
    st.lastOutcome = o;
    if (o.winner === 0) st.won++;
    else if (o.winner === 1) st.lost++;
    if (session) session.rallyEnded(len);
    st.banner = { text: `${o.label} · rally ${len}`, kind: o.winner === 0 ? 'good' : 'bad' };
    st.bannerUntil = world.time + BANNER_S;
    emit(world, 'rally:outcome', { winner: o.winner, reason: o.reason, label: o.label, pos: o.pos, rallyLength: len, duration: world.time - rallyStartT });
    if (st.rallies >= rallies) st.finished = true;
    else nextFeedAt = world.time + 2.5;
  }

  return {
    id: `rally:${level}`,
    start,
    update,
    onBus,
    hud: () => ({
      title: 'Rally with Coach',
      subtitle: `Level: ${level}`,
      repIndex: st.rallies,
      repTotal: Number.isFinite(rallies) ? rallies : null,
      points: null,
      streak: null,
      rally: st.current,
      bestRally: st.best,
      timer: null,
      score: null,
      lastShot: lastShotHud(st.lastShot),
      banner: st.banner,
      prompt: null,
    }),
    isFinished: () => st.finished,
    summary: () => ({ mode: 'rally', level, rallies: st.rallies, bestRally: st.best, won: st.won, lost: st.lost, playerHits: st.playerHits, session: session ? session.summary() : null }),
    get state() { return st; },
    get coach() { return coach; },
    get tactics() { return tactics; },
  };
}

// ---------------------------------------------------------------------------
// Match mode

/**
 * 2v2 match: the human (team 0, player 0, drive side) with an AI partner (team 0, player 1)
 * against two AI opponents (team 1). Real scoring (scoring.js, golden point by default),
 * serves with the referee, server rotation A, C, B, D.
 * opts: { level = 'club', games = 6 (games per set; one set), rng?, session?, goldenPoint = true,
 *         autoPlayer = false (the human slot is played by the AI brain: tests, attract mode),
 *         firstServer = { team: 1, player: 0 } }
 */
export function createMatchMode({
  level = 'club', games = 6, rng = createRng(0x3a7c), session = null, goldenPoint = true, autoPlayer = false,
  firstServer = { team: 1, player: 0 },
} = {}) {
  const match = createMatch({ gamesPerSet: games, setsToWin: 1, goldenPoint, tiebreakAt: games, firstServer });
  let referee = null;
  let partner = null, oppA = null, oppB = null, auto = null;
  let nextPointAt = Infinity;
  let serveAt = Infinity;
  let dropRetryAt = Infinity;
  let pointStartT = 0;
  const st = {
    points: [], banner: null, bannerUntil: 0, lastShot: null, finished: false, rally: 0, pointLive: false, faults: 0, serving: null,
  };
  const tactics = createTacticalHome({ netGame: true });

  const seed = () => (rng() * 2 ** 32) >>> 0;
  const near = (world) => [world.player.pos, partner.state.pos];
  const far = () => [oppA.state.pos, oppB.state.pos];

  /** Nearest-player responsibility between two teammates. */
  const coversVs = (selfPos, matePos) => (p) => Math.hypot(p.x - selfPos.x, p.z - selfPos.z) <= Math.hypot(p.x - matePos.x, p.z - matePos.z) + 0.05;

  function start(world) {
    const pl = world.player;
    partner = createCoach({ level, rng: createRng(seed()), side: 'near', team: 0, by: 'ai', name: 'B', home: { x: -2.4, z: 7.2 } });
    oppA = createCoach({ level, rng: createRng(seed()), side: 'far', team: 1, by: 'ai', name: 'C', home: { x: -2.4, z: -7.2 } });
    oppB = createCoach({ level, rng: createRng(seed()), side: 'far', team: 1, by: 'ai', name: 'D', home: { x: 2.4, z: -7.2 } });
    // Responsibilities and targets.
    patchCoach(partner, coversVs(partner.state.pos, pl.pos), () => far());
    patchCoach(oppA, coversVs(oppA.state.pos, oppB.state.pos), (w) => near(w));
    patchCoach(oppB, coversVs(oppB.state.pos, oppA.state.pos), (w) => near(w));
    world.ai = [partner, oppA, oppB];
    if (autoPlayer) {
      auto = createCoach({ level, rng: createRng(seed()), side: 'near', team: 0, by: 'ai', name: 'A', home: { x: 2.4, z: 7.2 }, bindPos: pl.pos, bindVel: pl.vel });
      patchCoach(auto, coversVs(pl.pos, partner.state.pos), () => far());
      world.ai.push(auto);
    }
    world.coach = null;
    world.machine = null;
    referee = createReferee({ serving: match.server(), onOutcome: (o) => onOutcome(world, o) });
    world.referee = referee;
    nextPointAt = world.time + 1.5;
    emit(world, 'coach:cue', { text: `Match vs ${level} opponents. Golden point at 40-all.`, es: `Partido contra rivales ${level}. Punto de oro en 40 iguales.`, priority: 2 });
  }

  // createCoach takes covers/opponents at construction; rebuild with closures that see live positions.
  function patchCoach(c, covers, opponents) {
    c.covers = covers;
    c.opponents = opponents;
  }

  function actorOf(team, player) {
    if (team === 0) return player === 0 ? auto : partner;
    return player === 0 ? oppA : oppB;
  }

  function placeTeams(world, sv) {
    const pl = world.player;
    const box = sv.box;
    // Near team: the human plays the right (drive) side; receives right-box serves.
    const humanServe = sv.team === 0 && sv.player === 0;
    const partnerServe = sv.team === 0 && sv.player === 1;
    const sgnBox = box === 'right' ? 1 : -1;
    let humanPos, partnerPos;
    if (humanServe) {
      humanPos = { x: 2.0 * sgnBox, z: 7.6 };
      partnerPos = { x: -2.3 * sgnBox, z: 3.4 };
    } else if (partnerServe) {
      partnerPos = { x: 2.0 * sgnBox, z: 7.6 };
      humanPos = { x: -2.3 * sgnBox, z: 3.4 };
    } else {
      // Receiving: the receiver stands deep on the box side, the other near the service line.
      humanPos = box === 'right' ? { x: 2.6, z: 8.5 } : { x: 2.4, z: 6.6 };
      partnerPos = box === 'left' ? { x: -2.6, z: 8.5 } : { x: -2.4, z: 6.6 };
    }
    tactics.setBase(world, humanPos);
    if (auto) auto.placeAt(humanPos);
    partner.placeAt(partnerPos);
    partner.setHome({ x: partnerPos.x < 0 ? -2.4 : 2.4, z: 7.2 });
    // Far team: C on the far right side (x < 0), D on the far left (x > 0).
    const farServe = sv.team === 1;
    const sgnFar = box === 'right' ? -1 : 1; // far player's right box side is x < 0
    for (const [c, k] of [[oppA, 0], [oppB, 1]]) {
      const ownX = k === 0 ? -2.4 : 2.4;
      let p;
      if (farServe && sv.player === k) p = { x: 2.0 * sgnFar, z: -7.6 };
      else if (farServe) p = { x: -2.3 * sgnFar, z: -3.4 };
      else p = (box === 'right') === (k === 0) ? { x: ownX, z: -8.5 } : { x: ownX, z: -6.6 };
      c.placeAt(p);
      c.setHome({ x: ownX, z: -7.2 });
    }
  }

  function startPoint(world) {
    const sv = match.server();
    world.ball = null; // the old ball is picked up between points
    st.serving = sv;
    st.rally = 0;
    st.pointLive = true;
    pointStartT = world.time;
    referee.reset({ serving: { team: sv.team, box: sv.box } });
    placeTeams(world, sv);
    scheduleServe(world, 1.8);
  }

  function scheduleServe(world, delay) {
    const sv = st.serving;
    const actor = actorOf(sv.team, sv.player);
    if (actor) {
      actor.serve(world, sv.box, delay);
      serveAt = Infinity;
    } else serveAt = world.time + delay; // the human serves: drop the ball beside them
  }

  function dropForHuman(world) {
    const p = world.player.pos;
    const dom = (world.settings.handed || 'right') === 'left' ? -1 : 1;
    launchBall(world, { pos: v3(p.x + 0.62 * dom, 1.0, p.z - 0.36), vel: v3(0, -0.2, 0), spin: v3(), by: 'drop' });
    dropRetryAt = world.time + 6;
  }

  function update(world, dt) {
    if (st.finished) return;
    if (!auto) tactics.update(world, dt);
    if (world.time >= nextPointAt) {
      nextPointAt = Infinity;
      startPoint(world);
    }
    if (world.time >= serveAt) {
      serveAt = Infinity;
      dropForHuman(world);
    }
    if (referee && referee.state.awaitingServe && world.time >= dropRetryAt && world.flight.by === 'drop') dropForHuman(world);
    if (st.banner && world.time > st.bannerUntil) st.banner = null;
    // Failsafe: replay a point that has produced no ruling for a long time.
    if (st.pointLive && world.time - pointStartT > 90) {
      emit(world, 'rally:outcome', { winner: null, reason: 'let', label: OUTCOME_LABELS.let, pos: null, detail: 'stalled' });
      st.pointLive = false;
      referee.reset({ serving: { team: st.serving.team, box: st.serving.box } });
      world.ball = null;
      nextPointAt = world.time + 1.5;
    }
  }

  function onBus(type, p, world) {
    if (type === 'judge:hit') {
      st.rally = referee.state.hits;
      if (p.team === 0 || p.team === 1) dropRetryAt = Infinity;
    } else if (type === 'ball:hit' && p.shot.by === 'player') {
      st.lastShot = p.shot;
      tactics.onPlayerShot(world, p.shot);
    }
  }

  function onOutcome(world, o) {
    if (!o.pointOver) {
      // First fault or let: same server again.
      st.faults = o.faults;
      st.banner = { text: o.label, kind: 'info' };
      st.bannerUntil = world.time + BANNER_S;
      emit(world, 'rally:outcome', { winner: null, reason: o.reason, label: o.label, pos: o.pos });
      scheduleServe(world, 1.6);
      return;
    }
    st.pointLive = false;
    let res = null;
    if (o.winner === 0 || o.winner === 1) res = match.pointWonBy(o.winner);
    st.points.push({ winner: o.winner, reason: o.reason, rally: o.rallyLength, server: st.serving, t: world.time });
    if (session) session.rallyEnded(o.rallyLength);
    emit(world, 'rally:outcome', { winner: o.winner, reason: o.reason, label: o.label, pos: o.pos, score: match.display() });
    const text = res && res.matchWon ? (o.winner === 0 ? 'Match won!' : 'Match lost') : res && res.gameWon ? `Game ${o.winner === 0 ? 'won' : 'lost'}` : o.label;
    st.banner = { text, kind: o.winner === 0 ? 'good' : 'bad' };
    st.bannerUntil = world.time + BANNER_S;
    if (match.isOver) {
      st.finished = true;
      emit(world, 'match:end', { summary: summary() });
    } else nextPointAt = world.time + 2.6;
  }

  function summary() {
    const d = match.display();
    return { mode: 'match', level, games, winner: match.winner, score: d, points: st.points.slice(), session: session ? session.summary() : null };
  }

  return {
    id: `match:${level}`,
    start,
    update,
    onBus,
    hud: () => ({
      title: 'Match',
      subtitle: `vs ${level}`,
      repIndex: st.points.length,
      repTotal: null,
      points: null,
      streak: null,
      rally: st.rally,
      timer: null,
      score: match.display(),
      lastShot: lastShotHud(st.lastShot),
      banner: st.banner,
      prompt: st.serving && st.serving.team === 0 && st.serving.player === 0 && referee && referee.state.awaitingServe ? 'Your serve: let it bounce, hit at waist height' : null,
    }),
    isFinished: () => st.finished,
    summary,
    match,
    get state() { return st; },
    get actors() { return { partner, oppA, oppB, auto }; },
    get tactics() { return tactics; },
  };
}

