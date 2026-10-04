// VITURE glasses head tracking over WebHID (Chrome / Edge; Safari has no WebHID).
//
// connect() must run from a user gesture: it asks for any VITURE device (vendor 0x35CA only,
// because the Beast's product id is unknown), opens every HID interface of that product, and
// detects the protocol: a V2 pose stream (0x0301 -> 0x7308 quaternions, ~120 Hz) first, the
// legacy IMU stream (0xFF 0xFC Euler reports after command 0x15) as a fallback. Poses are mapped
// to the three.js camera convention (configurable signed axis permutation + per-axis flips,
// persisted), recentred (yaw only when the head is level at recentre time, else the full
// rotation), lightly smoothed (only while the head is still) and predicted a few ms ahead from
// the angular velocity (≤ 20 ms). Nothing throws: without WebHID or a device every call
// reports a status instead. The module is pure apart from the injected `hid` object, so it runs
// under Node with the simulated device (sim.js).
import {
  VITURE_VENDOR_ID, VITURE_MODELS, V2, parseV2Frame, parseV2Pose, parseV2Reply, v2ImuControl, v2Query,
  buildLegacyCommand, parseLegacyImu, legacyEuler, LEGACY, classifyReport, outputReportInfo, displayModeInfo, hex, toBytes,
} from './protocol.js';
import {
  qValid, qNormalize, qRemap, qToEulerYXZ, qFromEulerYXZ, qSlerp, qDeltaWorld, qIntegrate, qMul, qConj, qFromAxisAngle,
  qCopy, qIdentity, remapValid, qAngleBetween,
} from './quat.js';

export const DRIVER_STORAGE_KEY = 'vibora.xr.viture.v1';
export const MAX_LOOKAHEAD_MS = 20;
const MAX_OMEGA = 10; // rad/s used for prediction (≈ 570°/s)
const STALL_MS = 1000;
const STALE_PREDICT_MS = 100;
const DEG = Math.PI / 180;

export const DEFAULT_DRIVER_CONFIG = Object.freeze({
  remap: Object.freeze({ src: Object.freeze([0, 1, 2]), sign: Object.freeze([1, 1, 1]) }),
  flip: Object.freeze({ yaw: false, pitch: false, roll: false }),
  predictMs: 10, // look-ahead (0 = off), ≤ 20
  smoothing: 'low', // 'off' | 'low' | 'high' (only while the head is still)
  recenterMode: 'auto', // 'auto' | 'yaw' | 'full'
  rateHz: 120,
});

const SMOOTH_TAU = { off: 0, low: 0.012, high: 0.035 };

/** Validated driver config (anything malformed falls back to the default). */
export function sanitizeDriverConfig(c = {}) {
  const d = DEFAULT_DRIVER_CONFIG;
  const remap = remapValid(c.remap) ? { src: [...c.remap.src], sign: [...c.remap.sign] } : { src: [...d.remap.src], sign: [...d.remap.sign] };
  const f = c.flip && typeof c.flip === 'object' ? c.flip : {};
  return {
    remap,
    flip: { yaw: f.yaw === true, pitch: f.pitch === true, roll: f.roll === true },
    predictMs: Number.isFinite(c.predictMs) ? Math.min(MAX_LOOKAHEAD_MS, Math.max(0, c.predictMs)) : d.predictMs,
    smoothing: SMOOTH_TAU[c.smoothing] !== undefined ? c.smoothing : d.smoothing,
    recenterMode: ['auto', 'yaw', 'full'].includes(c.recenterMode) ? c.recenterMode : d.recenterMode,
    rateHz: V2.RATE[c.rateHz] !== undefined ? c.rateHz : d.rateHz,
  };
}

/** Device quaternion -> camera convention: signed axis permutation, then per-axis Euler flips. */
export function mapDeviceQuat(q, config, out = {}) {
  qRemap(q, config.remap.src, config.remap.sign, out);
  qNormalize(out);
  const f = config.flip;
  if (f.yaw || f.pitch || f.roll) {
    const e = qToEulerYXZ(out, {});
    qFromEulerYXZ(f.yaw ? -e.yaw : e.yaw, f.pitch ? -e.pitch : e.pitch, f.roll ? -e.roll : e.roll, out);
  }
  return out;
}

/**
 * Recentre reference for a mapped pose: 'yaw' cancels the heading only (pitch / roll stay
 * relative to gravity), 'full' cancels the whole rotation; 'auto' uses 'yaw' when the head is
 * near level (|pitch| < 30°, |roll| < 20°), else 'full' (a reference frame that is not
 * gravity-aligned). Returns { ref (left multiplier), mode }.
 */
export function recenterRef(q, mode = 'auto') {
  const e = qToEulerYXZ(q, {});
  let m = mode;
  if (m === 'auto') m = Math.abs(e.pitch) < 30 * DEG && Math.abs(e.roll) < 20 * DEG ? 'yaw' : 'full';
  return { ref: m === 'yaw' ? qFromAxisAngle(0, 1, 0, -e.yaw, {}) : qConj(q, {}), mode: m };
}

/** Predicted pose: q rotated by omega (world, rad/s) for h seconds, both bounded. */
export function predictPose(q, omega, h, out = {}) {
  const hh = Math.min(Math.max(0, h), MAX_LOOKAHEAD_MS / 1000);
  let wx = omega.x, wy = omega.y, wz = omega.z;
  const n = Math.hypot(wx, wy, wz);
  if (!(n > 0) || !Number.isFinite(n) || hh === 0) return qCopy(out, q);
  if (n > MAX_OMEGA) {
    const k = MAX_OMEGA / n;
    wx *= k; wy *= k; wz *= k;
  }
  return qIntegrate(q, wx, wy, wz, hh, out);
}

/**
 * @param {object} [o]
 * @param {object|null} [o.hid]   navigator.hid (or the simulated one); null -> 'unsupported'
 * @param {{getItem,setItem}|null} [o.storage]
 * @param {() => number} [o.now]  ms clock (performance.now)
 * @param {(fn, ms) => any} [o.setTimer] / [o.clearTimer]
 */
export function createVitureDriver({
  hid = (typeof navigator !== 'undefined' && navigator.hid) || null,
  storage = null,
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
} = {}) {
  let config = sanitizeDriverConfig(load());
  const listeners = new Set();
  let status = hid ? 'idle' : 'unsupported';
  let message = hid ? 'Not connected' : 'WebHID is not available in this browser (use Chrome or Edge)';
  let protocol = null; // 'v2' | 'legacy' | null
  let devices = [];
  let wantConnected = false;
  let busy = false;
  const handlers = new Map();
  const waiters = new Set();
  const errors = [];
  const info = { firmware: null, displayMode: null, ackStatus: null };
  const counts = { packets: 0, poses: 0, unknown: 0, rejected: 0, winStart: 0, winPackets: 0, winPoses: 0, packetsPerSec: 0, posesPerSec: 0 };
  let lastRaw = null, lastKind = null, lastMsgId = null, lastPacketT = -Infinity;
  let counter = 1;

  // Pose state.
  let hasPose = false;
  const devQ = qIdentity(); // last device quaternion (axis test)
  const mapped = qIdentity();
  const filtered = qIdentity();
  const omega = { x: 0, y: 0, z: 0 };
  let lastPoseT = -Infinity;
  const hist = []; // { t, q } of filtered poses, newest last
  let ref = null; // recentre left multiplier
  let refMode = null;
  let refDev = null; // device quaternion at the last recentre (re-mapped when the axes change)
  let pendingRecenter = true; // the first pose recentres
  const poseListeners = new Set();

  function load() {
    try {
      const raw = storage && storage.getItem(DRIVER_STORAGE_KEY);
      return raw ? JSON.parse(raw) || {} : {};
    } catch {
      return {};
    }
  }
  function save() {
    try {
      storage && storage.setItem(DRIVER_STORAGE_KEY, JSON.stringify(config));
    } catch {
      /* private mode / quota */
    }
  }

  function emit() {
    for (const fn of listeners) {
      try {
        fn(api);
      } catch {
        /* listener errors never break the driver */
      }
    }
  }
  function setStatus(s, msg) {
    const changed = s !== status || (msg !== undefined && msg !== message);
    status = s;
    if (msg !== undefined) message = msg;
    if (changed) emit();
  }
  function error(where, e) {
    const text = `${where}: ${e && e.message ? e.message : String(e)}`;
    errors.push({ t: Math.round(now()), text });
    if (errors.length > 8) errors.shift();
  }

  // ---- incoming reports ---------------------------------------------------------

  function checkWaiters() {
    for (const w of [...waiters]) {
      if (w.pred()) {
        waiters.delete(w);
        clearTimer(w.timer);
        w.resolve(true);
      }
    }
  }
  function waitFor(pred, ms) {
    if (pred()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const w = { pred, resolve, timer: null };
      w.timer = setTimer(() => {
        waiters.delete(w);
        resolve(false);
      }, ms);
      waiters.add(w);
    });
  }

  function countWindow(t) {
    if (!counts.winStart) counts.winStart = t;
    const dt = t - counts.winStart;
    if (dt >= 1000) {
      counts.packetsPerSec = Math.round((counts.winPackets * 1000) / dt);
      counts.posesPerSec = Math.round((counts.winPoses * 1000) / dt);
      counts.winStart = t;
      counts.winPackets = 0;
      counts.winPoses = 0;
    }
  }

  /** One input report (also the test entry point). t: host ms. */
  function ingest(data, t = now()) {
    const b = toBytes(data);
    counts.packets++;
    counts.winPackets++;
    lastPacketT = t;
    lastRaw = b.slice(0, 64);
    countWindow(t);
    const kind = classifyReport(b);
    lastKind = kind;
    if (kind === 'v2') {
      const f = parseV2Frame(b);
      lastMsgId = f.msgId;
      if (f.msgId === V2.MSG.POSE) {
        const p = parseV2Pose(f.payload);
        if (p) acceptPose(p, t, 'v2');
      } else {
        const r = parseV2Reply(f);
        if (r) onReply(r);
      }
    } else if (kind === 'legacy-imu') {
      const raw = parseLegacyImu(b);
      if (raw) {
        const e = legacyEuler(raw);
        acceptPose(qFromEulerYXZ(e.yaw, e.pitch, e.roll, {}), t, 'legacy');
      } else counts.rejected++;
    } else if (kind === 'unknown') counts.unknown++;
    checkWaiters();
  }

  function onReply(r) {
    if (r.request === V2.MSG.IMU_CONTROL) info.ackStatus = r.status;
    else if (r.request === V2.MSG.FIRMWARE && r.status === 0) info.firmware = String.fromCharCode(...r.value).replace(/\0+$/, '').trim();
    else if (r.request === V2.MSG.DISPLAY_MODE && r.status === 0 && r.value.length) info.displayMode = displayModeInfo(r.value[0]);
    if (!protocol && r.request === V2.MSG.IMU_CONTROL) protocol = 'v2';
  }

  function acceptPose(q, t, proto) {
    if (!qValid(q)) {
      counts.rejected++;
      return;
    }
    if (!protocol) protocol = proto;
    if (proto !== protocol) return;
    counts.poses++;
    counts.winPoses++;
    qNormalize(q, devQ);
    mapDeviceQuat(devQ, config, mapped);
    const dt = hasPose ? Math.min(0.05, Math.max(0.5 / config.rateHz, (t - lastPoseT) / 1000)) : 0;
    // Angular velocity over a ≥ 16 ms window (robust to batched USB reports).
    hist.push({ t, q: { ...mapped } });
    while (hist.length > 12) hist.shift();
    let old = hist[0];
    for (let i = hist.length - 2; i >= 0; i--) {
      if (t - hist[i].t >= 16) {
        old = hist[i];
        break;
      }
    }
    const span = (t - old.t) / 1000;
    if (span >= 0.004) {
      const v = qDeltaWorld(old.q, mapped, {});
      const k = 0.5;
      omega.x += (v.x / span - omega.x) * k;
      omega.y += (v.y / span - omega.y) * k;
      omega.z += (v.z / span - omega.z) * k;
    }
    // Minimal smoothing: none while turning (no lag), a few ms of jitter filtering when still.
    const tauRest = SMOOTH_TAU[config.smoothing] || 0;
    if (!hasPose || !tauRest) qCopy(filtered, mapped);
    else {
      const speed = Math.hypot(omega.x, omega.y, omega.z);
      const tau = tauRest * Math.max(0, 1 - speed / 1.5);
      const a = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
      qSlerp(filtered, mapped, a, filtered);
    }
    hasPose = true;
    lastPoseT = t;
    if (pendingRecenter) doRecenter();
    if (status !== 'streaming') setStatus('streaming', `Head tracking on (${protocol === 'v2' ? 'pose stream' : 'legacy IMU'})`);
    for (const fn of poseListeners) {
      try {
        fn(devQ);
      } catch {
        /* ignore */
      }
    }
  }

  // ---- output -------------------------------------------------------------------

  async function send(bytes) {
    let sent = 0;
    for (const d of devices) {
      const o = outputReportInfo(d);
      const hasCollections = Array.isArray(d.collections) && d.collections.length > 0;
      if (hasCollections && !o.hasOutput) continue;
      const padded = new Uint8Array(Math.max(o.size, bytes.length));
      padded.set(bytes);
      try {
        await d.sendReport(o.reportId, padded);
        sent++;
      } catch (e) {
        try {
          await d.sendReport(o.reportId, bytes);
          sent++;
        } catch (e2) {
          error(`sendReport ${d.productName || ''}`, e2);
        }
      }
    }
    return sent;
  }

  // ---- connection ---------------------------------------------------------------

  const isViture = (d) => d && d.vendorId === VITURE_VENDOR_ID;

  async function openDevices(picked) {
    let all = picked.filter(isViture);
    try {
      const granted = await hid.getDevices();
      for (const d of granted) {
        if (isViture(d) && all.some((p) => p.productId === d.productId) && !all.includes(d)) all.push(d);
      }
    } catch (e) {
      error('getDevices', e);
    }
    for (const d of all) {
      try {
        if (!d.opened) await d.open();
        if (!handlers.has(d)) {
          const h = (ev) => ingest(ev.data, now());
          handlers.set(d, h);
          d.addEventListener('inputreport', h);
        }
        if (!devices.includes(d)) devices.push(d);
      } catch (e) {
        error(`open ${d.productName || ''}`, e);
      }
    }
    if (!devices.length) {
      setStatus('error', 'Could not open the glasses (another app may be using them)');
      return false;
    }
    wantConnected = true;
    setStatus('waiting', 'Connected, waiting for head tracking data…');
    await detect();
    return status === 'streaming';
  }

  async function detect() {
    const gotPose = () => hasPose;
    // Some firmwares stream as soon as they are opened.
    if (await waitFor(gotPose, 150)) return finishDetect();
    if (!protocol || protocol === 'v2') {
      await send(v2ImuControl(V2.STREAM.POSE, config.rateHz));
      if (await waitFor(gotPose, 700)) return finishDetect();
      if (protocol === 'v2' && (await waitFor(gotPose, 600))) return finishDetect();
    }
    if (protocol !== 'v2') {
      await send(buildLegacyCommand(LEGACY.CMD_IMU_ENABLE, [1], counter++));
      if (await waitFor(gotPose, 900)) return finishDetect();
    }
    setStatus('no-data', protocol === 'v2'
      ? 'The glasses answered but send no head pose. Unplug and replug them, then Connect again.'
      : 'Connected, but no head tracking data arrives. Unplug and replug the glasses, then Connect again.');
    return false;
  }

  async function finishDetect() {
    if (protocol === 'v2') {
      await send(v2Query(V2.MSG.FIRMWARE));
      await send(v2Query(V2.MSG.DISPLAY_MODE));
    }
    return true;
  }

  async function connect() {
    if (!hid) {
      setStatus('unsupported');
      return false;
    }
    // An automatic reconnect in flight: let it finish, then prompt only if it found nothing.
    if (inflight) await inflight.catch(() => false);
    if (status === 'streaming' && devices.length) return true;
    if (busy) return false;
    busy = true;
    try {
      setStatus('connecting', 'Choose your VITURE glasses in the browser dialog…');
      let picked = [];
      try {
        picked = await hid.requestDevice({ filters: [{ vendorId: VITURE_VENDOR_ID }] });
      } catch (e) {
        error('requestDevice', e);
        setStatus('idle', 'Connect needs a click (and Chrome / Edge)');
        return false;
      }
      if (!picked || !picked.length) {
        setStatus('idle', 'No glasses chosen');
        return false;
      }
      return await openDevices([...picked]);
    } finally {
      busy = false;
    }
  }

  /** Reopens glasses granted earlier (no prompt). */
  let inflight = null;
  function autoConnect() {
    if (!hid || busy || devices.length) return Promise.resolve(devices.length > 0 && status === 'streaming');
    busy = true;
    inflight = (async () => {
      try {
        let list = [];
        try {
          list = (await hid.getDevices()).filter(isViture);
        } catch (e) {
          error('getDevices', e);
        }
        if (!list.length) return false;
        return await openDevices(list);
      } finally {
        busy = false;
        inflight = null;
      }
    })();
    return inflight;
  }

  function dropDevices() {
    for (const d of devices) {
      const h = handlers.get(d);
      if (h) d.removeEventListener('inputreport', h);
      handlers.delete(d);
    }
    devices = [];
    hasPose = false;
    hist.length = 0;
    omega.x = omega.y = omega.z = 0;
    pendingRecenter = true;
    refDev = null;
  }

  async function disconnect() {
    wantConnected = false;
    if (protocol === 'v2') await send(v2ImuControl(V2.STREAM.OFF, 60));
    const list = devices.slice();
    dropDevices();
    for (const d of list) {
      try {
        if (d.opened) await d.close();
      } catch (e) {
        error('close', e);
      }
    }
    protocol = null;
    setStatus(hid ? 'idle' : 'unsupported', hid ? 'Disconnected' : undefined);
  }

  // Unplug / replug.
  const onHidDisconnect = (e) => {
    if (!devices.includes(e.device)) return;
    const h = handlers.get(e.device);
    if (h) e.device.removeEventListener('inputreport', h);
    handlers.delete(e.device);
    devices = devices.filter((d) => d !== e.device);
    if (!devices.length) {
      dropDevices();
      protocol = null;
      setStatus('disconnected', 'Glasses unplugged — plug them back in to resume head tracking');
    }
  };
  let reconnectTimer = null;
  const onHidConnect = (e) => {
    if (!wantConnected || !isViture(e.device)) return;
    clearTimer(reconnectTimer);
    reconnectTimer = setTimer(() => {
      autoConnect();
    }, 400);
  };
  if (hid && hid.addEventListener) {
    hid.addEventListener('disconnect', onHidDisconnect);
    hid.addEventListener('connect', onHidConnect);
  }

  // ---- pose output ----------------------------------------------------------------

  function doRecenter() {
    const r = recenterRef(filtered, config.recenterMode);
    ref = r.ref;
    refMode = r.mode;
    refDev = { ...devQ };
    pendingRecenter = false;
  }

  /** Recentres on the current pose (or on the next one when none has arrived yet). */
  function recenter() {
    if (!hasPose) {
      pendingRecenter = true;
      return false;
    }
    doRecenter();
    return true;
  }

  /**
   * Head rotation relative to the last recentre, three.js camera convention, predicted to
   * `nowMs` + predictMs (bounded), or null without a live pose.
   */
  function getQuaternion(nowMs = now()) {
    if (!hasPose) return null;
    const age = Math.max(0, nowMs - lastPoseT);
    const out = {};
    if (config.predictMs > 0 && age < STALE_PREDICT_MS) predictPose(filtered, omega, (age + config.predictMs) / 1000, out);
    else qCopy(out, filtered);
    if (ref) qMul(ref, out, out);
    return qNormalize(out);
  }

  /** Recentred head Euler angles in degrees (readouts / tests). */
  function getEuler(nowMs) {
    const q = getQuaternion(nowMs);
    if (!q) return null;
    const e = qToEulerYXZ(q, {});
    return { yaw: e.yaw / DEG, pitch: e.pitch / DEG, roll: e.roll / DEG };
  }

  function currentStatus() {
    if (status === 'streaming' && now() - lastPacketT > STALL_MS) return 'stalled';
    return status;
  }

  function setConfig(patch = {}) {
    const next = sanitizeDriverConfig({ ...config, ...patch, flip: { ...config.flip, ...(patch.flip || {}) } });
    const remapChanged = JSON.stringify(next.remap) !== JSON.stringify(config.remap) || JSON.stringify(next.flip) !== JSON.stringify(config.flip);
    config = next;
    save();
    if (remapChanged && hasPose) {
      mapDeviceQuat(devQ, config, mapped);
      qCopy(filtered, mapped);
      hist.length = 0;
      omega.x = omega.y = omega.z = 0;
      // Keep "forward" where the player recentred: re-derive the reference in the new axes from
      // the device pose of the last recentre (not the current pose, which may be turned).
      if (refDev) {
        const r = recenterRef(mapDeviceQuat(refDev, config, {}), config.recenterMode);
        ref = r.ref;
        refMode = r.mode;
      } else doRecenter();
    }
    emit();
    return config;
  }

  function productInfo() {
    const d = devices[0];
    if (!d) return null;
    return {
      name: d.productName || '',
      model: VITURE_MODELS[d.productId] || d.productName || 'VITURE glasses',
      vendorId: `0x${(d.vendorId || 0).toString(16).padStart(4, '0')}`,
      productId: `0x${(d.productId || 0).toString(16).padStart(4, '0')}`,
    };
  }

  function diagnostics() {
    const e = getEuler();
    return {
      supported: !!hid,
      status: currentStatus(),
      message,
      protocol,
      product: productInfo(),
      interfaces: devices.map((d) => {
        const o = outputReportInfo(d);
        return {
          name: d.productName || '', opened: !!d.opened, output: o.hasOutput ? `${o.size} B (id ${o.reportId})` : 'none',
          usages: (d.collections || []).map((c) => `0x${(c.usagePage || 0).toString(16)}:0x${(c.usage || 0).toString(16)}`),
        };
      }),
      packets: counts.packets,
      poses: counts.poses,
      rejected: counts.rejected,
      unknown: counts.unknown,
      packetsPerSec: counts.packetsPerSec,
      posesPerSec: counts.posesPerSec,
      lastPacketAgoMs: Number.isFinite(lastPacketT) ? Math.round(now() - lastPacketT) : null,
      lastRaw: lastRaw ? hex(lastRaw, 40) : null,
      lastKind,
      lastMsgId: lastMsgId !== null ? `0x${lastMsgId.toString(16).padStart(4, '0')}` : null,
      firmware: info.firmware,
      displayMode: info.displayMode,
      ack: info.ackStatus,
      head: e ? { yaw: round1(e.yaw), pitch: round1(e.pitch), roll: round1(e.roll) } : null,
      device: hasPose ? { w: round4(devQ.w), x: round4(devQ.x), y: round4(devQ.y), z: round4(devQ.z) } : null,
      angularSpeedDeg: round1(Math.hypot(omega.x, omega.y, omega.z) / DEG),
      recenter: refMode,
      config: JSON.parse(JSON.stringify(config)),
      errors: errors.map((x) => `${x.t} ${x.text}`),
    };
  }

  function dispose() {
    if (hid && hid.removeEventListener) {
      hid.removeEventListener('disconnect', onHidDisconnect);
      hid.removeEventListener('connect', onHidConnect);
    }
    clearTimer(reconnectTimer);
    dropDevices();
    listeners.clear();
    poseListeners.clear();
  }

  const api = {
    get supported() { return !!hid; },
    get status() { return currentStatus(); },
    get message() { return message; },
    get protocol() { return protocol; },
    get connected() { return devices.length > 0; },
    get streaming() { return hasPose && currentStatus() === 'streaming'; },
    get config() { return config; },
    get deviceQuaternion() { return hasPose ? { ...devQ } : null; },
    get displayMode() { return info.displayMode; },
    connect,
    autoConnect,
    disconnect,
    recenter,
    getQuaternion,
    getEuler,
    setConfig,
    diagnostics,
    ingest,
    /** fn(driver) on status / config changes; returns an unsubscribe function. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** fn(deviceQuaternion) for every accepted pose (axis test). */
    onPose(fn) {
      poseListeners.add(fn);
      return () => poseListeners.delete(fn);
    },
    dispose,
    /** Angle (deg) between the predicted and the latest measured pose (tests / debug). */
    predictionLeadDeg(nowMs = now()) {
      if (!hasPose) return 0;
      const p = predictPose(filtered, omega, (Math.max(0, nowMs - lastPoseT) + config.predictMs) / 1000, {});
      return qAngleBetween(p, filtered) / DEG;
    },
  };
  return api;
}

const round1 = (v) => Math.round(v * 10) / 10;
const round4 = (v) => Math.round(v * 1e4) / 1e4;
