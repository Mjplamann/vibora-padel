// Screenshots every UI screen at 1920x1080 via tools/shot.mjs.
// Usage: node dev/ui-shots.mjs [filter]
import { shoot } from '../tools/shot.mjs';

const SHOTS = [
  ['loading', 'screen=loading', 1500],
  ['title', 'screen=title', 1500],
  ['camera', 'screen=camera', 1800],
  ['cal-body', 'screen=calibrate&step=body', 1800],
  ['cal-body-warn', 'screen=calibrate&step=body&cal=warn', 1800],
  ['cal-spot', 'screen=calibrate&step=spot&still=0.6', 1800],
  ['cal-profile', 'screen=calibrate&step=profile', 1500],
  ['cal-latency', 'screen=calibrate&step=latency&run=1', 12500],
  ['cal-area', 'screen=calibrate&step=area', 3000],
  ['hub', 'screen=hub', 2000],
  ['hub-cursor', 'screen=hub&cursor=1', 700],
  ['drill-intro', 'screen=drill-intro', 2000],
  ['drill-intro-lob', 'screen=drill-intro&drill=lob-defense', 2000],
  ['play', 'screen=play', 1800],
  ['play-banner', 'screen=play&variant=banner', 900],
  ['play-match', 'screen=play&variant=match', 1800],
  ['play-prompt', 'screen=play&variant=prompt', 1500],
  ['pause', 'screen=pause', 1800],
  ['results', 'screen=results', 2000],
  ['settings', 'screen=settings', 1800],
  ['help', 'screen=help', 1800],
];

const filter = process.argv[2] ? new RegExp(process.argv[2]) : null;
let failed = 0;
const todo = SHOTS.filter(([n]) => !filter || filter.test(n));
const run = async ([name, q, wait]) => {
  const out = `tools/out/ui-${name}.png`;
  const { errors } = await shoot(`dev/ui.html?${q}`, out, { wait, width: 1920, height: 1080 });
  if (errors.length) { failed++; console.log(`✗ ${name}\n  ${errors.join('\n  ')}`); }
  else console.log(`✓ ${name} → ${out}`);
};
for (let i = 0; i < todo.length; i += 4) await Promise.all(todo.slice(i, i + 4).map(run));
process.exit(failed ? 1 : 0);
