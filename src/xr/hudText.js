// Text of the head-locked stereo HUD (pure): the app's HudState (game mode hud() plus main.js
// extras: prompt, miss, banner, lastShot) reduced to the few lines worth showing in the glasses.

const STROKES = {
  forehand: 'Forehand', backhand: 'Backhand', 'volley-fh': 'Forehand volley', 'volley-bh': 'Backhand volley',
  'glass-fh': 'Glass forehand', 'glass-bh': 'Glass backhand', bandeja: 'Bandeja', vibora: 'Víbora', smash: 'Smash',
  lob: 'Lob', chiquita: 'Chiquita', serve: 'Serve', drive: 'Drive',
};

export function strokeLabel(id) {
  if (!id) return '';
  return STROKES[id] || String(id).replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

const num = (v) => (Number.isFinite(v) ? v : null);

/**
 * @param {object|null} h HudState
 * @returns {{ title, reps, points, streak, shot, shotKind: 'good'|'miss'|'info'|'', note, key }}
 */
export function hudLines(h) {
  const out = { title: '', reps: '', points: '', streak: '', shot: '', shotKind: '', note: '', key: '' };
  if (!h || typeof h !== 'object') return out;
  out.title = String(h.title || '');
  const i = num(h.repIndex), n = num(h.repTotal);
  const sc = h.score;
  if (n) out.reps = `Rep ${Math.max(0, i || 0)} / ${n}`;
  else if (sc && Array.isArray(sc.games) && Array.isArray(sc.points)) {
    out.reps = `Games ${sc.games[0] ?? 0}–${sc.games[1] ?? 0} · ${sc.points[0] || 0}–${sc.points[1] || 0}`;
  } else if (num(h.rally) !== null) out.reps = `Rally ${h.rally}`;
  if (num(h.points) !== null) out.points = `${Math.round(h.points)} pts`;
  if (num(h.streak) && h.streak > 1) out.streak = `×${h.streak} streak`;
  const miss = h.miss && h.miss.text ? h.miss : null;
  const s = h.lastShot;
  if (miss) {
    out.shot = String(miss.text);
    out.shotKind = 'miss';
  } else if (s && (s.stroke || num(s.speedKmh) !== null)) {
    const parts = [strokeLabel(s.stroke)];
    const kmh = num(s.speedKmh) ?? (num(s.speedOut) !== null ? s.speedOut * 3.6 : null);
    if (kmh !== null) parts.push(`${Math.round(kmh)} km/h`);
    const spin = typeof s.spinRpm === 'number' ? s.spinRpm : s.spinRpm && num(s.spinRpm.total);
    if (num(spin) !== null && Math.abs(spin) >= 100) parts.push(`${Math.round(Math.abs(spin) / 10) * 10} rpm`);
    out.shot = parts.filter(Boolean).join(' · ');
    out.shotKind = s.success === false || (s.result && s.result.success === false) ? 'info' : 'good';
  }
  if (h.banner && h.banner.text) out.note = String(h.banner.text);
  else if (h.prompt) out.note = String(h.prompt);
  out.key = [out.title, out.reps, out.points, out.streak, out.shot, out.shotKind, out.note].join('|');
  return out;
}
