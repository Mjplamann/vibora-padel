// Court diagrams and session charts for the 10-foot UI (SPEC §8).
// Canvas drawings use exact court geometry from config.js: x right, z toward the
// near baseline; diagrams are drawn from behind the near player, so the far
// baseline (z = -10) is at the top of the canvas.

import { COURT } from '../config.js';

/** Stroke ids (SPEC §4.5) -> English / Spanish names. */
export const STROKE_NAMES = Object.freeze({
  forehand: { en: 'Forehand', es: 'Derecha' },
  backhand: { en: 'Backhand', es: 'Revés' },
  'volley-fh': { en: 'Forehand volley', es: 'Volea de derecha' },
  'volley-bh': { en: 'Backhand volley', es: 'Volea de revés' },
  bandeja: { en: 'Bandeja', es: 'Bandeja' },
  vibora: { en: 'Víbora', es: 'Víbora' },
  smash: { en: 'Smash', es: 'Remate' },
  lob: { en: 'Lob', es: 'Globo' },
  chiquita: { en: 'Chiquita', es: 'Chiquita' },
  serve: { en: 'Serve', es: 'Saque' },
  'glass-fh': { en: 'Forehand off the glass', es: 'Salida de pared · derecha' },
  'glass-bh': { en: 'Backhand off the glass', es: 'Salida de pared · revés' },
});

export function strokeName(id) {
  return STROKE_NAMES[id] || { en: id ? String(id).replace(/-/g, ' ') : 'Shot', es: '' };
}

// Palette mirrors the CSS tokens in styles/app.css (canvas can't read var() cheaply per frame).
export const CHART_COLORS = Object.freeze({
  turf: '#2a5aa6',
  turfDeep: '#1b3f7a',
  outside: '#0a1424',
  line: 'rgba(250, 247, 240, 0.92)',
  glass: '#8be4ee',
  glassSoft: 'rgba(139, 228, 238, 0.35)',
  mesh: 'rgba(170, 196, 214, 0.55)',
  text: '#f4efe4',
  textDim: 'rgba(244, 239, 228, 0.62)',
  ball: '#dcf53c',
  miss: '#ff7a5c',
  target: 'rgba(139, 228, 238, 0.20)',
  targetEdge: 'rgba(139, 228, 238, 0.95)',
  ink: '#05090f',
});

const C = CHART_COLORS;
const DISPLAY_FONT = "'Big Shoulders Display', 'VP Display Fallback', 'Arial Narrow', Impact, sans-serif";
const UI_FONT = "'Barlow Semi Condensed', 'VP UI Fallback', 'Arial Narrow', system-ui, sans-serif";

/** Sizes a canvas backing store to its CSS box at device pixel ratio; returns a 2D context in CSS px. */
export function fitCanvas(canvas, fallbackW = 300, fallbackH = 150) {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width || canvas.clientWidth || fallbackW));
  const h = Math.max(1, Math.round(rect.height || canvas.clientHeight || fallbackH));
  const dpr = Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/**
 * Builds a court->canvas mapping that fits the requested z range into w x h with a margin (m).
 * Returns { px(x), py(z), s (px per m), x0, x1, z0, z1 }.
 */
function courtMap(w, h, { z0 = -10, z1 = 10, margin = 0.7, pad = 6 } = {}) {
  const x0 = -COURT.halfWidth - margin, x1 = COURT.halfWidth + margin;
  const zz0 = z0 - margin, zz1 = z1 + margin;
  const s = Math.min((w - pad * 2) / (x1 - x0), (h - pad * 2) / (zz1 - zz0));
  const ox = (w - s * (x1 - x0)) / 2, oy = (h - s * (zz1 - zz0)) / 2;
  return {
    s, x0, x1, z0, z1,
    px: (x) => ox + (x - x0) * s,
    py: (z) => oy + (z - zz0) * s,
  };
}

/** Draws turf, playing lines, net and walls (glass solid, mesh dashed) for z in [z0, z1]. */
function drawCourt(ctx, m, { compact = false } = {}) {
  const { px, py, s, z0, z1 } = m;
  const hw = COURT.halfWidth;
  const top = py(z0), bot = py(z1), left = px(-hw), right = px(hw);

  // Turf with a soft lighting falloff, like the overhead LED rows.
  const g = ctx.createLinearGradient(0, top, 0, bot);
  g.addColorStop(0, C.turfDeep);
  g.addColorStop(0.5, C.turf);
  g.addColorStop(1, C.turfDeep);
  ctx.fillStyle = g;
  ctx.fillRect(left, top, right - left, bot - top);
  if (!compact) {
    const v = ctx.createRadialGradient((left + right) / 2, (top + bot) / 2, 0, (left + right) / 2, (top + bot) / 2, (bot - top) * 0.7);
    v.addColorStop(0, 'rgba(255,255,255,0.06)');
    v.addColorStop(1, 'rgba(0,0,0,0.18)');
    ctx.fillStyle = v;
    ctx.fillRect(left, top, right - left, bot - top);
  }

  // Playing lines: 5 cm, but never thinner than a crisp hairline on small diagrams.
  const lw = Math.max(compact ? 1 : 1.5, COURT.lineWidth * s);
  ctx.strokeStyle = C.line;
  ctx.lineWidth = lw;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  for (const sz of [-COURT.serviceLine, COURT.serviceLine]) {
    if (sz < z0 - 1e-6 || sz > z1 + 1e-6) continue;
    ctx.moveTo(left, py(sz));
    ctx.lineTo(right, py(sz));
  }
  // Center service line: net -> service line, overrunning 20 cm on each side.
  const cz0 = Math.max(z0, -COURT.serviceLine - COURT.centerLineOverrun);
  const cz1 = Math.min(z1, COURT.serviceLine + COURT.centerLineOverrun);
  ctx.moveTo(px(0), py(cz0));
  ctx.lineTo(px(0), py(cz1));
  ctx.stroke();

  // Walls. Back walls: glass full width. Side walls banded by |z| (config.sideWall).
  const wallW = Math.max(compact ? 2 : 3, s * 0.16);
  ctx.lineCap = 'square';
  const glassSeg = (xa, za, xb, zb) => {
    ctx.strokeStyle = C.glass;
    ctx.lineWidth = wallW;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(px(xa), py(za));
    ctx.lineTo(px(xb), py(zb));
    ctx.stroke();
  };
  const meshSeg = (xa, za, xb, zb) => {
    ctx.strokeStyle = C.mesh;
    ctx.lineWidth = Math.max(1, wallW * 0.45);
    ctx.setLineDash([Math.max(2, s * 0.18), Math.max(2, s * 0.14)]);
    ctx.beginPath();
    ctx.moveTo(px(xa), py(za));
    ctx.lineTo(px(xb), py(zb));
    ctx.stroke();
    ctx.setLineDash([]);
  };
  if (z0 <= -COURT.halfLength + 1e-6) glassSeg(-hw, -COURT.halfLength, hw, -COURT.halfLength);
  if (z1 >= COURT.halfLength - 1e-6) glassSeg(-hw, COURT.halfLength, hw, COURT.halfLength);
  for (const band of COURT.sideWall) {
    for (const sign of [-1, 1]) {
      let za = sign < 0 ? -band.zMax : band.zMin;
      let zb = sign < 0 ? -band.zMin : band.zMax;
      za = Math.max(za, z0);
      zb = Math.min(zb, z1);
      if (zb <= za) continue;
      for (const x of [-hw, hw]) {
        if (band.glassTop > 0) glassSeg(x, za, x, zb);
        else meshSeg(x, za, x, zb);
      }
    }
  }

  // Net (z = 0) with posts.
  if (z0 <= 0 && z1 >= 0) {
    const ny = py(0);
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = Math.max(3, s * 0.22);
    ctx.beginPath();
    ctx.moveTo(left, ny + 1.5);
    ctx.lineTo(right, ny + 1.5);
    ctx.stroke();
    ctx.strokeStyle = '#f8f6f0';
    ctx.lineWidth = Math.max(2, s * 0.1);
    ctx.beginPath();
    ctx.moveTo(left - s * 0.12, ny);
    ctx.lineTo(right + s * 0.12, ny);
    ctx.stroke();
    ctx.fillStyle = '#0b0f14';
    const ps = Math.max(3, s * 0.22);
    ctx.fillRect(left - s * 0.12 - ps / 2, ny - ps / 2, ps, ps);
    ctx.fillRect(right + s * 0.12 - ps / 2, ny - ps / 2, ps, ps);
  }
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawTargets(ctx, m, targets, { labels = true, compact = false, highlightId = null } = {}) {
  if (!targets) return;
  for (const zn of targets) {
    if (zn.kind && zn.kind !== 'land') continue;
    const x = m.px(Math.min(zn.x0, zn.x1)), y = m.py(Math.min(zn.z0, zn.z1));
    const w = Math.abs(m.px(zn.x1) - m.px(zn.x0)), h = Math.abs(m.py(zn.z1) - m.py(zn.z0));
    const hot = highlightId == null || highlightId === zn.id;
    ctx.fillStyle = hot ? C.target : 'rgba(139,228,238,0.08)';
    ctx.fillRect(x, y, w, h);
    // Diagonal hatching reads as "zone" even on small cards.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.strokeStyle = 'rgba(139,228,238,0.16)';
    ctx.lineWidth = 1;
    const step = Math.max(5, m.s * 0.55);
    ctx.beginPath();
    for (let d = -h; d < w; d += step) {
      ctx.moveTo(x + d, y + h);
      ctx.lineTo(x + d + h, y);
    }
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = hot ? C.targetEdge : C.glassSoft;
    ctx.lineWidth = compact ? 1.5 : 2;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    if (labels && !compact && w > 50 && h > 26) {
      ctx.fillStyle = C.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const fs = Math.max(11, Math.min(m.s * 0.62, h * 0.3, 22));
      ctx.font = `800 ${fs}px ${DISPLAY_FONT}`;
      const label = String(zn.label || zn.id || '').toUpperCase();
      // Net-side half of the zone: the machine and back-glass detail sit at the far end.
      const cy = y + h * 0.6;
      ctx.fillText(fitText(ctx, label, w - 10), x + w / 2, cy - (zn.points ? fs * 0.45 : 0));
      if (zn.points) {
        ctx.font = `600 ${Math.round(fs * 0.72)}px ${UI_FONT}`;
        ctx.fillStyle = C.glass;
        ctx.fillText(`${zn.points} PTS`, x + w / 2, cy + fs * 0.62);
      }
    }
  }
}

function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 2 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

function drawPlayer(ctx, m, p, { label = 'YOU', compact = false } = {}) {
  const x = m.px(p.x), y = m.py(p.z);
  const r = Math.max(compact ? 3.5 : 7, m.s * (compact ? 0.32 : 0.42));
  ctx.fillStyle = 'rgba(5,9,15,0.55)';
  ctx.beginPath();
  ctx.arc(x, y, r * 1.9, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = C.text;
  ctx.lineWidth = compact ? 1.5 : 2.5;
  ctx.beginPath();
  ctx.arc(x, y, r * 1.45, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = C.text;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.7, 0, Math.PI * 2);
  ctx.fill();
  // Facing tick toward the net (-z = up).
  ctx.beginPath();
  ctx.moveTo(x, y - r * 1.45);
  ctx.lineTo(x, y - r * 2.4);
  ctx.stroke();
  if (label && !compact) {
    ctx.font = `700 ${Math.max(11, m.s * 0.42)}px ${UI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = C.text;
    ctx.fillText(label, x, y + r * 2.1);
  }
}

function drawOpponent(ctx, m, p) {
  const x = m.px(p.x), y = m.py(p.z), r = Math.max(5, m.s * 0.34);
  ctx.strokeStyle = C.miss;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - r * 0.6, y);
  ctx.lineTo(x + r * 0.6, y);
  ctx.stroke();
}

function drawMachine(ctx, m, p, { label = true } = {}) {
  const x = m.px(p.x), y = m.py(p.z);
  const w = Math.max(10, m.s * 0.9), h = Math.max(6, m.s * 0.5);
  ctx.fillStyle = '#0b1220';
  ctx.strokeStyle = C.text;
  ctx.lineWidth = 1.5;
  roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = C.text;
  ctx.beginPath();
  ctx.arc(x, y + h / 2, Math.max(2, h * 0.28), 0, Math.PI * 2);
  ctx.fill();
  if (label) {
    ctx.font = `600 ${Math.max(10, m.s * 0.36)}px ${UI_FONT}`;
    ctx.fillStyle = C.textDim;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('MACHINE · CAÑÓN', x + w / 2 + 6, y);
  }
}

/**
 * Court diagram used by hub cards and the drill intro.
 * opts: { view: 'full'|'far', home:{x,z}, targets:[Zone], feeds:[{x,z}], machine:{x,z}|null,
 *         opponents:[{x,z}], compact:boolean, labels:boolean, highlightId }
 */
export function courtDiagram(canvas, opts = {}) {
  const { view = 'full', home = null, targets = [], feeds = [], machine = null, opponents = [], compact = false, labels = !compact, highlightId = null } = opts;
  const { ctx, w, h } = fitCanvas(canvas, 120, 240);
  const m = courtMap(w, h, view === 'far' ? { z0: -10, z1: 0, margin: compact ? 0.25 : 0.6, pad: compact ? 2 : 6 } : { margin: compact ? 0.25 : 0.6, pad: compact ? 2 : 6 });
  drawCourt(ctx, m, { compact });
  drawTargets(ctx, m, targets, { labels, compact, highlightId });

  // Feed arcs from the machine to each landing point (dashed), then the bounce marks.
  if (machine && feeds.length && !compact) {
    ctx.strokeStyle = 'rgba(244,239,228,0.28)';
    ctx.lineWidth = 1.25;
    ctx.setLineDash([4, 5]);
    for (const f of feeds) {
      const sx = m.px(machine.x), sy = m.py(machine.z), ex = m.px(f.x), ey = m.py(f.z);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo((sx + ex) / 2 + (ex - sx) * 0.15, (sy + ey) / 2, ex, ey);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  for (const f of feeds) {
    const x = m.px(f.x), y = m.py(f.z), r = Math.max(compact ? 1.6 : 3, m.s * 0.13);
    ctx.fillStyle = 'rgba(244,239,228,0.9)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (!compact) {
      ctx.strokeStyle = 'rgba(244,239,228,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  for (const o of opponents) drawOpponent(ctx, m, o);
  if (machine) drawMachine(ctx, m, machine, { label: false });
  if (home && (view === 'full' || home.z <= 0)) drawPlayer(ctx, m, home, { compact, label: labels ? 'YOU · TÚ' : '' });
  return m;
}

/**
 * Top-down far court with target zones and landing dots coloured by success (SPEC §8).
 * landings: [{ x, z, success }] in court coordinates (far side z < 0).
 */
export function landingMap(canvas, landings = [], targets = []) {
  const { ctx, w, h } = fitCanvas(canvas, 400, 400);
  const m = courtMap(w, h, { z0: -10, z1: 0, margin: 1.1, pad: 4 });
  // Outside floor (where outs land) as a subtle band.
  ctx.fillStyle = 'rgba(10,20,36,0.55)';
  ctx.fillRect(m.px(m.x0), m.py(-11.1), m.px(m.x1) - m.px(m.x0), m.py(1.1) - m.py(-11.1));
  drawCourt(ctx, m);
  drawTargets(ctx, m, targets, { labels: false });

  const r = Math.max(4, m.s * 0.17);
  const lim = { x: COURT.halfWidth + 0.9, zMin: -COURT.halfLength - 0.9, zMax: 0.6 };
  // Misses first so successes draw on top.
  const sorted = [...landings].sort((a, b) => Number(!!a.success) - Number(!!b.success));
  for (const l of sorted) {
    if (!l || !Number.isFinite(l.x) || !Number.isFinite(l.z)) continue;
    const x = m.px(Math.max(-lim.x, Math.min(lim.x, l.x)));
    const y = m.py(Math.max(lim.zMin, Math.min(lim.zMax, l.z)));
    if (l.success) {
      ctx.fillStyle = 'rgba(220,245,60,0.22)';
      ctx.beginPath();
      ctx.arc(x, y, r * 2.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.ball;
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.strokeStyle = C.miss;
      ctx.lineWidth = 2.5;
      const a = r * 0.85;
      ctx.beginPath();
      ctx.moveTo(x - a, y - a);
      ctx.lineTo(x + a, y + a);
      ctx.moveTo(x + a, y - a);
      ctx.lineTo(x - a, y + a);
      ctx.stroke();
    }
  }
  // Zone labels last, in a dark tag just outside the zone's net-side edge, so dots never hide them.
  for (const zn of targets || []) {
    if (zn.kind && zn.kind !== 'land') continue;
    const cx = (m.px(zn.x0) + m.px(zn.x1)) / 2, by = m.py(Math.max(zn.z0, zn.z1));
    const label = `${String(zn.label || zn.id || '').toUpperCase()}${zn.points ? `  ${zn.points}` : ''}`;
    ctx.font = `800 ${Math.max(11, Math.min(18, m.s * 0.5))}px ${DISPLAY_FONT}`;
    const tw = ctx.measureText(label).width + 12, th = Math.max(16, m.s * 0.7);
    ctx.fillStyle = 'rgba(5,9,15,0.78)';
    ctx.fillRect(cx - tw / 2, by + 4, tw, th);
    ctx.fillStyle = C.glass;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, by + 4 + th / 2);
  }
  return m;
}

const fmtInt = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');

/**
 * Per-stroke bars (success rate) with average speed and spin, built as accessible DOM.
 * byStroke: { [stroke]: { count, avgSpeedKmh, avgSpinRpm, successRate, avgQuality } }
 */
export function strokeBars(el, byStroke = {}) {
  const rows = Object.entries(byStroke || {}).filter(([, s]) => s && s.count > 0).sort((a, b) => b[1].count - a[1].count);
  el.classList.add('stroke-bars');
  el.setAttribute('role', 'table');
  el.setAttribute('aria-label', 'Strokes this session');
  if (!rows.length) {
    el.innerHTML = '<p class="sb-empty">No strokes recorded yet.</p>';
    return;
  }
  const head = `<div class="sb-row sb-head" role="row">
      <span role="columnheader">Stroke</span><span role="columnheader" class="sb-n">Hits</span>
      <span role="columnheader">On target <i class="sb-key"></i> sweet spot</span><span role="columnheader" class="sb-num">km/h</span><span role="columnheader" class="sb-num">rpm</span></div>`;
  const body = rows.slice(0, 6).map(([id, s]) => {
    const n = strokeName(id);
    const pct = Math.round(Math.max(0, Math.min(1, s.successRate || 0)) * 100);
    const q = Number.isFinite(s.avgQuality) ? Math.round(s.avgQuality * 100) : null;
    return `<div class="sb-row" role="row">
      <span class="sb-name" role="cell">${escapeHtml(n.en)}<small>${escapeHtml(n.es)}</small></span>
      <span class="sb-n" role="cell">${s.count}</span>
      <span class="sb-bar" role="cell" aria-label="${pct}% on target${q != null ? `, sweet spot ${q}%` : ''}">
        <span class="sb-track"><i style="width:${pct}%"></i>${q != null ? `<b class="sb-q" style="left:${q}%" title="Sweet-spot quality"></b>` : ''}</span>
        <em>${pct}%</em></span>
      <span class="sb-num" role="cell">${fmtInt(s.avgSpeedKmh)}</span>
      <span class="sb-num" role="cell">${fmtInt(s.avgSpinRpm)}</span>
    </div>`;
  }).join('');
  el.innerHTML = head + body;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// MediaPipe BlazePose connections drawn for the camera PiP skeleton.
const BONES = [
  [11, 12], [11, 23], [12, 24], [23, 24], [11, 13], [13, 15], [12, 14], [14, 16],
  [15, 19], [16, 20], [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32], [27, 29], [28, 30],
];

/**
 * Draws a pose skeleton (normalized, unmirrored landmarks) into ctx over a w x h image.
 * mirror = true draws it as a selfie view to match a mirrored video.
 */
export function drawSkeleton(ctx, landmarks, w, h, { mirror = true, color = C.glass, joint = C.text, minVis = 0.35, scale = 1 } = {}) {
  if (!landmarks || landmarks.length < 33) return;
  const X = (p) => (mirror ? 1 - p.x : p.x) * w;
  const Y = (p) => p.y * h;
  const vis = (p) => p && (p.visibility == null || p.visibility >= minVis);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 6 * scale;
  ctx.beginPath();
  for (const [a, b] of BONES) {
    const pa = landmarks[a], pb = landmarks[b];
    if (!vis(pa) || !vis(pb)) continue;
    ctx.moveTo(X(pa), Y(pa));
    ctx.lineTo(X(pb), Y(pb));
  }
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3 * scale;
  ctx.stroke();
  // Head as a ring around the nose/ears.
  const nose = landmarks[0], el = landmarks[7], er = landmarks[8];
  if (vis(nose)) {
    const r = vis(el) && vis(er) ? Math.hypot(X(el) - X(er), Y(el) - Y(er)) * 0.62 : 12 * scale;
    ctx.beginPath();
    ctx.arc(X(nose), Y(nose), Math.max(6 * scale, r), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = joint;
  for (const i of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    const p = landmarks[i];
    if (!vis(p)) continue;
    ctx.beginPath();
    ctx.arc(X(p), Y(p), 3.2 * scale, 0, Math.PI * 2);
    ctx.fill();
  }
}
