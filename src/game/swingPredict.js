// Predictive swing: the racket the player will have when they see the current frame.
//
// The camera loop is slow. A pose captured at time c reaches the game `delay` s later, and the
// player sees a frame `latency` s after it is drawn. To meet the ball they SEE at sim time T,
// their real racket is where it needs to be at capture time T + latency. So the racket that
// belongs next to the drawn ball is the tracked pose extrapolated by delay + latency, about
// 0.26 s on a Mac with a TV. A forward swing lasts about that long, and at the instant the
// ball reaches the contact point the newest pose still shows the racket held back. Velocity
// extrapolation cannot see a swing that has not visibly started (QA2: 0 of 20 contacts).
//
// So the predictor completes the swing. While a ball is coming, and the racket is prepared
// (held back, or already moving toward the ball), it predicts the contact the player is
// going for: the point where the ball passes their ideal contact spot (CONTACT_OFFSETS,
// the same model the movement magnet uses). The racket is then turned about the tracked
// hitting shoulder from its newest pose to that point, arriving when the ball does (an
// ease-in, so it leaves the backswing gently and meets the ball at swing speed), then
// follows through. Speed at contact is the player's own, learned from their confirmed hits.
// Otherwise the display pose is the tracked pose screw-extrapolated with damping (racketTrack).
//
// Pure module. Poses are COURT frame; all times are sim seconds. Ball time t pairs with racket
// capture time t + latency (SPEC §10.4).

import { Vec3 } from '../util/vec3.js';
import { clamp, smoothstep } from '../util/math.js';
import { RACKET } from '../config.js';
import { predict } from '../physics/predict.js';
import {
  createRacketPose, copyRacketPose, extrapolatePose, blendRacketPose, rotateAboutAxis,
} from '../tracking/racketTrack.js';
import { sweptContact } from '../physics/racket.js';

const REF_H = 1.75;

export const PREDICT = Object.freeze({
  /**
   * Ball prediction horizon (s) and refresh interval (s). The physics is deterministic, so a
   * prediction stays exact until the flight has a new event (mesh scatter) or is rewritten.
   */
  horizon: 1.3,
  refresh: 0.25,
  /** Loop delay (s) below which prediction is pointless (mouse controls, fast pipelines). */
  minLoop: 0.04,
  /** Display extrapolation cap (s) of the tracked pose when no swing is predicted. */
  maxExtrapolate: 0.3,
  /**
   * Horizontal miss (m) between the ball and the ideal contact spot still treated as a swing,
   * at rest; it shrinks by missPerSpeed per m/s of court speed (a player still being carried
   * across the court is not set up), and above maxRunSpeed nothing is predicted.
   */
  maxMiss: 0.42,
  missPerSpeed: 0.08,
  maxRunSpeed: 3,
  /** Racket speed relative to the body (m/s) below which it counts as held (backswing). */
  heldSpeed: 2.5,
  /** Largest swing rotation (rad) from the newest pose to the contact. */
  maxTurn: 2.9,
  /** Highest mean angular speed (rad/s) a predicted swing may need. */
  maxRate: 45,
  /**
   * Follow-through after the predicted contact: the swing decays at >= followDecay (1/s) and
   * turns at most followMax (rad) further, so the shown arm does not sweep across the eyes
   * before the camera has seen the real follow-through.
   */
  followDecay: 7,
  followMax: 0.9,
  /** Blend times (s): a plan fading in / the display returning to the tracked racket. */
  blendIn: 0.05,
  blendOut: 0.16,
  /** Ease-in exponent bounds. */
  pMin: 1,
  pMax: 7,
});

/** Default sweet-spot speed at contact (m/s) per family, before the player's own is learned. */
export const DEFAULT_SWING_SPEED = Object.freeze({
  fh: 14, bh: 12, vfh: 6.5, vbh: 6.5, oh: 12.5, sm: 26, serve: 15, gfh: 18, gbh: 16,
});

const tmpA = new Vec3(), tmpB = new Vec3(), tmpC = new Vec3();

/**
 * @param o.racketTrack createRacketTrack() of the human controller
 * @param o.posAt (t) -> {x, z} player court position at sim time t (or null)
 * @param o.contactOffsets CONTACT_OFFSETS of human.js (ideal contact per family)
 * @param o.futurePos (world, ahead, out) -> {x, z} the player's court position `ahead` s from now
 * @param o.contactPlan optional (world) -> { t, pos, vel, fam } | null: the contact the game has
 *   planned (timing hits, game/swingAssist.js); when given, the swing is completed to it
 * @returns SwingPredictor = { update(world), detect(world, ballPrev, ballNow, margin) -> contact|null,
 *   strike(), learn(shot), reset(), renderPose, prevPose, plan, stats }
 */
export function createSwingPredictor({ racketTrack, posAt, contactOffsets, futurePos, contactPlan = null }) {
  let cur = createRacketPose();
  let prev = createRacketPose();
  let hasCur = false, hasPrev = false;
  const kin = createRacketPose();
  const planPose = createRacketPose();
  let plan = null; // active plan (see makePlan)
  const passed = { key: null, t: -Infinity }; // a predicted contact that went by unstruck
  let mix = 0; // display weight of the plan (0 = tracked extrapolation)
  let lastT = null;
  let pred = null, predKey = null, predAt = -Infinity;
  const learned = new Map(); // `${modeId}:${family}` -> EMA of the sweet-spot speed at contact
  // `${modeId}:${family}` -> unit shoulder->sweet direction in the racket's own frame at contact
  // (x = axis x normal, y = axis, z = normal). A swing turns racket and arm together about the
  // shoulder, so this direction is what the rotation must carry from the backswing to the ball;
  // the backswing's own sweet-spot position is less reliable (bent elbow, laid-back wrist).
  const frames = new Map();
  const stats = { plans: 0, strikes: 0, lastReject: null };

  function reset() {
    plan = null;
    mix = 0;
    hasCur = hasPrev = false;
    pred = null;
    predKey = null;
    lastT = null;
  }

  function learnKey(world, fam) {
    const m = world.mode;
    return `${m && m.id ? m.id : 'free'}:${fam}`;
  }

  /** Records the racket speed of a confirmed hit for the family of the swing that made it. */
  function learn(world, shot, fam) {
    if (!shot || !(shot.racketSpeed > 0.5) || !fam) return;
    const k = learnKey(world, fam);
    const old = learned.get(k);
    learned.set(k, old === undefined ? shot.racketSpeed : old + 0.4 * (shot.racketSpeed - old));
  }

  /** Learns the racket's contact frame relative to the shoulder (pose and shoulder in court). */
  function learnFrame(world, fam, pose, shoulder) {
    if (!pose || !shoulder || !fam) return;
    const r = tmpA.subVectors(pose.sweet || tmpB.copy(pose.grip).addScaled(pose.axis, RACKET.sweetSpotY), shoulder);
    const len = r.length();
    if (len < 0.2) return;
    r.scale(1 / len);
    const xh = tmpC.crossVectors(pose.axis, pose.normal);
    const v = new Vec3(r.dot(xh), r.dot(pose.axis), r.dot(pose.normal));
    const k = learnKey(world, fam);
    const old = frames.get(k);
    if (old) v.scale(0.5).addScaled(old, 0.5);
    frames.set(k, v.normalize());
  }

  function swingSpeed(world, fam) {
    const v = learned.get(learnKey(world, fam));
    return v !== undefined ? v : DEFAULT_SWING_SPEED[fam] ?? 13;
  }

  function flightKey(world) {
    const b = world.ball;
    return b ? `${b.id}:${world.flight.startT}` : null;
  }

  /** Whether the live ball is one the player may still play (coming to them, not yet struck). */
  function incoming(world) {
    const b = world.ball;
    if (!b || b.atRest || b.outside) return false;
    const f = world.flight;
    if (f.team === 0 && f.by !== 'drop') return false;
    const lh = world.lastHit;
    if (lh && lh.team === 0 && lh.t >= f.startT - 1e-9) return false;
    return true;
  }

  function ballPrediction(world) {
    const key = flightKey(world);
    const corr = world.ballCorrection ? world.ballCorrection.seq : 0;
    const nEv = world.flight.events.length;
    if (!pred || key !== predKey || world.time - predAt > PREDICT.refresh || pred.corr !== corr || pred.nEv !== nEv) {
      pred = predict(world.ball, world.court, { maxTime: PREDICT.horizon, dt: 1 / 240 });
      pred.corr = corr;
      pred.nEv = nEv;
      // First floor bounce on the near side (past or predicted): earlier contacts are volleys.
      let nb = Infinity;
      for (const e of world.flight.events) if (e.type === 'bounce' && e.side === 'near') { nb = e.t; break; }
      if (nb === Infinity) for (const e of pred.events) if (e.type === 'bounce' && e.side === 'near') { nb = e.t; break; }
      let wall = Infinity;
      const scan = (list) => {
        for (const e of list) if (e.type === 'wall' && e.side === 'near' && e.t > nb) { wall = Math.min(wall, e.t); return; }
      };
      scan(world.flight.events);
      if (wall === Infinity) scan(pred.events);
      pred.nearBounce = nb;
      pred.wallAfter = wall;
      predKey = key;
      predAt = world.time;
    }
    return pred;
  }

  /** Swing family of a contact candidate (glass / serve / smash variants). */
  function famOf(fam, serving, t, pr, world) {
    if (serving) return 'serve';
    if (t > pr.wallAfter && (fam === 'fh' || fam === 'bh')) return fam === 'fh' ? 'gfh' : 'gbh';
    if (fam === 'oh' && world.mode && world.mode.apHints && world.mode.apHints.family === 'sm') return 'sm';
    return fam;
  }

  function reject(why) {
    stats.lastReject = why;
    return null;
  }

  /**
   * The swing the player is making at the incoming ball, or null. Fields: key, fam, tStar
   * (ball time of contact), cStar (racket capture time of contact), c0 (newest pose time),
   * C (contact point), S0 / S1 (shoulder at c0 / at the contact: the swing centre), u0 (unit
   * S1 -> sweet spot at c0), axisRot (unit rotation axis), D (rad), rho0 / rho1, n0, a0 (racket
   * normal / axis at c0), omega (rad/s at contact), p (ease-in exponent), offset0, prepared.
   */
  function makePlan(world, L, T, lat) {
    const body = world.player.body;
    if (!body || !body.valid || !body.joints) return reject('body');
    const pl = world.player;
    const handed = world.settings.handed || pl.handed || 'right';
    const dom = handed === 'left' ? -1 : 1;
    const k = (world.settings.height || pl.height || REF_H) / REF_H;
    const shU = body.joints[dom < 0 ? 'shoulderL' : 'shoulderR'];
    if (!shU) return reject('shoulder');
    const p0 = posAt(L.t) || pl.pos;
    const S0 = new Vec3(p0.x + shU.x, shU.y, p0.z - shU.z);
    const sweetUx = (L.sweet.x - p0.x) * dom;
    const fhSide = sweetUx >= 0;
    const overheadReady = L.sweet.y > shU.y + 0.2 * k;

    const pr = ballPrediction(world);
    const serving = world.flight.by === 'drop';
    // Player court position at the racket capture time of ball time t (the follow spring).
    const fp = { x: 0, z: 0 };
    const at = (t) => futurePos(world, clamp(t + lat - T, 0, 0.4), fp);
    // Timing hits: the game has planned the contact (moment, point, family); complete the swing to it.
    const planned = contactPlan ? contactPlan(world) : null;
    if (planned) return planToward(world, L, T, lat, planned, shU, dom, k, pr, serving, at, fp);
    // Each pass of the ball by the player's ideal contact spot is a candidate (a deep ball can
    // pass before the glass and again after it); the drill's intent picks among them.
    const minima = [];
    let run = null; // current descent: { s, cost, fam }
    let lastCost = Infinity;
    const tMin = T - 1 / 240 - 1e-9;
    for (let i = 0; i < pr.samples.length; i++) {
      const s = pr.samples[i];
      if (s.t < tMin) continue;
      const pos = s.pos;
      let fam = null;
      let cost = Infinity;
      at(s.t);
      const Px = fp.x, Pz = fp.z;
      // Miss distance from the family's ideal contact spot (court x, z).
      const miss = (f) => {
        const off = contactOffsets[f];
        return Math.hypot(pos.x - (Px + dom * off.x * k), pos.z - (Pz - off.z * k));
      };
      if (pos.z > 0.05 && pos.y >= 0.12 && pos.z <= Pz + 0.6) {
        if (serving) {
          if (s.t >= pr.nearBounce && pos.y <= 0.53 * REF_H * k) {
            fam = 'fh';
            cost = Math.hypot(pos.x - Px, pos.z - Pz) * 0.2 - pos.y; // the highest point under the waist
          }
        } else if (pos.y > 1.78 * k) {
          if (pos.y <= 2.6 * k) {
            fam = 'oh';
            cost = miss('oh') + 0.5 * Math.abs(pos.y - 2.08 * k) + (overheadReady ? 0 : 0.1);
          }
        } else {
          // Forehand or backhand: whichever spot the ball passes closer to; the side the
          // racket is prepared on breaks near-ties.
          const volley = s.t < pr.nearBounce;
          const ff = volley ? 'vfh' : 'fh', bf = volley ? 'vbh' : 'bh';
          const cf = miss(ff) + (fhSide ? 0 : 0.12);
          const cb = miss(bf) + (fhSide ? 0.12 : 0);
          fam = cf <= cb ? ff : bf;
          cost = Math.min(cf, cb);
        }
      }
      if (cost < lastCost) {
        if (!run || cost < run.cost) run = { s, cost, fam };
      } else if (run && cost > run.cost + 0.05) {
        minima.push(run);
        run = null;
      }
      lastCost = cost;
    }
    if (run) minima.push(run);
    const hint = world.mode && world.mode.apHints ? world.mode.apHints.contact : null;
    const run2 = Math.hypot(pl.vel.x, pl.vel.z);
    if (run2 > PREDICT.maxRunSpeed) return reject('running');
    const maxMiss = PREDICT.maxMiss - PREDICT.missPerSpeed * run2;
    const ok = minima.filter((m) => (serving ? Math.hypot(m.s.pos.x - pl.pos.x, m.s.pos.z - pl.pos.z) < 1.4 : m.cost <= maxMiss));
    // The drill's stroke decides (no swing is predicted at a pass the drill does not want);
    // otherwise the pass the player is set up for: the closest, the earliest of near-ties.
    let pool = ok;
    if (hint === 'glass') pool = ok.filter((m) => m.s.t > pr.wallAfter);
    else if (hint === 'overhead') pool = ok.filter((m) => m.fam === 'oh');
    else if (hint === 'volley') pool = ok.filter((m) => m.s.t < pr.nearBounce);
    let pick = null;
    if (pool.length) {
      const bestCost = Math.min(...pool.map((m) => m.cost));
      pick = pool.find((m) => m.cost <= bestCost + 0.1);
    }
    // A predicted contact that went by unstruck is not chased along the ball's path.
    if (passed.key === flightKey(world)) {
      const after = passed.t + 0.2;
      pick = pick && pick.s.t > after ? pick : ok.find((m) => m.s.t > after) || null;
    }
    if (!pick) return reject('nopick');
    const best = pick.s;
    const bestFam = pick.fam;
    const bestCost = pick.cost;
    const tStar = best.t;
    const cStar = tStar + lat;
    const span = cStar - L.t;
    if (span < 0.02) return reject('span');

    // Rotation about the shoulder from the newest pose to the contact.
    at(tStar);
    const Px = fp.x, Pz = fp.z;
    const S1 = new Vec3(Px + shU.x, shU.y, Pz - shU.z);
    // The swing turns about where the shoulder will be at the contact (the player is still
    // settling into the stance: the newest pose is taken relative to that same centre).
    const r0 = new Vec3().subVectors(L.sweet, S1);
    const rho0 = r0.length();
    const r1 = new Vec3().subVectors(best.pos, S1);
    const rho1 = r1.length();
    if (rho0 < 0.15 || rho1 < 0.15 || rho1 > 1.25 * k) return reject('rho');
    const u0 = r0.scale(1 / rho0);
    const u1 = r1.scale(1 / rho1);
    // The direction the swing rotates: from the learned contact frame when there is one.
    const fr = frames.get(learnKey(world, famOf(bestFam, serving, best.t, pr, world)));
    let offset0 = null;
    // Only for a bent-arm backswing (its sweet spot well inside the contact radius); a backswing
    // on the arc already carries the right direction (the contact frames vary with the aim).
    const bent = fr ? clamp((rho1 - rho0 - 0.03) / 0.1, 0, 1) : 0;
    if (bent > 0) {
      const xh = tmpA.crossVectors(L.axis, L.normal);
      const v = new Vec3().copy(xh).scale(fr.x).addScaled(L.axis, fr.y).addScaled(L.normal, fr.z).normalize();
      if (v.dot(u0) > Math.cos(0.6)) {
        v.scale(bent).addScaled(u0, 1 - bent).normalize();
        offset0 = new Vec3().copy(L.sweet).sub(tmpB.copy(S1).addScaled(v, rho0));
        u0.copy(v);
      }
    }
    const axisRot = new Vec3().crossVectors(u0, u1);
    const sinD = axisRot.length();
    const D = Math.atan2(sinD, u0.dot(u1));
    if (D > PREDICT.maxTurn) return reject('maxTurn');
    if (sinD > 1e-6) axisRot.scale(1 / sinD);
    else axisRot.copy(L.normal).addScaled(u0, -L.normal.dot(u0)).normalize();
    if (D / span > PREDICT.maxRate) return reject('maxRate');

    // Prepared: the racket is held (backswing) or already travelling toward the ball.
    const vRel = tmpA.set(L.vel.x - pl.vel.x, L.vel.y, L.vel.z - pl.vel.z);
    const vAbs = vRel.length();
    const tangent = tmpB.crossVectors(axisRot, u0);
    const toward = vRel.dot(tangent);
    // Moving back along the arc is the backswing itself; a racket moving across the swing
    // (lifted, dropped, waved) does not START a predicted stroke. Once one is under way for this
    // ball, the preparation (an overhead's racket going up behind the head) does not stop it.
    const prepared = vAbs < PREDICT.heldSpeed || (D > 0.2 && Math.abs(toward) > 0.6 * vAbs);
    const continuing = plan && !plan.struck && plan.key === flightKey(world) && !plan.dead;
    if (!prepared && !continuing) return reject('notPrepared');

    // The face it will meet the ball with must face the ball.
    const fam = famOf(bestFam, serving, best.t, pr, world);
    const speed = swingSpeed(world, fam);
    const omega = speed / rho1;
    const n1 = rotateAboutAxis(L.normal, axisRot, D, new Vec3());
    const vRacket = tmpC.crossVectors(axisRot, u1).scale(speed);
    const rel = vRacket.sub(best.vel).scale(-1); // ball relative to the racket
    const relLen = rel.length();
    if (relLen > 1e-6 && Math.abs(n1.dot(rel)) / relLen < 0.3) return reject('faceEdge');

    const p = clamp((omega * span) / Math.max(D, 1e-3), PREDICT.pMin, PREDICT.pMax);
    return {
      key: flightKey(world), fam, tStar, cStar, c0: L.t, C: best.pos.clone(), S0, S1, u0: u0.clone(), axisRot, offset0,
      D, rho0, rho1, n0: L.normal.clone(), a0: L.axis.clone(), omega, p, speed, struck: false, releaseAt: null, miss: bestCost, prepared,
    };
  }

  /**
   * Swing plan toward a contact planned by the game (timing hits): same arc about the shoulder as
   * makePlan, no candidate search, no face / running rejections (the timing judge decides the hit).
   */
  function planToward(world, L, T, lat, c, shU, dom, k, pr, serving, at, fp) {
    const pl = world.player;
    const tStar = c.t;
    const cStar = tStar + lat;
    const span = cStar - L.t;
    if (span < 0.02) return reject('span');
    at(tStar);
    const S1 = new Vec3(fp.x + shU.x, shU.y, fp.z - shU.z);
    const r0 = new Vec3().subVectors(L.sweet, S1);
    const rho0 = r0.length();
    const r1 = new Vec3().subVectors(c.pos, S1);
    const rho1 = r1.length();
    if (rho0 < 0.15 || rho1 < 0.15 || rho1 > 1.6 * k) return reject('rho');
    const u0 = r0.scale(1 / rho0);
    const u1 = r1.scale(1 / rho1);
    const axisRot = new Vec3().crossVectors(u0, u1);
    const sinD = axisRot.length();
    const D = Math.atan2(sinD, u0.dot(u1));
    if (sinD > 1e-6) axisRot.scale(1 / sinD);
    else axisRot.copy(L.normal).addScaled(u0, -L.normal.dot(u0)).normalize();
    if (D / span > PREDICT.maxRate * 1.5) return reject('maxRate');
    const vRel = tmpA.set(L.vel.x - pl.vel.x, L.vel.y, L.vel.z - pl.vel.z);
    const vAbs = vRel.length();
    const tangent = tmpB.crossVectors(axisRot, u0);
    const toward = vRel.dot(tangent);
    const prepared = vAbs < PREDICT.heldSpeed || (D > 0.2 && Math.abs(toward) > 0.6 * vAbs);
    const continuing = plan && !plan.struck && plan.key === flightKey(world) && !plan.dead;
    if (!prepared && !continuing) return reject('notPrepared');
    const fam = famOf(c.fam, serving, tStar, pr, world);
    const speed = swingSpeed(world, fam);
    const omega = speed / rho1;
    const p = clamp((omega * span) / Math.max(D, 1e-3), PREDICT.pMin, PREDICT.pMax);
    return {
      key: flightKey(world), fam, tStar, cStar, c0: L.t, C: c.pos.clone(), S0: S1.clone(), S1, u0: u0.clone(), axisRot, offset0: null,
      D, rho0, rho1, n0: L.normal.clone(), a0: L.axis.clone(), omega, p, speed, struck: false, releaseAt: null, miss: 0, prepared, timing: true,
    };
  }

  /** Pose of a plan at racket capture time tau (court frame, with vel and angVel). */
  function poseOfPlan(pl, tau, out) {
    const span = pl.cStar - pl.c0;
    let s = (tau - pl.c0) / span;
    let theta, rate;
    if (s <= 0) {
      s = 0;
      theta = 0;
      rate = 0;
    } else if (s <= 1) {
      theta = pl.D * Math.pow(s, pl.p);
      rate = (pl.D * pl.p * Math.pow(s, pl.p - 1)) / span;
    } else {
      const x = tau - pl.cStar;
      const kf = Math.max(PREDICT.followDecay, pl.omega / PREDICT.followMax);
      theta = pl.D + (pl.omega * (1 - Math.exp(-kf * x))) / kf;
      rate = pl.omega * Math.exp(-kf * x);
    }
    const sc = Math.min(1, s);
    const S = pl.S1;
    const rho = pl.rho0 + (pl.rho1 - pl.rho0) * smoothstep(0, 1, sc);
    const u = rotateAboutAxis(pl.u0, pl.axisRot, theta, tmpB);
    out.sweet.copy(S).addScaled(u, rho);
    // The tracked backswing sits off the learned arc: that offset fades out by the contact.
    if (pl.offset0 && s < 1) out.sweet.addScaled(pl.offset0, 1 - (s <= 0 ? 0 : Math.pow(s, Math.max(1, pl.p - 1))));
    rotateAboutAxis(pl.a0, pl.axisRot, theta, out.axis);
    rotateAboutAxis(pl.n0, pl.axisRot, theta, out.normal);
    out.vel.crossVectors(pl.axisRot, u).scale(rate * rho);
    out.angVel.copy(pl.axisRot).scale(rate);
    out.grip.copy(out.sweet).addScaled(out.axis, -RACKET.sweetSpotY);
    out.t = tau;
    return out;
  }

  /**
   * Once per world tick (after the ball physics): refreshes the plan and the display pose for
   * world.time. Returns the display pose (or null without tracking data).
   */
  function update(world) {
    const T = world.time;
    const dt = lastT === null ? 0 : clamp(T - lastT, 0, 0.1);
    lastT = T;
    const L = racketTrack.latest();
    // Previous display pose (for the swept speculative contact).
    const t = prev;
    prev = cur;
    cur = t;
    hasPrev = hasCur;
    if (!L) {
      hasCur = false;
      plan = null;
      return null;
    }
    const lat = world.settings.latency ?? 0;
    const loop = T + lat - L.t;
    const enabled = world.settings.hitPrediction !== false && loop >= PREDICT.minLoop;

    // Tracked pose, extrapolated toward what the player sees (damped, capped).
    extrapolatePose(L, clamp(loop, 0, PREDICT.maxExtrapolate), kin);

    if (plan && plan.struck) {
      // After the predicted contact: follow through until the real swing has been seen.
      if (plan.releaseAt === null && L.t >= plan.cStar + 0.02) plan.releaseAt = T;
      if (plan.releaseAt !== null) {
        mix = 1 - smoothstep(0, PREDICT.blendOut, T - plan.releaseAt);
        if (mix <= 0) plan = null;
      }
    } else {
      if (plan && !plan.dead && T > plan.tStar + 0.03) {
        passed.key = plan.key;
        passed.t = plan.tStar;
      }
      const np = enabled && incoming(world) ? makePlan(world, L, T, lat) : null;
      if (np) {
        if (!plan || plan.dead) stats.plans++;
        plan = np;
        // Fade in, fully in by the contact when the swing is recognised late.
        const rate = Math.max(1 / PREDICT.blendIn, (1 - mix) / Math.max(1 / 120, np.tStar - T));
        mix = Math.min(1, mix + (dt > 0 ? dt * rate : 1));
      } else {
        // No swing (any more): fade back to the tracked racket along the last plan.
        if (plan) plan.dead = true;
        mix = Math.max(0, mix - (dt > 0 ? dt / PREDICT.blendOut : 1));
        if (mix <= 0) plan = null;
      }
    }
    if (plan && mix > 0) {
      poseOfPlan(plan, T + lat, planPose);
      blendRacketPose(kin, planPose, mix, cur);
    } else {
      copyRacketPose(cur, kin);
    }
    cur.t = T; // display poses are stamped with the sim time they are shown at
    hasCur = true;
    return cur;
  }

  /**
   * Swept contact of the display racket (previous tick -> now) with the ball (ballPrev ->
   * ballNow, the same two ticks), only while a predicted swing is under way. Returns
   * sweptContact()'s result with `t` in sim time, or null.
   */
  function detect(world, ballPrev, ballNow, margin) {
    if (!plan || plan.struck || plan.dead || !hasPrev || !hasCur || mix < 0.3) return null;
    if (plan.key !== flightKey(world)) return null;
    const c = sweptContact(prev, cur, ballPrev, ballNow, margin);
    if (!c) return null;
    c.t = prev.t + (cur.t - prev.t) * c.u;
    c.plan = plan;
    return c;
  }

  /** The predicted swing met the ball: freeze it (follow-through, then back to tracking). */
  function strike() {
    if (!plan) return;
    plan.struck = true;
    stats.strikes++;
  }

  return {
    update,
    detect,
    strike,
    learn,
    learnFrame,
    reset,
    poseOfPlan,
    get renderPose() { return hasCur ? cur : null; },
    get prevPose() { return hasPrev ? prev : null; },
    get plan() { return plan; },
    get mix() { return mix; },
    stats,
  };
}
