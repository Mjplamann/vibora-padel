// Camera + MediaPipe pose tracker lifecycle and the calibration read-outs derived from
// pose frames (body-in-frame, distance, stillness, latency-test swings, racket raise).
import { listCameras, openCamera, preferredCamera, describeCameraError } from '../tracking/camera.js';
import { createPoseTracker } from '../tracking/pose.js';
import { TRACKING } from '../config.js';

/**
 * Capture offset (ms) for a camera preset: sensor exposure + transfer before the browser
 * sees the frame. Only applied when the browser gives no metadata.captureTime (Safari).
 */
export function captureOffsetFor(presetKey) {
  const p = TRACKING.cameraPresets[presetKey] || TRACKING.cameraPresets[TRACKING.defaultCamera];
  return p && Number.isFinite(p.captureOffsetMs) ? p.captureOffsetMs : 0;
}

const PARTS = {
  head: [0, 2, 5],
  shoulders: [11, 12],
  hips: [23, 24],
  knees: [25, 26],
  ankles: [27, 28],
};

/** Which body parts are visible and inside the picture: { visible, bodyInFrame 0..1 }. */
export function bodyVisibility(frame) {
  const p = frame && frame.people && frame.people[0];
  if (!p) return { visible: { head: false, shoulders: false, hips: false, knees: false, ankles: false }, bodyInFrame: 0 };
  const lm = p.landmarks;
  const visible = {};
  let n = 0;
  for (const [part, idx] of Object.entries(PARTS)) {
    const ok = idx.every((i) => {
      const l = lm[i];
      return l && (l.visibility ?? 1) > 0.5 && l.x > 0.01 && l.x < 0.99 && l.y > 0.01 && l.y < 0.99;
    });
    visible[part] = ok;
    if (ok) n++;
  }
  return { visible, bodyInFrame: n / 5 };
}

/**
 * Horizontal bearing (rad) of the tracked person from the camera's optical axis, from the
 * hip centre in the image: + toward image right. tan(b) = (u - 0.5) / f_n with
 * f_n = 0.5 / tan(hfov / 2) (focal length in image widths). Equals -atan2(room.x, room.d)
 * of body.js (room x is the user's right = image left). null without hips.
 */
export function offAxisBearing(frame, hfovDeg) {
  const p = frame && frame.people && frame.people[0];
  const lm = p && p.landmarks;
  if (!lm || !lm[23] || !lm[24]) return null;
  const u = 0.5 * (lm[23].x + lm[24].x);
  const fn = 0.5 / Math.tan(((hfovDeg || 68) * Math.PI) / 360);
  return Math.atan((u - 0.5) / fn);
}

/**
 * Off-axis yaw correction of MediaPipe world landmarks (optional, default off: QA2 / tracking
 * concern #4, unverified on real footage). BlazePose GHUM estimates the 3D pose in the frame
 * of its person crop, whose depth axis runs along the viewing ray rather than the optical
 * axis, so a player standing 1 m off-axis at 2.6 m has arms and racket face yawed by up to
 * ~20°. This rotates every world landmark about +y by the bearing b (ray frame -> camera
 * frame: x = x' cos b + z' sin b, z = -x' sin b + z' cos b; world landmarks are x image-right,
 * y down, z away from the camera). Returns a new frame; the input is not modified.
 */
export function correctOffAxisYaw(frame, hfovDeg) {
  if (!frame || !frame.people || !frame.people.length) return frame;
  const b0 = offAxisBearing(frame, hfovDeg);
  const people = frame.people.map((p) => {
    const b = offAxisBearing({ people: [p] }, hfovDeg); // each person has their own bearing
    if (b === null || Math.abs(b) < 1e-6) return p;
    const c = Math.cos(b), sn = Math.sin(b);
    const world = (p.world || []).map((q) => ({ ...q, x: q.x * c + q.z * sn, z: -q.x * sn + q.z * c }));
    return { ...p, world };
  });
  return { ...frame, people, yawCorrected: b0 };
}

/** Seconds a body part may be missing before the play HUD warns. */
export const FRAME_WARN = Object.freeze({ body: 0.5, feet: 1.2 });

/**
 * Out-of-frame watch for play: a PoseFrame stream -> the warning to show (or null). The
 * tracker needs head, shoulders and hips in the picture (distance, arms); feet out of view
 * make crouch / eye height unreliable. Times are the frames' ms timestamps.
 */
export function createFrameWatch() {
  let bodySince = null;
  let feetSince = null;
  return {
    update(frame) {
      const t = frame && Number.isFinite(frame.t) ? frame.t : 0;
      const v = bodyVisibility(frame).visible;
      const people = frame && frame.people ? frame.people.length : 0;
      const bodyOk = people > 0 && v.head && v.shoulders && v.hips;
      bodySince = bodyOk ? null : bodySince ?? t;
      feetSince = !bodyOk || v.ankles ? null : feetSince ?? t;
      if (bodySince !== null && t - bodySince >= FRAME_WARN.body * 1000) {
        return people
          ? { kind: 'body', text: 'Out of frame · step back into the camera view', es: 'Fuera de cámara · retrocede' }
          : { kind: 'none', text: 'Step in front of the camera', es: 'Ponte delante de la cámara' };
      }
      if (feetSince !== null && t - feetSince >= FRAME_WARN.feet * 1000) {
        return { kind: 'feet', text: 'Feet out of view · step back a little', es: 'Pies fuera de cámara · retrocede un poco' };
      }
      return null;
    },
    reset() { bodySince = null; feetSince = null; },
  };
}

/**
 * Derived read-outs from successive BodySamples: stillness, the dominant wrist's downward
 * swing peaks (latency test) and a racket raise (wrist above the head) for "raise to start".
 */
export function createMotionWatch() {
  let prev = null;
  let speedAvg = 0;
  let vyPrev = 0;
  let vyPrevPrev = 0;
  let lastSwingAt = -Infinity;
  let raisedSince = null;
  let lastSampleT = null;

  /** @returns {{ still, swingAt: number|null, raised: number (s held), handsUp }} */
  function update(sample) {
    const out = { still: false, swingAt: null, raisedFor: 0 };
    if (!sample || !sample.valid) {
      prev = null;
      raisedSince = null;
      return out;
    }
    const t = sample.t;
    const dom = sample.dominant || 'R';
    const w = sample.joints['wrist' + dom];
    if (prev && t > lastSampleT) {
      const dt = (t - lastSampleT) / 1000;
      const dx = sample.room.x - prev.room.x, dd = sample.room.d - prev.room.d;
      const pw = prev.joints['wrist' + dom];
      const v = Math.hypot(dx, dd) / dt;
      const wv = pw && w ? Math.hypot(w.x - pw.x, w.y - pw.y, w.z - pw.z) / dt : 0;
      speedAvg += (v + 0.25 * wv - speedAvg) * Math.min(1, dt * 4);
      const vy = pw && w ? (w.y - pw.y) / dt : 0;
      // Downward swing peak: the fastest downward wrist speed of a stroke (local minimum of vy).
      if (vyPrev < -1.6 && vyPrev <= vy && vyPrev <= vyPrevPrev && t - lastSwingAt > 450) {
        lastSwingAt = t - (t - lastSampleT) * 0.5;
        out.swingAt = lastSwingAt;
      }
      vyPrevPrev = vyPrev;
      vyPrev = vy;
    }
    out.still = prev !== null && speedAvg < 0.35;
    // Racket raise: dominant wrist clearly above the nose, the other hand below the shoulders.
    const nose = sample.joints.nose;
    const off = sample.joints['wrist' + (dom === 'R' ? 'L' : 'R')];
    const offShoulder = sample.joints['shoulder' + (dom === 'R' ? 'L' : 'R')];
    const up = w && nose && w.y > nose.y + 0.08 && (!off || !offShoulder || off.y < offShoulder.y);
    if (up) {
      if (raisedSince === null) raisedSince = t;
      out.raisedFor = (t - raisedSince) / 1000;
    } else raisedSince = null;
    prev = sample;
    lastSampleT = t;
    return out;
  }

  return { update, reset() { prev = null; raisedSince = null; speedAvg = 0; } };
}

/**
 * Camera and pose tracker. onFrame(PoseFrame) for every inference result.
 * @param {{ video: HTMLVideoElement, onFrame, onStatus, model? }} o
 */
export function createTracking({ video, onFrame, onStatus = () => {}, model = 'full', cameraPreset = null, yawCorrection = false }) {
  let cam = null;
  let presetOverride = cameraPreset;
  let yawOn = !!yawCorrection;
  const presetKey = () => presetOverride || (cam && cam.presetKey) || TRACKING.defaultCamera;
  const hfovNow = () => (TRACKING.cameraPresets[presetKey()] || TRACKING.cameraPresets[TRACKING.defaultCamera]).hfov;
  let tracker = null;
  let trackerPromise = null;
  let cameras = [];
  let error = null;
  let status = { phase: 'idle', message: '' };

  const setStatus = (s) => {
    status = s;
    onStatus(s);
  };

  async function list({ requestPermission = true } = {}) {
    error = null;
    try {
      cameras = await listCameras({ requestPermission });
    } catch (err) {
      error = describeCameraError(err);
      cameras = [];
    }
    return cameras;
  }

  async function ensureTracker() {
    if (tracker) return tracker;
    if (!trackerPromise) {
      trackerPromise = createPoseTracker({
        video,
        model,
        onFrame: (f) => onFrame(yawOn ? correctOffAxisYaw(f, hfovNow()) : f),
        onStatus: (s) => setStatus(s),
      }).then((t) => {
        tracker = t;
        return t;
      }).catch((err) => {
        trackerPromise = null;
        setStatus({ phase: 'error', message: `Pose model failed to load: ${err && err.message ? err.message : err}` });
        throw err;
      });
    }
    return trackerPromise;
  }

  /** Opens a camera (closing the current one) and starts pose tracking. */
  async function open(deviceId = null) {
    error = null;
    if (!deviceId) {
      const pref = preferredCamera(cameras);
      deviceId = pref ? pref.deviceId : null;
    }
    if (cam && cam.deviceId === deviceId && deviceId) return cam;
    if (tracker) tracker.stop();
    if (cam) cam.stop();
    cam = null;
    try {
      cam = await openCamera({ deviceId, video, fps: 60 });
    } catch (err) {
      error = describeCameraError(err);
      throw error;
    }
    cam.onEnded(() => {
      error = describeCameraError(Object.assign(new Error('Camera disconnected'), { name: 'NotFoundError' }));
      setStatus({ phase: 'error', message: 'Camera disconnected' });
    });
    const t = await ensureTracker();
    applyCaptureOffset();
    t.start();
    return cam;
  }

  function applyCaptureOffset() {
    if (!tracker || !tracker.setCaptureOffset) return;
    tracker.setCaptureOffset(captureOffsetFor(presetKey()));
  }

  /** The user's lens preset (settings.cameraPreset) overrides the one guessed from the camera label. */
  function setCameraPreset(key) {
    presetOverride = TRACKING.cameraPresets[key] ? key : null;
    applyCaptureOffset();
  }

  function stop() {
    if (tracker) tracker.stop();
    if (cam) cam.stop();
    cam = null;
  }

  return {
    list,
    open,
    stop,
    get camera() { return cam; },
    get cameras() { return cameras; },
    get error() { return error; },
    get status() { return status; },
    get stats() { return tracker ? tracker.stats : null; },
    get running() { return !!(cam && tracker && tracker.running); },
    setCameraPreset,
    /** Optional off-axis yaw correction of world landmarks (see correctOffAxisYaw). */
    setYawCorrection(on) { yawOn = !!on; },
    get yawCorrection() { return yawOn; },
    /** True when the browser gives no capture timestamps: the calibration should push the latency test. */
    get needsLatencyTest() { return !!(tracker && tracker.stats.needsLatencyTest); },
    get captureOffsetMs() { return tracker ? tracker.stats.captureOffsetMs : 0; },
  };
}
