// World bus -> audio, visual effects, UI and the voice coach (SPEC §5.1 event contract).
import { strokeName } from '../ui/charts.js';
import { reachRing, contactGhostPose, createGhostPose } from '../game/swingAssist.js';
import { isPerfectHit } from '../game/challenges.js';
import { bindVenue } from '../audio/venueAudio.js';

/** Spoken miss reasons: at most one per MISS_VOICE_GAP s, the same reason again only after MISS_REPEAT_S. */
export const MISS_VOICE_GAP = 2.5;
export const MISS_REPEAT_S = 8;

const EN_NUM = (n) => String(Math.round(n));

/**
 * Subscribes everything that reacts to a world's events. Returns an unsubscribe function.
 * ctx: { audio, voice, stage, ui, recorder, quiet (attract: no UI / voice), onDrillEnd(payload), onMatchEnd(payload),
 *   round 4: achievements (game/achievements.js tracker), onAchievement(def), director (app/replay.js
 *   createReplayDirector), glassTargets (render/glassTargets.js), onChallengeEnd(payload), onMatchPoint(payload),
 *   arcade (true in arcade challenges: every perfect hit gets its callout),
 *   umpireTeams ([{en, es}, {en, es}] names the umpire calls, default Víbora / Cobra) }
 * Venue sound (audio/venueAudio.js bindVenue): the crowd director (stands + crowd sound), the chair
 * umpire's score calls in matches (settings.umpireLang 'es' | 'en' | 'off') and the voiced partner /
 * rival callouts (settings.callouts), with speech ducking the crowd. ctx.venue exposes the binding.
 */
export function bindWorld(world, ctx) {
  const { audio, voice, stage, ui, recorder } = ctx;
  const bus = world.bus;
  const offs = [];
  const on = (type, fn) => offs.push(bus.on(type, fn));
  const quiet = !!ctx.quiet;
  const ghostPose = createGhostPose();

  // Spatial sound: racket, bounces, glass, mesh, net, cord, machine, footsteps. A predicted hit
  // plays its pock when the shown racket meets the ball; the camera's confirmation of it
  // (shot.confirms) must not play a second one.
  const audioBus = {
    on: (type, fn) => bus.on(type, type === 'ball:hit' ? (p) => { if (!(p && p.shot && p.shot.confirms)) fn(p); } : fn),
  };
  if (audio && !quiet) offs.push(audio.bindBus(audioBus, { cheer: {} }));
  // Crowd, umpire and callouts (the crowd director decides the reactions: no cheer from the engine).
  const s = world.settings || {};
  const umpLang = s.umpireLang === 'en' || s.umpireLang === 'es' ? s.umpireLang : s.voice === 'es' ? 'es' : 'en';
  const venue = bindVenue({
    world, bus, audio, voice: quiet ? null : voice, env: stage && stage.env, lang: umpLang,
    umpire: s.umpireLang !== 'off' && s.umpire !== false, callouts: s.callouts !== false, quiet, teams: ctx.umpireTeams || undefined,
  });
  offs.push(() => venue.unbind());
  ctx.venue = venue;

  let lastPlayerShot = null;
  on('ball:hit', ({ shot }) => {
    // Effects once, when the hit is shown: at the predicted strike, or at a hit found late.
    if (!shot.confirms) {
      stage.effects.racketHit(shot.contact, shot.quality ?? 0.8);
      stage.ballView.flash('hit');
    }
    // Provisional (predicted) hits are presentation only: the shot card, voice and replay
    // follow the confirmed shot.
    if (shot.provisional) return;
    if (recorder) recorder.onHit(shot);
    if (shot.by !== 'player' || quiet) return;
    lastPlayerShot = shot;
    ui.shotCard(shot);
    if (voice) {
      const n = strokeName(shot.stroke);
      const kmh = shot.speedOut * 3.6;
      voice.say(`${n.en}, ${EN_NUM(kmh)}`, { priority: 0, es: `${n.es}, ${EN_NUM(kmh)}` });
    }
  });
  on('ball:bounce', ({ evt }) => {
    stage.effects.bounce(evt.pos, evt.surface, evt.impactSpeed, evt.vel);
  });
  on('ball:outside-bounce', ({ evt }) => {
    stage.effects.bounce(evt.pos, 'outsideFloor', evt.impactSpeed);
  });
  on('ball:wall', ({ evt }) => {
    if (evt.surface === 'glass') {
      const n = stage.wallNormal(evt);
      stage.effects.glassHit(evt.pos, n, evt.impactSpeed);
      stage.env.addBallMark(evt.pos, n);
      stage.ballView.flash('wall');
    } else if (evt.surface === 'mesh' && stage.effects.meshHit) stage.effects.meshHit(evt.pos, stage.wallNormal(evt), evt.impactSpeed);
  });
  on('ball:net', ({ evt }) => stage.effects.netShake(evt.pos.x, Math.max(3, evt.impactSpeed || 5)));
  on('ball:netcord', ({ evt }) => stage.effects.netShake(evt.pos.x, 3));
  on('ball:launch', ({ by }) => {
    if (by === 'machine') stage.machine.pulse();
  });

  // Ball visibility aids (render/ballView.js): the setting and the reach ring of the timing plan.
  if (stage && stage.ballView && stage.ballView.bind) {
    stage.ballView.bind({
      visibility: () => world.settings.ballVisibility || 'enhanced',
      ring: () => (!quiet && stage.view === 'fp' ? reachRing(world) : null),
      // Racket ghost at the planned contact (game/swingAssist.js contactGhostPose; Settings → Ball & aids).
      ghost: () => (!quiet && stage.view === 'fp' && world.settings.racketGhost !== false ? contactGhostPose(world, ghostPose) : null),
    });
    offs.push(() => stage.ballView.bind(null));
  }

  if (!quiet) {
    // Why a ball was not hit (game/swingAssist.js): HUD card via mode.hud, voice here, rate-limited.
    let lastMissSay = -Infinity;
    const missSaid = new Map();
    on('player:miss', (m) => {
      const now = world.time;
      if (now - lastMissSay < MISS_VOICE_GAP) return;
      if (now - (missSaid.get(m.reason) ?? -Infinity) < MISS_REPEAT_S && m.reason !== 'early' && m.reason !== 'late') return;
      lastMissSay = now;
      missSaid.set(m.reason, now);
      if (voice) voice.say(m.text, { priority: 1, es: m.es });
      if (ui && ui.missCard) ui.missCard(m);
    });
    // Timing cues of balls off the glass: the audio tick, "Let it come off the glass… now!".
    on('timing:cue', (c) => {
      if (c.kind === 'tick') {
        if (audio && audio.ui) audio.ui('tick');
      } else if (c.kind === 'glass') {
        if (voice) voice.say(c.text, { priority: 1, es: c.es });
      } else if (c.kind === 'now-voice') {
        if (voice) voice.say(c.text, { priority: 3, es: c.es });
      } else if (c.kind === 'now') {
        if (ui && ui.timingCue) ui.timingCue('now');
      }
    });
    on('shot:result', (r) => {
      // Re-issue the shot card with the drill's verdict: points, success, coaching note.
      if (lastPlayerShot && r.shotId === lastPlayerShot.id) ui.shotCard({ ...lastPlayerShot, ...r, result: r });
    });
    on('coach:cue', (c) => {
      if (voice) voice.say(c.text, { priority: c.priority ?? 1, es: c.es });
      if ((c.priority ?? 0) >= 2) ui.toast(c.text);
    });
    on('drill:end', (p) => ctx.onDrillEnd && ctx.onDrillEnd(p));
    on('match:end', (p) => ctx.onMatchEnd && ctx.onMatchEnd(p));

    // ---- Round 4: career, arcade, achievements, replays ------------------------------------
    on('challenge:end', (p) => ctx.onChallengeEnd && ctx.onChallengeEnd(p));
    on('match:point', (p) => ctx.onMatchPoint && ctx.onMatchPoint(p));
    // The partner's calls: a HUD chip (audio/umpire.js, bound by bindVenue above, voices them).
    on('partner:call', (c) => { if (ui && ui.partnerCall) ui.partnerCall(c); });
    // "Perfect timing!": every perfect hit in the arcade, streaks of 3, 5, 10... elsewhere.
    let perfectRun = 0;
    on('challenge:perfect', (p) => { if (ui && ui.perfect) ui.perfect(p.streak); });
    if (!ctx.arcade) {
      on('ball:hit', ({ shot }) => {
        if (!shot || shot.by !== 'player' || shot.provisional) return;
        perfectRun = isPerfectHit(shot) ? perfectRun + 1 : 0;
        if (perfectRun === 3 || perfectRun === 5 || (perfectRun >= 10 && perfectRun % 5 === 0)) {
          if (ui && ui.perfect) ui.perfect(perfectRun);
          bus.emit('timing:perfect', { streak: perfectRun, shotId: shot.id });
        }
      });
    }
    // The venue reacts (render/environment.js env.react: stands, crowd) when there is one.
    const react = (kind, level) => { if (stage && stage.env && typeof stage.env.react === 'function') stage.env.react(kind, level); };
    on('challenge:combo', (p) => {
      if (ui && ui.callout && p.mult > 1) ui.callout(`Combo ×${p.mult}`, `${p.combo} seguidas`, 'combo');
      if (audio && audio.cheer && p.mult >= 3) audio.cheer(0.25 + 0.1 * p.mult);
      if (p.mult >= 3) react('cheer', Math.min(1, 0.3 + 0.15 * p.mult));
    });
    on('challenge:targets', (p) => { if (ctx.glassTargets) ctx.glassTargets.set(p.targets || []); });
    on('challenge:target-hit', (p) => {
      if (ctx.glassTargets) ctx.glassTargets.hit(p.id, p.pos);
      if (stage && stage.effects && p.pos) stage.effects.glassHit(p.pos, { x: 0, y: 0, z: p.pos.z < 0 ? 1 : -1 }, 14);
      if (audio && audio.cheer) audio.cheer(0.5);
      react('ooh', 0.7);
    });
    // Achievements and automatic replays read the same events.
    const watched = ['ball:hit', 'shot:result', 'rally:outcome', 'match:end', 'challenge:end', 'drill:end', 'challenge:perfect', 'challenge:target-hit', 'timing:perfect'];
    for (const type of watched) {
      on(type, (p) => {
        if (ctx.director) ctx.director.onBus(type, p, world);
        if (ctx.achievements) {
          const got = ctx.achievements.onBus(type, p);
          for (const a of got) if (ctx.onAchievement) ctx.onAchievement(a);
        }
      });
    }
  }

  return () => offs.forEach((off) => off && off());
}
