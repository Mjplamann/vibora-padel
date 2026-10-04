// One-call integration of glasses mode into the app (main.js): creates the controller with the
// stereo renderer, keeps stage.app.xr in sync (stage.setXR), the recentre keys, the per-frame
// play context and viewpoint offset, the stereo HUD feed, the Settings / Help panels and the
// URL flags ?glasses=1 (glasses mode for this visit) and ?xrsim=1|legacy (a simulated pair of
// glasses sweeping the head ±25°, for demos and tests without the hardware).
import { createGlasses } from './glasses.js';
import { createStereoRenderer } from './stereo.js';
import { createXrPanel } from './panel.js';
import { installXrStyles } from './styles.js';
import { createSimulatedGlasses, yawSweep } from './sim.js';

/**
 * @param {object} o
 * @param {object} o.stage      app/stage.js stage (setXR, viewSettings)
 * @param {object} o.settings   the app's live settings (S): its eyeOffset is restored when head tracking stops
 * @param {object} [o.storage]  safeStorage()
 * @param {HTMLElement} [o.uiRoot]
 * @param {(text:string) => void} [o.toast]
 * @param {string} [o.search]   location.search
 */
export function installGlasses({ stage, settings, storage = null, uiRoot = null, toast = () => {}, search = typeof location !== 'undefined' ? location.search : '' }) {
  installXrStyles();
  const qs = new URLSearchParams(search || '');
  const simKind = qs.get('xrsim');
  let sim = null;
  let hid;
  if (simKind === '1' || simKind === 'v2' || simKind === 'legacy') {
    sim = createSimulatedGlasses({ protocol: simKind === 'legacy' ? 'legacy' : 'v2', pose: yawSweep({ amplitudeDeg: 25, periodMs: 6000, t0: performance.now() }) });
    sim.start(120);
    hid = sim.hid;
  }
  const glasses = createGlasses({
    storage,
    hid,
    createStereo: (o) => createStereoRenderer(o),
    viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
  });
  if (qs.get('glasses') === '1' || sim) glasses.enable(true, { persist: false });
  if (qs.get('stereo') === '1') glasses.set({ stereo: 'on' }, { persist: false });

  const sync = () => stage.setXR(glasses.active);
  glasses.onChange(sync);
  sync();
  glasses.installKeys(window, () => toast('View recentred · Vista centrada'));
  if (sim) glasses.connect();
  else if (glasses.enabled) glasses.autoConnect();

  let lastEyeOffset = null;
  const panels = [];

  return {
    glasses,
    sim,
    /** Once per display frame, BEFORE stage.syncWorld. playing: first-person play on screen. */
    frame({ playing = false } = {}) {
      glasses.setPlaying(playing);
      const off = glasses.enabled ? glasses.xr.eyeOffset : null;
      const want = off || settings.eyeOffset;
      if (want !== lastEyeOffset || stage.viewSettings.eyeOffset !== want) {
        stage.viewSettings.eyeOffset = want;
        lastEyeOffset = want;
      }
    },
    /** The 10 Hz HUD state (same object as ui.hud) for the in-world stereo HUD. */
    hud(h) {
      glasses.xr.hud.update(h);
    },
    /** At every drill / rally / match start. */
    onSessionStart() {
      glasses.onSessionStart();
    },
    /** ui handlers.onScreen: mounts the glasses panel into Settings and Help. */
    onScreen(name) {
      if (!uiRoot) return;
      const host = name === 'settings' ? uiRoot.querySelector('.screen-settings .settings-grid')
        : name === 'help' ? uiRoot.querySelector('.screen-help .help-grid') : null;
      if (!host || host.querySelector('.xr-panel')) return;
      const p = createXrPanel({ glasses, variant: name === 'help' ? 'help' : 'settings', onToast: toast, onChange: sync });
      p.mount(host);
      panels.push(p);
      while (panels.length > 4) panels.shift().unmount();
    },
    diagnostics() {
      return glasses.diagnostics();
    },
  };
}
