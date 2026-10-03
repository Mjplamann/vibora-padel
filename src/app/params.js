// URL flags (SPEC §10.6 plus integration extras). Read once at boot.
//   ?autopilot=1        synthetic camera + autopilot drive the real pipeline (skips camera/calibration)
//   ?speed=N            N sim-seconds per real second (headless smoke runs)
//   ?debug=1            fps / draw calls / inference / latency overlay
//   ?drill=<id>         jump straight into a drill
//   ?mode=rally|match   jump straight into a rally or match (?level=rookie|club|pro)
//   ?fallback=1         mouse / trackpad controls (no camera)
//   ?quality=ultra|high|balanced
//   ?pitch=<deg>, ?fov=<deg>   override the first-person framing (testing)
//   ?eyeback=<m>, ?eyedown=<m> viewpoint offset behind / below the tracked eyes (testing)
//   ?attract=0          no autopilot demo behind the title screen
//   ?seed=N             RNG seed for the session
//   ?aplatency=<s>      display latency the autopilot plays with (default 0: it sees the true ball)
//   ?apdelivery=<s>     capture -> pose result delay of the autopilot's synthetic camera (default 0.045)

const QUALITIES = ['ultra', 'high', 'balanced'];
const LEVELS = ['rookie', 'club', 'pro'];

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
    pitch: num(q.get('pitch'), -40, 10),
    fov: num(q.get('fov'), 40, 110),
    eyeBack: num(q.get('eyeback'), -0.2, 0.4),
    eyeDown: num(q.get('eyedown'), -0.2, 0.3),
    attract: q.get('attract') !== '0',
    seed: num(q.get('seed'), 0, 2 ** 31, null),
    apLatency: num(q.get('aplatency'), 0, 0.3, 0),
    apDelivery: num(q.get('apdelivery'), 0, 0.3, 0.045),
    noAudio: flag('mute'),
  };
}
