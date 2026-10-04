// VITURE glasses (src/xr/): wire formats of both protocol generations (synthetic packets built
// from the documented layouts), axis mapping and recentre maths, prediction bounds, the driver
// end to end against the simulated device (detection, unplug / replug), the guided axis test,
// display maths and graceful behaviour without WebHID.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  VITURE_VENDOR_ID, V2, buildV2Frame, parseV2Frame, v2Checksum, v2ImuControl, v2Query, parseV2Pose, buildV2Pose, parseV2Reply,
  crc16, buildLegacyCommand, buildLegacyImu, parseLegacyFrame, parseLegacyImu, legacyEuler, classifyReport, hex, displayModeInfo,
  outputReportInfo,
} from '../src/xr/protocol.js';
import {
  qFromEulerYXZ, qToEulerYXZ, qMul, qConj, qRemap, remapDet, qAngleBetween, qRotateVec, qYaw, qFromAxisAngle, qSlerp, qIntegrate,
} from '../src/xr/quat.js';
import {
  createVitureDriver, mapDeviceQuat, recenterRef, predictPose, sanitizeDriverConfig, DEFAULT_DRIVER_CONFIG, MAX_LOOKAHEAD_MS, DRIVER_STORAGE_KEY,
} from '../src/xr/viture.js';
import { createSimulatedGlasses, toDeviceFrame, yawSweep } from '../src/xr/sim.js';
import { createAxisTest } from '../src/xr/axis.js';
import { fovFromDiagonal, profileFov, sbsLayout, eyeOffsets, hudPlacement, isFullSbsAspect, hfovFromVfov, BEAST } from '../src/xr/display.js';

const DEG = Math.PI / 180;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
};
/** Manual clock + timers so the driver's detection waits run instantly and deterministically. */
function fakeTime() {
  let t = 1000;
  const timers = [];
  return {
    now: () => t,
    setTimer(fn, ms) {
      const h = { at: t + ms, fn };
      timers.push(h);
      return h;
    },
    clearTimer(h) {
      const i = timers.indexOf(h);
      if (i >= 0) timers.splice(i, 1);
    },
    /** Advances time; fires due timers and calls onStep(t) every stepMs. */
    async advance(ms, stepMs = 1000 / 120, onStep = null) {
      const end = t + ms;
      while (t < end) {
        t = Math.min(end, t + stepMs);
        if (onStep) onStep(t);
        timers.sort((a, b) => a.at - b.at);
        while (timers.length && timers[0].at <= t) timers.shift().fn();
        await new Promise((r) => setImmediate(r));
      }
    },
  };
}
const yawLeft = (deg) => qFromEulerYXZ(deg * DEG, 0, 0, {});

describe('V2 protocol (Gen2 frames)', () => {
  test('IMU control frames match the documented bytes', () => {
    assert.equal(hex(v2ImuControl(V2.STREAM.POSE, 120)), '10 00 01 03 02 00 03 00 01 02');
    assert.equal(hex(v2ImuControl(V2.STREAM.RAW, 120)), '10 00 01 03 02 00 04 00 02 02');
    assert.equal(hex(v2ImuControl(V2.STREAM.OFF, 60)), '10 00 01 03 02 00 00 00 00 00');
    assert.equal(hex(v2Query(V2.MSG.BRIGHTNESS)), '10 00 22 31 00 00 00 00');
  });

  test('checksum is the byte sum of the payload, and replies parse', () => {
    const payload = Array.from({ length: 24 }, (_, i) => (i * 37 + 11) & 0xff);
    assert.equal(v2Checksum(payload), payload.reduce((a, b) => a + b, 0) & 0xffff);
    // Documented brightness reply: status 0, value 3.
    const f = parseV2Frame(Uint8Array.from([0x10, 0x00, 0x22, 0x51, 0x02, 0x00, 0x03, 0x00, 0x00, 0x03, 0, 0, 0, 0]));
    assert.ok(f && f.ok);
    assert.equal(f.msgId, 0x5122);
    const r = parseV2Reply(f);
    assert.equal(r.request, 0x3122);
    assert.equal(r.status, 0);
    assert.equal(r.value[0], 3);
    // A corrupted payload fails the checksum and is not classified as V2.
    const bad = buildV2Frame(0x2301, [0]);
    bad[8] = 5;
    assert.equal(parseV2Frame(bad).ok, false);
    assert.notEqual(classifyReport(bad), 'v2');
  });

  test('pose events round-trip a quaternion (zero padded to 64 bytes)', () => {
    const q = qFromEulerYXZ(0.4, -0.2, 0.1, {});
    const frame = buildV2Pose(q, 123456, 77);
    assert.equal(frame.length, 8 + 24);
    const padded = new Uint8Array(64);
    padded.set(frame);
    const f = parseV2Frame(padded);
    assert.equal(f.msgId, V2.MSG.POSE);
    assert.ok(f.ok);
    const p = parseV2Pose(f.payload);
    assert.equal(p.t, 123456);
    for (const k of ['w', 'x', 'y', 'z']) assert.ok(near(p[k], q[k], 1e-6), k);
    assert.equal(classifyReport(padded), 'v2');
  });

  test('display modes: 0x41 is 1920×1200 @ 60 Hz, 0x42 is the 3D side-by-side mode', () => {
    assert.deepEqual([displayModeInfo(0x41).width, displayModeInfo(0x41).height, displayModeInfo(0x41).hz, displayModeInfo(0x41).sbs], [1920, 1200, 60, false]);
    assert.equal(displayModeInfo(0x42).sbs, true);
    assert.equal(displayModeInfo(0x42).width, 3840);
    assert.equal(displayModeInfo(0x31).height, 1080);
    assert.match(displayModeInfo(0x99).label, /unknown/);
  });
});

describe('legacy protocol (0xFF 0xFE / 0xFF 0xFC)', () => {
  test('IMU enable command: layout and CRC-16-CCITT as in viture-hid.js', () => {
    const p = buildLegacyCommand(0x15, [0x01], 1);
    assert.equal(p.length, 20);
    assert.deepEqual([p[0], p[1]], [0xff, 0xfe]);
    assert.equal(p[4] | (p[5] << 8), 14); // reserved 8 + cmd 2 + counter 2 + data 1 + end 1
    assert.equal(p[14], 0x15);
    assert.equal(p[18], 0x01);
    assert.equal(p[19], 0x03);
    assert.equal((p[2] << 8) | p[3], crc16(p, 4, p.length - 4));
    const h = parseLegacyFrame(p);
    assert.deepEqual([h.kind, h.cmdId, h.crcOk], ['mcu', 0x15, true]);
    assert.equal(classifyReport(p), 'legacy-mcu');
  });

  test('CRC-16-CCITT (0xFFFF) check value', () => {
    assert.equal(crc16(Uint8Array.from('123456789', (c) => c.charCodeAt(0))), 0x29b1);
  });

  test('IMU reports carry big-endian Euler degrees at offset 18', () => {
    const pkt = buildLegacyImu(-3.5, 12.25, 45, 9);
    assert.equal(classifyReport(pkt), 'legacy-imu');
    assert.ok(parseLegacyFrame(pkt).crcOk);
    assert.deepEqual(parseLegacyImu(pkt), [-3.5, 12.25, 45]);
    // Default mapping: left/right = r2, up/down = -r1, roll = -r0.
    const e = legacyEuler([-3.5, 12.25, 45]);
    assert.ok(near(e.yaw, 45 * DEG) && near(e.pitch, -12.25 * DEG) && near(e.roll, 3.5 * DEG));
    // Garbage angles are rejected.
    const bad = buildLegacyImu(Number.NaN, 0, 0);
    assert.equal(parseLegacyImu(bad), null);
  });

  test('unknown reports and output report sizes', () => {
    assert.equal(classifyReport(new Uint8Array(64)), 'unknown');
    assert.equal(classifyReport([]), 'unknown');
    assert.deepEqual(outputReportInfo({ collections: [{ outputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }] }] }), { hasOutput: true, reportId: 0, size: 64 });
    assert.deepEqual(outputReportInfo({}), { hasOutput: false, reportId: 0, size: 64 });
  });
});

describe('axis mapping and recentre maths', () => {
  test('Euler YXZ round trip and the camera convention (yaw left turns -z toward -x)', () => {
    const q = qFromEulerYXZ(0.7, -0.3, 0.2, {});
    const e = qToEulerYXZ(q, {});
    assert.ok(near(e.yaw, 0.7) && near(e.pitch, -0.3) && near(e.roll, 0.2));
    const fwd = qRotateVec(yawLeft(90), { x: 0, y: 0, z: -1 });
    assert.ok(near(fwd.x, -1, 1e-9) && near(fwd.z, 0, 1e-9), 'turning left looks along -x');
    const up = qRotateVec(qFromEulerYXZ(0, 30 * DEG, 0, {}), { x: 0, y: 0, z: -1 });
    assert.ok(up.y > 0.49, 'positive pitch looks up');
  });

  test('a proper signed permutation remap is a homomorphism (composition survives the remap)', () => {
    const src = [2, 0, 1], sign = [1, -1, -1];
    assert.equal(remapDet(src, sign), 1);
    const a = qFromEulerYXZ(0.3, 0.2, -0.1, {}), b = qFromEulerYXZ(-0.5, 0.1, 0.4, {});
    const lhs = qRemap(qMul(a, b, {}), src, sign, {});
    const rhs = qMul(qRemap(a, src, sign, {}), qRemap(b, src, sign, {}), {});
    assert.ok(qAngleBetween(lhs, rhs) < 1e-9);
    // Odd permutations need an odd number of sign flips to stay proper.
    assert.equal(remapDet([1, 0, 2], [1, 1, 1]), -1);
    assert.equal(remapDet([1, 0, 2], [1, 1, -1]), 1);
  });

  test('a device with Z-up sensor axes maps back to the camera convention', () => {
    const axes = { src: [0, 2, 1], sign: [1, 1, -1] }; // device z = our yaw axis
    assert.equal(remapDet(axes.src, axes.sign), 1);
    const head = qFromEulerYXZ(35 * DEG, -10 * DEG, 5 * DEG, {});
    const dev = toDeviceFrame(head, axes);
    const cfg = sanitizeDriverConfig({ remap: axes });
    const back = mapDeviceQuat(dev, cfg, {});
    assert.ok(qAngleBetween(back, head) < 1e-9);
  });

  test('per-axis flips invert only that axis', () => {
    const cfg = sanitizeDriverConfig({ flip: { yaw: true } });
    const e = qToEulerYXZ(mapDeviceQuat(qFromEulerYXZ(20 * DEG, 10 * DEG, -5 * DEG, {}), cfg, {}), {});
    assert.ok(near(e.yaw, -20 * DEG, 1e-9) && near(e.pitch, 10 * DEG, 1e-9) && near(e.roll, -5 * DEG, 1e-9));
  });

  test('recentre: yaw-only keeps gravity pitch, full cancels everything, auto picks by level', () => {
    const q0 = qFromEulerYXZ(50 * DEG, -12 * DEG, 3 * DEG, {});
    const y = recenterRef(q0, 'yaw');
    assert.equal(y.mode, 'yaw');
    const e = qToEulerYXZ(qMul(y.ref, q0, {}), {});
    assert.ok(near(e.yaw, 0, 1e-9) && near(e.pitch, -12 * DEG, 1e-9) && near(e.roll, 3 * DEG, 1e-9));
    // After a yaw-only recentre, a further 20° left turn reads +20° yaw.
    const turned = qMul(yawLeft(20), q0, {});
    assert.ok(near(qYaw(qMul(y.ref, turned, {})), 20 * DEG, 1e-9));
    const f = recenterRef(q0, 'full');
    assert.ok(qAngleBetween(qMul(f.ref, q0, {}), { x: 0, y: 0, z: 0, w: 1 }) < 1e-9);
    assert.equal(recenterRef(q0, 'auto').mode, 'yaw');
    assert.equal(recenterRef(qFromEulerYXZ(0, 0, 80 * DEG, {}), 'auto').mode, 'full', 'a frame that is not gravity aligned is fully recentred');
  });

  test('sanitizeDriverConfig rejects malformed stored config', () => {
    const c = sanitizeDriverConfig({ remap: { src: [0, 0, 1], sign: [1, 1, 1] }, predictMs: 500, smoothing: 'max', recenterMode: 'x', rateHz: 7 });
    assert.deepEqual(c.remap.src, [0, 1, 2]);
    assert.equal(c.predictMs, MAX_LOOKAHEAD_MS);
    assert.equal(c.smoothing, DEFAULT_DRIVER_CONFIG.smoothing);
    assert.equal(c.recenterMode, 'auto');
    assert.equal(c.rateHz, 120);
  });
});

describe('prediction bounds', () => {
  test('look-ahead follows the angular velocity and never exceeds 20 ms', () => {
    const q = yawLeft(10);
    const omega = { x: 0, y: 2, z: 0 }; // 2 rad/s left
    const p10 = predictPose(q, omega, 0.010, {});
    assert.ok(near(qYaw(p10) - 10 * DEG, 0.02, 1e-9));
    const p1s = predictPose(q, omega, 1, {});
    assert.ok(near(qYaw(p1s) - 10 * DEG, 2 * 0.020, 1e-9), 'clamped to 20 ms');
    const crazy = predictPose(q, { x: 0, y: 500, z: 0 }, 0.02, {});
    assert.ok(qAngleBetween(crazy, q) <= 10 * 0.02 + 1e-9, 'angular speed capped at 10 rad/s');
    const nan = predictPose(q, { x: NaN, y: 0, z: 0 }, 0.02, {});
    assert.ok(qAngleBetween(nan, q) < 1e-12);
    assert.ok(qAngleBetween(predictPose(q, omega, -1, {}), q) < 1e-12);
  });
});

describe('driver against the simulated glasses', () => {
  test('no WebHID (Safari): every call degrades to a status, nothing throws', async () => {
    const d = createVitureDriver({ hid: null });
    assert.equal(d.supported, false);
    assert.equal(d.status, 'unsupported');
    assert.equal(await d.connect(), false);
    assert.equal(await d.autoConnect(), false);
    assert.equal(d.getQuaternion(), null);
    assert.equal(d.recenter(), false);
    await d.disconnect();
    const diag = d.diagnostics();
    assert.equal(diag.supported, false);
    assert.equal(diag.status, 'unsupported');
    d.dispose();
  });

  test('no device chosen / requestDevice throws (no user gesture)', async () => {
    const t = fakeTime();
    const d1 = createVitureDriver({ hid: { requestDevice: async () => [], getDevices: async () => [] }, now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer });
    assert.equal(await d1.connect(), false);
    assert.equal(d1.status, 'idle');
    const d2 = createVitureDriver({ hid: { requestDevice: async () => { throw new Error('Must be handling a user gesture'); }, getDevices: async () => [] }, now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer });
    assert.equal(await d2.connect(), false);
    assert.match(d2.diagnostics().errors[0], /user gesture/);
    assert.equal(d2.getQuaternion(), null);
  });

  for (const protocol of ['v2', 'legacy']) {
    test(`${protocol}: connect detects the protocol, tracks a left turn, recentres`, async () => {
      const t = fakeTime();
      let head = qFromEulerYXZ(15 * DEG, -5 * DEG, 0, {}); // facing 15° off at connect time
      const sim = createSimulatedGlasses({ protocol, now: t.now, pose: () => head });
      const storage = memStorage();
      const d = createVitureDriver({ hid: sim.hid, storage, now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer });
      const p = d.connect();
      await t.advance(2500, 1000 / 120, (now) => sim.emit(now));
      assert.equal(await p, true);
      assert.equal(d.protocol, protocol);
      assert.equal(d.status, 'streaming');
      assert.equal(sim.devices.every((x) => x.opened), true, 'every HID interface of the product is opened');
      if (protocol === 'v2') {
        assert.equal(hex(sim.sent[0].subarray(0, 10)), '10 00 01 03 02 00 03 00 01 02', 'pose stream at 120 Hz requested first');
        await t.advance(50, 1000 / 120, (now) => sim.emit(now));
        assert.equal(d.diagnostics().firmware, 'SIM.00.001_20261004');
        assert.equal(d.displayMode.width, 1920);
      } else {
        assert.ok(sim.sent.some((b) => b[0] === 0xff && b[1] === 0xfe && b[14] === 0x15), 'legacy IMU enable sent after V2 got no answer');
      }
      // First pose recentred: facing forward reads ~0 yaw, the gravity pitch is kept.
      let e = d.getEuler(t.now());
      assert.ok(Math.abs(e.yaw) < 0.5, `yaw ${e.yaw}`);
      assert.ok(Math.abs(e.pitch + 5) < 0.5, `pitch ${e.pitch}`);
      // Turn 30° further left over 0.25 s, then hold.
      const start = t.now();
      sim.setPose((now) => qFromEulerYXZ((15 + 30 * Math.min(1, (now - start) / 250)) * DEG, -5 * DEG, 0, {}));
      await t.advance(600, 1000 / 120, (now) => sim.emit(now));
      e = d.getEuler(t.now());
      assert.ok(Math.abs(e.yaw - 30) < 1, `left turn reads +30° (got ${e.yaw.toFixed(2)})`);
      d.recenter();
      e = d.getEuler(t.now());
      assert.ok(Math.abs(e.yaw) < 0.3);
      const diag = d.diagnostics();
      assert.ok(diag.posesPerSec >= 100 && diag.posesPerSec <= 130, `~120 poses/s (${diag.posesPerSec})`);
      assert.ok(diag.lastRaw && diag.product.vendorId === '0x35ca');
      head = qFromEulerYXZ(0, 0, 0, {});
      await d.disconnect();
      assert.equal(d.status, 'idle');
      assert.equal(d.getQuaternion(), null);
      if (protocol === 'v2') assert.equal(hex(sim.sent[sim.sent.length - 1].subarray(0, 8)), '10 00 01 03 02 00 00 00', 'stream switched off');
      d.dispose();
    });
  }

  test('prediction leads a turning head by about predictMs, and is 0 when still', async () => {
    const t = fakeTime();
    const sim = createSimulatedGlasses({ now: t.now, pose: () => yawLeft(0) });
    const d = createVitureDriver({ hid: sim.hid, now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const p = d.connect();
    await t.advance(1200, 1000 / 120, (n) => sim.emit(n));
    await p;
    assert.ok(d.predictionLeadDeg(t.now()) < 0.05, 'still head: no lead');
    const start = t.now();
    const rate = 120; // deg/s
    sim.setPose((n) => yawLeft(rate * (n - start) / 1000));
    await t.advance(400, 1000 / 120, (n) => sim.emit(n));
    const truth = rate * (t.now() - start) / 1000;
    const shown = d.getEuler(t.now()).yaw;
    // Shown pose = measurement + lead of ≈ predictMs (10 ms -> 1.2°), never more than 20 ms.
    assert.ok(shown > truth - 0.3, `prediction is not behind (${shown.toFixed(2)} vs ${truth.toFixed(2)})`);
    assert.ok(shown < truth + rate * 0.020 + 0.3, 'lead within 20 ms');
    d.setConfig({ predictMs: 0 });
    assert.ok(Math.abs(d.getEuler(t.now()).yaw - truth) < 0.5, 'prediction off: the measured pose');
  });

  test('unplug -> disconnected (no head pose), replug -> reconnects by itself', async () => {
    const t = fakeTime();
    const sim = createSimulatedGlasses({ now: t.now, pose: () => yawLeft(5) });
    const d = createVitureDriver({ hid: sim.hid, now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const p = d.connect();
    await t.advance(1200, 1000 / 120, (n) => sim.emit(n));
    assert.equal(await p, true);
    sim.unplug();
    assert.equal(d.status, 'disconnected');
    assert.equal(d.getQuaternion(), null);
    sim.replug();
    await t.advance(3000, 1000 / 120, (n) => sim.emit(n));
    assert.equal(d.status, 'streaming');
    assert.ok(d.getQuaternion());
  });

  test('stalled stream is reported; garbage packets are counted, never crash', async () => {
    const t = fakeTime();
    const sim = createSimulatedGlasses({ now: t.now });
    const d = createVitureDriver({ hid: sim.hid, now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const p = d.connect();
    await t.advance(1200, 1000 / 120, (n) => sim.emit(n));
    await p;
    d.ingest(new Uint8Array(64).fill(0xab), t.now());
    d.ingest(buildV2Pose({ x: NaN, y: 0, z: 0, w: 1 }), t.now());
    d.ingest(buildV2Pose({ x: 0, y: 0, z: 0, w: 0 }), t.now());
    d.ingest(new Uint8Array(3), t.now());
    const diag = d.diagnostics();
    assert.ok(diag.rejected >= 2 && diag.unknown >= 2);
    assert.ok(d.getQuaternion());
    await t.advance(1500, 50);
    assert.equal(d.status, 'stalled');
    assert.ok(d.getQuaternion(), 'holds the last pose while stalled');
  });

  test('axis config persists and survives a reload', () => {
    const storage = memStorage();
    const d = createVitureDriver({ hid: null, storage });
    d.setConfig({ flip: { yaw: true }, predictMs: 15 });
    assert.ok(storage.m.has(DRIVER_STORAGE_KEY));
    const d2 = createVitureDriver({ hid: null, storage });
    assert.equal(d2.config.flip.yaw, true);
    assert.equal(d2.config.predictMs, 15);
    storage.setItem(DRIVER_STORAGE_KEY, '{not json');
    assert.equal(createVitureDriver({ hid: null, storage }).config.predictMs, DEFAULT_DRIVER_CONFIG.predictMs);
  });
});

describe('guided axis test', () => {
  function run(axes, { roll = true } = {}) {
    const test = createAxisTest({ roll });
    test.start();
    const feed = (yaw, pitch, rollA, n = 1) => {
      for (let k = 0; k < n; k++) test.feed(toDeviceFrame(qFromEulerYXZ(yaw * DEG, pitch * DEG, rollA * DEG, {}), axes));
    };
    feed(0, 0, 0, 10); // hold still: the step arms
    for (let a = 0; a <= 30; a += 5) feed(a, 0, 0); // turn left
    feed(30, 0, 0, 10);
    for (let a = 0; a <= 30; a += 5) feed(30, a, 0); // look up
    if (roll) {
      feed(30, 30, 0, 10);
      for (let a = 0; a <= 30; a += 5) feed(30, 30, a); // tilt left
    }
    return test;
  }

  test('recovers identity, a permuted Z-up frame and a mirrored-yaw frame', () => {
    for (const axes of [{ src: [0, 1, 2], sign: [1, 1, 1] }, { src: [0, 2, 1], sign: [1, 1, -1] }, { src: [2, 1, 0], sign: [-1, -1, -1] }, { src: [1, 0, 2], sign: [-1, 1, 1] }]) {
      const t = run(axes);
      assert.equal(t.state, 'done', JSON.stringify(axes));
      const r = t.result();
      assert.deepEqual(r.src, axes.src, JSON.stringify(axes));
      assert.deepEqual(r.sign, axes.sign, JSON.stringify(axes));
      // Feeding the result to the driver maps device poses back to the true head pose.
      const head = qFromEulerYXZ(40 * DEG, 15 * DEG, -10 * DEG, {});
      const back = mapDeviceQuat(toDeviceFrame(head, axes), sanitizeDriverConfig({ remap: r }), {});
      assert.ok(qAngleBetween(back, head) < 1e-6);
    }
  });

  test('roll can be derived (two-step test) as the remaining proper axis', () => {
    const axes = { src: [2, 0, 1], sign: [1, -1, -1] };
    const r = run(axes, { roll: false }).result();
    assert.ok(r.derivedRoll && r.proper);
    assert.deepEqual(r.src, axes.src);
    assert.deepEqual(r.sign, axes.sign);
  });

  test('a diagonal movement is not accepted; reusing an axis fails the test', () => {
    const t = createAxisTest({ settleFeeds: 1 });
    t.start();
    t.feed(qFromEulerYXZ(0, 0, 0, {}));
    t.feed(qFromEulerYXZ(0, 0, 0, {}));
    const s = t.feed(qFromEulerYXZ(20 * DEG, 20 * DEG, 0, {}));
    assert.equal(s.state, 'running');
    assert.match(s.message, /one direction/);
    const t2 = createAxisTest({ settleFeeds: 1 });
    t2.start();
    t2.feed(yawLeft(0));
    t2.feed(yawLeft(0));
    t2.feed(yawLeft(30));
    t2.feed(yawLeft(30));
    t2.feed(yawLeft(30));
    const s2 = t2.feed(yawLeft(60)); // "look up" step but the head turned again
    assert.equal(s2.state, 'failed');
  });
});

describe('display maths', () => {
  test('58° diagonal at 16:10 -> 50.3° × 32.7° true scale', () => {
    const f = fovFromDiagonal(58, 16, 10);
    assert.ok(near(f.horizontal, 50.34, 0.05), f.horizontal);
    assert.ok(near(f.vertical, 32.75, 0.05), f.vertical);
    assert.ok(near(hfovFromVfov(f.vertical, 1.6), f.horizontal, 1e-6));
    assert.ok(near(profileFov('true'), f.vertical, 1e-9));
    assert.equal(profileFov('wide'), 50);
    assert.equal(profileFov('tv'), null);
    assert.ok(near(profileFov('auto', { headTracking: true }), f.vertical, 1e-9));
    assert.equal(profileFov('auto', { headTracking: false }), 50);
  });

  test('SBS layouts: full 3840×1200 and half 1920×1200 both project at 16:10 per eye', () => {
    const full = sbsLayout(3840, 1200);
    assert.equal(full.kind, 'full');
    assert.ok(near(full.eyeAspect, 1.6));
    assert.deepEqual(full.left, { x: 0, y: 0, width: 1920, height: 1200 });
    assert.deepEqual(full.right, { x: 1920, y: 0, width: 1920, height: 1200 });
    const half = sbsLayout(1920, 1200);
    assert.equal(half.kind, 'half');
    assert.ok(near(half.eyeAspect, 1.6));
    assert.equal(half.left.width, 960);
    assert.equal(sbsLayout(1920, 1200, 'full').kind, 'full');
    assert.ok(isFullSbsAspect(3840, 1080) && !isFullSbsAspect(1920, 1200) && !isFullSbsAspect(1920, 1080));
  });

  test('eyes and the HUD strip', () => {
    assert.deepEqual(eyeOffsets(0.063), [-0.0315, 0.0315]);
    const h = hudPlacement(profileFov('true'), 1.6);
    const halfH = 2 * Math.tan((profileFov('true') * DEG) / 2);
    assert.ok(h.y + h.height / 2 < halfH && h.y - h.height / 2 > 0, 'the strip sits in the upper half, inside the view');
    assert.ok(h.width < 2 * halfH * 1.6);
    assert.equal(BEAST.eye.width, 1920);
  });
});

test('quaternion helpers: slerp, integrate, axis-angle', () => {
  const a = yawLeft(0), b = yawLeft(90);
  assert.ok(near(qYaw(qSlerp(a, b, 0.5, {})), 45 * DEG, 1e-9));
  assert.ok(near(qYaw(qIntegrate(a, 0, 1, 0, 0.5, {})), 0.5, 1e-9));
  assert.ok(qAngleBetween(qFromAxisAngle(0, 0, 0, 1, {}), a) < 1e-12);
  assert.ok(qAngleBetween(qMul(b, qConj(b, {}), {}), a) < 1e-9);
  assert.equal(VITURE_VENDOR_ID, 0x35ca);
  assert.equal(typeof yawSweep()(1000).w, 'number');
});

// ---- glasses controller: the app.xr contract (fpCamera / stage read it live) -------------
import { createGlasses, GLASSES_STORAGE_KEY, sanitizeGlassesSettings } from '../src/xr/glasses.js';
import { hudLines, strokeLabel } from '../src/xr/hudText.js';
import { SETUP_GUIDE } from '../src/xr/panel.js';

async function connectedGlasses(opts = {}) {
  const t = fakeTime();
  let head = yawLeft(0);
  const sim = createSimulatedGlasses({ now: t.now, pose: () => head });
  const stereoCalls = [];
  const fakeStereo = (o) => ({ ...o, enabled: true, hud: { updates: [], update(h) { this.updates.push(h); } }, stats: { frames: 0 }, render: (...a) => stereoCalls.push(a), dispose() {} });
  const storage = memStorage();
  const g = createGlasses({ storage, hid: sim.hid, now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer, createStereo: fakeStereo, viewport: opts.viewport || { width: 1920, height: 1200 }, doc: null });
  return { t, sim, g, storage, stereoCalls, setHead: (q) => { head = q; } };
}

describe('glasses mode (app.xr contract)', () => {
  test('off by default: no head pose, no fov override, no stereo, not installed', async () => {
    const { g } = await connectedGlasses();
    assert.equal(g.enabled, false);
    assert.equal(g.active, null);
    assert.equal(g.xr.getHeadQuaternion(), null);
    assert.equal(g.xr.fov, undefined);
    assert.equal(g.xr.stereo.enabled, false);
    assert.equal(g.xr.eyeOffset, null);
  });

  test('without WebHID (Safari): glasses mode gives the comfort-wide view and a clear message', () => {
    const g = createGlasses({ hid: null, doc: null });
    g.enable(true);
    assert.equal(g.xr.getHeadQuaternion(), null);
    assert.equal(g.xr.fov, 50);
    assert.match(g.status().message, /Chrome or Edge/);
    assert.equal(g.status().supported, false);
  });

  test('connected: relative head quaternion, true-scale fov, true eye position, recentre at session start', async () => {
    const { t, sim, g, setHead } = await connectedGlasses();
    g.enable(true);
    setHead(yawLeft(40)); // the player happens to face 40° off when connecting
    const p = g.connect();
    await t.advance(1500, 1000 / 120, (n) => sim.emit(n));
    assert.equal(await p, true);
    assert.equal(g.active, g.xr, 'stable object for stage.setXR');
    assert.ok(Math.abs(g.xr.fov - 32.74) < 0.05);
    assert.deepEqual(g.xr.eyeOffset, { back: 0, down: 0 });
    let q = g.xr.getHeadQuaternion();
    assert.ok(Math.abs(qYaw(q)) < 0.01, 'first pose is the centre');
    setHead(yawLeft(70));
    await t.advance(300, 1000 / 120, (n) => sim.emit(n));
    q = g.xr.getHeadQuaternion();
    assert.ok(Math.abs(qYaw(q) / DEG - 30) < 1, `turned 30° left (${qYaw(q) / DEG})`);
    g.onSessionStart();
    assert.ok(Math.abs(qYaw(g.xr.getHeadQuaternion())) < 0.01, 'drill start recentres');
    g.set({ headTracking: false });
    assert.equal(g.xr.getHeadQuaternion(), null, 'head tracking off -> the gaze view');
    assert.equal(g.xr.fov, 50, 'auto profile falls back to comfort wide');
    g.set({ headTracking: true, profile: 'tv' });
    assert.equal(g.xr.fov, undefined, 'TV profile keeps the settings fov');
  });

  test('stereo only during play; auto follows a 3840-wide output; HUD fed through', async () => {
    const { g, stereoCalls } = await connectedGlasses({ viewport: { width: 3840, height: 1200 } });
    g.enable(true);
    g.set({ stereo: 'auto' });
    g.xr.hud.update({ title: 'Volleys', repIndex: 3, repTotal: 10 });
    assert.equal(g.xr.stereo.enabled, false, 'menus are DOM: no stereo outside play');
    g.setPlaying(true);
    assert.equal(g.xr.stereo.enabled, true);
    assert.equal(g.xr.stereo.ipd, 0.063);
    g.xr.stereo.render('r', 's', 'c', 'comp');
    assert.deepEqual(stereoCalls[0], ['r', 's', 'c', 'comp']);
    g.set({ ipdMm: 90 });
    assert.equal(g.xr.stereo.ipd, 0.074, 'IPD clamped to 54–74 mm');
    const { g: g2 } = await connectedGlasses({ viewport: { width: 1920, height: 1200 } });
    g2.enable(true);
    g2.set({ stereo: 'auto' });
    g2.setPlaying(true);
    assert.equal(g2.xr.stereo.enabled, false, 'a 16:10 output is not taken for SBS');
    g2.set({ stereo: 'on' });
    assert.equal(g2.xr.stereo.enabled, true, 'half SBS by choice');
  });

  test('C / Home recentre only while head tracking (Shift+C keeps the PiP toggle; Home in a slider is the slider\'s)', async () => {
    const { t, sim, g } = await connectedGlasses();
    const key = (k, extra = {}) => {
      const e = { key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
      return [g.handleKey(e), e.prevented];
    };
    g.enable(true);
    assert.deepEqual(key('c'), [false, false], 'no head tracking yet: C stays the PiP toggle');
    const p = g.connect();
    await t.advance(1500, 1000 / 120, (n) => sim.emit(n));
    await p;
    assert.deepEqual(key('c'), [true, true]);
    assert.deepEqual(key('C', { shiftKey: true }), [false, false]);
    assert.deepEqual(key('c', { metaKey: true }), [false, false]);
    assert.deepEqual(key('Home'), [true, true]);
    const slider = { closest: (sel) => (sel.includes('[data-range]') ? {} : null) };
    assert.deepEqual(key('Home', { target: slider }), [false, false], 'Home inside a range control');
    // The installed listener stops the event so the UI's keydown (PiP toggle) never sees it.
    const target = { fn: null, addEventListener(type, fn, cap) { this.fn = fn; this.cap = cap; }, removeEventListener() { this.fn = null; } };
    let recentred = 0;
    const off = g.installKeys(target, () => recentred++);
    assert.equal(target.cap, true, 'capture phase');
    const ev = { key: 'c', shiftKey: false, stopped: false, preventDefault() {}, stopImmediatePropagation() { this.stopped = true; } };
    target.fn(ev);
    assert.ok(ev.stopped && recentred === 1);
    const ev2 = { key: 'C', shiftKey: true, stopped: false, preventDefault() {}, stopImmediatePropagation() { this.stopped = true; } };
    target.fn(ev2);
    assert.ok(!ev2.stopped && recentred === 1, 'Shift+C passes through to the UI');
    off();
    g.enable(false);
    assert.deepEqual(key('Home'), [false, false]);
  });

  test('guided axis test through the driver fixes a mirrored-yaw device; manual flips', async () => {
    const t = fakeTime();
    const axes = { src: [0, 1, 2], sign: [-1, -1, 1] }; // yaw and pitch reversed (a proper remap)
    let head = yawLeft(0);
    const sim = createSimulatedGlasses({ now: t.now, pose: () => head, deviceAxes: axes });
    const g = createGlasses({ hid: sim.hid, now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer, doc: null });
    g.enable(true);
    const p = g.connect();
    await t.advance(1200, 1000 / 120, (n) => sim.emit(n));
    await p;
    head = yawLeft(30);
    await t.advance(200, 1000 / 120, (n) => sim.emit(n));
    assert.ok(qYaw(g.xr.getHeadQuaternion()) < 0, 'before the test a left turn reads as right');
    head = yawLeft(0);
    await t.advance(100, 1000 / 120, (n) => sim.emit(n));
    g.axisTest.start();
    // Reaction time: the player reads "Hold still… then turn left" before moving.
    await t.advance(300, 1000 / 120, (n) => sim.emit(n));
    const move = async (fn) => {
      const start = t.now();
      await t.advance(500, 1000 / 120, (n) => {
        head = fn(Math.min(1, (n - start) / 300));
        sim.emit(n);
      });
    };
    // Like a person: keep moving past the threshold, then hold each pose.
    await move((k) => qFromEulerYXZ(30 * k * DEG, 0, 0, {}));
    await move((k) => qFromEulerYXZ(30 * DEG, 30 * k * DEG, 0, {}));
    await move((k) => qFromEulerYXZ(30 * DEG, 30 * DEG, 30 * k * DEG, {}));
    assert.equal(g.axisTest.status.state, 'done', g.axisTest.status.message);
    assert.deepEqual(g.axisTest.result.sign, axes.sign);
    head = yawLeft(0);
    await t.advance(100, 1000 / 120, (n) => sim.emit(n));
    g.recenter();
    head = yawLeft(25);
    await t.advance(200, 1000 / 120, (n) => sim.emit(n));
    assert.ok(Math.abs(qYaw(g.xr.getHeadQuaternion()) / DEG - 25) < 1, 'after the test a left turn reads left');
    g.axisTest.answer('yaw', false);
    assert.equal(g.status().flips.yaw, true);
    assert.ok(qYaw(g.xr.getHeadQuaternion()) < 0, 'manual flip inverts yaw');
    g.axisTest.answer('yaw', true);
    assert.equal(g.status().flips.yaw, true, '"yes, it turned the right way" changes nothing');
  });

  test('settings persist; URL-flag changes ({persist:false}) do not', () => {
    const storage = memStorage();
    const g = createGlasses({ hid: null, storage, doc: null });
    g.set({ profile: 'wide', ipdMm: 66 });
    g.enable(true, { persist: false });
    const saved = JSON.parse(storage.getItem(GLASSES_STORAGE_KEY));
    assert.equal(saved.profile, 'wide');
    assert.equal(saved.ipdMm, 66);
    assert.equal(saved.enabled, false);
    const g2 = createGlasses({ hid: null, storage, doc: null });
    assert.equal(g2.settings.profile, 'wide');
    assert.equal(g2.enabled, false);
    assert.deepEqual(sanitizeGlassesSettings({ profile: 'x', stereo: 1, layout: 'y', ipdMm: 'z' }).profile, 'auto');
    storage.setItem(GLASSES_STORAGE_KEY, '{oops');
    assert.equal(createGlasses({ hid: null, storage, doc: null }).settings.profile, 'auto');
  });

  test('document classes: xr-glasses / xr-compact / xr-stereo', async () => {
    const cls = new Set();
    const doc = { documentElement: { classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) } } };
    const g = createGlasses({ hid: null, doc, viewport: { width: 3840, height: 1200 }, createStereo: () => ({ render() {}, stats: {} }) });
    assert.equal(cls.size, 0);
    g.enable(true);
    assert.ok(cls.has('xr-glasses') && cls.has('xr-compact') && !cls.has('xr-stereo'));
    g.set({ stereo: 'auto' });
    g.setPlaying(true);
    assert.ok(cls.has('xr-stereo'));
    g.setPlaying(false);
    assert.ok(!cls.has('xr-stereo'));
    g.set({ compactHud: false });
    assert.ok(!cls.has('xr-compact'));
  });

  test('diagnostics are JSON-serialisable and name the device', async () => {
    const { t, sim, g } = await connectedGlasses();
    g.enable(true);
    const p = g.connect();
    await t.advance(1500, 1000 / 120, (n) => sim.emit(n));
    await p;
    const d = JSON.parse(JSON.stringify(g.diagnostics()));
    assert.equal(d.driver.protocol, 'v2');
    assert.equal(d.driver.product.vendorId, '0x35ca');
    assert.equal(d.driver.interfaces.length, 2);
    assert.equal(d.webhid, true);
  });
});

describe('stereo HUD text', () => {
  test('drill, miss reason, last shot and match score', () => {
    const a = hudLines({ title: 'Forehand Drive', repIndex: 7, repTotal: 20, points: 140, streak: 3, miss: { text: 'No swing detected — swing a bit faster' }, prompt: 'Raise your racket' });
    assert.equal(a.reps, 'Rep 7 / 20');
    assert.equal(a.points, '140 pts');
    assert.equal(a.streak, '×3 streak');
    assert.equal(a.shotKind, 'miss');
    assert.match(a.shot, /No swing detected/);
    assert.equal(a.note, 'Raise your racket');
    const b = hudLines({ title: 'Volleys', repIndex: 2, repTotal: 10, points: 20, lastShot: { stroke: 'volley-fh', speedKmh: 71.6, spinRpm: { total: 1234 } }, banner: { text: '¡Por tres!' } });
    assert.equal(b.shot, 'Forehand volley · 72 km/h · 1230 rpm');
    assert.equal(b.note, '¡Por tres!');
    const m = hudLines({ title: 'Match', repTotal: null, rally: 4, points: null, score: { games: [2, 1], points: ['30', '15'] } });
    assert.equal(m.reps, 'Games 2–1 · 30–15');
    assert.equal(m.points, '');
    assert.notEqual(a.key, b.key);
    assert.equal(hudLines(null).key, '');
    assert.equal(strokeLabel('glass-bh'), 'Glass backhand');
    assert.equal(strokeLabel('new-thing'), 'New thing');
  });
});


describe('glasses review fixes', () => {
  test('flipping an axis keeps "forward" where the player recentred (not the current head pose)', async () => {
    const { t, sim, g, setHead } = await connectedGlasses();
    g.enable(true);
    const p = g.connect();
    await t.advance(1200, 1000 / 120, (n) => sim.emit(n));
    await p;
    g.driver.setConfig({ predictMs: 0, smoothing: 'off' });
    g.recenter();
    setHead(yawLeft(30));
    await t.advance(200, 1000 / 120, (n) => sim.emit(n));
    assert.ok(Math.abs(qYaw(g.xr.getHeadQuaternion()) / DEG - 30) < 0.5);
    g.axisTest.flip('yaw'); // flipped while the head is turned 30° left
    assert.ok(Math.abs(qYaw(g.xr.getHeadQuaternion()) / DEG + 30) < 0.5, 'reads 30° right, not 0°');
    setHead(yawLeft(0));
    await t.advance(200, 1000 / 120, (n) => sim.emit(n));
    assert.ok(Math.abs(qYaw(g.xr.getHeadQuaternion()) / DEG) < 0.5, 'facing the recentre direction still reads forward');
  });

  test('yaw sweep starts at yaw 0 at t0', () => {
    const f = yawSweep({ amplitudeDeg: 25, periodMs: 6000, t0: 12345 });
    assert.ok(Math.abs(qYaw(f(12345))) < 1e-9);
    assert.ok(Math.abs(qYaw(f(12345 + 1500)) / DEG - 25) < 1e-6);
  });

  test('setup guide covers display mode, macOS display, far camera, dimming, Safari', () => {
    const text = SETUP_GUIDE.join(' ').replace(/<[^>]+>/g, '');
    for (const re of [/Smooth Follow/, /3DoF/, /System Settings → Displays/, /1920 × 1200/, /Continuity Camera 2\.5–3 m/, /chest height/, /Dimming to maximum/, /Safari has no WebHID/, /3840 × 1200/]) {
      assert.match(text, re);
    }
  });
});
