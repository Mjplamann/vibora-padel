// Víbora Padel 10-foot UI (SPEC §8): every screen, the play HUD, banners, toasts,
// camera previews with skeleton overlay, the hand-cursor visual, and spatial
// keyboard navigation. Works with hand dwell (via cursor.js), keyboard and mouse.
//
// Navigation the UI performs on its own (title -> camera -> calibrate -> hub,
// hub card -> drill intro, settings/help and back) re-uses the data last passed to
// show() for that screen and notifies `handlers.onScreen?.(name, data)` so main.js
// can refresh it (e.g. list cameras, reload bests).

import { TRACKING, ASSIST } from '../config.js';
import { clamp, createRng } from '../util/math.js';
import { courtDiagram, landingMap, strokeBars, strokeName, drawSkeleton, escapeHtml as esc, fitCanvas } from './charts.js';

export const SCREENS = Object.freeze(['loading', 'title', 'camera', 'calibrate', 'hub', 'drill-intro', 'play', 'pause', 'results', 'settings', 'help']);

export const SKILLS = Object.freeze([
  { id: 'Groundstrokes', en: 'Groundstrokes', es: 'Fondo' },
  { id: 'Walls', en: 'Walls', es: 'Paredes' },
  { id: 'Net', en: 'Net', es: 'Red' },
  { id: 'Overheads', en: 'Overheads', es: 'Juego aéreo' },
  { id: 'Tactics', en: 'Tactics', es: 'Táctica' },
  { id: 'Serve', en: 'Serve', es: 'Saque y resto' },
]);

/** Settings the UI edits. Mirrors game/world.js DEFAULT_SETTINGS plus UI/render-only keys. */
export const UI_DEFAULT_SETTINGS = Object.freeze({
  assist: 'club', latency: TRACKING.latencyDefault, height: 1.75, handed: 'right',
  gainLateral: TRACKING.gainLateral, gainDepth: TRACKING.gainDepth, fov: 70,
  gazeFollow: true, landingMarker: true, contactGhost: false, halo: false,
  quality: 'high', voice: 'en', volumes: Object.freeze({ master: 0.9, sfx: 1, ambience: 0.5 }),
  skinTone: '#c58c6a', racketColor: '#e8572a', pip: true, skeleton: true,
  cameraPreset: TRACKING.defaultCamera,
});

const CAL_STEPS = [
  { id: 'body', en: 'Full body', es: 'Cuerpo entero' },
  { id: 'spot', en: 'Your spot', es: 'Tu sitio' },
  { id: 'profile', en: 'Profile', es: 'Perfil' },
  { id: 'latency', en: 'Latency', es: 'Latencia', optional: true },
  { id: 'area', en: 'Play area', es: 'Zona de juego' },
];
const DIST_IDEAL = [2.2, 3.5];
const DIST_SCALE = [1.4, 4.6];
const BODY_PARTS = [['head', 'Head', 'Cabeza'], ['shoulders', 'Shoulders', 'Hombros'], ['hips', 'Hips', 'Cadera'], ['knees', 'Knees', 'Rodillas'], ['ankles', 'Ankles', 'Tobillos']];
const LAT_BEAT_MS = 1100;
const LAT_LEAD_BEATS = 3;
const LAT_FLASHES = 6;
const LAT_FLASH_MS = 170;
const SPOT_HOLD_S = 2;
const AREA_STEP_M = 0.3;

const FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"]), [role="slider"]:not([aria-disabled="true"]), [data-focus]';
const PRESET_SHORT = { 'macbook-builtin': 'MacBook', 'iphone-continuity': 'iPhone', 'iphone-ultrawide': 'iPhone wide', 'usb-webcam': 'USB', 'usb-wide': 'USB wide' };
const SKIN_TONES = ['#f2cdb0', '#e2b08c', '#c58c6a', '#a46b4b', '#7b4a33', '#4e3024'];
const RACKET_COLORS = [['#e8572a', 'Ember'], ['#1f6fe0', 'Court blue'], ['#13a89e', 'Teal'], ['#d81b4f', 'Raspberry'], ['#eceae4', 'Chalk'], ['#16181d', 'Carbon']];

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmtInt = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');
const fmtTime = (s) => {
  if (typeof s === 'string') return s;
  if (!Number.isFinite(s)) return '';
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};
const pct = (v) => `${Math.round(v * 100)}%`;
const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

// ---------------------------------------------------------------------------
// Small inline SVG glyphs (line icons drawn for this product, no emoji).

const ICON = {
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.75 6.1 6.65.7-5 4.47 1.42 6.53L12 17.1l-5.82 3.3 1.42-6.53-5-4.47 6.65-.7z"/></svg>',
  laptop: '<svg viewBox="0 0 32 24" aria-hidden="true"><rect x="5" y="3" width="22" height="14" rx="1.5"/><path d="M2 20h28"/><circle cx="16" cy="5.6" r=".9" class="fill"/></svg>',
  phone: '<svg viewBox="0 0 32 24" aria-hidden="true"><rect x="10" y="1.5" width="12" height="21" rx="2"/><circle cx="13.5" cy="5" r="1.3"/><circle cx="13.5" cy="8.6" r="1.3"/></svg>',
  webcam: '<svg viewBox="0 0 32 24" aria-hidden="true"><circle cx="16" cy="10" r="7"/><circle cx="16" cy="10" r="2.6"/><path d="M11 22h10M16 17v5"/></svg>',
  arrow: '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M20 7v24M10 22l10 10 10-10"/></svg>',
  check: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5l4 4 8-9"/></svg>',
  back: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4l-6 6 6 6"/></svg>',
  hand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 13V5.5a1.5 1.5 0 013 0V11m0-6.5V4a1.5 1.5 0 013 0v7m0-5.5a1.5 1.5 0 013 0V12m0-3.5a1.5 1.5 0 013 0V15a7 7 0 01-7 7h-1.2a6 6 0 01-4.8-2.4L4.3 15.5a1.6 1.6 0 012.4-2.1L8 14.7"/></svg>',
  install: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12.5" rx="1.8"/><path d="M8 20.5h8M12 7.5v6M9.2 11l2.8 2.8 2.8-2.8"/></svg>',
  racket: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.2 14.8a6.2 6.2 0 118.6-1.4c-1.6 1.6-3.3 2.4-5.2 2.4l-5.4 5.4-1.8-1.8 5.4-5.4c-.2-.7-.9-1.4-1.6.8z"/><circle cx="13.2" cy="8.4" r=".7" class="fill"/><circle cx="15.6" cy="8.4" r=".7" class="fill"/><circle cx="13.2" cy="10.8" r=".7" class="fill"/><circle cx="15.6" cy="10.8" r=".7" class="fill"/></svg>',
};

function starsHtml(n, total = 3, cls = '') {
  let s = `<span class="stars ${cls}" role="img" aria-label="${n} of ${total} stars">`;
  for (let i = 0; i < total; i++) s += `<i class="${i < n ? 'on' : ''}">${ICON.star}</i>`;
  return s + '</span>';
}

function levelHtml(level) {
  const l = clamp(Math.round(level || 1), 1, 3);
  return `<span class="lvl" role="img" aria-label="Level ${l} of 3"><i class="${l >= 1 ? 'on' : ''}"></i><i class="${l >= 2 ? 'on' : ''}"></i><i class="${l >= 3 ? 'on' : ''}"></i></span>`;
}

// ---------------------------------------------------------------------------
// Control builders (segmented pickers, sliders, switches, swatches).

function segHtml(name, options, value, { label = '' } = {}) {
  const btns = options.map(([v, text, sub]) => `<button type="button" role="radio" data-value="${esc(v)}" aria-checked="${String(v) === String(value)}">${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}</button>`).join('');
  return `<div class="seg" role="radiogroup" data-seg="${esc(name)}" aria-label="${esc(label || name)}">${btns}</div>`;
}

function rangeHtml(name, { min, max, step, value, label = '', fmt = (v) => String(v) }) {
  const t = (clamp(value, min, max) - min) / (max - min);
  return `<div class="range" data-range="${esc(name)}" data-min="${min}" data-max="${max}" data-step="${step}">
    <button type="button" class="range-step" data-delta="-1" tabindex="-1" aria-label="Decrease ${esc(label)}" data-dwell-repeat>−</button>
    <div class="range-track" role="slider" tabindex="0" aria-label="${esc(label)}" aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${value}" aria-valuetext="${esc(fmt(value))}" style="--t:${t}">
      <span class="range-rail"></span><span class="range-fill"></span><span class="range-thumb"></span>
    </div>
    <button type="button" class="range-step" data-delta="1" tabindex="-1" aria-label="Increase ${esc(label)}" data-dwell-repeat>+</button>
  </div>`;
}

function switchHtml(name, on, label) {
  return `<button type="button" class="switch" role="switch" data-switch="${esc(name)}" aria-checked="${!!on}" aria-label="${esc(label)}"><span class="sw-track"><span class="sw-knob"></span></span><span class="sw-text">${on ? 'On' : 'Off'}</span></button>`;
}

function swatchHtml(name, colors, value, label) {
  return `<div class="swatches" role="radiogroup" data-seg="${esc(name)}" aria-label="${esc(label)}">${colors.map((c) => {
    const [hex, title] = Array.isArray(c) ? c : [c, c];
    return `<button type="button" role="radio" class="swatch" data-value="${hex}" aria-checked="${hex.toLowerCase() === String(value).toLowerCase()}" aria-label="${esc(title)}" style="--sw:${hex}"></button>`;
  }).join('')}</div>`;
}

function fieldHtml(label, es, control, { valueId = null, value = '' } = {}) {
  return `<div class="field"><div class="field-head"><span class="field-label">${esc(label)}${es ? `<span class="es">${esc(es)}</span>` : ''}</span>${valueId ? `<output class="field-val" data-out="${esc(valueId)}">${esc(value)}</output>` : ''}</div>${control}</div>`;
}

// ---------------------------------------------------------------------------
// Settings schema (SPEC §8 settings screen).

const SETTINGS_GROUPS = [
  {
    en: 'Play', es: 'Juego', items: [
      { key: 'assist', type: 'seg', en: 'Assist', es: 'Ayuda', options: [['rookie', 'Rookie'], ['club', 'Club'], ['pro', 'Pro']] },
      { key: 'hitPrediction', type: 'switch', en: 'Predictive hitting', es: 'Golpe predictivo' },
      { key: 'gazeFollow', type: 'switch', en: 'Gaze follows the ball', es: 'Mirada a la bola' },
      { key: 'landingMarker', type: 'switch', en: 'Landing marker', es: 'Marca de bote' },
      { key: 'contactGhost', type: 'switch', en: 'Ideal contact ghost', es: 'Punto de impacto ideal' },
      { key: 'halo', type: 'switch', en: 'Ball halo', es: 'Halo de la bola' },
    ],
  },
  {
    en: 'Movement & view', es: 'Movimiento y vista', items: [
      { key: 'gainLateral', type: 'range', en: 'Side-step gain', es: 'Lateral', min: 1, max: 4, step: 0.1, fmt: (v) => `×${v.toFixed(1)}` },
      { key: 'gainDepth', type: 'range', en: 'Forward / back gain', es: 'Profundidad', min: 1, max: 4, step: 0.1, fmt: (v) => `×${v.toFixed(1)}` },
      { key: 'fov', type: 'range', en: 'Field of view', es: 'Campo de visión', min: 55, max: 100, step: 1, fmt: (v) => `${Math.round(v)}°` },
      { key: 'latency', type: 'range', en: 'Latency compensation', es: 'Latencia', min: 0, max: 0.3, step: 0.005, fmt: (v) => `${Math.round(v * 1000)} ms` },
      { key: 'offAxisYaw', type: 'switch', en: 'Off-axis arm correction (experimental)', es: 'Corrección fuera de eje (experimental)' },
    ],
  },
  {
    en: 'Player', es: 'Jugador', items: [
      { key: 'handed', type: 'seg', en: 'Handedness', es: 'Mano', options: [['right', 'Right', 'Diestro'], ['left', 'Left', 'Zurdo']] },
      { key: 'height', type: 'range', en: 'Height', es: 'Altura', min: 1.4, max: 2.1, step: 0.01, fmt: (v) => `${v.toFixed(2)} m` },
      { key: 'skinTone', type: 'swatch', en: 'Skin tone', es: 'Tono de piel', options: SKIN_TONES },
      { key: 'racketColor', type: 'swatch', en: 'Racket colour', es: 'Color de la pala', options: RACKET_COLORS },
    ],
  },
  {
    en: 'Picture & sound', es: 'Imagen y sonido', items: [
      { key: 'quality', type: 'seg', en: 'Graphics quality', es: 'Calidad', options: [['balanced', 'Balanced'], ['high', 'High'], ['ultra', 'Ultra']] },
      { key: 'voice', type: 'seg', en: 'Voice coach', es: 'Entrenador por voz', options: [['off', 'Off'], ['en', 'English'], ['es', 'Español']] },
      { key: 'volumes.master', type: 'range', en: 'Master volume', es: 'Volumen', min: 0, max: 1, step: 0.05, fmt: pct },
      { key: 'volumes.sfx', type: 'range', en: 'Ball & racket', es: 'Efectos', min: 0, max: 1, step: 0.05, fmt: pct },
      { key: 'volumes.ambience', type: 'range', en: 'Club ambience', es: 'Ambiente', min: 0, max: 1, step: 0.05, fmt: pct },
      { key: 'pip', type: 'switch', en: 'Camera picture-in-picture', es: 'Cámara en pantalla' },
      { key: 'skeleton', type: 'switch', en: 'Skeleton overlay', es: 'Esqueleto' },
    ],
  },
];
const SETTING_ITEMS = Object.fromEntries(SETTINGS_GROUPS.flatMap((g) => g.items.map((it) => [it.key, it])));

/** Builds a settings patch for a (possibly nested 'volumes.x') key. */
function patchFor(settings, key, value) {
  if (!key.includes('.')) return { [key]: value };
  const [a, b] = key.split('.');
  return { [a]: { ...(settings[a] || {}), [b]: value } };
}

function applyPatch(settings, patch) {
  const out = { ...settings };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && settings[k] && typeof settings[k] === 'object' ? { ...settings[k], ...v } : v;
  }
  return out;
}

// ---------------------------------------------------------------------------

/**
 * @param {HTMLElement} root
 * @param {object} handlers  SPEC §8 handlers plus optional onScreen(name, data)
 */
export function createUI(root, handlers = {}) {
  const call = (name, ...args) => (typeof handlers[name] === 'function' ? handlers[name](...args) : undefined);

  const state = {
    screen: null,
    data: {},
    returnTo: {},
    settings: { ...UI_DEFAULT_SETTINGS, volumes: { ...UI_DEFAULT_SETTINGS.volumes } },
    hubLevel: 'club',
    focusMemory: {},
    hud: null,
    hudKeyShot: null,
    hudKeyBanner: null,
    lastPoints: null,
    preview: null,
    skeleton: null,
    skeletonAt: 0,
    calib: null,
    calStatus: {},
    loading: { p: 0, text: 'Warming up the court…' },
    ballInd: null,
    install: { kind: 'none', onInstall: null }, // app packaging (src/app/pwa.js)
  };

  // ---- DOM scaffold ---------------------------------------------------------
  root.classList.add('vp');
  root.dataset.input = 'keys';
  root.innerHTML = `
    <div class="vp-screen" data-layer="screen"></div>
    <div class="vp-hud" data-layer="hud" hidden></div>
    <div class="vp-banner" aria-live="assertive"></div>
    <div class="vp-toasts" aria-live="polite"></div>
    <div class="vp-update" role="status" hidden><span class="vu-text">Update ready<small>Nueva versión lista</small></span><button type="button" class="btn btn-sm go" data-update-restart>Restart</button></div>
    <div class="vp-pausehold" hidden><svg viewBox="0 0 64 64" aria-hidden="true"><circle class="bg" cx="32" cy="32" r="27"/><circle class="fg" cx="32" cy="32" r="27"/></svg><span>Hold to pause<small>Mantén para pausar</small></span></div>
    <div class="vp-cursor" hidden aria-hidden="true"><svg viewBox="0 0 80 80"><circle class="halo" cx="40" cy="40" r="30"/><circle class="track" cx="40" cy="40" r="30"/><circle class="ring" cx="40" cy="40" r="30"/></svg><span class="dot"></span></div>`;
  const $ = (sel, scope = root) => scope.querySelector(sel);
  const layerScreen = $('[data-layer="screen"]');
  const layerHud = $('[data-layer="hud"]');
  const bannerEl = $('.vp-banner');
  const toastEl = $('.vp-toasts');
  const cursorEl = $('.vp-cursor');
  const pauseHoldEl = $('.vp-pausehold');
  const RING_C = 2 * Math.PI * 30;
  const HOLD_C = 2 * Math.PI * 27;

  buildHud();

  // ---- Focus & spatial navigation ------------------------------------------
  function isVisible(el) {
    if (!el.isConnected || el.closest('[hidden], [inert]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function scopeEl() {
    return state.screen === 'play' ? layerHud : layerScreen;
  }

  function focusables(scope = scopeEl()) {
    return Array.from(scope.querySelectorAll(FOCUSABLE)).filter(isVisible);
  }

  function focusEl(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  function defaultFocus(scope = scopeEl()) {
    const key = state.focusMemory[state.screen];
    if (key) {
      const m = scope.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
      if (m && isVisible(m)) return m;
    }
    const a = scope.querySelector('[data-autofocus]');
    if (a && isVisible(a) && !a.disabled) return a;
    return focusables(scope)[0] || null;
  }

  function navigate(dir) {
    const items = focusables();
    if (!items.length) return;
    const cur = document.activeElement;
    if (!items.includes(cur)) {
      focusEl(defaultFocus());
      return;
    }
    const r0 = cur.getBoundingClientRect();
    const cx0 = r0.left + r0.width / 2, cy0 = r0.top + r0.height / 2;
    const horiz = dir === 'left' || dir === 'right';
    const sign = dir === 'right' || dir === 'down' ? 1 : -1;
    let best = null, bestScore = Infinity;
    for (const el of items) {
      if (el === cur) continue;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const d = horiz ? (cx - cx0) * sign : (cy - cy0) * sign;
      if (d <= 2) continue;
      const gap = horiz ? (sign > 0 ? r.left - r0.right : r0.left - r.right) : (sign > 0 ? r.top - r0.bottom : r0.top - r.bottom);
      const overlap = horiz ? Math.min(r.bottom, r0.bottom) - Math.max(r.top, r0.top) : Math.min(r.right, r0.right) - Math.max(r.left, r0.left);
      const ortho = overlap > 0 ? 0 : horiz ? Math.abs(cy - cy0) : Math.abs(cx - cx0);
      const score = Math.max(0, gap) + ortho * 2.2 + (overlap > 0 ? 0 : 60) + (horiz ? 0 : Math.abs(cx - cx0) * 0.05);
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) focusEl(best);
  }

  root.addEventListener('focusin', (e) => {
    const k = e.target.dataset && e.target.dataset.focusKey;
    if (k && state.screen) state.focusMemory[state.screen] = k;
  });

  const onKey = (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    root.dataset.input = 'keys';
    const k = e.key;
    const dirs = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    if (state.screen === 'play') {
      if (k === 'Escape' || k === 'p' || k === 'P') {
        e.preventDefault();
        call('onPause');
      } else if (k === 'c' || k === 'C') {
        changeSetting('pip', !state.settings.pip);
        toast(`Camera view ${state.settings.pip ? 'on' : 'off'}`);
      } else if (k === 'k' || k === 'K') {
        changeSetting('skeleton', !state.settings.skeleton);
        toast(`Skeleton overlay ${state.settings.skeleton ? 'on' : 'off'}`);
      }
      return;
    }
    if (dirs[k]) {
      e.preventDefault();
      navigate(dirs[k]);
      return;
    }
    if (k === 'Escape' || k === 'Backspace') {
      e.preventDefault();
      escapeAction();
      return;
    }
    if (k === 'Enter' || k === ' ') {
      const a = document.activeElement;
      if (!a || a === document.body || !root.contains(a)) {
        e.preventDefault();
        const d = defaultFocus();
        if (state.screen === 'title') d?.click();
        else focusEl(d);
      }
    }
  };
  window.addEventListener('keydown', onKey);
  const onPointer = () => { root.dataset.input = 'pointer'; };
  window.addEventListener('pointermove', onPointer, { passive: true });

  function escapeAction() {
    switch (state.screen) {
      case 'pause': call('onResume'); break;
      case 'settings': case 'help': goBack(); break;
      case 'camera': goto('title'); break;
      case 'calibrate': calBack(); break;
      case 'drill-intro': goto('hub'); break;
      case 'results': goto('hub'); call('onQuit'); break;
      default: break;
    }
  }

  // ---- Screen management -----------------------------------------------------
  const RENDER = {
    loading: renderLoading,
    title: renderTitle,
    camera: renderCamera,
    calibrate: renderCalibrate,
    hub: renderHub,
    'drill-intro': renderDrillIntro,
    pause: renderPause,
    results: renderResults,
    settings: renderSettings,
    help: renderHelp,
    play: () => null,
  };

  let mounted = null; // { el, mount, unmount, redraw }

  function show(screen, data) {
    if (!RENDER[screen]) throw new Error(`Unknown UI screen: ${screen}`);
    const prev = state.screen;
    if (data !== undefined) state.data[screen] = data;
    if (screen === 'hub' && data) {
      if (data.level) state.hubLevel = data.level;
    }
    if (screen === 'settings' && data && typeof data === 'object' && !Array.isArray(data)) {
      state.settings = applyPatch(state.settings, data);
    }
    if ((screen === 'settings' || screen === 'help') && prev && prev !== screen && prev !== 'settings' && prev !== 'help') {
      state.returnTo[screen] = prev;
    }
    if (mounted && mounted.unmount) mounted.unmount();
    mounted = null;
    state.screen = screen;
    root.dataset.screen = screen;

    const playing = screen === 'play' || screen === 'pause';
    layerHud.hidden = !playing;
    layerHud.classList.toggle('is-paused', screen === 'pause');
    if (playing && data && screen === 'play') {
      if (data.mode) layerHud.dataset.mode = data.mode;
      if (data.hud) hud(data.hud);
    }
    if (screen !== 'play' && screen !== 'pause') hideBallIndicator();

    const view = RENDER[screen](state.data[screen] || {});
    layerScreen.innerHTML = '';
    if (view) {
      view.el.classList.add('screen', `screen-${screen}`);
      if (!reducedMotion() && prev !== screen) view.el.classList.add('is-entering');
      layerScreen.appendChild(view.el);
      mounted = view;
      if (view.mount) view.mount();
      bindControls(view.el, view.onControl || null);
      requestAnimationFrame(() => view.el.classList.remove('is-entering'));
      const d = defaultFocus(view.el);
      if (d && !(screen === 'pause' && document.activeElement && view.el.contains(document.activeElement))) d.focus({ preventScroll: true });
    } else if (document.activeElement && layerScreen.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    updatePreviewSize();
    ensureLoop();
    return api;
  }

  /** UI-initiated navigation: shows with cached data and tells main.js. */
  function goto(screen, data) {
    show(screen, data);
    call('onScreen', screen, state.data[screen]);
  }

  function goBack() {
    const to = state.returnTo[state.screen] || (state.screen === 'help' ? 'title' : 'hub');
    goto(to);
  }

  // ---- Event delegation for data-action buttons -----------------------------
  layerScreen.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b || !layerScreen.contains(b) || b.disabled) return;
    action(b.dataset.action, b);
  });

  function action(name, el) {
    const d = el.dataset;
    switch (name) {
      case 'start': goto('camera'); break;
      case 'fallback': call('onUseFallbackControls'); break;
      case 'help': goto('help'); break;
      case 'install': if (state.install.onInstall) state.install.onInstall(); break;
      case 'settings': goto('settings'); break;
      case 'back': goBack(); break;
      case 'hub': goto('hub'); break;
      case 'camera': goto('camera'); break;
      case 'camera-retry': call('onCameraRetry'); break;
      case 'select-camera': {
        const cam = state.data.camera || {};
        const c = (cam.cameras || []).find((x) => x.deviceId === d.device) || {};
        const preset = c.presetKey || cam.presetKey || state.settings.cameraPreset;
        state.data.camera = { ...cam, selectedId: d.device, presetKey: preset };
        call('onCameraSelect', d.device, preset);
        refreshCameraList();
        break;
      }
      case 'to-calibrate': state.returnTo.calibrate = 'camera'; goto('calibrate', { step: 'body' }); break;
      case 'recalibrate': goto('calibrate', { step: 'body' }); break;
      case 'cal-next': calAdvance(); break;
      case 'cal-skip': calAdvance(true); break;
      case 'cal-back': calBack(); break;
      case 'lat-start': latStart(); break;
      case 'lat-accept': latAccept(); break;
      case 'cal-done': calFinish(); break;
      case 'drill': openDrill(d.drill); break;
      case 'start-drill': call('onStartDrill', d.drill); break;
      case 'rally': call('onStartRally', state.hubLevel); break;
      case 'match': call('onStartMatch', state.hubLevel); break;
      case 'resume': call('onResume'); break;
      case 'restart': call('onRestart'); break;
      case 'replay': call('onReplay'); break;
      case 'quit': call('onQuit'); goto('hub'); break;
      case 'next-drill': openDrill(d.drill); break;
      case 'pause-settings': state.returnTo.settings = 'pause'; goto('settings'); break;
      case 'pause-recal': state.returnTo.calibrate = 'pause'; goto('calibrate', { step: 'body' }); break;
      default: break;
    }
  }

  function openDrill(id) {
    const hubData = state.data.hub || {};
    const drill = (hubData.drills || []).find((x) => x.id === id) || (state.data['drill-intro'] && state.data['drill-intro'].drill && state.data['drill-intro'].drill.id === id ? state.data['drill-intro'].drill : null);
    if (!drill) {
      call('onStartDrill', id);
      return;
    }
    const best = (hubData.bests || {})[id] || null;
    goto('drill-intro', { drill, best });
  }

  // ---- Controls binding ------------------------------------------------------
  function bindControls(scope, onControl) {
    const emit = onControl || ((key, value) => changeSetting(key, value));
    scope.querySelectorAll('[data-seg]').forEach((group) => {
      group.addEventListener('click', (e) => {
        const b = e.target.closest('[role="radio"]');
        if (!b || !group.contains(b)) return;
        group.querySelectorAll('[role="radio"]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        emit(group.dataset.seg, b.dataset.value);
      });
    });
    scope.querySelectorAll('[data-switch]').forEach((sw) => {
      sw.addEventListener('click', () => {
        const on = sw.getAttribute('aria-checked') !== 'true';
        setSwitch(sw, on);
        emit(sw.dataset.switch, on);
      });
    });
    scope.querySelectorAll('[data-range]').forEach((rg) => bindRange(rg, emit));
  }

  function setSwitch(sw, on) {
    sw.setAttribute('aria-checked', String(on));
    const t = sw.querySelector('.sw-text');
    if (t) t.textContent = on ? 'On' : 'Off';
  }

  function bindRange(rg, emit) {
    const key = rg.dataset.range;
    const min = Number(rg.dataset.min), max = Number(rg.dataset.max), step = Number(rg.dataset.step);
    const track = rg.querySelector('.range-track');
    const item = SETTING_ITEMS[key];
    const fmt = (item && item.fmt) || rg._fmt || ((v) => String(v));
    const decimals = (String(step).split('.')[1] || '').length;
    const quant = (v) => Number(clamp(Math.round((v - min) / step) * step + min, min, max).toFixed(decimals));
    const setVal = (v, fire = true) => {
      const q = quant(v);
      const t = (q - min) / (max - min);
      track.style.setProperty('--t', t);
      track.setAttribute('aria-valuenow', q);
      track.setAttribute('aria-valuetext', fmt(q));
      const out = rg.closest('.field')?.querySelector('.field-val');
      if (out) out.textContent = fmt(q);
      if (fire && q !== rg._v) emit(key, q);
      rg._v = q;
    };
    rg._v = Number(track.getAttribute('aria-valuenow'));
    rg._set = setVal;
    const fromX = (x) => {
      const r = track.getBoundingClientRect();
      setVal(min + clamp((x - r.left) / r.width, 0, 1) * (max - min));
    };
    let drag = false;
    track.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = true;
      try { track.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      fromX(e.clientX);
    });
    track.addEventListener('pointermove', (e) => { if (drag) fromX(e.clientX); });
    track.addEventListener('pointerup', () => { drag = false; });
    track.addEventListener('pointercancel', () => { drag = false; });
    track.addEventListener('click', (e) => { if (e.vpDwell) fromX(e.clientX); });
    track.addEventListener('keydown', (e) => {
      const big = (max - min) / 10;
      const map = { ArrowLeft: -step, ArrowRight: step, PageDown: -big, PageUp: big };
      if (map[e.key] != null) setVal(rg._v + map[e.key]);
      else if (e.key === 'Home') setVal(min);
      else if (e.key === 'End') setVal(max);
      else return;
      e.preventDefault();
    });
    rg.querySelectorAll('.range-step').forEach((b) => b.addEventListener('click', () => setVal(rg._v + Number(b.dataset.delta) * step)));
  }

  function changeSetting(key, value) {
    const patch = patchFor(state.settings, key, value);
    state.settings = applyPatch(state.settings, patch);
    call('onSettings', patch);
    if (key === 'pip' || key === 'skeleton') syncPip();
  }

  // ---- Loading ----------------------------------------------------------------
  function renderLoading() {
    const el = document.createElement('section');
    el.innerHTML = `
      <div class="load-center">
        <div class="wordmark wordmark-md" aria-label="Víbora Padel">VÍBORA<span class="wm-sub">PADEL · TRAINING</span></div>
        <div class="load-bar" role="progressbar" aria-label="Loading" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="load-fill"></span><span class="load-ball"></span></div>
        <p class="load-text"></p>
      </div>
      <p class="load-foot">Best on a TV · Mac + camera at chest height, 2.5 m away</p>`;
    return { el, mount: () => applyLoading() };
  }

  function applyLoading() {
    const bar = $('.load-bar', layerScreen);
    if (!bar) return;
    const p = clamp(state.loading.p || 0, 0, 1);
    bar.style.setProperty('--p', p);
    bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    $('.load-text', layerScreen).textContent = state.loading.text || '';
  }

  function setLoading(p, text) {
    state.loading = { p, text: text ?? state.loading.text };
    if (state.screen !== 'loading') show('loading');
    else applyLoading();
  }

  // ---- Title --------------------------------------------------------------------
  // The hand cursor needs a running camera; until a person is tracked the title only offers
  // the keyboard / mouse (QA: "raise a hand" did nothing when no camera was open yet).
  function titleCtaHtml() {
    return state.titleHand
      ? '<strong>Raise a hand or press Enter</strong><span class="es">Levanta la mano o pulsa Enter</span>'
      : '<strong>Press Enter or click Start</strong><span class="es">Pulsa Enter o haz clic en Empezar</span>';
  }

  /** true once the camera tracks a person (the hand cursor works on the title). */
  function setTitleHandHint(on) {
    if (state.titleHand === !!on) return;
    state.titleHand = !!on;
    const el = layerScreen.querySelector('.title-cta-text');
    if (el) el.innerHTML = titleCtaHtml();
    layerScreen.querySelectorAll('.raise-hint').forEach((r) => { r.hidden = !state.titleHand; });
  }

  // ---- Install as an app (PWA; state from src/app/pwa.js via setInstall) ------------------
  function installTitleHtml() {
    switch (state.install.kind) {
      case 'prompt':
        return `<button type="button" class="btn btn-install" data-action="install" data-focus-key="install">${ICON.install}<span>Install Víbora<span class="es">Instalar la app</span></span></button><p class="install-note">Its own window and Dock icon · works offline</p>`;
      case 'safari':
        return `<p class="install-note">${ICON.install}<span>Make it an app: <b>File → Add to Dock</b><span class="es">Archivo → Añadir al Dock</span></span></p>`;
      default:
        return '';
    }
  }

  function installHelpHtml() {
    const k = state.install.kind;
    const chrome = 'In <b>Chrome</b>: the install icon at the right of the address bar, or <b>⋮ → Cast, save and share → Install page as app</b>.';
    const safari = 'In <b>Safari</b> (macOS Sonoma or later): <b>File → Add to Dock</b>.';
    let body;
    if (k === 'installed') body = '<p>You are running the Víbora app. Press <b>F</b> for full screen (hold <b>Esc</b> to leave it).</p>';
    else if (k === 'done') body = '<p>Installed. Open <b>Víbora</b> from the Dock or Launchpad.</p>';
    else if (k === 'prompt') body = `<div class="hi-row"><button type="button" class="btn btn-install" data-action="install" data-focus-key="install-help">${ICON.install}<span>Install Víbora<span class="es">Instalar la app</span></span></button><p>Its own window and Dock icon, no browser bars.</p></div>`;
    else if (k === 'safari') body = `<p>${safari}</p>`;
    else if (k === 'chrome') body = `<p>${chrome}</p>`;
    else body = `<p>${chrome}</p><p>${safari}</p>`;
    return `<h3 class="skill-head">Use it like an app<span class="es">Como una app</span></h3>${body}<p class="muted">Works offline after the first visit.</p>`;
  }

  function syncInstall() {
    layerScreen.querySelectorAll('[data-install-slot]').forEach((el) => {
      const html = el.dataset.installSlot === 'help' ? installHelpHtml() : installTitleHtml();
      const hadFocus = el.contains(document.activeElement);
      el.innerHTML = html;
      el.hidden = !html;
      if (hadFocus) focusEl(defaultFocus());
    });
  }

  /** info: { kind: 'installed'|'prompt'|'done'|'safari'|'chrome'|'none', onInstall } */
  function setInstall(info = {}) {
    state.install = { kind: info.kind || 'none', onInstall: info.onInstall || null };
    syncInstall();
  }

  /** A new version is waiting: a small "Update ready — Restart" notice (hidden during play). */
  function updateReady(onRestart) {
    const el = root.querySelector('.vp-update');
    if (!el) return;
    el.hidden = false;
    const b = el.querySelector('[data-update-restart]');
    b.onclick = () => {
      b.disabled = true;
      b.textContent = 'Restarting…';
      if (onRestart) onRestart();
    };
  }

  function renderTitle(data) {
    const el = document.createElement('section');
    el.innerHTML = `
      <div class="title-brand">
        <p class="eyebrow">Padel training · Entrenamiento de pádel</p>
        <h1 class="wordmark wordmark-xl" aria-label="Víbora">VÍBORA</h1>
        <div class="title-line" aria-hidden="true"><span></span></div>
        <p class="title-tag">First-person court. Your arms, your racket, real glass.<span class="es">Tu cuerpo es el mando.</span></p>
      </div>
      <div class="title-cta">
        <div class="raise-hint" aria-hidden="true"${state.titleHand ? '' : ' hidden'}><span class="raise-ring">${ICON.hand}</span></div>
        <div class="title-cta-text">${titleCtaHtml()}</div>
        <div class="btn-row">
          <button type="button" class="btn go btn-lg" data-action="start" data-autofocus data-focus-key="start">Start<span class="es">Empezar</span></button>
          <button type="button" class="btn" data-action="fallback" data-focus-key="fallback">Play with mouse</button>
          <button type="button" class="btn" data-action="help" data-focus-key="help">Setup help</button>
        </div>
      </div>
      <div class="title-install" data-install-slot="title"${installTitleHtml() ? '' : ' hidden'}>${installTitleHtml()}</div>
      ${data && data.version ? `<p class="title-version">${esc(data.version)}</p>` : ''}`;
    return { el };
  }

  // ---- Camera -------------------------------------------------------------------
  function cameraIcon(kind) {
    return kind === 'continuity' ? ICON.phone : kind === 'builtin' ? ICON.laptop : ICON.webcam;
  }

  function cameraListHtml(cam) {
    const list = cam.cameras || [];
    if (cam.error) {
      // Integration: human-readable camera errors (tracking/camera.js describeCameraError).
      const e = cam.error;
      return `<div class="cam-error" role="alert"><p class="ce-title">${esc(e.title || 'Camera problem')}</p><p class="ce-msg">${esc(e.message || '')}</p>${(e.help || []).length ? `<ol class="ce-help">${e.help.map((h) => `<li>${esc(h)}</li>`).join('')}</ol>` : ''}<button type="button" class="btn" data-action="camera-retry" data-focus-key="cam-retry">Refresh cameras<span class="es">Buscar de nuevo</span></button></div>`;
    }
    if (!list.length) {
      return `<p class="muted cam-empty">${esc(cam.status || 'Looking for cameras… allow camera access in the browser prompt.')}</p>`;
    }
    return list.map((c, i) => {
      const sel = c.deviceId === cam.selectedId || (!cam.selectedId && i === 0);
      const kind = c.kind || 'unknown';
      const sub = kind === 'continuity' ? 'Continuity Camera' : kind === 'builtin' ? 'Built-in' : kind === 'usb' ? 'USB' : 'Camera';
      return `<button type="button" class="cam-item" role="radio" aria-checked="${sel}" data-action="select-camera" data-device="${esc(c.deviceId)}" data-focus-key="cam-${i}">
        <span class="cam-ico">${cameraIcon(kind)}</span><span class="cam-name">${esc(c.label || `Camera ${i + 1}`)}<small>${esc(sub)}</small></span>${sel ? `<span class="cam-check">${ICON.check}</span>` : ''}</button>`;
    }).join('');
  }

  function refreshCameraList() {
    const box = $('.cam-list', layerScreen);
    if (box) box.innerHTML = cameraListHtml(state.data.camera || {});
    const seg = $('[data-seg="cameraPreset"]', layerScreen);
    const preset = (state.data.camera || {}).presetKey;
    if (seg && preset) seg.querySelectorAll('[role="radio"]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === preset)));
  }

  function renderCamera(cam) {
    const presets = Object.entries(TRACKING.cameraPresets);
    const preset = cam.presetKey || state.settings.cameraPreset || TRACKING.defaultCamera;
    const el = document.createElement('section');
    el.innerHTML = `
      <header class="screen-head">
        <button type="button" class="btn btn-ghost btn-back" data-action="back" aria-label="Back">${ICON.back}<span>Back</span></button>
        <div><p class="eyebrow">Step 1 of 2 · Paso 1</p><h2 class="h-display">Camera<span class="es">Cámara</span></h2></div>
      </header>
      <div class="cam-grid">
        <div class="preview-wrap panel">
          <canvas class="preview" data-preview aria-label="Live camera preview"></canvas>
          <div class="frame-guide" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
          <p class="preview-cap">Live preview · mirrored</p>
        </div>
        <div class="cam-side">
          <p class="eyebrow">Choose camera · Elige cámara</p>
          <div class="cam-list" role="radiogroup" aria-label="Cameras">${cameraListHtml(cam)}</div>
          <p class="eyebrow">Lens preset · Objetivo</p>
          <div class="preset-list">${segHtml('cameraPreset', presets.map(([k, p]) => [k, PRESET_SHORT[k] || p.label, `${p.hfov}°`]), preset, { label: 'Lens preset' })}</div>
          <aside class="tip">
            <p class="tip-head">Continuity Camera tip</p>
            <p>Mount your iPhone on top of the TV, landscape, rear camera facing you. In Control Centre turn <b>Center Stage off</b> so the framing stays fixed.</p>
          </aside>
          <div class="btn-row">
            <button type="button" class="btn go btn-lg" data-action="to-calibrate" data-autofocus data-focus-key="continue">Continue<span class="es">Seguir</span></button>
            <button type="button" class="btn" data-action="fallback" data-focus-key="fallback">Use mouse instead</button>
          </div>
        </div>
      </div>`;
    return {
      el,
      onControl: (key, value) => {
        if (key === 'cameraPreset') {
          const c = state.data.camera || {};
          state.data.camera = { ...c, presetKey: value };
          state.settings.cameraPreset = value;
          call('onCameraSelect', c.selectedId || (c.cameras && c.cameras[0] && c.cameras[0].deviceId) || null, value);
        }
      },
    };
  }

  // ---- Calibrate ----------------------------------------------------------------
  function newCalib(step = 'body') {
    return {
      step, auto: true, okSince: null, spot: 0, spotDone: false, spotDoneAt: 0,
      lat: { phase: 'idle', start: 0, flashes: [], swings: [], result: null, message: '' },
      area: { left: 0, right: 0, fwd: 0, back: 0 },
    };
  }

  function renderCalibrate(data) {
    if (!state.calib || data.step || data.reset) state.calib = newCalib(data.step || 'body');
    if (data.autoAdvance !== undefined) state.calib.auto = data.autoAdvance !== false;
    const el = document.createElement('section');
    const stepIdx = CAL_STEPS.findIndex((s) => s.id === state.calib.step);
    el.innerHTML = `
      <header class="screen-head">
        <button type="button" class="btn btn-ghost btn-back" data-action="cal-back" aria-label="Back">${ICON.back}<span>Back</span></button>
        <div><p class="eyebrow">Step 2 of 2 · Calibración</p><h2 class="h-display">Calibrate<span class="es">Calibrar</span></h2></div>
        <ol class="stepper" aria-label="Calibration steps">${CAL_STEPS.map((s, i) => `<li class="${i < stepIdx ? 'done' : i === stepIdx ? 'current' : ''}"${i === stepIdx ? ' aria-current="step"' : ''}><b>${i + 1}</b><span>${esc(s.en)}${s.optional ? ` <em data-k="${s.id}-tag">${esc(optTag(s.id))}</em>` : ''}<small>${esc(s.es)}</small></span></li>`).join('')}</ol>
      </header>
      <div class="cal-grid">
        <div class="preview-wrap panel">
          <canvas class="preview" data-preview aria-label="Camera with body tracking"></canvas>
          <div class="frame-guide" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
          <div class="lat-flash" aria-hidden="true"></div>
          <p class="preview-cap"><span class="track-dot"></span><span class="track-text">Tracking</span></p>
        </div>
        <div class="cal-panel">${calPanelHtml(state.calib.step)}</div>
      </div>`;
    return {
      el,
      mount: () => calUpdate(),
      onControl: (key, value) => {
        changeSetting(key, value);
      },
    };
  }

  function calPanelHtml(step) {
    const s = state.settings;
    switch (step) {
      case 'body': return `
        <h3 class="cal-title">Step into frame<span class="es">Entra en el encuadre</span></h3>
        <p class="cal-lead">Stand 2.2–3.5 m from the TV so the camera sees you from head to ankles.</p>
        <div class="parts" role="list">${BODY_PARTS.map(([id, en, es]) => `<span class="part" role="listitem" data-part="${id}"><i>${ICON.check}</i>${en}<small>${es}</small></span>`).join('')}</div>
        <div class="meter-row"><span class="meter-label">Body in frame<span class="es">Cuerpo visible</span></span><span class="meter-val" data-k="bif">—</span></div>
        <div class="bar-meter" data-k="bif-bar"><i></i></div>
        <div class="meter-row"><span class="meter-label">Distance to camera<span class="es">Distancia</span></span><span class="meter-val" data-k="dist">—</span></div>
        <div class="dist-meter" aria-hidden="true">
          <span class="dm-ideal" style="left:${distPos(DIST_IDEAL[0]) * 100}%;width:${(distPos(DIST_IDEAL[1]) - distPos(DIST_IDEAL[0])) * 100}%"></span>
          <span class="dm-mark" data-k="dist-mark"></span>
          ${[1.5, 2.2, 3.5, 4.5].map((v) => `<span class="dm-tick" style="left:${distPos(v) * 100}%">${v.toFixed(1)}</span>`).join('')}
        </div>
        <p class="cal-msg" data-k="msg" aria-live="polite"></p>
        <div class="btn-row"><button type="button" class="btn btn-lg" data-action="cal-next" data-k="next" data-autofocus data-focus-key="cal-next">Continue<span class="es">Seguir</span></button></div>`;
      case 'spot': return `
        <h3 class="cal-title">Stand on your spot<span class="es">Ponte en tu sitio</span></h3>
        <p class="cal-lead">Feet shoulder-width apart, ready position, stay still for two seconds. This becomes your home position on court.</p>
        <div class="countdown" aria-live="polite"><svg viewBox="0 0 120 120" aria-hidden="true"><circle class="bg" cx="60" cy="60" r="52"/><circle class="fg" cx="60" cy="60" r="52"/></svg><b data-k="count">2.0</b><span>seconds · segundos</span></div>
        <div class="checks"><span class="chk" data-k="chk-frame"><i>${ICON.check}</i>In frame</span><span class="chk" data-k="chk-still"><i>${ICON.check}</i>Still · quieto</span></div>
        <p class="cal-msg" data-k="msg" aria-live="polite"></p>`;
      case 'profile': return `
        <h3 class="cal-title">About you<span class="es">Sobre ti</span></h3>
        <p class="cal-lead">Your racket hand and height set the eye height, reach and which side is your forehand.</p>
        ${fieldHtml('Racket hand', 'Mano de la pala', segHtml('handed', [['right', 'Right', 'Diestro'], ['left', 'Left', 'Zurdo']], s.handed, { label: 'Racket hand' }))}
        ${fieldHtml('Height', 'Altura', rangeHtml('height', { min: 1.4, max: 2.1, step: 0.01, value: s.height, label: 'Height', fmt: SETTING_ITEMS.height.fmt }), { valueId: 'height', value: SETTING_ITEMS.height.fmt(s.height) })}
        <div class="btn-row"><button type="button" class="btn go btn-lg" data-action="cal-next" data-autofocus data-focus-key="cal-next">Continue<span class="es">Seguir</span></button></div>`;
      case 'latency': return `
        <h3 class="cal-title">Latency test <em class="opt" data-k="latency-tag">${esc(optTag('latency'))}</em><span class="es">Prueba de latencia</span></h3>
        <p class="cal-lead cal-why" data-k="lat-why"${needsLatencyTest() ? '' : ' hidden'}><b>Your browser doesn't report camera timestamps (Safari) – run the latency test.</b><span class="es">Tu navegador no da la hora de captura: haz la prueba de latencia.</span></p>
        <p class="cal-lead">Six flashes on a steady beat. Swing your racket hand <b>down</b> exactly on each flash. We measure how late the camera sees it.</p>
        <div class="lat-dots" role="list" aria-label="Flashes">${Array.from({ length: LAT_FLASHES }, (_, i) => `<span role="listitem" data-flash="${i}"></span>`).join('')}</div>
        <div class="lat-readout"><span class="meter-label">Measured · medido</span><b data-k="lat">${Math.round(s.latency * 1000)}<small>ms now</small></b></div>
        <p class="cal-msg" data-k="msg" aria-live="polite"></p>
        <div class="btn-row" data-k="lat-btns"></div>`;
      case 'area': return `
        <h3 class="cal-title">Check your play area<span class="es">Comprueba tu zona</span></h3>
        <p class="cal-lead">Take one step left, right, toward the TV and back. On court each step is amplified ×${s.gainLateral.toFixed(1)} sideways and ×${s.gainDepth.toFixed(1)} forward.</p>
        <div class="area-wrap">
          <div class="area-mat" aria-hidden="true">
            <span class="am-target" data-dir="fwd">TV</span><span class="am-target" data-dir="left">L</span><span class="am-target" data-dir="right">R</span><span class="am-target" data-dir="back">Back</span>
            <span class="am-home"></span><span class="am-dot" data-k="area-dot"></span>
          </div>
          <dl class="area-read">
            <dt>Side · lateral</dt><dd data-k="ax">—</dd>
            <dt>Depth · profundidad</dt><dd data-k="ad">—</dd>
            <dt>Court side · pista</dt><dd data-k="acx">—</dd>
            <dt>Court depth · pista</dt><dd data-k="acz">—</dd>
          </dl>
        </div>
        <div class="btn-row"><button type="button" class="btn btn-lg" data-action="cal-done" data-k="done" data-autofocus data-focus-key="cal-done">Done<span class="es">Listo</span></button></div>`;
      default: return '';
    }
  }

  const distPos = (d) => clamp((d - DIST_SCALE[0]) / (DIST_SCALE[1] - DIST_SCALE[0]), 0, 1);

  function calSetStep(step) {
    state.calib.step = step;
    state.calib.okSince = null;
    if (step === 'spot') { state.calib.spot = 0; state.calib.spotDone = false; }
    if (step === 'latency') state.calib.lat = { phase: 'idle', start: 0, flashes: [], swings: [], result: null, message: '' };
    if (step === 'area') state.calib.area = { left: 0, right: 0, fwd: 0, back: 0 };
    show('calibrate', { step: undefined });
    call('onScreen', 'calibrate', { step });
  }

  function calAdvance() {
    const i = CAL_STEPS.findIndex((s) => s.id === state.calib.step);
    if (i < 0 || i >= CAL_STEPS.length - 1) calFinish();
    else calSetStep(CAL_STEPS[i + 1].id);
  }

  function calBack() {
    const i = CAL_STEPS.findIndex((s) => s.id === state.calib.step);
    if (i <= 0) goto(state.returnTo.calibrate === 'pause' ? 'pause' : 'camera');
    else calSetStep(CAL_STEPS[i - 1].id);
  }

  function calFinish() {
    const to = state.returnTo.calibrate === 'pause' ? 'pause' : 'hub';
    state.returnTo.calibrate = null;
    goto(to);
  }

  function bodyStatus() {
    const st = state.calStatus || {};
    const bif = Number.isFinite(st.bodyInFrame) ? st.bodyInFrame : null;
    let vis = st.visible;
    if (!vis && bif != null) {
      const n = Math.round(bif * 5);
      vis = Object.fromEntries(BODY_PARTS.map(([id], i) => [id, i < n]));
    }
    const dist = Number.isFinite(st.distance) ? st.distance : null;
    const inFrame = bif != null && bif >= 0.9;
    const distOk = dist != null && dist >= DIST_IDEAL[0] && dist <= DIST_IDEAL[1];
    return { bif, vis: vis || {}, dist, inFrame, distOk, ok: inFrame && distOk, still: st.still !== false, tracking: st.tracking || (bif ? 'ok' : 'searching') };
  }

  /** Live calibration: in-place DOM updates plus the step timers (called every frame while visible). */
  function calUpdate(dt = 0) {
    if (state.screen !== 'calibrate' || !state.calib) return;
    const scope = layerScreen;
    const q = (k) => scope.querySelector(`[data-k="${k}"]`);
    const c = state.calib;
    const b = bodyStatus();
    const now = performance.now();

    const tt = scope.querySelector('.track-text');
    const td = scope.querySelector('.track-dot');
    if (tt) {
      const label = b.tracking === 'lost' ? 'Tracking lost · buscando' : b.bif ? `Tracking · ${Math.round(b.bif * 100)}% visible` : 'Searching for you…';
      if (tt.textContent !== label) tt.textContent = label;
      td.dataset.state = b.ok ? 'ok' : b.bif ? 'warn' : 'off';
    }
    const guide = scope.querySelector('.frame-guide');
    if (guide) guide.classList.toggle('ok', b.ok);

    if (c.step === 'body') {
      for (const [id] of BODY_PARTS) scope.querySelector(`[data-part="${id}"]`)?.classList.toggle('on', !!b.vis[id]);
      const bv = q('bif');
      if (bv) bv.textContent = b.bif == null ? '—' : pct(b.bif);
      q('bif-bar')?.style.setProperty('--p', b.bif ?? 0);
      q('bif-bar')?.classList.toggle('ok', b.inFrame);
      const dv = q('dist');
      if (dv) dv.textContent = b.dist == null ? '—' : `${b.dist.toFixed(1)} m`;
      const mk = q('dist-mark');
      if (mk) {
        mk.style.left = `${distPos(b.dist ?? DIST_SCALE[0]) * 100}%`;
        mk.hidden = b.dist == null;
        mk.classList.toggle('ok', b.distOk);
      }
      let msg = 'Waiting for the camera to find you…';
      if (b.bif != null && !b.inFrame) {
        const miss = BODY_PARTS.filter(([id]) => !b.vis[id]).map(([, en]) => en.toLowerCase());
        msg = miss.length ? `Can't see your ${miss.join(', ')}. ${miss.includes('ankles') || miss.includes('knees') ? 'Step back or tilt the camera down.' : 'Step back a little.'}` : 'Hold still…';
      } else if (b.dist != null && b.dist < DIST_IDEAL[0]) msg = `Step back about ${Math.round((DIST_IDEAL[0] + 0.3 - b.dist) * 100)} cm · un paso atrás`;
      else if (b.dist != null && b.dist > DIST_IDEAL[1]) msg = `Come closer about ${Math.round((b.dist - DIST_IDEAL[1] + 0.3) * 100)} cm · acércate`;
      else if (b.ok) msg = 'Perfect. Hold it there… · ¡Perfecto!';
      setText(q('msg'), msg);
      q('msg')?.classList.toggle('ok', b.ok);
      const nb = q('next');
      if (nb) nb.classList.toggle('go', b.ok);
      if (b.ok) {
        if (c.okSince == null) c.okSince = now;
        if (c.auto && now - c.okSince > 1500) calAdvance();
      } else c.okSince = null;
    } else if (c.step === 'spot') {
      const ok = b.bif != null ? b.bif >= 0.8 && b.still : false;
      if (!c.spotDone) {
        c.spot = ok ? c.spot + dt : Math.max(0, c.spot - dt * 2);
        if (c.spot >= SPOT_HOLD_S) {
          c.spotDone = true;
          c.spotDoneAt = now;
          call('onCalibrate');
        }
      } else if (now - c.spotDoneAt > 800) {
        calAdvance();
        return;
      }
      const left = Math.max(0, SPOT_HOLD_S - c.spot);
      setText(q('count'), c.spotDone ? '✓' : left.toFixed(1));
      const fg = scope.querySelector('.countdown .fg');
      if (fg) fg.style.strokeDashoffset = String(2 * Math.PI * 52 * (1 - clamp(c.spot / SPOT_HOLD_S, 0, 1)));
      scope.querySelector('.countdown')?.classList.toggle('done', c.spotDone);
      q('chk-frame')?.classList.toggle('on', b.bif != null && b.bif >= 0.8);
      q('chk-still')?.classList.toggle('on', b.bif != null && b.still);
      setText(q('msg'), c.spotDone ? 'Home position saved · guardado' : !b.bif ? 'Waiting for the camera to find you…' : !b.still ? 'Keep still for a moment' : 'Hold still… · quieto');
      q('msg')?.classList.toggle('ok', c.spotDone || (ok && c.spot > 0));
    } else if (c.step === 'latency') {
      latTick(now);
    } else if (c.step === 'area') {
      const off = state.calStatus.offset;
      const a = c.area;
      const dot = q('area-dot');
      if (off && Number.isFinite(off.x) && Number.isFinite(off.d)) {
        a.left = Math.max(a.left, -off.x);
        a.right = Math.max(a.right, off.x);
        a.fwd = Math.max(a.fwd, -off.d);
        a.back = Math.max(a.back, off.d);
        if (dot) {
          dot.hidden = false;
          dot.style.left = `${50 + clamp(off.x / 0.6, -1, 1) * 42}%`;
          dot.style.top = `${50 + clamp(off.d / 0.6, -1, 1) * 42}%`;
        }
        const s = state.settings;
        const sgn = (v, d) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)} m`;
        setText(q('ax'), sgn(off.x, 2));
        setText(q('ad'), sgn(off.d, 2));
        setText(q('acx'), sgn(off.x * s.gainLateral, 1));
        setText(q('acz'), sgn(off.d * s.gainDepth, 1));
      } else if (dot) dot.hidden = true;
      let all = true;
      for (const dir of ['left', 'right', 'fwd', 'back']) {
        const hit = a[dir] >= AREA_STEP_M;
        all = all && hit;
        scope.querySelector(`.am-target[data-dir="${dir}"]`)?.classList.toggle('on', hit);
      }
      q('done')?.classList.toggle('go', all);
    }
  }

  function setText(el, t) {
    if (el && el.textContent !== t) el.textContent = t;
  }

  function latStart() {
    const L = state.calib.lat;
    L.phase = 'run';
    L.start = performance.now() + 400;
    L.flashes = [];
    L.swings = [];
    L.result = null;
    L.message = '';
    layerScreen.querySelectorAll('[data-flash]').forEach((d) => { d.className = ''; });
    latButtons();
  }

  function latButtons() {
    const box = layerScreen.querySelector('[data-k="lat-btns"]');
    if (!box) return;
    const L = state.calib.lat;
    let html;
    if (L.phase === 'run') html = '<button type="button" class="btn" data-action="cal-skip" data-focus-key="lat-skip">Skip<span class="es">Saltar</span></button>';
    else if (L.phase === 'done' && L.result != null) html = `<button type="button" class="btn go btn-lg" data-action="lat-accept" data-autofocus data-focus-key="lat-accept">Use ${L.result} ms</button><button type="button" class="btn" data-action="lat-start" data-focus-key="lat-start">Retry</button><button type="button" class="btn" data-action="cal-skip" data-focus-key="lat-skip">Skip</button>`;
    else html = `<button type="button" class="btn go btn-lg" data-action="lat-start" data-autofocus data-focus-key="lat-start">${L.phase === 'done' ? 'Try again' : 'Start test'}<span class="es">Empezar</span></button><button type="button" class="btn" data-action="cal-skip" data-focus-key="lat-skip">Skip<span class="es">Saltar</span></button>`;
    box.innerHTML = html;
    const f = box.querySelector('[data-autofocus]') || box.querySelector('button');
    if (f && root.dataset.input === 'keys') f.focus({ preventScroll: true });
  }

  function latTick(now) {
    const L = state.calib.lat;
    const scope = layerScreen;
    const flashEl = scope.querySelector('.lat-flash');
    const msg = scope.querySelector('[data-k="msg"]');
    if (!scope.querySelector('[data-k="lat-btns"]').childElementCount) latButtons();
    if (L.phase !== 'run') {
      if (flashEl) flashEl.classList.remove('on');
      setText(msg, L.message || 'Stand on your spot, racket hand up and ready.');
      msg?.classList.toggle('ok', L.result != null);
      return;
    }
    const tRel = now - L.start;
    const beat = Math.floor(tRel / LAT_BEAT_MS);
    const inBeat = tRel - beat * LAT_BEAT_MS;
    if (tRel < 0) {
      setText(msg, 'Get ready…');
    } else if (beat < LAT_LEAD_BEATS) {
      setText(msg, `On the beat… ${LAT_LEAD_BEATS - beat}`);
      if (flashEl) {
        flashEl.dataset.count = String(LAT_LEAD_BEATS - beat);
        flashEl.classList.toggle('tick', inBeat < 160);
      }
    } else {
      const i = beat - LAT_LEAD_BEATS;
      if (flashEl) flashEl.dataset.count = '';
      if (i < LAT_FLASHES) {
        const on = inBeat < LAT_FLASH_MS;
        if (flashEl) flashEl.classList.toggle('on', on);
        // A long frame can skip a whole flash: fall back to its scheduled time.
        while (L.flashes.length < i) {
          const k = L.flashes.length;
          L.flashes.push(L.start + (LAT_LEAD_BEATS + k) * LAT_BEAT_MS);
          scope.querySelector(`[data-flash="${k}"]`)?.classList.add('shown');
        }
        if (on && L.flashes.length === i) {
          L.flashes.push(now);
          scope.querySelector(`[data-flash="${i}"]`)?.classList.add('shown');
        }
        setText(msg, `Swing down! ${i + 1} / ${LAT_FLASHES}`);
      } else if (tRel > (LAT_LEAD_BEATS + LAT_FLASHES) * LAT_BEAT_MS + 600) {
        if (flashEl) flashEl.classList.remove('on');
        latFinish();
      }
    }
    // Mark matched swings on the dots.
    L.flashes.forEach((ft, i) => {
      const hit = L.swings.some((s) => Math.abs(s - ft) < 550);
      scope.querySelector(`[data-flash="${i}"]`)?.classList.toggle('hit', hit);
    });
  }

  function latFinish() {
    const L = state.calib.lat;
    const offs = [];
    for (const ft of L.flashes) {
      let best = null;
      for (const s of L.swings) if (Math.abs(s - ft) < 550 && (best == null || Math.abs(s - ft) < Math.abs(best - ft))) best = s;
      if (best != null) offs.push(best - ft);
    }
    L.phase = 'done';
    if (offs.length >= 3) {
      offs.sort((a, b) => a - b);
      const med = offs[Math.floor(offs.length / 2)];
      L.result = Math.round(clamp(med, 0, 300));
      L.message = `${offs.length} of ${LAT_FLASHES} swings matched · spread ${Math.round(offs[offs.length - 1] - offs[0])} ms`;
      const out = layerScreen.querySelector('[data-k="lat"]');
      if (out) out.innerHTML = `${L.result}<small>ms</small>`;
    } else {
      L.result = null;
      L.message = `Only ${offs.length} swing${offs.length === 1 ? '' : 's'} seen. Swing a bit bigger, or skip.`;
    }
    latButtons();
  }

  function latAccept() {
    const L = state.calib.lat;
    if (L.result != null) changeSetting('latency', L.result / 1000);
    calAdvance();
  }

  /** The latency step is recommended (not optional) when the browser gives no capture timestamps. */
  function needsLatencyTest() {
    return !!state.calStatus.needsLatencyTest;
  }
  function optTag(id) {
    return id === 'latency' && needsLatencyTest() ? 'recommended' : 'optional';
  }

  function calibration(status = {}) {
    const st = { ...state.calStatus, ...status };
    if (status.swingAt != null && state.calib && state.calib.lat.phase === 'run') state.calib.lat.swings.push(status.swingAt);
    delete st.swingAt;
    const latChanged = status.needsLatencyTest !== undefined && !!status.needsLatencyTest !== !!state.calStatus.needsLatencyTest;
    state.calStatus = st;
    if (latChanged && state.screen === 'calibrate') {
      layerScreen.querySelectorAll('[data-k="latency-tag"]').forEach((e) => { e.textContent = optTag('latency'); });
      const why = layerScreen.querySelector('[data-k="lat-why"]');
      if (why) why.hidden = !needsLatencyTest();
    }
    if (status.step && state.screen === 'calibrate' && status.step !== state.calib.step) calSetStep(status.step);
  }

  // ---- Hub ------------------------------------------------------------------------
  function renderHub(data) {
    const drills = data.drills || [];
    const bests = data.bests || {};
    const s = state.settings;
    const el = document.createElement('section');
    const groups = SKILLS.map((sk) => ({ ...sk, drills: drills.filter((d) => d.skill === sk.id) })).filter((g) => g.drills.length);
    const other = drills.filter((d) => !SKILLS.some((sk) => sk.id === d.skill));
    if (other.length) groups.push({ id: 'Other', en: 'More', es: 'Más', drills: other });
    const card = (d) => {
      const b = bests[d.id] || null;
      return `<button type="button" class="drill-card" data-action="drill" data-drill="${esc(d.id)}" data-focus-key="drill-${esc(d.id)}">
        <canvas class="dc-diagram" data-diagram="${esc(d.id)}" aria-hidden="true"></canvas>
        <span class="dc-body">
          <span class="dc-name">${esc(d.name)}</span>
          <span class="dc-es">${esc(d.es && d.es !== d.name ? d.es : ' ')}</span>
          <span class="dc-meta">${levelHtml(d.level)}${b ? starsHtml(b.stars || 0) : '<span class="dc-new">New</span>'}</span>
          ${b ? `<span class="dc-best">Best <b>${fmtInt(b.points)}</b></span>` : ''}
        </span>
      </button>`;
    };
    el.innerHTML = `
      <header class="hub-head">
        <div class="wordmark wordmark-sm" aria-label="Víbora Padel">VÍBORA<span class="wm-sub">PADEL</span></div>
        <p class="hub-profile">${esc(s.handed === 'left' ? 'Left-handed · zurdo' : 'Right-handed · diestro')}<i></i>${s.height.toFixed(2)} m<i></i>Assist ${esc((ASSIST[s.assist] || {}).label || s.assist)}${data.player ? `<i></i>${esc(data.player)}` : ''}</p>
        <nav class="hub-nav" aria-label="Menu">
          <button type="button" class="btn btn-ghost" data-action="recalibrate" data-focus-key="recal">Recalibrate</button>
          <button type="button" class="btn btn-ghost" data-action="settings" data-focus-key="settings">Settings</button>
          <button type="button" class="btn btn-ghost" data-action="help" data-focus-key="help">Help</button>
        </nav>
      </header>
      <div class="hub-play">
        <button type="button" class="play-tile" data-action="rally" data-focus-key="rally" data-autofocus>
          <span class="pt-eyebrow">Live ball · Peloteo</span>
          <span class="pt-title">Rally with Coach</span>
          <span class="pt-desc">Open rally against an AI coach who mixes drives, lobs and balls off the glass.</span>
          <svg class="pt-court" viewBox="0 0 200 100" aria-hidden="true"><rect x="2" y="2" width="196" height="96"/><path d="M100 0v100" class="net"/><path d="M30.5 2v96M169.5 2v96M30.5 50h139"/><circle cx="148" cy="34" r="3.2" class="ball"/></svg>
        </button>
        <button type="button" class="play-tile" data-action="match" data-focus-key="match">
          <span class="pt-eyebrow">2 vs 2 · Partido</span>
          <span class="pt-title">Match</span>
          <span class="pt-desc">AI partner and two opponents. Golden point, real serves, one set.</span>
          <span class="pt-score" aria-hidden="true"><b>40</b><i>·</i><b>40</b></span>
        </button>
        <div class="level-pick">
          <p class="eyebrow">Opponent level · Nivel</p>
          ${segHtml('hubLevel', [['rookie', 'Rookie', 'Iniciación'], ['club', 'Club', 'Club'], ['pro', 'Pro', 'Pro']], state.hubLevel, { label: 'Opponent level' })}
        </div>
      </div>
      <div class="hub-drills" style="--cols:${groups.length}">
        ${groups.map((g) => `<section class="skill-col" aria-label="${esc(g.en)}">
          <h3 class="skill-head">${esc(g.en)}<span class="es">${esc(g.es)}</span></h3>
          ${g.drills.map(card).join('')}
        </section>`).join('')}
      </div>`;
    return {
      el,
      mount: () => {
        el.querySelectorAll('[data-diagram]').forEach((cv) => {
          const d = drills.find((x) => x.id === cv.dataset.diagram);
          if (d) courtDiagram(cv, { view: 'far', targets: d.targets || [], compact: true });
        });
      },
      redraw: () => {
        el.querySelectorAll('[data-diagram]').forEach((cv) => {
          const d = drills.find((x) => x.id === cv.dataset.diagram);
          if (d) courtDiagram(cv, { view: 'far', targets: d.targets || [], compact: true });
        });
      },
      onControl: (key, value) => {
        if (key === 'hubLevel') state.hubLevel = value;
      },
    };
  }

  // ---- Drill intro ---------------------------------------------------------------
  function sampleFeeds(drill, n = 10) {
    if (Array.isArray(drill.feedPoints)) return drill.feedPoints;
    if (typeof drill.feeds !== 'function') return [];
    const rng = createRng(0xfeed);
    const out = [];
    for (let i = 0; i < n; i++) {
      try {
        const f = drill.feeds(i, rng, { home: drill.home });
        if (f && f.target && Number.isFinite(f.target.x) && Number.isFinite(f.target.z) && f.target.z > 0) out.push(f.target);
      } catch {
        break;
      }
    }
    return out;
  }

  function renderDrillIntro(data) {
    const d = data.drill || {};
    const best = data.best || null;
    const cues = d.cues || {};
    const tips = (cues.tips || []).slice(0, 3);
    const tipsEs = cues.tipsEs || [];
    const el = document.createElement('section');
    const reps = d.reps ? `${d.reps} balls` : '';
    const interval = d.interval ? `every ${d.interval.toFixed(1)} s` : '';
    const sk = SKILLS.find((x) => x.id === d.skill);
    el.innerHTML = `
      <div class="intro-text">
        <button type="button" class="btn btn-ghost btn-back" data-action="hub" aria-label="Back to drills" data-focus-key="back">${ICON.back}<span>Drills</span></button>
        <p class="eyebrow">${esc(sk ? `${sk.en} · ${sk.es}` : d.skill || 'Drill')}</p>
        <h2 class="intro-title">${esc(d.name || '')}</h2>
        ${d.es && d.es !== d.name ? `<p class="intro-es">${esc(d.es)}</p>` : ''}
        <div class="intro-meta">${levelHtml(d.level)}<span>Level ${esc(d.level || 1)}</span>${reps ? `<i></i><span>${esc(reps)}${interval ? ` · ${esc(interval)}` : ''}</span>` : ''}${best ? `<i></i>${starsHtml(best.stars || 0)}<span>Best <b>${fmtInt(best.points)}</b></span>` : ''}</div>
        <p class="intro-lead">${esc(cues.intro || '')}</p>
        ${cues.introEs ? `<p class="intro-lead-es">${esc(cues.introEs)}</p>` : ''}
        ${tips.length ? `<ol class="intro-tips">${tips.map((t, i) => `<li><b>${i + 1}</b><span>${esc(t)}${tipsEs[i] ? `<small>${esc(tipsEs[i])}</small>` : ''}</span></li>`).join('')}</ol>` : ''}
        <div class="intro-go">
          <div class="raise-racket"><span class="rr-ico">${ICON.racket}</span><span><strong>Raise your racket to start</strong><small>Levanta la pala para empezar</small></span></div>
          <div class="btn-row">
            <button type="button" class="btn go btn-lg" data-action="start-drill" data-drill="${esc(d.id || '')}" data-autofocus data-focus-key="start">Start drill<span class="es">Empezar</span></button>
          </div>
        </div>
      </div>
      <figure class="intro-court panel">
        <canvas class="intro-canvas" aria-label="Court diagram: your position, where the feeds land and the target zones"></canvas>
        <figcaption class="legend">
          <span><i class="lg-you"></i>You</span>${d.id === 'serve' ? '' : '<span><i class="lg-machine"></i>Machine</span><span><i class="lg-feed"></i>Feed bounce</span>'}<span><i class="lg-target"></i>Target</span>
        </figcaption>
      </figure>`;
    const draw = () => {
      const cv = el.querySelector('.intro-canvas');
      courtDiagram(cv, {
        view: 'full',
        home: d.home,
        targets: d.targets || [],
        feeds: sampleFeeds(d),
        machine: d.id === 'serve' ? null : { x: 0, z: -9.2 },
        opponents: d.opponentsAtNet ? [{ x: -2.2, z: -3.4 }, { x: 2.2, z: -3.4 }] : [],
      });
    };
    return { el, mount: draw, redraw: draw };
  }

  // ---- Pause -----------------------------------------------------------------------
  function renderPause(data) {
    const el = document.createElement('section');
    const h = state.hud || {};
    el.innerHTML = `
      <div class="pause-panel panel">
        <p class="eyebrow">${esc(data.title || h.title || 'Session')}</p>
        <h2 class="h-display h-xl">Paused<span class="es">Pausa</span></h2>
        <div class="pause-btns">
          <button type="button" class="btn go btn-lg" data-action="resume" data-autofocus data-focus-key="resume">Resume<span class="es">Seguir</span></button>
          <button type="button" class="btn" data-action="restart" data-focus-key="restart">Restart<span class="es">Reiniciar</span></button>
          <button type="button" class="btn" data-action="replay" data-focus-key="replay">Instant replay<span class="es">Repetición</span></button>
          <button type="button" class="btn" data-action="pause-settings" data-focus-key="settings">Settings<span class="es">Ajustes</span></button>
          <button type="button" class="btn" data-action="pause-recal" data-focus-key="recal">Recalibrate<span class="es">Calibrar</span></button>
          <button type="button" class="btn" data-action="quit" data-focus-key="quit">Quit to drills<span class="es">Salir</span></button>
        </div>
        <p class="pause-hint">Both hands above your head for 2 s pauses play (between points) · Esc</p>
      </div>`;
    return { el };
  }

  // ---- Results ---------------------------------------------------------------------
  function renderResults(sum) {
    const el = document.createElement('section');
    const drill = sum.drill || {};
    const stars = clamp(sum.stars || 0, 0, 3);
    const points = sum.points || 0;
    const tips = (sum.tips || []).slice(0, 3);
    const shots = sum.shots || 0;
    const madeTxt = sum.reps ? `${sum.reps.made} / ${sum.reps.total}` : Number.isFinite(sum.successRate) ? pct(sum.successRate) : '—';
    const avgKmh = (() => {
      let n = 0, s = 0;
      for (const v of Object.values(sum.byStroke || {})) if (Number.isFinite(v.avgSpeedKmh)) { s += v.avgSpeedKmh * v.count; n += v.count; }
      return n ? s / n : null;
    })();
    const next = sum.nextDrill || null;
    const stat = (v, en, es) => `<div class="stat"><b>${v}</b><span>${esc(en)}<small>${esc(es)}</small></span></div>`;
    el.innerHTML = `
      <header class="res-head">
        <div>
          <p class="eyebrow">${esc(sum.mode === 'rally' ? 'Rally with Coach · Peloteo' : sum.mode === 'match' ? 'Match · Partido' : 'Drill complete · Ejercicio terminado')}</p>
          <h2 class="h-display h-xl">${esc(sum.title || drill.name || 'Session')}${drill.es && drill.es !== drill.name ? `<span class="es">${esc(drill.es)}</span>` : ''}</h2>
        </div>
        <div class="res-score">
          ${starsHtml(stars, 3, 'stars-xl')}
          <div class="res-points"><b>${fmtInt(points)}</b><span>points · puntos</span></div>
          ${sum.newBest ? '<span class="new-best">New best · récord</span>' : Number.isFinite(sum.best) ? `<span class="prev-best">Best ${fmtInt(sum.best)}</span>` : ''}
        </div>
      </header>
      <div class="res-grid">
        <div class="res-stats">
          ${stat(madeTxt, 'On target', 'Al objetivo')}
          ${stat(fmtInt(shots), 'Shots', 'Golpes')}
          ${stat(fmtInt(sum.longestStreak), 'Best streak', 'Mejor racha')}
          ${stat(avgKmh != null ? fmtInt(avgKmh) : '—', 'Avg km/h', 'Velocidad media')}
          ${stat(Number.isFinite(sum.avgReactionMs) ? `${fmtInt(sum.avgReactionMs)}<small>ms</small>` : '—', 'Reaction', 'Reacción')}
          ${stat(Number.isFinite(sum.kcal) ? fmtInt(sum.kcal) : '—', 'kcal', 'Calorías')}
        </div>
        <figure class="res-map panel">
          <figcaption><span class="eyebrow">Landings · Botes</span><span class="legend"><span><i class="lg-hit"></i>On target</span><span><i class="lg-miss"></i>Missed</span></span></figcaption>
          <canvas class="landing-canvas" aria-label="Landing map of your shots on the far court"></canvas>
        </figure>
        <div class="res-side">
          <div class="res-strokes"><p class="eyebrow">Strokes · Golpes</p><div class="sb" data-strokes></div></div>
          <div class="res-tips"><p class="eyebrow">Coach's notes · Consejos</p><ol>${tips.map((t, i) => `<li><b>${i + 1}</b><span>${esc(typeof t === 'string' ? t : t.text)}${t && t.es ? `<small>${esc(t.es)}</small>` : ''}</span></li>`).join('')}</ol></div>
        </div>
      </div>
      <div class="btn-row res-btns">
        <button type="button" class="btn ${next ? '' : 'go '}btn-lg" data-action="restart" data-focus-key="retry" ${next ? '' : 'data-autofocus'}>Retry<span class="es">Repetir</span></button>
        ${next ? `<button type="button" class="btn go btn-lg" data-action="next-drill" data-drill="${esc(next.id)}" data-autofocus data-focus-key="next">Next: ${esc(next.name)}</button>` : ''}
        <button type="button" class="btn" data-action="replay" data-focus-key="replay">Watch replay</button>
        <button type="button" class="btn" data-action="quit" data-focus-key="hub">All drills<span class="es">Ejercicios</span></button>
      </div>`;
    const draw = () => {
      landingMap(el.querySelector('.landing-canvas'), sum.landings || [], sum.targets || drill.targets || []);
    };
    return {
      el,
      mount: () => {
        strokeBars(el.querySelector('[data-strokes]'), sum.byStroke || {});
        draw();
      },
      redraw: draw,
    };
  }

  function results(summary) {
    show('results', summary);
  }

  // ---- Settings --------------------------------------------------------------------
  function controlFor(it, s) {
    const v = get(s, it.key);
    switch (it.type) {
      case 'seg': return segHtml(it.key, it.options, v, { label: it.en });
      case 'switch': return switchHtml(it.key, v, it.en);
      case 'swatch': return swatchHtml(it.key, it.options, v, it.en);
      case 'range': return rangeHtml(it.key, { min: it.min, max: it.max, step: it.step, value: v, label: it.en, fmt: it.fmt });
      default: return '';
    }
  }

  function renderSettings() {
    const s = state.settings;
    const el = document.createElement('section');
    el.innerHTML = `
      <header class="screen-head">
        <button type="button" class="btn btn-ghost btn-back" data-action="back" aria-label="Back" data-focus-key="back">${ICON.back}<span>Back</span></button>
        <div><p class="eyebrow">Changes apply instantly · Se aplican al momento</p><h2 class="h-display">Settings<span class="es">Ajustes</span></h2></div>
        <div class="head-actions"><button type="button" class="btn" data-action="camera" data-focus-key="camera">Camera</button><button type="button" class="btn" data-action="recalibrate" data-focus-key="recal">Recalibrate</button></div>
      </header>
      <div class="settings-grid">
        ${SETTINGS_GROUPS.map((g) => `<section class="set-group" aria-label="${esc(g.en)}">
          <h3 class="skill-head">${esc(g.en)}<span class="es">${esc(g.es)}</span></h3>
          ${g.items.map((it) => {
            const v = get(s, it.key);
            if (it.type === 'switch') return `<div class="field field-inline"><span class="field-label">${esc(it.en)}<span class="es">${esc(it.es)}</span></span>${controlFor(it, s)}</div>`;
            return fieldHtml(it.en, it.es, controlFor(it, s), it.type === 'range' ? { valueId: it.key, value: it.fmt(v) } : {});
          }).join('')}
        </section>`).join('')}
      </div>`;
    const first = el.querySelector('[data-seg="assist"] [aria-checked="true"]');
    if (first) first.setAttribute('data-autofocus', '');
    return { el };
  }

  /** Re-syncs visible settings controls to state.settings without rebuilding (keeps focus). */
  function syncSettingsControls() {
    const s = state.settings;
    layerScreen.querySelectorAll('[data-seg]').forEach((g) => {
      const v = get(s, g.dataset.seg);
      if (v === undefined) return;
      g.querySelectorAll('[role="radio"]').forEach((b) => b.setAttribute('aria-checked', String(String(b.dataset.value).toLowerCase() === String(v).toLowerCase())));
    });
    layerScreen.querySelectorAll('[data-switch]').forEach((sw) => {
      const v = get(s, sw.dataset.switch);
      if (v !== undefined) setSwitch(sw, !!v);
    });
    layerScreen.querySelectorAll('[data-range]').forEach((rg) => {
      const v = get(s, rg.dataset.range);
      if (Number.isFinite(v) && rg._set) rg._set(v, false);
    });
  }

  function settings(current = {}) {
    state.settings = applyPatch(state.settings, current || {});
    if (state.screen === 'settings' || state.screen === 'calibrate') syncSettingsControls();
    syncPip();
  }

  // ---- Help ----------------------------------------------------------------------
  function renderHelp() {
    const el = document.createElement('section');
    const strokesRead = [
      ['forehand', 'Contact on your racket side after the bounce, waist height.'],
      ['backhand', 'Contact across your body on the other side.'],
      ['volley-fh', 'Any contact before the ball bounces on your side.'],
      ['glass-fh', 'Contact after the ball comes back off your back or side glass.'],
      ['bandeja', 'Above-shoulder contact, controlled, face slightly open.'],
      ['vibora', 'Above-shoulder with strong sideways slice.'],
      ['smash', 'High contact, racket over 60 km/h and steeply down.'],
      ['lob', 'Ball leaves high: apex over 4 m, or climbing over 25° at 70 km/h or less.'],
      ['chiquita', 'Slow, low touch under 30 km/h racket speed.'],
    ];
    el.innerHTML = `
      <header class="screen-head">
        <button type="button" class="btn btn-ghost btn-back" data-action="back" aria-label="Back" data-autofocus data-focus-key="back">${ICON.back}<span>Back</span></button>
        <div><p class="eyebrow">Mac · TV · Camera</p><h2 class="h-display">Help<span class="es">Ayuda</span></h2></div>
      </header>
      <div class="help-grid">
        <section class="help-col">
          <h3 class="skill-head">Set up the room<span class="es">Prepara el espacio</span></h3>
          <figure class="room-fig panel" aria-label="Room layout: TV and camera on one wall, you 2.5 metres away with a clear area of about 2 by 1.5 metres">
            <svg viewBox="0 0 320 210" aria-hidden="true">
              <rect x="70" y="14" width="180" height="12" class="tv"/><text x="160" y="44" class="lbl">TV + camera on top</text>
              <rect x="150" y="6" width="20" height="8" class="cam"/>
              <path d="M160 26 L70 196 M160 26 L250 196" class="fov"/>
              <rect x="104" y="112" width="112" height="84" class="area"/>
              <circle cx="160" cy="150" r="9" class="you"/><text x="160" y="182" class="lbl">you</text>
              <path d="M286 26 V150" class="dim"/><text x="296" y="94" class="lbl" transform="rotate(90 296 94)">2.5 m</text>
              <text x="160" y="206" class="lbl dimmed">clear area ≈ 2 × 1.5 m</text>
            </svg>
          </figure>
          <ol class="help-steps">
            <li><b>1</b><span>Connect the Mac to the TV with HDMI. Mirror the display, set the TV to <em>Game mode</em> to cut lag.</span></li>
            <li><b>2</b><span>Put the camera on top of the TV, centred, at roughly chest height or tilted slightly down.</span></li>
            <li><b>3</b><span>Stand 2.2–3.5 m back with light on you, not behind you. Clear a 2 × 1.5 m area.</span></li>
            <li><b>4</b><span>Install it as an app (see <em>Use it like an app</em>) or open it in Chrome / Safari; full screen with F (or ⌃⌘F); allow camera access.</span></li>
          </ol>
        </section>
        <section class="help-col">
          <h3 class="skill-head">Camera<span class="es">Cámara</span></h3>
          <aside class="tip"><p class="tip-head">Continuity Camera · iPhone</p><p>Mount the iPhone on the TV, landscape, rear camera toward you. Pick it in the camera list; it appears automatically when it's near the Mac.</p><p>In Control Centre → Video Effects, turn <b>Center Stage off</b>. Auto-framing moves the image and breaks distance tracking.</p></aside>
          <ul class="help-list">
            <li>Choose the lens preset that matches your camera so distance reads right.</li>
            <li>60 fps cameras track swings best. Avoid backlight and mirrors behind you.</li>
            <li>Plain clothes with sleeves that contrast with the wall help the tracker.</li>
            <li>Pause between points: both hands above your head for 2 s, or Esc.</li>
          </ul>
          <div class="help-install" data-install-slot="help">${installHelpHtml()}</div>
        </section>
        <section class="help-col">
          <h3 class="skill-head">How strokes are read<span class="es">Cómo leemos el golpe</span></h3>
          <dl class="stroke-guide">${strokesRead.map(([id, txt]) => { const n = strokeName(id); return `<div><dt>${esc(n.en)}<small>${esc(n.es)}</small></dt><dd>${esc(txt)}</dd></div>`; }).join('')}</dl>
          <p class="muted">Ideal groundstroke contact: 25–75 cm in front of your hips, 50–90 cm to the side, 60–130 cm high.</p>
        </section>
      </div>`;
    return { el };
  }

  // ---- HUD -----------------------------------------------------------------------
  function buildHud() {
    layerHud.dataset.mode = 'drill';
    layerHud.innerHTML = `
      <div class="hud-tl">
        <div class="hud-title"><span class="ht-name"></span><span class="ht-sub es"></span></div>
        <div class="hud-reps"><span class="hr-lbl">Rep</span><b class="hr-i">0</b><span class="hr-of">/ 0</span><span class="hr-timer"></span></div>
        <div class="hud-ticks" aria-hidden="true"></div>
        <div class="scoreboard" hidden></div>
        <div class="pip" data-k="pip">
          <canvas class="pip-canvas" data-preview="pip" aria-label="Camera view with tracked skeleton"></canvas>
          <span class="pip-tag"><span class="track-dot" data-state="off"></span><span class="pip-text">Camera</span></span>
        </div>
      </div>
      <div class="hud-tr">
        <div class="hud-points"><b>0</b><span class="hp-lbl">pts</span></div>
        <div class="hud-streak"><span class="hs-x"></span><span class="hs-lbl">streak · racha</span></div>
      </div>
      <div class="hud-prompt" hidden><span class="hp-ring"></span><span class="hp-text"></span></div>
      <div class="shotcard" hidden aria-live="polite"></div>
      <div class="ball-ind" hidden><span class="bi-arrow">${ICON.arrow}</span><span class="bi-text">Ball behind you<small>detrás</small></span></div>`;
    syncPip();
  }

  function syncPip() {
    const pip = layerHud.querySelector('.pip');
    if (pip) pip.hidden = !state.settings.pip;
  }

  function setRepTicks(i, total) {
    const box = layerHud.querySelector('.hud-ticks');
    if (!total || total > 60) {
      box.innerHTML = '';
      return;
    }
    if (box.childElementCount !== total) box.innerHTML = '<i></i>'.repeat(total);
    Array.from(box.children).forEach((t, k) => {
      t.className = k < i - 1 ? 'done' : k === i - 1 ? 'cur' : '';
    });
  }

  function hud(h) {
    if (!h) return;
    state.hud = h;
    const q = (s) => layerHud.querySelector(s);
    setText(q('.ht-name'), h.title || '');
    setText(q('.ht-sub'), h.subtitle || '');
    const match = !!h.score;
    layerHud.classList.toggle('has-score', match);
    const reps = q('.hud-reps');
    const hasReps = Number.isFinite(h.repTotal) && h.repTotal > 0;
    q('.hr-lbl').hidden = !hasReps;
    q('.hr-i').hidden = !hasReps;
    q('.hr-of').hidden = !hasReps;
    if (hasReps) {
      setText(q('.hr-i'), String(Math.max(0, h.repIndex || 0)));
      setText(q('.hr-of'), `/ ${h.repTotal}`);
    }
    setText(q('.hr-timer'), h.timer != null ? fmtTime(h.timer) : '');
    reps.hidden = !hasReps && h.timer == null;
    setRepTicks(hasReps ? h.repIndex || 0 : 0, hasReps ? h.repTotal : 0);

    // Ball in play toward the player: HUD blocks near the action step back (PiP dims, the
    // shot card collapses to a strip); between reps they come back in full.
    layerHud.classList.toggle('ball-live', !!h.live);

    const pts = q('.hud-points');
    const rallyMode = h.rally != null && !Number.isFinite(h.points);
    pts.hidden = match;
    // Rally / match: the big number is the current rally length, not points.
    const p = rallyMode ? h.rally || 0 : Number.isFinite(h.points) ? h.points : 0;
    setText(pts.querySelector('b'), fmtInt(p));
    setText(pts.querySelector('.hp-lbl'), rallyMode ? 'rally · peloteo' : 'pts');
    if (!rallyMode && state.lastPoints != null && p > state.lastPoints && !reducedMotion()) {
      pts.classList.remove('bump');
      void pts.offsetWidth;
      pts.classList.add('bump');
    }
    state.lastPoints = rallyMode ? null : p;
    const st = q('.hud-streak');
    if (rallyMode || (match && h.rally != null)) {
      // Rally: best rally under the current one. Match: the rally length beside the scoreboard.
      const val = match ? h.rally || 0 : h.bestRally || 0;
      st.hidden = val < 1;
      setText(st.querySelector('.hs-x'), String(val));
      setText(st.querySelector('.hs-lbl'), match ? 'rally · peloteo' : 'best · mejor');
    } else {
      const streak = h.streak || 0;
      st.hidden = streak < 2;
      setText(st.querySelector('.hs-x'), `×${streak}`);
      setText(st.querySelector('.hs-lbl'), 'streak · racha');
    }

    if (match) renderScoreboard(h.score);
    else q('.scoreboard').hidden = true;

    const pr = q('.hud-prompt');
    pr.hidden = !h.prompt;
    if (h.prompt) setText(pr.querySelector('.hp-text'), h.prompt);

    if (h.lastShot) {
      const key = JSON.stringify([h.lastShot.stroke, h.lastShot.speedKmh, h.lastShot.spinRpm, h.lastShot.netClearance, h.lastShot.quality]);
      if (key !== state.hudKeyShot) {
        state.hudKeyShot = key;
        renderShotCard(normalizeShot(h.lastShot));
      }
    }
    if (h.banner && h.banner.text) {
      const key = `${h.banner.text}|${h.banner.kind}|${h.banner.id ?? ''}`;
      if (key !== state.hudKeyBanner) {
        state.hudKeyBanner = key;
        banner(h.banner.text, h.banner.kind);
      }
    } else state.hudKeyBanner = null;
    if (h.ballIndicator !== undefined) ballIndicator(h.ballIndicator);
  }

  function renderScoreboard(sc) {
    const box = layerHud.querySelector('.scoreboard');
    box.hidden = false;
    const flags = sc.flags || {};
    const serverTeam = sc.server ? sc.server.team : null;
    const sets = sc.sets || [];
    const games = sc.games || [0, 0];
    const points = sc.points || ['0', '0'];
    const names = sc.names || [['You', 'Nosotros'], ['Rivals', 'Rivales']];
    const row = (t) => `<div class="sb-team${serverTeam === t ? ' serving' : ''}">
      <span class="sbt-serve" aria-label="${serverTeam === t ? 'Serving' : ''}"></span>
      <span class="sbt-name">${esc(names[t][0])}<small>${esc(names[t][1] || '')}</small></span>
      ${sets.map((s) => `<span class="sbt-set">${esc(s[t])}</span>`).join('')}
      <span class="sbt-games">${esc(games[t])}</span>
      <span class="sbt-pts">${esc(points[t] || '')}</span>
    </div>`;
    const tags = [];
    if (flags.tiebreak) tags.push('Tie-break');
    if (flags.goldenPoint && points[0] === '40' && points[1] === '40') tags.push('Punto de oro');
    if (flags.matchPoint != null && flags.matchPoint !== false) tags.push('Match point');
    else if (flags.setPoint != null && flags.setPoint !== false) tags.push('Set point');
    else if (flags.gamePoint != null && flags.gamePoint !== false && !tags.length) tags.push('Game point');
    box.innerHTML = `${row(0)}${row(1)}${tags.length ? `<div class="sb-tags">${tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}`;
  }

  function normalizeShot(s) {
    if (!s) return null;
    const spin = s.spinRpm;
    const spinTotal = typeof spin === 'number' ? spin : spin && Number.isFinite(spin.total) ? spin.total : null;
    const spinTop = spin && typeof spin === 'object' && Number.isFinite(spin.top) ? spin.top : Number.isFinite(s.spinTop) ? s.spinTop : null;
    return {
      stroke: s.stroke,
      speedKmh: Number.isFinite(s.speedKmh) ? s.speedKmh : Number.isFinite(s.speedOut) ? s.speedOut * 3.6 : null,
      spinRpm: spinTotal,
      spinTop,
      netClearance: Number.isFinite(s.netClearance) ? s.netClearance : null,
      quality: Number.isFinite(s.quality) ? s.quality : null,
      timing: s.timing || null,
      spacing: s.spacing || null,
      notes: s.notes || (s.result && s.result.notes) || [],
      points: Number.isFinite(s.points) ? s.points : s.result && Number.isFinite(s.result.points) ? s.result.points : null,
      success: s.success ?? s.inTarget ?? (s.result ? s.result.success ?? s.result.inTarget ?? null : null),
      afterWall: !!s.afterWall,
    };
  }

  function chip(kind, value) {
    if (!value) return '';
    const good = value === 'good';
    const label = { early: 'Early', late: 'Late', good: kind === 'timing' ? 'On time' : 'Good space', cramped: 'Cramped', stretched: 'Stretched' }[value] || value;
    const es = { early: 'pronto', late: 'tarde', good: kind === 'timing' ? 'a tiempo' : 'buena distancia', cramped: 'pegado', stretched: 'lejos' }[value] || '';
    return `<span class="chip ${good ? 'chip-good' : 'chip-warn'}" title="${esc(kind)}"><i></i>${esc(label)}<small>${esc(es)}</small></span>`;
  }

  function renderShotCard(s) {
    const card = layerHud.querySelector('.shotcard');
    if (!s) {
      card.hidden = true;
      return;
    }
    const n = strokeName(s.stroke);
    const spinLbl = s.spinTop == null ? 'spin' : s.spinTop >= 0 ? 'topspin · liftado' : 'slice · cortado';
    const clr = s.netClearance == null ? '—' : `${s.netClearance >= 0 ? '+' : '−'}${Math.round(Math.abs(s.netClearance) * 100)}`;
    const q = s.quality == null ? null : clamp(s.quality, 0, 1);
    const note = (s.notes || [])[0] || '';
    const pts = s.points != null && s.points > 0 ? `<span class="sc-pts">+${fmtInt(s.points)}</span>` : s.success === false ? '<span class="sc-miss">Miss · fallo</span>' : '';
    card.innerHTML = `
      <div class="sc-head"><span class="sc-stroke">${esc(n.en)}</span><span class="sc-es">${esc(n.es)}</span><span class="sc-chips">${chip('timing', s.timing)}${chip('spacing', s.spacing)}</span>${pts}</div>
      <div class="sc-stats">
        <div class="sc-stat sc-speed"><b>${s.speedKmh == null ? '—' : Math.round(s.speedKmh)}</b><span>km/h</span></div>
        <div class="sc-stat"><b>${s.spinRpm == null ? '—' : fmtInt(s.spinRpm)}</b><span>rpm ${esc(spinLbl)}</span></div>
        <div class="sc-stat"><b>${clr}${s.netClearance == null ? '' : '<small>cm</small>'}</b><span>over net · sobre la red</span></div>
        ${q != null ? `<div class="sc-stat sc-q"><span class="sc-qbar" style="--q:${q}"><i></i></span><span>sweet spot ${Math.round(q * 100)}%</span></div>` : ''}
      </div>
      ${note ? `<p class="sc-note"><span class="sc-coach">Coach</span>${esc(note)}</p>` : ''}`;
    card.hidden = false;
    card.classList.remove('fresh');
    if (!reducedMotion()) {
      void card.offsetWidth;
      card.classList.add('fresh');
    }
    clearTimeout(card._fade);
    card.classList.remove('faded');
    card._fade = setTimeout(() => card.classList.add('faded'), 7000);
  }

  function shotCard(rec) {
    const s = normalizeShot(rec);
    state.hudKeyShot = JSON.stringify([s && s.stroke, s && s.speedKmh, s && s.spinRpm, s && s.netClearance, s && s.quality]);
    renderShotCard(s);
  }

  // ---- Banner & toast ------------------------------------------------------------
  const BANNER_KIND = {
    'por-tres': 'gold', 'por-cuatro': 'gold', winner: 'gold', great: 'gold', go: 'gold', win: 'gold', best: 'gold',
    point: 'plain', info: 'info', rep: 'plain', good: 'plain', bad: 'bad',
    fault: 'bad', miss: 'bad', net: 'bad', out: 'bad', lose: 'bad', 'double-bounce': 'bad', 'double-fault': 'bad',
    'serve-fault': 'bad', 'own-side': 'bad', 'volleyed-serve': 'bad', ceiling: 'bad',
  };

  function banner(text, kind = 'point', { sub = '', duration = 2300 } = {}) {
    clearTimeout(bannerEl._t);
    if (!text) {
      bannerEl.innerHTML = '';
      return;
    }
    const tone = BANNER_KIND[kind] || 'plain';
    bannerEl.innerHTML = `<div class="banner banner-${tone}" data-kind="${esc(kind)}"><span class="bn-line" aria-hidden="true"></span><span class="bn-text">${esc(text)}</span>${sub ? `<span class="bn-sub">${esc(sub)}</span>` : ''}</div>`;
    bannerEl._t = setTimeout(() => {
      const b = bannerEl.firstElementChild;
      if (b) b.classList.add('out');
      bannerEl._t = setTimeout(() => { bannerEl.innerHTML = ''; }, reducedMotion() ? 0 : 380);
    }, duration);
  }

  function toast(text, { duration = 3200 } = {}) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    toastEl.appendChild(t);
    while (toastEl.childElementCount > 3) toastEl.firstElementChild.remove();
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), reducedMotion() ? 0 : 300);
    }, duration);
  }

  // ---- Ball indicator -------------------------------------------------------------
  /** v: { angle (rad, 0 = straight ahead, +clockwise / to the right, PI = behind), label? } | null */
  function ballIndicator(v) {
    state.ballInd = v;
    const el = layerHud.querySelector('.ball-ind');
    if (!v || !Number.isFinite(v.angle)) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const a = v.angle;
    const sx = Math.sin(a), sy = -Math.cos(a);
    // Place on an inset ellipse; the bottom edge for balls behind.
    // Kept above the shot card and inside the side gutters so it never covers HUD blocks.
    const x = 50 + clamp(sx * 1.4, -1, 1) * 40;
    const y = Math.min(66, 50 + clamp(sy * 1.4, -1, 1) * 36);
    el.style.left = `${x}%`;
    el.style.top = `${y}%`;
    el.querySelector('.bi-arrow').style.transform = `rotate(${a - Math.PI}rad)`;
    const lbl = v.label || (Math.abs(a) > Math.PI * 0.6 ? 'Ball behind you' : a > 0 ? 'Ball to your right' : 'Ball to your left');
    const es = v.es || (Math.abs(a) > Math.PI * 0.6 ? 'detrás' : a > 0 ? 'a tu derecha' : 'a tu izquierda');
    el.querySelector('.bi-text').innerHTML = `${esc(lbl)}<small>${esc(es)}</small>`;
  }

  function hideBallIndicator() {
    const el = layerHud.querySelector('.ball-ind');
    if (el) el.hidden = true;
  }

  // ---- Camera preview & skeleton --------------------------------------------------
  function setCameraPreview(src) {
    state.preview = src || null;
    ensureLoop();
  }

  function setSkeleton(frame) {
    state.skeleton = frame || null;
    if (frame) state.skeletonAt = performance.now();
  }

  const previewSizes = new WeakMap();
  function updatePreviewSize() {
    root.querySelectorAll('canvas[data-preview]').forEach((cv) => previewSizes.delete(cv));
  }

  function sourceSize(src) {
    if (!src) return null;
    const w = src.videoWidth || src.naturalWidth || src.width;
    const h = src.videoHeight || src.naturalHeight || src.height;
    return w && h ? { w, h } : null;
  }

  function drawPreview(cv) {
    let sz = previewSizes.get(cv);
    if (!sz) {
      const r = fitCanvas(cv, 320, 180);
      sz = { w: r.w, h: r.h };
      previewSizes.set(cv, sz);
    }
    const ctx = cv.getContext('2d');
    const dpr = cv.width / sz.w;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { w, h } = sz;
    ctx.fillStyle = '#05080d';
    ctx.fillRect(0, 0, w, h);
    const src = state.preview;
    const ss = sourceSize(src);
    // Contain the source in the canvas so landmarks line up exactly.
    let rx = 0, ry = 0, rw = w, rh = h;
    if (ss) {
      const k = Math.min(w / ss.w, h / ss.h);
      rw = ss.w * k;
      rh = ss.h * k;
      rx = (w - rw) / 2;
      ry = (h - rh) / 2;
      const ready = src.readyState === undefined || src.readyState >= 2;
      if (ready) {
        ctx.save();
        ctx.translate(rx + rw, ry);
        ctx.scale(-1, 1);
        try { ctx.drawImage(src, 0, 0, rw, rh); } catch { /* not ready */ }
        ctx.restore();
        ctx.fillStyle = 'rgba(4,8,14,0.28)';
        ctx.fillRect(rx, ry, rw, rh);
      }
    } else {
      const g = ctx.createRadialGradient(w / 2, h * 0.45, 0, w / 2, h / 2, w * 0.6);
      g.addColorStop(0, '#111c2b');
      g.addColorStop(1, '#05080d');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      if (cv.dataset.preview !== 'pip') {
        ctx.fillStyle = 'rgba(244,239,228,0.55)';
        ctx.font = `600 ${Math.round(h * 0.05)}px 'Barlow Semi Condensed', sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('No camera yet', w / 2, h / 2);
      }
    }
    const frame = state.skeleton;
    const showSkel = cv.dataset.preview !== 'pip' || state.settings.skeleton;
    if (frame && showSkel && frame.people && frame.people[0] && performance.now() - state.skeletonAt < 600) {
      ctx.save();
      ctx.translate(rx, ry);
      drawSkeleton(ctx, frame.people[0].landmarks, rw, rh, { mirror: true, scale: cv.dataset.preview === 'pip' ? 0.7 : 1.15 });
      ctx.restore();
    }
  }

  // ---- Cursor visual --------------------------------------------------------------
  function setCursor(s = {}) {
    const vis = !!s.visible;
    cursorEl.hidden = !vis;
    if (vis) {
      cursorEl.style.transform = `translate3d(${Math.round(s.x)}px, ${Math.round(s.y)}px, 0)`;
      const p = clamp(s.progress || 0, 0, 1);
      cursorEl.querySelector('.ring').style.strokeDashoffset = String(RING_C * (1 - p));
      cursorEl.classList.toggle('on-target', !!s.target || p > 0);
      if (s.clicked && !reducedMotion()) {
        cursorEl.classList.remove('clicked');
        void cursorEl.offsetWidth;
        cursorEl.classList.add('clicked');
      }
      root.dataset.input = 'hand';
    }
    const pp = clamp(s.pauseProgress || 0, 0, 1);
    pauseHoldEl.hidden = !(pp > 0.02);
    if (pp > 0.02) pauseHoldEl.querySelector('.fg').style.strokeDashoffset = String(HOLD_C * (1 - pp));
  }

  // ---- Frame loop (previews, calibration timers) ------------------------------------
  let rafId = 0;
  let lastFrame = 0;
  let lastDraw = 0;
  function needLoop() {
    return state.screen === 'calibrate' || state.screen === 'camera' || ((state.screen === 'play' || state.screen === 'pause') && state.settings.pip);
  }
  function ensureLoop() {
    if (!rafId && needLoop()) {
      lastFrame = performance.now();
      rafId = requestAnimationFrame(loop);
    }
  }
  function loop(now) {
    rafId = 0;
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (state.screen === 'calibrate') calUpdate(dt);
    // Previews at ~30 fps keep the main thread free for tracking and rendering.
    if (now - lastDraw > 32) {
      lastDraw = now;
      root.querySelectorAll('canvas[data-preview]').forEach((cv) => {
        if (isVisible(cv)) drawPreview(cv);
      });
      const tag = layerHud.querySelector('.pip .track-dot');
      if (tag) {
        const live = state.skeleton && now - state.skeletonAt < 600;
        tag.dataset.state = live ? 'ok' : state.preview ? 'warn' : 'off';
        setText(layerHud.querySelector('.pip-text'), live ? 'Tracking' : state.preview ? 'No body found' : 'Camera off');
      }
    }
    if (needLoop()) rafId = requestAnimationFrame(loop);
  }

  // ---- Resize & fonts -----------------------------------------------------------------
  const onResize = () => {
    updatePreviewSize();
    if (mounted && mounted.redraw) mounted.redraw();
  };
  window.addEventListener('resize', onResize);
  if (document.fonts && document.fonts.ready) {
    Promise.all([
      document.fonts.load("800 20px 'Big Shoulders Display'"),
      document.fonts.load("600 20px 'Barlow Semi Condensed'"),
      document.fonts.load("700 20px 'Barlow Semi Condensed'"),
    ]).catch(() => {}).then(() => { if (mounted && mounted.redraw) mounted.redraw(); });
  }

  const api = {
    show,
    hud,
    shotCard,
    banner,
    toast,
    results,
    setLoading,
    setCameraPreview,
    setSkeleton,
    setCursor,
    setTitleHandHint,
    setInstall,
    updateReady,
    calibration,
    settings,
    ballIndicator,
    get screen() { return state.screen; },
    get currentSettings() { return { ...state.settings, volumes: { ...state.settings.volumes } }; },
    focusDefault() { focusEl(defaultFocus()); },
    dispose() {
      cancelAnimationFrame(rafId);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('resize', onResize);
      root.innerHTML = '';
    },
  };
  return api;
}
