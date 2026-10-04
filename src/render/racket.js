// Procedural padel racket. Local frame per RACKET in config.js: origin = grip point
// (center of the hand on the handle), +Y = handle -> tip, +Z = forehand face normal.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { RACKET } from '../config.js';
import {
  loadFonts, canvasTexture, cached, hash2, tileNoise, heightToNormalCanvas, DISPLAY_FONT, UI_FONT, actorQuality,
} from './actorKit.js';

// Head outline: a teardrop. Inner = hitting surface, outer = inner grown by the frame width.
const FACE_CY = 0.257;
const FACE_SX = 0.118;
const FACE_SY = 0.126;
const FRAME_W = RACKET.frameWidth; // 12 mm rim seen face-on
const THICK = RACKET.thickness; // 38 mm
const FACE_THICK = 0.0335; // faces sit ~2 mm inside the rim on each side
const HANDLE_R = 0.0172;
const HANDLE_BOTTOM = RACKET.buttY + 0.008;
const HANDLE_TOP = RACKET.handleTopY;

/**
 * Head shapes (game/progression.js RACKETS): teardrop (hybrid), round (control: wide, centred) and
 * diamond (power: widest high up, straight shoulders to a flattened tip). up: widening toward the
 * tip; down: narrowing toward the throat; sx / sy: width / length scale; point: tip pinch.
 */
export const RACKET_SHAPES = Object.freeze({
  teardrop: Object.freeze({ up: 0.055, down: 0.1, sx: 1, sy: 1, point: 0 }),
  round: Object.freeze({ up: 0.0, down: 0.035, sx: 1.04, sy: 0.955, point: 0 }),
  diamond: Object.freeze({ up: 0.13, down: 0.17, sx: 0.98, sy: 1.025, point: 0.2 }),
});
let SHAPE = RACKET_SHAPES.teardrop;

/** Head outline point at angle th (0 = tip, PI = throat), grown by g meters (current SHAPE). */
function teardrop(th, g, out = new THREE.Vector2()) {
  const c = Math.cos(th), s = Math.sin(th);
  // Widest point sits above center; the lower half narrows toward the throat.
  const widen = (1 + SHAPE.up * c - SHAPE.down * Math.max(0, -c) ** 1.6) * (1 - SHAPE.point * Math.max(0, c) ** 3);
  const x = (FACE_SX * SHAPE.sx * widen + g) * s;
  const y = FACE_CY + (FACE_SY * SHAPE.sy + g) * c - 0.012 * Math.max(0, -c) ** 2;
  return out.set(x, y);
}

function facePath(g, n = 96) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(teardrop((i / n) * Math.PI * 2, g));
  return pts;
}

/** Frame outline: head rim flowing into two throat arms that meet the handle. */
function frameOuterShape() {
  const shape = new THREE.Shape();
  const g = FRAME_W;
  const th0 = 2.3; // where the arms leave the head curve
  shape.moveTo(-0.0175, 0.062);
  const pL = teardrop(-th0, g);
  // Tangent-continuous join: arrive along the head curve's direction at -th0.
  const tL = teardrop(-th0 + 0.01, g).sub(pL).normalize();
  shape.bezierCurveTo(-0.024, 0.09, pL.x - tL.x * 0.04, pL.y - tL.y * 0.04, pL.x, pL.y);
  const n = 80;
  for (let i = 1; i <= n; i++) {
    const th = -th0 + (i / n) * (2 * th0);
    const p = teardrop(th, g);
    shape.lineTo(p.x, p.y);
  }
  const pR = teardrop(th0, g);
  const tR = teardrop(th0 + 0.01, g).sub(pR).normalize();
  shape.bezierCurveTo(pR.x + tR.x * 0.04, pR.y + tR.y * 0.04, 0.024, 0.09, 0.0175, 0.062);
  shape.lineTo(-0.0175, 0.062);
  return shape;
}

/** The open throat ("heart") between the bridge and the arms. */
function heartPath() {
  const p = new THREE.Path();
  const bridgeY = teardrop(Math.PI, 0).y - FRAME_W * 0.95; // bottom of face minus bridge
  // Rounded inverted triangle with a heart notch in the bridge.
  p.moveTo(0, 0.079);
  p.bezierCurveTo(-0.008, 0.083, -0.03, bridgeY - 0.026, -0.036, bridgeY - 0.008);
  p.quadraticCurveTo(-0.037, bridgeY + 0.001, -0.026, bridgeY);
  p.quadraticCurveTo(-0.01, bridgeY - 0.001, 0, bridgeY - 0.009);
  p.quadraticCurveTo(0.01, bridgeY - 0.001, 0.026, bridgeY);
  p.quadraticCurveTo(0.037, bridgeY + 0.001, 0.036, bridgeY - 0.008);
  p.bezierCurveTo(0.03, bridgeY - 0.026, 0.008, 0.083, 0, 0.079);
  return p;
}

/** ~40 drilled holes on a staggered grid, kept inside the face with a margin. */
export function racketHolePositions() {
  return cached('racketHoles', () => {
    const out = [];
    const sp = 0.0305;
    const rowH = sp * 0.866;
    for (let r = -6; r <= 6; r++) {
      const y = FACE_CY + 0.006 + r * rowH;
      const off = (r & 1) ? sp / 2 : 0;
      for (let c = -5; c <= 5; c++) {
        const x = c * sp + off;
        const nx = x / (FACE_SX - 0.02), ny = (y - FACE_CY) / (FACE_SY - 0.022);
        if (nx * nx + ny * ny > 1) continue;
        out.push(new THREE.Vector2(x, y));
      }
    }
    return out;
  });
}

const HOLE_R = 0.0062;

// ---------------------------------------------------------------- textures

function drawCarbon(ctx, w, h, cell, base = 18) {
  // 3K twill weave: alternating tows with a soft specular sheen gradient per tow.
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      const i = Math.floor(x / cell), j = Math.floor(y / cell);
      const horiz = ((i + j) & 3) < 2;
      const g = ctx.createLinearGradient(x, y, horiz ? x : x + cell, horiz ? y + cell : y);
      const k = base + hash2(i, j, 3) * 6;
      g.addColorStop(0, `rgb(${k},${k},${k + 2})`);
      g.addColorStop(0.5, `rgb(${k + 22},${k + 22},${k + 25})`);
      g.addColorStop(1, `rgb(${k},${k},${k + 2})`);
      ctx.fillStyle = g;
      ctx.fillRect(x, y, cell, cell);
    }
  }
}

/**
 * Face graphics per model (all original designs): the band motif and the printed names.
 * motif: 'fang' (sweeping bands), 'orbit' (concentric rings), 'grit' (contour lines),
 * 'cobra' (chevrons), 'mamba' (pinstripes).
 */
export const RACKET_MODELS = Object.freeze({
  fang: Object.freeze({ shape: 'teardrop', style: 'carbon', motif: 'fang', word: 'VÍBORA', line: 'FANG 18K  ·  CONTROL CORE', back: 'EVA SOFT 30  ·  360 g', color: '#e8572a' }),
  orbit: Object.freeze({ shape: 'round', style: 'white', motif: 'orbit', word: 'ORBIT', line: 'ROUND  ·  SOFT EVA  ·  355 g', back: 'CONTROL  ·  BIG SWEET SPOT', color: '#1f6fe0' }),
  grit: Object.freeze({ shape: 'teardrop', style: 'matte', motif: 'grit', word: 'GRIT 3D', line: 'SANDED FACE  ·  SPIN', back: '3D GRIT  ·  365 g', color: '#13a89e' }),
  cobra: Object.freeze({ shape: 'diamond', style: 'carbon', motif: 'cobra', word: 'COBRA', line: 'DIAMOND  ·  HARD EVA  ·  POWER', back: 'HIGH BALANCE  ·  370 g', color: '#d81b4f' }),
  mamba: Object.freeze({ shape: 'teardrop', style: 'carbon', motif: 'mamba', word: 'MAMBA PRO', line: '18K CARBON  ·  TOUR', back: 'HARD CORE  ·  365 g', color: '#eceae4' }),
});

/** Motif bands for the non-default models (front face). */
function drawMotif(ctx, w, h, motif, hex, dark, ink, rough) {
  ctx.save();
  switch (motif) {
    case 'orbit':
      ctx.lineWidth = w * 0.05;
      for (let i = 0; i < 4; i++) {
        ctx.strokeStyle = ink(i % 2 ? dark : hex);
        ctx.beginPath();
        ctx.ellipse(w * 0.5, h * 0.42, w * (0.18 + i * 0.1), h * (0.12 + i * 0.075), -0.25, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    case 'grit':
      ctx.lineWidth = w * 0.012;
      for (let i = 0; i < 14; i++) {
        ctx.strokeStyle = ink(i % 3 ? hex : '#f2f2f2');
        ctx.beginPath();
        for (let x = 0; x <= w; x += w / 40) {
          const y = h * (0.08 + i * 0.06) + Math.sin(x / w * 7 + i * 0.9) * h * 0.02 + Math.sin(x / w * 17 + i) * h * 0.006;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      break;
    case 'cobra':
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = ink(i % 2 ? dark : hex);
        const y = h * (0.12 + i * 0.11);
        ctx.beginPath();
        ctx.moveTo(0, y + h * 0.1);
        ctx.lineTo(w * 0.5, y);
        ctx.lineTo(w, y + h * 0.1);
        ctx.lineTo(w, y + h * 0.15);
        ctx.lineTo(w * 0.5, y + h * 0.05);
        ctx.lineTo(0, y + h * 0.15);
        ctx.closePath();
        ctx.fill();
      }
      break;
    case 'mamba':
      ctx.fillStyle = ink(hex);
      ctx.fillRect(w * 0.08, 0, w * 0.035, h);
      ctx.fillRect(w * 0.88, 0, w * 0.035, h);
      ctx.fillStyle = ink(rough ? '#3c3c3c' : '#16181d');
      ctx.fillRect(w * 0.13, 0, w * 0.012, h);
      ctx.fillRect(w * 0.86, 0, w * 0.012, h);
      break;
    default:
      break;
  }
  ctx.restore();
}

function drawFaceDesign(ctx, w, h, color, side, rough, modelId = 'fang') {
  const model = RACKET_MODELS[modelId] || RACKET_MODELS.fang;
  if (model.motif !== 'fang') {
    drawModelFace(ctx, w, h, color, side, rough, model);
    return;
  }
  // side: 'front' | 'back'. Coordinates: x across face (0..w), y down from tip (0..h).
  const col = new THREE.Color(color);
  const hex = `#${col.getHexString()}`;
  const dark = `#${col.clone().multiplyScalar(0.55).getHexString()}`;
  if (rough) {
    ctx.fillStyle = '#9a9a9a'; // sanded carbon: fairly rough
    ctx.fillRect(0, 0, w, h);
  } else {
    drawCarbon(ctx, w, h, 14);
  }
  const ink = (c) => (rough ? '#3c3c3c' : c); // printed areas: glossier

  ctx.save();
  if (side === 'front') {
    // Two sweeping "fang" bands from the throat toward the upper right.
    ctx.fillStyle = ink(hex);
    ctx.beginPath();
    ctx.moveTo(w * 0.0, h * 0.98);
    ctx.bezierCurveTo(w * 0.35, h * 0.72, w * 0.62, h * 0.55, w * 1.0, h * 0.18);
    ctx.lineTo(w * 1.0, h * 0.34);
    ctx.bezierCurveTo(w * 0.7, h * 0.62, w * 0.42, h * 0.82, w * 0.1, h * 1.0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = ink(dark);
    ctx.beginPath();
    ctx.moveTo(w * 0.22, h * 1.0);
    ctx.bezierCurveTo(w * 0.5, h * 0.8, w * 0.75, h * 0.62, w * 1.0, h * 0.42);
    ctx.lineTo(w * 1.0, h * 0.47);
    ctx.bezierCurveTo(w * 0.78, h * 0.66, w * 0.55, h * 0.84, w * 0.3, h * 1.0);
    ctx.closePath();
    ctx.fill();
    // Thin pinstripe.
    ctx.strokeStyle = ink('#f2f2f2');
    ctx.lineWidth = w * 0.006;
    ctx.beginPath();
    ctx.moveTo(w * 0.0, h * 0.9);
    ctx.bezierCurveTo(w * 0.33, h * 0.66, w * 0.6, h * 0.48, w * 1.0, h * 0.1);
    ctx.stroke();
    // Snake-scale texture on the upper left (subtle).
    if (!rough) {
      ctx.globalAlpha = 0.16;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2;
      for (let yy = 0; yy < h * 0.45; yy += 20) {
        for (let xx = (yy / 20) % 2 ? 0 : 14; xx < w * 0.55; xx += 28) {
          ctx.beginPath();
          ctx.arc(xx, yy, 12, 0.15 * Math.PI, 0.85 * Math.PI);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }
    // Wordmark across the lower face.
    ctx.fillStyle = ink('#f5f5f5');
    ctx.font = `900 ${Math.round(h * 0.135)}px ${DISPLAY_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.save();
    ctx.translate(w * 0.5, h * 0.7);
    ctx.rotate(-0.06);
    if (!rough) {
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 6;
    }
    ctx.fillText('VÍBORA', 0, 0);
    ctx.restore();
    ctx.font = `700 ${Math.round(h * 0.03)}px ${UI_FONT}`;
    ctx.fillStyle = ink('#d9d9d9');
    ctx.fillText('FANG 18K  ·  CONTROL CORE', w * 0.5, h * 0.79);
    // Fang mark near the tip.
    ctx.fillStyle = ink(hex);
    ctx.save();
    ctx.translate(w * 0.5, h * 0.14);
    ctx.beginPath();
    ctx.moveTo(-w * 0.07, 0);
    ctx.quadraticCurveTo(-w * 0.035, h * 0.02, -w * 0.02, h * 0.075);
    ctx.quadraticCurveTo(-w * 0.012, h * 0.03, 0, h * 0.02);
    ctx.quadraticCurveTo(w * 0.012, h * 0.03, w * 0.02, h * 0.075);
    ctx.quadraticCurveTo(w * 0.035, h * 0.02, w * 0.07, 0);
    ctx.quadraticCurveTo(0, h * 0.035, -w * 0.07, 0);
    ctx.fill();
    ctx.restore();
  } else {
    // Backhand face: mirrored diagonal and a vertical wordmark.
    ctx.fillStyle = ink(hex);
    ctx.beginPath();
    ctx.moveTo(w * 1.0, h * 0.95);
    ctx.bezierCurveTo(w * 0.7, h * 0.7, w * 0.35, h * 0.5, w * 0.0, h * 0.25);
    ctx.lineTo(w * 0.0, h * 0.36);
    ctx.bezierCurveTo(w * 0.3, h * 0.58, w * 0.62, h * 0.8, w * 0.88, h * 1.0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = ink('#f2f2f2');
    ctx.lineWidth = w * 0.006;
    ctx.beginPath();
    ctx.moveTo(w * 1.0, h * 0.86);
    ctx.bezierCurveTo(w * 0.66, h * 0.62, w * 0.36, h * 0.43, w * 0.0, h * 0.18);
    ctx.stroke();
    ctx.save();
    ctx.translate(w * 0.27, h * 0.52);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = ink('#f5f5f5');
    ctx.font = `900 ${Math.round(h * 0.11)}px ${DISPLAY_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('VÍBORA', 0, 0);
    ctx.restore();
    ctx.font = `600 ${Math.round(h * 0.028)}px ${UI_FONT}`;
    ctx.fillStyle = ink('#cfcfcf');
    ctx.textAlign = 'center';
    ctx.fillText('EVA SOFT 30  ·  360 g', w * 0.62, h * 0.86);
  }
  ctx.restore();
}

/** Face of the non-default models: motif, wordmark and spec line (front); name and spec (back). */
function drawModelFace(ctx, w, h, color, side, rough, model) {
  const col = new THREE.Color(color);
  const hex = `#${col.getHexString()}`;
  const dark = `#${col.clone().multiplyScalar(0.55).getHexString()}`;
  const light = col.getHSL({ h: 0, s: 0, l: 0 }).l > 0.7;
  if (rough) {
    ctx.fillStyle = model.motif === 'grit' ? '#c4c4c4' : '#9a9a9a'; // the grit face is much rougher
    ctx.fillRect(0, 0, w, h);
  } else if (model.style === 'white') {
    ctx.fillStyle = '#e9e8e4';
    ctx.fillRect(0, 0, w, h);
  } else {
    drawCarbon(ctx, w, h, model.motif === 'mamba' ? 10 : 14);
  }
  const ink = (c) => (rough ? '#3c3c3c' : c);
  const textInk = model.style === 'white' ? '#16181d' : light ? '#16181d' : '#f5f5f5';
  if (side === 'front') {
    drawMotif(ctx, w, h, model.motif, hex, dark, ink, rough);
    ctx.save();
    ctx.translate(w * 0.5, h * 0.72);
    ctx.rotate(model.motif === 'cobra' ? 0 : -0.05);
    ctx.fillStyle = ink(model.motif === 'mamba' ? hex : textInk);
    ctx.font = `900 ${Math.round(h * (model.word.length > 7 ? 0.105 : 0.135))}px ${DISPLAY_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (!rough && model.style !== 'white') {
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 6;
    }
    ctx.fillText(model.word, 0, 0);
    ctx.restore();
    ctx.font = `700 ${Math.round(h * 0.03)}px ${UI_FONT}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = ink(model.style === 'white' ? '#3a3d44' : '#d9d9d9');
    ctx.fillText(model.line, w * 0.5, h * 0.81);
  } else {
    ctx.save();
    ctx.globalAlpha = 0.85;
    drawMotif(ctx, w, h, model.motif, hex, dark, ink, rough);
    ctx.restore();
    ctx.save();
    ctx.translate(w * 0.27, h * 0.52);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = ink(textInk);
    ctx.font = `900 ${Math.round(h * 0.1)}px ${DISPLAY_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(model.word, 0, 0);
    ctx.restore();
    ctx.font = `600 ${Math.round(h * 0.028)}px ${UI_FONT}`;
    ctx.fillStyle = ink(model.style === 'white' ? '#3a3d44' : '#cfcfcf');
    ctx.textAlign = 'center';
    ctx.fillText(model.back, w * 0.62, h * 0.86);
  }
}

const FACE_ATLAS_W = 0.27; // meters covered horizontally by the atlas
const FACE_ATLAS_Y0 = FACE_CY - FACE_SY - 0.006;
const FACE_ATLAS_H = 2 * FACE_SY + 0.012;

function faceTextures(color, modelId = 'fang') {
  return cached(`racketFace:${modelId}:${color}`, () => {
    const q = actorQuality().tex;
    const W = 1024 * q, H = 2048 * q;
    const draw = (rough) => (ctx) => {
      ctx.save();
      ctx.scale(q, q);
      drawAtlas(ctx, rough);
      ctx.restore();
    };
    const drawAtlas = (ctx, rough) => {
      const W = 1024, H = 2048;
      ctx.save();
      drawFaceDesign(ctx, W, H / 2, color, 'front', rough, modelId);
      ctx.restore();
      ctx.save();
      ctx.translate(0, H / 2);
      drawFaceDesign(ctx, W, H / 2, color, 'back', rough, modelId);
      ctx.restore();
      if (rough) {
        // Sand grit noise on top of everything.
        const img = ctx.getImageData(0, 0, W * q, H * q);
        for (let i = 0; i < img.data.length; i += 4) {
          const n = (hash2(i, 7, 1) - 0.5) * 40;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, img.data[i] + n));
        }
        ctx.putImageData(img, 0, 0);
      }
    };
    const map = canvasTexture(W, H, draw(false));
    const rough = canvasTexture(W, H, draw(true), { srgb: false });
    loadFonts().then(() => { map.userData.redraw(); rough.userData.redraw(); });
    // Grit + weave bump.
    const bumpCanvas = document.createElement('canvas');
    bumpCanvas.width = bumpCanvas.height = 512;
    const bctx = bumpCanvas.getContext('2d');
    const img = bctx.createImageData(512, 512);
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        const i = (y * 512 + x) * 4;
        const cell = 7;
        const ix = Math.floor(x / cell), iy = Math.floor(y / cell);
        const horiz = ((ix + iy) & 3) < 2;
        const f = horiz ? (y % cell) / cell : (x % cell) / cell;
        const weave = Math.sin(f * Math.PI) * 0.6;
        const grit = hash2(x, y, 11) * 0.5;
        const v = (weave * 0.5 + grit * 0.5) * 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    bctx.putImageData(img, 0, 0);
    const normal = new THREE.CanvasTexture(heightToNormalCanvas(bumpCanvas, 1.2));
    normal.colorSpace = THREE.NoColorSpace;
    normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
    normal.repeat.set(2, 4);
    return { map, rough, normal };
  });
}

function carbonTileTexture() {
  return cached('racketCarbonTile', () => {
    const t = canvasTexture(256, 256, (ctx, w, h) => drawCarbon(ctx, w, h, 16, 14), { repeat: true });
    t.repeat.set(30, 2);
    return t;
  });
}

/** Frame side band: accent stripe running around the rim, centered in its thickness. */
function frameSideTexture(color) {
  return cached(`racketSide:${color}`, () => {
    const t = canvasTexture(64, 256, (ctx, w, h) => {
      ctx.fillStyle = '#121214';
      ctx.fillRect(0, 0, w, h);
      const c = `#${new THREE.Color(color).getHexString()}`;
      ctx.fillStyle = c;
      ctx.fillRect(0, h * 0.38, w, h * 0.24);
      ctx.fillStyle = '#e9e9e9';
      ctx.fillRect(0, h * 0.355, w, h * 0.012);
      ctx.fillRect(0, h * 0.633, w, h * 0.012);
    }, { repeat: true });
    return t;
  });
}

/** Overlapping grip-tape spiral (one tile = one diagonal turn) with perforations. */
function gripTextures(color) {
  return cached(`grip:${color}`, () => {
    const W = 256, H = 256;
    const heightCanvas = document.createElement('canvas');
    heightCanvas.width = W;
    heightCanvas.height = H;
    const hctx = heightCanvas.getContext('2d');
    const himg = hctx.createImageData(W, H);
    const colorDraw = (ctx) => {
      const img = ctx.createImageData(W, H);
      const base = new THREE.Color(color);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          // Tape coordinate across its width: wraps once per tile diagonally.
          const s = (((y / H) - (x / W)) % 1 + 1) % 1;
          const ridge = s < 0.08 ? s / 0.08 : 1; // overlap step
          const perf = ((Math.floor(x / 6) + Math.floor(y / 6)) & 1) === 0
            && Math.hypot((x % 6) - 3, (y % 6) - 3) < 1.1;
          const n = tileNoise(x / W, y / H, 64, 4) * 0.15;
          let v = 0.55 + 0.45 * ridge - n - (perf ? 0.35 : 0);
          const shade = 0.72 + 0.28 * ridge - (s < 0.02 ? 0.35 : 0) - (perf ? 0.25 : 0) - n * 0.6;
          const i = (y * W + x) * 4;
          img.data[i] = Math.min(255, base.r * 255 * shade + 8);
          img.data[i + 1] = Math.min(255, base.g * 255 * shade + 8);
          img.data[i + 2] = Math.min(255, base.b * 255 * shade + 8);
          img.data[i + 3] = 255;
          v = Math.max(0, Math.min(1, v));
          himg.data[i] = himg.data[i + 1] = himg.data[i + 2] = v * 255;
          himg.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      hctx.putImageData(himg, 0, 0);
    };
    const map = canvasTexture(W, H, colorDraw, { repeat: true });
    const normal = new THREE.CanvasTexture(heightToNormalCanvas(heightCanvas, 3));
    normal.colorSpace = THREE.NoColorSpace;
    normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
    const turns = 6;
    map.repeat.set(1, turns);
    normal.repeat.set(1, turns);
    return { map, normal };
  });
}

function capLogoTexture(color) {
  return cached(`racketCap:${color}`, () => {
    const t = canvasTexture(128, 128, (ctx, w, h) => {
      ctx.fillStyle = '#141416';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = `#${new THREE.Color(color).getHexString()}`;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, w * 0.36, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#f4f4f4';
      ctx.font = `900 ${Math.round(h * 0.5)}px ${DISPLAY_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('V', w / 2, h / 2 + 2);
    });
    loadFonts().then(() => t.userData.redraw());
    return t;
  });
}

// ---------------------------------------------------------------- geometry

function remapFaceUVs(geo, depth) {
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const capGroup = geo.groups[0];
  for (let i = capGroup.start; i < capGroup.start + capGroup.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const u = (x + FACE_ATLAS_W / 2) / FACE_ATLAS_W;
    const v = (y - FACE_ATLAS_Y0) / FACE_ATLAS_H;
    if (z > depth / 2) uv.setXY(i, u, 0.5 + 0.5 * v); // front (+Z) cap -> top of atlas
    else uv.setXY(i, 1 - u, 0.5 * v); // back cap, unmirrored -> bottom of atlas
  }
  uv.needsUpdate = true;
}

function buildHeadGeometries(shapeId = 'teardrop') {
  const shape = RACKET_SHAPES[shapeId] ? shapeId : 'teardrop';
  return cached(shape === 'teardrop' ? 'racketHeadGeo' : `racketHeadGeo:${shape}`, () => {
    const prev = SHAPE;
    SHAPE = RACKET_SHAPES[shape];
    try {
      return buildHeadGeometriesNow();
    } finally {
      SHAPE = prev;
    }
  });
}

function buildHeadGeometriesNow() {
  {
    // Hitting face with drilled holes.
    const faceShape = new THREE.Shape(facePath(0.0015));
    // Holes stay well inside this shape's outline (diamond tips are narrower).
    const inside = (p) => {
      const th = Math.atan2(p.x, p.y - FACE_CY);
      const edge = teardrop(th, -0.016);
      return Math.hypot(p.x, p.y - FACE_CY) <= Math.hypot(edge.x, edge.y - FACE_CY);
    };
    for (const p of racketHolePositions()) {
      if (!inside(p)) continue;
      const hole = new THREE.Path();
      hole.absarc(p.x, p.y, HOLE_R, 0, Math.PI * 2, true);
      faceShape.holes.push(hole);
    }
    const face = new THREE.ExtrudeGeometry(faceShape, { depth: FACE_THICK, bevelEnabled: false, curveSegments: 10 });
    remapFaceUVs(face, FACE_THICK);
    face.translate(0, 0, -FACE_THICK / 2);
    face.computeVertexNormals();

    // Frame rim + throat arms with the face opening and the heart opening as holes.
    const bevel = 0.0045;
    const frameShape = frameOuterShape();
    const faceHole = new THREE.Path(facePath(0).reverse());
    frameShape.holes.push(faceHole, heartPath());
    const frameDepth = THICK - 2 * bevel;
    const frame = new THREE.ExtrudeGeometry(frameShape, {
      depth: frameDepth, bevelEnabled: true, bevelThickness: bevel, bevelSize: 0.0032, bevelSegments: 4, curveSegments: 24,
    });
    // Side-wall UV: v = 1 - z; rescale so the stripe texture spans the full thickness.
    const uv = frame.attributes.uv;
    const pos = frame.attributes.position;
    const side = frame.groups[1];
    for (let i = side.start; i < side.start + side.count; i++) {
      const z = pos.getZ(i);
      uv.setY(i, (z + bevel) / (frameDepth + 2 * bevel));
      uv.setX(i, uv.getX(i) * 8);
    }
    const cap = frame.groups[0];
    for (let i = cap.start; i < cap.start + cap.count; i++) uv.setXY(i, pos.getX(i) * 6, pos.getY(i) * 6);
    frame.translate(0, 0, -frameDepth / 2);
    // Smooth the rim: weld the side walls (caps stay crisp because their UVs differ).
    const smooth = mergeVertices(frame, 1e-5);
    smooth.computeVertexNormals();
    return { face, frame: smooth };
  }
}

function handleGeometry() {
  return cached('racketHandleGeo', () => {
    const len = HANDLE_TOP - HANDLE_BOTTOM;
    const g = new THREE.CylinderGeometry(HANDLE_R, HANDLE_R * 1.07, len, 32, 24, true);
    // Rounded octagon cross-section, slightly deeper (Z) than wide.
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const a = Math.atan2(z, x);
      const r = Math.hypot(x, z);
      const seg = Math.PI / 4;
      const local = ((a % seg) + seg) % seg - seg / 2;
      const oct = 1 / Math.cos(local) * Math.cos(seg / 2);
      const k = 0.55 * oct + 0.45;
      p.setXYZ(i, Math.cos(a) * r * k * 0.97, p.getY(i), Math.sin(a) * r * k * 1.05);
    }
    g.translate(0, (HANDLE_TOP + HANDLE_BOTTOM) / 2, 0);
    g.computeVertexNormals();
    return g;
  });
}

function buttCapGeometry() {
  return cached('racketCapGeo', () => {
    const y0 = RACKET.buttY - 0.004;
    const pts = [
      [0.0001, y0], [0.013, y0], [0.0195, y0 + 0.002], [0.0215, y0 + 0.006], [0.0205, y0 + 0.011],
      [0.0182, y0 + 0.016], [0.0178, y0 + 0.02],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    return new THREE.LatheGeometry(pts, 32);
  });
}

function collarGeometry() {
  return cached('racketCollarGeo', () => {
    const pts = [
      [0.0176, HANDLE_TOP - 0.006], [0.0186, HANDLE_TOP - 0.002], [0.0186, HANDLE_TOP + 0.004], [0.0172, HANDLE_TOP + 0.01],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const g = new THREE.LatheGeometry(pts, 32);
    g.scale(1, 1, 1.1);
    return g;
  });
}

/** Approximate wrist position in the racket frame for the canonical right-hand grip (cord loop). */
export const CORD_WRIST = new THREE.Vector3(0.052, -0.048, -0.037);

function cordGeometry() {
  return cached('racketCordGeo', () => {
    // From the butt cap, down and around the wrist (a loop ~ 7 cm across), twisted pair.
    const c = CORD_WRIST;
    const axis = new THREE.Vector3(0.73, -0.68, 0).normalize(); // forearm direction (away from hand)
    const u = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(0, 0, 1)).normalize();
    const v = new THREE.Vector3().crossVectors(axis, u).normalize();
    const loopC = c.clone().addScaledVector(axis, 0.03);
    const rad = 0.034;
    const pts = [new THREE.Vector3(0, RACKET.buttY - 0.006, 0), new THREE.Vector3(0.006, RACKET.buttY - 0.022, -0.004)];
    const startA = Math.atan2(pts[1].clone().sub(loopC).dot(v), pts[1].clone().sub(loopC).dot(u));
    for (let i = 0; i <= 18; i++) {
      const a = startA + (i / 18) * Math.PI * 2;
      pts.push(loopC.clone().addScaledVector(u, Math.cos(a) * rad).addScaledVector(v, Math.sin(a) * rad));
    }
    pts.push(new THREE.Vector3(0.004, RACKET.buttY - 0.02, 0.004));
    pts.push(new THREE.Vector3(0, RACKET.buttY - 0.006, 0.001));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    return new THREE.TubeGeometry(curve, 120, 0.0021, 8, false);
  });
}

// ---------------------------------------------------------------- public

const STYLES = {
  carbon: { frame: '#141416', frameRough: 0.32, faceTint: '#ffffff' },
  matte: { frame: '#1e1f22', frameRough: 0.6, faceTint: '#ffffff' },
  white: { frame: '#e8e8ea', frameRough: 0.35, faceTint: '#ffffff' },
};

/**
 * @param {{style?: 'carbon'|'matte'|'white', color?: string, gripColor?: string, handed?: 'right'|'left', cord?: boolean}} opts
 * @returns {THREE.Group} origin = grip point, +Y handle->tip, +Z forehand face normal.
 *   userData: { cord: Mesh, face: Mesh, frame: Mesh, setColor(c), setHanded(h) }
 */
export function buildRacket({ style = null, color = '#e8572a', gripColor = '#f1f1ee', handed = 'right', cord = true, model = 'fang' } = {}) {
  let modelId = RACKET_MODELS[model] ? model : 'fang';
  let curColor = color;
  const m0 = RACKET_MODELS[modelId];
  style = style || m0.style;
  const st = STYLES[style] || STYLES.carbon;
  const group = new THREE.Group();
  group.name = 'racket';
  const { face, frame } = buildHeadGeometries(m0.shape);

  const tex = faceTextures(color, modelId);
  const faceMat = new THREE.MeshPhysicalMaterial({
    map: tex.map,
    roughnessMap: tex.rough,
    roughness: 1,
    metalness: 0.05,
    normalMap: tex.normal,
    normalScale: new THREE.Vector2(0.25, 0.25),
    clearcoat: 0.25,
    clearcoatRoughness: 0.45,
  });
  const foamMat = new THREE.MeshStandardMaterial({ color: '#2a2b2e', roughness: 0.95 });
  const faceMesh = new THREE.Mesh(face, [faceMat, foamMat]);
  faceMesh.name = 'racket-face';

  const capMat = new THREE.MeshPhysicalMaterial({
    color: st.frame, map: style === 'white' ? null : carbonTileTexture(), roughness: st.frameRough,
    metalness: 0.1, clearcoat: 0.85, clearcoatRoughness: 0.2,
  });
  const sideMat = new THREE.MeshPhysicalMaterial({
    map: frameSideTexture(color), color: style === 'white' ? '#ffffff' : '#ffffff', roughness: st.frameRough,
    metalness: 0.1, clearcoat: 0.85, clearcoatRoughness: 0.18,
  });
  const frameMesh = new THREE.Mesh(frame, [capMat, sideMat]);
  frameMesh.name = 'racket-frame';

  const grip = gripTextures(gripColor);
  const gripMat = new THREE.MeshStandardMaterial({
    map: grip.map, normalMap: grip.normal, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.78, metalness: 0,
  });
  const handle = new THREE.Mesh(handleGeometry(), gripMat);
  handle.name = 'racket-handle';
  const trimMat = new THREE.MeshPhysicalMaterial({ color: '#111113', roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.2 });
  const accentMat = new THREE.MeshPhysicalMaterial({ color, roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.15 });
  const collar = new THREE.Mesh(collarGeometry(), trimMat);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(HANDLE_R * 1.02, HANDLE_R * 1.02, 0.003, 32, 1, true), accentMat);
  band.position.y = HANDLE_TOP - 0.009;
  band.scale.z = 1.08;
  const cap = new THREE.Mesh(buttCapGeometry(), trimMat);
  const capLogo = new THREE.Mesh(new THREE.CircleGeometry(0.0128, 32), new THREE.MeshStandardMaterial({
    map: capLogoTexture(color), roughness: 0.4,
  }));
  capLogo.rotation.x = Math.PI / 2;
  capLogo.position.y = RACKET.buttY - 0.0042;

  group.add(frameMesh, faceMesh, handle, collar, band, cap, capLogo);

  let cordMesh = null;
  if (cord) {
    cordMesh = new THREE.Mesh(cordGeometry(), new THREE.MeshStandardMaterial({ color: '#1b1b1d', roughness: 0.7 }));
    cordMesh.name = 'racket-cord';
    group.add(cordMesh);
  }
  group.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  if (cordMesh) cordMesh.castShadow = false;

  const setHanded = (h) => {
    if (cordMesh) cordMesh.scale.x = h === 'left' ? -1 : 1;
  };
  setHanded(handed);
  group.userData = {
    cord: cordMesh,
    face: faceMesh,
    frame: frameMesh,
    setHanded,
    setCordVisible: (b) => { if (cordMesh) cordMesh.visible = b; },
    setColor: (c) => {
      curColor = c;
      const t = faceTextures(c, modelId);
      faceMat.map = t.map;
      faceMat.roughnessMap = t.rough;
      faceMat.needsUpdate = true;
      sideMat.map = frameSideTexture(c);
      sideMat.needsUpdate = true;
      accentMat.color.set(c);
      capLogo.material.map = capLogoTexture(c);
      capLogo.material.needsUpdate = true;
    },
    /** Switches the racket model (head shape, frame finish, face graphics); color optional. */
    setModel: (id, c = null) => {
      if (!RACKET_MODELS[id]) return;
      const md = RACKET_MODELS[id];
      modelId = id;
      const geo = buildHeadGeometries(md.shape);
      faceMesh.geometry = geo.face;
      frameMesh.geometry = geo.frame;
      const fs = STYLES[md.style] || STYLES.carbon;
      capMat.color.set(fs.frame);
      capMat.roughness = fs.frameRough;
      capMat.map = md.style === 'white' ? null : carbonTileTexture();
      capMat.needsUpdate = true;
      sideMat.roughness = fs.frameRough;
      group.userData.setColor(c || curColor);
      group.userData.model = id;
    },
    model: modelId,
  };
  return group;
}

/** Throat point (where the off hand cradles the racket in ready position), racket frame. */
export const RACKET_THROAT = new THREE.Vector3(0, 0.1, 0);
export const RACKET_HANDLE_RADIUS = HANDLE_R;
