// Realistic sample data for dev/ui.html: the 13 drills of SPEC §5.4 (UI-relevant
// fields only, with simple feed generators), bests, HUD states, a ShotRecord, a
// session summary, match score, camera list, a synthetic PoseFrame and a fake
// camera image to stand in for the <video>.

const zone = (id, label, x0, x1, z0, z1, points, kind = 'land') => ({ id, label, x0, x1, z0, z1, points, kind });
const Z_SVC = 6.95;

const feedAround = (cx, cz, sx = 0.6, sz = 0.5) => (i, rng) => ({
  target: { x: cx + (rng() * 2 - 1) * sx, z: cz + (rng() * 2 - 1) * sz },
  speedKmh: 60, spinRpm: { top: 600, side: 0 },
});
const feedAlt = (x, cz) => (i, rng) => ({ target: { x: (i % 2 ? -x : x) + (rng() - 0.5) * 0.6, z: cz + (rng() - 0.5) * 0.8 } });

export const DRILLS = [
  {
    id: 'fh-drive', name: 'Forehand Drive', es: 'Derecha', skill: 'Groundstrokes', level: 1, home: { x: 2.3, z: 7.8 }, reps: 20, interval: 3.2,
    feeds: feedAround(2.6, 6.0),
    targets: [zone('deep-cross', 'Deep cross', -5, 0, -9.5, -Z_SVC, 100), zone('line', 'Down the line', 0, 5, -9.5, -Z_SVC, 60)],
    cues: {
      intro: 'Turn early, meet the ball in front of your front hip, aim deep cross-court.',
      introEs: 'Gira pronto, golpea delante de la cadera y busca la diagonal profunda.',
      tips: ['Racket back as the ball crosses the net', 'Contact in front of your front hip', 'Low to high, finish over your shoulder'],
      tipsEs: ['Pala atrás cuando la bola pasa la red', 'Golpea delante de la cadera', 'De abajo arriba, termina sobre el hombro'],
    },
  },
  {
    id: 'bh-drive', name: 'Backhand Drive', es: 'Revés', skill: 'Groundstrokes', level: 1, home: { x: -2.3, z: 7.8 }, reps: 20, interval: 3.2,
    feeds: feedAround(-2.6, 6.0),
    targets: [zone('deep-cross', 'Deep cross', 0, 5, -9.5, -Z_SVC, 100), zone('line', 'Down the line', -5, 0, -9.5, -Z_SVC, 60)],
    cues: { intro: 'Shoulder turn, racket prepared early, contact in front, cross-court deep.', introEs: 'Gira los hombros, prepara pronto y golpea delante.', tips: ['Turn your shoulders before the bounce', 'Keep the racket face firm at contact', 'Finish toward the target'], tipsEs: ['Gira los hombros antes del bote', 'Cara de la pala firme', 'Termina hacia el objetivo'] },
  },
  {
    id: 'back-glass', name: 'Off the Back Glass', es: 'Salida de pared', skill: 'Walls', level: 2, home: { x: 2.0, z: 7.0 }, reps: 15, interval: 3.8,
    feeds: feedAround(1.8, 8.1, 1.2, 0.5),
    targets: [zone('deep', 'Deep', -5, 5, -9.5, -Z_SVC, 100)],
    cues: { intro: 'Let the ball come off the back glass, turn with it and hit on the way down, deep.', introEs: 'Deja que la bola salga de la pared, gira con ella y golpea en la caída.', tips: ['Let it come off the glass', 'Side-on, move with the ball', 'Hit as it drops, not as it rises'], tipsEs: ['Deja que salga de la pared', 'De perfil, acompaña la bola', 'Golpea en la caída'] },
  },
  {
    id: 'double-wall', name: 'Corner Exit', es: 'Doble pared', skill: 'Walls', level: 3, home: { x: 2.4, z: 7.0 }, reps: 15, interval: 4.0,
    feeds: feedAround(3.4, 8.4, 0.6, 0.4),
    targets: [zone('deep-cross', 'Deep cross', -5, 0, -9.5, -Z_SVC, 100)],
    cues: { intro: 'Back glass, then side glass: read the double bounce and wait for it in the corner.', introEs: 'Fondo y lateral: lee la doble pared y espérala en la esquina.', tips: ['Stay away from the corner', 'Wait for the second wall', 'Short swing, use its pace'], tipsEs: ['No te metas en la esquina', 'Espera la segunda pared', 'Swing corto'] },
  },
  {
    id: 'volleys', name: 'Net Volleys', es: 'Voleas', skill: 'Net', level: 1, home: { x: 1.6, z: 3.2 }, reps: 20, interval: 2.8,
    feeds: feedAlt(1.4, 2.4),
    targets: [zone('deep-l', 'Deep left', -5, -2.5, -9.5, -7, 100), zone('deep-r', 'Deep right', 2.5, 5, -9.5, -7, 100)],
    cues: { intro: 'Short punch in front of the body, firm wrist, aim for the deep corners.', introEs: 'Golpe corto delante del cuerpo, muñeca firme, a las esquinas.', tips: ['Racket up and in front', 'Punch, don\'t swing', 'Step toward the ball'], tipsEs: ['Pala arriba y delante', 'Bloquea, no hagas swing', 'Paso hacia la bola'] },
  },
  {
    id: 'bandeja', name: 'Bandeja', es: 'Bandeja', skill: 'Overheads', level: 2, home: { x: 1.6, z: 4.4 }, reps: 15, interval: 4.2,
    feeds: feedAround(1.4, 7.5, 1.0, 0.5),
    targets: [zone('deep', 'Deep', -5, 5, -9.5, -7, 100)],
    cues: { intro: 'Side-on under the lob, contact above and in front, slice it deep to keep the net.', introEs: 'De perfil bajo el globo, golpe arriba y delante, cortado y profundo.', tips: ['Turn side-on early', 'Contact in front of your head', 'Control over power'], tipsEs: ['Perfil pronto', 'Golpea delante de la cabeza', 'Control antes que potencia'] },
  },
  {
    id: 'vibora', name: 'Víbora', es: 'Víbora', skill: 'Overheads', level: 3, home: { x: 1.6, z: 4.4 }, reps: 15, interval: 4.2,
    feeds: feedAround(1.6, 7.0, 1.0, 0.5),
    targets: [zone('corner', 'Side glass', -5, -3, -9.5, -6.5, 120)],
    cues: { intro: 'Aggressive sidespin overhead into the far side-glass corner.', introEs: 'Remate con efecto lateral a la esquina de la pared.', tips: ['Contact at shoulder height, to the side', 'Brush across the ball', 'Aim for the side glass'], tipsEs: ['Golpea a la altura del hombro', 'Cepilla la bola', 'Apunta a la pared lateral'] },
  },
  {
    id: 'smash-x3', name: 'Smash Por Tres', es: 'Remate por tres', skill: 'Overheads', level: 3, home: { x: 1.2, z: 3.6 }, reps: 12, interval: 4.2,
    feeds: feedAround(1.0, 4.5, 1.0, 0.5),
    targets: [zone('svc', 'Service box', -5, 5, -Z_SVC, -2.5, 100)],
    cues: { intro: 'Get under the short lob, flat smash into the service area so it bounces out over the back wall.', introEs: 'Colócate bajo el globo corto y remata plano para sacarla por el fondo.', tips: ['Feet under the ball', 'Full extension, flat face', 'Aim between service line and net'], tipsEs: ['Pies bajo la bola', 'Brazo extendido, pala plana', 'Entre la línea de saque y la red'] },
  },
  {
    id: 'lob-defense', name: 'Defensive Lob', es: 'Globo', skill: 'Tactics', level: 2, home: { x: 1.8, z: 8.2 }, reps: 15, interval: 3.8, opponentsAtNet: true,
    feeds: feedAround(1.6, 7.8, 1.2, 0.6),
    targets: [zone('deep', 'Deep', -5, 5, -9.5, -7.5, 100)],
    cues: { intro: 'Opponents at the net: lift it high over them, apex above 4.5 m, landing deep.', introEs: 'Rivales en la red: globo alto, más de 4,5 m, profundo.', tips: ['Open the face', 'Long, slow swing upward', 'Height first, then depth'], tipsEs: ['Abre la pala', 'Swing largo y lento hacia arriba', 'Primero altura'] },
  },
  {
    id: 'chiquita', name: 'Chiquita', es: 'Chiquita', skill: 'Tactics', level: 2, home: { x: 2.0, z: 7.4 }, reps: 15, interval: 3.6, opponentsAtNet: true,
    feeds: feedAround(2.0, 6.4, 1.0, 0.5),
    targets: [zone('feet', 'At their feet', -5, 5, -4.5, -1.5, 100)],
    cues: { intro: 'Soft and low to the feet of the net players: under 45 km/h, just over the tape.', introEs: 'Suave y baja a los pies: menos de 45 km/h, rozando la red.', tips: ['Soft hands', 'Clear the net by a hand', 'Make them volley up'], tipsEs: ['Manos suaves', 'Un palmo sobre la red', 'Que volee hacia arriba'] },
  },
  {
    id: 'serve', name: 'Serve', es: 'Saque', skill: 'Serve', level: 1, home: { x: 2.0, z: 7.4 }, reps: 15, interval: 4.5,
    feeds: () => ({ target: { x: 2.0, z: 7.0 } }),
    targets: [zone('box', 'Service box', -5, 0, -Z_SVC, 0, 80), zone('deep', 'Near the line', -5, 0, -Z_SVC, -5.95, 120)],
    cues: { intro: 'Bounce it, hit at or below the hip, into the diagonal box, close to the service line.', introEs: 'Bota la bola, golpea bajo la cadera, a la diagonal y cerca de la línea.', tips: ['Contact below the hip', 'Aim deep in the box', 'Side glass after the bounce'], tipsEs: ['Golpea bajo la cadera', 'Profundo en el cuadro', 'Busca la pared lateral'] },
  },
  {
    id: 'return', name: 'Return of Serve', es: 'Resto', skill: 'Serve', level: 2, home: { x: 2.6, z: 8.6 }, reps: 15, interval: 4.2,
    feeds: feedAround(2.6, 5.4, 1.0, 0.8),
    targets: [zone('deep-cross', 'Deep cross', -5, 0, -9.5, -Z_SVC, 100)],
    cues: { intro: 'Read the serve off the bounce and return cross-court deep, or lob.', introEs: 'Lee el saque y resta cruzado y profundo, o globo.', tips: ['Split-step as they serve', 'Let it come off the side glass', 'Cross-court and deep'], tipsEs: ['Split-step al saque', 'Deja salir la lateral', 'Cruzado y profundo'] },
  },
  {
    id: 'live-mix', name: 'Live Ball Mix', es: 'Bola viva', skill: 'Tactics', level: 3, home: { x: 0.8, z: 7.4 }, reps: 24, interval: 3.8,
    feeds: (i, rng) => ({ target: { x: (rng() * 2 - 1) * 3.6, z: 3 + rng() * 5.4 } }),
    targets: [zone('deep', 'Deep', -5, 5, -9.5, -Z_SVC, 100)],
    cues: { intro: 'Random feeds from every drill. Recover to the middle after every shot.', introEs: 'Bolas de todos los ejercicios. Vuelve al centro tras cada golpe.', tips: ['Recover to the middle', 'Read early', 'Choose the safe shot'], tipsEs: ['Vuelve al centro', 'Lee pronto', 'Elige el golpe seguro'] },
  },
];

export const BESTS = {
  'fh-drive': { points: 1480, stars: 3 },
  'bh-drive': { points: 920, stars: 2 },
  'back-glass': { points: 610, stars: 1 },
  volleys: { points: 1210, stars: 2 },
  bandeja: { points: 540, stars: 1 },
  serve: { points: 1340, stars: 3 },
  chiquita: { points: 300, stars: 0 },
};

export const CAMERAS = [
  { deviceId: 'cont-1', label: 'Marta’s iPhone Camera', kind: 'continuity', presetKey: 'iphone-continuity' },
  { deviceId: 'builtin', label: 'FaceTime HD Camera', kind: 'builtin', presetKey: 'macbook-builtin' },
  { deviceId: 'usb-1', label: 'Logitech BRIO', kind: 'usb', presetKey: 'usb-webcam' },
];

export const SHOT = {
  id: 14, t: 41.2, by: 'player', stroke: 'forehand',
  contact: { x: 2.6, y: 0.92, z: 6.6 }, contactU: { x: 0.62, y: 0.92, z: 0.48 },
  racketSpeed: 19.2, speedIn: 17.1, speedOut: 22.4,
  spinRpm: { top: 1640, side: -210, total: 1653 },
  offCenter: 0.03, quality: 0.86, assist: 0.35, timing: 'good', spacing: 'cramped', netClearance: 0.42,
  predictedLanding: { x: -2.9, y: 0, z: -8.4 }, afterBounce: true, afterWall: false,
  points: 120, success: true, notes: ['Give yourself room – step away from the ball'],
};

export const HUD = {
  title: 'Forehand Drive', subtitle: 'Derecha · deep cross-court', repIndex: 7, repTotal: 20, points: 640, streak: 4, timer: null,
  score: null, lastShot: null, banner: null, prompt: null,
};

export const HUD_RALLY = {
  title: 'Rally with Coach', subtitle: 'Peloteo · Club', repIndex: 0, repTotal: 0, points: 2310, streak: 11, timer: 312,
  score: null, lastShot: null, banner: null, prompt: null,
};

export const HUD_MATCH = {
  title: 'Match', subtitle: 'Partido · Club', points: 0, streak: 3, timer: null,
  score: {
    points: ['40', '40'], games: [4, 3], sets: [[6, 4]], server: { team: 0, player: 0 }, box: 'left',
    flags: { goldenPoint: true, gamePoint: null, setPoint: null, matchPoint: null, tiebreak: false },
  },
  lastShot: null, banner: null, prompt: null,
};

export const SUMMARY = (() => {
  const landings = [];
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 20; i++) {
    const ok = rnd() < 0.68;
    const x = ok ? -4.6 + rnd() * 4.4 : -4.8 + rnd() * 9.8;
    const z = ok ? -9.4 + rnd() * 2.4 : -10.5 + rnd() * 6.5;
    landings.push({ x, z, success: ok && x <= 0 && z <= -6.95 && z >= -9.5 });
  }
  landings.push({ x: 1.2, z: 0.2, success: false });
  return {
    mode: 'drill',
    drill: DRILLS[0],
    targets: DRILLS[0].targets,
    points: 1560, stars: 3, best: 1480, newBest: true,
    reps: { made: 13, total: 20 },
    shots: 20,
    byStroke: {
      forehand: { count: 14, avgSpeedKmh: 74.2, avgSpinRpm: 1520, successRate: 0.71, avgQuality: 0.78 },
      'glass-fh': { count: 3, avgSpeedKmh: 61.0, avgSpinRpm: 980, successRate: 0.67, avgQuality: 0.62 },
      'volley-fh': { count: 2, avgSpeedKmh: 48.5, avgSpinRpm: 420, successRate: 0.5, avgQuality: 0.7 },
      lob: { count: 1, avgSpeedKmh: 41.0, avgSpinRpm: 1900, successRate: 0, avgQuality: 0.4 },
    },
    landings,
    longestStreak: 6, bestRally: 0, avgReactionMs: 412, prepOnTimeRate: 0.65, activeSeconds: 64, kcal: 9.1,
    tips: [
      { text: 'Racket back as the ball crosses the net — you were late on 6 of 20.', es: 'Pala atrás cuando la bola pasa la red' },
      { text: 'Give yourself room: step away so contact is 60 cm to your side.', es: 'Deja espacio: separa la bola del cuerpo' },
      { text: 'Great depth. Add a little topspin to bring long balls down.', es: 'Buena profundidad; más liftado' },
    ],
    nextDrill: { id: 'bh-drive', name: 'Backhand Drive', es: 'Revés' },
  };
})();

// ---- Synthetic pose (normalized, unmirrored image coords; "L" = person's left = image right).
export function poseLandmarks(t = 0, { cx = 0.5, swing = 0 } = {}) {
  const b = Math.sin(t * 2.2) * 0.004;
  const P = (x, y) => ({ x: cx + (x - 0.5), y: y + b, z: 0, visibility: 0.96 });
  const L = new Array(33).fill(null).map(() => P(0.5, 0.5));
  const set = (i, x, y) => { L[i] = P(x, y); };
  set(0, 0.5, 0.165); set(1, 0.508, 0.152); set(2, 0.512, 0.15); set(3, 0.517, 0.151);
  set(4, 0.492, 0.152); set(5, 0.488, 0.15); set(6, 0.483, 0.151); set(7, 0.527, 0.162); set(8, 0.473, 0.162);
  set(9, 0.508, 0.185); set(10, 0.492, 0.185);
  set(11, 0.56, 0.29); set(12, 0.44, 0.29);
  // Right arm (image left) prepared high for a forehand; left arm pointing forward.
  const s = swing;
  set(14, 0.375 - s * 0.02, 0.4 - s * 0.03); set(16, 0.335 + s * 0.05, 0.33 - s * 0.02);
  set(18, 0.322, 0.31); set(20, 0.33, 0.305); set(22, 0.343, 0.318);
  set(13, 0.605, 0.405); set(15, 0.585, 0.49); set(17, 0.588, 0.512); set(19, 0.582, 0.515); set(21, 0.578, 0.5);
  set(23, 0.537, 0.55); set(24, 0.463, 0.55);
  set(25, 0.565, 0.715); set(26, 0.435, 0.715);
  set(27, 0.58, 0.875); set(28, 0.42, 0.875);
  set(29, 0.575, 0.895); set(30, 0.425, 0.895); set(31, 0.6, 0.9); set(32, 0.4, 0.9);
  return L;
}

export function poseFrame(t = 0, opts) {
  return { t: t * 1000, width: 1280, height: 720, people: [{ landmarks: poseLandmarks(t, opts), world: [] }] };
}

/** A canvas that looks like a dim living-room webcam image with a person standing in it. */
export function fakeCameraCanvas(lm = poseLandmarks(0)) {
  const W = 1280, H = 720;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  // Back wall, floor, a doorway and a window glow.
  let gr = g.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, '#3a3f45');
  gr.addColorStop(0.62, '#2b2f34');
  gr.addColorStop(0.63, '#4a3d31');
  gr.addColorStop(1, '#2c241d');
  g.fillStyle = gr;
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#23272c';
  g.fillRect(930, 120, 170, 330);
  gr = g.createRadialGradient(220, 210, 10, 220, 210, 260);
  gr.addColorStop(0, 'rgba(255,236,200,0.55)');
  gr.addColorStop(1, 'rgba(255,236,200,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 600, 520);
  g.fillStyle = 'rgba(255,240,215,0.25)';
  g.fillRect(130, 120, 180, 210);
  // Person: thick soft limbs along the bones.
  const X = (i) => lm[i].x * W, Y = (i) => lm[i].y * H;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const limb = (a, b, w, col) => { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(X(a), Y(a)); g.lineTo(X(b), Y(b)); g.stroke(); };
  const shirt = '#1f3c66', skin = '#b88466', shorts = '#16191e';
  // Torso
  g.fillStyle = shirt;
  g.beginPath();
  g.moveTo(X(11) + 12, Y(11) - 6); g.lineTo(X(12) - 12, Y(12) - 6); g.lineTo(X(24) - 8, Y(24)); g.lineTo(X(23) + 8, Y(23));
  g.closePath();
  g.fill();
  limb(23, 25, 52, shorts); limb(24, 26, 52, shorts);
  limb(25, 27, 38, skin); limb(26, 28, 38, skin);
  limb(27, 31, 30, '#e9e6df'); limb(28, 32, 30, '#e9e6df');
  limb(11, 13, 36, shirt); limb(12, 14, 36, shirt);
  limb(13, 15, 28, skin); limb(14, 16, 28, skin);
  // Racket in the right hand.
  g.strokeStyle = '#111';
  g.lineWidth = 12;
  g.beginPath(); g.moveTo(X(16), Y(16)); g.lineTo(X(16) - 30, Y(16) - 70); g.stroke();
  g.fillStyle = '#d4552c';
  g.beginPath(); g.ellipse(X(16) - 44, Y(16) - 118, 42, 54, -0.4, 0, Math.PI * 2); g.fill();
  // Head
  g.fillStyle = skin;
  g.beginPath(); g.ellipse(X(0), Y(0), 34, 42, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#2a1d16';
  g.beginPath(); g.ellipse(X(0), Y(0) - 22, 36, 24, 0, Math.PI, 0); g.fill();
  // Camera noise + vignette.
  const img = g.getImageData(0, 0, W, H);
  let s = 3;
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const n = ((s >> 16) & 15) - 7;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  gr = g.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.75);
  gr.addColorStop(0, 'rgba(0,0,0,0)');
  gr.addColorStop(1, 'rgba(0,0,0,0.55)');
  g.fillStyle = gr;
  g.fillRect(0, 0, W, H);
  return c;
}

/** Procedural "night padel club photo" background: blurred perspective court, LED rows, glass. */
export function paintCourtBackdrop(canvas) {
  const W = canvas.width = innerWidth, H = canvas.height = innerHeight;
  const g = canvas.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#05070b');
  sky.addColorStop(0.45, '#0b1119');
  sky.addColorStop(0.46, '#101826');
  sky.addColorStop(1, '#060a12');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  g.filter = 'blur(6px)';
  for (let i = 0; i < 7; i++) {
    const x = W * (0.08 + i * 0.14);
    g.fillStyle = 'rgba(255,250,235,0.85)';
    g.fillRect(x, H * 0.07, W * 0.06, H * 0.012);
  }
  const hz = H * 0.46;
  g.beginPath();
  g.moveTo(W * 0.32, hz); g.lineTo(W * 0.68, hz); g.lineTo(W * 1.25, H); g.lineTo(-W * 0.25, H);
  g.closePath();
  const turf = g.createLinearGradient(0, hz, 0, H);
  turf.addColorStop(0, '#1f427c');
  turf.addColorStop(1, '#3a6cc0');
  g.fillStyle = turf;
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.8)';
  g.lineWidth = 4;
  g.beginPath(); g.moveTo(W * 0.5, hz + H * 0.06); g.lineTo(W * 0.5, H); g.stroke();
  g.beginPath(); g.moveTo(W * 0.22, hz + H * 0.16); g.lineTo(W * 0.78, hz + H * 0.16); g.stroke();
  g.fillStyle = 'rgba(160,220,230,0.08)';
  g.fillRect(W * 0.3, H * 0.22, W * 0.4, hz - H * 0.22);
  g.fillStyle = 'rgba(240,240,240,0.7)';
  g.fillRect(W * 0.26, hz + H * 0.055, W * 0.48, 4);
  g.filter = 'none';
}
