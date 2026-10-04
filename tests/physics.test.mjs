import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { v3, Vec3 } from '../src/util/vec3.js';
import { createRng, rpmToRads } from '../src/util/math.js';
import { BALL, COURT, SIM, SURFACES, netHeightAt } from '../src/config.js';
import {
  createBall, cloneBall, copyBallInto, stepBall, ballSpeed, ballAccel, substepCount, isRolling,
} from '../src/physics/ball.js';
import {
  createCourt, resolveImpact, surfaceAt, sideOf, inServiceBox, floorSurfaceAt,
} from '../src/physics/court.js';
import { createBallHistory } from '../src/physics/history.js';
import { predict, solveShot } from '../src/physics/predict.js';

const R = BALL.radius;
const DT = 1 / SIM.tickRate;
const W2500 = rpmToRads(2500);

/** Steps until pred(ball, events) is true or maxTime elapses. Returns the events. */
function run(ball, court, { maxTime = 5, rng = null, until = null, onTick = null } = {}) {
  const events = [];
  const n = Math.ceil(maxTime / DT);
  for (let i = 0; i < n; i++) {
    stepBall(ball, DT, court, rng, events);
    if (onTick) onTick(ball, events);
    if (until && until(ball, events)) break;
  }
  return events;
}

const first = (events, type) => events.find((e) => e.type === type) || null;

// ---------------------------------------------------------------------------

describe('ball state', () => {
  test('createBall copies inputs and assigns unique ids', () => {
    const p = v3(1, 2, 3);
    const a = createBall(p, v3(4, 5, 6), v3(7, 8, 9));
    const b = createBall();
    p.x = 99;
    assert.equal(a.pos.x, 1);
    assert.ok(a.pos instanceof Vec3);
    assert.notEqual(a.id, b.id);
    assert.deepEqual(
      { t: a.t, outside: a.outside, atRest: a.atRest, lastSurface: a.lastSurface },
      { t: 0, outside: false, atRest: false, lastSurface: null },
    );
  });

  test('cloneBall is a deep copy; copyBallInto copies every field', () => {
    const a = createBall(v3(1, 2, 3), v3(4, 5, 6), v3(7, 8, 9));
    a.t = 1.25; a.outside = true; a.lastSurface = 'glass';
    const c = cloneBall(a);
    assert.deepEqual(c, a);
    assert.notEqual(c.pos, a.pos);
    c.vel.x = -1;
    assert.equal(a.vel.x, 4);
    const d = createBall();
    copyBallInto(d, a);
    assert.deepEqual(d, a);
    assert.notEqual(d.spin, a.spin);
  });

  test('one 240 Hz tick is exactly 4 substeps (960 Hz)', () => {
    assert.equal(substepCount(1 / 240), 4);
    assert.equal(substepCount(1 / 60), 16);
    assert.equal(substepCount(1e-5), 1);
  });

  test('stepBall advances t by exactly dt', () => {
    const b = createBall(v3(0, 2, 5), v3(0, 0, -5));
    stepBall(b, DT, createCourt(), null, []);
    assert.equal(b.t, DT);
    stepBall(b, 0.05, createCourt(), null, []);
    assert.ok(Math.abs(b.t - (DT + 0.05)) < 1e-15);
  });
});

describe('aerodynamics', () => {
  test('ballAccel: gravity only at rest, drag opposes velocity', () => {
    const a = ballAccel(createBall(v3(0, 1, 0)), new Vec3());
    assert.deepEqual(a.toArray(), [0, -SIM.gravity, 0]);
    const b = createBall(v3(0, 1, 0), v3(0, 0, -30));
    const acc = ballAccel(b);
    const kd = (0.5 * BALL.airDensity * BALL.dragCoef * Math.PI * R * R) / BALL.mass;
    assert.ok(Math.abs(acc.z - kd * 900) < 1e-9, `drag ${acc.z}`);
    assert.ok(acc.z > 15 && acc.z < 20, 'tennis-like ball decelerates ~17 m/s^2 at 30 m/s');
  });

  test('Magnus: topspin pushes down, backspin lifts, sidespin curves; C_L saturates', () => {
    // Travelling -z: topspin has the top of the ball moving forward, i.e. spin -x.
    const top = ballAccel(createBall(v3(), v3(0, 0, -25), v3(-W2500, 0, 0)));
    const back = ballAccel(createBall(v3(), v3(0, 0, -25), v3(W2500, 0, 0)));
    assert.ok(top.y < -SIM.gravity - 3, `topspin ay ${top.y}`);
    assert.ok(back.y > -SIM.gravity + 3, `backspin ay ${back.y}`);
    // Spin about +y with -z travel: w x v = (+y) x (-z) = -x -> curves to -x.
    const side = ballAccel(createBall(v3(), v3(0, 0, -25), v3(0, W2500, 0)));
    assert.ok(side.x < -3);
    // Huge spin: lift capped at maxLiftCoef.
    const huge = ballAccel(createBall(v3(), v3(0, 0, -10), v3(5000, 0, 0)));
    const kl = (0.5 * BALL.airDensity * Math.PI * R * R) / BALL.mass;
    assert.ok(Math.abs(huge.y + SIM.gravity - kl * BALL.maxLiftCoef * 100) < 1e-9);
    // Spin parallel to velocity (rifle spin) gives no lift.
    const rifle = ballAccel(createBall(v3(), v3(0, 0, -20), v3(0, 0, 300)));
    assert.ok(Math.abs(rifle.x) < 1e-12 && Math.abs(rifle.y + SIM.gravity) < 1e-12);
  });

  test('(2) drag: 30 m/s horizontal ball slows to 24–26 m/s over 10 m', () => {
    const b = createBall(v3(0, 3, 9), v3(0, 0, -30));
    let prevZ = b.pos.z, prevV = 30;
    while (b.pos.z > -1) {
      prevZ = b.pos.z;
      prevV = ballSpeed(b);
      stepBall(b, DT, null, null, null);
    }
    const u = (prevZ + 1) / (prevZ - b.pos.z);
    const v10 = prevV + (ballSpeed(b) - prevV) * u;
    assert.ok(v10 >= 24 && v10 <= 26, `speed after 10 m: ${v10}`);
  });

  test('spin decays exponentially with spinDecayTau', () => {
    const b = createBall(v3(0, 5, 0), v3(0, 0, -1), v3(100, 0, 0));
    stepBall(b, 0.5, null, null, null);
    assert.ok(Math.abs(b.spin.x - 100 * Math.exp(-0.5 / BALL.spinDecayTau)) < 1e-9);
  });

  test('(3) topspin drive lands measurably shorter than flat, backspin longer', () => {
    const floorOnly = createCourt({ walls: false, net: false });
    const ang = (6 * Math.PI) / 180;
    const land = (wx) => {
      const b = createBall(v3(0, 1, 9), v3(0, 25 * Math.sin(ang), -25 * Math.cos(ang)), v3(wx, 0, 0));
      return run(b, floorOnly, { until: (_, e) => e.length > 0 })[0].pos.z; // floor contact (in or beyond the court)
    };
    const top = land(-W2500), flat = land(0), back = land(W2500);
    const dTop = 9 - top, dFlat = 9 - flat, dBack = 9 - back;
    assert.ok(dFlat - dTop > 1.5, `topspin ${dTop.toFixed(2)} m vs flat ${dFlat.toFixed(2)} m`);
    assert.ok(dBack - dFlat > 1.5, `backspin ${dBack.toFixed(2)} m vs flat ${dFlat.toFixed(2)} m`);
  });
});

describe('impact model (Brody/Cross grip–slip)', () => {
  test('(1) FIP drop test: 2.54 m drop onto turf rebounds 1.35–1.45 m', () => {
    const b = createBall(v3(0, 2.54 + R, 3));
    let bounced = false, maxBottom = 0;
    const ev = run(b, createCourt(), {
      maxTime: 2,
      onTick: (ball, e) => {
        if (e.length) bounced = true;
        if (bounced) maxBottom = Math.max(maxBottom, ball.pos.y - R);
      },
      until: (ball) => bounced && ball.vel.y < 0 && maxBottom > 0.5,
    });
    const bounce = first(ev, 'bounce');
    assert.equal(bounce.surface, 'turf');
    assert.ok(bounce.impactSpeed > 6.7 && bounce.impactSpeed < 7.06, `impact ${bounce.impactSpeed}`);
    assert.ok(maxBottom >= 1.35 && maxBottom <= 1.45, `rebound ${maxBottom.toFixed(3)} m`);
  });

  test('grip regime leaves the contact point rolling; rejects receding balls', () => {
    const b = createBall(v3(), v3(2, -5, 0), v3());
    const res = resolveImpact(b, v3(0, 1, 0), SURFACES.turf);
    assert.equal(res.slip, false);
    // Contact point velocity v + w x (-r n) has no tangential part after a grip.
    const vc = new Vec3().crossVectors(b.spin, v3(0, -R, 0)).add(b.vel);
    assert.ok(Math.abs(vc.x) < 1e-9 && Math.abs(vc.z) < 1e-9);
    assert.ok(b.spin.z < 0, 'rolling toward +x spins about -z');
    const recede = createBall(v3(), v3(0, 3, 0));
    assert.equal(resolveImpact(recede, v3(0, 1, 0), SURFACES.turf).impactSpeed, 0);
    assert.equal(recede.vel.y, 3);
  });

  test('skidding ball slips: tangential loss limited by mu * normal impulse', () => {
    const b = createBall(v3(), v3(0, -6, -24));
    const res = resolveImpact(b, v3(0, 1, 0), SURFACES.turf);
    assert.equal(res.slip, true);
    const dvt = 24 - -b.vel.z;
    assert.ok(Math.abs(dvt - SURFACES.turf.mu * (1 + res.e) * 6) < 1e-9);
  });

  test('topspin kicks forward off the turf, flat skids less', () => {
    const vIn = v3(0, -6, -20);
    const flat = createBall(v3(), vIn);
    const top = createBall(v3(), vIn, v3(-W2500, 0, 0));
    resolveImpact(flat, v3(0, 1, 0), SURFACES.turf);
    resolveImpact(top, v3(0, 1, 0), SURFACES.turf);
    assert.ok(-top.vel.z > -flat.vel.z + 0.3);
  });

  test('(4) glass at 10 m/s normal: normal speed ratio 0.6–0.75', () => {
    const b = createBall(v3(0, 1.5, -9.5), v3(0, 0, -10));
    const wall = first(run(b, createCourt(), { maxTime: 0.2 }), 'wall');
    assert.equal(wall.surface, 'glass');
    assert.equal(wall.wall, 'back');
    assert.equal(wall.side, 'far');
    const ratio = wall.vel.z / wall.impactSpeed;
    assert.ok(ratio >= 0.6 && ratio <= 0.75, `glass ratio ${ratio}`);
    assert.ok(Math.abs(wall.pos.z + COURT.halfLength) < 1e-9, 'contact point on the glass');
  });

  test('(5) backspin descending onto back glass comes off lower and dies nearer the glass than topspin', () => {
    const court = createCourt();
    const shot = (wx) => {
      const b = createBall(v3(0, 1.6, -8.5), v3(0, -4, -12), v3(wx, 0, 0));
      let maxAfter = -Infinity;
      const ev = run(b, court, {
        maxTime: 2,
        onTick: (ball, e) => { if (first(e, 'wall')) maxAfter = Math.max(maxAfter, ball.pos.y); },
        until: (_, e) => !!first(e, 'bounce'),
      });
      const wall = first(ev, 'wall');
      const bounce = first(ev, 'bounce');
      return {
        wall, maxAfter,
        dist: bounce.pos.z + COURT.halfLength, // how far it came out before landing
        flight: bounce.t - wall.t,
      };
    };
    const top = shot(-W2500); // topspin for -z travel
    const back = shot(W2500); // backspin (bandeja / víbora)
    assert.equal(top.wall.surface, 'glass');
    assert.equal(back.wall.surface, 'glass');
    assert.ok(back.wall.vel.y < top.wall.vel.y - 2, `exit vy back ${back.wall.vel.y} vs top ${top.wall.vel.y}`);
    assert.ok(back.maxAfter <= top.maxAfter + 0.05);
    assert.ok(back.dist < top.dist - 1, `lands ${back.dist.toFixed(2)} m vs ${top.dist.toFixed(2)} m from glass`);
    assert.ok(back.flight < top.flight, 'reaches the floor sooner (sticks to the glass)');
  });

  test('(6) mesh: much deader than glass, randomness only through the seeded rng', () => {
    const hit = (y, rng) => {
      const b = createBall(v3(1, y, -9.5), v3(0, 0, -10));
      const w = first(run(b, createCourt(), { maxTime: 0.2, rng }), 'wall');
      return { w, ratio: w.vel.z / w.impactSpeed, vel: w.vel.toArray() };
    };
    const glass = hit(1.5, null);
    const meshDet = hit(3.5, null);
    assert.equal(meshDet.w.surface, 'mesh');
    assert.ok(meshDet.ratio < 0.4 && glass.ratio - meshDet.ratio > 0.3, `mesh ${meshDet.ratio} glass ${glass.ratio}`);
    // Deterministic without an rng, and equal to the expected value of the jitter.
    assert.deepEqual(hit(3.5, null).vel, meshDet.vel);
    assert.equal(meshDet.w.vel.x, 0);
    // Same seed -> identical; different seeds -> different, all much deader than glass.
    assert.deepEqual(hit(3.5, createRng(7)).vel, hit(3.5, createRng(7)).vel);
    assert.notDeepEqual(hit(3.5, createRng(7)).vel, hit(3.5, createRng(8)).vel);
    let sum = 0, tilted = 0;
    for (let s = 1; s <= 200; s++) {
      const m = hit(3.5, createRng(s));
      assert.ok(m.ratio < 0.45 && m.ratio > 0.1, `seed ${s} ratio ${m.ratio}`);
      assert.ok(m.w.vel.z > 0, 'always leaves the mesh');
      if (Math.abs(m.w.vel.x) > 0.05) tilted++;
      sum += Math.hypot(...m.vel);
    }
    assert.ok(tilted > 150, 'mesh scatters the ball sideways');
    const meanSpeed = sum / 200;
    const detSpeed = Math.hypot(...meshDet.vel);
    assert.ok(Math.abs(meanSpeed - detSpeed) / detSpeed < 0.05, `mean ${meanSpeed} vs expected ${detSpeed}`);
  });
});

describe('court enclosure', () => {
  test('(7) no tunnelling at 60 m/s: back glass, side glass, net, corner, big dt', () => {
    const court = createCourt();
    const cases = [
      { name: 'back glass', pos: v3(0, 1.5, -8), vel: v3(0, 0, -60), ok: (b) => b.pos.z >= -10 + R - 1e-9, expect: 'wall' },
      { name: 'near back glass', pos: v3(-2, 1.5, 8), vel: v3(0, 0, 60), ok: (b) => b.pos.z <= 10 - R + 1e-9, expect: 'wall' },
      { name: 'side glass', pos: v3(3, 1.5, 9), vel: v3(60, 0, 0), ok: (b) => b.pos.x <= 5 - R + 1e-9, expect: 'wall' },
      { name: 'side mesh', pos: v3(-3, 1.5, 3), vel: v3(-60, 0, 0), ok: (b) => b.pos.x >= -5 + R - 1e-9, expect: 'wall' },
      { name: 'net body', pos: v3(0.5, 0.45, 2), vel: v3(0, 0.6, -60), ok: (b) => b.pos.z > 0, expect: 'net' },
      { name: 'net from far', pos: v3(-1, 0.4, -2), vel: v3(0, 0.6, 60), ok: (b) => b.pos.z < 0, expect: 'net' },
      { name: 'corner', pos: v3(3, 1.5, -8), vel: v3(42, 0, -42), ok: (b) => Math.abs(b.pos.x) <= 5 - R + 1e-9 && b.pos.z >= -10 + R - 1e-9, expect: 'wall' },
    ];
    for (const dt of [DT, 1 / 30]) {
      for (const c of cases) {
        const b = createBall(c.pos, c.vel);
        const events = [];
        for (let i = 0; i < Math.ceil(0.5 / dt); i++) {
          stepBall(b, dt, court, null, events);
          assert.ok(c.ok(b), `${c.name} dt=${dt} leaked: ${b.pos.toArray()}`);
          assert.ok(b.pos.y >= R - 1e-9, `${c.name} below floor`);
        }
        assert.ok(first(events, c.expect), `${c.name}: no ${c.expect} event`);
        assert.equal(b.outside, false, c.name);
      }
    }
  });

  test('(8) low 20 m/s ball into the net body drops on the hitter\'s side', () => {
    const b = createBall(v3(1, 0.4, 5), v3(0, 1, -20), v3(-150, 0, 0));
    let minZ = Infinity;
    const ev = run(b, createCourt(), { maxTime: 6, onTick: (ball) => { minZ = Math.min(minZ, ball.pos.z); } });
    const net = first(ev, 'net');
    assert.ok(net, 'net event');
    assert.equal(net.surface, 'netBody');
    assert.equal(net.side, 'near');
    assert.ok(net.vel.length() < 0.15 * net.impactSpeed + 0.5, 'net swallows the pace');
    assert.ok(minZ > 0, `crossed the net: ${minZ}`);
    assert.ok(b.atRest && b.pos.z > 0 && b.pos.z < 1.5, `rests near the net: ${b.pos.z}`);
    assert.ok(!ev.some((e) => e.type === 'bounce' && e.side === 'far'));
  });

  test('(9) a ball skimming the cord is deflected (netcord event)', () => {
    const y0 = netHeightAt(0) + 0.045; // within cord + ball radius of the cord axis
    const b = createBall(v3(0, y0, 0.6), v3(0, 0, -20));
    const ev = run(b, createCourt(), { maxTime: 0.1 });
    const cord = first(ev, 'netcord');
    assert.ok(cord, 'cord touched');
    assert.equal(cord.surface, 'netCord');
    assert.ok(cord.vel.y > 1, `kicked up: ${cord.vel.y}`);
    assert.ok(Math.abs(cord.vel.z) < 19.5, 'lost pace');
    assert.ok(!first(ev, 'net'));
    // A ball clearly above the cord is untouched.
    const clear = createBall(v3(0, netHeightAt(0) + 0.1, 0.6), v3(0, 0, -20));
    assert.equal(first(run(clear, createCourt(), { maxTime: 0.1 }), 'netcord'), null);
  });

  test('(10) exits: above 4 m over the back wall, above meshTop over the side', () => {
    const court = createCourt();
    const back = createBall(v3(0, 4.5, -8), v3(0, 2, -15));
    const ev = run(back, court, { maxTime: 3 });
    const exit = first(ev, 'exit');
    assert.ok(exit);
    assert.equal(exit.via, 'back');
    assert.equal(exit.wall, 'back');
    assert.equal(exit.surface, null);
    assert.equal(exit.side, 'far');
    assert.ok(exit.pos.y > COURT.backWall.meshTop);
    assert.ok(Math.abs(exit.pos.z + 10) < 1e-6);
    assert.equal(back.outside, true);
    assert.equal(first(ev, 'wall'), null);
    assert.ok(ev.some((e) => e.type === 'outside-bounce' && e.surface === 'outsideFloor'));
    assert.ok(back.pos.z < -10, 'stays outside');

    const side = createBall(v3(4, 3.5, -3), v3(10, 1, 0));
    const ev2 = run(side, court, { maxTime: 2 });
    assert.equal(first(ev2, 'exit').via, 'side');
    assert.equal(first(ev2, 'wall'), null);
    assert.ok(side.pos.x > 5);

    // Same flight 1 m lower hits the 3 m side mesh instead.
    const low = createBall(v3(4, 2.5, -3), v3(10, 1, 0));
    const ev3 = run(low, court, { maxTime: 0.5 });
    assert.equal(first(ev3, 'exit'), null);
    assert.equal(first(ev3, 'wall').surface, 'mesh');
    assert.equal(first(ev3, 'wall').wall, 'side');
  });

  test('(11) corner shot: back wall then side wall, in order, ball stays inside', () => {
    const b = createBall(v3(3.5, 1.5, -8.5), v3(8, 0.5, -10));
    const ev = run(b, createCourt(), { maxTime: 0.6 });
    const walls = ev.filter((e) => e.type === 'wall');
    assert.ok(walls.length >= 2);
    assert.deepEqual(walls.slice(0, 2).map((e) => e.wall), ['back', 'side']);
    assert.ok(walls[0].t < walls[1].t);
    assert.ok(walls.slice(0, 2).every((e) => e.surface === 'glass'));
    assert.ok(Math.abs(b.pos.x) < 5 && b.pos.z > -10);
  });

  test('exact corner: both walls resolved within one substep', () => {
    // Both planes are reached at the same instant.
    const b = createBall(v3(4, 1.5, -9), v3(20, 0, -20));
    const events = [];
    for (let i = 0; i < 20; i++) stepBall(b, DT, createCourt(), null, events);
    const walls = events.filter((e) => e.type === 'wall');
    assert.equal(walls.length, 2);
    assert.ok(Math.abs(walls[0].t - walls[1].t) < 1 / 960);
    assert.ok(b.vel.x < 0 && b.vel.z > 0, 'reflected out of the corner');
  });

  test('ceiling contact emits a ceiling event and reflects', () => {
    const b = createBall(v3(0, 9.5, -2), v3(0, 6, 0));
    const ev = run(b, createCourt(), { maxTime: 0.3 });
    const c = first(ev, 'ceiling');
    assert.ok(c);
    assert.equal(c.surface, 'ceiling');
    assert.ok(c.vel.y < 0);
    assert.ok(Math.abs(c.pos.y - COURT.ceiling) < 1e-9);
  });

  test('(12) rolling ball and a bouncing ball both come to rest with a rest event', () => {
    const roll = createBall(v3(0, R, 5), v3(2, 0, 0));
    assert.ok(isRolling(roll));
    const ev = run(roll, createCourt(), { maxTime: 10, until: (b) => b.atRest });
    const rest = first(ev, 'rest');
    assert.ok(rest);
    assert.equal(rest.surface, 'turf');
    assert.equal(rest.side, 'near');
    const travelled = roll.pos.x;
    assert.ok(travelled > 1 && travelled < 4, `rolled ${travelled} m`);
    const p = roll.pos.clone();
    stepBall(roll, 1, createCourt(), null, ev);
    assert.ok(roll.pos.equals(p));
    assert.equal(ev.filter((e) => e.type === 'rest').length, 1);

    const drop = createBall(v3(0, 1.5, -4), v3(0.5, 0, 0));
    const ev2 = run(drop, createCourt(), { maxTime: 15, until: (b) => b.atRest });
    assert.ok(drop.atRest, 'dropped ball settles');
    const bounces = ev2.filter((e) => e.type === 'bounce');
    assert.ok(bounces.length > 5 && bounces.length < 40, `${bounces.length} bounces`);
    assert.equal(ev2.at(-1).type, 'rest');
    assert.equal(ev2.at(-1).side, 'far');
  });

  test('event objects carry every field of the contract', () => {
    const b = createBall(v3(2, 1.2, 4), v3(0, 1, -14));
    const ev = run(b, createCourt(), { maxTime: 3 });
    assert.ok(ev.length > 2);
    for (const e of ev) {
      for (const k of ['type', 't', 'pos', 'vel', 'side', 'surface', 'wall', 'impactSpeed', 'via']) {
        assert.ok(k in e, `${e.type} missing ${k}`);
      }
      assert.ok(e.pos instanceof Vec3 && e.vel instanceof Vec3);
      assert.ok(Number.isFinite(e.t) && Number.isFinite(e.impactSpeed));
    }
    for (let i = 1; i < ev.length; i++) assert.ok(ev[i].t >= ev[i - 1].t, 'events in time order');
    const bounce = first(ev, 'bounce');
    assert.equal(bounce.pos.y, 0);
    assert.equal(bounce.side, 'far');
    assert.equal(bounce.wall, null);
    assert.equal(bounce.via, null);
    assert.equal(b.lastSurface, ev.filter((e) => e.surface).at(-1).surface);
  });

  test('deterministic option ignores the rng', () => {
    const go = (opts) => {
      const b = createBall(v3(0, 3.5, -9), v3(0, 0, -10));
      const events = [];
      for (let i = 0; i < 40; i++) stepBall(b, DT, createCourt(), createRng(3), events, opts);
      return b.vel.toArray();
    };
    const det = go({ deterministic: true });
    const b = createBall(v3(0, 3.5, -9), v3(0, 0, -10));
    for (let i = 0; i < 40; i++) stepBall(b, DT, createCourt(), null, []);
    assert.deepEqual(det, b.vel.toArray());
    assert.notDeepEqual(go({}), det);
  });

  test('colliders and dims are exposed', () => {
    const court = createCourt();
    assert.equal(court.dims, COURT);
    const ids = court.colliders.map((c) => c.id);
    for (const id of ['floor', 'ceiling', 'back-far', 'back-near', 'side-right', 'side-left', 'net-body', 'net-cord']) {
      assert.ok(ids.includes(id), id);
    }
  });
});

describe('court helpers', () => {
  test('surfaceAt follows FIP bands', () => {
    assert.equal(surfaceAt('back', 1, 10), 'glass');
    assert.equal(surfaceAt('back', 3, 10), 'glass');
    assert.equal(surfaceAt('back', 3.5, 10), 'mesh');
    assert.equal(surfaceAt('back', 4.01, 10), null);
    assert.equal(surfaceAt('side', 2.9, 9), 'glass');
    assert.equal(surfaceAt('side', 3.5, 9), 'mesh');
    assert.equal(surfaceAt('side', 4.5, 9), null);
    assert.equal(surfaceAt('side', 1.5, 7), 'glass');
    assert.equal(surfaceAt('side', 2.5, 7), 'mesh');
    assert.equal(surfaceAt('side', 3.2, 7), null);
    assert.equal(surfaceAt('side', 0.5, 3), 'mesh');
    assert.equal(surfaceAt('side', 3.1, 3), null);
  });

  test('sideOf and floorSurfaceAt', () => {
    assert.equal(sideOf(3), 'near');
    assert.equal(sideOf(-0.01), 'far');
    assert.equal(floorSurfaceAt(4.9, -9.9), 'turf');
    assert.equal(floorSurfaceAt(5.2, 0), 'outsideFloor');
    assert.equal(floorSurfaceAt(0, -10.5), 'outsideFloor');
  });

  test('inServiceBox: receiver\'s own right/left, lines in', () => {
    // Near receiver faces -z: right box is x > 0.
    assert.equal(inServiceBox(2, 3, 'near', 'right'), true);
    assert.equal(inServiceBox(-2, 3, 'near', 'right'), false);
    assert.equal(inServiceBox(-2, 3, 'near', 'left'), true);
    // Far receiver faces +z: right box is x < 0.
    assert.equal(inServiceBox(-2, -3, 'far', 'right'), true);
    assert.equal(inServiceBox(2, -3, 'far', 'right'), false);
    assert.equal(inServiceBox(2, -3, 'far', 'left'), true);
    // Lines count as in.
    assert.equal(inServiceBox(0, 6.95, 'near', 'right'), true);
    assert.equal(inServiceBox(0, 6.95, 'near', 'left'), true);
    assert.equal(inServiceBox(5, -6.95, 'far', 'left'), true);
    // Beyond the service line, wrong half, or outside the court.
    assert.equal(inServiceBox(1, 6.96, 'near', 'right'), false);
    assert.equal(inServiceBox(1, -3, 'near', 'right'), false);
    assert.equal(inServiceBox(5.01, 3, 'near', 'right'), false);
    assert.equal(inServiceBox(1, 0, 'near', 'right'), false);
    // Serve from the server's right (near, x>0) goes cross-court to the far receiver's right (x<0).
    assert.equal(inServiceBox(-3, -5, 'far', 'right'), true);
  });
});

describe('ball history', () => {
  const simulate = (ticks, hist) => {
    const b = createBall(v3(1, 1, 8), v3(0, 4, -22), v3(-200, 0, 0));
    const court = createCourt();
    hist.push(b);
    for (let i = 0; i < ticks; i++) {
      stepBall(b, DT, court, null, []);
      hist.push(b);
    }
    return b;
  };

  test('(13) interpolation, exact rewind, truncation and capacity', () => {
    const h = createBallHistory(1.5, 240);
    assert.equal(h.capacity, 361);
    assert.equal(h.latest(), null);
    assert.equal(h.at(0), null);
    const ball = simulate(400, h);
    assert.equal(h.length, 361);
    assert.ok(h.latest().pos.equals(ball.pos, 0));
    assert.notEqual(h.latest().pos, ball.pos);
    assert.ok(Math.abs(h.oldest().t - 40 * DT) < 1e-12, 'oldest ticks dropped');
    assert.equal(h.at(10 * DT), null, 'before the buffer');

    const i = 200;
    const a = h.get(i), b = h.get(i + 1);
    // Exactly on a tick: that snapshot.
    const onTick = h.at(a.t);
    assert.ok(onTick.pos.equals(a.pos, 1e-12) && onTick.vel.equals(a.vel, 1e-12));
    // Between ticks: linear blend.
    const mid = h.at((a.t + b.t) / 2);
    assert.ok(mid.pos.equals(new Vec3().lerpVectors(a.pos, b.pos, 0.5), 1e-12));
    assert.ok(mid.vel.equals(new Vec3().lerpVectors(a.vel, b.vel, 0.5), 1e-12));
    // Interpolation tracks the true flight closely (sub-millimetre).
    const truth = cloneBall(a);
    stepBall(truth, DT / 2, createCourt(), null, []);
    if (!h.get(i + 1).lastSurface || h.get(i + 1).lastSurface === a.lastSurface) {
      assert.ok(truth.pos.distanceTo(mid.pos) < 1e-3, `interp error ${truth.pos.distanceTo(mid.pos)}`);
    }
    // Beyond the newest: clamps to newest.
    assert.ok(h.at(ball.t + 1).pos.equals(ball.pos, 0));
    // Rewind: exact deep copy of the tick at or before t.
    const rw = h.rewindTo(a.t + 0.4 * DT);
    assert.deepEqual(rw, { ...a, pos: a.pos.clone(), vel: a.vel.clone(), spin: a.spin.clone() });
    assert.notEqual(rw.pos, a.pos);
    assert.equal(h.indexAt(a.t + 0.4 * DT), i);
    assert.equal(h.indexAt(0), -1);
    assert.equal(h.rewindTo(0), null);

    // Rewind and re-simulate reproduces the present bit for bit (lag compensation).
    const re = h.rewindTo(a.t);
    const n = h.length - 1 - i;
    for (let k = 0; k < n; k++) stepBall(re, DT, createCourt(), null, []);
    assert.deepEqual(re.pos.toArray(), ball.pos.toArray());
    assert.deepEqual(re.vel.toArray(), ball.vel.toArray());
    assert.equal(re.t, ball.t);

    // Truncate after a time drops newer ticks; pushes then continue from there.
    h.truncateAfter(a.t + 0.5 * DT);
    assert.equal(h.length, i + 1);
    assert.ok(h.latest().pos.equals(a.pos, 0));
    const next = cloneBall(a);
    stepBall(next, DT, createCourt(), null, []);
    h.push(next);
    assert.equal(h.length, i + 2);
    // Pushing a snapshot at an existing time replaces it instead of unsorting the buffer.
    h.push(cloneBall(a));
    assert.equal(h.length, i + 1);

    h.clear();
    assert.equal(h.length, 0);
    assert.equal(h.rewindTo(1), null);
  });

  test('history never interpolates between two different balls', () => {
    const h = createBallHistory();
    const a = createBall(v3(0, 1, 0));
    a.t = 1;
    const b = createBall(v3(4, 1, 0));
    b.t = 1 + DT;
    h.push(a);
    h.push(b);
    assert.equal(h.at(1 + DT / 2).pos.x, 0);
    assert.equal(h.at(1 + DT).pos.x, 4);
  });
});

describe('performance', () => {
  test('(14) 10 s of rally-like flight with many bounces in < 50 ms', () => {
    const court = createCourt();
    let rng;
    const shoot = (b, i) => {
      // Drives, lobs and slices from wherever the ball is, back over the net.
      const dir = b.pos.z > 0 ? -1 : 1;
      if (b.outside || Math.abs(b.pos.z) < 3) b.pos.set(rng.range(-3, 3), 1, -dir * 8);
      b.pos.y = Math.max(b.pos.y, 0.4);
      b.vel.set(rng.range(-3, 3), i % 3 === 1 ? 8 : 3.5, dir * rng.range(14, 22));
      b.spin.set(dir * (i % 2 ? 1 : -1) * rng.range(50, 280), rng.range(-40, 40), 0);
      b.atRest = false;
      b.outside = false;
    };
    const simulate = () => {
      rng = createRng(42);
      const b = createBall(v3(0, 1, 8));
      const events = [];
      let shots = 0, lastShot = 0, bouncesSeen = 0;
      shoot(b, shots++);
      for (let i = 0; i < 10 * SIM.tickRate; i++) {
        const n0 = events.length;
        stepBall(b, DT, court, rng, events);
        for (let k = n0; k < events.length; k++) if (events[k].type === 'bounce') bouncesSeen++;
        // The receiver plays it after the bounce, on the way down (often after the glass).
        const playable = bouncesSeen > 0 && b.vel.y < 0 && b.pos.y < 1.0;
        if (b.atRest || b.outside || playable || b.t - lastShot > 3) {
          shoot(b, shots++);
          lastShot = b.t;
          bouncesSeen = 0;
        }
      }
      return { events, shots };
    };
    simulate(); // warm-up (JIT)
    const t0 = performance.now();
    const { events, shots } = simulate();
    const ms = performance.now() - t0;
    assert.ok(shots >= 6, `${shots} shots`);
    assert.ok(events.length >= 10, `${events.length} events`);
    assert.ok(events.some((e) => e.type === 'bounce'));
    assert.ok(events.some((e) => e.type === 'wall'));
    assert.ok(ms < 50, `${ms.toFixed(1)} ms`);
  });
});

// ---------------------------------------------------------------------------
// Sand-filled turf at steep, fast impacts: por tres is reachable only for hard smashes.

describe('turf crater: smashes, bandejas and drives', () => {
  const RPM = (r) => rpmToRads(r);
  /** Topspin (+) / sidespin about +y for travel toward -z. */
  const spinFor = (top, side = 0) => v3(-RPM(top), RPM(side), 0);
  /** Solves a shot from `from` landing on `target` at kmh (launch speed) and plays it out. */
  const play = (court, from, target, kmh, spin = v3()) => {
    const s = solveShot({ from, target, spin, speed: kmh / 3.6, court });
    assert.ok(s.ok, `solve ${kmh} km/h to ${target.z}`);
    const p = predict(createBall(from, s.vel, spin), court, { maxTime: 4, stopOn: ['exit', 'rest'] });
    const bounce = first(p.events, 'bounce');
    const after = p.events.slice(p.events.indexOf(bounce) + 1);
    return { bounce, exit: first(p.events, 'exit'), wall: first(after, 'wall'), events: p.events };
  };
  const SMASH_FROM = v3(0, 2.8, 2.5);
  const SMASH_TO = v3(0, 0, -3);

  test('140 km/h flat smash from near the net, bounced 3 m past it, goes out over the back wall (por tres)', () => {
    const court = createCourt();
    for (const spin of [v3(), spinFor(600), spinFor(-600)]) {
      const r = play(court, SMASH_FROM, SMASH_TO, 140, spin);
      assert.equal(r.bounce.side, 'far');
      assert.ok(Math.abs(r.bounce.pos.z + 3) < 0.06, `bounce z ${r.bounce.pos.z}`);
      assert.ok(r.exit, 'exits');
      assert.equal(r.exit.via, 'back');
      assert.ok(r.exit.pos.y > COURT.backWall.meshTop);
      assert.ok(r.bounce.t < r.exit.t && !r.events.some((e) => e.type === 'wall' && e.t < r.exit.t), 'bounce then straight out');
    }
    // Without the crater (rigid-floor model) the same smash only reaches the back fence.
    const rigid = play(createCourt({ surfaces: { turf: { craterK: 0 } } }), SMASH_FROM, SMASH_TO, 140);
    assert.equal(rigid.exit, null);
  });

  test('angled 140 km/h smash goes out over the side (por cuatro)', () => {
    const r = play(createCourt(), v3(1.5, 2.8, 2.5), v3(3.5, 0, -3), 140);
    assert.ok(r.exit);
    assert.equal(r.exit.via, 'side');
    assert.equal(r.exit.side, 'far');
  });

  test('100 km/h smash and 70 km/h bandejas stay in the court', () => {
    const court = createCourt();
    const slow = play(court, SMASH_FROM, SMASH_TO, 100);
    assert.equal(slow.exit, null);
    assert.ok(slow.wall && slow.wall.wall === 'back' && slow.wall.pos.y < COURT.backWall.meshTop, `back wall at ${slow.wall?.pos.y}`);
    for (const [from, to] of [[v3(0, 2.6, 4), v3(0, 0, -3)], [v3(0, 2.6, 6), v3(0, 0, -5)], [v3(1, 2.5, 5), v3(-1.5, 0, -7)]]) {
      const b = play(court, from, to, 70, spinFor(-900));
      assert.equal(b.exit, null, `bandeja to ${to.z}`);
      assert.ok(b.wall && b.wall.surface === 'glass' && b.wall.pos.y < 2.0, `bandeja glass y ${b.wall?.pos.y}`);
    }
  });

  test('por tres window: needs pace and a bounce close to the net', () => {
    const court = createCourt();
    const out = (kmh, lz) => !!play(court, SMASH_FROM, v3(0, 0, lz), kmh).exit;
    assert.ok(out(120, -3) && out(150, -3) && out(140, -2));
    assert.ok(!out(140, -4.5) && !out(100, -3) && !out(110, -3.5));
  });

  test('drives keep a realistic bounce: 0.6–1.3 m at the back glass, at most 0.2 m above the rigid model', () => {
    const court = createCourt();
    const rigid = createCourt({ surfaces: { turf: { craterK: 0 } } });
    for (const kmh of [60, 80, 100]) {
      for (const lz of [-6.5, -7]) {
        const from = v3(0.5, 1.0, 8), to = v3(-0.5, 0, lz), spin = spinFor(1200);
        const a = play(court, from, to, kmh, spin);
        const b = play(rigid, from, to, kmh, spin);
        assert.equal(a.wall.surface, 'glass');
        const y = a.wall.pos.y;
        assert.ok(y >= 0.6 && y <= 1.3, `${kmh} km/h to ${lz}: glass at ${y.toFixed(2)} m`);
        const dy = y - b.wall.pos.y;
        assert.ok(dy >= 0 && dy < 0.2, `${kmh} km/h: crater changed the glass height by ${dy.toFixed(2)} m`);
      }
    }
  });

  test('crater: vertical drops are unchanged, steep fast balls rebound steeper, shallow ones barely', () => {
    const turf = createCourt().surfaces.turf;
    const plain = { ...turf, craterK: 0 };
    const drop = (s) => { const b = createBall(v3(), v3(0, -6.9, 0)); resolveImpact(b, v3(0, 1, 0), s); return b.vel; };
    assert.deepEqual(drop(turf).toArray(), drop(plain).toArray());
    const angleOut = (s, vin) => { const b = createBall(v3(), vin); resolveImpact(b, v3(0, 1, 0), s); return Math.atan2(b.vel.y, -b.vel.z) * 180 / Math.PI; };
    const smash = v3(0, -16.6, -31.2);
    assert.ok(angleOut(turf, smash) - angleOut(plain, smash) > 8, 'smash kicks up');
    const drive = v3(0, -4.6, -16.3);
    assert.ok(angleOut(turf, drive) - angleOut(plain, drive) < 2.5, 'drive almost unchanged');
    const b = createBall(v3(), smash.clone());
    resolveImpact(b, v3(0, 1, 0), turf);
    assert.ok(b.vel.y > 0 && b.vel.z < 0, 'still leaves forward and up');
  });
});
