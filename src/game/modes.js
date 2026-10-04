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
import { createCallouts } from './callouts.js';
import { PERSONALITIES } from './coach.js';

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

/** How long the HUD keeps the last miss reason and the timing meter (sim s). */
export const MISS_HUD_S = 3.5;
export const METER_HUD_S = 3.0;

/**
 * Timing-hit HUD fields (game/swingAssist.js): the last miss reason and the timing meter of the
 * last swing, while recent. { miss: { reason, text, es, ms, cm } | null, meter: { e, early, late, hit, label } | null }
 */
export function timingHud(world) {
  const T = world.timing;
  if (!T) return { miss: null, meter: null };
  const m = T.lastMiss && world.time - T.lastMiss.at <= MISS_HUD_S ? T.lastMiss : null;
  const s = T.lastSwing && world.time - T.lastSwing.at <= METER_HUD_S ? T.lastSwing : null;
  return {
    miss: m ? { reason: m.reason, text: m.text, es: m.es, ms: m.ms, cm: m.cm, at: m.at } : null,
    meter: s ? { e: s.e, early: s.early, late: s.late, hit: s.hit, label: s.label, at: s.at } : null,
  };
}

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
    // Spacing coaching of a timing hit (game/swingAssist.js spacingNote, QA r5) leads the notes.
    notes: shot.timingHit && shot.timingHit.spacingText ? [shot.timingHit.spacingText, ...(notes || [])] : notes,
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
      walls.push({ surface: e.surface, wall: e.wall, side: e.side, t: e.t, pos: e.pos ? { x: e.pos.x, y: e.pos.y, z: e.pos.z } : null });
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
    landingT: landing ? landT : null,
    walls,
    sideGlassAfterBounce: legal && sideGlass,
    backGlassAfterBounce: legal && backGlass,
    exitVia: legal ? exitVia : null,
    feed,
  };
}

/**
 * Rally / match shot log for the session (results: stroke table, landing map, in-play rate): each
 * judged player shot is recorded once its fate is known, i.e. when the other side plays the ball
 * (it was in) or when the point ends on it. success = the shot landed legally on the far side.
 * Fed from the mode's onBus (authoritative timeline only) and onOutcome. No allocation per frame.
 */
export function createRallyShotLog(session) {
  let pend = null; // { shot, hitT, events: [] }
  function close(outcome) {
    if (!pend) return;
    const p = pend;
    pend = null;
    if (!session) return;
    const info = shotOutcomeInfo(p.events, p.hitT, outcome, { team: 0 });
    // The other side played it (no outcome yet): it was in if it bounced legally first, or a volley.
    const success = outcome ? info.legal : !!info.landing || p.events.every((e) => e.type !== 'bounce' && e.type !== 'exit' && e.type !== 'outside-bounce');
    session.record(p.shot, { success, points: 0, landing: info.landing, rallyLength: 1 });
  }
  return {
    onBus(type, p) {
      if (type === 'ball:hit' && p.shot && p.shot.by === 'player') {
        close(null);
        pend = { shot: p.shot, hitT: Number.isFinite(p.shot.t) ? p.shot.t : -Infinity, events: [] };
      } else if (type === 'judge:event' && pend && p.evt) {
        if (pend.events.length < 32) pend.events.push(p.evt);
      } else if (type === 'judge:hit' && pend && p.team === 1) {
        close(null);
      }
    },
    onOutcome(o) {
      if (o && o.pointOver === false) return; // a fault: the serve is replayed, not a shot of the rally
      close(o || null);
    },
    clear() { pend = null; },
  };
}

// ---------------------------------------------------------------------------
// Drill mode

/**
 * @param drill DrillDef (right-handed; mirrored at start for a left-hander) or a drill id
 * @param opts { rng?, session?, startDelay = 2, machineSigma?, reps?,
 *   quiet?: true -> no per-rep banners / coach cues (arcade challenges show their own),
 *   gate?: (world) => boolean, an extra feed gate (arcade pacing),
 *   resolveOnLanding?: true -> a rep is settled at the return's first legal bounce on the far side
 *     (fast arcade feeding; the ball plays on but is no longer judged),
 *   resolveWhen?: (outcomeInfo, judgedEvent) => boolean, the same with a custom moment (e.g. the
 *     return reaching the far glass after its legal bounce) }
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
    finished: false, ended: false, hits: 0, successes: 0, counted: 0, opened: 0, misses: {},
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
      machine.gate = (w) => feedGateOpen(w, FEED_GAP) && (!opts.gate || opts.gate(w) !== false);
      world.machine = machine;
    }
    if (!opts.quiet) emit(world, 'coach:cue', { text: d.cues.intro, es: d.cues.introEs, priority: 2 });
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
        if (rep) {
          rep.events.push(p.evt);
          const early = opts.resolveWhen || (opts.resolveOnLanding ? (info, e) => e.type === 'bounce' && e.side === 'far' && !!info.landing : null);
          if (early && rep.shot && p.evt.side === 'far') {
            const info = shotOutcomeInfo(rep.events, rep.hitT, null, { team: 0 });
            if (info.legal && early(info, p.evt)) resolveRep(world, { winner: 0, reason: 'landed', label: 'In', pos: p.evt.pos, pointOver: true, synthetic: true });
          }
        }
        break;
      case 'ball:hit':
        if (p.shot.by === 'player') {
          st.hits++;
          st.lastShot = p.shot;
          st.lastNotes = [];
        }
        break;
      case 'player:miss':
        // Timing hits (swingAssist.js): why this rep's ball was not hit.
        st.misses[p.reason] = (st.misses[p.reason] || 0) + 1;
        if (rep && !rep.shot) rep.miss = p;
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
    // A ball the player did not hit: the reason the timing judge found replaces the generic tip.
    if (!r.void && !r.shot && r.miss && r.miss.text) res.notes = [r.miss.text];
    if (!r.void) {
      st.counted++;
      st.points += res.points;
      if (res.success) {
        st.successes++;
        st.streak++;
        st.bestStreak = Math.max(st.bestStreak, st.streak);
      } else st.streak = 0;
    }
    const entry = { index: r.index, shot: r.shot, landing: info.landing, legal: info.legal, reason: info.reason, void: r.void, miss: r.miss ? r.miss.reason : null, ...res };
    st.results.push(entry);
    st.lastNotes = res.notes;
    if (session && r.shot) {
      session.record(r.shot, { success: res.success, points: res.points, landing: info.landing, rallyLength: 1, notes: res.notes });
    }
    if (outcome && !outcome.synthetic) emit(world, 'rally:outcome', { winner: outcome.winner, reason: outcome.reason, label: outcome.label, pos: outcome.pos, rallyLength: outcome.rallyLength, lastBy: r.shot ? 'player' : null });
    emit(world, 'shot:result', {
      shotId: r.shot ? r.shot.id : null, landing: info.landing, inTarget: !!res.zone && res.success, points: res.points,
      notes: res.notes, success: res.success, zone: res.zone, reason: info.reason, legal: info.legal,
    });
    emit(world, 'drill:rep', { index: r.index, total: reps, points: res.points, totalPoints: st.points, streak: st.streak });
    if (opts.quiet) return;
    if (outcome && (outcome.reason === 'por-tres' || outcome.reason === 'por-cuatro')) setBanner(world, outcome.label, 'great');
    else if (res.points > 0) setBanner(world, `+${res.points}`, res.success ? 'good' : 'info');
    else if (outcome && outcome.winner === 1) setBanner(world, outcome.label, 'bad');
    if (res.notes.length) {
      const es = !r.shot && r.miss && r.miss.text === res.notes[0] ? r.miss.es : noteEs(res.notes[0]);
      emit(world, 'coach:cue', { text: res.notes[0], es, priority: res.success ? 0 : 1 });
    }
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
      ...timingHud(world),
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
      results: st.results.map((r) => ({ index: r.index, points: r.points, success: r.success, landing: r.landing, reason: r.reason, notes: r.notes, stroke: r.shot ? r.shot.stroke : null, void: r.void, miss: r.miss })),
      misses: { ...st.misses },
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
    get machine() { return machine; },
    get rep() { return rep; },
    /** Stops feeding (arcade timer): the rep in play is still judged. */
    stopFeeding() {
      if (machine) machine.stop();
    },
    /** Every launched ball has been judged (nothing left in play for scoring). */
    get settled() {
      const launchedCount = isServeDrill() ? launched : machine ? machine.state.fed : 0;
      return !rep && st.opened >= launchedCount;
    },
  };
}

/**
 * Coaching tip for a kind of miss (timing hits, game/swingAssist.js): the rep notes carry the exact
 * reason ("Swing was 0.3 s late"); the results screen gets the advice for the most frequent kind.
 */
export const MISS_TIPS = Object.freeze({
  'no-swing': 'Swing a bit faster – a full, quick swing counts',
  early: 'Wait for it – swing as the ring around the ball turns green',
  late: 'Start your swing earlier – as the ball bounces',
  below: 'Swing through the ball, not under it',
  above: 'Bend your knees for the low ball',
  'too-far': 'Step toward the ball before you swing',
  'too-close': 'Give yourself room – step away from the ball',
  behind: 'Step in and meet the ball in front of you',
  'in-front': 'Let the ball come to you',
  rules: 'Let it bounce – and off the glass – before you play it',
  tracking: 'Stay in the camera picture, head to ankles',
});

/** Three most frequent coaching notes of a drill run (misses grouped by their kind). */
function topTips(results) {
  const count = new Map();
  for (const r of results) {
    if (!r.shot && r.miss && MISS_TIPS[r.miss]) {
      const t = MISS_TIPS[r.miss];
      count.set(t, (count.get(t) || 0) + 1);
      continue;
    }
    for (const n of r.notes || []) count.set(n, (count.get(n) || 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);
}

// ---------------------------------------------------------------------------
// Rally mode

/**
 * Free rally with the coach: the coach feeds, you rally; counts rally length.
 * opts: { level = 'club', rng?, session?, rallies = Infinity (finish after this many) }
 */
export function createRallyMode({ level = 'club', rng = createRng(0x7a11), session = null, rallies = Infinity } = {}) {
  const shotLog = createRallyShotLog(session);
  let coach = null;
  let referee = null;
  let nextFeedAt = Infinity;
  let rallyStartT = 0;
  let lastActivity = 0;
  const tactics = createTacticalHome({ netGame: true });
  const RALLY_HOME = { x: 0.8, z: 7.8 };
  const st = {
    rallies: 0, current: 0, playerHits: 0, best: 0, lastShot: null, banner: null, bannerUntil: 0, lastOutcome: null,
    won: 0, lost: 0, finished: false, misses: {},
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
    shotLog.onBus(type, p);
    if (type === 'judge:launch' && p.by === 'coach') {
      referee.reset({ serving: null, feedTeam: 1 });
      st.current = 0;
      rallyStartT = p.t;
      lastActivity = world.time;
    } else if (type === 'judge:hit') {
      st.current = referee.state.hits;
      lastActivity = world.time;
      st.lastBy = p.shot ? p.shot.by : p.team === 0 ? 'player' : 'coach';
    } else if (type === 'ball:hit' && p.shot.by === 'player') {
      st.playerHits++;
      st.lastShot = p.shot;
      tactics.onPlayerShot(world, p.shot);
    } else if (type === 'player:miss') {
      st.misses[p.reason] = (st.misses[p.reason] || 0) + 1;
    }
  }

  function onOutcome(world, o) {
    const len = o.rallyLength;
    shotLog.onOutcome(o);
    tactics.setBase(world, RALLY_HOME, { snap: false }); // walk back for the next feed
    st.rallies++;
    st.best = Math.max(st.best, len);
    st.lastOutcome = o;
    if (o.winner === 0) st.won++;
    else if (o.winner === 1) st.lost++;
    if (session) session.rallyEnded(len);
    st.banner = { text: `${o.label} · rally ${len}`, kind: o.winner === 0 ? 'good' : 'bad' };
    st.bannerUntil = world.time + BANNER_S;
    emit(world, 'rally:outcome', { winner: o.winner, reason: o.reason, label: o.label, pos: o.pos, rallyLength: len, duration: world.time - rallyStartT, lastBy: st.lastBy || null });
    st.lastBy = null;
    if (st.rallies >= rallies) st.finished = true;
    else nextFeedAt = world.time + 2.5;
  }

  return {
    id: `rally:${level}`,
    start,
    update,
    onBus,
    hud: (world) => ({
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
      ...(world ? timingHud(world) : {}),
    }),
    isFinished: () => st.finished,
    summary: () => ({ mode: 'rally', level, rallies: st.rallies, bestRally: st.best, won: st.won, lost: st.lost, playerHits: st.playerHits, misses: { ...st.misses }, session: session ? session.summary() : null }),
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
 *         firstServer = { team: 1, player: 0 },
 *         opponents?: [{ name, short, personality, handed, kit }] x2 (career pairs; default neutral rivals),
 *         partner?: { name, short, personality, handed, kit } (default Lucía, all-round),
 *         teamNames?: [[name, small], [name, small]] for the scoreboard,
 *         resume?: { points: [winner 0|1, ...] } replays a saved match point by point,
 *         callouts = true: the partner's calls (game/callouts.js), title?, subtitle? }
 */
export const DEFAULT_PARTNER_INFO = Object.freeze({ name: 'Lucía Navarro', short: 'Lucía', personality: 'all-rounder', handed: 'right', kit: null });

export function createMatchMode({
  level = 'club', games = 6, rng = createRng(0x3a7c), session = null, goldenPoint = true, autoPlayer = false,
  firstServer = { team: 1, player: 0 }, opponents = null, partner: partnerInfo = null, teamNames = null, resume = null,
  callouts: wantCallouts = true, title = 'Match', subtitle = null, skill = null, partnerSkill = null,
} = {}) {
  // Career (round 5): a continuous opponent skill 0..2 (game/career.js adaptive difficulty) and the
  // partner's (at least club level, so a career partner is a help, not a liability).
  const oppSkill = Number.isFinite(skill) ? skill : null;
  const mateSkill = Number.isFinite(partnerSkill) ? partnerSkill : oppSkill;
  const match = createMatch({ gamesPerSet: games, setsToWin: 1, goldenPoint, tiebreakAt: games, firstServer });
  const shotLog = createRallyShotLog(session);
  let referee = null;
  let partner = null, oppA = null, oppB = null, auto = null;
  let nextPointAt = Infinity;
  let serveAt = Infinity;
  let dropRetryAt = Infinity;
  let pointStartT = 0;
  let callouts = null;
  const pInfo = partnerInfo || DEFAULT_PARTNER_INFO;
  const names = teamNames || [['You', 'Nosotros'], ['Rivals', 'Rivales']];
  const st = {
    points: [], banner: null, bannerUntil: 0, lastShot: null, finished: false, rally: 0, pointLive: false, faults: 0, serving: null,
    misses: {}, playerHits: 0, lastHit: null, resumed: 0, gameLosses: 0, cleanGames: 0,
  };
  const tactics = createTacticalHome({ netGame: true });

  const seed = () => (rng() * 2 ** 32) >>> 0;
  const near = (world) => [world.player.pos, partner.state.pos];
  const far = () => [oppA.state.pos, oppB.state.pos];

  /** Nearest-player responsibility between two teammates. */
  const coversVs = (selfPos, matePos) => (p) => Math.hypot(p.x - selfPos.x, p.z - selfPos.z) <= Math.hypot(p.x - matePos.x, p.z - matePos.z) + 0.05;

  function start(world) {
    const pl = world.player;
    const oi = (k) => (opponents && opponents[k]) || {};
    partner = createCoach({
      level, skill: mateSkill, rng: createRng(seed()), side: 'near', team: 0, by: 'ai', name: 'B', home: { x: -2.4, z: 7.2 },
      personality: pInfo.personality, handed: pInfo.handed || 'right', kit: pInfo.kit || null, displayName: pInfo.short || pInfo.name,
    });
    oppA = createCoach({
      level, skill: oppSkill, rng: createRng(seed()), side: 'far', team: 1, by: 'ai', name: 'C', home: { x: -2.4, z: -7.2 },
      personality: oi(0).personality, handed: oi(0).handed || 'right', kit: oi(0).kit || null, displayName: oi(0).short || oi(0).name || null,
    });
    oppB = createCoach({
      level, skill: oppSkill, rng: createRng(seed()), side: 'far', team: 1, by: 'ai', name: 'D', home: { x: 2.4, z: -7.2 },
      personality: oi(1).personality, handed: oi(1).handed || 'right', kit: oi(1).kit || null, displayName: oi(1).short || oi(1).name || null,
    });
    if (wantCallouts) {
      const talk = (PERSONALITIES[pInfo.personality] || PERSONALITIES['all-rounder']).mods.talk ?? 0.6;
      // Own rng (the match rng stream that seeds the players stays unchanged).
      callouts = createCallouts({ partner, who: pInfo.short || pInfo.name || 'Partner', talk, rng: createRng(0xca11 + games * 131 + level.length) });
    }
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
    // Resume a saved match: the point winners replayed into the score (server rotation included).
    if (resume && Array.isArray(resume.points)) {
      for (const w of resume.points) {
        if ((w !== 0 && w !== 1) || match.isOver) continue;
        match.pointWonBy(w);
        st.points.push({ winner: w, reason: 'resumed', rally: 0, server: null, t: world.time });
        st.resumed++;
      }
      // A saved match that had already been won (quit before its results): it ends at once.
      if (match.isOver) st.endOnStart = true;
    }
    referee = createReferee({ serving: match.server(), onOutcome: (o) => onOutcome(world, o) });
    world.referee = referee;
    nextPointAt = world.time + 1.5;
    const vs = opponents ? names[1][1] || names[1][0] : `${level} opponents`;
    emit(world, 'coach:cue', {
      text: st.resumed ? `Match resumed vs ${vs}.` : `Match vs ${vs}. Golden point at 40-all.`,
      es: st.resumed ? `Partido reanudado contra ${vs}.` : `Partido contra ${vs}. Punto de oro en 40 iguales.`, priority: 2,
    });
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
    if (callouts) callouts.beforePoint(world, match.display(), sv);
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
    if (st.endOnStart) {
      st.endOnStart = false;
      st.finished = true;
      emit(world, 'match:end', { summary: summary() });
    }
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
    if (callouts && st.pointLive) callouts.update(world);
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
    shotLog.onBus(type, p);
    if (type === 'judge:hit') {
      st.rally = referee.state.hits;
      if (p.team === 0 || p.team === 1) dropRetryAt = Infinity;
      st.lastHit = { by: p.shot ? p.shot.by : null, team: p.team, t: p.t };
    } else if (type === 'ball:hit' && p.shot.by === 'player') {
      st.lastShot = p.shot;
      st.playerHits++;
      tactics.onPlayerShot(world, p.shot);
    } else if (type === 'player:miss') {
      st.misses[p.reason] = (st.misses[p.reason] || 0) + 1;
    }
  }

  function onOutcome(world, o) {
    shotLog.onOutcome(o);
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
    const before = match.display();
    if (o.winner === 0 || o.winner === 1) res = match.pointWonBy(o.winner);
    st.points.push({ winner: o.winner, reason: o.reason, rally: o.rallyLength, server: st.serving, t: world.time, lastBy: st.lastHit ? st.lastHit.by : null });
    if (session) session.rallyEnded(o.rallyLength);
    // A game won to love (clean sheet): the losing side had no points when the game ended.
    let clean = false;
    if (res && res.gameWon && !before.flags.tiebreak) {
      const loserPts = before.points[1 - o.winner];
      clean = loserPts === '0' || loserPts === '';
      if (clean && o.winner === 0) st.cleanGames++;
    }
    const lastHit = st.lastHit;
    st.lastHit = null;
    emit(world, 'rally:outcome', {
      winner: o.winner, reason: o.reason, label: o.label, pos: o.pos, score: match.display(), rallyLength: o.rallyLength,
      lastBy: lastHit ? lastHit.by : null, lastTeam: lastHit ? lastHit.team : null, gameWon: !!(res && res.gameWon), cleanSheet: clean,
      golden: !!(before.flags.goldenPoint && before.points[0] === '40' && before.points[1] === '40'),
    });
    emit(world, 'match:point', { points: st.points.filter((q) => q.winner === 0 || q.winner === 1).map((q) => q.winner), score: match.display() });
    markMoods(world, o.winner);
    if (callouts) callouts.onPoint(world, o, lastHit, { gameWon: !!(res && res.gameWon && o.winner === 0) });
    const text = res && res.matchWon ? (o.winner === 0 ? 'Match won!' : 'Match lost') : res && res.gameWon ? `Game ${o.winner === 0 ? 'won' : 'lost'}` : o.label;
    st.banner = { text, kind: o.winner === 0 ? 'good' : 'bad' };
    st.bannerUntil = world.time + BANNER_S;
    if (match.isOver) {
      st.finished = true;
      emit(world, 'match:end', { summary: summary() });
    } else nextPointAt = world.time + 2.6;
  }

  /** Actors' reaction to the point (renderer hint: celebrate / dejected), { kind, at }. */
  function markMoods(world, winner) {
    if (winner !== 0 && winner !== 1) return;
    for (const a of [partner, oppA, oppB, auto]) {
      if (!a) continue;
      a.state.mood = { kind: a.team === winner ? 'celebrate' : 'dejected', at: world.time };
    }
  }

  function summary() {
    const d = match.display();
    return {
      mode: 'match', level, games, winner: match.winner, score: d, points: st.points.slice(), playerHits: st.playerHits, misses: { ...st.misses },
      session: session ? session.summary() : null, teamNames: names, cleanGames: st.cleanGames,
      bestRally: st.points.reduce((m, q) => Math.max(m, q.rally || 0), 0),
    };
  }

  return {
    id: `match:${level}`,
    start,
    update,
    onBus,
    hud: (world) => ({
      ...(world ? timingHud(world) : {}),
      title,
      subtitle: subtitle || `vs ${level}`,
      repIndex: st.points.length,
      repTotal: null,
      points: null,
      streak: null,
      rally: st.rally,
      timer: null,
      score: { ...match.display(), names },
      lastShot: lastShotHud(st.lastShot),
      banner: st.banner,
      prompt: st.serving && st.serving.team === 0 && st.serving.player === 0 && referee && referee.state.awaitingServe ? 'Your serve: let it bounce, hit at waist height' : null,
    }),
    isFinished: () => st.finished,
    summary,
    match,
    get state() { return st; },
    get actors() { return { partner, oppA, oppB, auto }; },
    get callouts() { return callouts; },
    teamNames: names,
    get tactics() { return tactics; },
  };
}

