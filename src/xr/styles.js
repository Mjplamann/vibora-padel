// CSS for glasses mode and the glasses panel, injected once as a <style> element (this module
// owns no stylesheet file; it reuses the app's tokens from styles/app.css).
//
//   html.xr-glasses  glasses mode on
//   html.xr-compact  compact HUD: the glasses show the whole 1920×1200 picture across ~50° of
//                    view (a TV at 3 m is ~22°), so text is drawn ~40 % smaller and kept away
//                    from the edges, which sit in the blurrier periphery of the optics
//   html.xr-stereo   3D side-by-side during play: DOM overlays would be split between the eyes,
//                    so they are hidden; the in-world stereo HUD (stereo.js) replaces them

export const XR_STYLE_ID = 'vp-xr-style';

export const XR_CSS = `
html.xr-compact { font-size: clamp(13px, 1.0vw, 24px); --safe-x: 11vw; --safe-y: 9vh; }
html.xr-compact .vp-hud .hud-tl .pip { width: 9rem; height: auto; aspect-ratio: 4 / 3; opacity: 0.75; }
html.xr-stereo .vp-hud, html.xr-stereo .vp-banner, html.xr-stereo .vp-toasts, html.xr-stereo .vp-replay { visibility: hidden !important; }

.xr-panel { grid-column: 1 / -1; margin-top: 0.4rem; }
.xr-panel .xr-cols { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1.5rem; align-items: start; }
.xr-panel .xr-cols-help { grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); }
.xr-more { font-size: 0.6rem; color: var(--text-3); margin: 0; line-height: 1.35; }
.xr-panel .xr-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.xr-panel .xr-badge { font: 700 0.5rem var(--f-ui); letter-spacing: 0.16em; text-transform: uppercase; color: var(--warn); border: var(--hair) solid currentColor; padding: 0.15em 0.5em; border-radius: var(--r); }
.xr-status { display: flex; gap: 0.55rem; align-items: flex-start; margin: 0 0 0.7rem; font-size: 0.66rem; color: var(--text-2); line-height: 1.35; }
.xr-dot { flex: none; width: 0.6rem; height: 0.6rem; border-radius: 50%; margin-top: 0.25em; background: var(--text-3); box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.4); }
.xr-dot[data-state="streaming"] { background: var(--ball); box-shadow: 0 0 0.6rem var(--ball-glow); }
.xr-dot[data-state="waiting"], .xr-dot[data-state="connecting"], .xr-dot[data-state="stalled"] { background: var(--warn); }
.xr-dot[data-state="error"], .xr-dot[data-state="no-data"], .xr-dot[data-state="disconnected"], .xr-dot[data-state="unsupported"] { background: var(--bad); }
.xr-panel .btn-row { margin: 0 0 0.7rem; }
.xr-panel .btn[disabled] { opacity: 0.45; cursor: default; }
.xr-readout { font: 600 0.58rem/1.45 ui-monospace, 'SF Mono', Menlo, monospace; color: var(--text-2); background: rgba(3, 6, 11, 0.55); border: var(--hair) solid var(--glass-faint); padding: 0.5rem 0.65rem; margin: 0 0 0.7rem; max-height: 11rem; overflow: auto; white-space: pre-wrap; word-break: break-all; user-select: text; -webkit-user-select: text; }
.xr-axis { margin: 0 0 0.7rem; }
.xr-axis-msg { font-size: 0.66rem; color: var(--text); margin: 0 0 0.35rem; min-height: 1.3em; }
.xr-bar { height: 0.32rem; background: rgba(139, 228, 238, 0.12); border-radius: 2px; overflow: hidden; }
.xr-bar i { display: block; height: 100%; width: 0; background: var(--glass); transition: width 120ms linear; }
.xr-flips { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.45rem 0 0; }
.xr-flips .btn { min-height: 1.6rem; font-size: 0.56rem; padding: 0.35em 0.7em; }
.xr-flips .btn[aria-pressed="true"] { border-color: var(--glass); color: var(--glass); }
.xr-ipd { display: flex; align-items: center; gap: 0.5rem; }
.xr-ipd output { font: 800 0.86rem/1 var(--f-display); color: var(--glass); min-width: 4.2em; text-align: center; font-variant-numeric: tabular-nums; }
.xr-guide { margin: 0; padding: 0; list-style: none; counter-reset: xrg; }
.xr-guide li { counter-increment: xrg; position: relative; padding-left: 1.6rem; margin: 0 0 0.5rem; font-size: 0.64rem; line-height: 1.38; color: var(--text-2); }
.xr-guide li::before { content: counter(xrg); position: absolute; left: 0; top: 0; font: 800 0.8rem/1 var(--f-display); color: var(--glass); }
.xr-guide b { color: var(--text); }
.xr-panel .tip { margin-bottom: 0.7rem; }
@media (max-width: 1100px) { .xr-panel .xr-cols { grid-template-columns: 1fr; } }
`;

/** Injects the stylesheet once (idempotent). */
export function installXrStyles(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc || !doc.head || doc.getElementById(XR_STYLE_ID)) return;
  const el = doc.createElement('style');
  el.id = XR_STYLE_ID;
  el.textContent = XR_CSS;
  doc.head.appendChild(el);
}
