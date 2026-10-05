// Persistent settings: world DEFAULT_SETTINGS + UI-only keys + first-person framing.
// One live object is shared by the renderer, the camera and the human controller; worlds get
// a synced copy (createWorld copies its settings).
import { resolveSettings } from '../game/world.js';
import { UI_DEFAULT_SETTINGS } from '../ui/ui.js';
import { TRACKING } from '../config.js';
import { VENUE_IDS, DEFAULT_VENUE } from '../render/venues/meta.js';
import { RACKETS, OUTFITS, DEFAULT_RACKET, DEFAULT_OUTFIT } from '../game/progression.js';

export const STORAGE_KEY = 'vibora.settings.v1';

/**
 * First-person framing chosen for a TV (see README "View"): a vertical FOV of 74°, the head
 * pitched 14° down and the viewpoint 12 cm behind / 6 cm below the tracked eyes put the hand
 * holding the racket and the off hand at the bottom of the picture in a ready position (like
 * a VR headset's wider view) while the far glass stays in frame. QA framing pass: the earlier
 * 72° / -12° with no offset left the racket floating without its hand.
 */
export const VIEW_DEFAULTS = Object.freeze({ fov: 74, viewPitch: -14, eyeOffset: Object.freeze({ back: 0.12, down: 0.06 }) });

/**
 * App-only settings: offAxisYaw is the experimental off-axis arm correction of the MediaPipe
 * world landmarks (app/tracking.js correctOffAxisYaw), off until verified on real footage.
 * hitPrediction (predictive hitting) is a world default (game/world.js DEFAULT_SETTINGS).
 * glassView: how a ball behind the player is shown (render/gaze.js GLASS_VIEW): 'mirror' (the view
 * stays on the net, a rear-view mirror inset shows the glass), 'turn' (a smooth head turn up to
 * 75°) or 'fixed'. racketGhost: a faint racket at the planned contact (timing hitting). Glasses mode keeps its own settings (src/xr/glasses.js, 'vibora.xr.v1').
 * timingAdapt (round 6): centre the timing windows on the player's own learned timing
 * (game/timingProfile.js, stored per camera under 'vibora.timing.v1'; Settings → Play).
 */
export const APP_DEFAULTS = Object.freeze({ offAxisYaw: false, glassView: 'mirror', racketGhost: true, cameraTilt: 'auto', hud: 'clean', approachTick: 'auto', timingAdapt: true });
/**
 * Round 6 (clarity): the play HUD layout. 'clean' (default): a slim top bar and one feedback line,
 * nothing over the court while a ball is live; 'standard': the same plus the last-shot card between
 * points; 'coach': every card (shot card with coaching notes, timing meter, camera picture).
 */
export const HUD_MODES = Object.freeze(['clean', 'standard', 'coach']);
/** Round 6: the approach circle's audio tick 0.2 s before the moment to swing ('auto' = Rookie). */
export const APPROACH_TICKS = Object.freeze(['auto', 'on', 'off']);
/** Settings → Camera tilt choices (deg up; 'auto' = measured in calibration). */
export const CAMERA_TILTS = Object.freeze(['auto', '0', '5', '10', '15', '20']);

/** Safe localStorage wrapper ({getItem,setItem} or null). */
export function safeStorage() {
  try {
    const s = globalThis.localStorage;
    const k = '__vibora_probe__';
    s.setItem(k, '1');
    s.removeItem(k);
    return {
      getItem: (key) => { try { return s.getItem(key); } catch { return null; } },
      setItem: (key, v) => { try { s.setItem(key, v); } catch { /* quota / private mode */ } },
    };
  } catch {
    const mem = new Map();
    return { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  }
}

function clampSettings(s) {
  const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  s.fov = num(s.fov, 55, 100, VIEW_DEFAULTS.fov);
  s.viewPitch = num(s.viewPitch, -30, 5, VIEW_DEFAULTS.viewPitch);
  const eo = s.eyeOffset && typeof s.eyeOffset === 'object' ? s.eyeOffset : VIEW_DEFAULTS.eyeOffset;
  s.eyeOffset = { back: num(eo.back, -0.2, 0.4, VIEW_DEFAULTS.eyeOffset.back), down: num(eo.down, -0.2, 0.3, VIEW_DEFAULTS.eyeOffset.down) };
  s.latency = num(s.latency, 0, 0.3, TRACKING.latencyDefault);
  s.height = num(s.height, 1.4, 2.1, 1.75);
  s.gainLateral = num(s.gainLateral, 1, 4, TRACKING.gainLateral);
  s.gainDepth = num(s.gainDepth, 1, 4, TRACKING.gainDepth);
  if (s.handed !== 'left') s.handed = 'right';
  s.offAxisYaw = s.offAxisYaw === true;
  if (!['mirror', 'turn', 'fixed'].includes(s.glassView)) s.glassView = 'mirror';
  s.hitPrediction = s.hitPrediction !== false;
  if (!['rookie', 'club', 'pro'].includes(s.assist)) s.assist = 'club';
  // Round 3 hittability settings.
  if (!['auto', 'timing', 'physical'].includes(s.hitMode)) s.hitMode = 'auto';
  if (!['realistic', 'enhanced', 'max'].includes(s.ballVisibility)) s.ballVisibility = 'enhanced';
  s.learningSlowmo = s.learningSlowmo === true ? 'on' : s.learningSlowmo === false ? 'off' : ['on', 'off'].includes(s.learningSlowmo) ? s.learningSlowmo : 'auto';
  s.timingTick = s.timingTick === true;
  // Round 5: the racket ghost at the planned contact (game/swingAssist.js contactGhostPose).
  s.racketGhost = s.racketGhost !== false;
  if (!CAMERA_TILTS.includes(String(s.cameraTilt))) s.cameraTilt = 'auto';
  // Round 6: HUD layout and the approach circle's tick (a legacy timingTick true asks for every ball).
  if (!HUD_MODES.includes(s.hud)) s.hud = 'clean';
  if (!APPROACH_TICKS.includes(s.approachTick)) s.approachTick = s.timingTick === true ? 'on' : 'auto';
  s.cameraTilt = String(s.cameraTilt);
  s.timingAdapt = s.timingAdapt !== false;
  if (!['ultra', 'high', 'balanced'].includes(s.quality)) s.quality = 'high';
  // Round 4: venue, umpire, callouts, replays, equipped racket / outfit (stored values are checked).
  if (!VENUE_IDS.includes(s.venue)) s.venue = DEFAULT_VENUE;
  if (!['es', 'en', 'off'].includes(s.umpireLang)) s.umpireLang = 'es';
  s.callouts = s.callouts !== false;
  s.autoReplay = s.autoReplay !== false;
  if (typeof s.racketModel !== 'string' || !RACKETS.some((r) => r.id === s.racketModel)) s.racketModel = DEFAULT_RACKET;
  if (typeof s.outfit !== 'string' || !OUTFITS.some((o) => o.id === s.outfit)) s.outfit = DEFAULT_OUTFIT;
  if (!TRACKING.cameraPresets[s.cameraPreset]) s.cameraPreset = TRACKING.defaultCamera;
  s.hfovDeg = TRACKING.cameraPresets[s.cameraPreset].hfov;
  return s;
}

/** Loads the stored settings over the defaults. */
export function loadSettings(storage) {
  let stored = {};
  try {
    const raw = storage && storage.getItem(STORAGE_KEY);
    if (raw) stored = JSON.parse(raw) || {};
  } catch {
    stored = {};
  }
  const base = resolveSettings({ ...UI_DEFAULT_SETTINGS, ...VIEW_DEFAULTS, ...APP_DEFAULTS, ...stored });
  // Round 6 migration: saves from before the clean HUD (no 'hud' key) stored every setting, so the old
  // camera picture-in-picture default (on) is indistinguishable from a choice: start them on the new
  // default (off; a tracking dot instead, the picture comes back by itself when tracking is lost).
  if (Object.keys(stored).length && stored.hud === undefined) base.pip = false;
  // A legacy "timing tick on every ball" keeps ticking with the approach circle's tick.
  if (stored.approachTick === undefined && stored.timingTick === true) base.approachTick = 'on';
  base.volumes = { ...UI_DEFAULT_SETTINGS.volumes, ...(stored.volumes || {}) };
  // Crowd volume (round 4; older saves have none): 0..1, default 0.7.
  base.volumes.crowd = Number.isFinite(base.volumes.crowd) ? Math.min(1, Math.max(0, base.volumes.crowd)) : 0.7;
  return clampSettings(base);
}

/**
 * @returns {{ value: object, patch(p): string[] (changed keys), save() }}
 */
export function createSettingsStore(storage) {
  const value = loadSettings(storage);
  let timer = null;
  function save() {
    clearTimeout(timer);
    timer = null;
    try {
      storage && storage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }
  function patch(p = {}) {
    const changed = [];
    for (const [k, v] of Object.entries(p)) {
      if (k === 'volumes' && v && typeof v === 'object') {
        value.volumes = { ...value.volumes, ...v };
        changed.push(k);
      } else if (value[k] !== v) {
        value[k] = v;
        changed.push(k);
      }
    }
    if (changed.includes('cameraPreset') || changed.includes('fov') || changed.includes('latency')) clampSettings(value);
    if (changed.length) {
      clearTimeout(timer);
      timer = setTimeout(save, 250);
    }
    return changed;
  }
  return { value, patch, save };
}
