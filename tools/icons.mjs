// App icon generator: writes the SVG sources in icons/ and renders every PNG size with
// headless Chromium. The mark is original: a perforated padel racket whose holes form a "V",
// an optic-yellow ball and court lines on court blue. No real brand is referenced.
// Usage: node tools/icons.mjs            (writes icons/*.svg and icons/*.png)
//        node tools/icons.mjs --svg-only
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'icons');

const C = {
  bgTop: '#3170c9',
  bgBot: '#12336b',
  line: '#8be4ee',
  racket: '#f4efe4',
  rim: '#0c1828',
  ball: '#dcf53c',
  ballShade: '#a9c21e',
  seam: '#f6ffd0',
};

const f = (n) => Number(n.toFixed(2));

/** The racket, ball and court lines drawn in a 512 x 512 full-bleed space. */
function art(id) {
  // Racket drawn upright (face up), then rotated 38° clockwise about the centre.
  const cx = 256, fy = 196, rx = 104, ry = 112; // face ellipse
  // V of holes: two arms of 5 holes meeting at the bottom of the face.
  const holes = [];
  const top = fy - 56, bottom = fy + 50, spread = 60;
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    const y = top + (bottom - top) * t;
    const dx = spread * (1 - t);
    holes.push([cx - dx, y]);
    if (i < 4) holes.push([cx + dx, y]);
  }
  const holeR = 12;
  // Outline: face ellipse + throat bridge + handle.
  const throat = `M${cx - 74} ${fy + 72} C ${cx - 40} ${fy + 128}, ${cx - 26} ${fy + 140}, ${cx - 20} ${fy + 168} L ${cx + 20} ${fy + 168} C ${cx + 26} ${fy + 140}, ${cx + 40} ${fy + 128}, ${cx + 74} ${fy + 72} Z`;
  const heart = `M${cx} ${fy + 112} C ${cx - 20} ${fy + 116}, ${cx - 30} ${fy + 126}, ${cx - 12} ${fy + 150} L ${cx + 12} ${fy + 150} C ${cx + 30} ${fy + 126}, ${cx + 20} ${fy + 116}, ${cx} ${fy + 112} Z`;
  const hx = cx - 19, hy = fy + 160, hw = 38, hh = 116;
  const grips = [0, 1, 2, 3, 4].map((i) => `<path d="M${hx} ${f(hy + 26 + i * 18)} l${hw} -9" stroke="${C.rim}" stroke-opacity="0.28" stroke-width="5" stroke-linecap="round"/>`).join('');
  const ball = { x: 150, y: 132, r: 46 };
  return `
  <g>
    <!-- court: service T and side line, glass-cyan, faint -->
    <g stroke="${C.line}" stroke-opacity="0.32" stroke-width="7" fill="none" stroke-linecap="square">
      <path d="M-200 421 L712 335"/>
      <path d="M284 378 L330 574"/>
    </g>
    <g stroke="${C.line}" stroke-opacity="0.16" stroke-width="5" fill="none">
      <path d="M-200 315 L712 239"/>
    </g>
    <!-- ball streak -->
    <g stroke="${C.line}" stroke-linecap="round" fill="none">
      <path d="M${ball.x - 58} ${ball.y + 64} L${ball.x - 112} ${ball.y + 120}" stroke-width="9" stroke-opacity="0.55"/>
      <path d="M${ball.x - 30} ${ball.y + 78} L${ball.x - 66} ${ball.y + 116}" stroke-width="7" stroke-opacity="0.35"/>
      <path d="M${ball.x - 76} ${ball.y + 38} L${ball.x - 104} ${ball.y + 66}" stroke-width="7" stroke-opacity="0.35"/>
    </g>
    <g transform="rotate(38 256 256)">
      <!-- soft shadow -->
      <g transform="translate(10 12)" fill="#04101f" fill-opacity="0.32">
        <ellipse cx="${cx}" cy="${fy}" rx="${rx}" ry="${ry}"/>
        <path d="${throat}"/>
        <rect x="${hx}" y="${hy}" width="${hw}" height="${hh}" rx="14"/>
      </g>
      <mask id="${id}-holes" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
        <rect x="-200" y="-200" width="912" height="912" fill="#fff"/>
        <g transform="rotate(-38 ${cx} ${fy})">${holes.map(([x, y]) => `<circle cx="${f(x)}" cy="${f(y)}" r="${holeR}" fill="#000"/>`).join('')}</g>
        <path d="${heart}" fill="#000"/>
      </mask>
      <g mask="url(#${id}-holes)">
        <ellipse cx="${cx}" cy="${fy}" rx="${rx}" ry="${ry}" fill="${C.racket}"/>
        <path d="${throat}" fill="${C.racket}"/>
        <ellipse cx="${cx}" cy="${fy}" rx="${rx - 9}" ry="${ry - 9}" fill="none" stroke="${C.rim}" stroke-opacity="0.16" stroke-width="5"/>
      </g>
      <rect x="${hx}" y="${hy}" width="${hw}" height="${hh}" rx="14" fill="${C.rim}"/>
      <g clip-path="url(#${id}-grip)">${grips}</g>
      <clipPath id="${id}-grip"><rect x="${hx}" y="${hy}" width="${hw}" height="${hh}" rx="14"/></clipPath>
      <rect x="${hx - 3}" y="${hy + hh - 16}" width="${hw + 6}" height="16" rx="7" fill="${C.racket}"/>
    </g>
    <!-- ball -->
    <circle cx="${ball.x}" cy="${ball.y}" r="${ball.r}" fill="url(#${id}-ball)"/>
    <path d="M${ball.x - ball.r + 6} ${ball.y - 18} C ${ball.x - 12} ${ball.y - 6}, ${ball.x - 10} ${ball.y + 22}, ${ball.x - 26} ${ball.y + ball.r - 8}" fill="none" stroke="${C.seam}" stroke-width="6" stroke-linecap="round"/>
    <path d="M${ball.x + 22} ${ball.y - ball.r + 6} C ${ball.x + 8} ${ball.y - 18}, ${ball.x + 18} ${ball.y + 12}, ${ball.x + ball.r - 4} ${ball.y + 16}" fill="none" stroke="${C.seam}" stroke-width="6" stroke-linecap="round"/>
  </g>`;
}

function defs(id) {
  return `
  <defs>
    <linearGradient id="${id}-bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="${C.bgTop}"/>
      <stop offset="1" stop-color="${C.bgBot}"/>
    </linearGradient>
    <radialGradient id="${id}-ball" cx="0.36" cy="0.32" r="0.75">
      <stop offset="0" stop-color="#f3ff8a"/>
      <stop offset="0.55" stop-color="${C.ball}"/>
      <stop offset="1" stop-color="${C.ballShade}"/>
    </radialGradient>
    <radialGradient id="${id}-glow" cx="0.3" cy="0.22" r="0.8">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>`;
}

/** 'any' icon: a macOS-style rounded square with a transparent margin (824/1024 body). */
export function iconSvg(inset = 44) {
  const id = 'vi';
  const size = 512 - 2 * inset, s = size / 512;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${defs(id)}
  <clipPath id="${id}-sq"><rect x="${inset}" y="${inset}" width="${size}" height="${size}" rx="${f(size * 0.225)}"/></clipPath>
  <g clip-path="url(#${id}-sq)">
    <rect x="${inset}" y="${inset}" width="${size}" height="${size}" fill="url(#${id}-bg)"/>
    <rect x="${inset}" y="${inset}" width="${size}" height="${size}" fill="url(#${id}-glow)"/>
    <g transform="translate(${inset} ${inset}) scale(${f(s * 1000) / 1000})">${art(id)}</g>
  </g>
  <rect x="${inset + 1}" y="${inset + 1}" width="${size - 2}" height="${size - 2}" rx="${f(size * 0.225)}" fill="none" stroke="#ffffff" stroke-opacity="0.12" stroke-width="2"/>
</svg>
`;
}

/** Maskable / Apple touch icon: full bleed, the mark inside the 80 % safe circle. */
export function maskableSvg() {
  const id = 'vm';
  const s = 0.84;
  const o = 256 * (1 - s);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${defs(id)}
  <rect width="512" height="512" fill="url(#${id}-bg)"/>
  <rect width="512" height="512" fill="url(#${id}-glow)"/>
  <g transform="translate(${f(o)} ${f(o)}) scale(${s})">${art(id)}</g>
</svg>
`;
}

const PNGS = [
  { file: 'icon-192.png', svg: 'icon.svg', size: 192 },
  { file: 'icon-512.png', svg: 'icon.svg', size: 512 },
  { file: 'icon-maskable-512.png', svg: 'icon-maskable.svg', size: 512 },
  { file: 'icon-maskable-192.png', svg: 'icon-maskable.svg', size: 192 },
  { file: 'apple-touch-icon.png', svg: 'icon-maskable.svg', size: 180 },
  { file: 'favicon-32.png', svg: 'favicon.svg', size: 32 },
];

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    return await import('/opt/node-tools/node_modules/playwright/index.mjs');
  }
}

async function main() {
  await mkdir(DIR, { recursive: true });
  await writeFile(join(DIR, 'icon.svg'), iconSvg());
  await writeFile(join(DIR, 'icon-maskable.svg'), maskableSvg());
  await writeFile(join(DIR, 'favicon.svg'), iconSvg(8));
  if (process.argv.includes('--svg-only')) return;
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  try {
    for (const p of PNGS) {
      const svg = await readFile(join(DIR, p.svg), 'utf8');
      const page = await browser.newPage({ viewport: { width: p.size, height: p.size }, deviceScaleFactor: 1 });
      const html = `<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block;width:${p.size}px;height:${p.size}px}</style></head><body>${svg}</body></html>`;
      await page.setContent(html);
      await page.screenshot({ path: join(DIR, p.file), omitBackground: true, clip: { x: 0, y: 0, width: p.size, height: p.size } });
      await page.close();
      console.log(`icons/${p.file} (${p.size}×${p.size})`);
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
