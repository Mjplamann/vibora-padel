// Instant replay: a 60 Hz ring buffer of the last few seconds (ball, player, tracked racket,
// AI actors, machine head) and a slow-motion player that rebuilds world-shaped frames for
// the renderer. The player appears as a humanoid whose stroke animation is keyed to the real
// contact times, with the tracked racket path drawn around it. Pure module.
import { RACKET } from '../config.js';

const SWING = {
  forehand: 0.9, backhand: 0.9, 'glass-fh': 0.9, 'glass-bh': 0.9, 'volley-fh': 0.6, 'volley-bh': 0.6,
  bandeja: 0.9, vibora: 0.9, smash: 0.85, lob: 0.9, chiquita: 0.8, serve: 1.0,
};
const CONTACT_PHASE = { smash: 0.6, serve: 0.6 };

const v3o = (v) => ({ x: v.x, y: v.y, z: v.z });

// Upper-body joints recorded for the replay body (render/fpBody.js createTrackedPoser).
const REPLAY_JOINTS = ['nose', 'earL', 'earR', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR', 'indexL', 'indexR', 'pinkyL', 'pinkyR', 'hipL', 'hipR'];
function packJoints(bc) {
  if (!bc || !bc.joints) return null;
  const out = new Float32Array(REPLAY_JOINTS.length * 3);
  REPLAY_JOINTS.forEach((n, i) => {
    const j = bc.joints[n];
    out[i * 3] = j ? j.x : NaN;
    out[i * 3 + 1] = j ? j.y : NaN;
    out[i * 3 + 2] = j ? j.z : NaN;
  });
  return out;
}
function lerpJoints(a, b, u, dominant) {
  const joints = {};
  REPLAY_JOINTS.forEach((n, i) => {
    const k = i * 3;
    if (!Number.isFinite(a[k]) || !Number.isFinite(b[k])) return;
    joints[n] = { x: a[k] + (b[k] - a[k]) * u, y: a[k + 1] + (b[k + 1] - a[k + 1]) * u, z: a[k + 2] + (b[k + 2] - a[k + 2]) * u };
  });
  return { joints, dominant: dominant || 'R' };
}

function copyActorState(s) {
  return {
    pos: { x: s.pos.x, y: 0, z: s.pos.z },
    vel: { x: s.vel ? s.vel.x : 0, y: 0, z: s.vel ? s.vel.z : 0 },
    facing: s.facing || 0,
    stroke: s.stroke || null,
    swingPhase: s.swingPhase || 0,
    holding: s.holding || 'ready',
    handed: s.handed || 'right',
    team: s.team,
    name: s.name,
  };
}

export function createRecorder({ seconds = 6, hz = 60 } = {}) {
  const cap = Math.ceil(seconds * hz) + 2;
  const frames = new Array(cap);
  let head = 0;
  let len = 0;
  let nextAt = -Infinity;
  const hits = [];
  let rewriteAfter = null;

  function record(world) {
    if (rewriteAfter !== null) rewrite(world);
    if (world.time < nextAt - 1e-9) return;
    nextAt = world.time + 1 / hz;
    const b = world.ball;
    const pl = world.player;
    const r = pl.racket;
    const actors = [];
    if (world.coach) actors.push({ key: world.coach, state: copyActorState(world.coach.state), static: !!world.coach.static });
    for (const a of world.ai) actors.push({ key: a, state: copyActorState(a.state), static: !!a.static });
    const m = world.machine;
    const f = {
      t: world.time,
      ball: b ? { pos: v3o(b.pos), vel: v3o(b.vel), spin: v3o(b.spin), id: b.id, atRest: b.atRest, outside: b.outside } : null,
      player: {
        pos: { x: pl.pos.x, y: 0, z: pl.pos.z },
        vel: { x: pl.vel.x, y: 0, z: pl.vel.z },
        eye: v3o(pl.eye),
        height: pl.height,
        handed: pl.handed,
        racket: r ? { grip: v3o(r.grip), axis: v3o(r.axis), normal: v3o(r.normal) } : null,
        joints: packJoints(pl.bodyCourt),
        dominant: pl.bodyCourt ? pl.bodyCourt.dominant : null,
      },
      actors,
      machine: m ? { pos: { x: m.pos.x, y: m.pos.y, z: m.pos.z }, state: { headYaw: m.state.headYaw, headPitch: m.state.headPitch } } : null,
    };
    frames[head] = f;
    head = (head + 1) % cap;
    if (len < cap) len++;
  }

  /**
   * A player hit: the frames recorded after its contact show the erased path of the
   * lag-compensated ball. They are rewritten from the corrected ball history at the next
   * record() (the hit is announced before the world has re-simulated to the present).
   */
  function onHit(shot) {
    if (shot.by !== 'player') return;
    hits.push({ t: shot.t, stroke: shot.stroke });
    if (hits.length > 24) hits.shift();
    rewriteAfter = rewriteAfter === null ? shot.t : Math.min(rewriteAfter, shot.t);
  }

  function rewrite(world) {
    const hist = world.ballHistory;
    const t0 = rewriteAfter;
    rewriteAfter = null;
    if (!hist) return;
    for (let i = len - 1; i >= 0; i--) {
      const f = frames[(head - len + i + cap) % cap];
      if (!f || f.t <= t0 + 1e-9) break;
      const b = hist.at(f.t);
      if (b) f.ball = { pos: v3o(b.pos), vel: v3o(b.vel), spin: v3o(b.spin), id: b.id, atRest: b.atRest, outside: b.outside };
    }
  }

  /** Copy of the buffer: { frames (oldest first), hits, t0, t1 } or null when empty. */
  function snapshot() {
    if (len < 2) return null;
    const out = [];
    for (let i = 0; i < len; i++) out.push(frames[(head - len + i + cap) % cap]);
    return { frames: out, hits: hits.slice(), t0: out[0].t, t1: out[out.length - 1].t };
  }

  return {
    record,
    onHit,
    snapshot,
    clear() {
      len = 0;
      head = 0;
      nextAt = -Infinity;
      hits.length = 0;
      rewriteAfter = null;
    },
    get length() { return len; },
  };
}

const lerp = (a, b, u) => a + (b - a) * u;
function lerpV(a, b, u, out = {}) {
  out.x = lerp(a.x, b.x, u);
  out.y = lerp(a.y, b.y, u);
  out.z = lerp(a.z, b.z, u);
  return out;
}
function nlerpV(a, b, u, out = {}) {
  lerpV(a, b, u, out);
  const n = Math.hypot(out.x, out.y, out.z) || 1;
  out.x /= n; out.y /= n; out.z /= n;
  return out;
}

/**
 * Slow-motion playback of a snapshot.
 * @param snap recorder.snapshot()
 * @param o { rate = 0.4, from (sim t) }
 */
export function createReplayPlayer(snap, { rate = 0.4, from = null, to = null } = {}) {
  const frames = snap.frames;
  const start = from != null ? Math.max(snap.t0, from) : snap.t0;
  // Optional end of the clip (a highlight stops shortly after its moment).
  const end = to != null ? Math.max(start + 0.5, Math.min(snap.t1, to)) : snap.t1;
  let t = start;
  let loops = 0;
  let idx = 0;

  function find(time) {
    if (idx >= frames.length - 1 || frames[idx].t > time) idx = 0;
    while (idx < frames.length - 2 && frames[idx + 1].t <= time) idx++;
    return idx;
  }

  function strokeAt(time) {
    for (const h of snap.hits) {
      const dur = SWING[h.stroke] || 0.9;
      const cp = CONTACT_PHASE[h.stroke] || 0.55;
      const phase = cp + (time - h.t) / dur;
      if (phase >= 0 && phase <= 1) return { stroke: h.stroke, swingPhase: phase };
    }
    return null;
  }

  /** Builds the world-shaped frame at the current replay time. */
  function frame() {
    const i = find(t);
    const a = frames[i];
    const b = frames[Math.min(frames.length - 1, i + 1)];
    const u = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    let ball = null;
    if (a.ball && b.ball && a.ball.id === b.ball.id) {
      ball = { pos: lerpV(a.ball.pos, b.ball.pos, u), vel: lerpV(a.ball.vel, b.ball.vel, u), spin: a.ball.spin, id: a.ball.id, atRest: a.ball.atRest, outside: a.ball.outside };
    } else if (a.ball) ball = { ...a.ball };
    const pa = a.player, pb = b.player;
    const player = {
      pos: lerpV(pa.pos, pb.pos, u),
      vel: lerpV(pa.vel, pb.vel, u),
      eye: lerpV(pa.eye, pb.eye, u),
      height: pa.height,
      handed: pa.handed,
      racket: pa.racket && pb.racket ? {
        grip: lerpV(pa.racket.grip, pb.racket.grip, u),
        axis: nlerpV(pa.racket.axis, pb.racket.axis, u),
        normal: nlerpV(pa.racket.normal, pb.racket.normal, u),
      } : pa.racket,
      bodyCourt: pa.joints && pb.joints ? lerpJoints(pa.joints, pb.joints, u, pa.dominant) : null,
    };
    const actors = a.actors.map((e) => {
      const eb = b.actors.find((x) => x.key === e.key);
      if (!eb) return e;
      const s = { ...e.state, pos: lerpV(e.state.pos, eb.state.pos, u), vel: lerpV(e.state.vel, eb.state.vel, u) };
      if (e.state.stroke === eb.state.stroke && eb.state.swingPhase >= e.state.swingPhase) s.swingPhase = lerp(e.state.swingPhase, eb.state.swingPhase, u);
      return { key: e.key, state: s, static: e.static };
    });
    const sw = strokeAt(t);
    const speed = Math.hypot(player.vel.x, player.vel.z);
    const selfActor = {
      pos: player.pos, vel: player.vel, facing: Math.PI, handed: player.handed,
      stroke: sw ? sw.stroke : null, swingPhase: sw ? sw.swingPhase : 0,
      holding: sw ? 'swing' : speed > 0.6 ? 'run' : 'ready',
    };
    // Tracked racket path over the last half second.
    const path = [];
    for (let k = i; k >= 0 && frames[k].t > t - 0.5; k--) {
      const r = frames[k].player.racket;
      if (r) path.unshift({ x: r.grip.x + r.axis.x * RACKET.sweetSpotY, y: r.grip.y + r.axis.y * RACKET.sweetSpotY, z: r.grip.z + r.axis.z * RACKET.sweetSpotY });
    }
    return {
      world: { time: t, ball, player, actors, machine: a.machine ? { pos: a.machine.pos, state: a.machine.state } : null, coach: null, ai: null },
      selfActor,
      racketPath: path,
      ghostPose: player.racket,
      progress: (t - start) / Math.max(1e-6, end - start),
    };
  }

  return {
    /** Advances by real dt; returns false once the clip has looped `maxLoops` times. */
    step(dtReal, maxLoops = 2) {
      t += dtReal * rate;
      if (t > end) {
        loops++;
        t = start;
        idx = 0;
      }
      return loops < maxLoops;
    },
    frame,
    /** Jumps to sim time `to` (clamped to the clip). */
    seek(at) {
      t = Math.min(end, Math.max(start, at));
      idx = 0;
    },
    /** Contact times of the player's hits inside the clip. */
    get hits() { return snap.hits.filter((h) => h.t >= start && h.t <= end).map((h) => h.t); },
    get t() { return t; },
    get rate() { return rate; },
    set rate(r) { rate = r; },
    get loops() { return loops; },
    get duration() { return end - start; },
  };
}

// ---------------------------------------------------------------------------
// Replay director: picks the special moments worth an automatic slow-motion replay from the
// session's bus events: a por tres / por cuatro, a smash winner or a winner by the player in a
// rally or match, a won rally of 20+ shots, a streak of perfect-timing hits, a shattered glass
// target. Pure.
//
// QA r5: replays interrupted about one match point in three (7.6 per 10 min: every 15-shot rally,
// either side's). Now only the player's pair's highlights count, a long rally needs 20 shots and the
// point won, and a match replays at most one moment per game (the best one), rally mode one per 2 min.

/** Moment kinds, by priority (higher wins when two fall in the same window). */
export const REPLAY_MOMENTS = Object.freeze({
  'por-tres': Object.freeze({ priority: 5, label: '¡Por tres!', es: 'Por tres', views: Object.freeze(['side', 'broadcast']), rate: 0.35 }),
  'por-cuatro': Object.freeze({ priority: 5, label: '¡Por cuatro!', es: 'Por cuatro', views: Object.freeze(['broadcast', 'side']), rate: 0.35 }),
  smash: Object.freeze({ priority: 4.5, label: 'Smash winner', es: 'Remate ganador', views: Object.freeze(['side', 'broadcast']), rate: 0.35 }),
  'long-rally': Object.freeze({ priority: 4, label: 'What a rally', es: 'Peloteo de', views: Object.freeze(['broadcast', 'ball']), rate: 0.5 }),
  winner: Object.freeze({ priority: 3, label: 'Winner', es: 'Ganador', views: Object.freeze(['broadcast', 'side']), rate: 0.4 }),
  target: Object.freeze({ priority: 3, label: 'Glass broken', es: 'Cristal roto', views: Object.freeze(['ball', 'broadcast']), rate: 0.4 }),
  perfect: Object.freeze({ priority: 2, label: 'Perfect timing', es: 'Golpes perfectos', views: Object.freeze(['side', 'broadcast']), rate: 0.4 }),
});
export const LONG_RALLY = 20;
export const PERFECT_STREAK = 3;
const SMASH_STROKES = new Set(['smash', 'vibora']);

/**
 * @param {{ minGap?: number, kinds?: string[], perGame?: boolean }} o minGap: sim s between two
 *   automatic replays; kinds: which moments may trigger (default all); perGame: at most one replay per
 *   game of a match (a `rally:outcome` with `gameWon` closes the game). The app asks take(world) once
 *   the ball is dead.
 */
export function createReplayDirector({ minGap = 20, kinds = null, perGame = false } = {}) {
  let pending = null;
  let lastAt = -Infinity;
  let lastPlayerHitT = null;
  let lastPlayerStroke = null;
  let perfectRun = 0;
  let game = 0; // games completed (match): a replay belongs to the game of its moment
  let replayedGame = -1;
  const allowed = (k) => !kinds || kinds.includes(k);

  function offer(kind, t, extra = {}) {
    if (!allowed(kind) || !REPLAY_MOMENTS[kind]) return;
    if (perGame && replayedGame === game) return;
    const m = REPLAY_MOMENTS[kind];
    if (pending && REPLAY_MOMENTS[pending.kind].priority >= m.priority) return;
    pending = { kind, t: t ?? lastPlayerHitT, label: m.label, es: m.es, views: m.views, rate: m.rate, priority: m.priority, game, ...extra };
  }

  /** Every bus event of the session (world.bus). */
  function onBus(type, p, world) {
    if (!p) return;
    if (type === 'ball:hit' && p.shot && p.shot.by === 'player' && !p.shot.provisional) {
      lastPlayerHitT = p.shot.t;
      lastPlayerStroke = p.shot.stroke || null;
    } else if (type === 'challenge:perfect' || type === 'timing:perfect') {
      perfectRun = p.streak || perfectRun + 1;
      if (perfectRun === PERFECT_STREAK || (perfectRun > PERFECT_STREAK && perfectRun % 5 === 0)) {
        offer('perfect', lastPlayerHitT, { label: `Perfect timing ×${perfectRun}`, es: `${perfectRun} golpes perfectos` });
      }
    } else if (type === 'challenge:target-hit') {
      offer('target', lastPlayerHitT);
    } else if (type === 'rally:outcome') {
      // Only the player's own winning shot (not the partner's, not an opponent's error) is a highlight;
      // a long rally must be won by the player's pair.
      const mine = p.winner === 0 && (p.lastBy === 'player' || p.lastBy === undefined);
      const won = p.winner === 0;
      const len = Number.isFinite(p.rallyLength) ? p.rallyLength : 0;
      if ((p.reason === 'por-tres' || p.reason === 'por-cuatro') && mine) offer(p.reason, lastPlayerHitT);
      else if (mine && p.lastBy === 'player' && (p.reason === 'double-bounce' || p.reason === 'winner') && SMASH_STROKES.has(lastPlayerStroke)) offer('smash', lastPlayerHitT);
      else if (won && len >= LONG_RALLY) offer('long-rally', lastPlayerHitT, { label: `${len}-shot rally`, es: `Peloteo de ${len}` });
      else if (mine && p.lastBy === 'player' && (p.reason === 'double-bounce' || p.reason === 'winner')) offer('winner', lastPlayerHitT);
      if (p.gameWon) game++;
    }
    if (world && pending && pending.at === undefined) pending.at = world.time;
  }

  /**
   * The moment to replay now, or null. Call when the ball is dead (between points / reps):
   * respects minGap and drops moments older than 6 s (the recorder keeps 6 s).
   */
  function take(world) {
    if (!pending) return null;
    const now = world ? world.time : 0;
    if (pending.t === null || pending.t === undefined || now - pending.t > 5.5) {
      pending = null;
      return null;
    }
    if (now - lastAt < minGap) {
      pending = null;
      return null;
    }
    const m = pending;
    pending = null;
    lastAt = now;
    replayedGame = m.game;
    return m;
  }

  return {
    onBus,
    take,
    get pending() { return pending; },
    clear() { pending = null; perfectRun = 0; },
    resetPerfect() { perfectRun = 0; },
  };
}
