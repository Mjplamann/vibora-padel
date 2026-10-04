// URL flags (SPEC §10.6 plus integration extras). Read once at boot.
//   ?autopilot=1        synthetic camera + autopilot drive the real pipeline (skips camera/calibration)
//   ?speed=N            N sim-seconds per real second (headless smoke runs)
//   ?debug=1            fps / draw calls / inference / latency overlay
//   ?drill=<id>         jump straight into a drill
//   ?mode=rally|match   jump straight into a rally or match (?level=rookie|club|pro)
//   ?fallback=1         mouse / trackpad controls (no camera)
//   ?quality=ultra|high|balanced
//   ?assist=rookie|club|pro   assist level for this visit (QA; Settings changes persist as usual)
//   ?pitch=<deg>, ?fov=<deg>   override the first-person framing (testing)
//   ?eyeback=<m>, ?eyedown=<m> viewpoint offset behind / below the tracked eyes (testing)
//   ?attract=0          no autopilot demo behind the title screen
//   ?seed=N             RNG seed for the session
//   ?aplatency=<s>      display latency the autopilot plays with (default 0: it sees the true ball)
//   ?apdelivery=<s>     capture -> pose result delay of the autopilot's synthetic camera (default 0.045)
//   ?approfile=human|precise  how the autopilot plays (tracking/autopilot.js HUMAN_PROFILE: timing
//                       σ 90 ms, racket position error, partial steps, 5% no-swing); default precise
//   ?apjitter=<s>       extra random capture -> result delay (uniform 0..apjitter) of a 30 fps
//                       webcam-like feed (app/game.js installRealisticFeed)
//   ?apnoise=<k>        landmark noise of that feed (1 = a MacBook camera at ~2.5 m)
//   ?apclose=1          close-mode autopilot feed (app/closeFeed.js: 1.7 m from a camera at chest height, legs out of frame)
//   (glasses mode reads its own flags in src/xr/boot.js: ?glasses=1, ?stereo=1, ?xrsim=1|legacy)
// Round 4 (career, arcade, venues):
//   ?venue=club|sunset|stadium   venue for this visit (free play; career events keep their own)
//   ?challenge=<id>|daily|daily:<YYYY-MM-DD>   jump into an arcade challenge (game/challenges.js)
//   ?career=<eventId>   jump into that career event's next match (game/career.js)
//   ?quick=1            career sets of one game (2-0, or a tie-break at 1-1; tests / screenshots)
//   ?autoreplay=1|0     automatic replays of great moments also with the autopilot (or never)
//   ?firsthits=1        the first-time timing prompt (shown until 5 hits) even for a returning player / the autopilot
//   ?screen=<name>      open a menu screen (hub, career, event-intro, trophies, arcade, freeplay,
//                       settings, help); with ?event=<id>, ?tab=<trophies tab>, ?fpmode=rally|match

const QUALITIES = ['ultra', 'high', 'balanced'];
const LEVELS = ['rookie', 'club', 'pro'];
const AP_PROFILES = ['precise', 'human'];
const VENUES = ['club', 'sunset', 'stadium'];

function num(v, lo, hi, fallback = null) {
  const n = Number(v);
  if (v === null || v === '' || !Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** @param {string} search location.search */
export function parseParams(search = '') {
  const q = new URLSearchParams(search);
  const flag = (k) => q.has(k) && q.get(k) !== '0' && q.get(k) !== 'false';
  const mode = q.get('mode');
  return {
    autopilot: flag('autopilot'),
    speed: num(q.get('speed'), 0.1, 8, 1),
    debug: flag('debug'),
    drill: q.get('drill') || null,
    mode: mode === 'rally' || mode === 'match' ? mode : null,
    level: LEVELS.includes(q.get('level')) ? q.get('level') : 'club',
    fallback: flag('fallback'),
    quality: QUALITIES.includes(q.get('quality')) ? q.get('quality') : null,
    assist: LEVELS.includes(q.get('assist')) ? q.get('assist') : null,
    pitch: num(q.get('pitch'), -40, 10),
    fov: num(q.get('fov'), 40, 110),
    eyeBack: num(q.get('eyeback'), -0.2, 0.4),
    eyeDown: num(q.get('eyedown'), -0.2, 0.3),
    attract: q.get('attract') !== '0',
    seed: num(q.get('seed'), 0, 2 ** 31, null),
    apLatency: num(q.get('aplatency'), 0, 0.3, 0),
    apDelivery: num(q.get('apdelivery'), 0, 0.3, 0.045),
    apProfile: AP_PROFILES.includes(q.get('approfile')) ? q.get('approfile') : null,
    apJitter: num(q.get('apjitter'), 0, 0.2, null),
    apNoise: num(q.get('apnoise'), 0, 4, null),
    apClose: q.get('apclose') === '1',
    noAudio: flag('mute'),
    // Round 4.
    venue: VENUES.includes(q.get('venue')) ? q.get('venue') : null,
    challenge: q.get('challenge') || null,
    career: q.get('career') || null,
    quick: q.get('quick') === '1',
    autoReplay: q.get('autoreplay') === '1' ? true : q.get('autoreplay') === '0' ? false : null,
    firstHits: q.get('firsthits') === '1',
    screen: q.get('screen') || null,
    event: q.get('event') || null,
    tab: q.get('tab') || null,
    fpMode: q.get('fpmode') === 'match' ? 'match' : q.get('fpmode') === 'rally' ? 'rally' : null,
  };
}
