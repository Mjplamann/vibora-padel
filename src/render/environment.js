// The court and its venue. SPEC §6.3. Court frame: metres, Y up, net plane z = 0, interior
// x ∈ [-5, 5], z ∈ [-10, 10].
//
// The FIP court kit (turf, glass, mesh, steel, net, ball marks, training mannequins) is built once.
// Around it a swappable venue layer (src/render/venues/*) supplies the surroundings, the lights,
// the sky / hall, the image-based lighting capture, the colour grade and the crowd:
//   'club'    indoor premium club at night (three courts under LED panels)
//   'sunset'  outdoor Mediterranean court at golden hour (sky, sun, palms, sea)
//   'stadium' pro-tour show court (stands, instanced crowd, LED boards, TV lighting)
// buildEnvironment(scene, renderer, { quality, venue }) keeps the original API; env.setVenue(id)
// swaps the layer at run time; env.venue is the venue metadata the audio engine reads.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { COURT, netHeightAt } from '../config.js';
import { QUALITY } from './scene.js';
import {
  turfTextures, courtWearTexture, meshAlphaTexture, netAlphaTexture, softSpriteTexture, glassSmudgeTexture,
  TURF_TILE_M, MESH_TILE_M,
} from './textures.js';
import { boxAt, wallPlane, merge, instanced, NEIGHBOR_OFFSET } from './venues/common.js';
import { VEIL_GLSL, veilLightsChunk } from './venues/veil.js';
import { venueMeta, venueId } from './venues/meta.js';
import { buildClub } from './venues/club.js';
import { buildSunset } from './venues/sunset.js';
import { buildStadium } from './venues/stadium.js';
import { createIblCapture, requestHdri, hdriIfReady } from './ibl.js';
import { detailNormal, addTriplanarDetail } from './detailMaps.js';

export { VENUE_IDS, venueMeta } from './venues/meta.js';

const HW = COURT.halfWidth;
const HL = COURT.halfLength;
const GLASS_T = 0.012;
const GLASS_GAP = 0.006;
const POST = 0.09;
const POST_OFF = GLASS_T + POST / 2 + 0.004; // post centre distance outside the wall plane
const MESH_OFF = 0.006; // mesh sits in the glass mid-plane
const BAND_H = 0.06;

/** Court centres along x: main court plus neighbours (the right one first, see setVenue). */
export { NEIGHBOR_OFFSET };
export { VEIL_GLSL, veilLightsChunk };
export { HALL, LIGHT } from './venues/club.js';

const REFLECTIVE = ['glass', 'glassEdge', 'bolt', 'steel'];
const REFLECT_INTENSITY = { glass: 1.5, glassEdge: 1.0, bolt: 0.8, steel: 0.45 };
const VENUE_BUILDERS = { club: buildClub, sunset: buildSunset, stadium: buildStadium };
/** Output tone mapping per venue (venues/meta.js toneMapping). */
export const TONE_MAPPINGS = { aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping };

/**
 * Starts loading a venue's panorama (render/ibl.js) before the environment is built, so the first
 * capture already includes it. Resolves true when loaded, false on failure or after `timeoutMs`.
 */
export function preloadVenueIbl(id, timeoutMs = 4000) {
  const name = venueMeta(id).hdri;
  if (!name) return Promise.resolve(false);
  return Promise.race([
    requestHdri(name).then(() => true, () => false),
    new Promise((ok) => setTimeout(() => ok(false), timeoutMs)),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Materials

/**
 * Glass: specular reflections at full strength (Fresnel from the physical BRDF: ~4 % head-on,
 * mirror-like at grazing angles), body tint scaled by opacity (premultiplied). Smudges (finger
 * grease, wipe arcs, felt marks, water spots) scatter light and blur the reflection locally.
 */
function makeGlassMaterial() {
  const smudge = glassSmudgeTexture();
  const uniforms = {
    uSmudge: { value: smudge },
    uSmudgeK: { value: new THREE.Vector4(1, 1, 0, 0) }, // grease, felt, water, unused
    // Round 6: box-projected (parallax-corrected) reflections: the reflection ray is intersected with
    // the venue's interior box and looked up from the capture point, so the hall's lights and walls
    // sit where they really are in the glass and slide correctly as the player moves.
    uBoxMin: { value: new THREE.Vector3(-21, -0.5, -15.5) },
    uBoxMax: { value: new THREE.Vector3(21, 11, 15.5) },
    uProbe: { value: new THREE.Vector3(0, 2.2, 0) },
    uBoxOn: { value: 0 },
  };
  const boxChunk = THREE.ShaderChunk.envmap_physical_pars_fragment.replace(
    'reflectVec = transformDirectionByInverseViewMatrix( reflectVec, viewMatrix );',
    'reflectVec = transformDirectionByInverseViewMatrix( reflectVec, viewMatrix );\n\t\t\treflectVec = glassBoxProject( vGlassW, reflectVec );',
  );
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xd6ece4,
    roughness: 0.04,
    metalness: 0,
    ior: 1.52,
    specularIntensity: 1,
    transparent: true,
    opacity: 0.1,
    premultipliedAlpha: true,
    depthWrite: false,
    envMapIntensity: 1.5,
    side: THREE.FrontSide,
  });
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGlassW;\nvarying vec3 vGlassN;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vGlassW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vGlassN = normalize(mat3(modelMatrix) * objectNormal);
        #ifdef USE_INSTANCING
        vGlassW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vGlassW;
        varying vec3 vGlassN;
        uniform sampler2D uSmudge;
        uniform vec4 uSmudgeK;
        uniform vec3 uBoxMin, uBoxMax, uProbe;
        uniform float uBoxOn;
        vec4 gSm = vec4(0.0);
        vec3 glassBoxProject(vec3 p, vec3 r) {
          if (uBoxOn < 0.5) return r;
          vec3 rr = vec3(abs(r.x) < 1e-4 ? 1e-4 : r.x, abs(r.y) < 1e-4 ? 1e-4 : r.y, abs(r.z) < 1e-4 ? 1e-4 : r.z);
          vec3 t = mix((uBoxMin - p) / rr, (uBoxMax - p) / rr, step(0.0, rr));
          float d = max(0.0, min(min(t.x, t.y), t.z));
          return normalize(p + r * d - uProbe);
        }`)
      .replace('#include <envmap_physical_pars_fragment>', boxChunk)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        {
          // Panel-space smudge lookup: lateral coordinate along the wall, height; each 2 m panel
          // gets its own offset so neighbouring panes never repeat.
          float side = step(0.5, abs(vGlassN.x));
          float lat = mix(vGlassW.x, vGlassW.z, side) + 1.0 - side; // panel joints at even values
          float pid = floor(lat * 0.5) + side * 7.0 + step(0.0, mix(vGlassW.z, vGlassW.x, side)) * 13.0 + floor(vGlassW.x / 13.0 + 0.5) * 29.0;
          vec2 ofs = fract(vec2(sin(pid * 12.9898) * 43758.5, sin(pid * 78.233) * 12345.7));
          float u = fract(lat * 0.5);
          u = mix(u, 1.0 - u, step(0.5, ofs.y));
          vec2 suv = vec2((u + step(0.5, ofs.x)) * 0.5, clamp(vGlassW.y / 3.0, 0.0, 1.0));
          gSm = texture2D(uSmudge, suv) * vec4(uSmudgeK.xyz, 1.0);
          float smear = clamp(gSm.r * 0.9 + gSm.g * 0.6 + gSm.b * 0.5, 0.0, 1.0);
          // Round 6: smears haze the reflection but stay glassy (0.32 spread one floodlight's glint
          // into a blown-out patch across a whole panel).
          roughnessFactor = mix(roughnessFactor, 0.15, smear);
        }`)
      .replace('#include <opaque_fragment>', `
        // Sand dust film near the bottom of the panels and faint haze overall.
        float dust = smoothstep(0.45, 0.0, vGlassW.y) * 0.16;
        // Faint grime / ball-felt haze where balls usually strike (0.4–2.2 m), broken up by noise.
        vec2 gp = vec2(vGlassW.x + vGlassW.z, vGlassW.y) * 2.3;
        vec2 gi = floor(gp), gf = fract(gp);
        gf = gf * gf * (3.0 - 2.0 * gf);
        float h00 = fract(sin(dot(gi, vec2(127.1, 311.7))) * 43758.5);
        float h10 = fract(sin(dot(gi + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5);
        float h01 = fract(sin(dot(gi + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5);
        float h11 = fract(sin(dot(gi + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5);
        float gn = mix(mix(h00, h10, gf.x), mix(h01, h11, gf.x), gf.y);
        dust += smoothstep(0.55, 1.0, gn) * smoothstep(0.3, 0.8, vGlassW.y) * smoothstep(2.4, 1.6, vGlassW.y) * 0.05;
        // Smudges catch the light (forward scattering): lit grey for grease, yellow-grey for felt.
        vec3 irr = totalDiffuse / max(diffuseColor.rgb, vec3(0.05));
        float smA = gSm.r * 0.05 + gSm.g * 0.07 + gSm.b * 0.035;
        vec3 smCol = irr * (vec3(0.55) * gSm.r + vec3(0.62, 0.62, 0.42) * gSm.g + vec3(0.6) * gSm.b) / max(gSm.r + gSm.g + gSm.b, 1e-3);
        float a = clamp(diffuseColor.a + dust + smA, 0.0, 1.0);
        vec3 dustCol = vec3(0.32, 0.31, 0.28) * (totalDiffuse + 0.08);
        gl_FragColor = vec4(totalDiffuse * diffuseColor.a * 0.3 + dustCol * dust + smCol * smA * 0.9 + totalSpecular + totalEmissiveRadiance, a);`)
      .replace('#include <premultiplied_alpha_fragment>', '');
  };
  m.customProgramCacheKey = () => 'vibora-glass-3';
  return m;
}

/**
 * Sand-filled artificial turf. Fibres lean with the grain (lighter looking along it, darker into
 * it), sand shows between the tufts and drifts against the walls, contact occlusion where the
 * glass meets the floor, and (outdoors) the analytic shadow of the glass / mesh / net.
 * Round 6: the fibre maps are read with a small LOD bias (the 9.5 mm tuft rows beat against the
 * pixel grid at standing distance), the polyethylene fibres get a broader, brighter sheen toward
 * the lights, and `shell: true` builds the near-field pile layers (turfShells below) that share
 * every uniform with the carpet.
 */
const TURF_SHELL_H = 0.0105; // free pile above the sand (m) covered by the shells
function makeTurfMaterial(renderer, q, { shell = false, uniforms: shared = null } = {}) {
  const tt = turfTextures(renderer, { size: q.turfSize });
  const reps = new THREE.Vector2((HW * 2) / TURF_TILE_M, (HL * 2) / TURF_TILE_M);
  for (const t of [tt.map, tt.normalMap, tt.roughnessMap]) t.repeat.copy(reps);
  const wear = courtWearTexture();
  const m = new THREE.MeshPhysicalMaterial({
    map: tt.map,
    normalMap: tt.normalMap,
    normalScale: new THREE.Vector2(0.9, 0.9),
    roughnessMap: tt.roughnessMap,
    roughness: 1,
    metalness: 0,
    specularIntensity: 0.75,
    sheen: shell ? 0 : 0.24,
    sheenColor: new THREE.Color(0.34, 0.5, 0.82),
    sheenRoughness: 0.55,
    envMapIntensity: 0.45,
  });
  if (shell) {
    m.transparent = true;
    m.depthWrite = false;
  }
  const uniforms = shared || {
    uWear: { value: wear },
    uLineHalf: { value: COURT.lineWidth / 2 },
    uService: { value: COURT.serviceLine - COURT.lineWidth / 2 },
    uCenterEnd: { value: COURT.serviceLine + COURT.centerLineOverrun },
    uSun: { value: new THREE.Vector4(0, 1, 0, 0) },
    // x: dust (outdoor sand film), y: wear scale, z: grain sheen, w: contact occlusion strength
    uTurfK: { value: new THREE.Vector4(0, 1, 0.1, 1) },
    uTurfTint: { value: new THREE.Color(1, 1, 1) },
    uTurfBias: { value: 0.7 },
    uShellFade: { value: new THREE.Vector2(2.4, 3.4) },
  };
  m.userData.uniforms = uniforms;
  const biased = (chunk, tex, uv) => THREE.ShaderChunk[chunk].replace(`texture2D( ${tex}, ${uv} )`, `texture2D( ${tex}, ${uv}, uTurfBias )`);
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vCourt;\nvarying vec3 vTurfW;\n${shell ? 'varying float vShellL;' : ''}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCourt = position.xz;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vTurfW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #ifdef USE_INSTANCING
        vTurfW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #endif
        ${shell ? `
        // Shells follow the camera: court coordinates and texture coordinates from the world position
        // (the carpet's own mapping: u = x + 5, v = 10 - z, one tile per TURF_TILE_M).
        vCourt = vTurfW.xz;
        vec2 tuv = vec2(vTurfW.x + ${HW.toFixed(1)}, ${HL.toFixed(1)} - vTurfW.z) / ${TURF_TILE_M.toFixed(3)};
        vMapUv = tuv;
        vNormalMapUv = tuv;
        vRoughnessMapUv = tuv;
        vShellL = instanceMatrix[3].y / ${TURF_SHELL_H.toFixed(4)};` : ''}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vCourt;
        varying vec3 vTurfW;
        ${shell ? 'varying float vShellL;\nuniform vec2 uShellFade;' : ''}
        uniform sampler2D uWear;
        uniform float uLineHalf, uService, uCenterEnd, uTurfBias;
        uniform vec4 uTurfK;
        uniform vec3 uTurfTint;
        ${VEIL_GLSL}
        float gLine = 0.0;
        float gWear = 0.0;
        float gAO = 1.0;
        vec3 gSunVeil = vec3(1.0);
        float boxCov(float d, float h, float f) {
          return clamp((min(d + 0.5 * f, h) - max(d - 0.5 * f, -h)) / f, 0.0, 1.0);
        }`)
      .replace('#include <map_fragment>', `
        vec4 texel = texture2D(map, vMapUv, uTurfBias);
        vec4 rmS = texture2D(roughnessMap, vRoughnessMapUv, uTurfBias);
        float sandMask = rmS.r;
        vec4 wearS = texture2D(uWear, vec2((vCourt.x + 5.0) / 10.0, (vCourt.y + 10.0) / 20.0));
        float wear = wearS.r * uTurfK.y;
        float loose = wearS.g;
        float rollVar = wearS.b - 0.5;
        gWear = wear;
        vec3 fib = texel.rgb * uTurfTint * (1.0 + rollVar * 1.6);
        // Grain: fibres lean toward -z; looking along the lean shows their lit sides (lighter,
        // bluer), looking into it shows tips and sand (darker). Stronger at grazing angles.
        vec3 Vw = normalize(cameraPosition - vTurfW);
        float graze = 1.0 - clamp(Vw.y, 0.0, 1.0);
        float rollSign = mod(floor((vCourt.x + 5.0) / 4.0), 2.0) * 2.0 - 1.0;
        float along = -Vw.z * (0.75 + 0.25 * rollSign);
        fib *= 1.0 + uTurfK.z * along * graze * graze;
        float lum = dot(fib, vec3(0.2126, 0.7152, 0.0722));
        // Flattened fibres in worn zones read lighter and greyer; more sand shows through.
        vec3 flatCol = mix(fib, vec3(lum) * vec3(0.9, 1.0, 1.25) * 1.35, 0.45);
        vec3 col = mix(fib, flatCol, wear * 0.7);
        vec3 sandCol = vec3(0.25, 0.24, 0.215);
        col = mix(col, sandCol * (0.85 + 0.3 * lum / 0.06), clamp(wear * 0.16 * (1.0 - sandMask) + loose * 0.6, 0.0, 0.85));
        // Outdoors: a film of wind-blown sand and dust over the whole carpet.
        col = mix(col, sandCol * 1.25, uTurfK.x * (0.12 + 0.3 * sandMask + 0.25 * loose));
        // Playing lines: inlaid white turf, exact 5 cm, box-filtered against the pixel footprint.
        float fz = max(fwidth(vCourt.y), 1e-4);
        float fx = max(fwidth(vCourt.x), 1e-4);
        float edgeNoise = (lum - 0.05) * 0.06 * (1.0 - smoothstep(0.004, 0.02, fz));
        float az = abs(vCourt.y);
        float svc = boxCov(az - uService + edgeNoise, uLineHalf, fz);
        float ctr = boxCov(vCourt.x + edgeNoise, uLineHalf, fx) * boxCov(az, uCenterEnd, fz);
        gLine = max(svc, ctr);
        vec3 lineCol = vec3(0.74, 0.76, 0.78) * clamp(0.55 + lum * 7.0, 0.6, 1.25);
        lineCol = mix(lineCol, sandCol * 1.6, sandMask * 0.55 + loose * 0.4 + uTurfK.x * 0.25);
        col = mix(col, lineCol, gLine);
        diffuseColor.rgb *= col;
        // Contact occlusion: the glass / mesh base, the corners, the net's bottom cord.
        float dW = min(5.0 - abs(vCourt.x), 10.0 - az);
        float cxq = 5.0 - abs(vCourt.x), czq = 10.0 - az;
        float corner = exp(-(cxq * cxq + czq * czq) / 0.35);
        float ao = 1.0 - 0.32 * exp(-dW / 0.09) - 0.12 * exp(-dW / 0.55) - 0.18 * corner;
        ao *= 1.0 - 0.28 * exp(-az / 0.05) * step(abs(vCourt.x), 5.0);
        gAO = mix(1.0, clamp(ao, 0.0, 1.0), uTurfK.w);
        gSunVeil = uSun.w > 0.5 ? enclosureVeil(vec3(vCourt.x, 0.0, vCourt.y), uSun.xyz) : vec3(1.0);
        ${shell ? `
        {
          // Pile shells: a fibre is present at this layer where the pile height reaches it; tips
          // catch more light than the shaded lower pile. Faded out with distance and at the walls.
          float ph = texture2D(roughnessMap, vRoughnessMapUv, 0.35).b;
          float th = 0.3 + 0.6 * vShellL;
          float a = smoothstep(th - 0.06, th + 0.06, ph);
          float dc = length(vTurfW.xz - cameraPosition.xz);
          a *= 1.0 - smoothstep(uShellFade.x, uShellFade.y, dc);
          a *= step(abs(vCourt.x), 4.97) * step(az, 9.97) * (1.0 - smoothstep(0.0, 0.03, -dW));
          if (a < 0.02) discard;
          diffuseColor.rgb *= mix(0.88, 1.08, vShellL);
          diffuseColor.a = a;
        }` : ''}`)
      .replace('#include <roughnessmap_fragment>', `${biased('roughnessmap_fragment', 'roughnessMap', 'vRoughnessMapUv')}
        roughnessFactor = mix(roughnessFactor, 0.93, clamp(gWear * 0.3, 0.0, 1.0));
        // Round 6: the white line fibres are a denser, glossier yarn than the blue pile (a soft
        // painted sheen toward the lights), dulled where sand sits on them.
        roughnessFactor = mix(roughnessFactor, 0.6 + 0.25 * uTurfK.x, gLine);`)
      .replace('#include <normal_fragment_maps>', `${biased('normal_fragment_maps', 'normalMap', 'vNormalMapUv')}
        normal = normalize(mix(normal, nonPerturbedNormal, clamp(gWear * 0.55, 0.0, 0.8)));`)
      .replace('#include <lights_fragment_begin>', veilLightsChunk())
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= gAO;
        reflectedLight.directDiffuse *= mix(1.0, gAO, 0.55);`);
  };
  m.customProgramCacheKey = () => (shell ? 'vibora-turf-shell-3' : 'vibora-turf-3');
  return m;
}

/**
 * Near-field pile: a few alpha-blended shell layers (3 / 6 / 9 mm…) of the same carpet on a disc
 * that follows the camera, so the fibres near the player have real parallax as the view moves
 * (classic shell texturing). One instanced draw, no depth write (decals and the ball's contact
 * shadow on the turf stay on top), faded out beyond ~3 m where the pile is sub-pixel.
 */
function createTurfShells(mats, layers) {
  const MAX = 4;
  const geo = new THREE.CircleGeometry(3.6, 40);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.InstancedMesh(geo, mats.turfShell, MAX);
  const m4 = new THREE.Matrix4();
  const setLayers = (n) => {
    const k = Math.max(0, Math.min(MAX, n | 0));
    for (let i = 0; i < k; i++) mesh.setMatrixAt(i, m4.makeTranslation(0, (TURF_SHELL_H * (i + 1)) / k, 0));
    mesh.count = k;
    mesh.visible = k > 0;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.layers = k;
  };
  setLayers(layers);
  // scene.js applySceneTier: the tier's shell count, live.
  mats.turfShell.userData.onTier = (q) => {
    if ((q.turfShells ?? 0) !== mesh.userData.layers) setLayers(q.turfShells ?? 0);
  };
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.renderOrder = -1;
  mesh.name = 'turf-shells';
  mesh.onBeforeRender = (r, s, camera) => {
    const e = camera.matrixWorld.elements;
    if (Number.isFinite(e[12]) && Number.isFinite(e[14])) {
      mesh.position.set(e[12], 0, e[14]);
      mesh.updateMatrixWorld();
    }
  };
  return mesh;
}

function makeMaterials(renderer, q) {
  const a2c = q.msaa > 0;
  const meshAlpha = meshAlphaTexture();
  const netAlpha = netAlphaTexture();
  const m = {
    // Black polyester powder coat: semi-gloss with a fine orange-peel texture (triplanar detail
    // normal below) that breaks up the reflections of the lights along the posts.
    steel: new THREE.MeshStandardMaterial({ color: 0x0d0e10, roughness: 0.4, metalness: 0.0, envMapIntensity: 1.2 }),
    glass: makeGlassMaterial(),
    glassEdge: new THREE.MeshStandardMaterial({
      color: 0x78b8a2, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.3, depthWrite: false, envMapIntensity: 1.4,
    }),
    bolt: new THREE.MeshStandardMaterial({ color: 0xc9ced3, roughness: 0.22, metalness: 1.0 }),
    mesh: new THREE.MeshStandardMaterial({
      color: 0x111214, roughness: 0.5, metalness: 0.0, alphaMap: meshAlpha, side: THREE.DoubleSide,
      alphaToCoverage: a2c, transparent: !a2c, depthWrite: a2c, envMapIntensity: 1.0,
    }),
    net: new THREE.MeshStandardMaterial({
      color: 0x0c0d0f, roughness: 0.85, alphaMap: netAlpha, side: THREE.DoubleSide,
      alphaToCoverage: a2c, transparent: !a2c, depthWrite: a2c,
    }),
    netStatic: null,
    band: new THREE.MeshStandardMaterial({ color: 0xf1f1ec, roughness: 0.8 }),
    turf: makeTurfMaterial(renderer, q),
    turfShell: null,
    dummy: new THREE.MeshStandardMaterial({ color: 0x1c2b4a, roughness: 0.7 }),
    dummyStripe: new THREE.MeshStandardMaterial({ color: 0xd9f03a, roughness: 0.5, emissive: 0x2a3008 }),
  };
  m.netStatic = m.net.clone();
  addTriplanarDetail(m.steel, detailNormal('orange-peel-normal'), { scale: 14, strength: 0.16, key: 'peel' });
  m.turfShell = makeTurfMaterial(renderer, q, { shell: true, uniforms: m.turf.userData.uniforms });
  m.turfShell.alphaToCoverage = false;
  // Wire materials use alpha-to-coverage under MSAA, alpha blending otherwise (scene.setQuality flips it).
  for (const w of [m.mesh, m.net, m.netStatic]) w.userData.alphaMode = 'coverage-or-blend';
  return m;
}

// ---------------------------------------------------------------------------------------------
// Court enclosure (court-local; instanced for the neighbours)

function sideBands() {
  const out = [];
  for (const b of COURT.sideWall) {
    out.push({ z0: b.zMin, z1: b.zMax, glassTop: b.glassTop, meshTop: b.meshTop });
    out.push({ z0: -b.zMax, z1: -b.zMin, glassTop: b.glassTop, meshTop: b.meshTop });
  }
  return out;
}

/** Steel tube with rounded edges (r 6 mm): the edges catch a line of light as real posts do. */
function tubeAt(w, h, d, x, y, z) {
  const g = new RoundedBoxGeometry(w, h, d, 1, Math.min(0.006, Math.min(w, d) * 0.3));
  g.translate(x, y, z);
  return g;
}

function buildEnclosureGeometry() {
  const steel = [], glass = [], edges = [], bolts = [], mesh = [];
  const glassPanels = [], meshPanels = [];
  const boltGeo = new THREE.CylinderGeometry(0.021, 0.021, 0.01, 14);

  const addGlass = (wall, sideSign, a0, a1, h) => {
    const w = a1 - a0 - GLASS_GAP;
    const c = (a0 + a1) / 2;
    const off = sideSign * (wall === 'back' ? HL : HW) + sideSign * GLASS_T / 2;
    const edgeS = 0.0125;
    if (wall === 'back') {
      glass.push(boxAt(w, h, GLASS_T, c, h / 2, off));
      edges.push(boxAt(w, edgeS, edgeS, c, h - edgeS / 2, off));
      edges.push(boxAt(edgeS, h, edgeS, c - w / 2 + edgeS / 2, h / 2, off));
      edges.push(boxAt(edgeS, h, edgeS, c + w / 2 - edgeS / 2, h / 2, off));
    } else {
      glass.push(boxAt(GLASS_T, h, w, off, h / 2, c));
      edges.push(boxAt(edgeS, edgeS, w, off, h - edgeS / 2, c));
      edges.push(boxAt(edgeS, h, edgeS, off, h / 2, c - w / 2 + edgeS / 2));
      edges.push(boxAt(edgeS, h, edgeS, off, h / 2, c + w / 2 - edgeS / 2));
    }
    // Countersunk fixing bolts on the court face.
    const inner = sideSign * (wall === 'back' ? HL : HW) - sideSign * 0.004;
    for (const da of [-w / 2 + 0.11, w / 2 - 0.11]) {
      for (const y of [0.32, h - 0.32]) {
        const g = boltGeo.clone();
        if (wall === 'back') {
          g.rotateX(Math.PI / 2);
          g.translate(c + da, y, inner);
        } else {
          g.rotateZ(Math.PI / 2);
          g.translate(inner, y, c + da);
        }
        bolts.push(g);
      }
    }
    const normal = wall === 'back' ? new THREE.Vector3(0, 0, -sideSign) : new THREE.Vector3(-sideSign, 0, 0);
    const center = wall === 'back' ? new THREE.Vector3(c, h / 2, sideSign * HL) : new THREE.Vector3(sideSign * HW, h / 2, c);
    glassPanels.push({
      wall, side: (wall === 'back' ? sideSign : c) > 0 ? 'near' : 'far', center, normal, width: w, height: h,
      a0, a1, y0: 0, y1: h,
    });
  };

  const addMesh = (wall, sideSign, a0, a1, y0, y1) => {
    const plane = sideSign * ((wall === 'back' ? HL : HW) + MESH_OFF);
    const g = wallPlane(wall === 'back' ? 'x' : 'z', a0, a1, y0, y1, plane, MESH_TILE_M, -sideSign);
    mesh.push(g);
    // Frame: 35 mm tube around the panel.
    const t = 0.035, w = a1 - a0, h = y1 - y0, c = (a0 + a1) / 2, fo = plane + sideSign * 0.02;
    if (wall === 'back') {
      steel.push(boxAt(w, t, t, c, y0 + t / 2, fo), boxAt(w, t, t, c, y1 - t / 2, fo));
      steel.push(boxAt(t, h, t, a0 + t / 2, (y0 + y1) / 2, fo), boxAt(t, h, t, a1 - t / 2, (y0 + y1) / 2, fo));
    } else {
      steel.push(boxAt(t, t, w, fo, y0 + t / 2, c), boxAt(t, t, w, fo, y1 - t / 2, c));
      steel.push(boxAt(t, h, t, fo, (y0 + y1) / 2, a0 + t / 2), boxAt(t, h, t, fo, (y0 + y1) / 2, a1 - t / 2));
    }
    const normal = wall === 'back' ? new THREE.Vector3(0, 0, -sideSign) : new THREE.Vector3(-sideSign, 0, 0);
    const center = wall === 'back' ? new THREE.Vector3(c, (y0 + y1) / 2, sideSign * HL) : new THREE.Vector3(sideSign * HW, (y0 + y1) / 2, c);
    meshPanels.push({ wall, side: (wall === 'back' ? sideSign : c) > 0 ? 'near' : 'far', center, normal, width: w, height: h, a0, a1, y0, y1 });
  };

  for (const s of [-1, 1]) {
    for (let x = -HW; x < HW - 1e-6; x += COURT.postSpacing) {
      addGlass('back', s, x, x + 2, COURT.backWall.glassTop);
      addMesh('back', s, x, x + 2, COURT.backWall.glassTop, COURT.backWall.meshTop);
    }
    for (let x = -HW; x <= HW + 1e-6; x += COURT.postSpacing) {
      steel.push(tubeAt(POST, COURT.backWall.meshTop, POST, x, COURT.backWall.meshTop / 2, s * (HL + POST_OFF)));
    }
    steel.push(tubeAt(HW * 2 + POST, 0.06, 0.06, 0, COURT.backWall.meshTop - 0.03, s * (HL + POST_OFF)));
    steel.push(tubeAt(HW * 2, 0.05, 0.05, 0, COURT.backWall.glassTop + 0.025, s * (HL + POST_OFF - 0.02)));
  }
  for (const sx of [-1, 1]) {
    for (const b of sideBands()) {
      for (let z = b.z0; z < b.z1 - 1e-6; z += COURT.postSpacing) {
        if (b.glassTop > 0) addGlass('side', sx, z, z + 2, b.glassTop);
        addMesh('side', sx, z, z + 2, b.glassTop, b.meshTop);
      }
      const railZ = (b.z0 + b.z1) / 2;
      steel.push(tubeAt(0.06, 0.06, b.z1 - b.z0, sx * (HW + POST_OFF), b.meshTop - 0.03, railZ));
      if (b.glassTop > 0) steel.push(tubeAt(0.05, 0.05, b.z1 - b.z0, sx * (HW + POST_OFF - 0.02), b.glassTop + 0.025, railZ));
    }
    for (let z = -HL + COURT.postSpacing; z <= HL - COURT.postSpacing + 1e-6; z += COURT.postSpacing) {
      const az = Math.abs(z);
      const h = az >= 8 - 1e-6 ? 4 : 3;
      steel.push(tubeAt(POST, h, POST, sx * (HW + POST_OFF), h / 2, z));
      // Base plates bolted to the slab.
      steel.push(boxAt(0.2, 0.012, 0.2, sx * (HW + POST_OFF), 0.006, z));
    }
    steel.push(boxAt(0.07, netHeightAt(HW) + 0.05, 0.07, sx * (HW - 0.035), (netHeightAt(HW) + 0.05) / 2, 0));
  }
  boltGeo.dispose();
  return {
    steel: merge(steel), glass: merge(glass), edges: merge(edges), bolts: merge(bolts), mesh: merge(mesh), glassPanels, meshPanels,
  };
}

// ---------------------------------------------------------------------------------------------
// Net (main court gets the shake shader)

function buildNetGeometry() {
  const segX = 100, segY = 10;
  const g = new THREE.PlaneGeometry(HW * 2, 1, segX, segY);
  const pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const t = pos.getY(i) + 0.5;
    const top = netHeightAt(x) - BAND_H * 0.6;
    const y = 0.02 + (top - 0.02) * t;
    pos.setY(i, y);
    uv.setXY(i, x / 1.0, y / 1.0);
  }
  g.computeVertexNormals();
  return g;
}

function buildBandGeometry() {
  const parts = [];
  for (const s of [-1, 1]) {
    const rise = COURT.net.postHeight - COURT.net.centerHeight;
    const len = Math.hypot(HW, rise);
    const g = new THREE.BoxGeometry(len, BAND_H, 0.012, 60, 1, 1);
    g.translate(0, -BAND_H / 2, 0);
    g.rotateZ(Math.atan2(rise, HW) * s);
    g.translate((s * HW) / 2, (COURT.net.centerHeight + COURT.net.postHeight) / 2, 0);
    parts.push(g);
  }
  parts.push(boxAt(HW * 2, 0.012, 0.012, 0, 0.02, 0));
  return merge(parts);
}

function createNet(mats) {
  const group = new THREE.Group();
  group.name = 'vibora-net';
  const shake = { value: new THREE.Vector4(0, 0, 99, 0) }; // x0, amplitude, time since hit, unused
  const inject = (mat, profileExpr) => {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uShake = shake;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform vec4 uShake;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          {
            float dx = abs(position.x - uShake.x);
            float t = uShake.z;
            float env = exp(-dx / 1.4) * exp(-t * 2.8);
            float wave = sin(t * 24.0 - dx * 4.5) + 0.35 * sin(t * 41.0 - dx * 9.0);
            float prof = ${profileExpr};
            transformed.z += uShake.y * env * wave * prof;
          }`);
    };
    mat.customProgramCacheKey = () => `vibora-net-${profileExpr.length}`;
  };
  const netMat = mats.net;
  const bandMat = mats.band.clone();
  inject(netMat, 'sin(clamp(position.y / 0.9, 0.0, 1.0) * 3.14159) * 0.9 + 0.1');
  inject(bandMat, '0.35');
  const mesh = new THREE.Mesh(buildNetGeometry(), netMat);
  mesh.name = 'vibora-net-mesh';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const band = new THREE.Mesh(buildBandGeometry(), bandMat);
  band.name = 'vibora-net-band';
  band.castShadow = true;
  band.receiveShadow = true;
  group.add(mesh, band);

  const api = {
    group,
    mesh,
    band,
    heightAt: netHeightAt,
    /** Excite the net at lateral position x with an impact of `speed` m/s. */
    shake(x, speed = 5) {
      const amp = Math.min(0.11, 0.004 + Math.abs(speed) * 0.006);
      const cur = shake.value;
      const curAmp = cur.y * Math.exp(-cur.z * 2.8);
      if (amp >= curAmp * 0.8) cur.set(THREE.MathUtils.clamp(x, -HW, HW), amp, 0, 0);
    },
    update(dt) {
      shake.value.z = Math.min(99, shake.value.z + dt);
    },
  };
  group.userData.netApi = api;
  return api;
}

// ---------------------------------------------------------------------------------------------
// Ball marks (pooled felt smudges that fade over 20 s)

function createBallMarks(root, count = 24) {
  const tex = softSpriteTexture({ size: 64, hardness: 0.35 });
  const geo = new THREE.PlaneGeometry(1, 1);
  const pool = [];
  for (let i = 0; i < count; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xd5dabd, map: tex, transparent: true, opacity: 0, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const m = new THREE.Mesh(geo, mat);
    m.visible = false;
    m.renderOrder = 3;
    m.userData.age = Infinity;
    root.add(m);
    pool.push(m);
  }
  let next = 0;
  const tmp = new THREE.Vector3();
  const LIFE = 20;
  return {
    add(pos, normal) {
      const m = pool[next];
      next = (next + 1) % pool.length;
      const n = tmp.set(normal?.x ?? 0, normal?.y ?? 1, normal?.z ?? 0).normalize();
      m.position.set(pos.x + n.x * 0.004, pos.y + n.y * 0.004, pos.z + n.z * 0.004);
      m.lookAt(m.position.x + n.x, m.position.y + n.y, m.position.z + n.z);
      m.rotateZ(Math.random() * Math.PI * 2);
      const s = 0.075 + Math.random() * 0.02;
      m.scale.set(s * (1 + Math.random() * 0.25), s, 1);
      m.userData.age = 0;
      m.material.opacity = 0.4;
      m.visible = true;
    },
    update(dt) {
      for (const m of pool) {
        if (!m.visible) continue;
        m.userData.age += dt;
        const k = 1 - m.userData.age / LIFE;
        if (k <= 0) {
          m.visible = false;
          continue;
        }
        m.material.opacity = 0.4 * k * k;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Training mannequins standing at the far net (for drills with opponentsAtNet)

function buildOpponents(root, mats) {
  const group = new THREE.Group();
  group.name = 'opponents';
  const profile = [
    [0.0, 0.0], [0.16, 0.0], [0.17, 0.04], [0.1, 0.06], [0.05, 0.1], [0.05, 0.85],
    [0.15, 0.9], [0.19, 1.05], [0.21, 1.25], [0.23, 1.42], [0.2, 1.48], [0.07, 1.52], [0.06, 1.58],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const bodyGeo = new THREE.LatheGeometry(profile, 28);
  const headGeo = new THREE.SphereGeometry(0.11, 24, 16);
  const stripeGeo = new THREE.CylinderGeometry(0.205, 0.215, 0.05, 28, 1, true);
  const armGeo = new THREE.CapsuleGeometry(0.045, 0.5, 6, 12);
  for (const x of [-2.4, 2.4]) {
    const d = new THREE.Group();
    const body = new THREE.Mesh(bodyGeo, mats.dummy);
    const head = new THREE.Mesh(headGeo, mats.dummy);
    head.position.y = 1.7;
    const stripe = new THREE.Mesh(stripeGeo, mats.dummyStripe);
    stripe.position.y = 1.18;
    const armL = new THREE.Mesh(armGeo, mats.dummy);
    armL.position.set(-0.27, 1.25, 0.08);
    armL.rotation.set(0.5, 0, 0.25);
    const armR = armL.clone();
    armR.position.x = 0.27;
    armR.rotation.z = -0.25;
    d.add(body, head, stripe, armL, armR);
    d.traverse((o) => {
      if (o.isMesh) o.castShadow = o.receiveShadow = true;
    });
    d.position.set(x, 0, -2.9);
    group.add(d);
  }
  group.visible = false;
  root.add(group);
  return group;
}

// ---------------------------------------------------------------------------------------------

/**
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer
 * @param {{quality?: string, venue?: 'club'|'sunset'|'stadium', envMode?: 'hall'|'room', neighbors?: boolean,
 *   overrides?: object, debug?: boolean}} opts
 */
export function buildEnvironment(scene, renderer, { quality = 'high', venue = 'club', envMode = 'hall', neighbors, overrides = null, iblOverrides = null, debug = false } = {}) {
  const tierOf = () => (scene.userData && QUALITY[scene.userData.quality] ? scene.userData.quality : QUALITY[quality] ? quality : 'high');
  const qualityNow = () => ({ ...QUALITY[tierOf()], ...(overrides || {}) });
  const q = qualityNow();
  let tLast = performance.now();
  const mark = (label) => {
    if (!debug) return;
    const now = performance.now();
    console.info(`[env] ${label}: ${Math.round(now - tLast)} ms`);
    tLast = now;
  };
  const root = new THREE.Group();
  root.name = 'vibora-environment';
  scene.add(root);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = roomEnv.texture;
  scene.environmentIntensity = 0.25;
  const iblCap = createIblCapture(renderer, pmrem);

  mark('room env');
  const mats = makeMaterials(renderer, q);
  mark('materials + textures');
  const wantNeighbors = neighbors ?? q.neighbors;
  // Main court first, then the right neighbour, then the left one: a venue shows the first N.
  const courtXs = wantNeighbors ? [0, NEIGHBOR_OFFSET, -NEIGHBOR_OFFSET] : [0];

  const kitMeshes = [];
  const addKit = (m) => {
    kitMeshes.push(m);
    root.add(m);
    return m;
  };
  const turfGeo = new THREE.PlaneGeometry(HW * 2, HL * 2, 1, 1);
  turfGeo.rotateX(-Math.PI / 2);
  addKit(instanced(turfGeo, mats.turf, courtXs, { name: 'turf' }));

  // Near-field fibre shells on the main court (quality tier: ultra 4, high 3, balanced none).
  const shells = createTurfShells(mats, q.turfShells ?? 0);
  root.add(shells);

  const kit = buildEnclosureGeometry();
  const steelInst = addKit(instanced(kit.steel, mats.steel, courtXs, { cast: true, name: 'steel' }));
  addKit(instanced(kit.bolts, mats.bolt, courtXs, { name: 'bolts' }));
  addKit(instanced(kit.mesh, mats.mesh, courtXs, { name: 'mesh' }));
  const edgeInst = addKit(instanced(kit.edges, mats.glassEdge, courtXs, { name: 'glass-edges' }));
  edgeInst.renderOrder = 1;
  const glassInst = addKit(instanced(kit.glass, mats.glass, courtXs, { receive: false, name: 'glass' }));
  glassInst.renderOrder = 2;

  const net = createNet(mats);
  root.add(net.group);
  const others = courtXs.filter((x) => x !== 0);
  const staticNets = [];
  if (others.length) {
    staticNets.push(root.add(instanced(net.mesh.geometry, mats.netStatic, others, { name: 'nets-static' })).children.at(-1));
    staticNets.push(root.add(instanced(net.band.geometry, mats.band, others, { name: 'bands-static' })).children.at(-1));
  }
  mark('court geometry');
  const marks = createBallMarks(root);
  const opponents = buildOpponents(root, mats);

  let layer = null;
  let meta = venueMeta(venue);
  let hallEnv = null;
  let reflectEnv = null;
  let time = 0;
  let gradeVersion = (scene.userData.gradeVersion || 0) + 1;

  /** Shows the first n courts (main + neighbours) of every court-kit instanced mesh. */
  function setCourtCount(n) {
    const k = Math.max(1, Math.min(courtXs.length, n));
    for (const m of kitMeshes) m.count = k;
    for (const m of staticNets) {
      m.count = Math.max(0, k - 1);
      m.visible = k > 1;
    }
  }

  /**
   * Captures the venue into two PMREMs: a dim one for ambient image-based light (scene.environment)
   * and one with the emitters at a realistic brightness ratio, used as the reflection map of the
   * glass and powder-coated steel so the lights / sky glint in the panels as they do on real courts.
   * Round 6: each capture is mixed with the venue's photographed panorama (layer.ibl, render/ibl.js)
   * once it has loaded (lazily, per venue): real-world texture in the reflections and a softer,
   * fuller ambient. Until then (or offline without it) the venue-only capture is used.
   */
  const hiddenForCapture = [];
  function iblParams() {
    const base = { hdri: meta.hdri, ...((layer && layer.ibl) || {}) };
    return iblOverrides ? { ...base, ...iblOverrides } : base;
  }
  function captureEnvironment(position = new THREE.Vector3(0, 2.2, 0)) {
    const prevOpp = opponents.visible;
    opponents.visible = false;
    // Only the venue goes into the reflection maps: players, ball, rig and effects (everything else
    // in the scene) would be frozen into the glass at the moment of a venue switch.
    hiddenForCapture.length = 0;
    for (const c of scene.children) {
      if (c !== root && c.visible && !c.isLight) {
        hiddenForCapture.push(c);
        c.visible = false;
      }
    }
    for (const k of REFLECTIVE) {
      mats[k].envMap = null;
      mats[k].needsUpdate = true;
    }
    const shellsOn = shells.visible;
    shells.visible = false;
    const hooks = (layer && layer.capture) || {};
    const size = qualityNow().envSize;
    const ib = iblParams();
    const hdri = ib.hdri ? hdriIfReady(ib.hdri) : null;
    const common = { size, position, hdri, rotationDeg: ib.rotationDeg || 0, tint: ib.tint, floor: ib.floor ?? 1, sky: ib.sky ?? 1, measure: debug };
    // The capture sees the venue lit by its own lights only (deterministic: no feedback from the
    // previous venue's or the previous capture's environment).
    const prevEnv = scene.environment;
    scene.environment = null;
    let rt, rt2;
    try {
      hooks.ambient?.();
      rt = iblCap.capture(scene, { ...common, venue: ib.ambient?.[0] ?? 1, weight: ib.ambient?.[1] ?? 0 });
      hooks.reflect?.();
      rt2 = iblCap.capture(scene, { ...common, venue: ib.reflect?.[0] ?? 1, weight: ib.reflect?.[1] ?? 0 });
    } finally {
      scene.environment = prevEnv;
      shells.visible = shellsOn;
      hooks.restore?.();
      opponents.visible = prevOpp;
      for (const c of hiddenForCapture) c.visible = true;
      hiddenForCapture.length = 0;
    }
    hallEnv?.dispose();
    reflectEnv?.dispose();
    hallEnv = rt;
    reflectEnv = rt2;
    scene.environment = rt.texture;
    scene.environmentIntensity = ib.envIntensity ?? (layer ? layer.envIntensity ?? 0.45 : 0.45);
    for (const k of REFLECTIVE) {
      mats[k].envMap = rt2.texture;
      mats[k].envMapIntensity = REFLECT_INTENSITY[k] * (layer?.reflectScale ?? 1);
      mats[k].needsUpdate = true;
    }
    iblState.withHdri = !!hdri;
    iblState.captures++;
    iblState.venueMean = iblCap.lastMean;
    return rt.texture;
  }
  const iblState = { withHdri: false, captures: 0, pending: null };

  /** Loads the venue's panorama (if any) and recaptures once it arrives. */
  function ensureHdri(vid) {
    const ib = iblParams();
    iblState.pending = null;
    if (!ib.hdri || envMode !== 'hall') return Promise.resolve(false);
    if (hdriIfReady(ib.hdri)) return Promise.resolve(true);
    const p = requestHdri(ib.hdri)
      .then(() => {
        if (!layer || layer.id !== vid || disposed) return false;
        captureEnvironment(layer.capturePosition);
        return true;
      })
      .catch(() => false);
    iblState.pending = p;
    return p;
  }
  let disposed = false;

  function applyMeta() {
    renderer.toneMappingExposure = meta.exposure;
    renderer.toneMapping = TONE_MAPPINGS[meta.toneMapping] ?? THREE.ACESFilmicToneMapping;
    scene.userData.grade = meta.grade;
    scene.userData.gradeVersion = ++gradeVersion;
    scene.userData.venue = meta.id;
  }

  /** Builds (or swaps to) a venue layer. Returns the venue metadata. */
  function setVenue(id) {
    const vid = venueId(id);
    if (layer && layer.id === vid) return meta;
    const t0 = performance.now();
    const hadLayer = !!layer;
    if (layer) {
      layer.dispose();
      root.remove(layer.group);
      layer = null;
    }
    scene.fog = null;
    meta = venueMeta(vid);
    const ctx = { scene, renderer, mats, q: qualityNow(), courtXs, root, debug };
    layer = VENUE_BUILDERS[vid](ctx);
    layer.id = vid;
    root.add(layer.group);
    setCourtCount(layer.courts ?? courtXs.length);
    // Court tuning per venue: outdoor dust, analytic enclosure shadow, grain, glass smudges.
    const tu = mats.turf.userData.uniforms;
    const tk = layer.turf || {};
    tu.uTurfK.value.set(tk.dust ?? 0, tk.wear ?? 1, tk.grain ?? 0.1, tk.ao ?? 1);
    tu.uTurfTint.value.set(tk.tint ?? 0xffffff);
    if (layer.sunDir) tu.uSun.value.set(layer.sunDir.x, layer.sunDir.y, layer.sunDir.z, 1);
    else tu.uSun.value.set(0, 1, 0, 0);
    const gk = layer.glass || {};
    const gu = mats.glass.userData.uniforms;
    gu.uSmudgeK.value.set(gk.grease ?? 1, gk.felt ?? 1, gk.water ?? 0, 0);
    // Interior box for parallax-corrected reflections (indoor venues; outdoors the sky is at infinity).
    if (layer.reflectBox) {
      gu.uBoxMin.value.copy(layer.reflectBox.min);
      gu.uBoxMax.value.copy(layer.reflectBox.max);
      gu.uProbe.value.copy(layer.capturePosition || new THREE.Vector3(0, 2.2, 0));
      gu.uBoxOn.value = 1;
    } else gu.uBoxOn.value = 0;
    // Outdoors the sun's analytic veil replaces the net's solid shadow-map shadow.
    net.mesh.castShadow = net.band.castShadow = !layer.sunDir;
    steelInst.castShadow = true;
    applyMeta();
    if (typeof scene.userData.refreshQuality === 'function') scene.userData.refreshQuality();
    if (hadLayer) issueCompiles();
    if (envMode === 'hall') captureEnvironment(layer.capturePosition);
    else useRoomEnvironment();
    ensureHdri(vid);
    mark(`venue ${vid} (${Math.round(performance.now() - t0)} ms)`);
    return meta;
  }

  /**
   * Live venue switch (QA r5: 58-65 programs compiled one by one on the first draws): issue every
   * program of the new lighting at once against a linear target like the scene's (three's compile
   * only starts the compiles; with KHR_parallel_shader_compile the driver builds them in parallel),
   * so the capture and the first frame wait for the slowest one instead of the sum.
   */
  let compileTarget = null;
  function issueCompiles() {
    const prev = renderer.getRenderTarget();
    try {
      compileTarget ||= new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
      renderer.setRenderTarget(compileTarget);
      const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.02, 120);
      renderer.compile(scene, cam);
    } catch {
      /* best effort: the draws compile what is missing */
    } finally {
      renderer.setRenderTarget(prev);
    }
  }

  function useRoomEnvironment() {
    scene.environment = roomEnv.texture;
    scene.environmentIntensity = 0.25;
    for (const k of REFLECTIVE) {
      mats[k].envMap = null;
      mats[k].needsUpdate = true;
    }
  }

  setVenue(venue);
  mark('venue + env capture');

  const api = {
    root,
    glassPanels: kit.glassPanels,
    meshPanels: kit.meshPanels,
    net,
    /** Lights of the current venue: { keys, fills, neighbors, hemi, sun, all }. */
    get lights() {
      return layer.lights;
    },
    materials: mats,
    /** The club sign group (club venue) or null. */
    get sign() {
      return layer.sign || null;
    },
    courtXs,
    /** Venue metadata (src/render/venues/meta.js): { id, name, es, acoustics, crowd, ambience, ... }. */
    get venue() {
      return meta;
    },
    /** The current venue layer's crowd (src/render/crowd.js) or null. */
    get crowd() {
      return layer.crowd || null;
    },
    setVenue,
    addBallMark(pos, normal) {
      marks.add(pos, normal);
    },
    /**
     * Crowd / venue reaction to the play (src/audio/crowdDirector.js kinds):
     * 'applause' | 'cheer' | 'roar' | 'ooh' | 'groan' | 'wave' | 'hush' | 'murmur'; level 0..1.
     */
    react(kind, level = 1, info = null) {
      layer.react?.(kind, level, info);
    },
    update(dt, camera = null) {
      time += dt;
      net.update(dt);
      marks.update(dt);
      layer.update?.(dt, time, camera);
    },
    setOpponentsVisible(v) {
      opponents.visible = !!v;
    },
    captureEnvironment,
    useRoomEnvironment,
    /** Image-based lighting state: { withHdri, captures, pending: Promise|null }. */
    get ibl() {
      return iblState;
    },
    /** Resolves once the current venue's panorama is in the lighting (false if it could not load). */
    whenLit() {
      return iblState.pending || Promise.resolve(iblState.withHdri);
    },
    dispose() {
      disposed = true;
      iblCap.dispose();
      layer?.dispose();
      scene.remove(root);
      hallEnv?.dispose();
      reflectEnv?.dispose();
      roomEnv.dispose();
      pmrem.dispose();
      compileTarget?.dispose();
      root.traverse((o) => {
        if (o.isMesh) o.geometry.dispose();
      });
    },
  };
  return api;
}
