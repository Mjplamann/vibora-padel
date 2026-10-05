// Approach circle (round 6, "a timing cue that doesn't lie"). The round-3 reach ring shrank fastest
// when it appeared ((1 - p)² easing) and sat still for its last ~0.25 s, so it looked "closed" well
// before the moment to swing; the user's misses were early by 0.34-0.82 s. Like a rhythm game's
// approach circle, this one shrinks onto the ball at a CONSTANT rate and closes exactly at t* (the
// timing plan's moment to swing, game/swingAssist.js): white while it closes, green only inside the
// assist's swing window, a short flash within ±TIMING.green of t*. Pure (no three): render/ballView.js
// draws it, app/wiring.js binds it; tests/clarity.test.mjs checks the closing moment and colours.
import { timingConfig, flightKeyOf, timingBias, TIMING } from '../game/swingAssist.js';

export const APPROACH = Object.freeze({
  /** s before t* the circle appears (and starts closing). */
  lead: 0.8,
  /** Its fade-in (s). */
  fadeIn: 0.12,
  /** Extra radius when it appears, as a fraction of the view height (it closes linearly from there). */
  open: 0.085,
  /** Radius at t*, in drawn ball radii, plus closePad of the view height: it just rings the ball. */
  close: 1.18,
  closePad: 0.0035,
  /** ± s around t* of the "perfect" flash (the timing judge's green band). */
  perfect: TIMING.green,
  /** s the colour takes to turn green as the window opens (no hard flash at the window's start). */
  greenEase: 0.06,
  /** The optional audio tick (settings.approachTick) sounds this long before t*. */
  tickLead: 0.2,
});

/**
 * The swing window the circle turns green in (s before / after t*): the assist's window around t*
 * INTERSECTED with the judge's window around the player's own moment (t* + personal timing bias,
 * game/swingAssist.js timingBias). Green therefore always means "a swing now is a clean hit", and the
 * cue never moves toward the player's habit (a green that opened earlier for an early player would
 * pull their swings earlier still, and the learned bias with them). The circle itself closes at the
 * true t* whatever the bias. Returns { early, late } (either may be negative when the bias is large).
 */
export function greenWindow(cfg, bias = 0) {
  const b = Number.isFinite(bias) ? bias : 0;
  let early = Math.min(cfg.early, cfg.early - b);
  let late = Math.min(cfg.late, cfg.late + b);
  if (early + late < 0.04) {
    // No useful overlap (cannot happen with the ±0.35 s bias clamp): the judge's own window.
    early = cfg.early - b;
    late = cfg.late + b;
  }
  return { early, late };
}

/**
 * State of the approach circle for the live ball, or null when there is none to show (no timing plan,
 * physical hitting, the swing already decided, the ball already struck on screen, outside the lead).
 * Reuses `out`. Fields: key, tau (t* - now, s), k (0..1: how open, linear in tau), alpha, green (0..1),
 * inWindow (the green window, greenWindow()), perfect, after, glass, tStar, pStar, early, late (the
 * green window's edges, s), bias.
 */
export function approachCue(world, out = {}) {
  const T = world && world.timing;
  const P = T && T.plan;
  if (!P || !P.pStar || P.closed) return null;
  const cfg = timingConfig(world);
  if (!cfg) return null;
  if (T.decided && T.decided.key === P.key) return null;
  if (P.key !== flightKeyOf(world)) return null;
  if (world.spec && world.ball && world.spec.ballId === world.ball.id) return null; // struck on screen
  const tau = P.tStar - world.time;
  const lead = APPROACH.lead;
  const bias = timingBias(world) || 0;
  const win = greenWindow(cfg, bias);
  const shownLate = Math.max(cfg.late, win.late);
  if (!(tau <= lead) || tau < -shownLate) return null;
  const inWindow = tau <= win.early && tau >= -win.late;
  out.key = P.key;
  out.tau = tau;
  out.k = Math.min(1, Math.max(0, tau / lead));
  out.inWindow = inWindow;
  out.green = inWindow ? Math.min(1, (win.early - tau) / APPROACH.greenEase) : 0;
  out.perfect = inWindow && Math.abs(tau) <= APPROACH.perfect;
  out.after = tau < 0;
  const fin = Math.min(1, (lead - tau) / APPROACH.fadeIn);
  const fout = tau < 0 ? Math.max(0, 1 + tau / Math.max(0.05, shownLate)) : 1;
  out.alpha = Math.max(0, Math.min(fin, fout));
  out.glass = !!P.glass;
  out.tStar = P.tStar;
  out.pStar = P.pStar;
  out.early = win.early;
  out.late = win.late;
  out.bias = bias;
  return out;
}

/**
 * Ring radius as a fraction of the view height: closes linearly from (ball + open) to the ball's own
 * outline at t*. ballFrac: the drawn ball's radius as a fraction of the view height.
 */
export function approachRadius(k, ballFrac) {
  const end = ballFrac * APPROACH.close + APPROACH.closePad;
  return end + APPROACH.open * Math.max(0, Math.min(1, k));
}

/** settings.approachTick: 'auto' (Rookie) | 'on' | 'off' (legacy timingTick true = 'on'). */
export function approachTickOn(s = {}) {
  const v = s.approachTick;
  if (v === 'on' || v === true) return true;
  if (v === 'off' || v === false) return false;
  return s.assist === 'rookie' || s.timingTick === true;
}
