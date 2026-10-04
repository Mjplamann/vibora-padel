// World bus -> audio, visual effects, UI and the voice coach (SPEC §5.1 event contract).
import { strokeName } from '../ui/charts.js';

const EN_NUM = (n) => String(Math.round(n));

/**
 * Subscribes everything that reacts to a world's events. Returns an unsubscribe function.
 * ctx: { audio, voice, stage, ui, recorder, quiet (attract: no UI / voice), onDrillEnd(payload), onMatchEnd(payload) }
 */
export function bindWorld(world, ctx) {
  const { audio, voice, stage, ui, recorder } = ctx;
  const bus = world.bus;
  const offs = [];
  const on = (type, fn) => offs.push(bus.on(type, fn));
  const quiet = !!ctx.quiet;

  // Spatial sound: racket, bounces, glass, mesh, net, cord, machine, footsteps. A predicted hit
  // plays its pock when the shown racket meets the ball; the camera's confirmation of it
  // (shot.confirms) must not play a second one.
  const audioBus = {
    on: (type, fn) => bus.on(type, type === 'ball:hit' ? (p) => { if (!(p && p.shot && p.shot.confirms)) fn(p); } : fn),
  };
  if (audio && !quiet) offs.push(audio.bindBus(audioBus, { cheer: {} }));

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
    stage.effects.bounce(evt.pos, evt.surface, evt.impactSpeed);
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
    }
  });
  on('ball:net', ({ evt }) => stage.effects.netShake(evt.pos.x, Math.max(3, evt.impactSpeed || 5)));
  on('ball:netcord', ({ evt }) => stage.effects.netShake(evt.pos.x, 3));
  on('ball:launch', ({ by }) => {
    if (by === 'machine') stage.machine.pulse();
  });

  if (!quiet) {
    on('rally:outcome', (o) => {
      if (!audio) return;
      if (o.winner === 0 && (o.reason === 'por-tres' || o.reason === 'por-cuatro')) audio.cheer(1);
      else if (o.winner === 0 && o.score) audio.cheer(0.35); // a point won in a match
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
  }

  return () => offs.forEach((off) => off && off());
}
