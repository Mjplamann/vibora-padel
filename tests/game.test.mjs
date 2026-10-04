// Game layer: world (judge queue, lag-compensated hits, assist), human controller,
// ball machine, coach / AI players, drills and the three modes. Deterministic.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Vec3, v3 } from '../src/util/vec3.js';
import { createRng } from '../src/util/math.js';
import { COURT, PLAYER, RACKET, ASSIST, TRACKING, netHeightAt } from '../src/config.js';
import { cloneBall, stepBall } from '../src/physics/ball.js';
import { solveShot, interceptCandidates } from '../src/physics/predict.js';
import { spinFromComponents, spinComponents } from '../src/physics/racket.js';
import { createReferee } from '../src/rules/referee.js';
import {
  createWorld, stepWorld, launchBall, applyPlayerHit, applyAiHit, DEFAULT_SETTINGS, resolveSettings,
  judgeDelay, JUDGE_MARGIN, predictFlight, intendedShot, applyNetSafety, freeFlight, SHOT_INTENT, HIT_COOLDOWN,
} from '../src/game/world.js';
import { createHumanController, idealStance, contactFamily, CONTACT_OFFSETS } from '../src/game/human.js';
import { createMachine, planFeed } from '../src/game/machine.js';
import { createCoach, COACH_LEVELS } from '../src/game/coach.js';
import { DRILLS, DRILL_BY_ID, getDrill, mirrorDrill, scoreShot, starsFor, landZone, inZone } from '../src/game/drills.js';
import { createDrillMode, createRallyMode, createMatchMode, shotOutcomeInfo } from '../src/game/modes.js';
import { solveSwing } from '../src/tracking/autopilot.js';
import { createSyntheticCamera, standingBody } from '../src/tracking/synthetic.js';

const DT = 1 / 240;
const near = (a, e, tol, msg = '') => assert.ok(Math.abs(a - e) <= tol, `${msg} expected ${e} ± ${tol}, got ${a}`);

function stepFor(world, seconds) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) stepWorld(world, DT);
}
function stepUntil(world, t) {
  while (world.time < t - 1e-9) stepWorld(world, DT);
}

/** Launches a solved feed from the machine position toward a near-side landing point. */
function feedBall(world, { target = { x: 2.6, z: 6.0 }, speedKmh = 62, top = 700, apex = null, from = v3(0, 1, -9.2) } = {}) {
  const t = v3(target.x, 0, target.z);
  const spin = spinFromComponents(v3(t.x - from.x, 0, t.z - from.z), top, 0);
  const res = solveShot({ from, target: t, spin, ...(apex ? { apex } : { speed: speedKmh / 3.6 }) });
  return launchBall(world, { pos: from, vel: res.vel, spin, by: 'machine' });
}

/** Contact candidate of the live ball on the near side. */
function planContact(world, { kind = 'after-bounce', minT = 0.25, minH = 0.5, maxH = 1.6 } = {}) {
  const pred = predictFlight(world, { maxTime: 4 });
  const cands = interceptCandidates(pred, {
    playerPos: world.player.pos, side: 'near', now: world.time, maxSpeed: 50, reachRadius: 30, minHeight: minH, maxHeight: maxH,
  });
  return cands.filter((c) => c.kind === kind && c.t - world.time > minT).sort((a, b) => a.t - b.t)[0] || null;
}

/**
 * A racket pose that sends the live ball from contact candidate c to `target` (inverse impact).
 */
function racketFor(world, c, target, { speedKmh = 70, top = 800, apex = null, faceSign = 1 } = {}) {
  const b = cloneBall(world.ball);
  stepBall(b, c.t - b.t, world.court, null, null, { deterministic: true });
  const from = b.pos.clone();
  const tg = v3(target.x, 0, target.z);
  const shoulder = v3(from.x - 0.5 * faceSign, from.y + 0.45, from.z + 0.3);
  // Solve the wanted launch with a spin guess, then again with the spin the impact really gives.
  let spin = spinFromComponents(v3(tg.x - from.x, 0, tg.z - from.z), top, 0);
  let sw = null;
  for (let k = 0; k < 2; k++) {
    const des = solveShot({ from, target: tg, spin, ...(apex ? { apex } : { speed: speedKmh / 3.6 }) });
    sw = solveSwing({ C: from, vin: b.vel, spinIn: b.spin, vDes: des.vel, shoulder, faceSign, brushDeg: 20 });
    spin = sw.spinOut;
  }
  const pose = {
    grip: from.clone().addScaled(sw.a, -RACKET.sweetSpotY), axis: sw.a.clone(), normal: sw.n.clone().scale(faceSign),
    vel: sw.V.clone(), angVel: sw.omega.clone(), t: c.t,
  };
  return { pose, contact: { local: { x: 0, y: RACKET.sweetSpotY }, face: faceSign > 0 ? 'front' : 'back' }, t: c.t, from };
}

/** Plays the live ball like a perfect player whose hit is detected `lag` seconds late. */
function perfectHit(world, target, opts = {}) {
  const c = planContact(world, opts);
  if (!c) return null;
  const r = racketFor(world, c, target, opts);
  world.player.pos.set(r.from.x - 0.7, 0, r.from.z + 0.35);
  stepUntil(world, c.t + (opts.lag ?? world.settings.latency + 0.04));
  return applyPlayerHit(world, r.contact, r.pose, r.t);
}

function collect(world, types) {
  const out = [];
  world.bus.on('*', (p, type) => {
    if (!types || types.includes(type)) out.push({ type, p, t: world.time });
  });
  return out;
}

// ---------------------------------------------------------------------------

describe('world', () => {
  test('defaults: settings shape, player, judge queue', () => {
    const keys = ['assist', 'latency', 'height', 'handed', 'gainLateral', 'gainDepth', 'hfovDeg', 'cameraPreset', 'gazeFollow',
      'fov', 'landingMarker', 'contactGhost', 'halo', 'quality', 'voice', 'volumes'];
    for (const k of keys) assert.ok(k in DEFAULT_SETTINGS, k);
    assert.equal(DEFAULT_SETTINGS.assist, 'club');
    assert.equal(DEFAULT_SETTINGS.latency, TRACKING.latencyDefault);
    assert.deepEqual({ ...DEFAULT_SETTINGS.volumes }, { master: 0.9, sfx: 1, ambience: 0.5 });
    const s = resolveSettings({ assist: 'pro', volumes: { sfx: 0.2 } });
    assert.equal(s.assist, 'pro');
    assert.deepEqual(s.volumes, { master: 0.9, sfx: 0.2, ambience: 0.5 });

    const w = createWorld({ settings: { height: 1.9 } });
    assert.equal(w.time, 0);
    assert.equal(w.ball, null);
    assert.equal(w.player.team, 0);
    assert.equal(w.player.lastHitAt, -Infinity);
    near(w.player.eye.y, 1.9 * PLAYER.eyeHeightRatio, 1e-9);
    assert.ok(w.court && w.bus && w.ballHistory && Array.isArray(w.ai) && Array.isArray(w.shots));
    near(judgeDelay(w), TRACKING.latencyDefault + JUDGE_MARGIN, 1e-12); // no measured pipeline: the floor
  });

  test('launchBall + stepWorld: bus events in real time, referee sees them after the judge delay', () => {
    const w = createWorld({ rng: createRng(1) });
    const log = collect(w);
    stepFor(w, 0.5);
    const ball = feedBall(w);
    assert.equal(ball.t, w.time);
    assert.equal(w.ballHistory.length, 1);
    assert.equal(log.find((e) => e.type === 'ball:launch').p.by, 'machine');
    stepFor(w, 2.0);
    near(ball.t, w.time, 1e-9, 'ball clock follows the world');
    const bounce = log.find((e) => e.type === 'ball:bounce');
    assert.ok(bounce, 'bounce emitted');
    near(bounce.t, bounce.p.evt.t, DT + 1e-9, 'emitted in the tick it happened');
    const judged = log.find((e) => e.type === 'judge:event' && e.p.evt === bounce.p.evt);
    assert.ok(judged, 'judged later');
    assert.ok(judged.t >= bounce.p.evt.t + judgeDelay(w) - 1e-9 && judged.t <= bounce.p.evt.t + judgeDelay(w) + DT + 1e-9);
    // Launch is judged before its own events, in order.
    const order = log.filter((e) => e.type.startsWith('judge:')).map((e) => e.type);
    assert.equal(order[0], 'judge:launch');
  });

  test('every bus emission is forwarded to the mode', () => {
    const w = createWorld({ rng: createRng(2) });
    const seen = [];
    w.mode = { onBus: (type) => seen.push(type), update() {} };
    feedBall(w);
    stepFor(w, 1.6);
    assert.ok(seen.includes('ball:launch') && seen.includes('ball:bounce') && seen.includes('judge:launch') && seen.includes('judge:event'));
  });

  test('freeFlight: landing, apex and net clearance of a drive', () => {
    const f = freeFlight(v3(1, 0.9, 8), v3(-1, 4, -20), v3());
    assert.ok(f.landed);
    assert.ok(f.z < -4 && f.z > -10, `landing z ${f.z}`);
    assert.ok(f.net > 0.2 && f.apex > 0.9);
  });
});

describe('lag-compensated player hit', () => {
  test('a hit detected late equals the same hit applied on time', () => {
    const run = (late) => {
      const w = createWorld({ rng: createRng(5) });
      w.referee = createReferee({ serving: null, feedIsNeutral: true });
      stepFor(w, 0.2);
      feedBall(w, { target: { x: 2.2, z: 6.2 } });
      const c = planContact(w);
      const r = racketFor(w, c, { x: -2.5, z: -8.2 });
      stepUntil(w, c.t + (late ? 0.19 : 0));
      const shot = applyPlayerHit(w, r.contact, r.pose, r.t);
      assert.ok(shot, 'hit accepted');
      stepUntil(w, c.t + 0.6);
      return { w, shot };
    };
    const a = run(false);
    const b = run(true);
    assert.ok(a.w.ball.pos.distanceTo(b.w.ball.pos) < 1e-6, `same state: ${a.w.ball.pos.toArray()} vs ${b.w.ball.pos.toArray()}`);
    assert.ok(a.w.ball.vel.distanceTo(b.w.ball.vel) < 1e-6);
    near(a.shot.t, b.shot.t, 1e-12);
    assert.equal(a.shot.stroke, b.shot.stroke);
    assert.ok(b.w.ball.vel.z < 0, 'ball goes back toward the far side');
  });

  test('events of the old trajectory after the contact are never judged', () => {
    const w = createWorld({ rng: createRng(6) });
    const outcomes = [];
    w.referee = createReferee({ serving: null, feedIsNeutral: true, onOutcome: (o) => outcomes.push(o) });
    const judged = [];
    w.bus.on('judge:event', (p) => judged.push(p.evt));
    const hits = [];
    w.bus.on('judge:hit', (p) => hits.push(p));
    stepFor(w, 0.2);
    // A deep feed that bounces and then reaches the back glass.
    feedBall(w, { target: { x: 2.0, z: 8.3 }, speedKmh: 72 });
    const c = planContact(w, { kind: 'after-bounce', minH: 0.6 });
    const r = racketFor(w, c, { x: -2.0, z: -7.6 });
    // Run on (the old ball reaches the glass) and detect the hit late.
    stepUntil(w, c.t + 0.25);
    const glassBefore = w.flight.events.find((e) => e.type === 'wall' && e.t > c.t);
    assert.ok(glassBefore, 'the uncorrected ball did reach the glass');
    const shot = applyPlayerHit(w, r.contact, r.pose, r.t);
    assert.ok(shot);
    assert.equal(shot.afterBounce, true);
    assert.equal(shot.afterWall, false);
    stepFor(w, 3.5);
    assert.ok(!judged.some((e) => e.type === 'wall' && e.side === 'near' && e.t > c.t), 'phantom glass not judged');
    assert.equal(hits.length, 1);
    assert.ok(outcomes.length >= 1);
    assert.equal(outcomes[0].winner, 0, `player won the point (${outcomes[0].reason})`);
  });

  test('a hit reported after the referee already ruled on later events is rejected; one stroke per flight', () => {
    const w = createWorld({ rng: createRng(7) });
    w.referee = createReferee({ serving: null, feedIsNeutral: true });
    stepFor(w, 0.2);
    feedBall(w, { target: { x: 2.0, z: 6.0 } });
    const c = planContact(w);
    const r = racketFor(w, c, { x: -2, z: -8 });
    stepUntil(w, c.t + judgeDelay(w) + 0.6); // the second bounce has been judged by now
    assert.equal(applyPlayerHit(w, r.contact, r.pose, r.t), null);

    const w2 = createWorld({ rng: createRng(7) });
    w2.referee = createReferee({ serving: null, feedIsNeutral: true });
    stepFor(w2, 0.2);
    feedBall(w2, { target: { x: 2.0, z: 6.0 } });
    const shot = perfectHit(w2, { x: -2, z: -8 });
    assert.ok(shot);
    assert.equal(w2.player.lastHitAt, shot.t);
    const again = applyPlayerHit(w2, { local: { x: 0, y: RACKET.sweetSpotY }, face: 'front' }, {
      grip: w2.ball.pos.clone(), axis: v3(1, 0, 0), normal: v3(0, 0, -1), vel: v3(0, 0, -10), t: w2.time,
    }, w2.time);
    assert.equal(again, null, 'no double hit');
  });

  test('ShotRecord carries the SPEC fields', () => {
    const w = createWorld({ rng: createRng(8) });
    w.referee = createReferee({ serving: null, feedIsNeutral: true });
    const hitsOnBus = [];
    w.bus.on('ball:hit', (p) => hitsOnBus.push(p.shot));
    stepFor(w, 0.2);
    feedBall(w);
    const shot = perfectHit(w, { x: -2.4, z: -8.2 });
    for (const k of ['id', 't', 'by', 'stroke', 'contact', 'contactU', 'racketSpeed', 'speedIn', 'speedOut', 'spinRpm', 'offCenter',
      'quality', 'assist', 'timing', 'spacing', 'netClearance', 'predictedLanding', 'afterBounce', 'afterWall']) {
      assert.ok(k in shot, k);
    }
    assert.equal(shot.by, 'player');
    assert.equal(shot.assist, 'club');
    assert.equal(hitsOnBus[0], shot);
    assert.ok(['forehand', 'glass-fh', 'lob'].includes(shot.stroke), shot.stroke);
    assert.ok(shot.speedOut * 3.6 > 50 && shot.speedOut * 3.6 < 100, `speed ${shot.speedOut * 3.6}`);
    assert.ok(shot.netClearance > 0.06, `clearance ${shot.netClearance}`);
    assert.ok(shot.predictedLanding.z < 0);
    assert.ok(Math.abs(shot.contactU.x) < 2 && shot.contactU.y > 0.4);
  });
});

describe('assist', () => {
  test('intended depth per stroke: drives deep, lobs high and deep, chiquitas short', () => {
    const from = v3(2, 0.9, 8);
    const drive = intendedShot(from, v3(-1.5, 3, -16), v3(), 'forehand');
    assert.ok(drive.target.z <= -SHOT_INTENT.forehand.depth[0] + 1e-9 && drive.target.z >= -SHOT_INTENT.forehand.depth[1] - 1e-9);
    const short = intendedShot(from, v3(-1.5, 2, -20), v3(), 'forehand'); // physically lands mid-court
    near(short.target.z, -7.5, 1e-9, 'pulled to the drive window');
    const lob = intendedShot(from, v3(-0.5, 9, -9), v3(), 'lob');
    const lf = freeFlight(from, lob.vel, v3());
    assert.ok(lf.apex >= 5.4 && lf.apex <= 7.1, `lob apex ${lf.apex}`);
    const soft = intendedShot(from.clone().setZ ? from : from, v3(-0.5, 2.5, -9.5), v3(), 'forehand');
    assert.ok(soft.target.z > -5.01, `soft short ball stays a chiquita: ${soft.target.z}`);
    assert.equal(intendedShot(from, v3(0, 3, 5), v3(), 'forehand'), null, 'backwards: no intent');
  });

  test('net safety lifts a ball headed into the net (club, rookie), never for pro', () => {
    const make = () => ({ pos: v3(1, 0.7, 6), vel: v3(0, 0.3, -18), spin: v3() });
    const before = { ...freeFlight(make().pos, make().vel, make().spin) }; // freeFlight reuses its result object
    assert.ok(before.net < 0, 'into the net');
    const pro = make();
    assert.equal(applyNetSafety(pro, ASSIST.pro.netSafety), 0);
    const rookie = make();
    applyNetSafety(rookie, ASSIST.rookie.netSafety);
    const after = freeFlight(rookie.pos, rookie.vel, rookie.spin);
    assert.ok(after.net > 0.12, `rookie clearance ${after.net}`);
    near(rookie.vel.length(), make().vel.length(), 1e-9, 'pace kept');
    const club = make();
    applyNetSafety(club, ASSIST.club.netSafety);
    const cf = freeFlight(club.pos, club.vel, club.spin);
    assert.ok(cf.net > before.net, 'club lifts it partway');
  });

  test('pro assist keeps the physical shot; club blends toward the intent', () => {
    const outcome = (assist) => {
      const w = createWorld({ settings: { assist }, rng: createRng(9) });
      w.referee = createReferee({ serving: null, feedIsNeutral: true });
      stepFor(w, 0.2);
      feedBall(w);
      // Short drive: physically lands around the service line.
      return perfectHit(w, { x: -2, z: -5.2 }, { speedKmh: 60 });
    };
    const pro = outcome('pro');
    const club = outcome('club');
    near(pro.speedOut, pro.physSpeedOut, 1e-9, 'pro: no blend');
    assert.ok(club.predictedLanding.z < pro.predictedLanding.z - 0.4, `club deeper: ${club.predictedLanding.z} vs ${pro.predictedLanding.z}`);
  });
});

describe('human controller', () => {
  test('critically damped follow with speed and acceleration limits, footsteps and position history', () => {
    const w = createWorld({ rng: createRng(1) });
    const h = createHumanController({ settings: w.settings });
    w.human = h;
    const steps = [];
    w.bus.on('player:step', (p) => steps.push(p));
    w.player.home = { x: 0, z: 8 };
    stepFor(w, 0.1);
    h.moveTo({ x: 3, z: 6 });
    let vmax = 0, xmax = 0, prevV = v3();
    let amax = 0;
    for (let i = 0; i < 240 * 2; i++) {
      stepWorld(w, DT);
      vmax = Math.max(vmax, w.player.speed);
      xmax = Math.max(xmax, w.player.pos.x);
      amax = Math.max(amax, prevV.distanceTo(w.player.vel) / DT);
      prevV = w.player.vel.clone();
    }
    near(w.player.pos.x, 3, 0.01);
    near(w.player.pos.z, 6, 0.01);
    assert.ok(vmax <= PLAYER.maxSpeed + 1e-9);
    assert.ok(amax <= PLAYER.maxAccel + 1e-6, `accel ${amax}`);
    assert.ok(xmax < 3.03, `overshoot ${xmax - 3}`);
    assert.ok(steps.length >= 3, `footsteps ${steps.length}`);
    const mid = h.posAt(1.0);
    assert.ok(mid.x > 0 && mid.x <= 3.0001);
  });

  test('camera pipeline: calibrated body in the court frame, eye height, stepping moves the player (amplified)', () => {
    const w = createWorld({ rng: createRng(1) });
    const h = createHumanController({ settings: w.settings });
    w.human = h;
    const cam = createSyntheticCamera({ hfovDeg: w.settings.hfovDeg });
    w.player.home = { x: 1, z: 8 };
    let room = { x: 0, d: 2.6 };
    let nextFrame = 0;
    const run = (seconds) => {
      const end = w.time + seconds;
      while (w.time < end) {
        if (w.time >= nextFrame) {
          const b = standingBody({ room });
          h.onPoseFrame(w, cam.frame(w.time * 1000, [b]), w.time);
          nextFrame += 1 / 30;
        }
        stepWorld(w, DT);
      }
    };
    run(1.0);
    assert.ok(h.calibrate());
    run(1.0);
    const bc = w.player.bodyCourt;
    assert.ok(bc && bc.joints.wristR && bc.handFrames.L && bc.handFrames.R && bc.dominant === 'R' && bc.eye);
    near(w.player.eye.y, 1.75 * PLAYER.eyeHeightRatio, 0.03, 'eye height');
    near(w.player.pos.x, 1, 0.05);
    near(bc.joints.shoulderR.x - w.player.pos.x, 0.18, 0.04, 'joints mapped with x right');
    assert.ok(w.player.racket && w.player.racket.grip && w.player.racket.axis);
    // Step 0.5 m right and 0.4 m toward the TV.
    room = { x: 0.5, d: 2.2 };
    run(2.0);
    near(w.player.pos.x, 1 + w.settings.gainLateral * (0.5 - TRACKING.deadzone), 0.12, 'lateral gain');
    near(w.player.pos.z, 8 - w.settings.gainDepth * (0.4 - TRACKING.deadzone), 0.15, 'toward the net');
  });

  test('fallback racket poses: a swing through the ball is detected with lag compensation', () => {
    const w = createWorld({ rng: createRng(3) });
    w.referee = createReferee({ serving: null, feedIsNeutral: true });
    const h = createHumanController({ settings: w.settings });
    w.human = h;
    stepFor(w, 0.2);
    feedBall(w);
    const c = planContact(w);
    const r = racketFor(w, c, { x: -2.4, z: -8.2 });
    const lat = w.settings.latency;
    // Racket poses captured at 60 Hz: a straight swing through the contact point, at racket time = ball time + latency.
    const tr = c.t + lat;
    const pushPose = (t) => {
      const dt = t - tr;
      const grip = r.pose.grip.clone().addScaled(r.pose.vel, dt);
      h.onRacketPose(w, { grip, axis: r.pose.axis, normal: r.pose.normal }, t);
    };
    let shots = 0;
    w.bus.on('ball:hit', (p) => { if (p.shot.by === 'player' && !p.shot.provisional) shots++; });
    let tf = tr - 0.3 + 0.004;
    while (w.time < tr + 0.4) {
      if (w.time >= tf) {
        pushPose(tf);
        tf += 1 / 60;
      }
      stepWorld(w, DT);
    }
    assert.equal(shots, 1);
    const shot = h.state.lastShot;
    near(shot.t, c.t, 0.02, 'contact rewound to the ball time');
    assert.ok(w.ball.vel.z < 0 || w.ball.pos.z < 0, 'returned');
  });

  test('ideal stance puts the ball at the family contact point', () => {
    const c = v3(2, 0.95, 7);
    const s = idealStance(c, 'fh', 'right');
    near(c.x - s.x, CONTACT_OFFSETS.fh.x, 1e-12);
    near(s.z - c.z, CONTACT_OFFSETS.fh.z, 1e-12);
    const l = idealStance(c, 'fh', 'left');
    near(l.x - c.x, CONTACT_OFFSETS.fh.x, 1e-12, 'mirrored');
    assert.equal(contactFamily(v3(0, 2.1, 5), 'volley', { x: 0, z: 5 }), 'oh');
    assert.equal(contactFamily(v3(-1.2, 1.0, 3), 'volley', { x: 0, z: 3.4 }), 'vbh');
    assert.equal(contactFamily(v3(1, 1.0, 8), 'after-bounce', { x: 0.3, z: 8.3 }), 'fh');
  });
});

describe('ball machine', () => {
  const firstBounce = (world) => {
    const ev = world.flight.events.find((e) => e.type === 'bounce');
    return ev ? ev.pos : null;
  };

  test('feeds land within 30 cm of their targets (drives, deep balls, lobs, short lobs, serves)', () => {
    const programs = [
      ...Array.from({ length: 20 }, (_, i) => DRILL_BY_ID['fh-drive'].feeds(i, createRng(100 + i))),
      ...Array.from({ length: 6 }, (_, i) => DRILL_BY_ID['back-glass'].feeds(i, createRng(200 + i))),
      ...Array.from({ length: 6 }, (_, i) => DRILL_BY_ID.bandeja.feeds(i, createRng(300 + i))),
      ...Array.from({ length: 6 }, (_, i) => DRILL_BY_ID['smash-x3'].feeds(i, createRng(400 + i))),
      ...Array.from({ length: 6 }, (_, i) => DRILL_BY_ID.return.feeds(i, createRng(500 + i))),
    ];
    const w = createWorld({ rng: createRng(4) });
    const m = createMachine({ rng: createRng(44) });
    w.machine = m;
    m.load(programs, { count: programs.length, interval: 3.5, startDelay: 0.5 });
    let worst = 0;
    const misses = [];
    for (let i = 0; i < programs.length; i++) {
      stepUntil(w, 0.5 + i * 3.5 + 3.2);
      const p = firstBounce(w);
      assert.ok(p, `feed ${i} bounced`);
      const nominal = programs[i].target;
      const d = Math.hypot(p.x - nominal.x, p.z - nominal.z);
      worst = Math.max(worst, d);
      misses.push(d);
    }
    assert.equal(m.state.fed, programs.length);
    assert.ok(worst < 0.3, `worst landing error ${worst.toFixed(3)} m`);
    const mean = misses.reduce((a, b) => a + b, 0) / misses.length;
    assert.ok(mean > 0.02, 'machine scatter is not zero');
  });

  test('schedule and head: startDelay, interval, count; head aims before the feed', () => {
    const w = createWorld({ rng: createRng(4) });
    const m = createMachine({ rng: createRng(1) });
    w.machine = m;
    const launches = [];
    w.bus.on('ball:launch', () => launches.push(w.time));
    m.load([{ target: { x: -3, z: 6 }, speedKmh: 60, spinRpm: { top: 500 } }, { target: { x: 3, z: 6 }, speedKmh: 60, spinRpm: { top: 500 } }],
      { interval: 2.0, count: 3, startDelay: 1.5 });
    assert.equal(m.state.feeding, true);
    stepFor(w, 1.4);
    assert.ok(m.state.headYaw < -0.05, `head turned toward the first target (${m.state.headYaw})`);
    stepFor(w, 6);
    assert.equal(launches.length, 3);
    near(launches[0], 1.5, 2 * DT);
    near(launches[1] - launches[0], 2.0, 2 * DT);
    assert.equal(m.state.feeding, false);
    assert.equal(m.state.fed, 3);
    for (const k of ['fed', 'total', 'nextIn', 'headYaw', 'headPitch', 'feeding']) assert.ok(k in m.state, k);
  });

  test('back-glass feeds rebound off the back glass at 0.8–1.6 m; corner feeds hit back then side glass', () => {
    let inBand = 0;
    for (let i = 0; i < 12; i++) {
      const w = createWorld({ rng: createRng(i + 1) });
      const plan = planFeed(DRILL_BY_ID['back-glass'].feeds(i, createRng(i + 7)), { origin: v3(0, 1, -9.2), rng: createRng(i), court: w.court });
      launchBall(w, { pos: plan.from, vel: plan.vel, spin: plan.spin, by: 'machine' });
      stepFor(w, 2.2);
      const evs = w.flight.events;
      assert.equal(evs[0].type, 'bounce');
      const glass = evs.find((e) => e.type === 'wall' && e.wall === 'back');
      assert.ok(glass && glass.surface === 'glass', 'reaches the back glass');
      if (glass.pos.y >= 0.8 && glass.pos.y <= 1.6) inBand++;
    }
    assert.ok(inBand >= 10, `rebound height in band ${inBand}/12`);
    let corner = 0;
    for (let i = 0; i < 10; i++) {
      const w = createWorld({ rng: createRng(i + 1) });
      const plan = planFeed(DRILL_BY_ID['double-wall'].feeds(i, createRng(i + 3)), { origin: v3(0, 1, -9.2), rng: createRng(i), court: w.court });
      launchBall(w, { pos: plan.from, vel: plan.vel, spin: plan.spin, by: 'machine' });
      stepFor(w, 2.5);
      const seq = w.flight.events.filter((e) => e.type !== 'rest').map((e) => (e.type === 'wall' ? `${e.wall}` : e.type));
      if (seq[0] === 'bounce' && seq[1] === 'back' && seq[2] === 'side') corner++;
    }
    assert.ok(corner >= 8, `back-then-side corner feeds ${corner}/10`);
  });

  test('volley feeds pass the net player at chest height', () => {
    const d = DRILL_BY_ID.volleys;
    for (let i = 0; i < 6; i++) {
      const f = d.feeds(i, createRng(i + 1), { home: d.home });
      const w = createWorld();
      const plan = planFeed(f, { origin: v3(0, 1, -9.2), court: w.court });
      launchBall(w, { pos: plan.from, vel: plan.vel, spin: plan.spin, by: 'machine' });
      let y = null, prev = w.ball.pos.clone();
      while (y === null && w.time < 2) {
        stepWorld(w, DT);
        if (prev.z < f.via.z && w.ball.pos.z >= f.via.z) {
          const u = (f.via.z - prev.z) / (w.ball.pos.z - prev.z);
          y = prev.y + (w.ball.pos.y - prev.y) * u;
        }
        prev = w.ball.pos.clone();
      }
      near(y, f.via.y, 0.1, `feed ${i} height at the player`);
      assert.ok(!w.flight.events.some((e) => e.type === 'bounce' && e.t < w.time - 0.01), 'not bounced before the player');
    }
  });
});

describe('coach (AI player)', () => {
  /** Feeds player-like drives at the coach and judges its returns. */
  function rallyTest(level, n, seed = 9) {
    const w = createWorld({ rng: createRng(seed) });
    const rng = createRng(seed + 1);
    const coach = createCoach({ level, rng: createRng(seed + 2) });
    w.coach = coach;
    let outcome = null, events = [], hitT = null, shot = null;
    w.referee = createReferee({ serving: null, feedTeam: 0, onOutcome: (o) => { outcome = o; } });
    w.bus.on('judge:launch', () => {
      w.referee.reset({ serving: null, feedTeam: 0 });
      outcome = null;
      events = [];
      hitT = null;
      shot = null;
    });
    w.bus.on('judge:event', (p) => events.push(p.evt));
    w.bus.on('judge:hit', (p) => { if (p.team === 1) { hitT = p.t; shot = p.shot; } });
    const res = { feeds: 0, hits: 0, legal: 0, speeds: [], strokes: {}, sides: [] };
    for (let i = 0; i < n; i++) {
      stepFor(w, 1.5);
      const from = v3(rng.range(-3, 3), rng.range(0.8, 1.1), rng.range(6.5, 8.5));
      const target = v3(rng.range(-3.5, 3.5), 0, rng.range(-8.8, -5.5));
      const spin = spinFromComponents(v3(target.x - from.x, 0, target.z - from.z), rng.range(300, 1500), 0);
      let sol = solveShot({ from, target, spin, speed: rng.range(55, 80) / 3.6, court: w.court });
      if (!sol.ok || !sol.clearsNet || sol.netClearance < 0.3 || sol.blockedBy) sol = solveShot({ from, target, spin, apex: 2.4, court: w.court });
      launchBall(w, { pos: from, vel: sol.vel, spin, by: 'player' });
      res.feeds++;
      stepFor(w, 0.5);
      for (let k = 0; k < 240 * 7 && !outcome; k++) stepWorld(w, DT);
      if (hitT !== null) {
        res.hits++;
        res.speeds.push(shot.speedOut * 3.6);
        res.sides.push(shot.contact.z);
        res.strokes[shot.stroke] = (res.strokes[shot.stroke] || 0) + 1;
        if (shotOutcomeInfo(events, hitT, outcome, { team: 1 }).legal) res.legal++;
      }
    }
    return res;
  }

  test('club coach returns legal shots to the near side >= 80% of the time, at club pace', () => {
    const r = rallyTest('club', 30);
    assert.ok(r.legal / r.feeds >= 0.8, `legal ${r.legal}/${r.feeds}`);
    assert.ok(r.sides.every((z) => z < 0), 'always struck on its own half');
    const sorted = r.speeds.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    assert.ok(median >= 55 && median <= 85, `median pace ${median} km/h`);
    assert.ok(Object.keys(r.strokes).length >= 3, `variety ${JSON.stringify(r.strokes)}`);
  });

  test('level presets order: pro faster and steadier than rookie', () => {
    assert.ok(COACH_LEVELS.pro.sigma < COACH_LEVELS.club.sigma && COACH_LEVELS.club.sigma < COACH_LEVELS.rookie.sigma);
    assert.deepEqual(COACH_LEVELS.club.kmh, [60, 80]);
    assert.deepEqual(COACH_LEVELS.pro.kmh, [85, 100]);
    assert.deepEqual(COACH_LEVELS.rookie.kmh, [45, 60]);
    const pro = rallyTest('pro', 12, 21);
    const rookie = rallyTest('rookie', 12, 21);
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    assert.ok(avg(pro.speeds) > avg(rookie.speeds) + 12, `pro ${avg(pro.speeds)} vs rookie ${avg(rookie.speeds)}`);
  });

  test('lobs or plays chiquitas against a net player', () => {
    const w = createWorld({ rng: createRng(31) });
    const coach = createCoach({ level: 'club', rng: createRng(32) });
    w.coach = coach;
    w.player.pos.set(1, 0, 3.0);
    const choices = [];
    w.bus.on('ball:hit', (p) => { if (p.shot.by === 'coach') choices.push(p.shot.choice); });
    const rng = createRng(33);
    for (let i = 0; i < 16; i++) {
      stepFor(w, 1.2);
      const from = v3(rng.range(-2, 2), 1.0, 3.0);
      const target = v3(rng.range(-3, 3), 0, rng.range(-8.5, -7));
      const res = solveShot({ from, target, spin: v3(), speed: 16 });
      launchBall(w, { pos: from, vel: res.vel, spin: v3(), by: 'player' });
      stepFor(w, 2.5);
    }
    const tactical = choices.filter((c) => c === 'lob' || c === 'chiquita').length;
    assert.ok(choices.length >= 12, `returns ${choices.length}`);
    assert.ok(tactical / choices.length >= 0.5, `lob/chiquita share ${tactical}/${choices.length}`);
  });

  test('never volleys a serve, and does not hit its own team\'s ball', () => {
    const w = createWorld({ rng: createRng(41) });
    const coach = createCoach({ level: 'pro', rng: createRng(42) });
    w.coach = coach;
    const hits = [];
    const serves = [];
    w.bus.on('ball:hit', (p) => (p.shot.by === 'coach' ? hits : serves).push(p.shot));
    w.referee = createReferee({ serving: { team: 0, box: 'right' } });
    stepFor(w, 1.0);
    // A legal serve from the near right into the far right box (x <= 0).
    const from = v3(2, 0.8, 7.6);
    const res = solveShot({ from, target: v3(-2.5, 0, -5.5), spin: v3(), speed: 18 });
    launchBall(w, { pos: from, vel: res.vel, spin: v3(), by: 'player', strike: { team: 0, isServe: true } });
    stepFor(w, 3);
    assert.equal(serves.length, 1, 'the serve is a stroke on the bus');
    assert.equal(serves[0].isServe, true);
    assert.equal(serves[0].stroke, 'serve');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].afterBounce, true, 'serve returned after its bounce');
    // The coach's own feed is never struck by the coach.
    const before = hits.length;
    coach.feed(w);
    stepFor(w, 4);
    assert.equal(hits.length, before);
  });

  test('renderer state shape', () => {
    const w = createWorld({ rng: createRng(1) });
    const coach = createCoach({});
    w.coach = coach;
    feedBall(w, { target: { x: 1, z: 6 } });
    const holdings = new Set();
    let maxPhase = 0;
    stepFor(w, 0.2);
    const b = w.ball;
    launchBall(w, { pos: v3(0, 1, 6), vel: solveShot({ from: v3(0, 1, 6), target: v3(0.5, 0, -6.5), spin: v3(), speed: 17 }).vel, by: 'player' });
    for (let i = 0; i < 240 * 3; i++) {
      stepWorld(w, DT);
      holdings.add(coach.state.holding);
      maxPhase = Math.max(maxPhase, coach.state.swingPhase);
    }
    assert.ok(b);
    const st = coach.state;
    for (const k of ['pos', 'vel', 'facing', 'stroke', 'swingPhase', 'swingT', 'holding', 'racket']) assert.ok(k in st, k);
    assert.ok(holdings.has('swing') && holdings.has('ready'));
    assert.ok(maxPhase > 0.5 && maxPhase <= 1);
    near(st.facing, 0, 0.61, 'far coach faces +z');
    assert.ok(st.racket.grip instanceof Vec3);
  });
});

describe('drills', () => {
  const ids = ['fh-drive', 'bh-drive', 'back-glass', 'double-wall', 'volleys', 'bandeja', 'vibora', 'smash-x3', 'lob-defense', 'chiquita', 'serve', 'return', 'live-mix'];

  test('all 13 SPEC drills with the DrillDef fields; feeds are valid', () => {
    assert.deepEqual(DRILLS.map((d) => d.id), ids);
    const skills = new Set(['Groundstrokes', 'Walls', 'Net', 'Overheads', 'Tactics', 'Serve']);
    for (const d of DRILLS) {
      for (const k of ['id', 'name', 'es', 'skill', 'level', 'home', 'side', 'reps', 'interval', 'feeds', 'targets', 'scoring', 'cues']) assert.ok(k in d, `${d.id}.${k}`);
      assert.ok(skills.has(d.skill), d.skill);
      assert.ok(d.level >= 1 && d.level <= 3);
      assert.ok(d.home.z > 0 && Math.abs(d.home.x) < 5);
      assert.ok(d.cues.intro && d.cues.tips.length >= 2);
      assert.ok(d.targets.length >= 1);
      for (const zn of d.targets) assert.ok(zn.x0 < zn.x1 && zn.z0 < zn.z1 && zn.points > 0 && ['land', 'glass-after', 'exit'].includes(zn.kind));
      const f = d.feeds(0, createRng(1), { home: d.home });
      if (!f.drop) assert.ok((f.target || f.via) && f.spinRpm, d.id);
    }
    assert.equal(DRILL_BY_ID['fh-drive'].home.x, 2.3);
    assert.equal(DRILL_BY_ID.volleys.home.z, 3.2);
    assert.equal(DRILL_BY_ID['lob-defense'].opponentsAtNet, true);
  });

  test('fh-drive feeds follow the SPEC window (2.6±0.6, 5.5–6.5, 55–70 km/h, light topspin)', () => {
    const rng = createRng(3);
    for (let i = 0; i < 50; i++) {
      const f = DRILL_BY_ID['fh-drive'].feeds(i, rng);
      assert.ok(f.target.x >= 2.0 && f.target.x <= 3.2 && f.target.z >= 5.5 && f.target.z <= 6.5);
      assert.ok(f.speedKmh >= 55 && f.speedKmh <= 70 && f.spinRpm.top > 0 && f.spinRpm.top <= 1000);
    }
  });

  const shot = (o = {}) => ({
    stroke: 'forehand', speedOut: 20, netClearance: 0.6, afterBounce: true, afterWall: false, apex: 2.2, quality: 0.8,
    timing: 'good', spacing: 'good', contact: v3(2, 0.9, 7.5), ...o,
  });
  const res = (o = {}) => ({ legal: true, landing: { x: -2.5, z: -8.2 }, reason: null, ...o });

  test('drives: target, in-court, net clearance bonus, faults', () => {
    const d = DRILL_BY_ID['fh-drive'];
    assert.deepEqual(scoreShot(d, shot(), res()).points, 125);
    assert.equal(scoreShot(d, shot({ netClearance: 1.2 }), res()).points, 100);
    const mid = scoreShot(d, shot(), res({ landing: { x: 2, z: -5 } }));
    assert.equal(mid.points, 30);
    assert.equal(mid.success, false);
    const out = scoreShot(d, shot(), res({ legal: false, landing: null, reason: 'out', detail: 'glass before the bounce' }));
    assert.equal(out.points, 0);
    assert.match(out.notes[0], /long/i);
    const net = scoreShot(d, shot(), res({ legal: false, landing: null, reason: 'net' }));
    assert.match(net.notes[0], /net/i);
    assert.equal(scoreShot(DRILL_BY_ID['bh-drive'], shot({ stroke: 'backhand' }), res({ landing: { x: 2.5, z: -8 } })).success, true);
    const missed = scoreShot(d, null, res({ legal: false }));
    assert.equal(missed.points, 0);
  });

  test('back glass: points only for returns hit after the wall that land deep', () => {
    const d = DRILL_BY_ID['back-glass'];
    const early = scoreShot(d, shot({ afterWall: false }), res());
    assert.equal(early.points, 0);
    assert.match(early.notes[0], /glass/);
    assert.equal(scoreShot(d, shot({ afterWall: true, stroke: 'glass-fh' }), res()).points, 100);
    assert.equal(scoreShot(d, shot({ afterWall: true }), res({ landing: { x: 0, z: -4 } })).points, 0);
    assert.equal(scoreShot(DRILL_BY_ID['double-wall'], shot({ afterWall: true }), res({ landing: { x: 0, z: -4 } })).points, 50);
  });

  test('volleys must be volleys; overheads must be overheads; bandeja pace penalty; víbora side-glass bonus', () => {
    assert.equal(scoreShot(DRILL_BY_ID.volleys, shot({ afterBounce: true, stroke: 'forehand' }), res({ landing: { x: -3, z: -8 } })).points, 0);
    assert.equal(scoreShot(DRILL_BY_ID.volleys, shot({ afterBounce: false, stroke: 'volley-fh' }), res({ landing: { x: -3, z: -8 } })).points, 100);
    assert.equal(scoreShot(DRILL_BY_ID.volleys, shot({ afterBounce: false, stroke: 'volley-fh' }), res({ landing: { x: 0, z: -5 } })).points, 30);
    const b = DRILL_BY_ID.bandeja;
    assert.equal(scoreShot(b, shot({ stroke: 'forehand' }), res()).points, 0);
    assert.equal(scoreShot(b, shot({ stroke: 'bandeja', speedOut: 70 / 3.6 }), res()).points, 100);
    const hard = scoreShot(b, shot({ stroke: 'bandeja', speedOut: 95 / 3.6 }), res());
    assert.equal(hard.points, 50);
    assert.match(hard.notes.join(' '), /Control/);
    const v = DRILL_BY_ID.vibora;
    assert.equal(scoreShot(v, shot({ stroke: 'vibora' }), res({ landing: { x: -4, z: -8 } })).points, 100);
    assert.equal(scoreShot(v, shot({ stroke: 'vibora' }), res({ landing: { x: -4, z: -8 }, sideGlassAfterBounce: true })).points, 150);
  });

  test('smash por tres: +500 for an exit over the back wall after the bounce', () => {
    const d = DRILL_BY_ID['smash-x3'];
    assert.equal(scoreShot(d, shot({ stroke: 'smash' }), res({ landing: { x: 0, z: -5 } })).points, 100);
    const x3 = scoreShot(d, shot({ stroke: 'smash' }), res({ landing: { x: 0, z: -5 }, reason: 'por-tres', exitVia: 'back' }));
    assert.equal(x3.points, 600);
    assert.match(x3.notes[0], /tres/);
    assert.equal(scoreShot(d, shot({ stroke: 'smash' }), res({ landing: { x: 0, z: -5 }, reason: 'por-cuatro' })).points, 350);
    assert.equal(scoreShot(d, shot({ stroke: 'forehand' }), res({ reason: 'por-tres' })).points, 0, 'must be an overhead');
  });

  test('lob, chiquita, serve and return conditions', () => {
    const lob = DRILL_BY_ID['lob-defense'];
    assert.equal(scoreShot(lob, shot({ stroke: 'lob', apex: 6 }), res({ landing: { x: 0, z: -8.5 } })).points, 100);
    assert.equal(scoreShot(lob, shot({ stroke: 'lob', apex: 3.5 }), res({ landing: { x: 0, z: -8.5 } })).points, 10);
    const glassOnFull = scoreShot(lob, shot({ apex: 6 }), res({ legal: false, landing: null, reason: 'out' }));
    assert.equal(glassOnFull.points, 0);
    const ch = DRILL_BY_ID.chiquita;
    assert.equal(scoreShot(ch, shot({ speedOut: 38 / 3.6, netClearance: 0.3 }), res({ landing: { x: -1, z: -2.6 } })).points, 100);
    assert.equal(scoreShot(ch, shot({ speedOut: 55 / 3.6, netClearance: 0.3 }), res({ landing: { x: -1, z: -2.6 } })).points, 40);
    assert.equal(scoreShot(ch, shot({ speedOut: 38 / 3.6, netClearance: 0.8 }), res({ landing: { x: -1, z: -2.6 } })).points, 40);
    const sv = DRILL_BY_ID.serve;
    const low = shot({ stroke: 'serve', contact: v3(2, 0.7, 7.4) });
    assert.equal(scoreShot(sv, low, res({ landing: { x: -2, z: -4 } }), { height: 1.75 }).points, 100);
    assert.equal(scoreShot(sv, low, res({ landing: { x: -2, z: -6.3 } }), { height: 1.75 }).points, 150);
    assert.equal(scoreShot(sv, low, res({ landing: { x: -2, z: -6.3 }, sideGlassAfterBounce: true }), { height: 1.75 }).points, 200);
    assert.equal(scoreShot(sv, shot({ stroke: 'serve', contact: v3(2, 1.3, 7.4) }), res({ landing: { x: -2, z: -4 } }), { height: 1.75 }).points, 0, 'above the waist');
    assert.equal(scoreShot(sv, low, res({ legal: false, reason: 'serve-fault', detail: 'out of the box' }), { height: 1.75 }).points, 0);
    const rt = DRILL_BY_ID.return;
    assert.equal(scoreShot(rt, shot(), res()).points, 100);
    assert.equal(scoreShot(rt, shot({ apex: 6 }), res({ landing: { x: 3, z: -8.5 } })).points, 100, 'lob return');
    assert.equal(scoreShot(rt, shot(), res({ landing: { x: 3, z: -5 } })).points, 30);
  });

  test('live mix scores with the feeding drill; lefty mirror; stars', () => {
    const mix = DRILL_BY_ID['live-mix'];
    assert.equal(scoreShot(mix, shot({ afterWall: false }), res({ feed: { drillId: 'back-glass' } })).points, 0);
    assert.equal(scoreShot(mix, shot(), res({ feed: { drillId: 'fh-drive' } })).points, 125);
    const lefty = getDrill('fh-drive', 'left');
    assert.equal(lefty.home.x, -2.3);
    assert.deepEqual([lefty.targets[0].x0, lefty.targets[0].x1], [0, 5]);
    assert.equal(scoreShot(lefty, shot(), res({ landing: { x: 2.5, z: -8.2 } })).success, true);
    assert.equal(scoreShot(lefty, shot(), res({ landing: { x: -2.5, z: -8.2 } })).success, false);
    const lf = lefty.feeds(0, createRng(1), {});
    assert.ok(lf.target.x < 0);
    assert.equal(getDrill('serve', 'left').serving.box, 'left');
    assert.ok(inZone(DRILL_BY_ID['fh-drive'].targets[0], { x: 0, z: -6.95 }), 'lines are in');
    assert.equal(landZone(DRILL_BY_ID['fh-drive'], { x: 0.01, z: -8 }), null);
    const d = DRILL_BY_ID['fh-drive'];
    assert.equal(starsFor(d, 0), 0);
    assert.equal(starsFor(d, 0.2 * d.reps * 100), 1);
    assert.equal(starsFor(d, 0.45 * d.reps * 100), 2);
    assert.equal(starsFor(d, 0.7 * d.reps * 100), 3);
  });
});

describe('modes', () => {
  test('drill mode with a perfect player: reps, results, drill:end, HUD', () => {
    const w = createWorld({ rng: createRng(12) });
    const mode = createDrillMode('fh-drive', { rng: createRng(13), reps: 5, startDelay: 1 });
    w.mode = mode;
    mode.start(w);
    const log = collect(w, ['drill:rep', 'shot:result', 'drill:end', 'rally:outcome', 'coach:cue']);
    let guard = 0;
    while (!mode.isFinished() && guard++ < 60) {
      // Wait for the next feed, then play it perfectly to the deep cross-court target.
      const fed = w.machine.state.fed;
      while (w.machine.state.fed === fed && !mode.isFinished() && w.time < 60) stepWorld(w, DT);
      if (mode.isFinished()) break;
      stepFor(w, 0.05);
      perfectHit(w, { x: -2.4, z: -8.2 });
    }
    stepFor(w, 3);
    assert.ok(mode.isFinished());
    const reps = log.filter((e) => e.type === 'drill:rep');
    assert.equal(reps.length, 5);
    assert.ok(log.some((e) => e.type === 'drill:end'));
    const sum = mode.summary();
    assert.equal(sum.reps, 5);
    assert.ok(sum.successRate >= 0.8, `success ${sum.successRate}`);
    assert.ok(sum.points >= 400);
    assert.ok(sum.stars >= 2);
    const hud = mode.hud(w);
    for (const k of ['title', 'subtitle', 'repIndex', 'repTotal', 'points', 'streak', 'timer', 'score', 'lastShot', 'banner', 'prompt']) assert.ok(k in hud, k);
    assert.equal(hud.repIndex, 5);
    assert.equal(hud.lastShot.stroke.length > 0, true);
    assert.ok(log.some((e) => e.type === 'coach:cue'));
  });

  test('drill mode: back-glass awards points only after the wall (through the referee and events)', () => {
    const play = (afterWall) => {
      const w = createWorld({ rng: createRng(14) });
      const mode = createDrillMode('back-glass', { rng: createRng(15), reps: 1, startDelay: 0.5 });
      w.mode = mode;
      mode.start(w);
      const results = [];
      w.bus.on('shot:result', (p) => results.push(p));
      while (w.machine.state.fed === 0) stepWorld(w, DT);
      stepFor(w, 0.05);
      const shot = perfectHit(w, { x: -1, z: -7.6 }, { kind: afterWall ? 'after-wall' : 'after-bounce', minH: 0.5, maxH: 1.6, speedKmh: 50 });
      assert.ok(shot, 'hit');
      assert.equal(shot.afterWall, afterWall);
      stepFor(w, 5);
      return results[0];
    };
    const before = play(false);
    const after = play(true);
    assert.equal(before.points, 0);
    assert.ok(after.points >= 100, `after wall ${after.points}`);
  });

  test('drill mode: a missed feed scores 0 with a coaching note', () => {
    const w = createWorld({ rng: createRng(16) });
    const mode = createDrillMode('fh-drive', { rng: createRng(17), reps: 2, startDelay: 0.5 });
    w.mode = mode;
    mode.start(w);
    const results = [];
    w.bus.on('shot:result', (p) => results.push(p));
    stepFor(w, 9);
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.points === 0 && r.notes.length));
    assert.ok(mode.isFinished());
  });

  test('serve drill: dropped ball, served at waist height into the diagonal box', () => {
    const w = createWorld({ rng: createRng(18) });
    const mode = createDrillMode('serve', { rng: createRng(19), reps: 1, startDelay: 0.5 });
    w.mode = mode;
    mode.start(w);
    const results = [];
    w.bus.on('shot:result', (p) => results.push(p));
    stepFor(w, 0.6);
    assert.equal(w.flight.by, 'drop');
    const shot = perfectHit(w, { x: -2.5, z: -5.8 }, { minH: 0.3, maxH: 0.85, speedKmh: 60, top: 0 });
    assert.ok(shot);
    assert.equal(shot.isServe, true);
    assert.equal(shot.stroke, 'serve');
    stepFor(w, 4);
    assert.ok(results[0].points >= 100, JSON.stringify(results[0]));
  });

  test('rally mode: coach feeds and rallies with an AI near player; rally lengths are counted', () => {
    const w = createWorld({ rng: createRng(20) });
    const mode = createRallyMode({ level: 'club', rng: createRng(21), rallies: 4 });
    w.mode = mode;
    mode.start(w);
    // Stand-in for the human: the AI brain bound to the player's position.
    const stand = createCoach({ level: 'pro', side: 'near', team: 0, by: 'player', rng: createRng(22), bindPos: w.player.pos, bindVel: w.player.vel, home: { x: 0.8, z: 7.8 } });
    w.ai.push(stand);
    const outcomes = [];
    w.bus.on('rally:outcome', (p) => outcomes.push(p));
    let guard = 0;
    while (!mode.isFinished() && guard++ < 240 * 300) stepWorld(w, DT);
    assert.ok(mode.isFinished());
    assert.equal(outcomes.length, 4);
    const s = mode.summary();
    assert.ok(s.bestRally >= 3, `best rally ${s.bestRally}`);
    assert.ok(outcomes.every((o) => typeof o.rallyLength === 'number'));
    assert.equal(mode.hud(w).title, 'Rally with Coach');
  });

  test('match mode plays a full game (and set) deterministically with real scoring and serves', () => {
    const run = () => {
      const w = createWorld({ rng: createRng(1) });
      const mode = createMatchMode({ level: 'club', games: 1, rng: createRng(11), autoPlayer: true });
      w.mode = mode;
      mode.start(w);
      const log = [];
      let gameAt = null;
      w.bus.on('rally:outcome', (p) => {
        log.push(`${p.reason}:${p.winner}`);
        if (gameAt === null && p.score && (p.score.games[0] + p.score.games[1] === 1)) gameAt = log.length;
      });
      const serves = [];
      w.bus.on('ball:hit', (p) => { if (p.shot.isServe) serves.push(p.shot.team); });
      let guard = 0;
      while (!mode.isFinished() && guard++ < 240 * 1500) stepWorld(w, DT);
      return { w, mode, log, gameAt, serves };
    };
    const a = run();
    const b = run();
    assert.deepEqual(a.log, b.log, 'deterministic');
    assert.ok(a.gameAt !== null && a.gameAt >= 4, `first game after ${a.gameAt} points`);
    assert.ok(a.mode.isFinished());
    const s = a.mode.summary();
    assert.ok(s.winner === 0 || s.winner === 1);
    assert.equal(s.score.sets.length, 1);
    assert.ok(a.serves.includes(0) && a.serves.includes(1), 'both teams served');
    const reasons = new Set(a.log.map((l) => l.split(':')[0]));
    assert.ok(reasons.size >= 2, `varied endings ${[...reasons]}`);
    const hud = a.mode.hud(a.w);
    assert.ok(hud.score && Array.isArray(hud.score.games));
    // The rally ends are padel rulings.
    for (const r of reasons) assert.ok(['double-bounce', 'net', 'out', 'own-side', 'serve-fault', 'double-fault', 'por-tres', 'por-cuatro', 'ceiling', 'winner', 'let', 'volleyed-serve', 'double-hit'].includes(r), r);
  });

  test('shotOutcomeInfo: legal landing, walls after the bounce, faults', () => {
    const ev = (type, t, x, z, o = {}) => ({ type, t, pos: v3(x, o.y ?? 0, z), side: z >= 0 ? 'near' : 'far', surface: o.surface ?? 'turf', wall: o.wall ?? null, via: o.via ?? null });
    const evs = [ev('bounce', 1, 1, 6), ev('bounce', 2.0, -2, -8), ev('wall', 2.2, -5, -9, { surface: 'glass', wall: 'side', y: 1 }), ev('bounce', 2.6, -3, -6)];
    const info = shotOutcomeInfo(evs, 1.5, { winner: 0, reason: 'double-bounce', pointOver: true });
    assert.equal(info.legal, true);
    assert.deepEqual(info.landing, { x: -2, z: -8 });
    assert.equal(info.sideGlassAfterBounce, true);
    const out = shotOutcomeInfo([ev('wall', 2, 0, -10, { surface: 'glass', wall: 'back', y: 1 })], 1.5, { winner: 1, reason: 'out', pointOver: true });
    assert.equal(out.legal, false);
    assert.equal(out.landing, null);
  });
});
