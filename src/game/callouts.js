// AI partner callouts in a 2v2 match: the calls real padel partners make, at the moments they
// make them. "¡Mía!" / "¡Tuya!" on a ball down the middle, "¡Pared!" on a lob going to the glass,
// "¡Vamos!" after a point, "Tranquilo" after an error, "Punto de oro" before the deciding point.
// Emitted on the bus as 'partner:call' { text, es, en, who, kind, priority, at } (audio/umpire.js
// voices them with the partner's voice; the HUD shows them). Spanish is the language of the court
// (text = es); `en` is the translation. Rate-limited, and how chatty the partner is follows their
// personality (talk).
// Pure module.

import { createRng, clamp } from '../util/math.js';
import { emit } from './world.js';

/** Minimum gap between two calls (s), and between two optional ones. */
export const CALL_GAP = 1.4;
export const CHAT_GAP = 6;
/** Ball calls ("¡Mía!" / "¡Tuya!") only on a ball down the middle (|x| below this, m), at most every BALL_GAP s. */
export const MIDDLE_X = 1.0;
export const BALL_GAP = 4;

export const CALLS = Object.freeze({
  mine: [['¡Mía!', 'Mine!']],
  yours: [['¡Tuya!', 'Yours!'], ['¡Tuya, tuya!', 'Yours!']],
  wall: [['¡Pared!', 'Let it come off the glass!'], ['¡Deja, pared!', 'Leave it, glass!']],
  switch: [['¡Cambio!', 'Switch!']],
  up: [['¡Arriba!', 'Up to the net!'], ['¡Subimos!', 'Let\'s go up!']],
  great: [['¡Qué bola!', 'What a ball!'], ['¡Bien jugado!', 'Well played!'], ['¡Golpazo!', 'Great shot!']],
  vamos: [['¡Vamos!', 'Come on!'], ['¡Vamos, vamos!', 'Come on!'], ['¡Eso es!', 'That\'s it!']],
  calm: [['Tranquilo, siguiente', 'Easy, next one'], ['No pasa nada', 'No worries'], ['Sigue así', 'Keep going']],
  theirs: [['Buena de ellos', 'Good one from them'], ['Bien jugada por ellos', 'Well played by them']],
  sorry: [['Perdona, mía', 'Sorry, my bad'], ['Mía, perdón', 'My fault, sorry']],
  game: [['¡Juego! ¡Vamos!', 'Game! Come on!']],
  golden: [['Punto de oro. ¡Concentración!', 'Golden point. Focus!']],
  serve: [['Tu saque, ¡vamos!', 'Your serve, come on!'], ['Saca tranquilo', 'Easy serve']],
  setpoint: [['¡Bola de set! Paciencia', 'Set point! Be patient']],
});

/**
 * @param {object} o
 * @param {object} o.partner the partner actor (createCoach, team 0)
 * @param {string} o.who display name ("Lucía")
 * @param {number} [o.talk] 0..1 chattiness (personality)
 * @param {Function} [o.rng]
 */
export function createCallouts({ partner, who = 'Partner', talk = 0.6, rng = createRng(0xca11) } = {}) {
  let lastAt = -Infinity;
  let lastChat = -Infinity;
  let lastBall = -Infinity;
  let flightKey = null;
  let flightCalled = false;
  const log = [];

  function say(world, kind, { priority = 1, optional = false } = {}) {
    const now = world.time;
    if (now - lastAt < CALL_GAP) return null;
    if (optional && (now - lastChat < CHAT_GAP || rng() > talk)) return null;
    const list = CALLS[kind];
    if (!list) return null;
    const [text, en] = list[Math.floor(rng() * list.length) % list.length];
    lastAt = now;
    if (optional) lastChat = now;
    const call = { text, es: text, en, who, kind, priority, at: now };
    log.push(call);
    if (log.length > 40) log.shift();
    emit(world, 'partner:call', call);
    return call;
  }

  /**
   * Every tick of a live point. ctx: { humanPos, pointLive }.
   * Calls the ball as it comes over the net toward our half.
   */
  function update(world) {
    const b = world.ball;
    if (!b || b.atRest || b.outside || world.flight.team !== 1) return;
    const key = `${b.id}:${world.flight.startT}`;
    if (key !== flightKey) {
      flightKey = key;
      flightCalled = false;
    }
    if (flightCalled || b.vel.z <= 0 || b.pos.z < 0.4) return;
    // Wait for the partner's read of the ball (its plan comes after its reaction time).
    const plan = partner && partner.state ? partner.state.plan : null;
    if (world.time - world.flight.startT < 0.32) return;
    flightCalled = true;
    const land = plan && plan.pos ? plan.pos : b.pos;
    const vy = b.vel.y;
    const apexAbove = b.pos.y + Math.max(0, vy) ** 2 / 19.6;
    const partnerAtNet = partner && Math.abs(partner.state.pos.z) < 5.2;
    if (apexAbove > 4.4 && partnerAtNet) {
      // A lob over us: let it come off the glass, or switch sides.
      say(world, plan && !plan.miss && plan.kind === 'after-wall' ? 'wall' : 'switch', { priority: 2 });
      return;
    }
    // Real partners call the ball that could be either player's: down the middle.
    if (Math.abs(land.x) >= MIDDLE_X || world.time - lastBall < BALL_GAP || rng() > 0.4 + 0.6 * talk) return;
    const c = say(world, plan && !plan.miss ? 'mine' : 'yours', { priority: 2 });
    if (c) lastBall = world.time;
  }

  /**
   * A point is over. o: rally:outcome payload with score; last: { by, team } of the last stroke.
   * gameWon: our team won the game.
   */
  function onPoint(world, o, last, { gameWon = false } = {}) {
    if (!o || (o.winner !== 0 && o.winner !== 1)) return null;
    const lastBy = last ? last.by : null;
    const lastTeam = last ? last.team : null;
    if (o.winner === 0) {
      if (gameWon) return say(world, 'game', { priority: 1 });
      if (lastTeam === 0 && lastBy === 'player') return say(world, rng() < 0.6 ? 'great' : 'vamos', { priority: 1 });
      return say(world, 'vamos', { priority: 1, optional: true });
    }
    // Lost the point.
    if (lastTeam === 0 && lastBy === 'player') return say(world, 'calm', { priority: 1, optional: true });
    if (lastTeam === 0) return say(world, 'sorry', { priority: 1 });
    return say(world, 'theirs', { priority: 0, optional: true });
  }

  /** Before a point: golden point / set point / the human's serve. sv: match.server(). */
  function beforePoint(world, display, sv) {
    const f = display && display.flags ? display.flags : {};
    const pts = display ? display.points : null;
    if (f.goldenPoint && pts && pts[0] === '40' && pts[1] === '40') return say(world, 'golden', { priority: 2 });
    if (f.setPoint === 0 || f.matchPoint === 0) return say(world, 'setpoint', { priority: 1, optional: true });
    if (sv && sv.team === 0 && sv.player === 0) return say(world, 'serve', { priority: 0, optional: true });
    return null;
  }

  return {
    update,
    onPoint,
    beforePoint,
    get log() { return log; },
    /** Chattiness can change (settings: callouts off -> 0 keeps only essential calls). */
    setTalk(t) { talk = clamp(t, 0, 1); },
  };
}
