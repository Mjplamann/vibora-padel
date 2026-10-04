// Career: the "Circuito Víbora", a ladder of eight tournaments from the Club Open to the Pro Tour
// Finals. Each event is 1-3 knockout matches against named AI pairs whose personalities change how
// the coach brain plays (game/coach.js PERSONALITIES), at a venue ('club' | 'sunset' | 'stadium').
// You choose an AI partner with a personality too. Progress is saved after every point, so a
// match can be resumed exactly where it was left (the point winners are replayed into the score).
// Pure module: storage is injected.

import { PERSONALITIES, levelOfSkill } from './coach.js';

export const CAREER_KEY = 'vibora.career.v1';

/** Venues (render/environment.js buildEnvironment(..., { venue })). */
export const VENUES = Object.freeze([
  Object.freeze({ id: 'club', name: 'Víbora Padel Club', es: 'Club indoor', desc: 'Indoor club at night', descEs: 'Club cubierto de noche' }),
  Object.freeze({ id: 'sunset', name: 'Costa Sunset Courts', es: 'Pista al atardecer', desc: 'Outdoor courts at golden hour', descEs: 'Pistas exteriores al atardecer' }),
  Object.freeze({ id: 'stadium', name: 'Arena Central', es: 'Estadio', desc: 'Show court with stands, crowd and umpire', descEs: 'Pista central con grada, público y árbitro' }),
]);
export const VENUE_IDS = Object.freeze(VENUES.map((v) => v.id));
export const venueById = (id) => VENUES.find((v) => v.id === id) || VENUES[0];

/**
 * Players. kit: renderer colours ({ shirt, shorts, cap, skin, hair }); handed; personality.
 * All names are fictional.
 */
export const PLAYERS = Object.freeze({
  paco: { name: 'Paco Ruiz', short: 'Paco', personality: 'all-rounder', handed: 'right', country: 'ES', kit: { shirt: '#c9302c', shorts: '#1b1d22', cap: '#c9302c', skin: '#c58c6a' } },
  toni: { name: 'Toni Bermejo', short: 'Toni', personality: 'lobber', handed: 'right', country: 'ES', kit: { shirt: '#c9302c', shorts: '#1b1d22', cap: null, skin: '#a46b4b' } },
  carla: { name: 'Carla Ortega', short: 'Carla', personality: 'chiquita', handed: 'right', country: 'ES', kit: { shirt: '#7d4bd8', shorts: '#f4efe4', cap: null, skin: '#e2b08c' } },
  nuria: { name: 'Nuria Ortega', short: 'Nuria', personality: 'wall-master', handed: 'left', country: 'ES', kit: { shirt: '#7d4bd8', shorts: '#f4efe4', cap: '#f4efe4', skin: '#e2b08c' } },
  bruno: { name: 'Bruno Sáez', short: 'Bruno', personality: 'big-hitter', handed: 'right', country: 'AR', kit: { shirt: '#f0a020', shorts: '#14213a', cap: '#14213a', skin: '#c58c6a' } },
  dario: { name: 'Darío Méndez', short: 'Darío', personality: 'net-rusher', handed: 'right', country: 'AR', kit: { shirt: '#f0a020', shorts: '#14213a', cap: null, skin: '#7b4a33' } },
  ines: { name: 'Inés Varela', short: 'Inés', personality: 'wall-master', handed: 'right', country: 'PT', kit: { shirt: '#118c6e', shorts: '#f4efe4', cap: '#f4efe4', skin: '#e2b08c' } },
  marta: { name: 'Marta Lobo', short: 'Marta', personality: 'lobber', handed: 'right', country: 'ES', kit: { shirt: '#118c6e', shorts: '#f4efe4', cap: null, skin: '#c58c6a' } },
  hugo: { name: 'Hugo Ferrán', short: 'Hugo', personality: 'net-rusher', handed: 'left', country: 'ES', kit: { shirt: '#e8eaf0', shorts: '#1d2b4a', cap: '#1d2b4a', skin: '#f2cdb0' } },
  leo: { name: 'Leo Castillo', short: 'Leo', personality: 'big-hitter', handed: 'right', country: 'MX', kit: { shirt: '#e8eaf0', shorts: '#1d2b4a', cap: null, skin: '#a46b4b' } },
  sol: { name: 'Sol Aguirre', short: 'Sol', personality: 'chiquita', handed: 'right', country: 'AR', kit: { shirt: '#ff6b8b', shorts: '#16181d', cap: null, skin: '#c58c6a' } },
  vera: { name: 'Vera Kowal', short: 'Vera', personality: 'all-rounder', handed: 'right', country: 'SE', kit: { shirt: '#ff6b8b', shorts: '#16181d', cap: '#16181d', skin: '#f2cdb0' } },
  alex: { name: 'Álex Prieto', short: 'Álex', personality: 'wall-master', handed: 'right', country: 'ES', kit: { shirt: '#20262e', shorts: '#20262e', cap: '#dcf53c', skin: '#c58c6a' } },
  rafa: { name: 'Rafa Iturbe', short: 'Rafa', personality: 'big-hitter', handed: 'left', country: 'ES', kit: { shirt: '#20262e', shorts: '#20262e', cap: null, skin: '#a46b4b' } },
  joao: { name: 'João Pires', short: 'João', personality: 'lobber', handed: 'right', country: 'BR', kit: { shirt: '#ffd23f', shorts: '#0f5132', cap: null, skin: '#7b4a33' } },
  mateo: { name: 'Mateo Rivas', short: 'Mateo', personality: 'net-rusher', handed: 'right', country: 'AR', kit: { shirt: '#ffd23f', shorts: '#0f5132', cap: '#0f5132', skin: '#c58c6a' } },
  // Partners (near side, beside you).
  lucia: { name: 'Lucía Navarro', short: 'Lucía', personality: 'wall-master', handed: 'right', country: 'ES', kit: { shirt: '#2a5aa6', shorts: '#10131a', cap: null, skin: '#e2b08c' } },
  nico: { name: 'Nico Herrera', short: 'Nico', personality: 'net-rusher', handed: 'left', country: 'AR', kit: { shirt: '#2a5aa6', shorts: '#10131a', cap: '#f4efe4', skin: '#c58c6a' } },
  pablo: { name: 'Pablo Soler', short: 'Pablo', personality: 'lobber', handed: 'right', country: 'ES', kit: { shirt: '#2a5aa6', shorts: '#10131a', cap: '#2a5aa6', skin: '#a46b4b' } },
});

/** Pairs: two players, a team name, a short scoreboard tag. */
export const PAIRS = Object.freeze({
  vecinos: { name: 'Los Vecinos', tag: 'RUIZ/BERMEJO', players: ['paco', 'toni'] },
  ortega: { name: 'Hermanas Ortega', tag: 'ORTEGA/ORTEGA', players: ['carla', 'nuria'] },
  pampa: { name: 'Pampa Power', tag: 'SÁEZ/MÉNDEZ', players: ['bruno', 'dario'] },
  atlantico: { name: 'Atlántico', tag: 'VARELA/LOBO', players: ['ines', 'marta'] },
  zurdos: { name: 'Zurdo & Diestro', tag: 'FERRÁN/CASTILLO', players: ['hugo', 'leo'] },
  aurora: { name: 'Aurora', tag: 'AGUIRRE/KOWAL', players: ['sol', 'vera'] },
  norte: { name: 'Muro del Norte', tag: 'PRIETO/ITURBE', players: ['alex', 'rafa'] },
  samba: { name: 'Samba & Tango', tag: 'PIRES/RIVAS', players: ['joao', 'mateo'] },
});

export const PARTNERS = Object.freeze(['lucia', 'nico', 'pablo']);
export const DEFAULT_PARTNER = 'lucia';

/**
 * The circuit. tier 1..8; level: AI level; games: games per set (one set, golden point,
 * tie-break at games-all); matches: knockout rounds (opponent pair per round).
 * skill (round 5): the opponents' base skill on the continuous 0 (rookie) .. 1 (club) .. 2 (pro)
 * scale, shifted by the player's career form (ADAPT); Pro only in the last two events. recLevel:
 * the player level the event is designed for (shown on its card).
 */
export const EVENTS = Object.freeze([
  { id: 'club-open', name: 'Club Open', es: 'Open del club', tier: 1, venue: 'club', level: 'rookie', skill: 0, recLevel: 1, games: 2, matches: [{ round: 'Final', es: 'Final', pair: 'vecinos' }] },
  { id: 'liga', name: 'Liga Social', es: 'Liga social', tier: 2, venue: 'club', level: 'rookie', skill: 0.3, recLevel: 2, games: 3, matches: [{ round: 'Semifinal', es: 'Semifinal', pair: 'vecinos' }, { round: 'Final', es: 'Final', pair: 'ortega' }] },
  { id: 'atardecer', name: 'Torneo Atardecer', es: 'Torneo atardecer', tier: 3, venue: 'sunset', level: 'club', skill: 0.6, recLevel: 4, games: 3, matches: [{ round: 'Semifinal', es: 'Semifinal', pair: 'ortega' }, { round: 'Final', es: 'Final', pair: 'atlantico' }] },
  { id: 'regional', name: 'Regional Open', es: 'Open regional', tier: 4, venue: 'sunset', level: 'club', skill: 0.8, recLevel: 6, games: 4, matches: [{ round: 'Semifinal', es: 'Semifinal', pair: 'atlantico' }, { round: 'Final', es: 'Final', pair: 'pampa' }] },
  { id: 'copa-costa', name: 'Copa Costa', es: 'Copa costa', tier: 5, venue: 'sunset', level: 'club', skill: 1.0, recLevel: 8, games: 4, matches: [{ round: 'Quarterfinal', es: 'Cuartos', pair: 'aurora' }, { round: 'Semifinal', es: 'Semifinal', pair: 'pampa' }, { round: 'Final', es: 'Final', pair: 'zurdos' }] },
  { id: 'national', name: 'National Championship', es: 'Campeonato nacional', tier: 6, venue: 'stadium', level: 'club', skill: 1.2, recLevel: 10, games: 4, matches: [{ round: 'Quarterfinal', es: 'Cuartos', pair: 'zurdos' }, { round: 'Semifinal', es: 'Semifinal', pair: 'aurora' }, { round: 'Final', es: 'Final', pair: 'norte' }] },
  { id: 'masters', name: 'Víbora Masters', es: 'Masters', tier: 7, venue: 'stadium', level: 'pro', skill: 1.5, recLevel: 12, games: 5, matches: [{ round: 'Quarterfinal', es: 'Cuartos', pair: 'pampa' }, { round: 'Semifinal', es: 'Semifinal', pair: 'norte' }, { round: 'Final', es: 'Final', pair: 'samba' }] },
  { id: 'finals', name: 'Pro Tour Finals', es: 'Finales del circuito', tier: 8, venue: 'stadium', level: 'pro', skill: 1.8, recLevel: 14, games: 6, matches: [{ round: 'Quarterfinal', es: 'Cuartos', pair: 'norte' }, { round: 'Semifinal', es: 'Semifinal', pair: 'zurdos' }, { round: 'Final', es: 'Final', pair: 'samba' }] },
].map((e) => Object.freeze({ ...e, matches: Object.freeze(e.matches.map((m) => Object.freeze(m))) })));
export const EVENT_BY_ID = Object.freeze(Object.fromEntries(EVENTS.map((e) => [e.id, e])));

/**
 * Adaptive difficulty (round 5, QA r5: a human-level player at ~0.26 s camera latency won tiers 1-3
 * and then lost 3 of 4 Regional Open matches; the pro tiers beat even the precise autopilot). The
 * career keeps a form value `form` (-0.9 .. +0.3) that moves after every match with the share of
 * points won (50% = no change; a loss also drops it); each event plays at skill + form, at most
 * maxSkill below the last two events (Pro only there), never below -1 (beginner, coach.js). After `unlockAfter` played
 * attempts without the trophy the next event opens anyway.
 */
export const ADAPT = Object.freeze({ gain: 1.4, up: 0.15, down: -0.3, lostMatch: -0.08, min: -0.9, max: 0.3, maxSkill: 1.45, unlockAfter: 3 });

/** Opponent skill of an event for a form value. */
export function eventSkill(ev, form = 0) {
  const cap = ev.tier >= 7 ? 2 : ADAPT.maxSkill;
  return Math.max(-1, Math.min(cap, ev.skill + (Number.isFinite(form) ? form : 0)));
}

/** Label of an opponent skill (event cards, intro): 'Rookie', 'Rookie+', 'Club-', 'Club', 'Club+', 'Pro-', 'Pro'. */
export function skillLabel(x) {
  if (x < -0.17) return 'Beginner';
  const name = { rookie: 'Rookie', club: 'Club', pro: 'Pro' }[levelOfSkill(x)];
  const base = x < 0.5 ? 0 : x < 1.5 ? 1 : 2;
  const d = x - base;
  return d > 0.17 ? `${name}+` : d < -0.17 ? `${name}−` : name;
}

/** Player card: name, personality info, kit. */
export function playerCard(id) {
  const p = PLAYERS[id];
  if (!p) return null;
  const per = PERSONALITIES[p.personality] || PERSONALITIES['all-rounder'];
  return { id, ...p, personalityInfo: { id: per.id, name: per.name, es: per.es, desc: per.desc, descEs: per.descEs, icon: per.icon } };
}

/** Trophy name for unlock texts ("Win the Regional Open"). */
export const trophyName = (id) => (EVENT_BY_ID[id] ? EVENT_BY_ID[id].name : id);

function freshState() {
  return {
    v: 1,
    partner: DEFAULT_PARTNER,
    events: {}, // id -> { status: 'won'|'lost'|'open', best: place|null, played: n, round: index }
    active: null, // { eventId, matchIndex, points: [winner,...], startedAt }
    history: [], // last results [{ eventId, round, won, score, at }]
    form: 0, // adaptive difficulty (ADAPT)
  };
}

/** Match spec for the app (app/game.js createGame): an AI pair, a partner, the venue and format. */
export function matchSpec(eventId, matchIndex = 0, partnerId = DEFAULT_PARTNER, { resume = null, quick = false, form = 0 } = {}) {
  const ev = EVENT_BY_ID[eventId];
  if (!ev) return null;
  const m = ev.matches[Math.min(matchIndex, ev.matches.length - 1)];
  const pair = PAIRS[m.pair];
  const opp = pair.players.map((id) => ({ id, ...PLAYERS[id] }));
  const pid = PARTNERS.includes(partnerId) ? partnerId : DEFAULT_PARTNER;
  const partner = { id: pid, ...PLAYERS[pid] };
  const skill = eventSkill(ev, form);
  return {
    kind: 'match',
    level: levelOfSkill(skill),
    skill,
    partnerSkill: Math.max(1, skill),
    skillLabel: skillLabel(skill),
    games: quick ? 1 : ev.games,
    venue: ev.venue,
    career: { eventId, matchIndex, round: m.round, roundEs: m.es, eventName: ev.name, tier: ev.tier, last: matchIndex === ev.matches.length - 1 },
    opponents: opp.map((p) => ({ id: p.id, name: p.name, short: p.short, personality: p.personality, handed: p.handed, kit: p.kit })),
    partner: { id: partner.id, name: partner.name, short: partner.short, personality: partner.personality, handed: partner.handed, kit: partner.kit },
    teamNames: [[`You & ${partner.short}`, 'Nosotros'], [pair.tag, pair.name]],
    pairName: pair.name,
    resume: resume && Array.isArray(resume.points) ? { points: resume.points.slice() } : null,
  };
}

/**
 * @param {{ storage?: {getItem,setItem}|null, now?: () => number }} o
 */
export function createCareer({ storage = null, now = () => Date.now() } = {}) {
  let st = freshState();
  try {
    const raw = storage && storage.getItem(CAREER_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && p.v === 1) st = { ...freshState(), ...p, events: { ...(p.events || {}) }, history: Array.isArray(p.history) ? p.history.slice(-20) : [] };
    }
  } catch {
    st = freshState();
  }
  if (!PARTNERS.includes(st.partner)) st.partner = DEFAULT_PARTNER;
  if (st.active && !EVENT_BY_ID[st.active.eventId]) st.active = null;

  function save() {
    try {
      if (storage) storage.setItem(CAREER_KEY, JSON.stringify(st));
    } catch {
      /* ignore */
    }
  }

  const won = (id) => !!(st.events[id] && st.events[id].best === 1);

  /**
   * An event is open once the previous one has been won, or played ADAPT.unlockAfter times (the
   * first is always open).
   */
  function isOpen(id) {
    const i = EVENTS.findIndex((e) => e.id === id);
    if (i <= 0) return i === 0;
    const prev = st.events[EVENTS[i - 1].id];
    return won(EVENTS[i - 1].id) || !!(prev && prev.played >= ADAPT.unlockAfter && isOpen(EVENTS[i - 1].id));
  }
  const form = () => (Number.isFinite(st.form) ? st.form : 0);

  /** Events with their status for the career map. */
  function events() {
    return EVENTS.map((e) => {
      const rec = st.events[e.id] || null;
      const active = st.active && st.active.eventId === e.id ? st.active : null;
      let status = 'locked';
      if (rec && rec.best === 1) status = 'won';
      else if (isOpen(e.id)) status = active ? 'in-progress' : rec && rec.played ? 'retry' : 'open';
      const sk = eventSkill(e, form());
      return {
        ...e,
        status,
        oppSkill: sk,
        oppLabel: skillLabel(sk),
        attempts: rec ? rec.played : 0,
        openedByAttempts: status !== 'locked' && EVENTS.indexOf(e) > 0 && !won(EVENTS[EVENTS.indexOf(e) - 1].id),
        best: rec ? rec.best : null,
        played: rec ? rec.played : 0,
        matchIndex: active ? active.matchIndex : 0,
        midMatch: !!(active && active.points && active.points.length),
      };
    });
  }

  /** The event to play next (the first not won), for the hub's career tile. */
  function current() {
    const list = events();
    return list.find((e) => e.status === 'in-progress') || list.find((e) => e.status !== 'won' && e.status !== 'locked') || list[list.length - 1];
  }

  /** Starts (or resumes) an event: returns the match spec to play, or null if locked. */
  function startEvent(id, { quick = false } = {}) {
    if (!isOpen(id) && !won(id)) return null;
    if (!st.active || st.active.eventId !== id) {
      st.active = { eventId: id, matchIndex: 0, points: [], startedAt: now() };
      save();
    }
    return matchSpec(id, st.active.matchIndex, st.partner, { resume: st.active.points.length ? { points: st.active.points } : null, quick, form: form() });
  }

  /** Point-by-point save of the match in progress (winners 0 | 1, lets excluded). */
  function saveMidMatch(points) {
    if (!st.active) return;
    st.active.points = (points || []).filter((w) => w === 0 || w === 1);
    save();
  }

  /**
   * A finished match of the active event. result: { won: boolean, score: display() }.
   * -> { eventId, eventDone, eventWon, place, nextMatch (spec|null), unlockedEvent (id|null), round }
   */
  function recordMatch(result = {}) {
    const a = st.active;
    if (!a) return null;
    const ev = EVENT_BY_ID[a.eventId];
    const m = ev.matches[a.matchIndex];
    const rec = st.events[ev.id] || (st.events[ev.id] = { best: null, played: 0 });
    st.history.push({ eventId: ev.id, round: m.round, won: !!result.won, games: result.score ? result.score.games : null, at: now() });
    if (st.history.length > 20) st.history.shift();
    // Adaptive difficulty: form follows the share of points won (and drops after a loss).
    const formBefore = form();
    const pp = Number(result.pointsPlayed), pw = Number(result.pointsWon);
    let dForm = pp > 0 && Number.isFinite(pw) ? Math.max(ADAPT.down, Math.min(ADAPT.up, (pw / pp - 0.5) * ADAPT.gain)) : result.won ? 0.05 : -0.1;
    if (!result.won) dForm += ADAPT.lostMatch;
    st.form = Math.max(ADAPT.min, Math.min(ADAPT.max, formBefore + dForm));
    const last = a.matchIndex >= ev.matches.length - 1;
    let out;
    if (result.won && !last) {
      a.matchIndex++;
      a.points = [];
      out = { eventId: ev.id, eventDone: false, eventWon: false, place: null, round: m.round, nextRound: ev.matches[a.matchIndex].round };
    } else {
      // Knockout: a loss ends the run; the place is the round reached.
      const remaining = ev.matches.length - 1 - a.matchIndex; // rounds after this one
      const place = result.won ? 1 : remaining === 0 ? 2 : remaining === 1 ? 3 : 4;
      rec.played++;
      if (rec.best === null || place < rec.best) rec.best = place;
      st.active = null;
      const i = EVENTS.indexOf(ev);
      const unlockedEvent = result.won && i < EVENTS.length - 1 && !won(EVENTS[i + 1].id) ? EVENTS[i + 1].id : null;
      out = { eventId: ev.id, eventDone: true, eventWon: !!result.won, place, round: m.round, unlockedEvent, tier: ev.tier };
    }
    out.form = st.form;
    out.formChange = st.form - formBefore;
    out.unlockedByAttempts = !result.won && out.eventDone && !won(ev.id) && rec.played >= ADAPT.unlockAfter && EVENTS.indexOf(ev) < EVENTS.length - 1 && !won(EVENTS[EVENTS.indexOf(ev) + 1].id)
      ? EVENTS[EVENTS.indexOf(ev) + 1].id : null;
    save();
    out.nextMatch = st.active ? matchSpec(st.active.eventId, st.active.matchIndex, st.partner, { form: st.form }) : null;
    return out;
  }

  function setPartner(id) {
    if (!PARTNERS.includes(id)) return false;
    st.partner = id;
    save();
    return true;
  }

  /** Gives up the event in progress (counts as played, no trophy). */
  function abandon() {
    if (!st.active) return;
    const rec = st.events[st.active.eventId] || (st.events[st.active.eventId] = { best: null, played: 0 });
    rec.played++;
    st.active = null;
    save();
  }

  function reset() {
    st = freshState();
    save();
  }

  return {
    get state() { return st; },
    get partner() { return st.partner; },
    /** Adaptive difficulty form (-0.9 .. +0.3, ADAPT). */
    get form() { return form(); },
    get active() { return st.active; },
    events,
    current,
    isOpen,
    won,
    startEvent,
    saveMidMatch,
    recordMatch,
    setPartner,
    abandon,
    reset,
    trophies: () => EVENTS.filter((e) => st.events[e.id] && st.events[e.id].best).map((e) => ({ id: e.id, name: e.name, es: e.es, tier: e.tier, venue: e.venue, place: st.events[e.id].best })),
  };
}
