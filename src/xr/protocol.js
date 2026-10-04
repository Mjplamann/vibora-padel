// VITURE glasses USB-HID wire formats (pure; builders and parsers, tested under Node).
//
// Two protocol generations are spoken:
//  - V2 (Gen2, e.g. Pro 2 0x35CA:0x1301; documented in elasticjava/viture-v2 PROTOCOL.md, MIT):
//    frame = u16 preamble 0x0010 | u16 MsgID | u16 PayloadLen | u16 Checksum (byte sum of the
//    payload, mod 2^16) | payload, all little-endian. 0x0301 [stream, rate] switches the IMU
//    streams; the glasses answer 0x2301 [status] and then send 0x7308 pose events (24 bytes:
//    u32, u32 timestamp, f32 qw, qx, qy, qz) at the chosen rate. Replies are MsgID + 0x2000.
//  - Legacy (One / Pro / Luma; viture-webxr-extension viture-hid.js, MIT, after XRLinuxDriver):
//    MCU commands start 0xFF 0xFE, IMU reports 0xFF 0xFC; CRC-16-CCITT (init 0xFFFF) over the
//    bytes from offset 4, stored big-endian at offset 2; u16 LE length at 4; command id at 14;
//    IMU Euler angles (degrees) as big-endian f32 at 18, 22, 26. Command 0x15 [1] enables the IMU.
// The VITURE Beast's product id and generation are not documented; the driver (viture.js) tries
// V2 first and falls back to legacy.

export const VITURE_VENDOR_ID = 0x35ca;

/** Known product ids -> model names (the Beast is not listed: its id is unknown). */
export const VITURE_MODELS = Object.freeze({
  0x1011: 'VITURE One', 0x1013: 'VITURE One', 0x1017: 'VITURE One',
  0x1015: 'VITURE One Lite', 0x101b: 'VITURE One Lite',
  0x1019: 'VITURE Pro', 0x101d: 'VITURE Pro',
  0x1121: 'VITURE Luma Pro', 0x1141: 'VITURE Luma Pro',
  0x1131: 'VITURE Luma',
  0x1301: 'VITURE Pro 2 (Gen2)',
});

export const V2 = Object.freeze({
  PREAMBLE: 0x0010,
  HEADER: 8,
  REPLY: 0x2000,
  MSG: Object.freeze({
    IMU_CONTROL: 0x0301,
    IMU_CONTROL_ACK: 0x2301,
    POSE: 0x7308,
    RAW: 0x7309,
    SERIAL: 0x3002,
    FIRMWARE: 0x3003,
    BRIGHTNESS: 0x3122,
    DISPLAY_MODE: 0x3141,
    WEAR: 0x3321,
  }),
  /** 0x0301 stream bitmask (NOT the SDK enum: pose is 1 on the wire, raw 2). */
  STREAM: Object.freeze({ OFF: 0, POSE: 1, RAW: 2 }),
  /** 0x0301 rate codes. */
  RATE: Object.freeze({ 60: 0, 90: 1, 120: 2, 240: 3, 500: 4, 1000: 5 }),
});

export const LEGACY = Object.freeze({
  MCU: 0xfe,
  IMU: 0xfc,
  CMD_IMU_ENABLE: 0x15,
  EULER_OFFSET: 18,
  HEADER: 18,
});

// ---- small helpers ----------------------------------------------------------------

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function f32le(b, o) {
  const dv = new DataView(new ArrayBuffer(4));
  for (let i = 0; i < 4; i++) dv.setUint8(i, b[o + i]);
  return dv.getFloat32(0, true);
}

function f32be(b, o) {
  const dv = new DataView(new ArrayBuffer(4));
  for (let i = 0; i < 4; i++) dv.setUint8(i, b[o + i]);
  return dv.getFloat32(0, false);
}

function putF32(b, o, v, little) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  dv.setFloat32(o, v, little);
}

/** Byte array view of anything report-like (Uint8Array, DataView, ArrayBuffer, number[]). */
export function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof DataView !== 'undefined' && data instanceof DataView) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Uint8Array.from(data);
  return new Uint8Array(0);
}

/** "10 00 01 03 …" (first `max` bytes). */
export function hex(bytes, max = 32) {
  const b = toBytes(bytes);
  const n = Math.min(b.length, max);
  let s = '';
  for (let i = 0; i < n; i++) s += (i ? ' ' : '') + b[i].toString(16).padStart(2, '0');
  return b.length > n ? `${s} …(${b.length})` : s;
}

// ---- V2 ---------------------------------------------------------------------------

export function v2Checksum(payload) {
  let s = 0;
  for (let i = 0; i < payload.length; i++) s += payload[i];
  return s & 0xffff;
}

/** A complete V2 frame for msgId with the given payload bytes. */
export function buildV2Frame(msgId, payload = []) {
  const p = toBytes(payload);
  const out = new Uint8Array(V2.HEADER + p.length);
  const sum = v2Checksum(p);
  out[0] = V2.PREAMBLE & 0xff; out[1] = V2.PREAMBLE >> 8;
  out[2] = msgId & 0xff; out[3] = (msgId >> 8) & 0xff;
  out[4] = p.length & 0xff; out[5] = (p.length >> 8) & 0xff;
  out[6] = sum & 0xff; out[7] = sum >> 8;
  out.set(p, V2.HEADER);
  return out;
}

/** IMU control: stream = V2.STREAM bitmask, rateHz one of 60/90/120/240/500/1000. */
export function v2ImuControl(stream = V2.STREAM.POSE, rateHz = 120) {
  const code = V2.RATE[rateHz] ?? V2.RATE[120];
  return buildV2Frame(V2.MSG.IMU_CONTROL, [stream & 0xff, code]);
}

/** A query (payload length 0); the reply arrives as msgId + 0x2000. */
export function v2Query(msgId) {
  return buildV2Frame(msgId, []);
}

/**
 * Parses a V2 frame (zero padding after the payload is ignored).
 * @returns {{msgId:number, len:number, checksum:number, ok:boolean, payload:Uint8Array}|null}
 */
export function parseV2Frame(data) {
  const b = toBytes(data);
  if (b.length < V2.HEADER || u16(b, 0) !== V2.PREAMBLE) return null;
  const msgId = u16(b, 2);
  const len = u16(b, 4);
  if (V2.HEADER + len > b.length) return null;
  const checksum = u16(b, 6);
  const payload = b.subarray(V2.HEADER, V2.HEADER + len);
  return { msgId, len, checksum, ok: v2Checksum(payload) === checksum, payload };
}

/** 0x7308 pose payload -> { t, w, x, y, z } (device quaternion), or null. */
export function parseV2Pose(payload) {
  const p = toBytes(payload);
  if (p.length < 24) return null;
  return { t: u32(p, 4), w: f32le(p, 8), x: f32le(p, 12), y: f32le(p, 16), z: f32le(p, 20) };
}

/** Builds a 0x7308 pose event (tests and the simulated device). */
export function buildV2Pose(q, t = 0, tag = 0) {
  const p = new Uint8Array(24);
  const dv = new DataView(p.buffer);
  dv.setUint32(0, tag >>> 0, true);
  dv.setUint32(4, t >>> 0, true);
  putF32(p, 8, q.w, true);
  putF32(p, 12, q.x, true);
  putF32(p, 16, q.y, true);
  putF32(p, 20, q.z, true);
  return buildV2Frame(V2.MSG.POSE, p);
}

/** A reply frame: { request, status, value: Uint8Array } or null if msgId is not a reply. */
export function parseV2Reply(frame) {
  if (!frame || frame.msgId < V2.REPLY || frame.msgId === V2.MSG.POSE || frame.msgId === V2.MSG.RAW) return null;
  const p = frame.payload;
  return { request: frame.msgId - V2.REPLY, status: p.length ? p[0] : -1, value: p.subarray(1) };
}

/** Display mode byte (0x3141 reply) -> { code, width, height, hz, sbs, label }. */
export function displayModeInfo(code) {
  const lo = code & 0x0f, hi = code >> 4;
  const h = hi === 4 ? 1200 : hi === 3 ? 1080 : 0;
  const table = { 1: [1920, 60, false], 2: [3840, 60, true], 3: [1920, 90, false], 4: [1920, 120, false], 5: [3840, 90, true] };
  const t = table[lo];
  if (!h || !t) return { code, width: 0, height: 0, hz: 0, sbs: false, label: `unknown (0x${code.toString(16)})` };
  return { code, width: t[0], height: h, hz: t[1], sbs: t[2], label: `${t[0]}×${h} @ ${t[1]} Hz${t[2] ? ' (3D SBS)' : ''}` };
}

// ---- legacy -----------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let j = 0; j < 8; j++) c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1;
    t[i] = c & 0xffff;
  }
  return t;
})();

/** CRC-16-CCITT (poly 0x1021, init 0xFFFF). */
export function crc16(bytes, start = 0, length = bytes.length - start) {
  let crc = 0xffff;
  for (let i = start; i < start + length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >> 8) ^ bytes[i]) & 0xff]) & 0xffff;
  return crc;
}

function legacyFrame(kind, cmdId, data, counter, euler) {
  const d = toBytes(data || []);
  const body = euler ? 12 : d.length;
  const total = LEGACY.HEADER + body + 1;
  const b = new Uint8Array(total);
  b[0] = 0xff; b[1] = kind;
  const len = total - 6;
  b[4] = len & 0xff; b[5] = len >> 8;
  b[14] = cmdId & 0xff; b[15] = (cmdId >> 8) & 0xff;
  b[16] = counter & 0xff; b[17] = (counter >> 8) & 0xff;
  if (euler) {
    putF32(b, 18, euler[0], false);
    putF32(b, 22, euler[1], false);
    putF32(b, 26, euler[2], false);
  } else b.set(d, LEGACY.HEADER);
  b[total - 1] = 0x03;
  const crc = crc16(b, 4, total - 4);
  b[2] = crc >> 8; b[3] = crc & 0xff;
  return b;
}

/** MCU command packet (0xFF 0xFE), e.g. buildLegacyCommand(0x15, [1]) enables the IMU. */
export function buildLegacyCommand(cmdId, data = [], counter = 1) {
  return legacyFrame(LEGACY.MCU, cmdId, data, counter, null);
}

/** IMU report (0xFF 0xFC) carrying raw Euler angles in degrees (tests, simulated device). */
export function buildLegacyImu(raw0, raw1, raw2, counter = 0) {
  return legacyFrame(LEGACY.IMU, 0, null, counter, [raw0, raw1, raw2]);
}

/** Header of a legacy packet: { kind: 'imu'|'mcu', len, cmdId, crcOk } or null. */
export function parseLegacyFrame(data) {
  const b = toBytes(data);
  if (b.length < LEGACY.HEADER || b[0] !== 0xff || (b[1] !== LEGACY.IMU && b[1] !== LEGACY.MCU)) return null;
  const len = u16(b, 4);
  let crcOk = false;
  if (6 + len <= b.length && len > 0) crcOk = crc16(b, 4, len + 2) === ((b[2] << 8) | b[3]);
  return { kind: b[1] === LEGACY.IMU ? 'imu' : 'mcu', len, cmdId: u16(b, 14), crcOk };
}

/** Legacy IMU report -> raw Euler degrees [r0, r1, r2], or null. */
export function parseLegacyImu(data) {
  const b = toBytes(data);
  const h = parseLegacyFrame(b);
  if (!h || h.kind !== 'imu' || b.length < LEGACY.EULER_OFFSET + 12) return null;
  const r = [f32be(b, 18), f32be(b, 22), f32be(b, 26)];
  if (!r.every((v) => Number.isFinite(v) && Math.abs(v) <= 360)) return null;
  return r;
}

/**
 * Legacy raw Euler degrees -> {yaw, pitch, roll} (rad, camera convention). The default mapping
 * is the one the viture-webxr-extension found by testing: up/down = -r1, left/right = r2,
 * roll = -r0. The driver's axis remap and flips still apply on top.
 */
export function legacyEuler(raw) {
  const D = Math.PI / 180;
  return { yaw: raw[2] * D, pitch: -raw[1] * D, roll: -raw[0] * D };
}

// ---- detection --------------------------------------------------------------------

/** 'v2' | 'legacy-imu' | 'legacy-mcu' | 'unknown' for one input report. */
export function classifyReport(data) {
  const b = toBytes(data);
  if (b.length >= V2.HEADER && u16(b, 0) === V2.PREAMBLE) {
    const f = parseV2Frame(b);
    if (f && f.ok) return 'v2';
  }
  const l = parseLegacyFrame(b);
  if (l) return l.kind === 'imu' ? 'legacy-imu' : 'legacy-mcu';
  return 'unknown';
}

/** Output report size (bytes) and id from a WebHID device's collections (defaults 64 / 0). */
export function outputReportInfo(device) {
  let size = 0, id = 0, found = false;
  try {
    for (const c of device.collections || []) {
      for (const r of c.outputReports || []) {
        found = true;
        id = r.reportId || 0;
        let bits = 0;
        for (const it of r.items || []) bits += (it.reportSize || 0) * (it.reportCount || 0);
        size = Math.max(size, Math.ceil(bits / 8));
      }
    }
  } catch {
    /* ignore */
  }
  return { hasOutput: found, reportId: id, size: size || 64 };
}
