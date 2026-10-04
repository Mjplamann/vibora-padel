// Calibration screen logic and panels for close mode (round 4). The first real player stood very
// far back because the old check wanted head to ankles in the picture; the tracker now also
// works from the upper body at 1.3–2.2 m (tracking/body.js CLOSE). This module decides the
// body step ("in frame": upper body accepted), the mode-aware distance meter (close 1.3–2.2 m,
// full body 2.2–3.5 m), the camera placement tip ("camera at chest height"), the stand-on-spot
// check and the play-area readout with the movement gains in use. ui.js renders these panels
// and calls update*() from its frame loop (calUpdate). The decisions are pure (Node tests).

/** Ideal distance (m) per tracking mode (tracking/body.js DISTANCE_RANGES). */
export const CAL_RANGES = Object.freeze({ upper: Object.freeze([1.3, 2.2]), full: Object.freeze([2.2, 3.5]) });
/** Distance meter scale (m). */
export const CAL_SCALE = Object.freeze([1.0, 4.6]);
/** Seconds the body check must hold before the step auto-advances. */
export const BODY_HOLD_S = 1.5;
/** Parts shown in the body check: [id, EN, ES, needed in close mode]. */
export const CAL_PARTS = Object.freeze([
  ['head', 'Head', 'Cabeza', true], ['shoulders', 'Shoulders', 'Hombros', true], ['hips', 'Hips', 'Cadera', false],
  ['knees', 'Knees', 'Rodillas', false], ['ankles', 'Ankles', 'Tobillos', false],
]);
/** Step list for the stepper (replaces ui.js CAL_STEPS: the first step no longer asks for the full body). */
export const CAL_STEPS_CLOSE = Object.freeze([
  { id: 'body', en: 'In frame', es: 'Encuadre' },
  { id: 'spot', en: 'Your spot', es: 'Tu sitio' },
  { id: 'profile', en: 'Profile', es: 'Perfil' },
  { id: 'latency', en: 'Latency', es: 'Latencia', optional: true },
  { id: 'area', en: 'Play area', es: 'Zona de juego' },
]);
export const CAMERA_TIP = Object.freeze({
  en: 'Camera at chest height (about 1.2–1.4 m) and level: a MacBook on a shelf or a stack of books, screen upright. Close (1.3–2.2 m) the camera only needs your head, shoulders and arms.',
  es: 'Cámara a la altura del pecho (1,2–1,4 m) y recta. De cerca (1,3–2,2 m) basta con ver cabeza, hombros y brazos.',
});

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isNum = Number.isFinite;

/** Position (0..1) of a distance on the meter. */
export const distPos = (d) => clamp((d - CAL_SCALE[0]) / (CAL_SCALE[1] - CAL_SCALE[0]), 0, 1);

/**
 * The body check from the live calibration status (main.js ui.calibration payload):
 * { visible: {head, shoulders, hips, knees, ankles}, bodyInFrame, distance, still, tracking,
 *   trackMode ('full' | 'upper' from the tracker), upper (head + shoulders in view) }.
 * @returns {{ mode: 'full'|'upper'|'none', parts, needed: string[], inFrame, dist, range: [lo, hi],
 *   distOk, ok, msg, es, level: 'ok'|'warn'|'off', tracking }}
 */
export function bodyCheck(st = {}) {
  const vis = { ...(st.visible || {}) };
  const bif = isNum(st.bodyInFrame) ? st.bodyInFrame : null;
  const all = ['head', 'shoulders', 'hips', 'knees', 'ankles'].every((p) => vis[p]);
  const upper = st.upper !== undefined ? !!st.upper : !!(vis.head && vis.shoulders);
  // The legs decide the mode: whole body when every part is in view, else the upper body (the
  // tracker switches the same way, with hysteresis: tracking/body.js CLOSE).
  const mode = all ? 'full' : upper ? 'upper' : 'none';
  const range = CAL_RANGES[mode === 'full' ? 'full' : 'upper'];
  const dist = isNum(st.distance) ? st.distance : null;
  const inFrame = mode !== 'none';
  const distOk = dist !== null && dist >= range[0] - 0.05 && dist <= range[1] + 0.05;
  const tracking = st.tracking || (bif ? 'ok' : 'searching');
  let msg, es;
  if (tracking === 'searching' && !bif) {
    msg = 'Waiting for the camera to find you…';
    es = 'Buscándote…';
  } else if (!vis.shoulders) {
    msg = 'Step back a little so your shoulders are in the picture.';
    es = 'Retrocede un poco: que se vean los hombros.';
  } else if (!vis.head) {
    msg = 'Can’t see your head. Raise the camera to chest height or step back.';
    es = 'No se ve la cabeza: sube la cámara o retrocede.';
  } else if (dist === null) {
    msg = 'Hold still…';
    es = 'Quieto…';
  } else if (dist < range[0] - 0.05) {
    msg = `Step back about ${Math.round((range[0] + 0.15 - dist) * 100)} cm`;
    es = 'Un paso atrás';
  } else if (mode === 'upper' && dist > range[1] + 0.05) {
    msg = 'Come closer (1.3–2.2 m), or step back until your feet are in view (2.2–3.5 m)';
    es = 'Acércate (1,3–2,2 m) o aléjate hasta ver los pies';
  } else if (dist > range[1] + 0.05) {
    msg = `Come closer about ${Math.round((dist - range[1] + 0.15) * 100)} cm`;
    es = 'Acércate un poco';
  } else if (mode === 'upper') {
    msg = 'Close mode: upper body tracked. Perfect, hold it there…';
    es = 'Modo cercano: perfecto, quieto…';
  } else {
    msg = 'Full body in view. Perfect, hold it there…';
    es = 'Cuerpo entero: ¡perfecto!';
  }
  const ok = inFrame && distOk;
  const needed = mode === 'full' ? ['head', 'shoulders', 'hips', 'knees', 'ankles'] : ['head', 'shoulders'];
  return { mode, parts: vis, needed, inFrame, dist, range, distOk, ok, msg, es, level: ok ? 'ok' : bif ? 'warn' : 'off', tracking, bif };
}

/** Stand-on-your-spot check: the upper body in view (close mode accepted) and still. */
export function spotCheck(st = {}) {
  const c = bodyCheck(st);
  return { inFrame: c.inFrame, still: st.still !== false, ok: c.inFrame && st.still !== false, mode: c.mode };
}

/**
 * Play-area readout: the real offset and where it puts the player on court with the gains in use
 * (a close-mode calibration boosts them: tracking/locomotion.js closeRangeBoost).
 * @param off { x, d } m from the calibrated spot
 * @param s settings { gainLateral, gainDepth }
 * @param boost { lateral, depth } (default 1)
 */
export function areaReadout(off, s, boost = null) {
  const bl = boost && isNum(boost.lateral) ? boost.lateral : 1;
  const bd = boost && isNum(boost.depth) ? boost.depth : 1;
  const sgn = (v, d) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)} m`;
  if (!off || !isNum(off.x) || !isNum(off.d)) return null;
  return {
    x: sgn(off.x, 2), d: sgn(off.d, 2),
    courtX: sgn(off.x * s.gainLateral * bl, 1), courtZ: sgn(off.d * s.gainDepth * bd, 1),
    gains: { lateral: s.gainLateral * bl, depth: s.gainDepth * bd },
  };
}

/** Area step targets: how far (m) each direction must be stepped in a mode (close: smaller room). */
export function areaStep(mode) {
  return mode === 'upper' ? 0.2 : 0.3;
}

// ---------------------------------------------------------------------------------------
// Panels (HTML strings in the existing calibration styles) and in-place updates.

/**
 * The body step panel. o: { esc (HTML escape), check (ICON.check svg) }.
 * Keys for update: data-part, data-k="mode", "bif", "bif-bar", "dist", "dist-mark", "ideal-upper",
 * "ideal-full", "msg", "next", "tip".
 */
export function bodyPanelHtml({ esc = (t) => String(t), check = '' } = {}) {
  const band = (key, r, label) => `<span class="dm-ideal" data-k="ideal-${key}" data-label="${label}" style="left:${distPos(r[0]) * 100}%;width:${(distPos(r[1]) - distPos(r[0])) * 100}%"></span>`;
  return `
    <h3 class="cal-title">Step into frame<span class="es">Entra en el encuadre</span></h3>
    <p class="cal-lead">Stand <b>1.3–2.2 m</b> from the camera (close: head, shoulders and arms in view) or <b>2.2–3.5 m</b> (head to ankles).</p>
    <div class="parts" role="list">${CAL_PARTS.map(([id, en, es, need]) => `<span class="part" role="listitem" data-part="${id}"${need ? '' : ' data-optional="1"'}><i>${check}</i>${esc(en)}<small>${esc(es)}</small></span>`).join('')}</div>
    <div class="meter-row"><span class="meter-label">Tracking<span class="es">Seguimiento</span></span><span class="meter-val" data-k="mode">—</span></div>
    <div class="bar-meter" data-k="bif-bar"><i></i></div>
    <div class="meter-row"><span class="meter-label">Distance to camera<span class="es">Distancia</span></span><span class="meter-val" data-k="dist">—</span></div>
    <div class="dist-meter" aria-hidden="true">
      ${band('upper', CAL_RANGES.upper, 'Close')}${band('full', CAL_RANGES.full, 'Full body')}
      <span class="dm-mark" data-k="dist-mark"></span>
      ${[1.3, 2.2, 3.5, 4.5].map((v) => `<span class="dm-tick" style="left:${distPos(v) * 100}%">${v.toFixed(1)}</span>`).join('')}
    </div>
    <p class="cal-msg" data-k="msg" aria-live="polite"></p>
    <p class="cal-lead cal-tip" data-k="tip">${esc(CAMERA_TIP.en)}<span class="es">${esc(CAMERA_TIP.es)}</span></p>
    <div class="btn-row"><button type="button" class="btn btn-lg" data-action="cal-next" data-k="next" data-autofocus data-focus-key="cal-next">Continue<span class="es">Seguir</span></button></div>`;
}

const setText = (el, t) => {
  if (el && el.textContent !== t) el.textContent = t;
};

/**
 * In-place update of the body panel. Returns the check. calib: ui.js state.calib ({ okSince,
 * auto }); nowMs: performance.now(). Sets calib.advance = true once ok has held BODY_HOLD_S.
 */
export function updateBodyPanel(scope, status, calib = null, nowMs = 0) {
  const c = bodyCheck(status);
  const q = (k) => scope.querySelector(`[data-k="${k}"]`);
  for (const [id, , , need] of CAL_PARTS) {
    const el = scope.querySelector(`[data-part="${id}"]`);
    if (!el) continue;
    el.classList.toggle('on', !!c.parts[id]);
    // Close mode: the legs are optional (dimmed when not seen).
    el.style.opacity = !need && c.mode !== 'full' && !c.parts[id] ? '0.45' : '';
  }
  setText(q('mode'), c.mode === 'full' ? 'Full body' : c.mode === 'upper' ? 'Close · upper body' : '—');
  const bar = q('bif-bar');
  if (bar) {
    const n = c.needed.filter((p) => c.parts[p]).length / c.needed.length;
    bar.style.setProperty('--p', c.bif == null ? 0 : n);
    bar.classList.toggle('ok', c.inFrame);
  }
  setText(q('dist'), c.dist == null ? '—' : `${c.dist.toFixed(1)} m`);
  const mk = q('dist-mark');
  if (mk) {
    mk.style.left = `${distPos(c.dist ?? CAL_SCALE[0]) * 100}%`;
    mk.hidden = c.dist == null;
    mk.classList.toggle('ok', c.distOk);
  }
  const active = c.mode === 'full' ? 'full' : c.mode === 'upper' ? 'upper' : null;
  for (const key of ['upper', 'full']) {
    const b = q(`ideal-${key}`);
    if (b) b.style.opacity = !active || active === key ? '' : '0.35';
  }
  setText(q('msg'), c.msg);
  q('msg')?.classList.toggle('ok', c.ok);
  q('next')?.classList.toggle('go', c.ok);
  if (calib) {
    if (c.ok) {
      if (calib.okSince == null) calib.okSince = nowMs;
      calib.advance = calib.auto !== false && nowMs - calib.okSince > BODY_HOLD_S * 1000;
    } else {
      calib.okSince = null;
      calib.advance = false;
    }
  }
  return c;
}
