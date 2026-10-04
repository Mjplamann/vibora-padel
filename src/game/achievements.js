// Achievements: what a padel player is proud of. The tracker listens to a session's bus events
// (and to session / career results) and reports newly earned achievements once; the app saves
// them in the profile (game/progression.js), awards their XP and shows a toast. Pure module.

import { isPerfectHit } from './challenges.js';

const T = (id, name, es, desc, descEs, xp, tier, icon) => Object.freeze({ id, name, es, desc, descEs, xp, tier, icon });

export const ACHIEVEMENTS = Object.freeze([
  T('first-hit', 'First contact', 'Primer golpe', 'Hit your first ball.', 'Golpea tu primera bola.', 50, 'bronze', 'ball'),
  T('por-tres', '¡Por tres!', '¡Por tres!', 'Smash a ball out over the back wall.', 'Saca una bola por encima del fondo.', 200, 'silver', 'smash'),
  T('por-cuatro', '¡Por cuatro!', '¡Por cuatro!', 'Smash a ball out over the side wall.', 'Saca una bola por la puerta lateral.', 200, 'silver', 'smash'),
  T('rally-10', 'Peloteo', 'Peloteo', 'Play a 10-shot rally.', 'Juega un peloteo de 10 golpes.', 100, 'bronze', 'rally'),
  T('rally-20', 'Twenty and counting', 'Veinte y contando', 'Play a 20-shot rally.', 'Juega un peloteo de 20 golpes.', 250, 'silver', 'rally'),
  T('perfect-5', 'In the zone', 'Inspirado', '5 perfect-timing shots in a row.', '5 golpes perfectos seguidos.', 150, 'bronze', 'timing'),
  T('perfect-volleys-10', 'Wall of hands', 'Muro de manos', '10 perfect volleys in a row.', '10 voleas perfectas seguidas.', 300, 'gold', 'volley'),
  T('clean-sheet', 'Clean sheet', 'Juego en blanco', 'Win a game to love.', 'Gana un juego a cero.', 200, 'silver', 'shield'),
  T('golden-point', 'Nerves of steel', 'Nervios de acero', 'Win a golden point.', 'Gana un punto de oro.', 150, 'bronze', 'gold'),
  T('back-glass-master', 'Back-glass master', 'Maestro de la pared', '10 good returns off the back glass in one session.', '10 buenas salidas de pared en una sesión.', 250, 'silver', 'glass'),
  T('chiquita-artist', 'Chiquita artist', 'Artista de la chiquita', '5 good chiquitas in one session.', '5 chiquitas buenas en una sesión.', 200, 'silver', 'touch'),
  T('cannon', 'Cannon', 'Cañonazo', 'Smash at 120 km/h or faster.', 'Remata a 120 km/h o más.', 150, 'bronze', 'power'),
  T('heavy-topspin', 'Heavy topspin', 'Liftado pesado', 'Hit a ball with 2,500 rpm of topspin.', 'Golpea con 2.500 rpm de liftado.', 150, 'bronze', 'spin'),
  T('star-pupil', 'Star pupil', 'Alumno estrella', 'Earn 3 stars in a drill.', 'Consigue 3 estrellas en un ejercicio.', 150, 'bronze', 'star'),
  T('curriculum', 'Complete curriculum', 'Plan completo', 'Play every drill.', 'Juega todos los ejercicios.', 300, 'silver', 'book'),
  T('first-win', 'First win', 'Primera victoria', 'Win a match.', 'Gana un partido.', 200, 'bronze', 'trophy'),
  T('arcade-ace', 'Arcade ace', 'As del arcade', 'Score 10,000 in an arcade challenge.', 'Haz 10.000 puntos en un reto.', 200, 'silver', 'arcade'),
  T('glass-smasher', 'Glass smasher', 'Rompecristales', 'Shatter 10 targets in one Glass Breaker run.', 'Rompe 10 dianas en una partida.', 250, 'silver', 'glass'),
  T('sweat', 'Sweat session', 'Buena sudada', '20 active minutes in one session.', '20 minutos activos en una sesión.', 200, 'silver', 'fitness'),
  T('habit', 'Daily habit', 'Hábito diario', 'Play three days in a row.', 'Juega tres días seguidos.', 250, 'silver', 'calendar'),
  T('club-champion', 'Club champion', 'Campeón del club', 'Win the Club Open.', 'Gana el Open del club.', 200, 'bronze', 'trophy'),
  T('regional-champion', 'Regional champion', 'Campeón regional', 'Win the Regional Open.', 'Gana el Open regional.', 400, 'silver', 'trophy'),
  T('national-champion', 'National champion', 'Campeón nacional', 'Win the National Championship.', 'Gana el Campeonato nacional.', 600, 'gold', 'trophy'),
  T('tour-champion', 'Tour champion', 'Campeón del circuito', 'Win the Pro Tour Finals.', 'Gana las Finales del circuito.', 1000, 'gold', 'crown'),
]);
export const ACHIEVEMENT_BY_ID = Object.freeze(Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a])));

const VOLLEYS = new Set(['volley-fh', 'volley-bh']);
const CAREER_ACH = { 'club-open': 'club-champion', regional: 'regional-champion', national: 'national-champion', finals: 'tour-champion' };

/**
 * @param {{ has: (id) => boolean, ctx?: { kind, drillId, challengeId } }} o
 *   has: whether an achievement is already earned (profile).
 * @returns tracker with onBus(type, payload) -> earned[], onSession(summary, profileData) -> earned[],
 *   onCareer(result) -> earned[], state.
 */
export function createAchievementTracker({ has = () => false, ctx = {} } = {}) {
  const earnedNow = new Set();
  const st = { perfectStreak: 0, perfectVolleys: 0, glassGood: 0, chiquitaGood: 0, shots: new Map() };

  function earn(id, out) {
    if (!ACHIEVEMENT_BY_ID[id] || earnedNow.has(id) || has(id)) return;
    earnedNow.add(id);
    out.push(ACHIEVEMENT_BY_ID[id]);
  }

  function onBus(type, p) {
    const out = [];
    if (!p) return out;
    switch (type) {
      case 'ball:hit': {
        const s = p.shot;
        if (!s || s.by !== 'player' || s.provisional) break;
        st.shots.set(s.id, s);
        if (st.shots.size > 60) st.shots.delete(st.shots.keys().next().value);
        earn('first-hit', out);
        const kmh = Number.isFinite(s.speedOut) ? s.speedOut * 3.6 : 0;
        if (s.stroke === 'smash' && kmh >= 120) earn('cannon', out);
        if (s.spinRpm && s.spinRpm.top >= 2500) earn('heavy-topspin', out);
        const perfect = isPerfectHit(s);
        st.perfectStreak = perfect ? st.perfectStreak + 1 : 0;
        if (st.perfectStreak >= 5) earn('perfect-5', out);
        if (VOLLEYS.has(s.stroke)) {
          st.perfectVolleys = perfect ? st.perfectVolleys + 1 : 0;
          if (st.perfectVolleys >= 10) earn('perfect-volleys-10', out);
        }
        break;
      }
      case 'shot:result': {
        const s = p.shotId != null ? st.shots.get(p.shotId) : null;
        if (!s || !p.success) break;
        if (s.afterWall) {
          st.glassGood++;
          if (st.glassGood >= 10) earn('back-glass-master', out);
        }
        if (s.stroke === 'chiquita') {
          st.chiquitaGood++;
          if (st.chiquitaGood >= 5) earn('chiquita-artist', out);
        }
        break;
      }
      case 'rally:outcome': {
        const mine = p.winner === 0 && (p.lastBy === 'player' || p.lastBy === undefined);
        if (p.reason === 'por-tres' && mine) earn('por-tres', out);
        if (p.reason === 'por-cuatro' && mine) earn('por-cuatro', out);
        const len = Number.isFinite(p.rallyLength) ? p.rallyLength : 0;
        if (len >= 10) earn('rally-10', out);
        if (len >= 20) earn('rally-20', out);
        if (p.cleanSheet && p.winner === 0) earn('clean-sheet', out);
        if (p.golden && p.winner === 0) earn('golden-point', out);
        break;
      }
      case 'match:end':
        if (p.summary && p.summary.winner === 0) earn('first-win', out);
        break;
      case 'challenge:end': {
        const s = p.summary || {};
        if (s.score >= 10000) earn('arcade-ace', out);
        if (s.shattered >= 10) earn('glass-smasher', out);
        break;
      }
      case 'drill:end': {
        const s = p.summary || {};
        if (s.stars >= 3) earn('star-pupil', out);
        break;
      }
      default:
        break;
    }
    return out;
  }

  /**
   * End of a session. summary: { activeSeconds }, profile: progression data ({ drillsPlayed, streak }),
   * drillCount: total drills in the curriculum.
   */
  function onSession(summary = {}, profile = null, drillCount = 13) {
    const out = [];
    if ((summary.activeSeconds || 0) >= 20 * 60) earn('sweat', out);
    if (profile) {
      if ((profile.drillsPlayed || []).length >= drillCount) earn('curriculum', out);
      if (profile.streak && profile.streak.days >= 3) earn('habit', out);
    }
    return out;
  }

  /** Career result (career.recordMatch). */
  function onCareer(result) {
    const out = [];
    if (result && result.eventWon && CAREER_ACH[result.eventId]) earn(CAREER_ACH[result.eventId], out);
    return out;
  }

  return { onBus, onSession, onCareer, get state() { return st; }, ctx, get earned() { return [...earnedNow]; } };
}
