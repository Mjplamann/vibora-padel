// Glasses mode (VITURE Beast and other VITURE XR glasses plugged into the Mac as a display).
//
// Owns its settings (persisted under 'vibora.xr.v1'), the WebHID head-tracking driver
// (viture.js), the optional side-by-side stereo renderer (stereo.js) and exposes the stage's XR
// integration object (SPEC §6.8, read live by fpCamera.js / stage.js):
//   xr.getHeadQuaternion() -> {x,y,z,w} | null   relative since the last recentre, three.js camera
//                                               convention; null unless glasses mode + head
//                                               tracking are on and the glasses stream a pose
//   xr.fov / xr.fovOverride                      vertical FOV (deg) of the view profile, or undefined
//   xr.stereo = { enabled, ipd, render(renderer, scene, camera, composer) }
//   xr.eyeOffset                                 {back, down} to use instead of the TV framing
//                                               offset while head tracking (true eye position)
//   xr.hud.update(hudState)                      feeds the in-world stereo HUD
// Pure apart from the injected hid / storage / stereo factory, so the contract is tested in Node.
import { createVitureDriver } from './viture.js';
import { createAxisTest } from './axis.js';
import { profileFov, profileInfo, PROFILE_IDS, clampIpdMm, isFullSbsAspect, BEAST } from './display.js';

export const GLASSES_STORAGE_KEY = 'vibora.xr.v1';
const TRUE_EYE = Object.freeze({ back: 0, down: 0 });

export const GLASSES_DEFAULTS = Object.freeze({
  enabled: false, // glasses mode
  profile: 'auto', // 'auto' | 'true' | 'wide' | 'tv'
  headTracking: true, // use the glasses' IMU when connected (Chrome)
  stereo: 'off', // 'off' | 'auto' (3D when the output is 3840×1200 / the glasses report 3D) | 'on'
  layout: 'auto', // 'auto' | 'full' | 'half'
  ipdMm: BEAST.ipdMm,
  compactHud: true,
  autoRecenter: true, // recentre at every drill / rally start
  autoConnect: true, // reopen glasses granted earlier, without a prompt
  stereoPost: true, // anti-aliased stereo (own composer); off = fastest
});

/** Validated settings. */
export function sanitizeGlassesSettings(s = {}) {
  const d = GLASSES_DEFAULTS;
  return {
    enabled: s.enabled === true,
    profile: PROFILE_IDS.includes(s.profile) ? s.profile : d.profile,
    headTracking: s.headTracking !== false,
    stereo: ['off', 'auto', 'on'].includes(s.stereo) ? s.stereo : d.stereo,
    layout: ['auto', 'full', 'half'].includes(s.layout) ? s.layout : d.layout,
    ipdMm: clampIpdMm(s.ipdMm ?? d.ipdMm),
    compactHud: s.compactHud !== false,
    autoRecenter: s.autoRecenter !== false,
    autoConnect: s.autoConnect !== false,
    stereoPost: s.stereoPost !== false,
  };
}

/**
 * @param {object} [o]
 * @param {{getItem,setItem}|null} [o.storage]
 * @param {object|null} [o.hid]          navigator.hid (default) or a simulated one
 * @param {object|null} [o.driver]       an existing driver (tests)
 * @param {() => number} [o.now]
 * @param {(opts) => object} [o.createStereo]  stereo renderer factory (browser: stereo.js); null in Node
 * @param {{width:number,height:number}|(() => {width,height})} [o.viewport]  output size for 'auto' stereo
 * @param {Document|null} [o.doc]        document for the CSS classes (null in Node)
 */
export function createGlasses({
  storage = null, hid, driver = null, now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  createStereo = null, viewport = null, doc = typeof document !== 'undefined' ? document : null, setTimer, clearTimer,
} = {}) {
  let S = sanitizeGlassesSettings(load());
  let stored = { ...S }; // what is persisted (URL flags change S for this visit only)
  const drv = driver || createVitureDriver({ hid, storage, now, ...(setTimer ? { setTimer } : {}), ...(clearTimer ? { clearTimer } : {}) });
  const listeners = new Set();
  let playing = false;
  let stereo = null; // created lazily (three.js)
  const axis = createAxisTest();
  let axisUnsub = null;
  let axisResult = null;
  let lastHud = null;

  function load() {
    try {
      const raw = storage && storage.getItem(GLASSES_STORAGE_KEY);
      return raw ? JSON.parse(raw) || {} : {};
    } catch {
      return {};
    }
  }
  function save() {
    try {
      storage && storage.setItem(GLASSES_STORAGE_KEY, JSON.stringify(stored));
    } catch {
      /* ignore */
    }
  }
  function emit() {
    applyDocument();
    for (const fn of listeners) {
      try {
        fn(api);
      } catch {
        /* ignore */
      }
    }
  }
  drv.onChange(() => emit());

  const headLive = () => S.enabled && S.headTracking && drv.streaming;

  function outputSize() {
    if (typeof viewport === 'function') return viewport();
    if (viewport) return viewport;
    if (typeof window !== 'undefined') return { width: window.innerWidth, height: window.innerHeight };
    return { width: 1920, height: 1200 };
  }

  /** 3D side-by-side wanted right now (setting, detection, play context). */
  function stereoWanted() {
    if (!S.enabled || S.stereo === 'off' || !playing) return false;
    if (S.stereo === 'on') return true;
    const vp = outputSize();
    const dm = drv.displayMode;
    return isFullSbsAspect(vp.width, vp.height) || !!(dm && dm.sbs);
  }

  function ensureStereo() {
    if (!stereo && createStereo) {
      stereo = createStereo({ ipd: S.ipdMm / 1000, layout: S.layout, post: S.stereoPost });
      if (stereo.hud && lastHud) stereo.hud.update(lastHud);
    }
    if (stereo) {
      stereo.ipd = S.ipdMm / 1000;
      stereo.layout = S.layout;
      stereo.post = S.stereoPost;
    }
    return stereo;
  }

  // ---- the app.xr object (stable identity) -----------------------------------------

  const stereoFacade = {
    get enabled() {
      return stereoWanted() && !!ensureStereo();
    },
    get ipd() { return S.ipdMm / 1000; },
    get layout() { return S.layout; },
    render(renderer, scene, camera, composer) {
      const st = ensureStereo();
      if (st) st.render(renderer, scene, camera, composer);
    },
    get stats() { return stereo ? stereo.stats : null; },
  };

  const xr = {
    getHeadQuaternion() {
      if (!headLive()) return null;
      return drv.getQuaternion(now());
    },
    get fov() {
      if (!S.enabled) return undefined;
      const v = profileFov(S.profile, { headTracking: headLive() });
      return v || undefined;
    },
    get fovOverride() { return this.fov; },
    stereo: stereoFacade,
    /** Viewpoint offset while head tracking: the true eye position (TV framing off). */
    get eyeOffset() { return headLive() ? TRUE_EYE : null; },
    hud: {
      update(h) {
        lastHud = h;
        if (stereo && stereo.hud) stereo.hud.update(h);
      },
    },
    get headTracking() { return headLive(); },
  };

  // ---- controls ---------------------------------------------------------------------

  /** Changes settings; { persist: false } applies them to this visit only (URL flags). */
  function set(patch = {}, { persist = true } = {}) {
    const prev = S;
    S = sanitizeGlassesSettings({ ...S, ...patch });
    if (persist) {
      stored = sanitizeGlassesSettings({ ...stored, ...patch });
      save();
    }
    if (S.enabled && !prev.enabled && S.autoConnect && S.headTracking && drv.supported && !drv.connected) drv.autoConnect();
    if (stereo) ensureStereo();
    emit();
    return S;
  }

  function recenter() {
    const ok = drv.recenter();
    emit();
    return ok;
  }

  /** Called by the app at drill / rally / match start. */
  function onSessionStart() {
    if (S.enabled && S.autoRecenter) recenter();
  }

  /** Play context: stereo only renders during play (menus are DOM, which cannot be stereo). */
  function setPlaying(on) {
    const v = !!on;
    if (v === playing) return;
    playing = v;
    applyDocument();
  }

  // Axis test: device quaternions from the driver feed the guided test; the result becomes the
  // driver's remap (flips reset).
  const axisTest = {
    start() {
      axisResult = null;
      axis.start();
      if (axisUnsub) axisUnsub();
      const q = drv.deviceQuaternion;
      if (q) axis.feed(q);
      axisUnsub = drv.onPose((dq) => {
        const st = axis.feed(dq);
        if (st.state === 'done' || st.state === 'failed') {
          if (st.state === 'done') {
            axisResult = axis.result();
            drv.setConfig({ remap: { src: axisResult.src, sign: axisResult.sign }, flip: { yaw: false, pitch: false, roll: false } });
          }
          if (axisUnsub) axisUnsub();
          axisUnsub = null;
          emit();
        }
      });
      emit();
      return axis.status();
    },
    cancel() {
      axis.cancel();
      if (axisUnsub) axisUnsub();
      axisUnsub = null;
      emit();
    },
    get status() { return axis.status(); },
    get result() { return axisResult; },
    /** Manual answer to "did the view turn the right way?": false flips that axis. */
    answer(axisId, correct) {
      if (correct || !['yaw', 'pitch', 'roll'].includes(axisId)) return drv.config.flip;
      const f = { ...drv.config.flip, [axisId]: !drv.config.flip[axisId] };
      drv.setConfig({ flip: f });
      return f;
    },
    flip(axisId) {
      return this.answer(axisId, false);
    },
    reset() {
      drv.setConfig({ remap: { src: [0, 1, 2], sign: [1, 1, 1] }, flip: { yaw: false, pitch: false, roll: false } });
      axisResult = null;
    },
  };

  /**
   * Recentre keys while head tracking runs: lowercase c (Shift+C keeps the UI's camera PiP
   * toggle) and Home (not inside a slider or text field, where Home has its own meaning).
   * Returns true if it consumed the key.
   */
  function handleKey(e) {
    if (!S.enabled || !e || e.metaKey || e.ctrlKey || e.altKey || !headLive()) return false;
    const k = e.key;
    const tg = e.target;
    const inControl = !!(tg && typeof tg.closest === 'function' && tg.closest('input, textarea, select, [contenteditable], [role="slider"], [data-range], .range-track'));
    if ((k === 'c' && !e.shiftKey) || (k === 'Home' && !inControl)) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      recenter();
      return true;
    }
    return false;
  }

  /** Capture-phase listener that stops the event, so the UI's own C (camera PiP) does not also fire. */
  function installKeys(target = typeof window !== 'undefined' ? window : null, onRecenter = null) {
    if (!target) return () => {};
    const fn = (e) => {
      if (!handleKey(e)) return;
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      if (onRecenter) onRecenter();
    };
    target.addEventListener('keydown', fn, true);
    return () => target.removeEventListener('keydown', fn, true);
  }

  /** CSS classes on <html>: xr-glasses (mode on), xr-compact (compact HUD), xr-stereo (3D in play). */
  function applyDocument() {
    const root = doc && doc.documentElement;
    if (!root || !root.classList) return;
    root.classList.toggle('xr-glasses', S.enabled);
    root.classList.toggle('xr-compact', S.enabled && S.compactHud);
    root.classList.toggle('xr-stereo', S.enabled && stereoWanted());
  }

  /** Everything the UI needs to draw the panel / a status chip. */
  function status() {
    const head = headLive();
    const prof = profileInfo(S.profile, { headTracking: head });
    const ds = drv.status;
    let message;
    if (!S.enabled) message = 'Glasses mode is off';
    else if (!drv.supported) message = 'Head tracking needs Chrome or Edge (WebHID). Glasses mode still gives the true-scale view and compact HUD.';
    else if (!S.headTracking) message = 'Head tracking off: the view follows the ball like on the TV';
    else if (ds === 'streaming') message = `Head tracking on · ${drv.protocol === 'v2' ? 'pose stream' : 'legacy IMU'} · C recentres`;
    else if (ds === 'stalled') message = 'No data from the glasses for a second — check the cable';
    else message = drv.message;
    return {
      enabled: S.enabled,
      settings: { ...S },
      supported: drv.supported,
      connection: ds,
      connected: drv.connected,
      protocol: drv.protocol,
      headTracking: head,
      stereo: S.enabled && stereoWanted(),
      playing,
      fov: prof,
      message,
      euler: head ? drv.getEuler(now()) : null,
      axisTest: axis.status(),
      axisResult,
      flips: { ...drv.config.flip },
      predictMs: drv.config.predictMs,
    };
  }

  function diagnostics() {
    const st = status();
    return {
      glasses: { enabled: st.enabled, settings: st.settings, headTracking: st.headTracking, stereo: st.stereo, fov: st.fov, playing },
      driver: drv.diagnostics(),
      stereo: stereo ? { ...stereo.stats } : null,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'node',
      webhid: drv.supported,
    };
  }

  const api = {
    xr,
    driver: drv,
    get settings() { return { ...S }; },
    get enabled() { return S.enabled; },
    set,
    enable(on = true, opts) {
      return set({ enabled: !!on }, opts);
    },
    connect: () => drv.connect(),
    disconnect: () => drv.disconnect(),
    autoConnect: () => (S.enabled && S.autoConnect && S.headTracking ? drv.autoConnect() : Promise.resolve(false)),
    recenter,
    onSessionStart,
    setPlaying,
    axisTest,
    handleKey,
    installKeys,
    applyDocument,
    status,
    diagnostics,
    /** For the app: the integration object to install (stage.setXR) — null while glasses mode is off. */
    get active() { return S.enabled ? xr : null; },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setPredictMs(ms) {
      drv.setConfig({ predictMs: ms });
      emit();
    },
    dispose() {
      if (axisUnsub) axisUnsub();
      if (stereo) stereo.dispose();
      drv.dispose();
      listeners.clear();
    },
  };
  applyDocument();
  return api;
}
