// Training session statistics: shot log, per-stroke aggregates, landing map,
// streaks, energy estimate and per-drill bests persisted through an injected
// storage ({ getItem, setItem }, e.g. window.localStorage). Pure module.
//
// Energy: kcal = MET x body mass (kg) x active hours x movement scale.
// Padel is ~7 MET (Compendium of Physical Activities, racquet sports, doubles
// at a club level). Active time is time with the ball in play. The movement
// scale compares the user's mean real-world body speed while the ball is in
// play with a reference; with no movement data it is 1 (plain MET formula).

const STORAGE_PREFIX = 'vibora.best.';
const MAX_LANDINGS = 2000;
// Shot gaps up to this long count as ball-in-play when time is estimated from shots.
const MAX_INPLAY_GAP = 6;
// Ball-in-play time credited after a rally's last shot when estimating from shots.
const TAIL_SECONDS = 1.5;
// Mean real body speed (m/s) during play that corresponds to a movement scale of 1.
const REF_REAL_SPEED = 0.5;
const MIN_MOVE_SCALE = 0.6;
const MAX_MOVE_SCALE = 1.25;

function finiteOr(v, d) {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function mean(sum, n) {
  return n > 0 ? sum / n : null;
}

/**
 * @param {object} o
 * @param {{getItem(k:string):string|null, setItem(k:string,v:string):void}|null} [o.storage]
 * @param {number} [o.weightKg=70]
 * @param {number} [o.met=7]
 * @param {() => number} [o.now] wall clock in ms for best timestamps (default Date.now)
 */
export function createSession({ storage = null, weightKg = 70, met = 7.0, now = () => Date.now() } = {}) {
  let log = [];
  let strokes = new Map();
  let landings = [];
  let streak = 0;
  let longestStreak = 0;
  let bestRally = 0;
  let totalPoints = 0;
  let successes = 0;
  let reactionSum = 0;
  let reactionN = 0;
  let prepOn = 0;
  let prepN = 0;
  let activeSeconds = 0; // from tick()
  let moveDistance = 0; // real meters walked while in play, from tick()
  let moveSeconds = 0; // in-play seconds that carried a realSpeed sample
  const bestCache = new Map();

  function strokeAgg(stroke) {
    let a = strokes.get(stroke);
    if (!a) {
      a = { count: 0, speedSum: 0, speedN: 0, spinSum: 0, spinN: 0, success: 0, qualitySum: 0, qualityN: 0 };
      strokes.set(stroke, a);
    }
    return a;
  }

  /**
   * Adds one stroke. `shot` is a ShotRecord (SPEC §5.1); non-player shots are
   * ignored. `result` is the drill/rally verdict, all fields optional:
   * { success, inTarget, points, landing: {x,z}, rallyLength, reactionMs, prepOnTime, notes }.
   * Returns the stored log entry, or null if ignored.
   */
  function record(shot, result = {}) {
    if (!shot || (shot.by && shot.by !== 'player')) return null;
    const r = result || {};
    const success = !!(r.success ?? r.inTarget ?? false);
    const stroke = shot.stroke || 'unknown';
    const speedKmh = finiteOr(shot.speedOut, null) === null ? null : shot.speedOut * 3.6;
    const spinRpm = finiteOr(shot.spinRpm && shot.spinRpm.total, null);
    const quality = finiteOr(shot.quality, null);

    const a = strokeAgg(stroke);
    a.count++;
    if (speedKmh !== null) { a.speedSum += speedKmh; a.speedN++; }
    if (spinRpm !== null) { a.spinSum += Math.abs(spinRpm); a.spinN++; }
    if (quality !== null) { a.qualitySum += quality; a.qualityN++; }
    if (success) a.success++;

    if (success) {
      successes++;
      streak++;
      if (streak > longestStreak) longestStreak = streak;
    } else {
      streak = 0;
    }
    totalPoints += finiteOr(r.points, 0);

    const landing = r.landing || null;
    if (landing && Number.isFinite(landing.x) && Number.isFinite(landing.z)) {
      landings.push({ x: landing.x, z: landing.z, success });
      if (landings.length > MAX_LANDINGS) landings.shift();
    }

    const rally = finiteOr(r.rallyLength, 0);
    if (rally > bestRally) bestRally = rally;

    const reaction = finiteOr(r.reactionMs ?? shot.reactionMs, null);
    if (reaction !== null) { reactionSum += reaction; reactionN++; }
    const prep = r.prepOnTime ?? shot.prepOnTime;
    if (typeof prep === 'boolean') { prepN++; if (prep) prepOn++; }

    const entry = {
      t: finiteOr(shot.t, null),
      stroke,
      speedKmh,
      spinRpm,
      quality,
      success,
      points: finiteOr(r.points, 0),
      timing: shot.timing || null,
      spacing: shot.spacing || null,
      notes: Array.isArray(r.notes) ? r.notes.slice() : [],
    };
    log.push(entry);
    return entry;
  }

  /** Records a finished rally's length (strokes by both sides). */
  function rallyEnded(length) {
    const n = finiteOr(length, 0);
    if (n > bestRally) bestRally = n;
  }

  /**
   * Accumulates active time. Call every frame (or tick) with
   * { inPlay: ball currently in play, realSpeed: user's real-world body speed m/s }.
   */
  function tick(dt, { inPlay = true, realSpeed = null } = {}) {
    if (!(dt > 0) || !inPlay) return;
    activeSeconds += dt;
    if (typeof realSpeed === 'number' && Number.isFinite(realSpeed)) {
      moveDistance += Math.max(0, realSpeed) * dt;
      moveSeconds += dt;
    }
  }

  /** Ball-in-play time estimated from shot timestamps (used when tick() was never fed). */
  function estimateActiveFromShots() {
    let total = 0;
    let prev = null;
    for (const e of log) {
      if (e.t === null) continue;
      if (prev !== null) {
        const gap = e.t - prev;
        total += gap >= 0 && gap <= MAX_INPLAY_GAP ? gap : TAIL_SECONDS;
      }
      prev = e.t;
    }
    if (prev !== null) total += TAIL_SECONDS;
    return total;
  }

  function movementScale() {
    if (moveSeconds <= 0) return 1;
    const avg = moveDistance / moveSeconds;
    const s = MIN_MOVE_SCALE + (1 - MIN_MOVE_SCALE) * (avg / REF_REAL_SPEED);
    return Math.min(MAX_MOVE_SCALE, Math.max(MIN_MOVE_SCALE, s));
  }

  function summary() {
    const byStroke = {};
    for (const [stroke, a] of strokes) {
      byStroke[stroke] = {
        count: a.count,
        avgSpeedKmh: mean(a.speedSum, a.speedN),
        avgSpinRpm: mean(a.spinSum, a.spinN),
        successRate: a.count ? a.success / a.count : 0,
        avgQuality: mean(a.qualitySum, a.qualityN),
      };
    }
    const active = activeSeconds > 0 ? activeSeconds : estimateActiveFromShots();
    const moveScale = movementScale();
    return {
      shots: log.length,
      byStroke,
      landings: landings.map((l) => ({ ...l })),
      bestRally,
      longestStreak,
      currentStreak: streak,
      points: totalPoints,
      successRate: log.length ? successes / log.length : 0,
      avgReactionMs: mean(reactionSum, reactionN),
      prepOnTimeRate: prepN ? prepOn / prepN : null,
      activeSeconds: active,
      movementScale: moveScale,
      kcal: met * weightKg * (active / 3600) * moveScale,
    };
  }

  // ---- bests (persisted) --------------------------------------------------

  function readBest(drillId) {
    if (bestCache.has(drillId)) return bestCache.get(drillId);
    let rec = null;
    if (storage) {
      try {
        const raw = storage.getItem(STORAGE_PREFIX + drillId);
        if (raw) {
          const parsed = JSON.parse(raw);
          const pts = typeof parsed === 'number' ? parsed : parsed && parsed.points;
          if (Number.isFinite(pts)) rec = { points: pts, at: finiteOr(parsed.at, null) };
        }
      } catch {
        rec = null; // unavailable storage or corrupt value
      }
    }
    bestCache.set(drillId, rec);
    return rec;
  }

  /** Best points for a drill, or null when none recorded. */
  function bests(drillId) {
    const rec = readBest(drillId);
    return rec ? rec.points : null;
  }

  /** Stores `points` if it beats the previous best. -> { isNew, best, previous } */
  function saveBest(drillId, points) {
    const prev = readBest(drillId);
    const previous = prev ? prev.points : null;
    if (!Number.isFinite(points) || (previous !== null && points <= previous)) {
      return { isNew: false, best: previous, previous };
    }
    const rec = { points, at: now() };
    bestCache.set(drillId, rec);
    if (storage) {
      try {
        storage.setItem(STORAGE_PREFIX + drillId, JSON.stringify(rec));
      } catch {
        // quota exceeded / private mode: keep the in-memory best for this session
      }
    }
    return { isNew: true, best: points, previous };
  }

  function reset() {
    log = [];
    strokes = new Map();
    landings = [];
    streak = longestStreak = bestRally = totalPoints = successes = 0;
    reactionSum = reactionN = prepOn = prepN = 0;
    activeSeconds = moveDistance = moveSeconds = 0;
  }

  return {
    record,
    rallyEnded,
    tick,
    summary,
    bests,
    saveBest,
    reset,
    get log() {
      return log;
    },
  };
}
