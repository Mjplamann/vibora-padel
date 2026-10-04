// Positioning and first-person framing (QA round 2): the player and racket stay off the glass,
// glass balls are played once they have come off it, the predicted contact is framed on screen,
// arm segments never fill the picture, zone labels never sit under HUD blocks' rules, and the
// pause gesture cannot fire during an overhead.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createGame } from '../src/app/game.js';
import { loadSettings } from '../src/app/settings.js';
import { COURT, RACKET } from '../src/config.js';
import { defaultBounds, ENCLOSURE_MARGIN } from '../src/tracking/locomotion.js';
import { playableCandidates, pickGlassContact, stanceBounds, STANCE_Z_MAX, GLASS_CLEAR } from '../src/game/intercept.js';
import { createGaze, GAZE } from '../src/render/gaze.js';
import { angularAlpha, ARM_FADE, ARM_RADIUS, segmentAlpha, stubStart, UPPER_STUB, stubRaiseFactor, besideEyeFactor, nearCutAlpha, alongCutStart, alongCutHide, stubShown } from '../src/render/armFade.js';
import { racketEnclosureShift } from '../src/render/viewClamp.js';
import { createHandCursor, PAUSE_HOLD_MS } from '../src/ui/cursor.js';

const DEG = Math.PI / 180;
const FRAME = 1 / 60;

/** Racket frame probes (court) of a RacketPose: butt, tip and both head sides. */
function racketProbes(r) {
  const sx = r.axis.y * r.normal.z - r.axis.z * r.normal.y;
  const sz = r.axis.x * r.normal.y - r.axis.y * r.normal.x;
  const sl = Math.hypot(sx, r.axis.z * r.normal.x - r.axis.x * r.normal.z, sz) || 1;
  return [[RACKET.buttY, 0], [RACKET.length + RACKET.buttY, 0], [RACKET.faceCenterY, RACKET.headWidth / 2], [RACKET.faceCenterY, -RACKET.headWidth / 2]]
    .map(([y, w]) => ({ x: r.grip.x + r.axis.x * y + (sx / sl) * w, z: r.grip.z + r.axis.z * y + (sz / sl) * w }));
}

function runDrill(drillId, { seed = 3, apLatency = 0, apDelivery = 0, seconds = 120, onFrame = null } = {}) {
  const S = loadSettings(null);
  const g = createGame({ spec: { kind: 'drill', drillId }, settings: S, input: 'autopilot', startTime: 10, seed, apLatency, apDelivery });
  const w = g.world;
  const out = { contacts: [], maxRacketZ: -Infinity, maxRacketX: 0, maxPlayerZ: -Infinity, maxPlayerX: 0, S, g };
  w.bus.on('ball:hit', ({ shot }) => { if (shot.by === 'player' && !shot.provisional) out.contacts.push(shot); });
  while (!g.isFinished() && w.time < 10 + seconds) {
    g.advanceTo(w.time + FRAME);
    out.maxPlayerZ = Math.max(out.maxPlayerZ, w.player.pos.z);
    out.maxPlayerX = Math.max(out.maxPlayerX, Math.abs(w.player.pos.x));
    if (w.player.racket) {
      for (const p of racketProbes(w.player.racket)) {
        out.maxRacketZ = Math.max(out.maxRacketZ, p.z);
        out.maxRacketX = Math.max(out.maxRacketX, Math.abs(p.x));
      }
    }
    if (onFrame) onFrame(w, S);
  }
  return out;
}

describe('enclosure: player and racket stay off the glass', () => {
  test('body bounds keep 0.6 m from the back glass and 0.45 m from the side glass; plans stop at 9.2 m', () => {
    const b = defaultBounds();
    assert.ok(COURT.halfLength - b.zMax >= 0.6 - 1e-9 && COURT.halfWidth - b.xMax >= 0.45 - 1e-9);
    assert.equal(ENCLOSURE_MARGIN.back, 0.6);
    assert.ok(stanceBounds().zMax <= STANCE_Z_MAX && STANCE_Z_MAX <= 9.2);
  });

  test('glass candidates: only once the ball has come >= 1.2 m off the glass, at a playable height', () => {
    const c = (kind, z, y, t, extra = {}) => ({ kind, pos: { x: 2, y, z }, height: y, t, comfortable: y >= 0.6 && y <= 1.3, cramped: false, ...extra });
    const cands = [c('after-wall', 9.6, 1.0, 1.0), c('after-wall', 9.2, 1.3, 1.08), c('after-wall', 8.8, 1.55, 1.15), c('after-wall', 8.5, 1.65, 1.2), c('after-wall', 5.5, 1.2, 1.9)];
    const ok = playableCandidates(cands);
    assert.deepEqual(ok.map((x) => x.pos.z), [8.8, 8.5, 5.5]);
    const pick = pickGlassContact(ok);
    assert.ok(pick && COURT.halfLength - pick.pos.z >= GLASS_CLEAR.glass, `picked z ${pick && pick.pos.z}`);
    // Groundstrokes: >= 1.1 m off the back glass; volleys 0.8 m.
    assert.deepEqual(playableCandidates([c('after-bounce', 9.0, 1, 1), c('after-bounce', 8.85, 1, 1.1), c('volley', 9.15, 1.4, 0.5)]).map((x) => x.pos.z), [8.85, 9.15]);
  });

  for (const [id, lat, del] of [['back-glass', 0, 0], ['back-glass', 0.11, 0.15], ['double-wall', 0, 0], ['fh-drive', 0, 0]]) {
    test(`${id}${lat ? ' (0.11 s latency)' : ''}: contacts >= 1 m off the glass, body <= 9.4 m, racket never through the glass`, () => {
      const r = runDrill(id, { apLatency: lat, apDelivery: del });
      assert.ok(r.contacts.length >= 10, `${r.contacts.length} contacts`);
      const deep = r.contacts.filter((s) => s.contact.z > 9.0);
      assert.ok(deep.length <= Math.floor(r.contacts.length * 0.1), `contacts deeper than 9.0 m: ${deep.map((s) => s.contact.z.toFixed(2)).join(', ')}`);
      assert.ok(r.maxPlayerZ <= defaultBounds().zMax + 1e-6, `player z ${r.maxPlayerZ.toFixed(2)}`);
      assert.ok(r.maxPlayerX <= defaultBounds().xMax + 1e-6, `player |x| ${r.maxPlayerX.toFixed(2)}`);
      assert.ok(r.maxRacketZ < COURT.halfLength - 0.02, `racket z ${r.maxRacketZ.toFixed(3)}`);
      assert.ok(r.maxRacketX < COURT.halfWidth - 0.02, `racket |x| ${r.maxRacketX.toFixed(3)}`);
    });
  }

  test('rendered racket: soft clamp inside the glass planes (visual only)', () => {
    const axisBack = { x: 0, y: 0, z: 1 }, up = { x: 0, y: 1, z: 0 };
    assert.deepEqual(racketEnclosureShift({ x: 1, y: 1, z: 9.3 }, axisBack, up), { dx: 0, dz: 0 });
    let prev = 0;
    for (let gz = 9.4; gz <= 10.2; gz += 0.01) {
      const s = racketEnclosureShift({ x: 1, y: 1, z: gz }, axisBack, up);
      const tip = gz + s.dz + RACKET.length + RACKET.buttY;
      assert.ok(tip <= COURT.halfLength - 0.02 + 1e-9, `tip ${tip.toFixed(3)} at grip ${gz.toFixed(2)}`);
      assert.ok(Math.abs(-s.dz - prev) <= 0.0105, 'continuous');
      prev = -s.dz;
    }
    const side = racketEnclosureShift({ x: 4.95, y: 1, z: 0 }, up, { x: 0, y: 0, z: -1 });
    assert.ok(side.dx < -0.1 && side.dz === 0);
  });
});

/** NDC of court point p for a camera at `eye` with gaze yaw / pitch (Euler YXZ), 74° vertical FOV, 16:9. */
function project(p, eye, yaw, pitch, vf = 74 * DEG, asp = 16 / 9) {
  const x = p.x - eye.x, y = p.y - eye.y, z = p.z - eye.z;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = x * cy - z * sy, z1 = x * sy + z * cy;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const y2 = y * cp + z1 * sp, z2 = -y * sp + z1 * cp;
  if (z2 > -0.01) return { x: 9, y: 9 };
  const t = Math.tan(vf / 2);
  return { x: x1 / -z2 / (t * asp), y: y2 / -z2 / t };
}

describe('contact framing (gaze)', () => {
  for (const id of ['fh-drive', 'bh-drive', 'volleys', 'bandeja']) {
    test(`${id}: every contact is on screen; groundstrokes and volleys in the lower-middle`, () => {
      const gaze = createGaze();
      const frames = [];
      let maxPitch = -Infinity;
      const r = runDrill(id, {
        seed: 4,
        onFrame(w, S) {
          const e = w.player.eye, off = S.eyeOffset;
          const view = { x: e.x, y: e.y - off.down, z: e.z + off.back };
          const ic = w.mode && w.mode.tactics && w.mode.tactics.state.intercept;
          const g = gaze.update(w.ball, view, FRAME, { basePitch: S.viewPitch * DEG, contact: ic && w.ball ? { ...ic.contact, t: ic.t } : null });
          maxPitch = Math.max(maxPitch, g.pitch);
          frames.push({ t: w.time, yaw: g.yaw, pitch: g.pitch, view });
        },
      });
      assert.ok(r.contacts.length >= 10);
      let lowerMid = 0;
      for (const s of r.contacts) {
        const f = frames.filter((q) => q.t <= s.t + 1e-6).pop();
        const p = project(s.contact, f.view, f.yaw, f.pitch);
        assert.ok(Math.abs(p.x) <= 0.95 && Math.abs(p.y) <= 0.95, `${id} contact at NDC ${p.x.toFixed(2)}, ${p.y.toFixed(2)}`);
        if (Math.abs(p.x) <= 0.5 && p.y <= 0 && p.y >= -0.85) lowerMid++;
      }
      if (id === 'bandeja') assert.ok(maxPitch <= GAZE.OVERHEAD_PITCH_MAX + 1e-6, `overhead pitch ${(maxPitch / DEG).toFixed(1)}°`);
      else assert.ok(lowerMid >= r.contacts.length * 0.8, `lower-middle ${lowerMid}/${r.contacts.length}`);
    });
  }
});

describe('first-person arms', () => {
  test('angular fade: solid below 0.12 rad, gone at 0.2 rad; the upper arm is a stub from the elbow', () => {
    assert.equal(angularAlpha(0.04, 0.04 / 0.11), 1);
    assert.equal(angularAlpha(0.04, 0.04 / 0.21), 0);
    const mid = angularAlpha(0.04, 0.04 / ((ARM_FADE.A0 + ARM_FADE.A1) / 2));
    assert.ok(mid > 0.4 && mid < 0.6);
    const st = stubStart({ x: 0, y: 1.43, z: 8 }, { x: 0, y: 1.13, z: 8 });
    assert.ok(Math.abs(st.y - (1.13 + UPPER_STUB)) < 1e-9);
    // A forearm 22 cm from the eye is (almost) faded out; at 45 cm it is solid.
    assert.ok(segmentAlpha(ARM_RADIUS.fore, { x: 0.1, y: 1.4, z: 7.78 }, { x: 0.3, y: 1.4, z: 7.78 }, [{ x: 0.2, y: 1.4, z: 8 }]) < 0.1);
    assert.equal(segmentAlpha(ARM_RADIUS.fore, { x: 0.1, y: 1.3, z: 7.55 }, { x: 0.3, y: 1.3, z: 7.55 }, [{ x: 0.2, y: 1.4, z: 8 }]), 1);
  });
});

/**
 * Share of the picture covered by arm segments, ray-cast on a 48x27 grid, alpha-weighted the way
 * fpRig draws them: a whole-segment alpha times the per-fragment view-depth fade (addNearFade).
 */
function armCoverage(view, yaw, pitch, segs, vf = 74 * DEG, asp = 16 / 9) {
  const GW = 48, GH = 27, tv = Math.tan(vf / 2);
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const fwd = { x: -cp * sy, y: sp, z: -cp * cy };
  let n = 0;
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const x = (((i + 0.5) / GW) * 2 - 1) * tv * asp, y = (1 - ((j + 0.5) / GH) * 2) * tv;
    const y1 = y * cp + sp, z1 = y * sp - cp; // Rx(pitch) of (x, y, -1)
    const dx = x * cy + z1 * sy, dz = -x * sy + z1 * cy;
    const L = Math.hypot(dx, y1, dz);
    const d = { x: dx / L, y: y1 / L, z: dz / L };
    const cosF = d.x * fwd.x + d.y * fwd.y + d.z * fwd.z;
    let cov = 0;
    for (const sg of segs) {
      if (sg.alpha <= 0.02) continue;
      // Nearest hit along the ray (segment sampled), then the fragment's view depth.
      let hitT = Infinity;
      for (let k = 0; k <= 12; k++) {
        const u = k / 12;
        const px = sg.a.x + (sg.b.x - sg.a.x) * u - view.x, py = sg.a.y + (sg.b.y - sg.a.y) * u - view.y, pz = sg.a.z + (sg.b.z - sg.a.z) * u - view.z;
        const t = px * d.x + py * d.y + pz * d.z;
        if (t < 0.03) continue;
        if (Math.hypot(px - d.x * t, py - d.y * t, pz - d.z * t) < sg.r) hitT = Math.min(hitT, t);
      }
      if (hitT === Infinity) continue;
      const a = sg.alpha * nearCutAlpha(sg.r, hitT * cosF);
      cov = 1 - (1 - cov) * (1 - a);
    }
    n += cov;
  }
  return n / (GW * GH);
}

describe('first-person arm coverage', () => {
  test('rally at 0.11 s latency: no arm segment covers 10% of the picture; all arms together exceed 10% in < 1% of frames', () => {
    const S = loadSettings(null);
    const g = createGame({ spec: { kind: 'rally', level: 'club' }, settings: S, input: 'autopilot', startTime: 10, seed: 4, apLatency: 0.11, apDelivery: 0.15 });
    const w = g.world;
    const gaze = createGaze();
    const fwd = { x: 0, y: 0, z: -1 };
    let frames = 0, over = 0, maxSeg = 0;
    const stubOn = { L: false, R: false };
    while (w.time < 10 + 60) {
      let r;
      for (let k = 0; k < 6; k++) {
        g.advanceTo(w.time + FRAME);
        const e = w.player.eye;
        const ic = w.mode.tactics.state.intercept;
        r = gaze.update(w.ball, { x: e.x, y: e.y - S.eyeOffset.down, z: e.z + S.eyeOffset.back }, FRAME, { basePitch: S.viewPitch * DEG, contact: ic && w.ball ? { ...ic.contact, t: ic.t } : null });
      }
      const bc = w.player.bodyCourt;
      if (!bc) continue;
      const e = w.player.eye;
      const view = { x: e.x, y: e.y - S.eyeOffset.down, z: e.z + S.eyeOffset.back };
      const segs = [];
      for (const side of ['L', 'R']) {
        const Sh = bc.joints['shoulder' + side], E = bc.joints['elbow' + side], W = bc.joints['wrist' + side];
        const st = stubStart(Sh, E);
        // Round 5 (fpRig): the stub is solid or hidden; the forearm is drawn from its along-cut to the wrist.
        const ed = Math.hypot(E.x - e.x, E.y - e.y, E.z - e.z);
        stubOn[side] = stubShown(stubOn[side], ed, Math.sin(r.pitch), stubRaiseFactor(Sh, E) * segmentAlpha(ARM_RADIUS.upper, E, E, [e]) * besideEyeFactor(st, E, e, fwd));
        if (stubOn[side]) segs.push({ a: st, b: E, r: ARM_RADIUS.upper, alpha: 1 });
        const c = Math.max(0, alongCutHide(alongCutStart(stubOn[side], ed), segmentAlpha(ARM_RADIUS.fore, W, W, [e]) * besideEyeFactor(E, W, e, fwd)));
        if (c < 1) segs.push({ a: { x: E.x + (W.x - E.x) * c, y: E.y + (W.y - E.y) * c, z: E.z + (W.z - E.z) * c }, b: W, r: ARM_RADIUS.fore, alpha: 1 });
      }
      frames++;
      if (armCoverage(view, r.yaw, r.pitch, segs) > 0.1) over++;
      if (frames % 3 === 0) for (const sg of segs) maxSeg = Math.max(maxSeg, armCoverage(view, r.yaw, r.pitch, [sg]));
    }
    assert.ok(frames > 400, `${frames} frames`);
    assert.ok(maxSeg < 0.1, `largest single segment ${(maxSeg * 100).toFixed(1)}% of the picture`);
    assert.ok(over / frames < 0.01, `arms > 10% of the picture in ${((100 * over) / frames).toFixed(1)}% of frames`);
  });

  test('overhead preparation: a raised elbow hides the stub; a forearm level with the head is hidden', () => {
    const sh = { x: 0.19, y: 1.43, z: 8 };
    assert.equal(stubRaiseFactor(sh, { x: 0.3, y: 1.1, z: 7.9 }), 1);
    assert.equal(stubRaiseFactor(sh, { x: 0.45, y: 1.45, z: 8 }), 0);
    const eye = { x: 0, y: 1.64, z: 8 }, fwd = { x: 0, y: 0, z: -1 };
    assert.equal(besideEyeFactor({ x: 0.3, y: 1.66, z: 8.15 }, { x: 0.33, y: 1.97, z: 8.13 }, eye, fwd), 0);
    assert.equal(besideEyeFactor({ x: 0.25, y: 1.1, z: 7.8 }, { x: 0.35, y: 1.15, z: 7.5 }, eye, fwd), 1);
  });
});

describe('pause gesture', () => {
  const hands = (up) => ({
    valid: true, t: 0, dominant: 'R',
    joints: {
      nose: { x: 0, y: 1.6, z: 0 },
      shoulderL: { x: -0.19, y: 1.43, z: 0 }, shoulderR: { x: 0.19, y: 1.43, z: 0 },
      hipL: { x: -0.1, y: 0.93, z: 0 }, hipR: { x: 0.1, y: 0.93, z: 0 },
      wristL: { x: -0.2, y: up ? 1.9 : 1.0, z: 0.1 }, wristR: { x: 0.2, y: up ? 1.9 : 1.0, z: 0.1 },
    },
  });
  const rect = { left: 0, top: 0, width: 1920, height: 1080 };

  test(`needs ${PAUSE_HOLD_MS / 1000} s with both hands up, and never fires while a ball is live`, () => {
    assert.ok(PAUSE_HOLD_MS >= 2000);
    let t = 0, paused = 0, live = true;
    const cur = createHandCursor({ root: null, now: () => t, onPause: () => paused++, isLive: () => live });
    cur.setEnabled(false);
    for (; t <= 3000; t += 33) cur.update(hands(true), rect); // bandeja preparation during a rally
    assert.equal(paused, 0, 'no pause during a live ball');
    live = false;
    const t0 = t;
    for (; t - t0 < 1700; t += 33) cur.update(hands(true), rect);
    assert.equal(paused, 0, 'not after 1.7 s');
    for (; t - t0 < 2200; t += 33) cur.update(hands(true), rect);
    assert.equal(paused, 1, 'paused after 2 s between points');
  });
});
