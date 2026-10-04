// Hand cursor (SPEC §8): the raised hand drives an on-screen pointer, hovering an
// interactive element for `dwellMs` clicks it, and holding both hands above the
// head for `pauseHoldMs` fires the pause gesture.
//
// Mapping: a comfortable "reach box" in front of the active shoulder (user frame U:
// x right, y up, z toward the TV) maps to the screen rect. The user's right is the
// screen's right because they face the TV. Coordinates are smoothed with One Euro
// filters in normalized screen units.

import { OneEuro, clamp } from '../util/math.js';

export const DWELL_MS = 1000;
// QA2: overhead preparation (racket up, off hand pointing at the lob) held the old 1.5 s gesture.
export const PAUSE_HOLD_MS = 2000;
export const DWELL_SELECTOR = 'button:not([disabled]):not([aria-disabled="true"]), [data-dwell]:not([aria-disabled="true"]), [role="slider"]';

// Reach box around the active shoulder, in meters for a 0.38 m shoulder width.
const REACH = Object.freeze({
  outward: 0.12, // box center sits this far toward the hand's side
  down: 0.04, // and this far below the shoulder
  width: 0.62,
  height: 0.44,
});
const RAISE_ON = 0.5; // wrist above hip + RAISE_ON * (shoulder - hip) activates a hand
const RAISE_OFF = 0.3; // hysteresis: stays active until below this fraction
const LOST_GRACE_MS = 400;
const PAUSE_COOLDOWN_MS = 3000;
const REPEAT_DELAY_MS = 450;
const REARM_MS = 600;

/**
 * @param {object} o
 * @param {HTMLElement} [o.root=document.body] elements outside root are never dwell-clicked
 * @param {{setCursor(s:object):void}} [o.ui] when given, update() forwards the cursor state to ui.setCursor
 * @param {() => void} [o.onPause] both hands above the head for pauseHoldMs
 * @param {(state:object) => void} [o.onCursor] called with the state on every update
 * @param {(el:Element, state:object) => void} [o.onDwellClick] called after a dwell click
 * @param {number} [o.dwellMs=1000]
 * @param {number} [o.pauseHoldMs=2000]
 * @param {() => boolean} [o.isLive] true while a ball is in play (world.ball live and the referee
 *   phase not 'dead'): the pause gesture is ignored then, so an overhead cannot pause the game
 * @param {() => number} [o.now=performance.now]
 */
export function createHandCursor({
  root = typeof document !== 'undefined' ? document.body : null,
  ui = null,
  onPause = null,
  onCursor = null,
  onDwellClick = null,
  dwellMs = DWELL_MS,
  pauseHoldMs = PAUSE_HOLD_MS,
  now = () => performance.now(),
  isLive = null,
} = {}) {
  let liveGate = isLive;
  let enabled = true;
  const fx = new OneEuro(1.1, 4.0, 1.0);
  const fy = new OneEuro(1.1, 4.0, 1.0);
  let activeHand = null;
  let lastSeenAt = -Infinity;
  let hot = null;
  let hotSince = 0;
  let armed = true;
  let lastClickAt = -Infinity;
  let pauseSince = null;
  let pauseCooldownUntil = 0;

  const state = {
    x: 0, y: 0, nx: 0.5, ny: 0.5, visible: false, progress: 0, hand: null,
    target: null, clicked: false, pauseProgress: 0,
  };

  function setHot(el, t) {
    if (el === hot) return;
    if (hot) hot.classList.remove('dwell-hot');
    hot = el;
    // A new screen often puts a button where the hand already is: wait a beat before dwelling.
    hotSince = Math.max(t, lastClickAt + REARM_MS);
    armed = true;
    if (hot) hot.classList.add('dwell-hot');
  }

  function raisedFraction(j, side) {
    const w = j['wrist' + side], s = j['shoulder' + side], h = j['hip' + side];
    if (!w || !s || !h) return -Infinity;
    const span = Math.max(0.2, s.y - h.y);
    return (w.y - h.y) / span;
  }

  function pickHand(sample) {
    const j = sample.joints;
    const dom = sample.dominant === 'L' ? 'L' : 'R';
    const off = dom === 'R' ? 'L' : 'R';
    const fd = raisedFraction(j, dom), fo = raisedFraction(j, off);
    if (activeHand && raisedFraction(j, activeHand) > RAISE_OFF) {
      // Switch only when the other hand is clearly higher (the "highest raised" hand).
      const other = activeHand === 'R' ? 'L' : 'R';
      const fa = raisedFraction(j, activeHand), fb = raisedFraction(j, other);
      if (fb > RAISE_ON && fb > fa + 0.45) return other;
      return activeHand;
    }
    if (fd > RAISE_ON && fo > RAISE_ON) return fo > fd + 0.3 ? off : dom;
    if (fd > RAISE_ON) return dom;
    if (fo > RAISE_ON) return off;
    return null;
  }

  function handPoint(j, side) {
    const w = j['wrist' + side], i = j['index' + side], p = j['pinky' + side];
    if (i && p) return { x: w.x + ((i.x + p.x) / 2 - w.x) * 0.6, y: w.y + ((i.y + p.y) / 2 - w.y) * 0.6 };
    return w;
  }

  function mapToScreen(j, side, rect, tSec) {
    const sh = j['shoulder' + side];
    const sL = j.shoulderL, sR = j.shoulderR;
    const sw = sL && sR ? Math.hypot(sL.x - sR.x, sL.y - sR.y) : 0.38;
    const k = clamp(sw / 0.38, 0.7, 1.4);
    const sign = side === 'R' ? 1 : -1;
    const cx = sh.x + sign * REACH.outward * k;
    const cy = sh.y - REACH.down * k;
    const p = handPoint(j, side);
    const rawX = clamp((p.x - cx) / (REACH.width * k) + 0.5, -0.05, 1.05);
    const rawY = clamp(0.5 - (p.y - cy) / (REACH.height * k), -0.05, 1.05);
    const nx = clamp(fx.filter(rawX, tSec), 0, 1);
    const ny = clamp(fy.filter(rawY, tSec), 0, 1);
    state.nx = nx;
    state.ny = ny;
    state.x = rect.left + nx * rect.width;
    state.y = rect.top + ny * rect.height;
  }

  function bothAboveHead(j) {
    const head = j.nose || j.eyeL || j.eyeR;
    if (!head || !j.wristL || !j.wristR) return false;
    return j.wristL.y > head.y + 0.06 && j.wristR.y > head.y + 0.06;
  }

  function dwellTarget(x, y) {
    if (typeof document === 'undefined') return null;
    const el = document.elementFromPoint(x, y);
    const t = el && el.closest ? el.closest(DWELL_SELECTOR) : null;
    if (!t || (root && !root.contains(t))) return null;
    if (t.closest('[inert], [hidden]')) return null;
    return t;
  }

  function click(el) {
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: state.x, clientY: state.y, detail: 1, view: window });
    ev.vpDwell = true;
    el.dispatchEvent(ev);
    if (onDwellClick) onDwellClick(el, state);
  }

  function publish() {
    if (ui && typeof ui.setCursor === 'function') ui.setCursor(state);
    if (onCursor) onCursor(state);
    return state;
  }

  function hide() {
    state.visible = false;
    state.progress = 0;
    state.target = null;
    state.hand = null;
    activeHand = null;
    setHot(null, 0);
  }

  /**
   * Feed one BodySample (or null). screenRect defaults to the viewport.
   * Returns { x, y, nx, ny, visible, progress 0..1, hand, target, clicked, pauseProgress 0..1 }.
   */
  function update(sample, screenRect = null) {
    const tNow = now();
    state.clicked = false;
    const rect = screenRect || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const valid = sample && sample.valid !== false && sample.joints;
    if (!valid) {
      if (tNow - lastSeenAt > LOST_GRACE_MS) hide();
      state.pauseProgress = 0;
      pauseSince = null;
      return publish();
    }
    lastSeenAt = tNow;
    const j = sample.joints;
    const tSec = Number.isFinite(sample.t) ? sample.t / 1000 : tNow / 1000;

    // Pause gesture works even when the cursor is disabled (e.g. during play), but not while a ball
    // is live: bandeja / smash preparation looks the same.
    let live = false;
    try { live = !!(liveGate && liveGate()); } catch { live = false; }
    if (!live && bothAboveHead(j) && tNow >= pauseCooldownUntil) {
      if (pauseSince == null) pauseSince = tNow;
      state.pauseProgress = clamp((tNow - pauseSince) / pauseHoldMs, 0, 1);
      if (state.pauseProgress >= 1) {
        pauseSince = null;
        state.pauseProgress = 0;
        pauseCooldownUntil = tNow + PAUSE_COOLDOWN_MS;
        if (onPause) onPause();
      }
    } else {
      pauseSince = null;
      state.pauseProgress = 0;
    }

    if (!enabled) {
      hide();
      return publish();
    }

    const hand = pickHand(sample);
    if (!hand) {
      hide();
      fx.reset();
      fy.reset();
      return publish();
    }
    if (hand !== activeHand) {
      fx.reset();
      fy.reset();
    }
    activeHand = hand;
    state.hand = hand;
    state.visible = true;
    mapToScreen(j, hand, rect, tSec);

    // No dwell clicks while both hands are up (the user is pausing).
    const target = pauseSince != null ? null : dwellTarget(state.x, state.y);
    setHot(target, tNow);
    state.target = target;
    state.progress = 0;
    if (hot && armed && tNow >= hotSince) {
      state.progress = clamp((tNow - hotSince) / dwellMs, 0, 1);
      if (state.progress >= 1) {
        click(hot);
        lastClickAt = tNow;
        state.clicked = true;
        state.progress = 0;
        if (hot && hot.hasAttribute('data-dwell-repeat')) {
          // Steppers auto-repeat: the ring restarts part-filled so repeats come every REPEAT_DELAY_MS.
          hotSince = tNow - Math.max(0, dwellMs - REPEAT_DELAY_MS);
        } else {
          armed = false;
        }
      }
    }
    return publish();
  }

  function setEnabled(b) {
    enabled = !!b;
    if (!enabled) {
      hide();
      publish();
    }
  }

  function reset() {
    fx.reset();
    fy.reset();
    pauseSince = null;
    hide();
  }

  return {
    update,
    setEnabled,
    reset,
    get enabled() { return enabled; },
    /** Sets the live-ball gate (see o.isLive); null removes it. */
    setLiveGate(fn) { liveGate = typeof fn === 'function' ? fn : null; },
    get state() { return state; },
    dispose() { reset(); },
  };
}
