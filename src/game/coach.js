// AI padel player (SPEC §5.3): the coach on the far side, and the same brain for the AI
// partner / opponents in match mode. It reads the ball with predict + interceptCandidates
// once its reaction time has elapsed, runs (speed and acceleration limited) to a stance
// that puts the ball at its ideal contact point, swings so the stroke animation peaks at
// contact, strikes with a solved shot plus level-dependent error, then recovers.
// It respects the rules: only its own team's turn, never volleys a serve, can play off
// its own glass (after-wall candidates). Pure module.

import { Vec3, v3 } from '../util/vec3.js';
import { clamp, createRng } from '../util/math.js';
import { COURT, PLAYER } from '../config.js';
import { predict, interceptCandidates, solveShot } from '../physics/predict.js';
import { spinFromComponents } from '../physics/racket.js';
import { applyAiHit, launchBall, emit, predictFlight, currentStroke } from './world.js';
import { CONTACT_OFFSETS } from './human.js';

/**
 * Level presets. sigma: landing error (m, per axis); kmh: drive pace window; topRpm:
 * drive topspin window; maxSpeed / accel: court movement; reaction: s before reading the
 * ball; smash: share of high balls put away with a smash; lob / chiquita: shares against
 * net players; err: unforced-error probability of a routine ball (scaled by difficulty);
 * kill: share of high net volleys that are put away at an angle.
 */
export const COACH_LEVELS = Object.freeze({
  rookie: Object.freeze({ sigma: 0.8, kmh: [45, 60], topRpm: [200, 900], maxSpeed: 4.2, accel: 10, reaction: 0.35, smash: 0, lob: 0.45, chiquita: 0.2, err: 0.1, kill: 0.15 }),
  club: Object.freeze({ sigma: 0.5, kmh: [60, 80], topRpm: [500, 1500], maxSpeed: 5.0, accel: 12, reaction: 0.25, smash: 0.25, lob: 0.45, chiquita: 0.35, err: 0.05, kill: 0.35 }),
  pro: Object.freeze({ sigma: 0.25, kmh: [85, 100], topRpm: [900, 2200], maxSpeed: 5.5, accel: 14, reaction: 0.18, smash: 0.6, lob: 0.45, chiquita: 0.35, err: 0.025, kill: 0.55 }),
});

/**
 * Underhand serve spin per level (rpm): slice (backspin) and sidespin windows; the side
 * sign is random (cut inside-out or across). Real padel serves are sliced, rarely flat.
 */
export const SERVE_SPIN = Object.freeze({
  rookie: Object.freeze({ slice: [200, 400], side: [300, 600] }),
  club: Object.freeze({ slice: [250, 600], side: [300, 900] }),
  pro: Object.freeze({ slice: [300, 800], side: [500, 1200] }),
});
/** Hand feeds carry a little sidespin (rpm, either way). */
export const FEED_SIDE_RPM = 200;

/** Ready depth (|z|, m) at the net and at the back. */
export const NET_Z = 3.2;
export const BACK_Z = 7.4;

/** Stroke animation length (s) and the phase at which the ball is struck (humanoid keys). */
const SWING = {
  forehand: [0.9, 0.55], backhand: [0.9, 0.55], 'glass-fh': [0.9, 0.55], 'glass-bh': [0.9, 0.55],
  'volley-fh': [0.6, 0.55], 'volley-bh': [0.6, 0.55], bandeja: [0.9, 0.55], vibora: [0.9, 0.55],
  smash: [0.85, 0.6], lob: [0.9, 0.55], chiquita: [0.8, 0.55], serve: [1.0, 0.6],
};

const HW = COURT.halfWidth;
const SAFE_X = 3.6; // lateral aim window (m): about 1.4 m inside the side walls

/**
 * @param {object} o
 * @param {'rookie'|'club'|'pro'} [o.level]
 * @param {Function} [o.rng]
 * @param {'far'|'near'} [o.side] half it defends
 * @param {0|1} [o.team]
 * @param {'coach'|'ai'} [o.by] hitter tag in ShotRecords
 * @param {{x,z}} [o.home] ready position (default (0, ∓7.5))
 * @param {Vec3} [o.bindPos] share this position vector (e.g. world.player.pos for an auto player)
 * @param {Vec3} [o.bindVel]
 * @param {(pos:Vec3)=>boolean} [o.covers] which contacts this actor is responsible for (doubles)
 * @param {(world)=>Array<{x,z}>} [o.opponents] positions of the players it hits against
 */
export function createCoach({
  level = 'club', rng = createRng(0xc0ac4), side = 'far', team = null, by = 'coach', home = null,
  handed = 'right', bindPos = null, bindVel = null, covers = null, opponents = null, name = null,
} = {}) {
  const L = COACH_LEVELS[level] || COACH_LEVELS.club;
  const sz = side === 'far' ? -1 : 1; // sign of z on our half
  const tm = team ?? (side === 'far' ? 1 : 0);
  const baseFacing = side === 'far' ? 0 : Math.PI;
  const dom = handed === 'left' ? -1 : 1;
  const homePos = { x: home ? home.x : 0, z: home ? home.z : 7.5 * sz };

  const pos = bindPos || v3(homePos.x, 0, homePos.z);
  const vel = bindVel || v3();
  const state = {
    pos, vel, facing: baseFacing, stroke: null, swingPhase: 0, swingT: 0, holding: 'ready',
    racket: { grip: v3(), axis: v3(0, 1, 0), normal: v3(0, 0, 1), vel: v3(), t: 0 },
    handed, side, team: tm, level, name, home: homePos, plan: null, lastShot: null, hits: 0, misses: 0,
  };
  let role = 'back'; // 'back' | 'net'
  let lastSeenShot = 0;
  let coversFn = covers;
  let opponentsFn = opponents;
  let plan = null;
  let swing = null; // { stroke, start, dur }
  let replanAt = 0;
  let pendingServe = null;

  // Actor-frame unit vectors (forward toward the net / the other half, and the actor's right).
  const fwd = v3(0, 0, -sz);
  const right = v3(sz, 0, 0); // far actor faces +z: right is -x; near actor faces -z: right is +x

  function setHome(h) {
    homePos.x = h.x;
    homePos.z = h.z;
  }

  function placeAt(p, r = null) {
    if (r) role = r;
    else role = Math.abs(p.z) < 5 ? 'net' : 'back';
    pos.set(p.x, 0, p.z);
    vel.set(0, 0, 0);
    plan = null;
    swing = null;
    state.holding = 'ready';
    state.swingPhase = 0;
  }

  function opponentsOf(world) {
    if (opponentsFn) return opponentsFn(world);
    if (tm === 1) return [world.player.pos];
    return [];
  }

  // ---- planning ----------------------------------------------------------------

  function strokeFor(c) {
    if (c.pos.y > 1.8) return 'bandeja';
    const rel = (c.pos.x - pos.x) * right.x * dom;
    const fh = rel > -0.25;
    if (c.kind === 'volley') return fh ? 'volley-fh' : 'volley-bh';
    if (c.kind === 'after-wall') return fh ? 'glass-fh' : 'glass-bh';
    return fh ? 'forehand' : 'backhand';
  }

  function stanceFor(c, stroke) {
    const fam = stroke === 'bandeja' || stroke === 'smash' || stroke === 'vibora' ? 'oh'
      : stroke === 'volley-fh' ? 'vfh' : stroke === 'volley-bh' ? 'vbh'
        : stroke.endsWith('bh') || stroke === 'backhand' ? 'bh' : 'fh';
    const off = CONTACT_OFFSETS[fam];
    const x = c.pos.x - right.x * dom * off.x - fwd.x * off.z;
    const z = c.pos.z - fwd.z * off.z;
    return { x: clamp(x, -HW + 0.3, HW - 0.3), z: sz * clamp(z * sz, PLAYER.netKeepOut, COURT.halfLength - 0.3) };
  }

  function makePlan(world, key) {
    const pred = predictFlight(world, { maxTime: 4 });
    const stroke0 = currentStroke(world);
    const serveInFlight = !!(stroke0 && stroke0.isServe);
    let cands = interceptCandidates(pred, {
      playerPos: pos, maxSpeed: L.maxSpeed, reachRadius: 0.75, side, now: world.time, minHeight: 0.3, maxHeight: 2.45,
    });
    cands = cands.filter((c) => (!serveInFlight || c.kind !== 'volley') && (!coversFn || coversFn(c.pos)));
    if (!cands.length) return { key, miss: true, t: Infinity };
    let c = cands[0];
    // At the net, take high balls in the air (bandeja / smash) instead of letting them bounce deep.
    // At (or coming from) the net, take high balls in the air (bandeja / smash) rather than
    // letting a lob push you back to the glass.
    const atNet = Math.abs(pos.z) < 5.5 || role === 'net';
    if (atNet && !serveInFlight) {
      const oh = cands.filter((k) => k.kind === 'volley' && k.height > 1.85 && k.height < 2.4 && Math.abs(k.pos.z) < 8.2);
      if (oh.length && (c.kind !== 'volley' || c.height < 1.0)) c = oh[0];
    }
    const stroke = strokeFor(c);
    const stance = stanceFor(c, stroke);
    const [dur, phase] = SWING[stroke] || SWING.forehand;
    return {
      key, miss: false, t: c.t, pos: c.pos.clone(), kind: c.kind, stroke, stance,
      swingStart: c.t - phase * dur, swingDur: dur, choice: chooseShot(world, c, stroke),
    };
  }

  // ---- shot selection ------------------------------------------------------------

  function chooseShot(world, c, stroke) {
    const opp = opponentsOf(world);
    let netZ = Infinity, oppX = 0;
    for (const p of opp) {
      const d = Math.abs(p.z);
      if (d < netZ) { netZ = d; oppX = p.x; }
    }
    // A net player volleys; lobs and chiquitas are played from the back against net players.
    const oppAtNet = netZ < 4.5 && Math.abs(pos.z) > 5.0;
    const r = rng();
    const [k0, k1] = L.kmh;
    const tz = (depth) => -sz * depth; // z on the other half
    // Pace and spin vary shot to shot (QA: every bandeja was 57 km/h / -700 rpm, no sidespin).
    const lv = level === 'pro' ? 1 : level === 'rookie' ? 0 : 0.5;
    const sideRpm = (amp) => rng.range(-amp, amp) * (0.5 + lv);
    if (stroke === 'bandeja') {
      if (c.pos.y > 2.15 && Math.abs(c.pos.z) < 6 && rng() < L.smash) {
        if (level === 'pro' && Math.abs(c.pos.z) < 4 && rng() < 0.4) {
          // Por tres: flat and hard from near the net, bounced 2.4–3.4 m past it so it kicks
          // up over the 4 m back wall (needs ~130 km/h+ on the sand-filled turf).
          return {
            kind: 'smash', stroke: 'smash', target: v3(rng.range(-1.5, 1.5), 0, tz(rng.range(2.4, 3.4))),
            speed: (k1 * rng.range(1.35, 1.5)) / 3.6, top: rng.range(0, 400), side: sideRpm(250),
          };
        }
        return {
          kind: 'smash', stroke: 'smash', target: v3(rng.range(-SAFE_X, SAFE_X), 0, tz(rng.range(4.5, 6.2))),
          speed: (k1 * rng.range(1.15, 1.4)) / 3.6, top: rng.range(0, 700), side: sideRpm(400),
        };
      }
      return {
        kind: 'bandeja', stroke: 'bandeja', target: v3(rng.range(-SAFE_X, SAFE_X), 0, tz(rng.range(7.2, 8.8))),
        speed: rng.range(48 + 10 * lv, 62 + 10 * lv) / 3.6, top: -rng.range(500, 1000 + 400 * lv), side: sideRpm(600),
      };
    }
    if (oppAtNet && r < L.lob) {
      return {
        kind: 'lob', stroke: 'lob', target: v3(rng.range(-3.2, 3.2), 0, tz(rng.range(8.0, 9.0))), apex: rng.range(6.0, 7.0),
        top: rng.range(-200, 600 + 600 * lv), side: sideRpm(300),
      };
    }
    if (oppAtNet && r < L.lob + L.chiquita) {
      const x = clamp(oppX + rng.range(-0.7, 0.7), -SAFE_X, SAFE_X);
      const target = v3(x, 0, tz(clamp(netZ + 0.5, 2.4, 4.5)));
      // Soft and dipping: solved by flight time (a 32-40 km/h average pace), not by launch speed,
      // which cannot reach a short target and fell back to ~50 km/h.
      const dist = Math.hypot(target.x - c.pos.x, target.z - c.pos.z);
      return {
        kind: 'chiquita', stroke: 'chiquita', target, flightTime: dist / (rng.range(32, 40) / 3.6),
        top: rng.range(200, 700), side: sideRpm(300),
      };
    }
    const volley = c.kind === 'volley';
    if (volley && Math.abs(c.pos.z) < 5 && c.pos.y > 0.95 && rng() < L.kill) {
      // Put-away volley at the net: angled, short-ish and hard, away from the opponents.
      const away = oppX >= 0 ? -1 : 1;
      return {
        kind: 'kill', stroke, target: v3(away * rng.range(2.8, 4.0), 0, tz(rng.range(4.5, 6.5))),
        speed: (k1 * rng.range(0.95, 1.12)) / 3.6, top: rng.range(-300, 200), side: sideRpm(300),
      };
    }
    if (volley && c.pos.y < 0.7) {
      // Low volley: block it back deep and soft, through the middle.
      return {
        kind: 'block', stroke, target: v3(rng.range(-1.5, 1.5), 0, tz(rng.range(7.0, 8.5))),
        speed: (k0 * rng.range(0.68, 0.82)) / 3.6, top: -rng.range(150, 500), side: sideRpm(250),
      };
    }
    const glass = rng() < 0.4; // to the back glass: the player practises salida de pared
    const depth = volley ? rng.range(6.5, 8.4) : glass ? rng.range(8.4, 9.0) : rng.range(7.0, 8.4);
    const kmh = rng.range(k0, k1) * (volley ? 0.85 : 1);
    return {
      kind: volley ? 'volley' : 'drive', stroke, target: v3(rng.range(-SAFE_X, SAFE_X), 0, tz(depth)),
      speed: kmh / 3.6, top: volley ? rng.range(-350, 150) : rng.range(L.topRpm[0], L.topRpm[1]), side: sideRpm(volley ? 250 : 450),
    };
  }

  /**
   * Shot difficulty (>= 1): pace of the incoming ball, awkward contact heights, playing off
   * the glass, a hurried stance and aggressive choices all raise the unforced-error risk.
   */
  function difficulty(ball, p) {
    let d = 1;
    const vin = ball.vel.length();
    if (vin > 18) d += 0.6 + (vin - 18) * 0.08;
    const y = ball.pos.y;
    if (y < 0.45) d += 0.8;
    else if (y > 2.2) d += 0.5;
    if (p.kind === 'after-wall') d += 0.3;
    if (p.choice.kind === 'lob' && (y < 0.5 || vin > 16)) d += 0.5; // lobbing a low / fast ball
    const stretch = Math.hypot(pos.x - p.stance.x, pos.z - p.stance.z);
    if (stretch > 0.2) d += 2.5 * (stretch - 0.2);
    const k = p.choice.kind;
    if (k === 'kill' || k === 'smash') d += 0.6;
    if (k === 'chiquita') d += 0.4;
    return d;
  }

  /** Turns a choice into an unforced error: into the net, long onto the glass, or wide. */
  function errorChoice(choice) {
    const e = { ...choice, error: true };
    const r = rng();
    if (r < 0.4) {
      e.errorKind = 'net';
      e.target = v3(choice.target.x, 0, -sz * rng.range(0.3, 1.2));
      e.apex = null;
      e.flightTime = null;
      e.speed = Math.max(choice.speed || 15, 15);
    } else if (r < 0.8) {
      e.errorKind = 'long';
      e.target = v3(choice.target.x, 0, -sz * rng.range(10.4, 11.5));
    } else {
      e.errorKind = 'wide';
      e.target = v3((choice.target.x >= 0 ? 1 : -1) * rng.range(5.4, 6.2), 0, choice.target.z);
    }
    return e;
  }

  /** Velocity + spin for a choice from the ball's current position (with the level's error). */
  function executeShot(from, choice) {
    const target = choice.target.clone();
    if (!choice.error) {
      target.x += rng.normal(0, L.sigma);
      target.z += rng.normal(0, L.sigma);
    }
    const dir = v3(target.x - from.x, 0, target.z - from.z);
    const spin = spinFromComponents(dir, choice.top || 0, choice.side || 0);
    let res;
    if (choice.apex) res = solveShot({ from, target, spin, apex: choice.apex });
    else if (choice.flightTime) res = solveShot({ from, target, spin, flightTime: choice.flightTime });
    else res = solveShot({ from, target, spin, speed: choice.speed });
    if (!choice.error && (!res.ok || !res.clearsNet || (res.netClearance !== null && res.netClearance < 0.25 && choice.kind !== 'chiquita'))) {
      const dist = Math.hypot(dir.x, dir.z);
      res = solveShot({ from, target, spin, apex: Math.max(from.y + 0.3, 1.6 + 0.05 * dist) });
    }
    return { vel: res.vel, spin, target, solve: res };
  }

  // ---- movement ------------------------------------------------------------------

  function moveToward(tx, tz, dt) {
    const dx = tx - pos.x, dz = tz - pos.z;
    const dist = Math.hypot(dx, dz);
    let vx = 0, vz = 0;
    if (dist > 0.02) {
      const sp = Math.min(L.maxSpeed, Math.sqrt(2 * L.accel * dist) * 0.9);
      vx = (dx / dist) * sp;
      vz = (dz / dist) * sp;
    }
    let ax = (vx - vel.x) / dt, az = (vz - vel.z) / dt;
    const a = Math.hypot(ax, az);
    if (a > L.accel) {
      ax *= L.accel / a;
      az *= L.accel / a;
    }
    vel.x += ax * dt;
    vel.z += az * dt;
    pos.x += vel.x * dt;
    pos.z += vel.z * dt;
  }

  function updateRacket() {
    const rk = state.racket;
    const f = state.facing;
    const fx = Math.sin(f), fz = Math.cos(f);
    const rx = -fz * dom, rz = fx * dom;
    rk.grip.set(pos.x + rx * 0.1 + fx * 0.36, 1.08, pos.z + rz * 0.1 + fz * 0.36);
    rk.axis.set(rx * -0.3 + fx * 0.55, 0.75, rz * -0.3 + fz * 0.55).normalize();
    rk.normal.set(rx * -0.9 + fx * 0.35, 0.1, rz * -0.9 + fz * 0.35).normalize();
  }

  // ---- main update ---------------------------------------------------------------

  function update(world, dt) {
    const now = world.time;
    const ball = world.ball;
    const ref = world.referee;
    const live = ball && !ball.atRest && !ball.outside && !(ref && ref.state.phase === 'dead');

    if (pendingServe && now >= pendingServe.at) {
      const ps = pendingServe;
      pendingServe = null;
      doServe(world, ps.box);
    }

    updateRole(world);
    // Is this ball ours to play? (never a ball dropped for a serve that has not been struck yet)
    const waitingServe = !!(ref && ref.state.awaitingServe && !currentStroke(world));
    const ours = live && !waitingServe && world.flight.team !== tm && now - world.flight.startT >= L.reaction;
    if (ours) {
      const key = `${ball.id}:${world.flight.startT}`;
      if (!plan || plan.key !== key) {
        plan = makePlan(world, key);
        replanAt = now + 0.2;
      } else if (!plan.miss && now >= replanAt && plan.t - now > 0.3) {
        // Mesh contacts are random: re-read the ball if it is not where we planned.
        replanAt = now + 0.2;
        const pred = predict(ball, world.court, { maxTime: plan.t - now + 0.05 });
        const s = pred.samples[pred.samples.length - 1];
        if (s.pos.distanceTo(plan.pos) > 0.25) plan = makePlan(world, key);
      }
    } else if (plan && (!live || world.flight.team === tm)) {
      plan = null;
    }
    state.plan = plan;

    // Movement.
    if (plan && !plan.miss) moveToward(plan.stance.x, plan.stance.z, dt);
    else if (!swing) moveToward(homePos.x, sz * (role === 'net' ? NET_Z : Math.abs(homePos.z)), dt);
    else moveToward(pos.x, pos.z, dt); // finishing a stroke: brake

    // Swing animation and the strike.
    if (plan && !plan.miss && !swing && now >= plan.swingStart) swing = { stroke: plan.stroke, start: plan.swingStart, dur: plan.swingDur };
    if (plan && !plan.miss && now + dt > plan.t) {
      strike(world);
      plan = null;
    }
    if (swing) {
      state.swingPhase = clamp((now - swing.start) / swing.dur, 0, 1);
      state.swingT = now - swing.start;
      state.stroke = swing.stroke;
      state.holding = 'swing';
      if (state.swingPhase >= 1) swing = null;
    } else {
      state.swingPhase = 0;
      const sp = Math.hypot(vel.x, vel.z);
      state.holding = sp > 0.6 ? 'run' : plan ? 'ready' : state.holding === 'swing' ? 'recover' : sp > 0.2 ? 'recover' : 'ready';
    }
    const target = live ? ball.pos : null;
    const yawTo = target ? Math.atan2(target.x - pos.x, Math.max(0.5, Math.abs(target.z - pos.z))) * -sz : 0;
    state.facing = baseFacing + clamp(yawTo * 0.4, -0.6, 0.6);
    updateRacket();
  }

  /**
   * Doubles positioning: follow your own lob (or serve) to the net, retreat when the
   * opponents lob over you.
   */
  function updateRole(world) {
    const shots = world.shots;
    const last = shots.length ? shots[shots.length - 1] : null;
    if (!last || last.id === lastSeenShot) return;
    lastSeenShot = last.id;
    const apex = last.apex ?? 0;
    if (last.team === tm) {
      const mine = last.actorPos && Math.hypot(last.actorPos.x - pos.x, last.actorPos.z - pos.z) < 0.6;
      if (last.choice === 'lob' || apex > 4.5 || (last.isServe && mine)) role = 'net';
    } else {
      const land = last.predictedLanding;
      if (apex > 3.8 && land && land.z * sz > 5.0) role = 'back';
    }
  }

  function strike(world) {
    const ball = world.ball;
    const p = plan;
    if (!ball) return null;
    const late = Math.hypot(pos.x - p.stance.x, pos.z - p.stance.z) > 0.45;
    const moved = ball.pos.distanceTo(p.pos) > 0.6;
    if (late || moved) {
      state.misses++;
      return null;
    }
    let choice = p.choice;
    if (rng() < L.err * difficulty(ball, p)) choice = errorChoice(choice);
    const shot = executeShot(ball.pos.clone(), choice);
    const rec = applyAiHit(world, {
      by, team: tm, vel: shot.vel, spin: shot.spin, stroke: choice.stroke || p.stroke, actorPos: pos,
      racketSpeed: shot.vel.length() * 0.62,
      extra: { aim: shot.target, choice: choice.kind, error: choice.error ? choice.errorKind : null },
    });
    if (rec) {
      state.lastShot = rec;
      state.hits++;
    }
    return rec;
  }

  // ---- feeds and serves -------------------------------------------------------------

  /**
   * Starts a rally by hand-feeding toward the other half (rally mode). Returns the ball.
   * opts: { target?: {x,z}, kmh = 50, top = 600 }
   */
  function feed(world, { target = null, kmh = 50, top = 600 } = {}) {
    const from = v3(pos.x + fwd.x * 0.5 + right.x * dom * 0.35, 1.0, pos.z + fwd.z * 0.5);
    const opp = opponentsOf(world)[0];
    const t = target ? v3(target.x, 0, target.z)
      : v3(clamp((opp ? opp.x : 0) + rng.range(-1.0, 1.2), -SAFE_X, SAFE_X), 0, -sz * rng.range(5.6, 6.6));
    const spin = spinFromComponents(v3(t.x - from.x, 0, t.z - from.z), top, rng.range(-FEED_SIDE_RPM, FEED_SIDE_RPM));
    let res = solveShot({ from, target: t, spin, speed: kmh / 3.6 });
    if (!res.ok || !res.clearsNet) res = solveShot({ from, target: t, spin, apex: 2.2 });
    swing = { stroke: 'forehand', start: world.time - 0.5, dur: 0.9 };
    return launchBall(world, { pos: from, vel: res.vel, spin, by, team: tm });
  }

  /** Serve position (behind the service line, on the box side) for box 'right'|'left'. */
  function servePosition(box) {
    const sgnRight = right.x; // our right in court x
    const x = (box === 'right' ? 1 : -1) * sgnRight * 2.0;
    return { x, z: sz * 7.6 };
  }

  /** Schedules a serve `delay` s from now into the diagonal `box` (referee naming). */
  function serve(world, box, delay = 1.2) {
    placeAt(servePosition(box));
    pendingServe = { box, at: world.time + delay };
  }

  function doServe(world, box) {
    const from = v3(pos.x + right.x * dom * 0.45, 0.85, pos.z + fwd.z * 0.35);
    // Receiver's box on the other half: diagonal from our box side.
    const recvRightX = -sz; // near receiver's right is +x, far receiver's right is -x
    const bx = (box === 'right' ? 1 : -1) * recvRightX;
    const target = v3(bx * rng.range(1.2, 3.2), 0, -sz * rng.range(5.0, 6.3));
    target.x += rng.normal(0, L.sigma * 0.5);
    target.z += rng.normal(0, L.sigma * 0.5);
    const sv = SERVE_SPIN[level] || SERVE_SPIN.club;
    const top = -rng.range(sv.slice[0], sv.slice[1]);
    const sideRpm = (rng() < 0.5 ? -1 : 1) * rng.range(sv.side[0], sv.side[1]);
    const spin = spinFromComponents(v3(target.x - from.x, 0, target.z - from.z), top, sideRpm);
    let res = solveShot({ from, target, spin, speed: rng.range(L.kmh[0] * 0.85, L.kmh[1] * 0.85) / 3.6 });
    if (!res.ok || !res.clearsNet) res = solveShot({ from, target, spin, apex: 1.5 });
    swing = { stroke: 'serve', start: world.time - 0.6, dur: 1.0 };
    launchBall(world, { pos: from, vel: res.vel, spin, by, team: tm, strike: { team: tm, isServe: true, actorPos: { x: pos.x, z: pos.z } } });
    emit(world, 'ai:serve', { team: tm, by, box });
  }

  return {
    update,
    feed,
    serve,
    servePosition,
    placeAt,
    setHome,
    get state() {
      return state;
    },
    level,
    team: tm,
    side,
    get role() {
      return role;
    },
    set role(r) {
      role = r;
    },
    set covers(fn) {
      coversFn = fn;
    },
    set opponents(fn) {
      opponentsFn = fn;
    },
  };
}

