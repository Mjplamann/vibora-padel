// MediaPipe PoseLandmarker driver (SPEC §4.1, §4.8). Browser module.
//
// createPoseTracker({ video, model, numPoses, onFrame, onStatus }) resolves once the model
// is loaded (GPU delegate, CPU fallback). tracker.start() then runs inference on every new
// camera frame (requestVideoFrameCallback, rAF fallback) and calls
//   onFrame({ t, width, height, people: [{ landmarks: [33 x {x,y,z,visibility}], world: [33 x ...] }] })
// with t = capture-time estimate in performance.now() milliseconds.
//
// Asset paths resolve relative to this module, so the app works from the project root,
// from dev/ pages and from a GitHub Pages sub-path alike.

const ROOT = new URL('../../', import.meta.url);
export const POSE_ASSETS = {
  bundle: new URL('vendor/mediapipe/vision_bundle.mjs', ROOT).href,
  wasm: new URL('vendor/mediapipe/wasm', ROOT).href,
  model: (m) => new URL(`models/pose_landmarker_${m}.task`, ROOT).href,
};

const MODELS = ['lite', 'full', 'heavy'];
let visionPromise = null;
let filesetPromise = null;

function loadVision() {
  visionPromise ||= import(POSE_ASSETS.bundle);
  return visionPromise;
}

async function loadFileset() {
  const vision = await loadVision();
  filesetPromise ||= vision.FilesetResolver.forVisionTasks(POSE_ASSETS.wasm);
  return filesetPromise;
}

/**
 * MediaPipe's WASM runtime writes informational glog lines ("INFO: Created TensorFlow Lite
 * XNNPACK delegate…", "W0000 …") through console.error. While the tracker is alive they are
 * re-routed to console.debug so real errors stay visible.
 */
const BENIGN = /^(INFO:|I\d{4} |W\d{4} |Graph successfully|Created TensorFlow Lite|.*OpenGL error checking is disabled|.*Feedback manager requires)/;
let filterRefs = 0;
let originalError = null;
function pushConsoleFilter() {
  if (filterRefs++ > 0) return;
  originalError = console.error;
  console.error = (...args) => {
    if (typeof args[0] === 'string' && BENIGN.test(args[0])) console.debug('[mediapipe]', ...args);
    else originalError.apply(console, args);
  };
}
function popConsoleFilter() {
  if (--filterRefs > 0 || !originalError) return;
  console.error = originalError;
  originalError = null;
}

const copyLm = (p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility ?? p.presence ?? 1 });

/**
 * @param {object} o
 * @param {HTMLVideoElement} o.video
 * @param {'lite'|'full'|'heavy'} [o.model]
 * @param {number} [o.numPoses]
 * @param {(frame: object) => void} [o.onFrame]
 * @param {(s: {phase: 'loading'|'ready'|'error', message: string, delegate?: string}) => void} [o.onStatus]
 * @param {'GPU'|'CPU'} [o.delegate] preferred delegate
 */
export async function createPoseTracker({
  video,
  model = 'full',
  numPoses = 1,
  onFrame = () => {},
  onStatus = () => {},
  delegate = 'GPU',
  minDetection = 0.5,
  minPresence = 0.5,
  minTracking = 0.5,
} = {}) {
  if (!video) throw new Error('createPoseTracker: video element required');
  let landmarker = null;
  let usedDelegate = null;
  let curModel = MODELS.includes(model) ? model : 'full';
  let running = false;
  let handle = null;
  let rafHandle = null;
  let lastTs = -Infinity;
  let lastVideoTime = -1;
  let lastFrameAt = null;
  let goodFrames = 0;
  let closed = false;
  const stats = { fps: 0, inferMs: 0, latencyMs: 0, frames: 0, people: 0, delegate: null, model: curModel, captureTime: false };

  const status = (phase, message, extra = {}) => {
    try {
      onStatus({ phase, message, delegate: usedDelegate, model: curModel, ...extra });
    } catch {
      /* listener errors must not break tracking */
    }
  };

  pushConsoleFilter();

  async function create(del) {
    const vision = await loadVision();
    const fileset = await loadFileset();
    return vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: POSE_ASSETS.model(curModel), delegate: del },
      runningMode: 'VIDEO',
      numPoses,
      minPoseDetectionConfidence: minDetection,
      minPosePresenceConfidence: minPresence,
      minTrackingConfidence: minTracking,
      outputSegmentationMasks: false,
    });
  }

  async function load(preferred) {
    status('loading', `Loading pose model (${curModel})…`);
    const order = preferred === 'CPU' ? ['CPU'] : ['GPU', 'CPU'];
    let lastErr = null;
    for (const del of order) {
      try {
        const lm = await create(del);
        if (landmarker) landmarker.close();
        landmarker = lm;
        usedDelegate = del;
        stats.delegate = del;
        stats.model = curModel;
        goodFrames = 0;
        lastTs = -Infinity;
        status('ready', `Pose tracking ready (${curModel}, ${del})`);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    const message = `Could not start pose tracking: ${lastErr?.message || lastErr}`;
    status('error', message);
    throw new Error(message);
  }

  try {
    await load(delegate);
  } catch (err) {
    popConsoleFilter();
    throw err;
  }

  const nominalFps = () => {
    const track = video.srcObject?.getVideoTracks?.()[0];
    return track?.getSettings?.().frameRate || 30;
  };

  /** Capture-time estimate (ms, performance.now clock). */
  function captureTimeOf(now, md) {
    const perfNow = performance.now();
    if (md && Number.isFinite(md.captureTime) && md.captureTime > 0) {
      const age = perfNow - md.captureTime;
      if (age >= -5 && age < 1000) {
        stats.captureTime = true;
        return md.captureTime;
      }
    }
    stats.captureTime = false;
    const ref = md && Number.isFinite(md.expectedDisplayTime) ? md.expectedDisplayTime : now;
    return Math.min(perfNow, ref - 1000 / nominalFps());
  }

  let fallingBack = false;
  async function cpuFallback(err) {
    if (fallingBack) return;
    fallingBack = true;
    const wasRunning = running;
    running = false;
    try {
      status('loading', `GPU inference failed (${err?.message || err}); switching to CPU…`);
      await load('CPU');
    } finally {
      fallingBack = false;
      if (wasRunning && !closed) api.start();
    }
  }

  function process(t) {
    if (!landmarker || !video.videoWidth || video.readyState < 2) return;
    const ts = Math.max(t, lastTs + 0.01); // MediaPipe needs strictly increasing timestamps
    lastTs = ts;
    const t0 = performance.now();
    let res;
    try {
      res = landmarker.detectForVideo(video, ts);
    } catch (err) {
      if (usedDelegate === 'GPU' && goodFrames < 5) {
        cpuFallback(err).catch((e) => {
          running = false;
          status('error', `Pose tracking failed (${e?.message || e}). Use mouse controls instead.`);
        });
      } else status('error', `Pose inference error: ${err?.message || err}`);
      return;
    }
    const t1 = performance.now();
    goodFrames++;
    const k = stats.frames < 5 ? 0.5 : 0.1;
    stats.inferMs += (t1 - t0 - stats.inferMs) * k;
    stats.latencyMs += (t1 - t - stats.latencyMs) * k;
    if (lastFrameAt != null) {
      const dt = t1 - lastFrameAt;
      if (dt > 0) stats.fps += (1000 / dt - stats.fps) * k;
    }
    lastFrameAt = t1;
    stats.frames++;
    const lms = res?.landmarks || [];
    const worlds = res?.worldLandmarks || [];
    const people = lms.map((lm, i) => ({ landmarks: lm.map(copyLm), world: (worlds[i] || []).map(copyLm) }));
    stats.people = people.length;
    try {
      onFrame({ t, width: video.videoWidth, height: video.videoHeight, people });
    } catch (err) {
      // surface consumer bugs without killing the loop
      setTimeout(() => {
        throw err;
      });
    }
  }

  function onVideoFrame(now, md) {
    handle = null;
    if (!running) return;
    process(captureTimeOf(now, md));
    schedule();
  }

  function onRaf(now) {
    rafHandle = null;
    if (!running) return;
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      process(captureTimeOf(now, null));
    }
    schedule();
  }

  function schedule() {
    if (!running) return;
    if (typeof video.requestVideoFrameCallback === 'function') handle = video.requestVideoFrameCallback(onVideoFrame);
    else rafHandle = requestAnimationFrame(onRaf);
  }

  const api = {
    stats,
    get delegate() {
      return usedDelegate;
    },
    get model() {
      return curModel;
    },
    get running() {
      return running;
    },
    start() {
      if (running || closed) return;
      running = true;
      lastFrameAt = null;
      schedule();
    },
    stop() {
      running = false;
      if (handle != null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle);
      if (rafHandle != null) cancelAnimationFrame(rafHandle);
      handle = null;
      rafHandle = null;
    },
    /** Swap model at runtime ('lite' | 'full' | 'heavy'). */
    async setModel(m) {
      if (!MODELS.includes(m) || m === curModel) return;
      const wasRunning = running;
      api.stop();
      curModel = m;
      await load(usedDelegate || delegate);
      if (wasRunning) api.start();
    },
    close() {
      api.stop();
      closed = true;
      if (landmarker) landmarker.close();
      landmarker = null;
      popConsoleFilter();
    },
  };
  return api;
}
