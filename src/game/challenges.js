// Arcade challenges (60-90 s, scored, local leaderboards): Por Tres Party, Glass Breaker, Rally
// Marathon, Volley Wall and a Daily Challenge seeded by the date. Each is a ModeController
// (SPEC §5.6) built on the real drill / rally machinery, so every ball is still ruled by the
// referee with padel rules; the arcade layer adds a clock, combos and multipliers, "Perfect
// timing!" bonuses and the leaderboard. Bus events (presentation): 'challenge:score'
// { points, base, mult, perfect, combo, total, label, es, kind }, 'challenge:perfect' { streak },
// 'challenge:combo' { combo, mult }, 'challenge:targets' { targets }, 'challenge:target-hit'
// { id, pos, points }, 'challenge:end' { summary }. Pure module.

import { createRng } from '../util/math.js';
import { COURT } from '../config.js';
import { DRILL_BY_ID } from './drills.js';
import { createDrillMode, createRallyMode, timingHud } from './modes.js';
import { emit } from './world.js';

export const ARCADE_KEY = 'vibora.arcade.v1';

/** Combo -> multiplier steps: 3 in a row ×2, 6 ×3, 10 ×4, 15 ×5. */
export const COMBO_STEPS = Object.freeze([0, 3, 6, 10, 15]);
export function multiplierFor(combo) {
  let m = 1;
  for (let i = 1; i < COMBO_STEPS.length; i++) if (combo >= COMBO_STEPS[i]) m = i + 1;
  return m;
}

/** A timing hit within this many seconds of the ideal moment is "Perfect timing!". */
export const PERFECT_TIMING_S = 0.05;
export const PERFECT_BONUS = 0.5;

/**
 * Perfect hit: a timing hit (swingAssist.js shot.timingHit.e) within PERFECT_TIMING_S of the
 * ideal moment, or a physical hit on the sweet spot (quality ≥ 0.85) on time.
 */
export function isPerfectHit(shot) {
  if (!shot || shot.by !== 'player') return false;
  const th = shot.timingHit;
  if (th && Number.isFinite(th.e)) return Math.abs(th.e) <= PERFECT_TIMING_S;
  return Number.isFinite(shot.quality) && shot.quality >= 0.85 && shot.timing === 'good';
}

// ---------------------------------------------------------------------------
// Definitions

export const CHALLENGES = Object.freeze([
  Object.freeze({
    id: 'por-tres-party', name: 'Por Tres Party', es: 'Fiesta por tres', duration: 75, icon: 'smash', skill: 'Overheads',
    desc: 'Short lobs, one after another. Smash them out over the back wall for the big points.',
    descEs: 'Globos cortos sin parar. Remátalos por encima del fondo.',
    rules: [['¡Por tres! over the back wall', 1000], ['¡Por cuatro! over the side', 600], ['Smash between the net and service line', 250], ['Any other overhead in', 80]],
  }),
  Object.freeze({
    id: 'glass-breaker', name: 'Glass Breaker', es: 'Rompecristales', duration: 60, icon: 'glass', skill: 'Groundstrokes',
    desc: 'Glowing targets light up on the far back glass. The brightest one is your aim: an on-time drive flies at it (early pulls it cross-court, late sends it down the line). Bounce first, then shatter it. Targets start big and shrink as your combo grows.',
    descEs: 'Dianas en el cristal del fondo rival: la más brillante es tu objetivo. Golpe a tiempo, bote y rompe la diana.',
    rules: [['Target shattered (bounce, then glass)', 300], ['Deep drive off the back glass', 60], ['Ball in the court', 20], ['On time = the bright target · early = cross-court · late = down the line', 'Aim']],
  }),
  Object.freeze({
    id: 'rally-marathon', name: 'Rally Marathon', es: 'Maratón de peloteo', duration: 90, icon: 'rally', skill: 'Tactics', lives: 3,
    desc: 'Keep the rally alive against the coach. Every ball you return speeds the next one up. Three lives.',
    descEs: 'Aguanta el peloteo con el entrenador: cada bola llega más rápida. Tres vidas.',
    rules: [['Ball returned', '10 × rally level'], ['Winner past the coach', 150], ['Rally lost', 'one life']],
  }),
  Object.freeze({
    id: 'volley-wall', name: 'Volley Wall', es: 'Muro de voleas', duration: 60, icon: 'volley', skill: 'Net',
    desc: 'At the net, the machine fires faster and faster. Punch every volley back into the court.',
    descEs: 'En la red, la máquina dispara cada vez más rápido. Devuelve cada volea.',
    rules: [['Volley into the deep corners', 200], ['Volley in the court', 100]],
  }),
]);
export const CHALLENGE_BY_ID = Object.freeze(Object.fromEntries(CHALLENGES.map((c) => [c.id, c])));

/** Rival scores on a fresh leaderboard (fictional players of the Circuito Víbora). */
const RIVALS = {
  'por-tres-party': [['Rafa Iturbe', 62000], ['Bruno Sáez', 45000], ['Hugo Ferrán', 30000], ['Lucía Navarro', 18000], ['Paco Ruiz', 8000]],
  'glass-breaker': [['Álex Prieto', 14000], ['Inés Varela', 10000], ['Nuria Ortega', 7000], ['Nico Herrera', 4000], ['Toni Bermejo', 1500]],
  'rally-marathon': [['Nuria Ortega', 6000], ['Álex Prieto', 4500], ['Marta Lobo', 3000], ['Pablo Soler', 1800], ['Carla Ortega', 800]],
  'volley-wall': [['Darío Méndez', 24000], ['Mateo Rivas', 17000], ['Hugo Ferrán', 12000], ['Nico Herrera', 7000], ['Vera Kowal', 3000]],
};

// ---------------------------------------------------------------------------
// Daily challenge

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** 'YYYY-MM-DD' of a Date / ms (local time). */
export function dateKey(d = new Date()) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

const DAILY_TWISTS = Object.freeze([
  { id: 'fast', en: 'Fast feeds', es: 'Bolas rápidas', pace: 1.12 },
  { id: 'short', en: 'Sprint: 45 seconds', es: 'Sprint: 45 segundos', duration: 45 },
  { id: 'long', en: 'Endurance: +30 s', es: 'Resistencia: +30 s', duration: 30, add: true },
  { id: 'double', en: 'Double points on perfect timing', es: 'Doble en golpes perfectos', perfectBonus: 1.0 },
  { id: 'pro', en: 'Pro coach', es: 'Entrenador pro', level: 'pro' },
]);

/** Today's challenge: a base challenge, a twist and a venue, all from the date. */
export function dailyChallenge(key = dateKey()) {
  const h = hashStr(`vibora-daily:${key}`);
  const base = CHALLENGES[h % CHALLENGES.length];
  const twist = DAILY_TWISTS[(h >>> 8) % DAILY_TWISTS.length];
  const venue = ['club', 'sunset', 'stadium'][(h >>> 16) % 3];
  let duration = base.duration;
  if (twist.duration) duration = twist.add ? base.duration + twist.duration : twist.duration;
  return {
    id: `daily:${key}`, date: key, base: base.id, name: `Daily · ${base.name}`, es: `Reto diario · ${base.es}`,
    twist: { id: twist.id, en: twist.en, es: twist.es }, venue, seed: h, duration,
    pace: twist.pace || 1, perfectBonus: twist.perfectBonus ?? PERFECT_BONUS, level: twist.level || null,
  };
}

// ---------------------------------------------------------------------------
// Leaderboards (local)

/**
 * @param {{ storage?: {getItem,setItem}|null, now?: () => number }} o
 */
export function createLeaderboards({ storage = null, now = () => Date.now() } = {}) {
  let data = { v: 1, boards: {} };
  try {
    const raw = storage && storage.getItem(ARCADE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && p.v === 1 && p.boards && typeof p.boards === 'object') data = p;
    }
  } catch {
    data = { v: 1, boards: {} };
  }
  const save = () => {
    try {
      if (storage) storage.setItem(ARCADE_KEY, JSON.stringify(data));
    } catch {
      /* ignore */
    }
  };
  const baseOf = (id) => (id.startsWith('daily:') ? null : id);
  const mine = (id) => (Array.isArray(data.boards[id]) ? data.boards[id] : []);

  /** Merged board: rivals plus your runs, best first. Rows: { name, score, you, at, combo }. */
  function board(id, n = 8) {
    const base = baseOf(id);
    const rows = (base && RIVALS[base] ? RIVALS[base] : []).map(([name, score]) => ({ name, score, you: false }));
    for (const e of mine(id)) rows.push({ name: 'You', score: e.score, you: true, at: e.at, combo: e.combo, perfect: e.perfect });
    rows.sort((a, b) => b.score - a.score || (a.you ? -1 : 1));
    return rows.slice(0, n).map((r, i) => ({ ...r, rank: i + 1 }));
  }

  /** Your best score on a board (or null). */
  function best(id) {
    const m = mine(id);
    return m.length ? Math.max(...m.map((e) => e.score)) : null;
  }

  /** Records a run. -> { rank (in the merged board), isBest, previousBest, board } */
  function submit(id, { score = 0, combo = 0, perfect = 0 } = {}) {
    const prev = best(id);
    const entry = { score: Math.max(0, Math.round(score)), combo, perfect, at: now() };
    const list = mine(id).concat(entry).sort((a, b) => b.score - a.score).slice(0, 10);
    data.boards[id] = list;
    save();
    const full = board(id, 50);
    const rank = full.findIndex((r) => r.you && r.at === entry.at && r.score === entry.score) + 1;
    return { rank: rank || null, isBest: prev === null || entry.score > prev, previousBest: prev, board: board(id, 8), score: entry.score };
  }

  return { board, best, submit, get data() { return data; } };
}

// ---------------------------------------------------------------------------
// Glass Breaker targets (far back glass, z = -10). Five panels; three targets lit at a time.

const BACK_Z = -COURT.halfLength;
// QA r5: the score was mostly luck. Now a target's size follows the combo (big while you find the
// timing, the base size from a combo of `shrinkAt`), the hit allowance is its radius + `margin`,
// and the first lit target is the aim of an on-time drive (flagged `aim`, drawn brightest).
export const GLASS_TARGET = Object.freeze({
  radius: 0.7, hitRadius: 0.8, margin: 0.1, startRadius: 0.95, shrinkAt: 8, y: [0.8, 1.4], panels: Object.freeze([-4, -2, 0, 2, 4]), lit: 3,
});

/** Radius (m) of a target lit at this combo: startRadius at 0 down to radius at shrinkAt. */
export function glassTargetRadius(combo = 0) {
  const k = Math.min(1, Math.max(0, combo) / GLASS_TARGET.shrinkAt);
  return GLASS_TARGET.startRadius + (GLASS_TARGET.radius - GLASS_TARGET.startRadius) * k;
}

function makeTarget(rng, x, n, combo = 0) {
  const r = glassTargetRadius(combo);
  const y0 = Math.max(GLASS_TARGET.y[0], r * 0.9);
  return { id: `t${n}`, x: x + rng.range(-0.3, 0.3), y: rng.range(y0, y0 + GLASS_TARGET.y[1] - GLASS_TARGET.y[0]), z: BACK_Z, r, wall: 'back' };
}

// ---------------------------------------------------------------------------
// Drill definitions behind the machine challenges

function porTresDrill(pace = 1) {
  const base = DRILL_BY_ID['smash-x3'];
  return {
    ...base,
    id: 'arcade-por-tres', name: 'Por Tres Party', es: 'Fiesta por tres', reps: 999, interval: 3.6 / Math.sqrt(pace),
    scoring: (shot, r) => {
      const over = ['bandeja', 'vibora', 'smash'].includes(shot.stroke);
      if (r.reason === 'por-tres') return { points: 1000, success: true, notes: ['¡Por tres!'] };
      if (r.reason === 'por-cuatro') return { points: 600, success: true, notes: ['¡Por cuatro!'] };
      if (!r.legal) return { points: 0, success: false, notes: [] };
      if (over && shot.stroke === 'smash' && r.landing && r.landing.z >= -COURT.serviceLine && r.landing.z <= -1) return { points: 250, success: true, notes: ['Smash in'] };
      return { points: over ? 80 : 20, success: false, notes: [] };
    },
  };
}

function volleyDrill() {
  const base = DRILL_BY_ID.volleys;
  return {
    ...base,
    id: 'arcade-volley-wall', name: 'Volley Wall', es: 'Muro de voleas', reps: 999, interval: 1.2,
    feeds: (i, rng, ctx) => {
      const f = base.feeds(i, rng, ctx);
      // Pace rises with every ball: 50-65 km/h at the start, up to ~85 km/h.
      const k = Math.min(1.3, 1 + i * 0.012);
      return { ...f, speedKmh: f.speedKmh * k };
    },
    scoring: (shot, r) => {
      if (shot.afterBounce) return { points: 0, success: false, notes: ['Volley it'] };
      if (!r.legal) return { points: 0, success: false, notes: [] };
      const deep = r.landing && r.landing.z <= -7 && Math.abs(r.landing.x) >= 2.5;
      return { points: deep ? 200 : 100, success: true, notes: [] };
    },
  };
}

function glassDrill(state, pace = 1) {
  const base = DRILL_BY_ID['fh-drive'];
  return {
    ...base,
    id: 'arcade-glass-breaker', name: 'Glass Breaker', es: 'Rompecristales', reps: 999, interval: 2.9 / Math.sqrt(pace),
    targets: [],
    scoring: (shot, r) => {
      if (!r.legal) return { points: 0, success: false, notes: [] };
      for (const w of r.walls || []) {
        if (w.wall !== 'back' || w.surface !== 'glass' || w.side !== 'far' || !w.pos) continue;
        const hit = state.targets.find((t) => Math.hypot(w.pos.x - t.x, w.pos.y - t.y) <= (t.r ?? GLASS_TARGET.radius) + GLASS_TARGET.margin);
        if (hit) {
          state.lastTargetHit = { id: hit.id, pos: { x: w.pos.x, y: w.pos.y, z: w.pos.z }, shotId: shot.id };
          return { points: 300, success: true, notes: ['Target shattered'] };
        }
        return { points: 60, success: false, notes: ['Off the glass – find a target'] };
      }
      return { points: 20, success: false, notes: [] };
    },
    ap: { ...base.ap, aim: { x: -2.4, z: -8.6 } },
  };
}

// ---------------------------------------------------------------------------
// Challenge mode

/**
 * @param {string} id challenge id, or 'daily' / 'daily:YYYY-MM-DD'
 * @param {{ rng?, session?, daily?: object, level?: string, startDelay?: number, duration?: number }} opts
 */
export function createChallengeMode(id, opts = {}) {
  const daily = opts.daily || (String(id).startsWith('daily') ? dailyChallenge(String(id).split(':')[1] || dateKey()) : null);
  const def = CHALLENGE_BY_ID[daily ? daily.base : id] || CHALLENGES[0];
  const rng = opts.rng || createRng(daily ? daily.seed : 0xa4cade);
  const session = opts.session || null;
  const pace = daily ? daily.pace : 1;
  const perfectBonus = daily ? daily.perfectBonus : PERFECT_BONUS;
  const duration = opts.duration ?? (daily ? daily.duration : def.duration);
  const startDelay = opts.startDelay ?? 2.5;
  const level = opts.level || (daily && daily.level) || 'club';
  const boardId = daily ? daily.id : def.id;

  const st = {
    score: 0, combo: 0, maxCombo: 0, perfect: 0, perfectStreak: 0, bestPerfectStreak: 0, hits: 0, scored: 0,
    lives: def.lives || null, finished: false, ended: false, banner: null, bannerUntil: 0, lastAward: null,
    timeUp: false, tStart: null, tEnd: null, targets: [], targetN: 0, shattered: 0, porTres: 0, longest: 0,
    pending: null, lastTargetHit: null, wideStreak: 0, wideAt: -Infinity,
  };
  const perfectById = new Map();
  let inner = null;
  let lastShotRec = null;

  // Glass Breaker: lit targets and where the timing hit should aim (the first lit target).
  function refillTargets(world) {
    while (st.targets.length < GLASS_TARGET.lit) {
      const used = new Set(st.targets.map((t) => Math.round(t.x / 2)));
      const free = GLASS_TARGET.panels.filter((x) => !used.has(Math.round(x / 2)));
      const x = free[Math.floor(rng() * free.length) % free.length];
      st.targets.push(makeTarget(rng, x, ++st.targetN, st.combo));
    }
    emit(world, 'challenge:targets', { targets: st.targets.map((t, i) => ({ ...t, aim: i === 0 })) });
  }

  function buildInner() {
    const common = { rng, session, reps: 999, startDelay, quiet: true };
    switch (def.id) {
      case 'por-tres-party': return createDrillMode(porTresDrill(pace), common);
      case 'glass-breaker':
        // Settled as soon as the return reaches the far back glass (or bounces twice).
        return createDrillMode(glassDrill(st, pace), {
          ...common,
          resolveWhen: (info, e) => !!info.landing && ((e.type === 'wall' && e.wall === 'back') || (e.type === 'bounce' && e.t > info.landingT + 0.05)),
        });
      case 'volley-wall': {
        let launches = 0;
        let nextOk = -Infinity;
        const m = createDrillMode(volleyDrill(), {
          ...common,
          resolveOnLanding: true,
          // Faster and faster: 2.6 s between balls at the start, 1.5 s after ~14 balls.
          gate: (w) => w.time >= nextOk,
        });
        const onBus0 = m.onBus;
        m.onBus = (type, p, w) => {
          if (type === 'judge:launch' && p.by === 'machine') {
            launches++;
            nextOk = w.time + Math.max(1.5, (2.6 - 0.08 * launches) / pace) - 0.6;
          }
          onBus0(type, p, w);
        };
        return m;
      }
      case 'rally-marathon':
      default:
        return createRallyMode({ level, rng, session });
    }
  }

  function setBanner(world, text, kind) {
    st.banner = { text, kind, id: world.time };
    st.bannerUntil = world.time + 1.6;
  }

  function start(world) {
    inner = buildInner();
    inner.start(world);
    st.tStart = world.time + startDelay;
    if (def.id === 'glass-breaker') refillTargets(world);
    emit(world, 'coach:cue', { text: `${daily ? daily.name : def.name}: ${def.desc}`, es: def.descEs, priority: 2 });
  }

  /** Points for one scoring event, with the combo multiplier and the perfect bonus. */
  function award(world, base, { success, perfect = false, label = null, es = null, kind = 'shot' }) {
    if (success) {
      st.combo++;
      st.maxCombo = Math.max(st.maxCombo, st.combo);
    } else if (base <= 0) st.combo = 0;
    const mult = multiplierFor(st.combo);
    const pts = Math.round(base * mult * (perfect ? 1 + perfectBonus : 1));
    st.score += pts;
    if (pts > 0) st.scored++;
    st.lastAward = { points: pts, base, mult, perfect, label, es, at: world.time, kind };
    emit(world, 'challenge:score', { points: pts, base, mult, perfect, combo: st.combo, total: st.score, label, es, kind });
    if (success && COMBO_STEPS.includes(st.combo) && st.combo > 0) emit(world, 'challenge:combo', { combo: st.combo, mult });
    if (label) setBanner(world, pts > 0 ? `${label} +${pts}` : label, pts >= 600 ? 'great' : pts > 0 ? 'good' : 'bad');
    else if (pts > 0) setBanner(world, `+${pts}`, mult > 1 ? 'good' : 'info');
    return pts;
  }

  function onPlayerShot(world, shot) {
    st.hits++;
    lastShotRec = shot;
    const perfect = isPerfectHit(shot);
    perfectById.set(shot.id, perfect);
    if (perfect) {
      st.perfect++;
      st.perfectStreak++;
      st.bestPerfectStreak = Math.max(st.bestPerfectStreak, st.perfectStreak);
      emit(world, 'challenge:perfect', { streak: st.perfectStreak, shotId: shot.id });
    } else st.perfectStreak = 0;
  }

  // Rally marathon: a return counts once the coach has played it (or it beat the coach).
  function marathonBus(type, p, world) {
    if (type === 'judge:hit' && p.team === 0) st.pending = { shotId: p.shot ? p.shot.id : null };
    else if (type === 'judge:hit' && p.team === 1 && st.pending) {
      const rally = inner.state.current || 0;
      const lvl = 1 + Math.floor(rally / 6);
      award(world, 10 * lvl, { success: true, perfect: !!perfectById.get(st.pending.shotId) });
      st.pending = null;
      st.longest = Math.max(st.longest, rally);
      // The coach speeds up with every ball you return.
      if (inner.coach && inner.coach.setPace) inner.coach.setPace(Math.min(1.5, pace * (1 + 0.035 * rally)));
    } else if (type === 'rally:outcome') {
      st.longest = Math.max(st.longest, p.rallyLength || 0);
      if (p.winner === 0) {
        award(world, st.pending ? 150 : 50, { success: true, perfect: !!(st.pending && perfectById.get(st.pending.shotId)), label: 'Winner', es: 'Ganador', kind: 'winner' });
      } else if (p.winner === 1) {
        st.combo = 0;
        if (st.lives !== null) st.lives--;
        setBanner(world, st.lives > 0 ? `${st.lives} ${st.lives === 1 ? 'life' : 'lives'} left` : 'Last rally', 'bad');
      }
      st.pending = null;
      if (inner.coach && inner.coach.setPace) inner.coach.setPace(pace);
    }
  }

  function machineResult(world, r) {
    // shot:result of the inner drill: base points from the challenge scoring.
    if (r.shotId == null) {
      st.combo = 0;
      return;
    }
    const perfect = !!perfectById.get(r.shotId);
    let label = null, es = null, kind = 'shot';
    if (r.reason === 'por-tres') { label = '¡Por tres!'; es = 'Por tres'; kind = 'por-tres'; st.porTres++; }
    else if (r.reason === 'por-cuatro') { label = '¡Por cuatro!'; es = 'Por cuatro'; kind = 'por-cuatro'; st.porTres++; }
    const th = st.lastTargetHit;
    if (def.id === 'glass-breaker' && th && th.shotId === r.shotId) {
      st.lastTargetHit = null;
      const t = st.targets.find((x) => x.id === th.id);
      st.targets = st.targets.filter((x) => x.id !== th.id);
      st.shattered++;
      st.wideStreak = 0;
      label = 'Glass broken';
      es = '¡Cristal roto!';
      kind = 'target';
      const pts = award(world, r.points || 0, { success: !!r.success, perfect, label, es, kind });
      emit(world, 'challenge:target-hit', { id: th.id, pos: th.pos || (t ? { x: t.x, y: t.y, z: t.z } : null), points: pts });
      refillTargets(world);
      return;
    }
    if (def.id === 'glass-breaker' && r.points === 60) {
      st.wideStreak++;
      st.wideAt = world.time;
    }
    award(world, r.points || 0, { success: !!r.success, perfect, label, es, kind });
  }

  function onBus(type, p, world) {
    if (!inner) return;
    inner.onBus(type, p, world);
    if (st.ended) return;
    if (type === 'ball:hit' && p.shot && p.shot.by === 'player' && !p.shot.provisional) onPlayerShot(world, p.shot);
    if (def.id === 'rally-marathon') marathonBus(type, p, world);
    else if (type === 'shot:result') machineResult(world, p);
  }

  function update(world, dt) {
    if (!inner || st.finished) return;
    inner.update(world, dt);
    if (st.banner && world.time > st.bannerUntil) st.banner = null;
    const left = timeLeft(world);
    const outOfLives = st.lives !== null && st.lives <= 0;
    if (!st.timeUp && (left <= 0 || outOfLives)) {
      st.timeUp = true;
      st.tEnd = world.time;
      if (inner.stopFeeding) inner.stopFeeding();
      setBanner(world, outOfLives ? 'Out of lives' : 'Time!', 'info');
    }
    if (st.timeUp && !st.finished) {
      const settled = def.id === 'rally-marathon' ? !world.referee || world.referee.state.phase === 'dead' || outOfLives : inner.settled;
      if (settled || world.time - st.tEnd > 8) finish(world);
    }
  }

  function timeLeft(world) {
    if (st.tStart === null) return duration;
    if (st.timeUp) return 0;
    return Math.max(0, duration - Math.max(0, world.time - st.tStart));
  }

  function finish(world) {
    if (st.ended) return;
    st.finished = true;
    st.ended = true;
    emit(world, 'challenge:end', { summary: summary(world) });
  }

  function summary(world = null) {
    const base = inner && inner.summary ? inner.summary(world) : {};
    return {
      mode: 'challenge', challengeId: def.id, boardId, daily: daily || null, name: daily ? daily.name : def.name, es: daily ? daily.es : def.es,
      score: st.score, maxCombo: st.maxCombo, perfect: st.perfect, bestPerfectStreak: st.bestPerfectStreak, hits: st.hits, scored: st.scored,
      shattered: st.shattered, porTres: st.porTres, longestRally: Math.max(st.longest, base.bestRally || 0), lives: st.lives, duration,
      misses: base.misses || {}, results: base.results || [], targets: base.targets || [], session: session ? session.summary() : null,
    };
  }

  // Glass Breaker: for the first seconds (and again after a few balls off the glass but wide of
  // every target) say which target is the aim and what the timing does.
  function aimPrompt(world) {
    if (def.id !== 'glass-breaker' || !world || st.tStart === null || !st.targets.length) return null;
    const since = world.time - st.tStart;
    if (since > 7 && !(st.wideStreak >= 3 && world.time - st.wideAt < 4)) return null;
    const t = st.targets[0];
    const side = t.x < -1.2 ? 'left' : t.x > 1.2 ? 'right' : 'middle';
    return `Bright target (${side}) is your aim · early = cross-court · late = down the line`;
  }

  function hud(world) {
    const h = inner ? inner.hud(world) : {};
    const left = world ? timeLeft(world) : duration;
    const waiting = world && st.tStart !== null && world.time < st.tStart;
    return {
      ...h,
      ...(world ? timingHud(world) : {}),
      title: daily ? daily.name : def.name,
      subtitle: daily ? `${daily.twist.en} · ${def.es}` : `Arcade · ${def.es}`,
      repIndex: null,
      repTotal: null,
      points: st.score,
      streak: st.combo,
      rally: undefined,
      timer: left,
      score: null,
      banner: st.banner || null,
      prompt: waiting ? `Get ready · ${Math.ceil(st.tStart - world.time)}` : h.prompt || aimPrompt(world),
      challenge: {
        id: def.id, timeLeft: left, duration, combo: st.combo, mult: multiplierFor(st.combo), lives: st.lives, maxLives: def.lives || null,
        perfectStreak: st.perfectStreak, lastAward: st.lastAward, targets: st.targets.length, rally: def.id === 'rally-marathon' && inner ? inner.state.current : null,
      },
    };
  }

  return {
    id: `challenge:${def.id}`,
    challenge: def,
    daily,
    boardId,
    get drill() { return inner && inner.drill ? inner.drill : null; },
    get activeDrill() { return inner && inner.activeDrill ? inner.activeDrill : null; },
    get apHints() {
      const h = inner && inner.apHints ? inner.apHints : null;
      if (def.id === 'glass-breaker' && h && st.targets.length) {
        // Aim for the lit target: a deep drive that bounces ~2 m off the glass in line with it.
        const t = st.targets[0];
        return { ...h, aim: { x: Math.max(-4.2, Math.min(4.2, t.x)), z: -8.2 } };
      }
      return h;
    },
    get tactics() { return inner ? inner.tactics : null; },
    get coach() { return inner ? inner.coach : null; },
    get referee() { return inner ? inner.referee : null; },
    get state() { return st; },
    get inner() { return inner; },
    get targets() { return st.targets; },
    start,
    update,
    onBus,
    hud,
    isFinished: () => st.finished,
    summary,
    timeLeft,
  };
}
