// "Copy diagnostics" (Pause and Settings, D on the pause screen): a compact JSON snapshot of what a
// remote helper needs to understand a real session (round 3: the first real player could not tell
// why swings missed). Pure builder + a clipboard helper with a selectable-text fallback.
//
// buildDiagnostics(src) takes whatever is available; every field is optional:
//   src = { world, settings, tracking, calibration, pwa, stats, params, env: { ua, platform, lang,
//           dpr, width, height, screen, displayMode, url }, glasses (src/xr glasses.diagnostics()),
//           safety (stage.safety: black-screen safety-net counters), robust ({ stats: bodyTracker.stats,
//           yawDeg, sideOn } of the last sample: side-on tracking guards), input ('camera' |
//           'fallback' | 'autopilot': the hitting mode of a copy taken with no game running),
//           timingProfile (game/timingProfile.js: the camera player's learned timing bias) }
import { ASSIST, TRACKING } from '../config.js';
import { activeHitting, timingLog } from '../game/swingAssist.js';

export const DIAGNOSTICS_VERSION = 1;

const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v ?? null);

function cameraInfo(tracking) {
  if (!tracking) return null;
  const cam = tracking.camera || null;
  const set = cam && cam.settings ? cam.settings : {};
  return {
    label: cam ? cam.label || null : null,
    kind: cam ? cam.kind || null : null,
    preset: cam ? cam.presetKey || null : null,
    width: set.width ?? null,
    height: set.height ?? null,
    fps: r3(set.frameRate ?? null),
  };
}

function trackerInfo(tracking) {
  const st = tracking && tracking.stats;
  if (!st) return null;
  return {
    fps: r3(st.fps), inferMs: r3(st.inferMs), latencyMs: r3(st.latencyMs), frames: st.frames ?? null,
    captureTime: st.needsLatencyTest === undefined ? null : !st.needsLatencyTest,
    captureOffsetMs: r3(st.captureOffsetMs ?? null), model: st.model || null, delegate: st.delegate || null,
  };
}

function settingsCopy(s) {
  if (!s) return null;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === 'function') continue;
    out[k] = v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
  }
  return out;
}

/** A JSON-safe deep copy (null when it cannot be serialised). */
function jsonSafe(v) {
  if (v === null || v === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return null;
  }
}

/** Per drill / mode: hits and misses by reason (this app session, every world). */
function perMode(world) {
  const out = {};
  const add = (src) => {
    for (const [id, m] of Object.entries(src || {})) {
      const o = out[id] || (out[id] = { hits: 0, misses: {} });
      o.hits = Math.max(o.hits, m.hits || 0);
      for (const [r, n] of Object.entries(m.misses || {})) o.misses[r] = Math.max(o.misses[r] || 0, n);
    }
  };
  add(timingLog.byMode);
  if (world && world.timing) add(world.timing.byMode);
  return out;
}

/** The diagnostics object (JSON-safe). */
export function buildDiagnostics(src = {}) {
  const { world = null, settings = null, tracking = null, calibration = null, pwa = null, stats = null, params = null, env = {}, glasses = null, safety = null, robust = null, bodyTracker = null } = src;
  const s = settings || (world && world.settings) || null;
  const T = world && world.timing;
  // Round 6: the hitting the player gets, also when no game runs (a copy from Settings reported
  // 'physical' for a Rookie player: it read the absent world), with the personal timing in use.
  const H = s ? activeHitting({ world, settings: s, input: world ? world.input : (src.input || 'camera'), profile: src.timingProfile || null }) : null;
  const swings = (timingLog.swings.length ? timingLog.swings : T ? T.swings : []).slice(-40);
  return {
    kind: 'vibora-diagnostics',
    v: DIAGNOSTICS_VERSION,
    at: env.at || null,
    app: {
      version: (pwa && pwa.state && pwa.state.sw && pwa.state.sw.version) || null,
      displayMode: env.displayMode || null,
      url: env.url || null,
      params: params ? { autopilot: !!params.autopilot, speed: params.speed, drill: params.drill, mode: params.mode, debug: !!params.debug, apProfile: params.apProfile || null, apClose: !!params.apClose } : null,
    },
    browser: { ua: env.ua || null, platform: env.platform || null, lang: env.lang || null, cores: env.cores ?? null, memoryGB: env.memory ?? null },
    display: { width: env.width ?? null, height: env.height ?? null, dpr: env.dpr ?? null, screen: env.screen || null },
    camera: cameraInfo(tracking),
    tracker: trackerInfo(tracking),
    calibration: calibration ? { x0: r3(calibration.x0), d0: r3(calibration.d0), eyeHeight: r3(calibration.eyeHeight), scale: r3(calibration.scale), ok: !!calibration.ok } : null,
    settings: settingsCopy(s),
    hitting: s ? {
      assist: s.assist, mode: H.mode, windows: jsonSafe(H.windows), active: H.active, bias: H.bias, tuned: H.text,
      adapt: s.timingAdapt !== false, profile: jsonSafe(H.profile),
      latency: s.latency, presetCaptureOffsetMs: TRACKING.cameraPresets[s.cameraPreset] ? TRACKING.cameraPresets[s.cameraPreset].captureOffsetMs : null,
      assistPreset: ASSIST[s.assist] ? { contactMargin: ASSIST[s.assist].contactMargin, netSafety: ASSIST[s.assist].netSafety } : null,
    } : null,
    session: world ? {
      mode: world.mode && world.mode.id ? world.mode.id : null,
      simTime: r3(world.time),
      stats: stats || null,
      timing: T ? { log: T.log, learned: T.learned, lastMiss: T.lastMiss ? { reason: T.lastMiss.reason, text: T.lastMiss.text } : null } : null,
      speculative: world.specStats ? { strikes: world.specStats.strikes, confirmed: world.specStats.confirmed, reverted: world.specStats.reverted } : null,
      hitRejects: world.hitRejects ? { late: world.hitRejects.late, rules: world.hitRejects.rules, other: world.hitRejects.other } : null,
    } : null,
    perDrill: perMode(world),
    swings,
    glasses: jsonSafe(glasses),
    safety: jsonSafe(safety),
    robust: robust ? { stats: jsonSafe(robust.stats || null), yawDeg: r3(robust.yawDeg ?? null), sideOn: robust.sideOn ?? null } : null,
    // Close mode (tracking/body.js): 'full' | 'upper', camera tilt, upperFrames / modeSwitches.
    bodyTracker: bodyTracker ? jsonSafe({ ...bodyTracker, tilt: bodyTracker.tilt ? { deg: r3(bodyTracker.tilt.deg), confidence: r3(bodyTracker.tilt.confidence) } : null }) : null,
  };
}

/** Browser environment for buildDiagnostics (call in the page only). */
export function browserEnv() {
  const g = globalThis;
  const nav = g.navigator || {};
  const scr = g.screen || null;
  let displayMode = null;
  try {
    displayMode = g.matchMedia && g.matchMedia('(display-mode: standalone)').matches ? 'standalone'
      : g.matchMedia && g.matchMedia('(display-mode: fullscreen)').matches ? 'fullscreen' : 'browser';
  } catch {
    displayMode = null;
  }
  return {
    at: new Date().toISOString(),
    ua: nav.userAgent || null,
    platform: (nav.userAgentData && nav.userAgentData.platform) || nav.platform || null,
    lang: nav.language || null,
    cores: nav.hardwareConcurrency ?? null,
    memory: nav.deviceMemory ?? null,
    width: g.innerWidth ?? null,
    height: g.innerHeight ?? null,
    dpr: g.devicePixelRatio ?? null,
    screen: scr ? { width: scr.width, height: scr.height } : null,
    displayMode,
    url: g.location ? g.location.pathname + g.location.search : null,
  };
}

/**
 * Copies text from inside a click / key handler (navigator.clipboard.writeText needs the user
 * gesture). Resolves 'copied', or calls fallback(text) and resolves 'fallback' when the clipboard is
 * unavailable or refuses.
 */
export function copyText(text, fallback) {
  const nav = globalThis.navigator;
  try {
    if (nav && nav.clipboard && nav.clipboard.writeText) {
      return nav.clipboard.writeText(text).then(() => 'copied', () => {
        if (fallback) fallback(text);
        return 'fallback';
      });
    }
  } catch {
    /* fall through */
  }
  if (fallback) fallback(text);
  return Promise.resolve('fallback');
}
