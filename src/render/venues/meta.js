// Venue metadata (pure: no three, no DOM). Shared by the renderer (environment.js) and the
// audio engine (reverb profile, ambience bed, crowd level and where the crowd sits).
//
// Court frame: metres, Y up, net plane z = 0, interior x ∈ [-5, 5], z ∈ [-10, 10].

/** Selectable venues, in menu order. */
export const VENUE_IDS = Object.freeze(['club', 'sunset', 'stadium']);
export const DEFAULT_VENUE = 'club';

/**
 * acoustics: { kind: 'hall'|'open'|'arena', rt60 (s), wet (send level into the reverb), predelay (s),
 *   damp (0..1 high-frequency damping of the tail), early: early-reflection density (0..1) }
 * crowd: { level 0..1 (how many people react, how loud), bed: murmur level between points,
 *   sources: positions the crowd is heard from (court frame) }
 * grade: display-referred colour grade applied after tone mapping (scene.js GRADE_SHADER):
 *   { lift [r,g,b], gamma [r,g,b], gain [r,g,b], saturation, contrast, vignette, warmth }
 * hdri: the photographed panorama mixed into the venue's image-based lighting (assets/env/<hdri>.exr,
 *   render/ibl.js; loaded lazily when the venue is shown)
 * toneMapping: 'aces' | 'agx' | 'neutral' (render/scene.js output pass), chosen by eye per venue
 */
const VENUES = {
  club: {
    id: 'club',
    name: 'Víbora Padel Club',
    es: 'Club Víbora',
    blurb: { en: 'Indoor club at night: three courts under LED panels.', es: 'Club cubierto de noche: tres pistas bajo paneles LED.' },
    kind: 'indoor',
    acoustics: { kind: 'hall', rt60: 1.4, wet: 0.15, predelay: 0.012, damp: 0.55, early: 0.7 },
    crowd: {
      level: 0.18,
      bed: 0.0,
      sources: [{ x: -6.6, y: 1.1, z: -1.4 }, { x: 6.6, y: 1.1, z: 1.4 }, { x: 0, y: 2.0, z: -14 }],
    },
    ambience: 'club',
    hdri: 'warehouse',
    // Round 6, chosen by eye (ACES / AgX / Neutral side by side): Neutral keeps the turf a true
    // saturated court blue and the LED whites clean; ACES pushed it toward pastel cyan, AgX grey.
    toneMapping: 'neutral',
    exposure: 1.12,
    grade: { lift: [0.004, 0.004, 0.008], gamma: [1, 1, 1], gain: [1.0, 1.0, 1.02], saturation: 1.04, contrast: 1.08, vignette: 0.2, warmth: 0 },
  },
  sunset: {
    id: 'sunset',
    name: 'Costa Sunset',
    es: 'Atardecer en la costa',
    blurb: { en: 'Outdoor Mediterranean court at golden hour.', es: 'Pista exterior mediterránea a la hora dorada.' },
    kind: 'outdoor',
    // Open air: no hall tail, only a short slap off the court's own glass.
    acoustics: { kind: 'open', rt60: 0.32, wet: 0.05, predelay: 0.006, damp: 0.75, early: 0.35 },
    crowd: {
      level: 0.3,
      bed: 0.0,
      sources: [{ x: -7.5, y: 1.2, z: 2.0 }, { x: -7.5, y: 1.2, z: -3.0 }, { x: 4, y: 1.4, z: 19.5 }],
    },
    ambience: 'sunset',
    hdri: 'sunset',
    // ACES: its warm highlight roll-off is the golden-hour look (Neutral kept the sky too pink).
    toneMapping: 'aces',
    exposure: 1.0,
    grade: { lift: [0.014, 0.004, 0.022], gamma: [0.97, 1.0, 1.04], gain: [1.07, 1.0, 0.9], saturation: 1.12, contrast: 1.07, vignette: 0.28, warmth: 0.6 },
  },
  stadium: {
    id: 'stadium',
    name: 'Víbora Tour Finals',
    es: 'Finales del Víbora Tour',
    blurb: { en: 'Pro-tour show court: packed stands, LED boards, TV lights.', es: 'Pista central del circuito: gradas llenas, LEDs y luces de TV.' },
    kind: 'arena',
    acoustics: { kind: 'arena', rt60: 2.3, wet: 0.22, predelay: 0.028, damp: 0.6, early: 0.9 },
    crowd: {
      level: 1,
      bed: 0.55,
      sources: [
        { x: -14, y: 4, z: -4 }, { x: -14, y: 4, z: 6 }, { x: 14, y: 4, z: -6 }, { x: 14, y: 4, z: 4 },
        { x: 0, y: 4.5, z: -19 }, { x: 0, y: 4.5, z: 19 },
      ],
    },
    ambience: 'stadium',
    // 'esplanade' (a dark concourse with downlights): the 'hall' ballroom's chandeliers reflected as
    // big white cones in the far glass, the 'night' field's horizon as white panes.
    hdri: 'esplanade',
    // Neutral: broadcast colour (saturated boards, a deep court blue under the TV lights).
    toneMapping: 'neutral',
    exposure: 0.95,
    grade: { lift: [0.0, 0.002, 0.008], gamma: [1, 1, 1], gain: [1.02, 1.01, 1.0], saturation: 1.06, contrast: 1.12, vignette: 0.16, warmth: 0.1 },
  },
};

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  return Object.freeze(o);
};
for (const v of Object.values(VENUES)) deepFreeze(v);

/** Normalises a venue id (unknown values fall back to the club). */
export function venueId(id) {
  return VENUE_IDS.includes(id) ? id : DEFAULT_VENUE;
}

/** Frozen metadata of a venue: { id, name, es, kind, acoustics, crowd, ambience, exposure, grade }. */
export function venueMeta(id) {
  return VENUES[venueId(id)];
}

/** Menu entries for a settings control: [[id, name], ...]. */
export function venueOptions(lang = 'en') {
  return VENUE_IDS.map((id) => [id, lang === 'es' ? VENUES[id].es : VENUES[id].name]);
}
