// Swipe mode for phones and tablets (iPhone first): device detection, the input choice, a mobile
// quality tier, the touch layer (src/input/touch.js) and its overlay (pause / view buttons, swipe
// trail and feedback, movement stick, rotate hint, first-run swipe tutorial, swipe settings), the
// third-person chase camera (src/render/chaseCam.js), iOS audio unlock and safe areas
// (styles/mobile.css).
//
// main.js integration (see the handoff in the round report): createMobile() at boot, install() once
// the UI / stage / audio exist, attachGame(game) for every 'touch' session, enterPlayView(stage)
// wherever main.js enters the play view, selfActor(world) / afterSync(world, dt) around
// stage.syncWorld, frame() every animation frame. No MediaPipe is loaded in swipe mode: the camera
// tracker is only opened when the player chooses the camera.
//
// The pure helpers (detectDevice, decideInput, prefs, MOBILE_QUALITY, mobileTier) run under node.

import { createTouchController, attachTouchGame, bindTouchInput, TOUCH } from '../input/touch.js';
import { createSwipeRecognizer, shotIntent } from '../input/swipe.js';
import { createChaseCam } from '../render/chaseCam.js';

export const MOBILE_STORE = 'vibora.mobile.v1';

/**
 * Mobile render tier (registered as QUALITY.mobile over 'balanced'): pixel ratio capped at 1.5 of a
 * phone's 3, FXAA instead of MSAA, smaller shadow maps and soft radius, no ambient occlusion, light
 * bloom, small environment / turf textures, no neighbouring courts or fill lights. maxShadowLights and
 * crowdScale are read by limitShadowLights() here and (handoff) by the venue builders.
 */
export const MOBILE_QUALITY = Object.freeze({
  msaa: 0, fxaa: true, maxPixelRatio: 1.5, shadowMapSize: 1024, shadowRadius: 2,
  bloom: true, bloomStrength: 0.12, turfSize: 1024, envSize: 128, neighbors: false, fillLights: false, ao: 0,
  turfShells: 0, ssao: false, maxShadowLights: 1, crowdScale: 0.5,
});

/** Default swipe-mode preferences (stored under MOBILE_STORE). */
export const MOBILE_DEFAULTS = Object.freeze({ controls: null, view: 'behind', stick: false, tutorialDone: false, rotateDismissed: false });

// ---------------------------------------------------------------------------------------
// Pure helpers

/**
 * Device facts from navigator / window (injected for tests):
 * { ios, iphone, ipad, android, touch, touchPrimary, phone, tablet, standalone, dpr, portrait }.
 * iPadOS reports a Mac user agent: a "Macintosh" with several touch points is an iPad.
 */
export function detectDevice({ nav = globalThis.navigator, win = globalThis.window } = {}) {
  const ua = String((nav && nav.userAgent) || '');
  const tp = (nav && nav.maxTouchPoints) || 0;
  const mm = (q) => !!(win && typeof win.matchMedia === 'function' && win.matchMedia(q).matches);
  const iphone = /iPhone|iPod/.test(ua);
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && tp > 1);
  const android = /Android/.test(ua);
  const touch = tp > 0 || (win && 'ontouchstart' in win);
  const coarse = mm('(pointer: coarse)');
  const fine = mm('(any-pointer: fine)');
  const touchPrimary = !!(iphone || ipad || android || (touch && coarse && !fine));
  const w = (win && win.innerWidth) || 0, h = (win && win.innerHeight) || 0;
  const short = Math.min(w || 9999, h || 9999);
  const phone = iphone || (android && /Mobile/.test(ua)) || (touchPrimary && short > 0 && short < 500);
  return {
    ios: iphone || ipad, iphone, ipad, android, touch: !!touch, touchPrimary, phone: !!phone, tablet: !!(touchPrimary && !phone),
    standalone: !!((nav && nav.standalone) || mm('(display-mode: standalone)') || mm('(display-mode: fullscreen)')),
    dpr: (win && win.devicePixelRatio) || 1,
    portrait: h > w,
  };
}

/**
 * The input to boot with: 'touch' (swipe mode), 'camera', 'fallback' (mouse), or null (no opinion:
 * the app's own default). URL first (?input=swipe|camera|mouse, ?swipe=1, ?fallback=1 and
 * ?autopilot=1 win), then the stored choice, then the device: touch-primary devices swipe.
 */
export function decideInput({ search = '', device = {}, prefs = MOBILE_DEFAULTS } = {}) {
  const q = new URLSearchParams(search);
  if (q.has('autopilot') && q.get('autopilot') !== '0') return null;
  const inp = q.get('input');
  if (inp === 'swipe' || inp === 'touch' || q.get('swipe') === '1') return 'touch';
  if (inp === 'camera') return 'camera';
  if (inp === 'mouse' || (q.has('fallback') && q.get('fallback') !== '0')) return null;
  if (q.get('swipe') === '0') return null;
  if (prefs && prefs.controls === 'camera') return 'camera';
  if (prefs && prefs.controls === 'swipe') return 'touch';
  return device.touchPrimary ? 'touch' : null;
}

export function loadPrefs(storage) {
  try {
    const raw = storage && storage.getItem(MOBILE_STORE);
    const v = raw ? JSON.parse(raw) : {};
    return { ...MOBILE_DEFAULTS, ...(v && typeof v === 'object' ? v : {}) };
  } catch {
    return { ...MOBILE_DEFAULTS };
  }
}

export function savePrefs(storage, prefs) {
  try {
    if (storage) storage.setItem(MOBILE_STORE, JSON.stringify(prefs));
  } catch {
    /* private mode: preferences live for this visit */
  }
}

/** Registers QUALITY.mobile (over QUALITY.balanced, so tier fields added later keep balanced values). */
export function mobileTier(QUALITY) {
  if (!QUALITY || typeof QUALITY !== 'object') return null;
  if (!QUALITY.mobile) QUALITY.mobile = { ...(QUALITY.balanced || {}), ...MOBILE_QUALITY };
  return 'mobile';
}

/**
 * Keeps at most `max` shadow-casting lights in a three.js scene (the strongest ones; directional
 * first). Returns the number turned off. Run after a venue is built (stage creation, setVenue).
 */
export function limitShadowLights(scene, max = 1) {
  if (!scene || typeof scene.traverse !== 'function') return 0;
  const lights = [];
  scene.traverse((o) => {
    if (o.isLight && o.castShadow) lights.push(o);
  });
  if (lights.length <= max) return 0;
  lights.sort((a, b) => (b.isDirectionalLight ? 1 : 0) - (a.isDirectionalLight ? 1 : 0) || (b.intensity || 0) - (a.intensity || 0));
  let n = 0;
  for (const l of lights.slice(max)) {
    l.castShadow = false;
    n++;
  }
  return n;
}

const KIND_TEXT = {
  topspin: ['Topspin', 'Liftado'], flat: ['Flat', 'Plano'], slice: ['Slice', 'Cortado'], lob: ['Lob', 'Globo'],
  volley: ['Volley', 'Volea'], bandeja: ['Bandeja', 'Bandeja'], vibora: ['Víbora', 'Víbora'], smash: ['Smash', 'Remate'], serve: ['Serve', 'Saque'],
};

// ---------------------------------------------------------------------------------------
// The app layer

/**
 * @param {object} o
 * @param {string} [o.search] location.search
 * @param {object} [o.storage] { getItem, setItem }
 * @param {object} [o.QUALITY] render/scene.js QUALITY (registers the mobile tier when swiping on a phone)
 * @param {string} [o.forceInput] tests: 'touch' | 'camera' | null
 */
export function createMobile({ search = globalThis.location ? location.search : '', storage = null, QUALITY = null, nav, win, forceInput } = {}) {
  const device = detectDevice({ nav, win });
  const prefs = loadPrefs(storage);
  const q = new URLSearchParams(search);
  const input = forceInput !== undefined ? forceInput : decideInput({ search, device, prefs });
  const swipe = input === 'touch';
  if (q.get('view') === 'fp' || q.get('view') === 'first') prefs.view = 'first';
  else if (q.get('view') === 'behind') prefs.view = 'behind';
  if (q.get('stick') === '1') prefs.stick = true;
  if (q.get('tutorial') === '1') prefs.tutorialDone = false;
  // The mobile tier on phones and tablets (any input), unless ?quality= chooses.
  const quality = !q.get('quality') && (device.touchPrimary || swipe) && QUALITY ? mobileTier(QUALITY) : null;

  const controller = createTouchController({ handed: 'right' });
  let env = null; // install() context
  let detach = null;
  let game = null;
  let chase = null;
  let touch = null;
  let el = null;
  let trail = null;
  let unlocked = false;
  let tutorial = null;
  const lastSwipe = { at: -1, kind: null };

  function save() { savePrefs(storage, prefs); }

  // ---- DOM overlay ------------------------------------------------------------------

  function mount() {
    const doc = globalThis.document;
    if (!doc || el) return;
    doc.documentElement.classList.add('vp-mobile');
    if (device.ios) doc.documentElement.classList.add('vp-ios');
    if (swipe) doc.documentElement.classList.add('vp-swipe');
    el = doc.createElement('div');
    el.className = 'vpm';
    el.innerHTML = `
      <canvas class="vpm-trail" aria-hidden="true"></canvas>
      <div class="vpm-bar" hidden>
        <button type="button" class="vpm-btn vpm-view" data-vpm="view" aria-label="Switch view"><span class="vpm-view-text">First person</span></button>
        <button type="button" class="vpm-btn vpm-pause" data-vpm="pause" aria-label="Pause"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg></button>
      </div>
      <button type="button" class="vpm-btn vpm-gear" data-vpm="sheet" aria-label="Swipe settings" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.6a3.4 3.4 0 100 6.8 3.4 3.4 0 000-6.8zm8.3 4.9l1.6 1.3-1.8 3.1-2-.7a7.6 7.6 0 01-1.9 1.1l-.3 2.1H12.3l-.3-2.1a7.6 7.6 0 01-1.9-1.1l-2 .7-1.8-3.1 1.6-1.3a7.4 7.4 0 010-2.2L6.3 8.9l1.8-3.1 2 .7a7.6 7.6 0 011.9-1.1l.3-2.1h3.6l.3 2.1a7.6 7.6 0 011.9 1.1l2-.7 1.8 3.1-1.6 1.3a7.4 7.4 0 010 2.2z"/></svg></button>
      <div class="vpm-stick" hidden aria-hidden="true"><i></i></div>
      <div class="vpm-chip" hidden aria-live="polite"></div>
      <div class="vpm-rotate" hidden role="status"><span class="vpm-rotate-icon" aria-hidden="true"></span><span>Turn your phone sideways for the widest view<small>Gira el móvil · el vertical también funciona</small></span><button type="button" class="vpm-x" data-vpm="rotate-x" aria-label="Dismiss">✕</button></div>
      <div class="vpm-sheet" hidden role="dialog" aria-label="Swipe settings"></div>
      <div class="vpm-tutorial" hidden role="dialog" aria-label="How to swing"></div>`;
    doc.body.appendChild(el);
    trail = el.querySelector('.vpm-trail');
    el.addEventListener('click', onClick);
    sizeTrail();
    globalThis.addEventListener('resize', onResize);
    globalThis.addEventListener('orientationchange', onResize);
    syncView();
  }

  function onResize() {
    sizeTrail();
    if (chase) chase.snap();
    refreshRotate();
  }

  function sizeTrail() {
    if (!trail) return;
    const w = globalThis.innerWidth || 1, h = globalThis.innerHeight || 1;
    const r = Math.min(2, globalThis.devicePixelRatio || 1);
    trail.width = Math.round(w * r);
    trail.height = Math.round(h * r);
    trail.style.width = `${w}px`;
    trail.style.height = `${h}px`;
    trail.dataset.r = r;
  }

  function onClick(e) {
    const b = e.target.closest('[data-vpm]');
    if (!b) return;
    const k = b.dataset.vpm;
    const H = (env && env.handlers) || {};
    if (k === 'pause' && H.pause) H.pause();
    else if (k === 'view') setView(prefs.view === 'behind' ? 'first' : 'behind');
    else if (k === 'sheet') openSheet();
    else if (k === 'rotate-x') {
      prefs.rotateDismissed = true;
      save();
      refreshRotate();
    } else if (k === 'sheet-close') closeSheet();
    else if (k === 'sheet-view') { setView(b.dataset.value); renderSheet(); }
    else if (k === 'sheet-stick') { setStick(b.dataset.value === 'on'); renderSheet(); }
    else if (k === 'sheet-tutorial') { closeSheet(); showTutorial(); }
    else if (k === 'sheet-camera') {
      prefs.controls = 'camera';
      save();
      if (H.useCamera) H.useCamera();
    } else if (k === 'sheet-swipe') {
      prefs.controls = 'swipe';
      save();
      if (H.useSwipe) H.useSwipe();
    }
  }

  function syncView() {
    if (!el) return;
    el.dataset.view = prefs.view;
    const t = el.querySelector('.vpm-view-text');
    if (t) t.textContent = prefs.view === 'behind' ? 'First person' : 'Behind';
  }

  function setView(v) {
    prefs.view = v === 'first' ? 'first' : 'behind';
    save();
    syncView();
    if (env && env.stage && game) enterPlayView(env.stage);
  }

  function setStick(on) {
    prefs.stick = !!on;
    save();
    if (touch) touch.setStick(prefs.stick);
  }

  // ---- settings sheet -----------------------------------------------------------------

  function seg(name, opts, value) {
    return `<div class="vpm-seg" role="radiogroup">${opts.map(([v, t]) => `<button type="button" role="radio" data-vpm="${name}" data-value="${v}" aria-checked="${v === value}">${t}</button>`).join('')}</div>`;
  }

  function renderSheet() {
    const s = el && el.querySelector('.vpm-sheet');
    if (!s) return;
    s.innerHTML = `
      <div class="vpm-sheet-card">
        <h2>Swipe controls<small>Controles táctiles</small></h2>
        <div class="vpm-row"><span>View<small>Vista</small></span>${seg('sheet-view', [['behind', 'Behind'], ['first', 'First person']], prefs.view)}</div>
        <div class="vpm-row"><span>Movement stick<small>Joystick (pulgar izquierdo)</small></span>${seg('sheet-stick', [['off', 'Off'], ['on', 'On']], prefs.stick ? 'on' : 'off')}</div>
        <div class="vpm-row vpm-row-btns">
          <button type="button" class="vpm-btn vpm-wide" data-vpm="sheet-tutorial">How to swing<small>Cómo golpear</small></button>
          ${swipe
    ? '<button type="button" class="vpm-btn vpm-wide" data-vpm="sheet-camera">Use the camera instead<small>Usar la cámara</small></button>'
    : '<button type="button" class="vpm-btn vpm-wide" data-vpm="sheet-swipe">Use swipes instead<small>Usar gestos</small></button>'}
        </div>
        <button type="button" class="vpm-btn vpm-close" data-vpm="sheet-close">Done<small>Listo</small></button>
      </div>`;
  }

  function openSheet() {
    const s = el && el.querySelector('.vpm-sheet');
    if (!s) return;
    renderSheet();
    s.hidden = false;
  }

  function closeSheet() {
    const s = el && el.querySelector('.vpm-sheet');
    if (s) s.hidden = true;
  }

  // ---- rotate hint ------------------------------------------------------------------------

  function refreshRotate() {
    const r = el && el.querySelector('.vpm-rotate');
    if (!r) return;
    const portrait = (globalThis.innerHeight || 0) > (globalThis.innerWidth || 0);
    r.hidden = !(swipe && device.phone && portrait && !prefs.rotateDismissed);
  }

  // ---- tutorial ------------------------------------------------------------------------------

  const STEPS = [
    {
      key: 'time', title: 'Swipe when the circle closes', es: 'Desliza cuando el círculo se cierra',
      body: 'The ring shrinks onto the ball. Flick up as it closes — the earlier or later, the more the ball goes cross-court or down the line.',
      try: 'Try it: flick up', demo: 'time',
    },
    {
      key: 'power', title: 'Swipe faster = harder', es: 'Más rápido = más fuerte',
      body: 'A gentle swipe places the ball; a fast, long flick hits it hard. Lean the flick left or right to aim.',
      try: 'Try a fast one', demo: 'power',
    },
    {
      key: 'shape', title: 'Up = topspin · down = smash · curve = slice', es: 'Arriba liftado · abajo remate · curva cortado',
      body: 'Up brushes topspin (slow and long: a lob). Down on a high ball smashes (gently: a bandeja). A curved swipe cuts — overhead, a víbora.',
      try: 'Swipe any shape', demo: 'shape',
    },
  ];

  function demoHtml(kind) {
    if (kind === 'time') {
      return `<div class="vpm-demo vpm-demo-time"><span class="vpm-ball"></span><span class="vpm-ring"></span><span class="vpm-finger vpm-f-up"></span></div>`;
    }
    if (kind === 'power') {
      return `<div class="vpm-demo vpm-demo-power">
        <div class="vpm-lane"><span class="vpm-finger vpm-f-slow"></span><b>Soft · 55 km/h</b></div>
        <div class="vpm-lane"><span class="vpm-finger vpm-f-fast"></span><b>Hard · 110 km/h</b></div></div>`;
    }
    return `<div class="vpm-demo vpm-demo-shape">
      <div class="vpm-mini"><svg viewBox="0 0 60 80" aria-hidden="true"><path class="vpm-path" d="M30 72 L30 10"/><path class="vpm-head" d="M22 18 L30 8 L38 18"/></svg><b>Topspin</b></div>
      <div class="vpm-mini"><svg viewBox="0 0 60 80" aria-hidden="true"><path class="vpm-path" d="M30 8 L30 70"/><path class="vpm-head" d="M22 62 L30 72 L38 62"/></svg><b>Smash</b></div>
      <div class="vpm-mini"><svg viewBox="0 0 60 80" aria-hidden="true"><path class="vpm-path" d="M18 72 Q52 44 22 10"/><path class="vpm-head" d="M16 20 L21 9 L31 14"/></svg><b>Slice · víbora</b></div></div>`;
  }

  function showTutorial(onDone = null) {
    const t = el && el.querySelector('.vpm-tutorial');
    if (!t) {
      if (onDone) onDone();
      return;
    }
    let i = 0;
    const doc = globalThis.document;
    const rec = createSwipeRecognizer({ width: globalThis.innerWidth || 844, height: globalThis.innerHeight || 390 });
    const finish = () => {
      t.hidden = true;
      t.innerHTML = '';
      prefs.tutorialDone = true;
      save();
      tutorial = null;
      for (const [k, fn] of Object.entries(hs)) t.removeEventListener(k, fn);
      if (onDone) onDone();
    };
    const render = (feedback = '') => {
      const s = STEPS[i];
      t.innerHTML = `
        <div class="vpm-tut-card" data-step="${s.key}">
          <p class="vpm-tut-step">${i + 1} / ${STEPS.length}</p>
          ${demoHtml(s.demo)}
          <h2>${s.title}<small>${s.es}</small></h2>
          <p class="vpm-tut-body">${s.body}</p>
          <p class="vpm-tut-try">${feedback || s.try}</p>
          <div class="vpm-tut-btns">
            <button type="button" class="vpm-btn" data-tut="skip">Skip<small>Saltar</small></button>
            <button type="button" class="vpm-btn vpm-go" data-tut="next">${i < STEPS.length - 1 ? 'Next' : "Let's play"}<small>${i < STEPS.length - 1 ? 'Siguiente' : '¡A jugar!'}</small></button>
          </div>
        </div>`;
    };
    const next = () => {
      if (i < STEPS.length - 1) {
        i++;
        render();
      } else finish();
    };
    const onSwipe = (ev) => {
      const intent = shotIntent(ev, { family: STEPS[i].key === 'shape' && ev.upness < -0.35 ? 'oh' : 'fh' });
      const [en] = KIND_TEXT[intent.kind] || ['Swing'];
      render(`<b>${en} · ${Math.round(ev.effort * 100)}% power</b> — nice!`);
      clearTimeout(tutorial && tutorial.timer);
      if (tutorial) tutorial.timer = setTimeout(next, 1100);
    };
    const hs = {
      touchstart: (e) => {
        if (e.target.closest('button')) return;
        if (e.cancelable) e.preventDefault();
        for (const c of e.changedTouches) rec.down(c.identifier, c.clientX, c.clientY, e.timeStamp);
      },
      touchmove: (e) => {
        if (e.cancelable) e.preventDefault();
        for (const c of e.changedTouches) for (const ev of rec.move(c.identifier, c.clientX, c.clientY, e.timeStamp)) if (ev.type === 'swing') onSwipe(ev);
      },
      touchend: (e) => {
        for (const c of e.changedTouches) for (const ev of rec.up(c.identifier, c.clientX, c.clientY, e.timeStamp)) if (ev.type === 'swing') onSwipe(ev);
      },
      touchcancel: (e) => {
        for (const c of e.changedTouches) rec.cancel(c.identifier);
      },
      click: (e) => {
        const b = e.target.closest('[data-tut]');
        if (!b) return;
        if (b.dataset.tut === 'skip') finish();
        else next();
      },
    };
    for (const [k, fn] of Object.entries(hs)) t.addEventListener(k, fn, { passive: false });
    tutorial = { timer: null, finish };
    t.hidden = false;
    render();
    void doc;
  }

  // ---- touch layer -------------------------------------------------------------------------

  /** Swipe feedback: the finger's trail (fades), coloured by the swing's effort, and a chip. */
  const trails = new Map(); // id -> { pts: [{x,y,t}], effort }
  function onTrail(kind, id, x, y, t) {
    if (kind === 'start') trails.set(id, { pts: [{ x, y, t }], effort: null, end: null });
    else {
      const tr = trails.get(id);
      if (!tr) return;
      tr.pts.push({ x, y, t });
      if (tr.pts.length > 40) tr.pts.shift();
      if (kind !== 'move') tr.end = t;
    }
  }

  let trailOn = true;
  function drawTrails(now) {
    if (!trail) return;
    const ctx = trail.getContext('2d');
    if (!ctx) return;
    // No trail: hide the layer (and skip the clears), so a finished swipe never lingers on screen.
    if (!trails.size) {
      if (trailOn) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, trail.width, trail.height);
        trail.style.visibility = 'hidden';
        trailOn = false;
      }
      return;
    }
    if (!trailOn) {
      trail.style.visibility = '';
      trailOn = true;
    }
    const r = Number(trail.dataset.r) || 1;
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.clearRect(0, 0, trail.width, trail.height);
    for (const [id, tr] of trails) {
      const age = tr.end !== null ? now - tr.end : 0;
      if (age > 420) {
        trails.delete(id);
        continue;
      }
      const a = 1 - age / 420;
      const e = tr.effort ?? 0.4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 1; i < tr.pts.length; i++) {
        const p0 = tr.pts[i - 1], p1 = tr.pts[i];
        const fresh = Math.max(0, 1 - (now - p1.t) / 380);
        const al = a * (0.25 + 0.75 * fresh) * (i / tr.pts.length);
        ctx.strokeStyle = `rgba(${Math.round(139 + 81 * e)}, ${Math.round(228 + 17 * e)}, ${Math.round(238 - 178 * e)}, ${al.toFixed(3)})`;
        ctx.lineWidth = 4 + 10 * e * (i / tr.pts.length);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
    }
  }

  function showChip(ev) {
    const c = el && el.querySelector('.vpm-chip');
    if (!c) return;
    const g = game && game.world;
    const P = g && g.timing && g.timing.plan;
    const fam = P ? (P.serve ? 'serve' : P.family) : 'fh';
    const intent = shotIntent(ev, { family: fam, serve: !!(P && P.serve) });
    const [en, es] = KIND_TEXT[intent.kind] || ['Swing', 'Golpe'];
    c.innerHTML = `<b>${en}</b><span>${Math.round(intent.effort * 100)}%</span><small>${es}</small>`;
    c.style.setProperty('--e', intent.effort.toFixed(2));
    const W = globalThis.innerWidth || 844, H = globalThis.innerHeight || 390;
    c.style.left = `${Math.max(60, Math.min(W - 60, ev.x))}px`;
    c.style.top = `${Math.max(70, Math.min(H - 40, ev.y - 34))}px`;
    c.hidden = false;
    c.classList.remove('is-on');
    void c.offsetWidth;
    c.classList.add('is-on');
    lastSwipe.at = Number.isFinite(ev.tEnd) ? ev.tEnd : performance.now();
    lastSwipe.kind = intent.kind;
    const tr = trails.get(ev.id);
    if (tr) tr.effort = intent.effort;
  }

  function showStick(e) {
    const s = el && el.querySelector('.vpm-stick');
    if (!s) return;
    if (!e.active) {
      s.hidden = true;
      return;
    }
    s.hidden = false;
    if (Number.isFinite(e.ox)) {
      s.style.left = `${e.ox}px`;
      s.style.top = `${e.oy}px`;
    }
    const knob = s.firstElementChild;
    if (knob) knob.style.transform = `translate(${(e.x * 38).toFixed(1)}px, ${(-e.y * 38).toFixed(1)}px)`;
  }

  function onTouchEvent(e) {
    const H = (env && env.handlers) || {};
    const playing = H.isPlaying ? H.isPlaying() : !!game;
    if (e.type === 'pause') {
      if (playing && H.pause) H.pause();
      return;
    }
    if (H.isReplay && H.isReplay()) {
      if ((e.type === 'tap' || e.type === 'swing') && H.skipReplay) H.skipReplay();
      return;
    }
    if (!playing) return;
    if (e.type === 'swing') {
      controller.onSwipe(e);
      showChip(e);
    } else if (e.type === 'tap') controller.onTap(e);
    else if (e.type === 'stick') {
      controller.setStick(e.x, e.y, e.active);
      showStick(e);
    }
  }

  function unlockOnce() {
    if (unlocked) return;
    const H = (env && env.handlers) || {};
    const r = H.unlockAudio ? H.unlockAudio() : null;
    Promise.resolve(r).then((ok) => {
      if (ok !== false) {
        unlocked = true;
        globalThis.removeEventListener('touchend', unlockOnce, true);
        globalThis.removeEventListener('click', unlockOnce, true);
      }
    }).catch(() => {});
  }

  // ---- views ---------------------------------------------------------------------------------

  /** Enters the play view of a swipe session: the chase camera (behind) or first person. Returns the view name. */
  function enterPlayView(stage) {
    if (!stage) return null;
    if (prefs.view === 'first') {
      stage.setView('fp');
      return 'fp';
    }
    // The stage's broadcast cutaway clears the near back wall for a camera behind it: a 'chase' view
    // when the stage has one (handoff), else the replay view's broadcast angle with our camera on top.
    const v = stage.supportsChase ? 'chase' : 'replay';
    stage.setView(v);
    if (v === 'replay' && stage.fpCam && stage.fpCam.setReplayView) stage.fpCam.setReplayView('broadcast');
    if (!chase && stage.app && stage.app.camera) chase = createChaseCam(stage.app.camera);
    if (chase) chase.snap();
    return v;
  }

  let barW = 0, barTick = 0;
  const listenerOut = { pos: { x: 0, y: 1.6, z: 8 }, fwd: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } };

  return {
    device,
    prefs,
    /** The input this visit boots with ('touch' = swipe mode, 'camera', or null for the app default). */
    input,
    swipe,
    /** Render tier to use ('mobile', registered on QUALITY) or null. */
    quality,
    controller,
    TOUCH,
    /**
     * Once at boot, after the UI, stage and audio exist. ctx: { canvas, stage, ui, handlers: {
     * pause(), skipReplay(), isPlaying(), isReplay(), unlockAudio() -> Promise<boolean>|boolean,
     * useCamera(), useSwipe() } }.
     */
    install(ctx = {}) {
      env = ctx;
      mount();
      if (ctx.stage && quality) limitShadowLights(ctx.stage.app && ctx.stage.app.scene, MOBILE_QUALITY.maxShadowLights);
      if (swipe && ctx.canvas) touch = bindTouchInput(ctx.canvas, { on: onTouchEvent, onTrail, stick: prefs.stick });
      globalThis.addEventListener('touchend', unlockOnce, true);
      globalThis.addEventListener('click', unlockOnce, true);
      refreshRotate();
    },
    /** A 'touch' session: drives the touch controller from the game's fixed ticks. */
    attachGame(g, { clock = null } = {}) {
      if (detach) detach();
      game = g;
      setSimTime(clock);
      controller.setHanded(g.world.settings.handed);
      detach = attachTouchGame(g, controller);
      if (chase) chase.snap();
      return detach;
    },
    detachGame() {
      if (detach) detach();
      detach = null;
      game = null;
      trails.clear();
      controller.setStick(0, 0, false);
    },
    enterPlayView,
    get view() { return prefs.view; },
    setView,
    setStick,
    /** stage.syncWorld({ selfActor }) in the behind view (null in first person or without a session). */
    selfActor(world) {
      if (prefs.view !== 'behind' || !game || !world) return null;
      return controller.selfActor(world);
    },
    /** After stage.syncWorld, before stage.render: the chase camera. */
    afterSync(world, dt) {
      if (prefs.view !== 'behind' || !chase || !world) return;
      chase.update(world, dt);
    },
    /** Spatial-audio listener in the behind view: the player's head (null: the camera's). */
    listener(world) {
      if (prefs.view !== 'behind' || !world || !world.player) return null;
      const p = world.player;
      listenerOut.pos.x = p.pos.x;
      listenerOut.pos.y = (p.height || 1.75) * 0.93;
      listenerOut.pos.z = p.pos.z;
      return listenerOut;
    },
    /** Every animation frame: stalled swipes, overlay visibility, trails. screen: ui.screen. */
    frame({ screen = null, playing = false, paused = false, replay = false, now = performance.now() } = {}) {
      if (touch) touch.poll(now);
      if (!el) return;
      const bar = el.querySelector('.vpm-bar');
      const gear = el.querySelector('.vpm-gear');
      const inPlay = !!(playing && !paused && !replay);
      if (bar) bar.hidden = !(swipe && inPlay);
      // The HUD's top bar (app.css .hud-bar: title left, score right) ends left of these buttons.
      if (bar && !bar.hidden && (barW === 0 || ++barTick % 60 === 0)) {
        const w = bar.offsetWidth;
        if (w && w !== barW) {
          barW = w;
          globalThis.document.documentElement.style.setProperty('--vpm-bar-w', `${w}px`);
        }
      }
      if (gear) gear.hidden = !(screen === 'hub' || screen === 'pause' || screen === 'training' || screen === 'settings');
      drawTrails(now);
      const chip = el.querySelector('.vpm-chip');
      if (chip && !chip.hidden && now - lastSwipe.at > 900) chip.hidden = true;
    },
    /** First-run tutorial (swipe mode only). */
    needsTutorial() {
      return swipe && !prefs.tutorialDone;
    },
    showTutorial,
    get tutorialOpen() { return !!tutorial; },
    openSheet,
    closeSheet,
    /** Shadow budget for a freshly built venue (stage.setVenue). */
    applyBudget(stage) {
      if (!quality || !stage || !stage.app) return 0;
      return limitShadowLights(stage.app.scene, MOBILE_QUALITY.maxShadowLights);
    },
    /**
     * The stage as app/wiring.js should see it in swipe mode: the behind (chase) view counts as a play
     * view, so the approach circle, contact ghost and timing ticks (wiring: stage.view === 'fp') show.
     * Identity when the stage has its own 'chase' view (stage.supportsChase) or in first person.
     */
    playStage(stage) {
      if (!stage || stage.supportsChase) return stage;
      return Object.create(stage, { view: { get: () => (stage.view === 'replay' && game && prefs.view === 'behind' ? 'fp' : stage.view) } });
    },
    get chase() { return chase; },
    get touch() { return touch; },
  };

  function setSimTime(clock) {
    // The controller converts touch timestamps with the app clock (pauses, slow motion).
    if (clock && typeof clock.simTimeOf === 'function') controller.setClock(clock.simTimeOf);
  }
}
