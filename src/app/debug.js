// ?debug=1 overlay: frame rate, draw calls, pose inference, latency, tracking status.
import { judgeMargin } from '../game/world.js';

export function createDebugOverlay() {
  const el = document.createElement('pre');
  el.className = 'vp-debug';
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  let acc = 0;
  return {
    update(dt, info) {
      acc += dt;
      if (acc < 0.25) return;
      acc = 0;
      const r = info.render || {};
      const p = info.pose || null;
      const w = info.world;
      const b = w && w.ball;
      const lines = [
        `fps ${(r.fps || 0).toFixed(0)}  frame ${(r.frameMs || 0).toFixed(1)} ms  px ${(r.pixelRatio || 0).toFixed(2)}`,
        `draw ${r.drawCalls || 0}  tris ${Math.round((r.triangles || 0) / 1000)}k  quality ${info.quality}`,
        p ? `pose ${p.fps.toFixed(0)} fps  infer ${p.inferMs.toFixed(1)} ms  cam→result ${p.latencyMs.toFixed(0)} ms  ${p.delegate || ''}/${p.model || ''}  people ${p.people}` : `pose ${info.input}`,
        `status ${info.poseStatus || '—'}  latency ${Math.round((info.latency || 0) * 1000)} ms  speed ×${info.speed}`,
        w ? `sim ${w.time.toFixed(2)}  hits ${info.stats ? info.stats.playerHits : 0}  in ${info.stats ? info.stats.inCourt : 0}/${info.stats ? info.stats.judgedShots : 0}` : 'no session',
        b ? `ball ${(Math.hypot(b.vel.x, b.vel.y, b.vel.z) * 3.6).toFixed(0)} km/h  y ${b.pos.y.toFixed(2)}  z ${b.pos.z.toFixed(2)}` : 'ball —',
        w ? `player x ${w.player.pos.x.toFixed(2)} z ${w.player.pos.z.toFixed(2)}  eye ${w.player.eye.y.toFixed(2)}` : '',
        w && w.hitRejects ? `judge +${Math.round(judgeMargin(w) * 1000)} ms  rejected hits: late ${w.hitRejects.late}${w.hitRejects.lastLate ? ` (last ${Math.round(w.hitRejects.lastLate.by * 1000)} ms after contact)` : ''}  rules ${w.hitRejects.rules}  other ${w.hitRejects.other}` : '',
        // Black-screen safety net (app/stage.js, render/fpCamera.js, render/fpRig.js) and the side-on tracker guards (tracking/body.js).
        info.safety ? `safety hidden ${info.safety.meshesHidden} cam ${info.safety.camera.cameraRestored} eye ${info.safety.camera.eyeRestored} ball ${info.safety.ballHidden} rig ${info.safety.rig.racketRejected}/${info.safety.rig.segmentsHidden} · tracker swaps ${info.tracker ? info.tracker.swaps : 0} spikes ${info.tracker ? info.tracker.spikes : 0} rejected ${info.tracker ? info.tracker.rejectedLandmarks : 0} side-on ${info.tracker ? info.tracker.sideOnFrames : 0}` : '',
        info.timeRate !== undefined && info.timeRate !== 1 ? `slow motion ×${info.timeRate.toFixed(2)}` : '',
        info.glasses ? `glasses ${info.glasses}` : '',
      ].filter((l) => l !== '');
      el.textContent = lines.join('\n');
    },
    dispose() { el.remove(); },
  };
}
