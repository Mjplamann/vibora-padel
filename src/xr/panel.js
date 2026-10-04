// Glasses settings / connect panel (DOM). Self-contained: the app mounts it into the Settings
// screen (.settings-grid, variant 'settings') and the Help screen (.help-grid, variant 'help');
// it binds its own controls (data-xr-* attributes, so the UI's own binders leave it alone),
// polls the glasses status at 4 Hz while it is in the document, and uses the app's CSS classes
// (set-group, skill-head, field, seg, switch, btn, tip) plus a small injected stylesheet.
import { installXrStyles } from './styles.js';
import { profileInfo } from './display.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function segHtml(key, options, value, label) {
  const btns = options.map(([v, text, sub]) => `<button type="button" role="radio" data-value="${esc(v)}" aria-checked="${String(v) === String(value)}">${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}</button>`).join('');
  return `<div class="seg" role="radiogroup" data-xr-seg="${esc(key)}" aria-label="${esc(label)}">${btns}</div>`;
}
function switchHtml(key, on, label) {
  return `<button type="button" class="switch" role="switch" data-xr-switch="${esc(key)}" aria-checked="${!!on}" aria-label="${esc(label)}"><span class="sw-track"><span class="sw-knob"></span></span><span class="sw-text">${on ? 'On' : 'Off'}</span></button>`;
}
function inlineField(label, es, control) {
  return `<div class="field field-inline"><span class="field-label">${esc(label)}<span class="es">${esc(es)}</span></span>${control}</div>`;
}
function field(label, es, control, extra = '') {
  return `<div class="field"><div class="field-head"><span class="field-label">${esc(label)}<span class="es">${esc(es)}</span></span>${extra}</div>${control}</div>`;
}

/** Setup guide (shared by both variants). */
export const SETUP_GUIDE = Object.freeze([
  '<b>Standard display mode.</b> On the glasses pick the standard, head-locked display (the picture stays in front of your eyes): <b>turn off their own 3DoF / anchored screen and Smooth Follow</b>. Víbora turns the view itself; with both on the court would move twice, and Smooth Follow slowly slides the view back to the centre.',
  '<b>Plug the glasses into the Mac</b> (USB‑C). In <b>System Settings → Displays</b> select the glasses, <b>Use as: Main display</b>, <b>1920 × 1200</b>, 60 Hz. For 3D, switch the glasses to their 3D side-by-side mode (3840 × 1200) and set <b>3D</b> below to On or Auto.',
  '<b>Camera far away.</b> The glasses cable keeps the Mac next to you, so its own camera is too close. Use an <b>iPhone as a wireless Continuity Camera 2.5–3 m away at chest height</b> (landscape, rear camera toward you, Center Stage off), or a USB webcam on a long active extension cable.',
  '<b>Dimming to maximum</b> for immersion, brightness up. Clear the play area first: you will not see the furniture, and keep the cable slack so a swing cannot pull the Mac.',
  '<b>3D (experimental):</b> in the glasses\' 3D side-by-side mode the menus look split between the eyes; set up in 2D, then switch the glasses to 3D for play. If the view turns the wrong way, run the <b>Axis test</b> or flip that axis.',
  '<b>Head tracking (Chrome / Edge):</b> click <b>Connect glasses</b> with the mouse or keyboard (the browser needs a real click) and pick the VITURE device. Face the TV spot you play towards and press <b>C</b> (or Home) to recentre; every drill recentres by itself. Safari has no WebHID: Glasses mode still gives the true-scale view and the compact HUD.',
]);

/**
 * @param {object} o
 * @param {object} o.glasses   createGlasses() controller
 * @param {'settings'|'help'} [o.variant]
 * @param {Document} [o.doc]
 * @param {(text:string) => void} [o.onToast]
 * @param {() => void} [o.onChange]   called after a setting changed (e.g. to re-install app.xr)
 */
export function createXrPanel({ glasses, variant = 'settings', doc = document, onToast = () => {}, onChange = () => {} }) {
  installXrStyles(doc);
  const el = doc.createElement('section');
  el.className = variant === 'help' ? 'help-col xr-panel' : 'set-group xr-panel';
  el.setAttribute('aria-label', 'VITURE glasses');
  const s = glasses.settings;
  const st0 = glasses.status();
  const guide = `<ol class="xr-guide">${SETUP_GUIDE.map((li) => `<li>${li}</li>`).join('')}</ol>`;
  const statusHtml = `<p class="xr-status" role="status" aria-live="polite"><span class="xr-dot" data-xr="dot"></span><span data-xr="msg"></span></p>`;
  const connectRow = `<div class="btn-row">
      <button type="button" class="btn" data-xr-act="connect">Connect glasses<span class="es">Conectar gafas</span></button>
      <button type="button" class="btn" data-xr-act="recenter">Recenter · C<span class="es">Centrar</span></button>
      <button type="button" class="btn btn-ghost" data-xr-act="disconnect">Disconnect</button>
    </div>`;
  const safari = st0.supported ? '' : `<aside class="tip"><p class="tip-head">Safari · no head tracking</p><p>Head tracking reads the glasses' motion sensor over <b>WebHID</b>, which only Chrome and Edge have. Open Víbora in Chrome for head tracking; here Glasses mode gives the true-scale view and the compact HUD.</p></aside>`;

  if (variant === 'help') {
    el.innerHTML = `
      <div class="xr-head"><h3 class="skill-head">VITURE glasses<span class="es">Gafas VITURE</span></h3><span class="xr-badge">Experimental</span></div>
      <div class="xr-cols xr-cols-help">
        <div class="xr-col">
          ${statusHtml}
          ${inlineField('Glasses mode', 'Modo gafas', switchHtml('enabled', s.enabled, 'Glasses mode'))}
          ${connectRow}
          ${safari}
          <p class="xr-more">More glasses settings (view, 3D, axis test, diagnostics) are in <b>Settings</b>.</p>
        </div>
        <div class="xr-col">${guide}</div>
      </div>`;
  } else {
    el.innerHTML = `
      <div class="xr-head"><h3 class="skill-head">VITURE glasses<span class="es">Gafas VITURE</span></h3><span class="xr-badge">Experimental</span></div>
      <div class="xr-cols">
        <div class="xr-col">
          ${inlineField('Glasses mode', 'Modo gafas', switchHtml('enabled', s.enabled, 'Glasses mode'))}
          ${statusHtml}
          ${connectRow}
          ${safari}
          ${field('View', 'Vista', segHtml('profile', [['auto', 'Auto'], ['true', 'True scale', '33°'], ['wide', 'Wide', '50°'], ['tv', 'TV']], s.profile, 'View'), '<output class="field-val" data-xr="fov"></output>')}
          ${inlineField('Head tracking', 'Seguimiento de cabeza', switchHtml('headTracking', s.headTracking, 'Head tracking'))}
          ${inlineField('Compact HUD', 'Marcador compacto', switchHtml('compactHud', s.compactHud, 'Compact HUD'))}
          ${inlineField('Recenter at every drill', 'Centrar en cada ejercicio', switchHtml('autoRecenter', s.autoRecenter, 'Recenter at every drill'))}
        </div>
        <div class="xr-col">
          <div class="xr-axis">
            <div class="btn-row">
              <button type="button" class="btn" data-xr-act="axis">Axis test<span class="es">Prueba de ejes</span></button>
              <button type="button" class="btn btn-ghost" data-xr-act="axis-reset">Reset axes</button>
            </div>
            <p class="xr-axis-msg" data-xr="axis-msg">Turn your head left: did the view turn left? If not, flip that axis.</p>
            <div class="xr-bar" aria-hidden="true"><i data-xr="axis-bar"></i></div>
            <div class="xr-flips">
              <button type="button" class="btn" data-xr-flip="yaw" aria-pressed="false">Flip left / right</button>
              <button type="button" class="btn" data-xr-flip="pitch" aria-pressed="false">Flip up / down</button>
              <button type="button" class="btn" data-xr-flip="roll" aria-pressed="false">Flip tilt</button>
            </div>
          </div>
          ${field('Head prediction', 'Predicción', segHtml('predictMs', [['0', 'Off'], ['10', '10 ms'], ['20', '20 ms']], String(glasses.driver.config.predictMs), 'Head prediction'))}
          ${field('3D side-by-side', '3D lado a lado', segHtml('stereo', [['off', 'Off'], ['auto', 'Auto', '3840 wide'], ['on', 'On']], s.stereo, '3D side-by-side'))}
          ${field('3D layout', 'Formato 3D', segHtml('layout', [['auto', 'Auto'], ['full', 'Full', '3840×1200'], ['half', 'Half', '1920×1200']], s.layout, '3D layout'))}
          ${field('Eye distance (IPD)', 'Distancia entre ojos', `<div class="xr-ipd"><button type="button" class="btn" data-xr-act="ipd-" aria-label="Decrease IPD">−</button><output data-xr="ipd"></output><button type="button" class="btn" data-xr-act="ipd+" aria-label="Increase IPD">+</button></div>`)}
          ${inlineField('Smooth 3D edges', 'Bordes suaves en 3D', switchHtml('stereoPost', s.stereoPost, 'Smooth 3D edges'))}
        </div>
        <div class="xr-col">
          ${guide}
          <pre class="xr-readout" data-xr="diag" aria-label="Glasses diagnostics"></pre>
          <div class="btn-row"><button type="button" class="btn" data-xr-act="copy">Copy glasses diagnostics</button></div>
        </div>
      </div>`;
  }

  const q = (sel) => el.querySelector(sel);

  async function act(name) {
    switch (name) {
      case 'connect': {
        if (!glasses.enabled) glasses.enable(true);
        const ok = await glasses.connect();
        onToast(ok ? 'Glasses connected — head tracking on' : glasses.status().message);
        break;
      }
      case 'disconnect':
        await glasses.disconnect();
        break;
      case 'recenter':
        onToast(glasses.recenter() ? 'View recentred' : 'Connect the glasses first');
        break;
      case 'axis':
        if (!glasses.status().headTracking) {
          onToast('Connect the glasses (Chrome) to run the axis test');
          break;
        }
        glasses.axisTest.start();
        break;
      case 'axis-reset':
        glasses.axisTest.reset();
        onToast('Axes reset to the defaults');
        break;
      case 'ipd-':
      case 'ipd+':
        glasses.set({ ipdMm: glasses.settings.ipdMm + (name === 'ipd+' ? 1 : -1) });
        break;
      case 'copy':
        await copyDiagnostics();
        break;
      default:
        break;
    }
    onChange();
    refresh();
  }

  async function copyDiagnostics() {
    const text = JSON.stringify(glasses.diagnostics(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      onToast('Glasses diagnostics copied');
    } catch {
      const pre = q('[data-xr="diag"]');
      if (pre) {
        pre.textContent = text;
        const r = doc.createRange();
        r.selectNodeContents(pre);
        const sel = doc.getSelection && doc.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(r);
        }
      }
      onToast('Press ⌘C to copy the selected diagnostics');
    }
  }

  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-xr-act]');
    if (a && el.contains(a)) {
      if (!a.disabled) act(a.dataset.xrAct);
      return;
    }
    const f = e.target.closest('[data-xr-flip]');
    if (f && el.contains(f)) {
      glasses.axisTest.flip(f.dataset.xrFlip);
      onChange();
      refresh();
      return;
    }
    const sw = e.target.closest('[data-xr-switch]');
    if (sw && el.contains(sw)) {
      const key = sw.dataset.xrSwitch;
      glasses.set({ [key]: !glasses.settings[key] });
      onChange();
      refresh();
      return;
    }
    const b = e.target.closest('[data-xr-seg] [role="radio"]');
    if (b && el.contains(b)) {
      const key = b.closest('[data-xr-seg]').dataset.xrSeg;
      if (key === 'predictMs') glasses.setPredictMs(Number(b.dataset.value));
      else glasses.set({ [key]: b.dataset.value });
      onChange();
      refresh();
    }
  });

  function setText(sel, text) {
    const n = q(sel);
    if (n && n.textContent !== text) n.textContent = text;
  }

  function refresh() {
    const st = glasses.status();
    const S = st.settings;
    const dot = q('[data-xr="dot"]');
    if (dot) dot.dataset.state = st.enabled ? st.connection : 'off';
    setText('[data-xr="msg"]', st.message);
    el.querySelectorAll('[data-xr-switch]').forEach((sw) => {
      const on = !!S[sw.dataset.xrSwitch];
      sw.setAttribute('aria-checked', String(on));
      const t = sw.querySelector('.sw-text');
      if (t) t.textContent = on ? 'On' : 'Off';
    });
    el.querySelectorAll('[data-xr-seg]').forEach((g) => {
      const key = g.dataset.xrSeg;
      const v = key === 'predictMs' ? String(st.predictMs) : String(S[key]);
      g.querySelectorAll('[role="radio"]').forEach((r) => r.setAttribute('aria-checked', String(r.dataset.value === v)));
    });
    const conn = q('[data-xr-act="connect"]');
    if (conn) conn.disabled = !st.supported || st.connection === 'connecting';
    const dis = q('[data-xr-act="disconnect"]');
    if (dis) dis.disabled = !st.connected;
    const rec = q('[data-xr-act="recenter"]');
    if (rec) rec.disabled = !st.headTracking;
    const fi = profileInfo(S.profile, { headTracking: st.headTracking });
    setText('[data-xr="fov"]', fi.vertical ? `${fi.vertical.toFixed(1)}° × ${fi.horizontal.toFixed(1)}°` : 'TV');
    setText('[data-xr="ipd"]', `${S.ipdMm} mm`);
    const ax = st.axisTest;
    if (ax.state === 'running' || ax.state === 'failed' || ax.state === 'done') setText('[data-xr="axis-msg"]', `${ax.state === 'running' ? `${ax.index + 1}/${ax.count} · ` : ''}${ax.message}`);
    const bar = q('[data-xr="axis-bar"]');
    if (bar) bar.style.width = `${Math.round((ax.state === 'running' ? ax.progress : ax.state === 'done' ? 1 : 0) * 100)}%`;
    el.querySelectorAll('[data-xr-flip]').forEach((b) => b.setAttribute('aria-pressed', String(!!st.flips[b.dataset.xrFlip])));
    const diag = q('[data-xr="diag"]');
    if (diag) {
      const d = glasses.driver.diagnostics();
      const e = st.euler;
      const lines = [
        `status    ${d.status}${d.protocol ? ` · ${d.protocol}` : ''}`,
        `device    ${d.product ? `${d.product.model} ${d.product.vendorId}:${d.product.productId}` : '—'}`,
        `firmware  ${d.firmware || '—'}${d.displayMode ? ` · ${d.displayMode.label}` : ''}`,
        `rate      ${d.posesPerSec} poses/s · ${d.packetsPerSec} packets/s`,
        `head      ${e ? `yaw ${e.yaw.toFixed(1)}° pitch ${e.pitch.toFixed(1)}° roll ${e.roll.toFixed(1)}°` : '—'}`,
        `view      ${fi.vertical ? `${fi.vertical.toFixed(1)}° v` : 'TV fov'}${st.stereo ? ' · 3D SBS' : ''}`,
        `last      ${d.lastRaw || '—'}`,
        ...(d.errors.length ? [`errors    ${d.errors.slice(-3).join('\n          ')}`] : []),
      ];
      const text = lines.join('\n');
      if (diag.textContent !== text) diag.textContent = text;
    }
  }

  let timer = null;
  let unsub = null;
  function mount(parent) {
    if (!parent) return api;
    parent.appendChild(el);
    refresh();
    clearInterval(timer);
    timer = setInterval(() => {
      if (!el.isConnected) {
        unmount();
        return;
      }
      refresh();
    }, 250);
    if (!unsub) unsub = glasses.onChange(() => refresh());
    return api;
  }
  function unmount() {
    clearInterval(timer);
    timer = null;
    if (unsub) unsub();
    unsub = null;
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  const api = { el, mount, unmount, refresh };
  return api;
}
