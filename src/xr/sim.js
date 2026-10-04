// Simulated VITURE glasses: a WebHID-shaped device and `navigator.hid` stand-in that speak the
// real wire formats (protocol.js). Used by the Node tests, dev/xr.html and `?xrsim=1`, so the
// driver, the axis test and the app.xr contract can be exercised without the hardware.
//
// The head pose comes from `pose(tMs)` in the CAMERA convention (yaw left +, pitch up +); the
// simulated firmware rotates it into its own sensor axes with `deviceAxes` (the inverse of the
// driver's remap), so an axis test against it must recover that remap.
import {
  VITURE_VENDOR_ID, V2, buildV2Frame, buildV2Pose, parseV2Frame, parseLegacyFrame, buildLegacyImu, LEGACY,
} from './protocol.js';
import { qFromEulerYXZ, qToEulerYXZ } from './quat.js';

const DEG = Math.PI / 180;

/** Camera-convention quaternion -> device quaternion for a driver remap {src, sign} (its inverse). */
export function toDeviceFrame(q, axes) {
  const v = [0, 0, 0];
  const c = [q.x, q.y, q.z];
  for (let i = 0; i < 3; i++) v[axes.src[i]] = axes.sign[i] * c[i];
  return { x: v[0], y: v[1], z: v[2], w: q.w };
}

/** A scripted head motion: yaw sweep (deg) as a function of time; yaw 0 at t0 (ms). */
export function yawSweep({ amplitudeDeg = 60, periodMs = 4000, pitchDeg = 0, t0 = 0 } = {}) {
  return (t) => qFromEulerYXZ(amplitudeDeg * DEG * Math.sin((2 * Math.PI * (t - t0)) / periodMs), pitchDeg * DEG, 0, {});
}

/**
 * @param {object} [o]
 * @param {'v2'|'legacy'} [o.protocol]
 * @param {number} [o.productId]         default 0x1401 (made up: the Beast's id is unknown)
 * @param {string} [o.productName]
 * @param {(tMs:number) => {x,y,z,w}} [o.pose]  camera-convention head pose
 * @param {{src:number[], sign:number[]}} [o.deviceAxes]  sensor axes (identity by default)
 * @param {boolean} [o.streamOnOpen]     legacy firmwares that stream without a command
 * @param {number} [o.interfaces]        HID interfaces exposed (the first one has the output report)
 * @param {boolean} [o.startGranted]     permission granted in an earlier visit (getDevices lists it)
 * @param {() => number} [o.now]
 */
export function createSimulatedGlasses({
  protocol = 'v2', productId = 0x1401, productName = 'VITURE Beast (simulated)', pose = () => ({ x: 0, y: 0, z: 0, w: 1 }),
  deviceAxes = { src: [0, 1, 2], sign: [1, 1, 1] }, streamOnOpen = false, interfaces = 2, startGranted = false,
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
} = {}) {
  const sent = [];
  let streaming = streamOnOpen;
  let seq = 0;
  const hidListeners = { connect: new Set(), disconnect: new Set() };
  let plugged = true;

  function makeDevice(index) {
    const listeners = new Set();
    const output = index === 0;
    return {
      vendorId: VITURE_VENDOR_ID,
      productId,
      productName,
      opened: false,
      collections: [{
        usagePage: 0xff00, usage: index + 1,
        inputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }],
        outputReports: output ? [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }] : [],
      }],
      async open() {
        if (!plugged) throw new Error('device unplugged');
        this.opened = true;
      },
      async close() {
        this.opened = false;
      },
      async sendReport(reportId, data) {
        if (!this.opened) throw new Error('device not open');
        if (!output) throw new Error('no output report');
        const b = Uint8Array.from(data);
        sent.push(b);
        handleCommand(b);
      },
      addEventListener(type, fn) {
        if (type === 'inputreport') listeners.add(fn);
      },
      removeEventListener(type, fn) {
        if (type === 'inputreport') listeners.delete(fn);
      },
      _emit(bytes) {
        if (!this.opened) return;
        const padded = new Uint8Array(64);
        padded.set(bytes.subarray(0, 64));
        const ev = { data: new DataView(padded.buffer), reportId: 0, device: this };
        for (const fn of listeners) fn(ev);
      },
    };
  }

  const devices = Array.from({ length: Math.max(1, interfaces) }, (_, i) => makeDevice(i));
  // Data comes out of the last interface (like the legacy MCU / IMU split), commands go to the first.
  const dataDevice = devices[devices.length - 1];

  function reply(msgId, payload) {
    dataDevice._emit(buildV2Frame(msgId + V2.REPLY, payload));
  }

  function handleCommand(b) {
    if (protocol === 'v2') {
      const f = parseV2Frame(b);
      if (!f || !f.ok) return;
      if (f.msgId === V2.MSG.IMU_CONTROL) {
        streaming = (f.payload[0] & V2.STREAM.POSE) !== 0;
        Promise.resolve().then(() => reply(V2.MSG.IMU_CONTROL, [0]));
      } else if (f.msgId === V2.MSG.FIRMWARE) {
        Promise.resolve().then(() => reply(V2.MSG.FIRMWARE, [0, ...Array.from('SIM.00.001_20261004', (c) => c.charCodeAt(0))]));
      } else if (f.msgId === V2.MSG.DISPLAY_MODE) {
        Promise.resolve().then(() => reply(V2.MSG.DISPLAY_MODE, [0, 0x41]));
      }
    } else {
      const h = parseLegacyFrame(b);
      if (h && h.kind === 'mcu' && h.crcOk && h.cmdId === LEGACY.CMD_IMU_ENABLE) streaming = b[LEGACY.HEADER] === 1;
    }
  }

  /** Emits one pose packet for time t (ms) if the stream is on. */
  function emit(t = now()) {
    if (!streaming || !plugged) return false;
    const q = toDeviceFrame(pose(t), deviceAxes);
    if (protocol === 'v2') {
      dataDevice._emit(buildV2Pose(q, Math.round(t), seq++));
    } else {
      // Legacy firmware sends Euler degrees: invert the driver's default legacy mapping.
      const e = qToEulerYXZ(q, {});
      dataDevice._emit(buildLegacyImu(-e.roll / DEG, -e.pitch / DEG, e.yaw / DEG, seq++));
    }
    return true;
  }

  let timer = null;
  /** Streams automatically at rateHz (browser demos). */
  function start(rateHz = 120) {
    stop();
    timer = setInterval(() => emit(now()), 1000 / rateHz);
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // Like WebHID, getDevices() only lists devices the user granted with requestDevice() (all
  // interfaces of the chosen product), unless the sim starts as already granted.
  let granted = startGranted;
  const hid = {
    async requestDevice({ filters = [] } = {}) {
      if (!plugged) return [];
      const ok = filters.length === 0 || filters.some((f) => f.vendorId === undefined || f.vendorId === VITURE_VENDOR_ID);
      if (ok) granted = true;
      return ok ? [devices[0]] : [];
    },
    async getDevices() {
      return plugged && granted ? devices.slice() : [];
    },
    addEventListener(type, fn) {
      hidListeners[type]?.add(fn);
    },
    removeEventListener(type, fn) {
      hidListeners[type]?.delete(fn);
    },
  };

  function unplug() {
    plugged = false;
    streaming = false;
    for (const d of devices) {
      d.opened = false;
      for (const fn of hidListeners.disconnect) fn({ device: d });
    }
  }
  function replug() {
    plugged = true;
    streaming = streamOnOpen;
    for (const d of devices) for (const fn of hidListeners.connect) fn({ device: d });
  }

  return {
    hid,
    devices,
    sent,
    emit,
    start,
    stop,
    unplug,
    replug,
    get streaming() { return streaming; },
    setPose(fn) {
      pose = fn;
    },
  };
}
