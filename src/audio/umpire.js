// The chair umpire and the players' callouts, spoken through the shared voice queue (voice.js).
//
// Score calls follow padel / tennis umpiring, in Spanish and English:
//   points, server's score first: "Quince – nada" / "Fifteen–love", "Nada – quince" / "Love–fifteen",
//   "Treinta iguales" / "Thirty all", "Cuarenta – treinta" / "Forty–thirty";
//   40-40: "Iguales. Punto de oro" / "Deuce. Golden point" (advantage scoring: "Iguales" / "Deuce",
//   then "Ventaja Víbora" / "Advantage Víbora");
//   games: "Juego, Víbora. Cuatro juegos a dos, Víbora" / "Game, Víbora. Víbora leads four games to
//   two", "Tres iguales" / "Three games all"; "Juego y set, Víbora. Seis – cuatro" / "Game and set";
//   "Juego, set y partido, Víbora" / "Game, set and match"; tie-break: "Seis iguales. Tie-break",
//   then the points, leader first: "Tres – uno, Víbora" / "Three–one, Víbora", "Dos iguales" / "Two all";
//   faults and lets: "Falta" / "Fault", "Doble falta" / "Double fault", "Let".
// The player's pair is "Víbora", the rivals "Cobra" (configurable).
//
// Callouts: 'partner:call' { text, who, es?, en? } ("¡Mía!", "¡Tuya!", "¡Vamos!", ...) are voiced
// by that character (partner / opponent / opponent2 voices, voice.js SPEAKERS), may cut a coaching
// tip (they are worthless late: 1 s expiry) and never overlap anything.
import { looksSpanish } from './voice.js';

export const TEAMS = Object.freeze([Object.freeze({ en: 'Víbora', es: 'Víbora' }), Object.freeze({ en: 'Cobra', es: 'Cobra' })]);

const EN_NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const ES_NUM = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce',
  'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós',
  'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve', 'treinta'];
const EN_PTS = { 0: 'love', 15: 'fifteen', 30: 'thirty', 40: 'forty' };
const ES_PTS = { 0: 'nada', 15: 'quince', 30: 'treinta', 40: 'cuarenta' };

export const enNumber = (n) => (n >= 0 && n < EN_NUM.length ? EN_NUM[n] : String(n));
export const esNumber = (n) => (n >= 0 && n < ES_NUM.length ? ES_NUM[n] : String(n));
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const DASH = ' – ';

/** "Four games to two" / "four games to love". */
function enGames(a, b) {
  return `${enNumber(a)} ${a === 1 ? 'game' : 'games'} to ${b === 0 ? 'love' : enNumber(b)}`;
}
/** "cuatro juegos a dos" / "un juego a cero". */
function esGames(a, b) {
  return `${a === 1 ? 'un' : esNumber(a)} ${a === 1 ? 'juego' : 'juegos'} a ${esNumber(b)}`;
}

/** Point call of a regular game, server first. pts = display.points, sv = serving team. */
export function pointCall(display, lang = 'en', teams = TEAMS) {
  const f = display.flags || {};
  const [p0, p1] = display.points;
  const sv = display.server ? display.server.team : 0;
  const es = lang === 'es';
  if (f.goldenPoint) return es ? 'Iguales. Punto de oro' : 'Deuce. Golden point';
  if (f.deuce) return es ? 'Iguales' : 'Deuce';
  if (p0 === 'AD' || p1 === 'AD') {
    const t = teams[p0 === 'AD' ? 0 : 1];
    return es ? `Ventaja ${t.es}` : `Advantage ${t.en}`;
  }
  const ps = sv === 0 ? p0 : p1, pr = sv === 0 ? p1 : p0;
  if (ps === pr) return es ? `${cap(ES_PTS[ps])} iguales` : `${cap(EN_PTS[ps])} all`;
  return es ? cap(`${ES_PTS[ps]}${DASH}${ES_PTS[pr]}`) : cap(`${EN_PTS[ps]}${DASH}${EN_PTS[pr]}`);
}

/** Tie-break points, leader first: "Three–one, Víbora" / "Two all". */
export function tiebreakCall(display, lang = 'en', teams = TEAMS) {
  const a = Number(display.points[0]) || 0, b = Number(display.points[1]) || 0;
  const es = lang === 'es';
  if (a === b) return es ? `${cap(esNumber(a))} iguales` : `${cap(enNumber(a))} all`;
  const lead = a > b ? 0 : 1;
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return es ? `${cap(esNumber(hi))}${DASH}${esNumber(lo)}, ${teams[lead].es}` : `${cap(enNumber(hi))}${DASH}${enNumber(lo)}, ${teams[lead].en}`;
}

/** Games call after a game: "Víbora leads four games to two" / "Three games all". */
export function gamesCall(games, lang = 'en', teams = TEAMS) {
  const [a, b] = games;
  const es = lang === 'es';
  if (a === b) return es ? `${cap(esNumber(a))} iguales` : `${cap(enNumber(a))} ${a === 1 ? 'game' : 'games'} all`;
  const lead = a > b ? 0 : 1;
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return es ? `${cap(esGames(hi, lo))}, ${teams[lead].es}` : `${teams[lead].en} leads ${enGames(hi, lo)}`;
}

const sumArr = (x) => (x || []).reduce((s, v) => s + (v || 0), 0);

/**
 * The umpire's call after a point: { en, es, kind } or null.
 * cur / prev: match.display() after / before the point (prev null for the first call);
 * o: { winner (0|1|null), reason (rally:outcome reason), teams }.
 * kind: 'point' | 'game' | 'set' | 'match' | 'tiebreak' | 'tiebreak-start' | 'fault' | 'let'
 */
export function scoreCall(cur, prev, { winner = null, reason = null, teams = TEAMS } = {}) {
  if (winner !== 0 && winner !== 1) {
    if (reason === 'serve-fault') return { en: 'Fault', es: 'Falta', kind: 'fault' };
    if (reason === 'let') return { en: 'Let', es: 'Let', kind: 'let' };
    return null;
  }
  if (!cur || !cur.points) return null;
  const W = teams[winner];
  const pre = reason === 'double-fault' ? { en: 'Double fault. ', es: 'Doble falta. ' } : { en: '', es: '' };
  const say = (en, es, kind) => ({ en: `${pre.en}${en}`, es: `${pre.es}${es}`, kind });
  if (cur.isOver) {
    const last = cur.sets && cur.sets.length ? cur.sets[cur.sets.length - 1] : cur.games;
    const [a, b] = last || [0, 0];
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return say(
      `Game, set and match, ${W.en}. ${cap(enNumber(hi))}${DASH}${enNumber(lo)}`,
      `Juego, set y partido, ${W.es}. ${cap(esNumber(hi))}${DASH}${esNumber(lo)}`,
      'match',
    );
  }
  const setsNow = (cur.sets || []).length, setsBefore = prev ? (prev.sets || []).length : 0;
  if (prev && setsNow > setsBefore) {
    const [a, b] = cur.sets[setsNow - 1];
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return say(`Game and set, ${W.en}. ${cap(enNumber(hi))}${DASH}${enNumber(lo)}`, `Juego y set, ${W.es}. ${cap(esNumber(hi))}${DASH}${esNumber(lo)}`, 'set');
  }
  const tb = !!(cur.flags && cur.flags.tiebreak);
  const tbBefore = !!(prev && prev.flags && prev.flags.tiebreak);
  if (tb && !tbBefore) {
    const n = cur.games[0];
    return say(
      `Game, ${W.en}. ${cap(enNumber(n))} games all. Tie-break`,
      `Juego, ${W.es}. ${cap(esNumber(n))} iguales. Tie-break`,
      'tiebreak-start',
    );
  }
  if (prev && sumArr(cur.games) > sumArr(prev.games)) {
    return say(`Game, ${W.en}. ${gamesCall(cur.games, 'en', teams)}`, `Juego, ${W.es}. ${gamesCall(cur.games, 'es', teams)}`, 'game');
  }
  if (tb) return say(tiebreakCall(cur, 'en', teams), tiebreakCall(cur, 'es', teams), 'tiebreak');
  return say(pointCall(cur, 'en', teams), pointCall(cur, 'es', teams), 'point');
}

/** Opening call of a match: "Víbora to serve. Play" / "Saca Víbora. Tiempo". */
export function openingCall(display, teams = TEAMS) {
  const t = teams[display && display.server ? display.server.team : 0];
  return { en: `${t.en} to serve. Play`, es: `Saca ${t.es}. Tiempo`, kind: 'open' };
}

const CALLER = { partner: 'partner', opponent: 'opponent', rival: 'opponent', opp1: 'opponent', rival1: 'opponent', opp2: 'opponent2', rival2: 'opponent2', coach: 'partner' };

/** Speaker id for a 'partner:call' who / role (a display name such as "Lucía" is the partner). */
export const callerSpeaker = (who) => CALLER[who] || 'partner';

/**
 * Quick court calls (game/callouts.js kinds): shouted in Spanish whatever the app language (that is
 * how padel sounds everywhere), may cut a coaching tip, and are worthless after a second.
 * Everything else (chatter: "Well played!", "Easy, next one") follows the app language and waits.
 */
export const QUICK_CALLS = Object.freeze(new Set(['mine', 'yours', 'wall', 'switch', 'up', 'vamos', 'game', 'golden']));

/**
 * @param {{ voice, lang?: 'en'|'es', teams?, enabled?: boolean, callouts?: boolean, delayMs?: number,
 *   setTimer?: Function }} o
 */
export function createUmpire({ voice, lang = 'en', teams = TEAMS, enabled = true, callouts = true, delayMs = 650, setTimer = (fn, ms) => setTimeout(fn, ms) } = {}) {
  let prev = null;
  let curLang = lang === 'es' ? 'es' : 'en';
  let on = !!enabled;
  let calls = !!callouts;
  let opened = false;
  const log = [];

  function speak(c, priority = 2) {
    if (!c || !voice) return false;
    log.push(c);
    if (log.length > 40) log.shift();
    return voice.say(c.en, { es: c.es, speaker: 'umpire', lang: curLang, priority, expireMs: 6000 });
  }

  const api = {
    get log() {
      return log.slice();
    },
    setLang(l) {
      curLang = l === 'es' ? 'es' : 'en';
    },
    setEnabled(b) {
      on = !!b;
    },
    setCallouts(b) {
      calls = !!b;
    },
    /** Resets the remembered score (a new match). */
    reset(display = null) {
      prev = display;
      opened = false;
    },
    /** rally:outcome payload { winner, reason, score }: the call is spoken after a short pause. */
    onOutcome(o) {
      if (!on || !o) return null;
      if (!o.score && o.winner != null) return null;
      const c = scoreCall(o.score || prev, prev, { winner: o.winner, reason: o.reason, teams });
      if (o.score) prev = o.score;
      if (c) setTimer(() => speak(c), delayMs);
      return c;
    },
    /** Opening call before the first serve of a match. */
    open(display) {
      if (!on || opened) return null;
      opened = true;
      prev = display || prev;
      const c = openingCall(display, teams);
      speak(c, 1);
      return c;
    },
    /** 'partner:call' { text, who, role?, kind?, es?, en? } (game/callouts.js). */
    callout(p) {
      if (!calls || !voice || !p) return false;
      const speaker = callerSpeaker(p.role || p.who);
      const quick = p.kind ? QUICK_CALLS.has(p.kind) : true;
      const timing = quick ? { priority: 2, cut: true, expireMs: 1000 } : { priority: 1, cut: false, expireMs: 3000 };
      if (p.en || p.es) {
        const spanish = !!p.es && (curLang === 'es' || quick || !p.en);
        return spanish
          ? voice.say(p.es, { es: p.es, speaker, lang: 'es', ...timing })
          : voice.say(p.en, { es: p.es || p.en, speaker, lang: curLang, ...timing });
      }
      const text = String(p.text || '').trim();
      if (!text) return false;
      return voice.say(text, { speaker, lang: looksSpanish(text) ? 'es' : curLang, ...timing });
    },
    /** Subscribes to a world bus. isMatch() tells whether score calls apply. Returns an unsubscribe fn. */
    bindBus(bus, { isMatch = () => true, display = null } = {}) {
      const offs = [
        bus.on('rally:outcome', (o) => {
          if (isMatch()) api.onOutcome(o);
        }),
        bus.on('partner:call', (p) => api.callout(p)),
        bus.on('ball:launch', ({ by } = {}) => {
          if (!opened && isMatch() && by !== 'machine') api.open(typeof display === 'function' ? display() : display);
        }),
        bus.on('match:end', () => {
          opened = false;
        }),
      ];
      return () => offs.forEach((off) => off && off());
    },
  };
  return api;
}
