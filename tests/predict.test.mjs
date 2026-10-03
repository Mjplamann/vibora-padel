import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { v3 } from '../src/util/vec3.js';
import { createRng, msToKmh } from '../src/util/math.js';
import { BALL, COURT, SIM, netHeightAt } from '../src/config.js';
import { createBall, stepBall } from '../src/physics/ball.js';
import { createCourt } from '../src/physics/court.js';
import { spinFromComponents } from '../src/physics/racket.js';
import {
  predict, solveShot, interceptCandidates, netClearance, firstBounce, REACTION_TIME,
} from '../src/physics/predict.js';

const R = BALL.radius;
const court = createCourt();

/** Spin vector for a shot from `from` toward `target` with top/side rpm. */
function shotSpin(from, target, top, side = 0) {
  return spinFromComponents(v3(target.x - from.x, 0, target.z - from.z), top, side);
}

describe('predict', () => {
  test('clones the ball, samples every dt from ball.t and stops on exit/rest', () => {
    const ball = createBall(v3(0, 2, 6), v3(0, 12, 10), v3()); // popped up over the near back wall
    ball.t = 12.5;
    const snapshot = JSON.stringify(ball);
    const p = predict(ball, court);
    assert.equal(JSON.stringify(ball), snapshot, 'input untouched');
    assert.equal(p.samples[0].t, 12.5);
    assert.ok(p.samples[0].pos.equals(ball.pos) && p.samples[0].pos !== ball.pos);
    for (let i = 1; i < p.samples.length; i++) {
      assert.ok(Math.abs(p.samples[i].t - p.samples[i - 1].t - 1 / 240) < 1e-9);
    }
    const last = p.events[p.events.length - 1];
    assert.equal(last.type, 'exit');
    assert.equal(last.via, 'back');
    assert.ok(p.samples[p.samples.length - 1].t - last.t < 1 / 240 + 1e-9, 'stops in the exit step');
    assert.ok(p.ball.outside);
  });

  test('respects maxTime, custom stopOn and dt', () => {
    const ball = createBall(v3(0, 1, -8), v3(0, 3, 14), v3());
    const p = predict(ball, court, { maxTime: 0.5 });
    assert.ok(Math.abs(p.samples[p.samples.length - 1].t - 0.5) < 1e-9);
    const q = predict(ball, court, { stopOn: ['bounce'], dt: 1 / 120 });
    assert.equal(q.events[q.events.length - 1].type, 'bounce');
    assert.ok(Math.abs(q.samples[1].t - 1 / 120) < 1e-12);
  });

  test('deterministic by default (mesh uses its expected value) and repeatable', () => {
    // Into the near back mesh (3–4 m).
    const ball = createBall(v3(0, 2.5, 4), v3(0, 3.5, 16), v3());
    const a = predict(ball, court);
    const b = predict(ball, court);
    const mesh = a.events.find((e) => e.surface === 'mesh');
    assert.ok(mesh, 'hits the mesh');
    assert.deepEqual(a.events, b.events);
    assert.deepEqual(a.samples[a.samples.length - 1], b.samples[b.samples.length - 1]);
    // A live (seeded) prediction scatters but is reproducible for the same seed.
    const s1 = predict(ball, court, { deterministic: false, rng: createRng(7) });
    const s2 = predict(ball, court, { deterministic: false, rng: createRng(7) });
    assert.deepEqual(s1.events, s2.events);
  });

  test('matches stepping the real ball tick by tick', () => {
    const ball = createBall(v3(1, 1, -9), v3(-1, 4, 16), v3(-200, 0, 0));
    const p = predict(ball, court, { maxTime: 2 });
    const live = createBall(ball.pos, ball.vel, ball.spin);
    for (let i = 1; i < p.samples.length; i++) {
      stepBall(live, 1 / SIM.tickRate, court, null, null, { deterministic: true });
      assert.ok(live.pos.equals(p.samples[i].pos, 1e-12));
    }
  });

  test('an already-resting ball returns just its own sample', () => {
    const ball = createBall(v3(1, R, 5));
    ball.atRest = true;
    const p = predict(ball, court);
    assert.equal(p.samples.length, 1);
    assert.equal(p.events.length, 0);
  });
});

describe('netClearance and firstBounce', () => {
  test('clearance at the first crossing agrees with a fine integration', () => {
    const ball = createBall(v3(-1, 1.1, 8), v3(0.4, 3.4, -21), shotSpin(v3(0, 0, 8), v3(0, 0, -8), 1500));
    const p = predict(ball, court);
    const fine = predict(ball, court, { dt: 1 / 1920 });
    const c = netClearance(p);
    assert.ok(c > 0.1 && c < 1.0, `clearance ${c}`);
    assert.ok(Math.abs(c - netClearance(fine)) < 0.005);
    // Only the first crossing counts even if the ball comes back off the far glass.
    const back = p.events.find((e) => e.type === 'wall');
    if (back) assert.ok(c > 0.1);
    const fb = firstBounce(p);
    assert.equal(fb.type, 'bounce');
    assert.equal(fb.side, 'far');
    assert.equal(fb, p.events.find((e) => e.type === 'bounce'));
  });

  test('null without a crossing; negative into the net; below r + cordRadius on a tape clip', () => {
    const stay = predict(createBall(v3(0, 1, 8), v3(0, 3, -6)), court, { stopOn: ['bounce'] });
    assert.equal(netClearance(stay), null);
    const intoNet = predict(createBall(v3(0, 0.5, 6), v3(0, 0.5, -18)), court);
    assert.ok(intoNet.events.some((e) => e.type === 'net'));
    assert.ok(netClearance(intoNet) < 0, `${netClearance(intoNet)}`);
    // ~20 m/s nearly flat ball: drops ~0.11 m over the 3 m to the net.
    const reach = R + COURT.net.cordRadius;
    const skim = predict(createBall(v3(0, 0.88 + 0.03 + 0.11, 3), v3(0, 0, -20)), court);
    assert.ok(skim.events.some((e) => e.type === 'netcord'), 'clips the tape');
    const cs = netClearance(skim);
    assert.ok(cs > 0 && cs < reach, `tape clip clearance ${cs}`);
    const clean = predict(createBall(v3(0, 0.88 + 0.12 + 0.11, 3), v3(0, 0, -20)), court, { stopOn: ['bounce'] });
    assert.ok(!clean.events.some((e) => e.type === 'netcord' || e.type === 'net'));
    const cc = netClearance(clean);
    assert.ok(cc > reach && cc < 0.2, `clean clearance ${cc}`);
    assert.equal(firstBounce({ samples: [], events: [] }), null);
  });
});

describe('solveShot', () => {
  test('20 seeded random shots from both halves (drives, slices, lobs) land within 5 cm', (t) => {
    const rng = createRng(20261003);
    const lines = [];
    let maxErr = 0;
    let totalMs = 0;
    for (let i = 0; i < 20; i++) {
      const nearHitter = i % 2 === 0;
      const sgn = nearHitter ? 1 : -1;
      const from = v3(rng.range(-4, 4), rng.range(0.5, 1.3), sgn * rng.range(5.5, 9.5));
      const target = v3(rng.range(-4.3, 4.3), 0, -sgn * rng.range(4, 9.3));
      const kind = ['drive', 'slice', 'lob', 'lob-slice', 'speed'][i % 5];
      let args;
      if (kind === 'drive') args = { flightTime: rng.range(0.85, 1.3), top: rng.range(1000, 3000) };
      else if (kind === 'slice') args = { flightTime: rng.range(1.0, 1.4), top: -rng.range(1000, 2500) };
      else if (kind === 'lob') args = { apex: rng.range(6, 7), top: rng.range(500, 1500) };
      else if (kind === 'lob-slice') args = { apex: rng.range(6, 7), top: -rng.range(500, 1500) };
      else args = { speed: rng.range(20, 26), top: rng.range(1500, 2500) };
      const spin = shotSpin(from, target, args.top, rng.range(-300, 300));
      const t0 = performance.now();
      const r = solveShot({ from, target, spin, flightTime: args.flightTime ?? null, apex: args.apex ?? null, speed: args.speed ?? null, court });
      totalMs += performance.now() - t0;

      assert.ok(r.ok, `shot ${i} (${kind}) error ${r.error}`);
      assert.ok(r.error < 0.05);
      maxErr = Math.max(maxErr, r.error);
      assert.equal(r.landing.y, 0);
      if (args.apex) assert.ok(Math.abs(r.apex - args.apex) < 0.05, `apex ${r.apex} vs ${args.apex}`);
      if (args.flightTime) assert.ok(Math.abs(r.flightTime - args.flightTime) < 0.01, `T ${r.flightTime}`);
      if (args.speed) assert.ok(Math.abs(r.vel.length() - args.speed) < 0.05);
      assert.ok(r.clearsNet, `shot ${i} (${kind}) net clearance ${r.netClearance}`);
      assert.equal(r.blockedBy, null);

      // Independent check with the live court simulation: the first bounce is where we aimed.
      const p = predict(createBall(from, r.vel, spin), court, { stopOn: ['bounce', 'outside-bounce'] });
      const fb = firstBounce(p);
      assert.ok(fb, `shot ${i} bounced`);
      const miss = Math.hypot(fb.pos.x - target.x, fb.pos.z - target.z);
      assert.ok(miss < 0.05, `shot ${i} (${kind}) real landing miss ${miss}`);
      assert.equal(fb.side, nearHitter ? 'far' : 'near');
      assert.ok(Math.abs(netClearance(p) - r.netClearance) < 0.02);
      lines.push(`${i} ${kind.padEnd(9)} ${nearHitter ? 'near->far' : 'far->near'} ` +
        `${msToKmh(r.vel.length()).toFixed(0).padStart(3)} km/h T=${r.flightTime.toFixed(2)}s ` +
        `apex=${r.apex.toFixed(2)}m net+${r.netClearance.toFixed(2)}m miss=${(miss * 100).toFixed(2)}cm it=${r.iterations}`);
    }
    t.diagnostic(`max solver error ${(maxErr * 100).toFixed(2)} cm, ${(totalMs / 20).toFixed(1)} ms per solve`);
    for (const l of lines) t.diagnostic(l);
  });

  test('mode priority: apex beats flightTime; default is a 1.0 s flight', () => {
    const from = v3(0, 1, -9);
    const target = v3(1, 0, 7);
    const both = solveShot({ from, target, apex: 6.5, flightTime: 1.0 });
    assert.equal(both.mode, 'apex');
    assert.ok(Math.abs(both.apex - 6.5) < 0.05);
    const def = solveShot({ from, target });
    assert.equal(def.mode, 'time');
    assert.ok(Math.abs(def.flightTime - 1.0) < 0.01);
    assert.equal(def.blockedBy, null, 'no court -> no obstacle check');
  });

  test('drag and Magnus matter: the solution differs from the vacuum ballistic guess', () => {
    const from = v3(0, 1, 8);
    const target = v3(0, 0, -8);
    const T = 1.0;
    const top = solveShot({ from, target, flightTime: T, spin: shotSpin(from, target, 2500) });
    const back = solveShot({ from, target, flightTime: T, spin: shotSpin(from, target, -2500) });
    const vacuumVz = (target.z - from.z) / T;
    assert.ok(top.vel.z < vacuumVz - 1, 'drag needs extra pace');
    // Topspin needs more lift at launch, backspin less, for the same flight time.
    assert.ok(top.vel.y > back.vel.y + 1, `${top.vel.y} vs ${back.vel.y}`);
  });

  test('reports a shot the net would stop', () => {
    const from = v3(0, 0.4, 2);
    const target = v3(0, 0, -1.5);
    const r = solveShot({ from, target, flightTime: 0.22, court });
    assert.ok(r.ok);
    assert.ok(!r.clearsNet, `clearance ${r.netClearance}`);
    assert.ok(r.blockedBy === 'net' || r.blockedBy === 'netcord', `${r.blockedBy}`);
  });

  test('speed mode reaches realistic pace on the low trajectory', () => {
    const from = v3(2, 1, 8.5);
    const target = v3(-3, 0, -8.5);
    const r = solveShot({ from, target, speed: 100 / 3.6, spin: shotSpin(from, target, 2000), court });
    assert.equal(r.mode, 'speed');
    assert.ok(r.ok && Math.abs(r.vel.length() - 100 / 3.6) < 0.05);
    assert.ok(r.apex < 2.5, `low drive apex ${r.apex}`);
    assert.ok(r.clearsNet);
  });
});

describe('interceptCandidates', () => {
  // Deep machine feed that bounces at z ≈ 8.2 and comes off the near back glass.
  const from = v3(0, 1.0, -9.2);
  const target = v3(2.4, 0, 8.2);
  const spin = shotSpin(from, target, 600);
  const shot = solveShot({ from, target, flightTime: 1.05, spin, court });
  const ball = createBall(from, shot.vel, spin);
  const pred = predict(ball, court);
  const bounces = pred.events.filter((e) => e.type === 'bounce' && e.side === 'near');
  const wall = pred.events.find((e) => e.type === 'wall' && e.side === 'near');
  const opts = { playerPos: { x: 2.3, z: 7.8 }, maxSpeed: 4.5, reachRadius: 0.9, minHeight: 0.2, maxHeight: 2.6, side: 'near' };

  test('scenario: bounce, then back glass, then a second bounce', (t) => {
    assert.ok(shot.ok);
    assert.ok(bounces.length >= 2, 'bounces twice on the near side');
    assert.ok(wall && wall.wall === 'back' && wall.surface === 'glass');
    assert.ok(bounces[0].t < wall.t && wall.t < bounces[1].t);
    assert.ok(wall.pos.y > 0.6 && wall.pos.y < 2.0, `glass contact height ${wall.pos.y}`);
    const c = interceptCandidates(pred, opts);
    const count = (k) => c.filter((x) => x.kind === k).length;
    t.diagnostic(`feed ${msToKmh(shot.vel.length()).toFixed(0)} km/h, bounce z=${bounces[0].pos.z.toFixed(2)} @${bounces[0].t.toFixed(2)}s, ` +
      `glass y=${wall.pos.y.toFixed(2)} @${wall.t.toFixed(2)}s, 2nd bounce z=${bounces[1].pos.z.toFixed(2)} @${bounces[1].t.toFixed(2)}s; ` +
      `candidates volley ${count('volley')}, after-bounce ${count('after-bounce')}, after-wall ${count('after-wall')}; ` +
      `best ${c[0].kind} y=${c[0].pos.y.toFixed(2)} z=${c[0].pos.z.toFixed(2)} slack=${c[0].slack.toFixed(2)}s`);
  });

  test('labels volley / after-bounce / after-wall by event order', () => {
    const c = interceptCandidates(pred, opts);
    const kinds = new Set(c.map((x) => x.kind));
    assert.ok(kinds.has('volley') && kinds.has('after-bounce') && kinds.has('after-wall'), [...kinds].join(','));
    for (const x of c) {
      if (x.kind === 'volley') assert.ok(x.t <= bounces[0].t + 1e-9);
      if (x.kind === 'after-bounce') assert.ok(x.t > bounces[0].t && x.t <= wall.t + 1e-9);
      if (x.kind === 'after-wall') assert.ok(x.t > wall.t);
      assert.ok(x.t <= bounces[1].t + 1e-9, 'nothing after the second bounce');
      assert.ok(x.pos.z >= 0 && x.pos.z <= COURT.halfLength);
    }
  });

  test('slack, travel and height filters follow the SPEC formula', () => {
    const c = interceptCandidates(pred, opts);
    const t0 = pred.samples[0].t;
    for (const x of c) {
      const d = Math.hypot(x.pos.x - opts.playerPos.x, x.pos.z - opts.playerPos.z);
      assert.ok(Math.abs(x.travel - Math.max(0, d - opts.reachRadius)) < 1e-12);
      assert.ok(Math.abs(x.slack - ((x.t - t0) - x.travel / opts.maxSpeed - REACTION_TIME)) < 1e-12);
      assert.ok(x.slack >= 0);
      assert.ok(x.pos.y >= opts.minHeight && x.pos.y <= opts.maxHeight);
    }
    // A player far away and slow cannot reach the early part of the flight.
    const slow = interceptCandidates(pred, { ...opts, playerPos: { x: -4, z: 2 }, maxSpeed: 2 });
    assert.ok(slow.length < c.length);
    for (const x of slow) assert.ok(x.slack >= 0);
    // fromTime and side filters.
    const late = interceptCandidates(pred, { ...opts, fromTime: wall.t });
    assert.ok(late.every((x) => x.t >= wall.t && x.kind === 'after-wall'));
    assert.equal(interceptCandidates(pred, { ...opts, side: 'far', fromTime: 0.5 }).length, 0);
  });

  test('preference: comfortable groundstrokes first, then volleys', () => {
    const c = interceptCandidates(pred, opts);
    assert.ok(c[0].kind !== 'volley');
    assert.ok(c[0].pos.y >= 0.6 && c[0].pos.y <= 1.3 && c[0].comfortable && !c[0].cramped);
    assert.ok(COURT.halfLength - c[0].pos.z >= 0.6, 'room to swing in front of the glass');
    // For this deep feed the textbook answer is to let it come off the glass.
    assert.equal(c[0].kind, 'after-wall');
    const firstVolley = c.findIndex((x) => x.kind === 'volley');
    const lastComfort = c.map((x) => x.kind !== 'volley' && x.comfortable && !x.cramped).lastIndexOf(true);
    assert.ok(lastComfort < firstVolley);
    // Within a group, earliest first.
    for (let i = 1; i < c.length; i++) {
      const same = c[i].kind === c[i - 1].kind && c[i].comfortable === c[i - 1].comfortable && c[i].cramped === c[i - 1].cramped;
      if (same) assert.ok(c[i].t >= c[i - 1].t);
    }
  });

  test('a ball that hits the near glass on the full is dead after the wall', () => {
    const f = v3(0, 1.2, -9);
    const full = createBall(f, v3(1, 6.5, 24.5), v3()); // reaches the back glass before bouncing
    const p = predict(full, court);
    const w = p.events.find((e) => e.type === 'wall' && e.side === 'near');
    const b = p.events.find((e) => e.type === 'bounce' && e.side === 'near');
    assert.ok(w && (!b || w.t < b.t), 'glass before the bounce');
    const c = interceptCandidates(p, { ...opts, playerPos: { x: 0.5, z: 8 } });
    assert.ok(c.length > 0);
    assert.ok(c.every((x) => x.kind === 'volley' && x.t <= w.t + 1e-9));
  });
});
