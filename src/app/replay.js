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
export function createReplayPlayer(snap, { rate = 0.4, from = null } = {}) {
  const frames = snap.frames;
  const start = from != null ? Math.max(snap.t0, from) : snap.t0;
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
      bodyCourt: null,
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
      progress: (t - start) / Math.max(1e-6, snap.t1 - start),
    };
  }

  return {
    /** Advances by real dt; returns false once the clip has looped `maxLoops` times. */
    step(dtReal, maxLoops = 2) {
      t += dtReal * rate;
      if (t > snap.t1) {
        loops++;
        t = start;
        idx = 0;
      }
      return loops < maxLoops;
    },
    frame,
    /** Jumps to sim time `to` (clamped to the clip). */
    seek(to) {
      t = Math.min(snap.t1, Math.max(start, to));
      idx = 0;
    },
    /** Contact times of the player's hits inside the clip. */
    get hits() { return snap.hits.filter((h) => h.t >= start && h.t <= snap.t1).map((h) => h.t); },
    get t() { return t; },
    get rate() { return rate; },
    set rate(r) { rate = r; },
    get loops() { return loops; },
    get duration() { return snap.t1 - start; },
  };
}
