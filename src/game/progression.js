// Player progression: XP and levels, unlockable rackets (with real stat trade-offs, applied
// through physics/racket.js profiles) and outfits, trophies, achievements and lifetime fitness.
// Saved through an injected storage ({ getItem, setItem }, e.g. localStorage) with try/catch.
// Pure module.

export const PROFILE_KEY = 'vibora.profile.v1';
export const MAX_LEVEL = 50;

/** Total XP needed to reach level L (level 1 = 0 XP). Gentle early, steeper later. */
export function xpForLevel(L) {
  const l = Math.max(1, Math.min(MAX_LEVEL, Math.floor(L)));
  let total = 0;
  for (let i = 1; i < l; i++) total += Math.round(250 + 90 * i ** 1.25);
  return total;
}

/** { level, into, need, progress 0..1 } for a total XP. */
export function levelOf(xp) {
  const x = Math.max(0, Number.isFinite(xp) ? xp : 0);
  let L = 1;
  while (L < MAX_LEVEL && x >= xpForLevel(L + 1)) L++;
  const base = xpForLevel(L);
  const next = L < MAX_LEVEL ? xpForLevel(L + 1) : base;
  const need = next - base;
  return { level: L, into: x - base, need, progress: need > 0 ? (x - base) / need : 1 };
}

/** Level titles shown under the XP bar. */
export function rankTitle(level) {
  if (level >= 40) return { en: 'World Padel legend', es: 'Leyenda' };
  if (level >= 30) return { en: 'Pro tour player', es: 'Jugador profesional' };
  if (level >= 20) return { en: 'National contender', es: 'Aspirante nacional' };
  if (level >= 12) return { en: 'Regional competitor', es: 'Competidor regional' };
  if (level >= 6) return { en: 'Club regular', es: 'Habitual del club' };
  return { en: 'Newcomer', es: 'Recién llegado' };
}

// ---------------------------------------------------------------------------
// Rackets: shape, foam and face change power, control, sweet-spot size and spin.
// physics: racketImpact overrides (physical / Pro hits); timing: factors for timing hits
// (pace of the shot, scatter of the landing point, tolerance of the timing window).
// Stats are 1..10 for the UI. All original designs: no real brand.

export const RACKETS = Object.freeze([
  Object.freeze({
    id: 'fang', name: 'Víbora Fang', es: 'Lágrima híbrida', shape: 'teardrop', color: '#e8572a', frame: 'carbon',
    tag: 'Teardrop · medium EVA', desc: 'The all-court racket you start with: balanced power and control.',
    stats: Object.freeze({ power: 6, control: 6, sweetSpot: 6, spin: 6 }),
    physics: Object.freeze({ apparentCOR: 0.42, corFalloff: 0.6, minCOR: 0.18, mu: 0.45 }),
    timing: Object.freeze({ pace: 1, scatter: 1, window: 1, spin: 1 }),
    unlock: Object.freeze({ level: 1 }),
  }),
  Object.freeze({
    id: 'orbit', name: 'Orbit Round', es: 'Redonda control', shape: 'round', color: '#1f6fe0', frame: 'white',
    tag: 'Round · soft EVA', desc: 'Big, centred sweet spot and soft feel. Forgiving, accurate, a little less pace.',
    stats: Object.freeze({ power: 4, control: 9, sweetSpot: 9, spin: 5 }),
    physics: Object.freeze({ apparentCOR: 0.4, corFalloff: 0.38, minCOR: 0.22, mu: 0.44 }),
    timing: Object.freeze({ pace: 0.94, scatter: 0.72, window: 1.12, spin: 0.95 }),
    unlock: Object.freeze({ level: 3 }),
  }),
  Object.freeze({
    id: 'grit', name: 'Grit 3D Spin', es: 'Superficie rugosa', shape: 'teardrop', color: '#13a89e', frame: 'matte',
    tag: 'Teardrop · 3D sanded face', desc: 'Sand-textured face that grips the ball: heavy topspin and biting slice.',
    stats: Object.freeze({ power: 6, control: 6, sweetSpot: 6, spin: 9 }),
    physics: Object.freeze({ apparentCOR: 0.415, corFalloff: 0.6, minCOR: 0.18, mu: 0.58 }),
    timing: Object.freeze({ pace: 1, scatter: 0.95, window: 1, spin: 1.3 }),
    unlock: Object.freeze({ level: 6 }),
  }),
  Object.freeze({
    id: 'cobra', name: 'Cobra Diamond', es: 'Diamante potencia', shape: 'diamond', color: '#d81b4f', frame: 'carbon',
    tag: 'Diamond · hard EVA', desc: 'High balance and a sweet spot near the tip: huge smashes, unforgiving off-centre.',
    stats: Object.freeze({ power: 10, control: 4, sweetSpot: 3, spin: 6 }),
    physics: Object.freeze({ apparentCOR: 0.46, corFalloff: 0.85, minCOR: 0.16, mu: 0.45 }),
    timing: Object.freeze({ pace: 1.1, scatter: 1.25, window: 0.9, spin: 1 }),
    unlock: Object.freeze({ trophy: 'regional' }),
  }),
  Object.freeze({
    id: 'mamba', name: 'Mamba Pro 18K', es: 'Carbono 18K', shape: 'teardrop', color: '#eceae4', frame: 'carbon',
    tag: 'Teardrop · 18K carbon, hard core', desc: 'The tour racket: fast, precise and spinny once you find the middle.',
    stats: Object.freeze({ power: 8, control: 8, sweetSpot: 5, spin: 8 }),
    physics: Object.freeze({ apparentCOR: 0.445, corFalloff: 0.68, minCOR: 0.17, mu: 0.52 }),
    timing: Object.freeze({ pace: 1.06, scatter: 0.85, window: 0.95, spin: 1.15 }),
    unlock: Object.freeze({ trophy: 'national' }),
  }),
]);
export const RACKET_BY_ID = Object.freeze(Object.fromEntries(RACKETS.map((r) => [r.id, r])));
export const DEFAULT_RACKET = 'fang';

/** Racket profile for an id (unknown ids fall back to the starter racket). */
export function racketById(id) {
  return RACKET_BY_ID[id] || RACKET_BY_ID[DEFAULT_RACKET];
}

// Outfits: colour sets of the player's own kit (first-person sleeves / wristbands, replay body).
export const OUTFITS = Object.freeze([
  Object.freeze({ id: 'club', name: 'Club navy', es: 'Azul club', shirt: '#1d2b4a', sleeve: '#1d2b4a', band: '#f2f2f2', shorts: '#10131a', unlock: Object.freeze({ level: 1 }) }),
  Object.freeze({ id: 'court', name: 'Court blue', es: 'Azul pista', shirt: '#2a5aa6', sleeve: '#2a5aa6', band: '#dcf53c', shorts: '#14213a', unlock: Object.freeze({ level: 2 }) }),
  Object.freeze({ id: 'sunset', name: 'Sunset coral', es: 'Coral atardecer', shirt: '#ff7a59', sleeve: '#ff7a59', band: '#1d2b4a', shorts: '#f4efe4', unlock: Object.freeze({ trophy: 'atardecer' }) }),
  Object.freeze({ id: 'optic', name: 'Optic', es: 'Amarillo óptico', shirt: '#dcf53c', sleeve: '#dcf53c', band: '#0e1405', shorts: '#0e1405', unlock: Object.freeze({ level: 8 }) }),
  Object.freeze({ id: 'mono', name: 'Tour white', es: 'Blanco tour', shirt: '#f4f2ec', sleeve: '#f4f2ec', band: '#e8572a', shorts: '#f4f2ec', unlock: Object.freeze({ level: 14 }) }),
  Object.freeze({ id: 'black', name: 'Finals black', es: 'Negro final', shirt: '#121418', sleeve: '#121418', band: '#dcf53c', shorts: '#121418', unlock: Object.freeze({ trophy: 'finals' }) }),
]);
export const OUTFIT_BY_ID = Object.freeze(Object.fromEntries(OUTFITS.map((o) => [o.id, o])));
export const DEFAULT_OUTFIT = 'club';

/** Outfit colours for an id (unknown ids fall back to the club kit). */
export function outfitById(id) {
  return OUTFIT_BY_ID[id] || OUTFIT_BY_ID[DEFAULT_OUTFIT];
}

// ---------------------------------------------------------------------------
// XP awards

/**
 * XP for a finished session. summary: { kind: 'drill'|'rally'|'match'|'challenge', stars, points, won,
 * gamesWon, bestRally, playerHits, score (challenge), activeSeconds, career?: { eventWon, round } }.
 */
export function xpForSession(s = {}) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  let xp = 0;
  const parts = [];
  const add = (v, en, es) => {
    const k = Math.max(0, Math.round(v));
    if (k > 0) {
      xp += k;
      parts.push({ xp: k, en, es });
    }
  };
  switch (s.kind) {
    case 'drill':
      add(30, 'Drill completed', 'Ejercicio completado');
      add(40 * n(s.stars), `${n(s.stars)} star${n(s.stars) === 1 ? '' : 's'}`, 'Estrellas');
      add(Math.min(60, n(s.points) / 40), 'Points', 'Puntos');
      break;
    case 'rally':
      add(Math.min(120, 4 * n(s.playerHits)), 'Balls returned', 'Bolas devueltas');
      add(Math.min(120, 6 * n(s.bestRally)), 'Longest rally', 'Peloteo más largo');
      break;
    case 'match':
      add(s.won ? 250 : 80, s.won ? 'Match won' : 'Match played', s.won ? 'Partido ganado' : 'Partido jugado');
      add(25 * n(s.gamesWon), 'Games won', 'Juegos ganados');
      if (s.career && s.career.eventWon) add(400 + 150 * n(s.career.tier), 'Tournament won', 'Torneo ganado');
      // Round 5: a tournament played to its end without the trophy still counts.
      else if (s.career && s.career.eventDone) add(60 + 20 * n(s.career.tier), 'Tournament played', 'Torneo disputado');
      break;
    case 'challenge':
      add(40, 'Challenge played', 'Reto jugado');
      add(Math.min(250, n(s.score) / 25), 'Score', 'Puntuación');
      if (s.daily) add(60, 'Daily challenge', 'Reto diario');
      if (s.newBest) add(50, 'Personal best', 'Récord personal');
      break;
    default:
      break;
  }
  add(Math.min(150, n(s.activeSeconds) / 6), 'Active time', 'Tiempo activo');
  return { xp, parts };
}

// ---------------------------------------------------------------------------
// Profile store

const today = (now) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / 86400000);

function freshProfile() {
  return {
    v: 1,
    xp: 0,
    racket: DEFAULT_RACKET,
    outfit: DEFAULT_OUTFIT,
    unlocked: { rackets: [DEFAULT_RACKET], outfits: [DEFAULT_OUTFIT] },
    trophies: {}, // id -> { place: 1|2|3|4, at }
    achievements: {}, // id -> at
    drillsPlayed: [],
    lifetime: { sessions: 0, activeSeconds: 0, kcal: 0, swings: 0, shots: 0, bestRally: 0 },
    streak: { days: 0, last: null, best: 0 },
    seen: { rackets: [DEFAULT_RACKET], outfits: [DEFAULT_OUTFIT] },
  };
}

function sanitize(p) {
  const f = freshProfile();
  if (!p || typeof p !== 'object') return f;
  const out = { ...f, ...p };
  out.xp = Number.isFinite(p.xp) && p.xp >= 0 ? p.xp : 0;
  out.unlocked = {
    rackets: Array.isArray(p.unlocked?.rackets) ? p.unlocked.rackets.filter((id) => RACKET_BY_ID[id]) : f.unlocked.rackets,
    outfits: Array.isArray(p.unlocked?.outfits) ? p.unlocked.outfits.filter((id) => OUTFIT_BY_ID[id]) : f.unlocked.outfits,
  };
  if (!out.unlocked.rackets.includes(DEFAULT_RACKET)) out.unlocked.rackets.unshift(DEFAULT_RACKET);
  if (!out.unlocked.outfits.includes(DEFAULT_OUTFIT)) out.unlocked.outfits.unshift(DEFAULT_OUTFIT);
  out.racket = out.unlocked.rackets.includes(p.racket) ? p.racket : DEFAULT_RACKET;
  out.outfit = out.unlocked.outfits.includes(p.outfit) ? p.outfit : DEFAULT_OUTFIT;
  out.trophies = p.trophies && typeof p.trophies === 'object' ? { ...p.trophies } : {};
  out.achievements = p.achievements && typeof p.achievements === 'object' ? { ...p.achievements } : {};
  out.drillsPlayed = Array.isArray(p.drillsPlayed) ? p.drillsPlayed.slice(0, 64) : [];
  out.lifetime = { ...f.lifetime, ...(p.lifetime || {}) };
  out.streak = { ...f.streak, ...(p.streak || {}) };
  out.seen = {
    rackets: Array.isArray(p.seen?.rackets) ? p.seen.rackets : out.unlocked.rackets.slice(),
    outfits: Array.isArray(p.seen?.outfits) ? p.seen.outfits : out.unlocked.outfits.slice(),
  };
  return out;
}

/** Whether an unlock rule is met by a profile: { level } | { trophy } | { achievement }. */
export function unlockMet(rule, p) {
  if (!rule) return true;
  if (rule.level != null && levelOf(p.xp).level < rule.level) return false;
  if (rule.trophy && !(p.trophies[rule.trophy] && p.trophies[rule.trophy].place === 1)) return false;
  if (rule.achievement && !p.achievements[rule.achievement]) return false;
  return true;
}

/** Human-readable unlock rule: "Reach level 6", "Win the Regional Open". */
export function unlockText(rule, trophyName = (id) => id) {
  if (!rule) return { en: 'Unlocked', es: 'Desbloqueado' };
  if (rule.trophy) return { en: `Win the ${trophyName(rule.trophy)}`, es: `Gana ${trophyName(rule.trophy)}` };
  if (rule.achievement) return { en: 'Achievement', es: 'Logro' };
  return { en: `Reach level ${rule.level}`, es: `Nivel ${rule.level}` };
}

/**
 * @param {{ storage?: {getItem,setItem}|null, now?: () => number }} o
 */
export function createProgress({ storage = null, now = () => Date.now() } = {}) {
  let p = freshProfile();
  try {
    const raw = storage && storage.getItem(PROFILE_KEY);
    if (raw) p = sanitize(JSON.parse(raw));
  } catch {
    p = freshProfile();
  }

  function save() {
    try {
      if (storage) storage.setItem(PROFILE_KEY, JSON.stringify(p));
    } catch {
      /* quota / private mode: keep it in memory */
    }
  }

  /** Unlocks every racket / outfit whose rule is now met. Returns the new ones. */
  function refreshUnlocks() {
    const out = [];
    for (const r of RACKETS) {
      if (!p.unlocked.rackets.includes(r.id) && unlockMet(r.unlock, p)) {
        p.unlocked.rackets.push(r.id);
        out.push({ kind: 'racket', id: r.id, name: r.name, es: r.es });
      }
    }
    for (const o of OUTFITS) {
      if (!p.unlocked.outfits.includes(o.id) && unlockMet(o.unlock, p)) {
        p.unlocked.outfits.push(o.id);
        out.push({ kind: 'outfit', id: o.id, name: o.name, es: o.es });
      }
    }
    return out;
  }

  /** Adds XP. -> { gained, xp, before, after (levels), levelUps: [levels], unlocks: [...] } */
  function addXp(amount) {
    const gained = Math.max(0, Math.round(Number.isFinite(amount) ? amount : 0));
    const before = levelOf(p.xp).level;
    p.xp += gained;
    const after = levelOf(p.xp).level;
    const levelUps = [];
    for (let l = before + 1; l <= after; l++) levelUps.push(l);
    const unlocks = refreshUnlocks();
    save();
    return { gained, xp: p.xp, before, after, levelUps, unlocks };
  }

  /** A tournament result: place 1 (won), 2 (final), 3 (semi), 4 (earlier). Keeps the best. */
  function awardTrophy(id, place) {
    const prev = p.trophies[id];
    const isNew = !prev || place < prev.place;
    if (isNew) p.trophies[id] = { place, at: now() };
    const unlocks = refreshUnlocks();
    save();
    return { isNew, place: isNew ? place : prev.place, unlocks };
  }

  function unlockAchievement(id) {
    if (p.achievements[id]) return false;
    p.achievements[id] = now();
    save();
    return true;
  }

  function equip(kind, id) {
    if (kind === 'racket' && p.unlocked.rackets.includes(id)) p.racket = id;
    else if (kind === 'outfit' && p.unlocked.outfits.includes(id)) p.outfit = id;
    else return false;
    save();
    return true;
  }

  /** Marks unlocks as seen (the trophies screen clears its "new" badges). */
  function markSeen() {
    p.seen = { rackets: p.unlocked.rackets.slice(), outfits: p.unlocked.outfits.slice() };
    save();
  }

  /**
   * Adds a finished session to the lifetime totals and the daily streak.
   * stats: { activeSeconds, kcal, swings, shots, bestRally, drillId }
   */
  function recordSession(stats = {}) {
    const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
    const L = p.lifetime;
    L.sessions++;
    L.activeSeconds += n(stats.activeSeconds);
    L.kcal += n(stats.kcal);
    L.swings += n(stats.swings);
    L.shots += n(stats.shots);
    L.bestRally = Math.max(L.bestRally, n(stats.bestRally));
    if (stats.drillId && !p.drillsPlayed.includes(stats.drillId)) p.drillsPlayed.push(stats.drillId);
    const d = today(now());
    const s = p.streak;
    if (s.last !== d) {
      const gap = s.last ? dayDiff(s.last, d) : null;
      s.days = gap === 1 ? s.days + 1 : 1;
      s.last = d;
      s.best = Math.max(s.best, s.days);
    }
    save();
    return { streak: s.days, lifetime: { ...L } };
  }

  function reset() {
    p = freshProfile();
    save();
  }

  return {
    get data() { return p; },
    get level() { return levelOf(p.xp); },
    get racket() { return racketById(p.racket); },
    get outfit() { return outfitById(p.outfit); },
    isUnlocked: (kind, id) => (kind === 'racket' ? p.unlocked.rackets : p.unlocked.outfits).includes(id),
    isNew: (kind, id) => (kind === 'racket' ? p.unlocked.rackets : p.unlocked.outfits).includes(id)
      && !(kind === 'racket' ? p.seen.rackets : p.seen.outfits).includes(id),
    addXp,
    awardTrophy,
    unlockAchievement,
    equip,
    markSeen,
    recordSession,
    refreshUnlocks,
    save,
    reset,
  };
}
