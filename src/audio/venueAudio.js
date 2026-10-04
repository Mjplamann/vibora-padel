// Venue sound and voices, bound to a world's bus in one call (app/wiring.js):
//  - the crowd director (crowdDirector.js) drives the venue's stands (env.react: render/crowd.js,
//    LED boards) and the crowd's sound (audio.crowd), scaled by the venue's crowd level;
//  - the umpire (umpire.js) calls the score in matches; the partner / rivals voice 'partner:call';
//  - speech ducks the crowd and the ambience (voice.onSpeaking -> audio.duck).
// The racket whoosh ('player:swing') and the impact sounds are bound by audio.bindBus.
import { createCrowdDirector } from './crowdDirector.js';
import { createUmpire } from './umpire.js';

const modeKind = (world) => {
  const id = world && world.mode && world.mode.id;
  return typeof id === 'string' ? id.split(':')[0] : null;
};

/**
 * @param {{ world, bus?, audio?, voice?, env?, lang?: 'en'|'es', umpire?: boolean, callouts?: boolean,
 *   crowd?: boolean, quiet?: boolean, teams?: [{en, es}, {en, es}] (umpire.js TEAMS) }} o
 * @returns {{ unbind(): void, director, umpire, update(): void }}
 */
export function bindVenue({ world, bus = world && world.bus, audio = null, voice = null, env = null, lang = 'en', umpire = true, callouts = true, crowd = true, quiet = false, teams = undefined } = {}) {
  const offs = [];
  const now = () => (world ? world.time : 0);
  const director = createCrowdDirector({
    now,
    // Arcade challenges are machine-fed like drills: no hush before every feed, no groans (their
    // combos cheer through app/wiring.js).
    mode: () => {
      const k = modeKind(world);
      return k === 'challenge' ? 'drill' : k;
    },
    onReact: (kind, level, info) => {
      if (env && env.react) env.react(kind, level, info);
      if (audio && audio.crowd && !quiet) audio.crowd(kind === 'cheer' && level > 0.9 ? 'roar' : kind, level);
    },
  });
  if (crowd && bus) offs.push(director.bindBus(bus));
  const ump = createUmpire({ voice: quiet ? null : voice, lang, enabled: umpire, callouts, ...(teams ? { teams } : {}) });
  if (bus && voice && !quiet) {
    offs.push(ump.bindBus(bus, {
      isMatch: () => modeKind(world) === 'match',
      display: () => (world && world.mode && world.mode.hud ? world.mode.hud(world).score : null),
    }));
  }
  if (voice && audio && voice.onSpeaking && audio.duck) offs.push(voice.onSpeaking((on) => audio.duck(on ? 1 : 0)));
  // The murmur comes back a few seconds after each point.
  const timer = setInterval(() => director.update(), 250);
  offs.push(() => clearInterval(timer));
  return {
    director,
    umpire: ump,
    update: () => director.update(),
    unbind() {
      for (const off of offs.splice(0)) if (typeof off === 'function') off();
      if (audio && audio.duck) audio.duck(0);
    },
  };
}
