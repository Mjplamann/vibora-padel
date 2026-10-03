import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { v3, Vec3 } from '../src/util/vec3.js';
import { DEG, msToKmh, createRng } from '../src/util/math.js';
import { BALL, RACKET, SIM } from '../src/config.js';
import { createBall, ballAccel } from '../src/physics/ball.js';
import {
  racketFace, pointOnRacket, sweptContact, racketImpact, blendTowardIntent,
  spinComponents, spinFromComponents,
} from '../src/physics/racket.js';

const R = BALL.radius;
const HALF_T = RACKET.thickness / 2;
const DT30 = 1 / 30;

/** Unit direction rotated `deg` from base toward toward (both unit, perpendicular). */
function tilt(base, toward, deg) {
  return base.clone().scale(Math.cos(deg * DEG)).addScaled(toward, Math.sin(deg * DEG));
}

/**
 * Builds a racket segment and a ball segment that meet at the middle of the segment:
 * the face point at racket-local (offX, sweetSpotY + offY) and the ball centre coincide
 * at t = dt/2 (centre-to-face, i.e. the ball would be half way through the face).
 */
function setup({
  racketVel, ballVel, axis = v3(1, 0, 0), normal = v3(0, 0, -1), off = [0, 0], dt = DT30,
  meet = v3(0.4, 1.0, 7.0), phase = 0.5, ballSpin = v3(), angVel = null,
}) {
  const face = racketFace({ grip: v3(), axis, normal }, {});
  const gripAtMeet = meet.clone().addScaled(face.xAxis, -off[0]).addScaled(axis, -(RACKET.sweetSpotY + off[1]));
  const tm = phase * dt;
  const poseA = { grip: gripAtMeet.clone().addScaled(racketVel, -tm), axis: axis.clone(), normal: normal.clone(), vel: racketVel.clone(), angVel, t: 0 };
  const poseB = { grip: gripAtMeet.clone().addScaled(racketVel, dt - tm), axis: axis.clone(), normal: normal.clone(), vel: racketVel.clone(), angVel, t: dt };
  const ballA = createBall(meet.clone().addScaled(ballVel, -tm), ballVel, ballSpin);
  ballA.t = 0;
  const ballB = createBall(meet.clone().addScaled(ballVel, dt - tm), ballVel, ballSpin);
  ballB.t = dt;
  return { poseA, poseB, ballA, ballB };
}

/** Detects the contact and applies the impact to a ball at the contact state. */
function hit(cfg, margin = 0.02, impactOpts = {}) {
  const s = setup(cfg);
  const contact = sweptContact(s.poseA, s.poseB, s.ballA, s.ballB, margin);
  if (!contact) return { contact: null };
  const ball = createBall(contact.ballPos, contact.ballVel, cfg.ballSpin || v3());
  const info = racketImpact(ball, contact.pose, contact, impactOpts);
  return { contact, ball, info, ...s };
}

describe('racket geometry', () => {
  test('racketFace builds an orthonormal frame centred on the face', () => {
    const pose = { grip: v3(1, 1, 5), axis: v3(0, 1, 0), normal: v3(0.2, 0.1, -1).normalize() };
    const f = racketFace(pose);
    assert.ok(Math.abs(f.normal.length() - 1) < 1e-12);
    assert.ok(Math.abs(f.normal.dot(f.yAxis)) < 1e-12, 'normal made orthogonal to the axis');
    assert.ok(Math.abs(f.xAxis.dot(f.yAxis)) < 1e-12 && Math.abs(f.xAxis.dot(f.normal)) < 1e-12);
    assert.ok(f.xAxis.clone().cross(f.yAxis).equals(f.normal, 1e-12), 'right-handed: X x Y = Z');
    assert.ok(f.center.equals(v3(1, 1 + RACKET.faceCenterY, 5), 1e-12));
    assert.equal(f.semiX, RACKET.faceSemiX);
    assert.equal(f.semiY, RACKET.faceSemiY);
    // Reuses the out object's vectors.
    const c = f.center;
    racketFace(pose, f);
    assert.equal(f.center, c);
  });

  test('pointOnRacket maps racket-local coordinates (origin at the grip)', () => {
    const pose = { grip: v3(0, 1, 7), axis: v3(1, 0, 0), normal: v3(0, 0, -1) };
    const sweet = pointOnRacket(pose, 0, RACKET.sweetSpotY);
    assert.ok(sweet.equals(v3(RACKET.sweetSpotY, 1, 7), 1e-12));
    // X = Y x Z = (+x) x (-z) = +y.
    const rim = pointOnRacket(pose, RACKET.faceSemiX, RACKET.faceCenterY, new Vec3());
    assert.ok(rim.equals(v3(RACKET.faceCenterY, 1 + RACKET.faceSemiX, 7), 1e-12));
  });
});

describe('racketImpact: SPEC sanity targets and real padel numbers', () => {
  test('15 m/s ball vs 15 m/s racket head-on leaves at 26–29 m/s (~100 km/h)', () => {
    const r = hit({ racketVel: v3(0, 0, -15), ballVel: v3(0, 0, 15) });
    assert.ok(r.contact, 'contact detected');
    assert.equal(r.contact.face, 'front');
    assert.ok(Math.abs(r.contact.approachSpeed - 30) < 0.05, `approach ${r.contact.approachSpeed}`);
    assert.ok(r.info.speedOut >= 26 && r.info.speedOut <= 29, `speedOut ${r.info.speedOut}`);
    assert.ok(r.ball.vel.z < -25 && Math.abs(r.ball.vel.x) < 1e-6 && Math.abs(r.ball.vel.y) < 1e-6);
    assert.equal(r.info.speedIn, 15);
    assert.equal(r.info.racketSpeed, 15);
    assert.ok(r.info.offCenter < 1e-6 && r.info.quality > 0.999);
    assert.equal(r.info.eA, RACKET.apparentCOR);
    assert.ok(r.info.hit);
  });

  test('pro drive 80–110 km/h, smash 110–150 km/h, bandeja 60–85 km/h with backspin', () => {
    // Drive: 17 m/s head, 25 m/s incoming feed, slight upward brush.
    const fwd = v3(0, 0, -1), up = v3(0, 1, 0);
    const drive = hit({ racketVel: tilt(fwd, up, 12).scale(17), ballVel: v3(0, -2, 16) });
    const driveKmh = msToKmh(drive.info.speedOut);
    assert.ok(driveKmh >= 80 && driveKmh <= 110, `drive ${driveKmh} km/h`);
    assert.ok(drive.info.spinRpm.top > 300, `drive topspin ${drive.info.spinRpm.top}`);

    // Smash: lob dropping at 9 m/s, racket head ~27 m/s travelling forward and down,
    // face square to the swing (racket pointing up, face toward the far court).
    const smashDir = tilt(fwd, v3(0, -1, 0), 15);
    const smash = hit({
      racketVel: smashDir.clone().scale(27), ballVel: v3(0, -8.5, 3),
      axis: v3(0, 1, 0).projectOnPlane(smashDir).normalize(), normal: smashDir, meet: v3(0.3, 2.6, 5),
    });
    const smashKmh = msToKmh(smash.info.speedOut);
    assert.ok(smashKmh >= 110 && smashKmh <= 150, `smash ${smashKmh} km/h`);
    assert.ok(smash.ball.vel.y < 0, 'smash goes down');

    // Bandeja: controlled ~16 m/s overhead swing travelling forward and 30° down with the
    // face opened 25° (slice) against a lob dropping at 8 m/s: flat-ish, 60–85 km/h, backspin.
    const open = tilt(fwd, up, 25);
    const bandeja = hit({
      racketVel: tilt(fwd, v3(0, -1, 0), 30).scale(16), ballVel: v3(0, -8, 4),
      axis: v3(1, 0, 0), normal: open, meet: v3(0.3, 2.4, 5),
    });
    const bKmh = msToKmh(bandeja.info.speedOut);
    assert.ok(bKmh >= 60 && bKmh <= 85, `bandeja ${bKmh} km/h`);
    const bTop = bandeja.info.spinRpm.top;
    assert.ok(bTop <= -800 && bTop >= -2500, `bandeja spin ${bTop}`);
    const bAngle = Math.atan2(bandeja.ball.vel.y, -bandeja.ball.vel.z) / DEG;
    assert.ok(bAngle > -12 && bAngle < 8, `bandeja launch ${bAngle} deg`);
  });

  test('upward brush (racket velocity 25° above the face normal) gives 900–2500 rpm topspin', () => {
    const fwd = v3(0, 0, -1), up = v3(0, 1, 0);
    const r = hit({ racketVel: tilt(fwd, up, 25).scale(15), ballVel: v3(0, 0, 15) });
    const top = r.info.spinRpm.top;
    assert.ok(top >= 900 && top <= 2500, `topspin ${top} rpm`);
    assert.ok(r.ball.spin.x < 0, 'topspin for a ball travelling -z spins about -x');
    assert.ok(Math.abs(r.info.spinRpm.side) < 1, 'no sidespin from a vertical brush');
    assert.ok(r.ball.vel.y > 0 && r.ball.vel.z < -20, 'leaves forward and slightly up');
    const a = ballAccel(r.ball);
    assert.ok(a.y < -SIM.gravity - 3, `Magnus dips the ball (ay ${a.y})`);
  });

  test('more brush means more spin; a downward brush gives slice', () => {
    const fwd = v3(0, 0, -1), up = v3(0, 1, 0);
    const spinAt = (deg) => hit({ racketVel: tilt(fwd, up, deg).scale(15), ballVel: v3(0, 0, 15) }).info.spinRpm.top;
    const s10 = spinAt(10), s25 = spinAt(25), s40 = spinAt(40);
    assert.ok(s10 < s25 && s25 < s40, `${s10} < ${s25} < ${s40}`);
    assert.ok(s40 < 4000, 'brushing is bounded by friction and the rolling limit');
    const slice = spinAt(-30);
    assert.ok(slice <= -900 && slice >= -3000, `slice ${slice}`);
    const sliced = hit({ racketVel: tilt(fwd, up, -30).scale(15), ballVel: v3(0, 0, 15) });
    assert.ok(ballAccel(sliced.ball).y > -SIM.gravity, 'backspin lifts');
  });

  test('a ball hitting the frame edge loses speed; speed falls monotonically off-centre', () => {
    const cfg = (x) => ({ racketVel: v3(0, 0, -15), ballVel: v3(0, 0, 15), off: [x, 0] });
    const speeds = [0, 0.04, 0.08, 0.115].map((x) => hit(cfg(x)).info);
    for (let i = 1; i < speeds.length; i++) assert.ok(speeds[i].speedOut < speeds[i - 1].speedOut);
    const edge = speeds[3];
    assert.ok(edge.speedOut < 0.85 * speeds[0].speedOut, `edge ${edge.speedOut} vs sweet ${speeds[0].speedOut}`);
    assert.ok(edge.quality < 0.1, `edge quality ${edge.quality}`);
    assert.ok(edge.eA < 0.5 * RACKET.apparentCOR, `edge eA ${edge.eA}`);
    assert.ok(Math.abs(edge.offCenter - 0.115) < 1e-6);
    // Toward the tip is deader than the throat for the same distance.
    const tip = hit({ racketVel: v3(0, 0, -15), ballVel: v3(0, 0, 15), off: [0, 0.07] }).info;
    const throat = hit({ racketVel: v3(0, 0, -15), ballVel: v3(0, 0, 15), off: [0, -0.07] }).info;
    assert.ok(tip.speedOut < speeds[0].speedOut && throat.speedOut < speeds[0].speedOut);
  });

  test('off-centre hits twist the face and push the ball toward the side of the hit', () => {
    const base = { racketVel: v3(0, 0, -15), ballVel: v3(0, 0, 15), off: [0.08, 0] };
    const twisted = hit(base);
    const flat = hit(base, 0.02, { twist: false });
    // Local +X is world +y for this pose (axis +x, normal -z).
    assert.ok(twisted.ball.vel.y > flat.ball.vel.y + 0.5, `${twisted.ball.vel.y} vs ${flat.ball.vel.y}`);
    const angle = Math.atan2(twisted.ball.vel.y, -twisted.ball.vel.z) / DEG;
    assert.ok(angle > 1 && angle < 10, `deflection ${angle} deg`);
    const mirrored = hit({ ...base, off: [-0.08, 0] });
    assert.ok(Math.abs(mirrored.ball.vel.y + twisted.ball.vel.y) < 1e-9, 'symmetric');
  });

  test('assist margin forgives an off-centre hit without hiding it', () => {
    const cfg = { racketVel: v3(0, 0, -15), ballVel: v3(0, 0, 15), off: [0.1, 0] };
    const raw = hit(cfg).info;
    const helped = hit(cfg, 0.02, { margin: 0.1 }).info;
    assert.ok(helped.speedOut > raw.speedOut + 2);
    assert.equal(helped.offCenter, raw.offCenter);
    assert.equal(helped.quality, raw.quality);
  });

  test('back-face hits work (backhand) and report the face actually hit', () => {
    // Pose normal points at the player (+z); the ball hits the other face.
    const r = hit({ racketVel: v3(0, 0, -15), ballVel: v3(0, 0, 15), normal: v3(0, 0, 1) });
    assert.ok(r.contact);
    assert.equal(r.contact.face, 'back');
    assert.ok(r.contact.normal.equals(v3(0, 0, -1), 1e-9), 'reported normal is the struck face');
    assert.equal(r.info.face, 'back');
    assert.ok(r.info.speedOut >= 26 && r.info.speedOut <= 29, `${r.info.speedOut}`);
    assert.ok(r.ball.vel.z < -25);
    // Topspin brush on the back face is still topspin.
    const b = hit({ racketVel: tilt(v3(0, 0, -1), v3(0, 1, 0), 25).scale(15), ballVel: v3(0, 0, 15), normal: v3(0, 0, 1) });
    assert.ok(b.info.spinRpm.top > 900);
  });

  test('angular velocity adds the swing speed of the contact point', () => {
    // Racket swinging about the vertical (wrist/forearm rotation): the tip moves faster.
    const base = { racketVel: v3(0, 0, -12), ballVel: v3(0, 0, 12), off: [0, 0.08] };
    const plain = hit(base);
    const spinning = hit({ ...base, angVel: v3(0, 25, 0) }); // +y rotation moves +x points toward -z
    assert.ok(Math.abs(spinning.info.racketSpeed - (12 + 25 * 0.08)) < 0.2, `${spinning.info.racketSpeed}`);
    assert.ok(spinning.info.speedOut > plain.info.speedOut + 2);
  });

  test('incoming topspin changes the outgoing spin (a slice block reverses it)', () => {
    const fwd = v3(0, 0, -1);
    const incomingTop = spinFromComponents(v3(0, 0, 1), 2500, 0); // topspin travelling +z
    const block = hit({ racketVel: fwd.clone().scale(5), ballVel: v3(0, 0, 15), ballSpin: incomingTop });
    assert.ok(Number.isFinite(block.info.spinRpm.top));
    // Reversed travel: the incoming topspin reads as backspin on the way out, reduced by grip.
    assert.ok(block.info.spinRpm.top < 0 && block.info.spinRpm.top > -2500, `${block.info.spinRpm.top}`);
  });

  test('ball is moved clear of the face and is not struck twice', () => {
    const r = hit({ racketVel: v3(0, 0, -15), ballVel: v3(0, 0, 15) });
    const face = racketFace(r.contact.pose);
    const s = r.ball.pos.clone().sub(face.center).dot(face.normal);
    assert.ok(s >= R + HALF_T - 1e-9, 'clear of the face');
    // Next segment: racket keeps moving, ball flies away.
    const dt = DT30 * (1 - r.contact.u);
    const poseB = { ...r.contact.pose, grip: r.contact.pose.grip.clone().addScaled(r.contact.pose.vel, dt), t: r.contact.t + dt };
    const ballB = createBall(r.ball.pos.clone().addScaled(r.ball.vel, dt), r.ball.vel);
    assert.equal(sweptContact(r.contact.pose, poseB, r.ball, ballB, 0.1), null);
  });

  test('a non-approaching contact leaves the ball untouched', () => {
    const pose = { grip: v3(0, 1, 7), axis: v3(1, 0, 0), normal: v3(0, 0, -1), vel: v3(0, 0, -5), t: 0 };
    const ball = createBall(pointOnRacket(pose, 0, RACKET.sweetSpotY).addScaled(v3(0, 0, -1), 0.05), v3(0, 0, -10));
    const info = racketImpact(ball, pose, { local: { x: 0, y: RACKET.sweetSpotY }, face: 'front' });
    assert.equal(info.hit, false);
    assert.ok(ball.vel.equals(v3(0, 0, -10)));
  });
});

describe('sweptContact', () => {
  test('contact time matches the analytic first touch', () => {
    const margin = 0.02;
    const s = setup({ racketVel: v3(0, 0, -15), ballVel: v3(0, 0, 15) });
    const c = sweptContact(s.poseA, s.poseB, s.ballA, s.ballB, margin);
    const D = R + HALF_T + margin;
    const uExpected = 0.5 - D / (30 * DT30);
    assert.ok(Math.abs(c.u - uExpected) < 1e-5, `${c.u} vs ${uExpected}`);
    assert.ok(Math.abs(c.t - uExpected * DT30) < 1e-6);
    assert.ok(Math.abs(c.local.x) < 1e-9 && Math.abs(c.local.y - RACKET.sweetSpotY) < 1e-9);
    // point lies on the struck face surface.
    const f = racketFace(c.pose);
    assert.ok(Math.abs(c.point.clone().sub(f.center).dot(f.normal) - HALF_T) < 1e-9);
    assert.ok(c.pose.vel.equals(v3(0, 0, -15)));
    assert.ok(c.ballVel.equals(v3(0, 0, 15)));
  });

  test('a fast 25 m/s racket sweeping 0.6 m between samples never misses (60 phases, margin 0)', () => {
    const dt = 0.6 / 25; // 0.6 m per pose sample
    const fwd = v3(0, 0, -1), up = v3(0, 1, 0);
    let found = 0;
    for (let i = 0; i < 60; i++) {
      const phase = (i + 0.37) / 60;
      const s = setup({ racketVel: tilt(fwd, up, 10).scale(25), ballVel: v3(0.5, -1, 20), dt, phase, off: [0.03, -0.02] });
      const c = sweptContact(s.poseA, s.poseB, s.ballA, s.ballB, 0);
      if (!c) continue;
      found++;
      assert.ok(c.u <= phase + 1e-9, 'contact happens before the centres would meet');
      assert.equal(c.face, 'front');
      assert.ok(c.approachSpeed > 40 && c.approachSpeed < 50);
      const ball = createBall(c.ballPos, c.ballVel);
      const info = racketImpact(ball, c.pose, c);
      assert.ok(msToKmh(info.speedOut) > 120, 'a full swing at a fast ball is a very fast ball');
    }
    assert.equal(found, 60);
  });

  test('a rotating arc swing (60° of racket rotation between samples) still connects', () => {
    // Forehand arc: grip circles a pivot (shoulder) while the racket yaws with it.
    const pivot = v3(0, 1.2, 7.4);
    const armLen = 0.6;
    const pose = (ang, t) => {
      const dir = v3(Math.sin(ang), 0, -Math.cos(ang)); // radial direction from the pivot
      const tangent = v3(-Math.cos(ang), 0, -Math.sin(ang)); // swing direction (ang decreasing)
      return {
        grip: pivot.clone().addScaled(dir, armLen), axis: dir.clone(), normal: tangent.clone(),
        vel: tangent.clone().scale(18), t,
      };
    };
    const dt = 1 / 30;
    const poseA = pose(60 * DEG, 0);
    const poseB = pose(0, dt);
    // Ball crossing the arc where the sweet spot passes at ang = 30°.
    const ang = 30 * DEG;
    const meet = pivot.clone().addScaled(v3(Math.sin(ang), 0, -Math.cos(ang)), armLen + RACKET.sweetSpotY);
    const bv = v3(0, 0, 14);
    const ballA = createBall(meet.clone().addScaled(bv, -dt / 2), bv);
    const ballB = createBall(meet.clone().addScaled(bv, dt / 2), bv);
    const c = sweptContact(poseA, poseB, ballA, ballB, 0);
    assert.ok(c, 'arc swing detected');
    assert.equal(c.face, 'front');
    assert.ok(c.u > 0.3 && c.u < 0.6, `u ${c.u}`);
    assert.ok(c.offCenter < 0.1);
  });

  test('no contact when the ball passes 30 cm away', () => {
    const margin = 0.1; // even with the Club assist margin
    // Crosses the face plane 30 cm from the face centre (beside the head).
    for (const dir of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const s = setup({ racketVel: v3(0, 0, -15), ballVel: v3(0, 0, 15), off: [0, 0] });
      const f = racketFace(s.poseA);
      const shift = f.xAxis.clone().scale(dir[0] * 0.3).addScaled(f.yAxis, dir[1] * 0.3 + (RACKET.faceCenterY - RACKET.sweetSpotY));
      s.ballA.pos.add(shift);
      s.ballB.pos.add(shift);
      assert.equal(sweptContact(s.poseA, s.poseB, s.ballA, s.ballB, margin), null, `offset ${dir}`);
    }
    // Flies parallel to the face 30 cm in front of it.
    const pose = { grip: v3(0, 1, 7), axis: v3(1, 0, 0), normal: v3(0, 0, -1), vel: v3(), t: 0 };
    const sweet = pointOnRacket(pose, 0, RACKET.sweetSpotY);
    const a = createBall(sweet.clone().add(v3(0.5, 0, -0.3)), v3(-30, 0, 0));
    const b = createBall(sweet.clone().add(v3(-0.5, 0, -0.3)), v3(-30, 0, 0));
    assert.equal(sweptContact(pose, { ...pose, t: 1 / 30 }, a, b, margin), null);
  });

  test('a ball moving away from the face is not a hit', () => {
    // Racket chasing a faster ball: the gap only grows.
    const pose = { grip: v3(0, 1, 7), axis: v3(1, 0, 0), normal: v3(0, 0, -1), vel: v3(0, 0, -10), t: 0 };
    const poseB = { ...pose, grip: pose.grip.clone().add(v3(0, 0, -10 / 30)), t: 1 / 30 };
    const sweet = pointOnRacket(pose, 0, RACKET.sweetSpotY);
    const start = sweet.clone().add(v3(0, 0, -(R + HALF_T)));
    const a = createBall(start, v3(0, 0, -20));
    const b = createBall(start.clone().add(v3(0, 0, -20 / 30)), v3(0, 0, -20));
    assert.equal(sweptContact(pose, poseB, a, b, 0.05), null);
  });

  test('accepts plain Vec3 ball positions and ball times when poses have no t', () => {
    const s = setup({ racketVel: v3(0, 0, -15), ballVel: v3(0, 0, 15) });
    delete s.poseA.t;
    delete s.poseB.t;
    const c = sweptContact(s.poseA, s.poseB, s.ballA, s.ballB, 0);
    assert.ok(c && Math.abs(c.approachSpeed - 30) < 0.05);
    const c2 = sweptContact(s.poseA, s.poseB, s.ballA.pos, s.ballB.pos, 0);
    assert.ok(c2 && Math.abs(c2.u - c.u) < 1e-9);
    assert.equal(c2.ballVel, null);
  });

  test('randomised swings: detection agrees with a brute-force 2000-sample scan', () => {
    const rng = createRng(4242);
    let hits = 0;
    for (let k = 0; k < 150; k++) {
      const off = [rng.range(-0.2, 0.2), rng.range(-0.2, 0.2)];
      const racketVel = v3(rng.range(-3, 3), rng.range(-4, 4), -rng.range(5, 25));
      const ballVel = v3(rng.range(-3, 3), rng.range(-3, 3), rng.range(8, 25));
      const normal = rng() < 0.5 ? v3(0, 0, -1) : v3(0, 0, 1);
      const s = setup({ racketVel, ballVel, off, normal, phase: rng.range(0.1, 0.9) });
      const c = sweptContact(s.poseA, s.poseB, s.ballA, s.ballB, 0);
      if (c) assert.equal(c.face, normal.z < 0 ? 'front' : 'back');
      // Brute force: first sample with the centre inside the slab and the ellipse.
      const D = R + HALF_T;
      let brute = -1;
      for (let i = 0; i <= 2000 && brute < 0; i++) {
        const u = i / 2000;
        const grip = s.poseA.grip.clone().lerp(s.poseB.grip, u);
        const f = racketFace({ grip, axis: s.poseA.axis, normal: s.poseA.normal });
        const p = s.ballA.pos.clone().lerp(s.ballB.pos, u).sub(f.center);
        const px = p.dot(f.xAxis), py = p.dot(f.yAxis), sd = p.dot(f.normal);
        if (Math.abs(sd) <= D && (px / f.semiX) ** 2 + (py / f.semiY) ** 2 <= 1) brute = u;
      }
      if (brute >= 0) {
        hits++;
        assert.ok(c, `case ${k} missed`);
        assert.ok(c.u <= brute + 1e-9 && c.u > brute - 0.002, `case ${k}: ${c.u} vs ${brute}`);
      } else if (c) {
        // Only grazing contacts between brute-force samples may differ.
        assert.ok(Math.abs(c.local.x) / RACKET.faceSemiX > 0.9 || Math.abs(c.local.y - RACKET.faceCenterY) / RACKET.faceSemiY > 0.9);
      }
    }
    assert.ok(hits > 40, `exercised ${hits} hits`);
  });
});

describe('blendTowardIntent and spin conventions', () => {
  test('w = 0 keeps physics, w = 1 takes the intended direction with 60% of the speed change', () => {
    const phys = v3(0, 2, -25);
    const intent = v3(-6, 4, -18);
    const w0 = blendTowardIntent(phys, intent, 0);
    assert.ok(w0.equals(phys, 1e-9));
    const out = new Vec3();
    const w1 = blendTowardIntent(phys, intent, 1, out);
    assert.equal(w1, out);
    const expectedSpeed = phys.length() + (intent.length() - phys.length()) * 0.6;
    assert.ok(Math.abs(w1.length() - expectedSpeed) < 1e-9);
    assert.ok(w1.clone().normalize().equals(intent.clone().normalize(), 1e-9));
  });

  test('w = 0.5 is a true slerp: half the angle', () => {
    const phys = v3(0, 0, -20);
    const intent = v3(-20, 0, 0);
    const h = blendTowardIntent(phys, intent, 0.5);
    const a1 = Math.acos(h.clone().normalize().dot(phys.clone().normalize()));
    assert.ok(Math.abs(a1 - 45 * DEG) < 1e-9);
    assert.ok(Math.abs(h.length() - 20) < 1e-9);
  });

  test('degenerate inputs stay finite', () => {
    const anti = blendTowardIntent(v3(0, 0, -10), v3(0, 0, 10), 0.5);
    assert.ok(Number.isFinite(anti.x) && Math.abs(anti.length() - 10) < 1e-9);
    assert.ok(Math.abs(anti.clone().normalize().dot(v3(0, 0, 1))) < 1e-9, 'perpendicular at half way');
    assert.ok(blendTowardIntent(v3(), v3(0, 0, -10), 0.5).equals(v3(0, 0, -3)));
    assert.ok(blendTowardIntent(v3(0, 0, -10), v3(), 0.5).equals(v3(0, 0, -7)));
    assert.ok(blendTowardIntent(v3(), v3(), 0.5).equals(v3()));
  });

  test('spinComponents / spinFromComponents round-trip and match Magnus', () => {
    const dir = v3(0.3, 0.2, -1);
    const w = spinFromComponents(dir, 2000, 600);
    const c = spinComponents(dir, w);
    assert.ok(Math.abs(c.top - 2000) < 1e-6 && Math.abs(c.side - 600) < 1e-6);
    assert.ok(Math.abs(c.total - Math.hypot(2000, 600)) < 1e-6);
    // Topspin dives; positive side curves right of travel.
    const ball = createBall(v3(0, 1, 5), v3(0, 0, -20), spinFromComponents(v3(0, 0, -1), 2000, 0));
    assert.ok(ballAccel(ball).y < -SIM.gravity);
    ball.spin.copy(spinFromComponents(v3(0, 0, -1), 0, 2000));
    assert.ok(ballAccel(ball).x > 0.5, 'curves to +x = right of a -z travel');
  });
});
