// Downloads the MakeHuman 1.1 assets the athlete bake needs (all explicitly released as CC0 1.0 by
// the MakeHuman project; see THIRD_PARTY_NOTICES.md) into a local cache directory:
//   base mesh hm08 (base.obj), default skeleton joints (default.mhskel), default weights
//   (default_weights.mhw) and the young-adult macro targets (gender, muscle, weight, height,
//   proportions, ethnicity) from github.com/makehumancommunity/makehuman (makehuman/data/…),
// and the MakeHuman 1.1 system proxies / textures (skins, hair, eyebrows, eyelashes, eyes) from the
// npm package makehuman-data@0.0.2 (a JSON export of the same bundled MakeHuman assets).
// Usage: node tools/people/fetch-sources.mjs [cacheDir]   (default: $TMPDIR/vibora-people-src)
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const DEFAULT_SRC = join(tmpdir(), 'vibora-people-src');
const RAW = 'https://raw.githubusercontent.com/makehumancommunity/makehuman/master/makehuman/data';

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function get(url, path) {
  if (await exists(path)) return;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  await writeFile(path, Buffer.from(await r.arrayBuffer()));
}

export async function fetchSources(dir = DEFAULT_SRC) {
  await mkdir(join(dir, 'targets'), { recursive: true });
  const jobs = [
    [`${RAW}/3dobjs/base.obj`, join(dir, 'base.obj')],
    [`${RAW}/rigs/default.mhskel`, join(dir, 'default.mhskel')],
    [`${RAW}/rigs/default_weights.mhw`, join(dir, 'default_weights.mhw')],
  ];
  for (const g of ['female', 'male']) {
    for (const r of ['african', 'asian', 'caucasian']) jobs.push([`${RAW}/targets/macrodetails/${r}-${g}-young.target`, join(dir, 'targets', `${r}-${g}-young.target`)]);
    for (const m of ['minmuscle', 'averagemuscle', 'maxmuscle']) {
      for (const w of ['minweight', 'averageweight', 'maxweight']) {
        const b = `${g}-young-${m}-${w}`;
        jobs.push([`${RAW}/targets/macrodetails/universal-${b}.target`, join(dir, 'targets', `universal-${b}.target`)]);
        for (const h of ['minheight', 'maxheight']) jobs.push([`${RAW}/targets/macrodetails/height/${b}-${h}.target`, join(dir, 'targets', `${b}-${h}.target`)]);
        jobs.push([`${RAW}/targets/macrodetails/proportions/${b}-idealproportions.target`, join(dir, 'targets', `${b}-idealproportions.target`)]);
      }
    }
  }
  for (let i = 0; i < jobs.length; i += 8) await Promise.all(jobs.slice(i, i + 8).map(([u, p]) => get(u, p)));
  // makehuman-data (npm): system proxies and textures.
  if (!(await exists(join(dir, 'npm', 'package', 'public', 'data')))) {
    await mkdir(join(dir, 'npm'), { recursive: true });
    execFileSync('npm', ['pack', 'makehuman-data@0.0.2', '--pack-destination', join(dir, 'npm')], { stdio: 'inherit' });
    execFileSync('tar', ['xzf', join(dir, 'npm', 'makehuman-data-0.0.2.tgz'), '-C', join(dir, 'npm')], { stdio: 'inherit' });
  }
  return dir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = await fetchSources(process.argv[2] || DEFAULT_SRC);
  console.log(`MakeHuman sources in ${dir}`);
}
