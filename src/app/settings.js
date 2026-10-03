// Persistent settings: world DEFAULT_SETTINGS + UI-only keys + first-person framing.
// One live object is shared by the renderer, the camera and the human controller; worlds get
// a synced copy (createWorld copies its settings).
import { resolveSettings } from '../game/world.js';
import { UI_DEFAULT_SETTINGS } from '../ui/ui.js';
import { TRACKING } from '../config.js';

export const STORAGE_KEY = 'vibora.settings.v1';

/**
 * First-person framing chosen for a TV (see README "View"): a vertical FOV of 74°, the head
 * pitched 14° down and the viewpoint 12 cm behind / 6 cm below the tracked eyes put the hand
 * holding the racket and the off hand at the bottom of the picture in a ready position (like
 * a VR headset's wider view) while the far glass stays in frame. QA framing pass: the earlier
 * 72° / -12° with no offset left the racket floating without its hand.
 */
export const VIEW_DEFAULTS = Object.freeze({ fov: 74, viewPitch: -14, eyeOffset: Object.freeze({ back: 0.12, down: 0.06 }) });

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
  if (!['rookie', 'club', 'pro'].includes(s.assist)) s.assist = 'club';
  if (!['ultra', 'high', 'balanced'].includes(s.quality)) s.quality = 'high';
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
  const base = resolveSettings({ ...UI_DEFAULT_SETTINGS, ...VIEW_DEFAULTS, ...stored });
  base.volumes = { ...UI_DEFAULT_SETTINGS.volumes, ...(stored.volumes || {}) };
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
