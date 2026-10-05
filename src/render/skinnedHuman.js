// Skinned athletes (coach, AI players, the player's own body). Two sources, one skeleton layout
// (humanModel.js BONES: 22 bones in a fixed order):
//   realistic  the baked MakeHuman athletes (render/peopleAssets.js, assets/people/*): an athletic
//              male and female body with the racket hand wrapped around a grip, clothing shells,
//              shoes, eyes, eyebrows, eyelashes, hair cards and headwear; each body has its own bind
//              skeleton (joint positions), hand frames and limb lengths;
//   procedural the signed-distance athlete (humanModel.js), used until the assets arrive and as the
//              offline fallback.
// Either way a person is one SkinnedMesh per level of detail sharing one physical material (kit
// colours, ambient occlusion and per-region surface parameters are vertex attributes), so a whole
// person is one draw call (plus the racket). People built before the assets loaded rebuild
// themselves when they arrive.
import * as THREE from 'three';
import {
  humanTemplate, assembleHuman, BONES, REGION, PART, handBindBasis, REF_HEIGHT, LIMBS, HAIR_STYLE_NAMES, HEADWEAR_NAMES, hairlineY, HEAD_OFFSET,
} from './humanModel.js';
import { knitNormalTexture, actorQuality } from './actorKit.js';
import { racketInHand } from './handPose.js';
import { loadPeopleAssets, peopleLib, onPeopleReady, requestWarmup, PEOPLE_URL } from './peopleAssets.js';

export { BONES, LIMBS, REF_HEIGHT };

// The realistic assets load in the background as soon as a browser imports this module
// (?people=sdf keeps the procedural humans, for comparisons).
const REAL_DEFAULT = true;
const peopleParam = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('people') : null;
export const PEOPLE_MODE = peopleParam === 'sdf' ? 'sdf' : peopleParam === 'real' || REAL_DEFAULT ? 'real' : 'sdf';
if (typeof document !== 'undefined' && PEOPLE_MODE === 'real') {
  const loader = new THREE.TextureLoader();
  loadPeopleAssets({
    textures: (url) => loader.loadAsync(url).then((t) => {
      t.colorSpace = THREE.NoColorSpace;
      t.anisotropy = actorQuality().aniso;
      return t;
    }),
  });
}

// ------------------------------------------------------------------ kits

export const SKIN_TONES = ['#f2cdb0', '#e3b08e', '#c99170', '#a8714f', '#875638', '#5f3b27'];
export const HAIR_COLORS = ['#16110e', '#2a1d16', '#47301f', '#6f4a2c', '#9c7247', '#c9a46b', '#3a3a3a'];
const SHIRTS = [
  ['#e8572a', '#1d2b4a'], ['#eef1f4', '#1d2b4a'], ['#c8263c', '#16181d'], ['#1f6fd1', '#eef1f4'], ['#14a37f', '#0f1b2e'],
  ['#f2c21b', '#16181d'], ['#7a3fc4', '#eef1f4'], ['#16181d', '#d7ff3a'], ['#2b9be8', '#16181d'], ['#f06a9b', '#1b1b25'],
];
const SHORTS = ['#16181d', '#1b2a44', '#eef1f4', '#2b2f36', '#0f1b2e'];
const SHOES = [['#f4f4f4', '#e8572a'], ['#16181d', '#d7ff3a'], ['#eef1f4', '#1f6fd1'], ['#f4f4f4', '#14a37f'], ['#2b2f36', '#f06a9b']];
/** First names read as women in the career roster and partner seeds (body choice). */
const FEMALE_NAMES = new Set(['carla', 'nuria', 'ines', 'marta', 'sol', 'vera', 'lucia', 'ana', 'maria', 'paula', 'sara', 'laura', 'elena', 'claudia', 'alba', 'irene', 'gemma', 'bea']);

/** Default kit (every field may be overridden). body: 'male' | 'female'; height in m (null: the body's own). */
export const DEFAULT_KIT = Object.freeze({
  skin: '#c58c6a', shirt: '#1d2b4a', trim: '#e8572a', shorts: '#10131a', shortsTrim: '#e8572a', sock: '#f2f2ef',
  shoe: '#f4f4f4', sole: '#e8e5de', shoeAccent: '#e8572a', lace: '#fbfbfb', hair: '#2a1d16', headwear: '#e8572a',
  headwearAccent: '#1d2b4a', band: '#f4f4f2', iris: '#4a3423', hairStyle: 'short', headwearKind: 'none',
  sockHeight: 0.11, wristband: 'racket', panels: true, body: 'male', height: null, stubble: 0,
});

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Body from a seed: a known first name decides, otherwise ~35 % women (deterministic). */
export function bodyForSeed(seed) {
  const s = String(seed).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (s === 'player' || s === 'coach' || s === 'humanoid') return 'male';
  const name = s.split(/[-\s_]/).pop();
  if (FEMALE_NAMES.has(name)) return 'female';
  if (/^[a-z]+$/.test(name) && name.length > 2 && !/^(b|c|d|a)$/.test(name)) return 'male';
  return hashStr(`${s}#body`) % 100 < 35 ? 'female' : 'male';
}

/**
 * A plausible club kit from a seed string (deterministic): shirt + trim, shorts, shoes, skin tone,
 * hair colour and style, headwear, body and height. `base` fields win (team colours, the coach's shirt).
 */
export function kitFor(seed, base = {}) {
  let h = hashStr(String(seed));
  const pick = (arr) => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    return arr[h % arr.length];
  };
  const shirt = pick(SHIRTS);
  const shoe = pick(SHOES);
  const body = base.body || bodyForSeed(seed);
  const female = body === 'female';
  const kit = {
    ...DEFAULT_KIT,
    shirt: shirt[0], trim: shirt[1], shorts: pick(SHORTS), shortsTrim: shirt[0],
    shoe: shoe[0], shoeAccent: shoe[1], skin: pick(SKIN_TONES), hair: pick(HAIR_COLORS),
    hairStyle: female ? pick(['ponytail', 'ponytail', 'bun', 'medium']) : pick(['short', 'short', 'buzz', 'medium', 'short']),
    headwearKind: pick(['none', 'cap', 'visor', 'headband', 'none']),
    headwear: pick(['#eef1f4', '#16181d', shirt[0], shirt[1]]), headwearAccent: shirt[1],
    iris: pick(['#4a3423', '#2f4f6f', '#3e5b3a', '#6b4b2a']), sockHeight: pick([0.06, 0.11, 0.14]),
    wristband: pick(['racket', 'both', null]), panels: pick([true, false]),
    body, height: female ? pick([1.62, 1.66, 1.68, 1.7, 1.73]) : pick([1.76, 1.79, 1.81, 1.84, 1.87]),
    stubble: female ? 0 : pick([0, 0.35, 0.6, 0.85]),
  };
  if (kit.hairStyle === 'bun' || kit.hairStyle === 'ponytail') kit.headwearKind = pick(['none', 'visor', 'headband']);
  // Darker skin tones sometimes wear an afro (male) — the style list is per body.
  if (!female && (kit.skin === '#875638' || kit.skin === '#5f3b27') && pick([0, 1, 2]) === 0) kit.hairStyle = 'afro';
  return { ...kit, ...base };
}

/** Kit hair style -> baked realistic hair id (null: none). */
const REAL_HAIR = { short: 'short', buzz: 'crop', medium: 'medium', ponytail: 'ponytail', bun: 'bob', afro: 'afro', crop: 'crop', bob: 'bob', none: null };
const HAIR_FALLBACK = { short: ['medium', 'bob'], crop: ['short', 'medium', 'bob'], afro: ['medium', 'bob'], ponytail: ['medium'], bob: ['medium'], medium: ['short', 'bob'] };

// ------------------------------------------------------------------ procedural material

/** Per-region surface: [roughness, fabric (sheen + knit), skin (wrap lighting)]. */
const SURF = {
  [REGION.SKIN]: [0.5, 0, 1], [REGION.SHIRT]: [0.8, 1, 0], [REGION.TRIM]: [0.6, 0.7, 0], [REGION.SHORTS]: [0.72, 0.8, 0],
  [REGION.SHORTS_TRIM]: [0.6, 0.6, 0], [REGION.SOCK]: [0.95, 1, 0], [REGION.SHOE]: [0.55, 0.3, 0], [REGION.SOLE]: [0.85, 0, 0],
  [REGION.SHOE_ACCENT]: [0.38, 0, 0], [REGION.HAIR]: [0.52, 0.18, 0], [REGION.HEADWEAR]: [0.8, 1, 0], [REGION.HEADWEAR_ACCENT]: [0.55, 0.4, 0],
  [REGION.EYE]: [0.15, 0, 0.25], [REGION.IRIS]: [0.1, 0, 0], [REGION.PUPIL]: [0.06, 0, 0], [REGION.BAND]: [0.95, 1, 0], [REGION.LACE]: [0.8, 0.6, 0],
};

const WRAP_FIND = 'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );';
const WRAP_REPLACE = `{
    float sssNL = dot( geometryNormal, directLight.direction );
    vec3 sssW = vec3( 0.38, 0.2, 0.13 ) * vHumanSurf.z;
    vec3 sssIrr = clamp( ( vec3( sssNL ) + sssW ) / ( 1.0 + sssW ), 0.0, 1.0 ) * directLight.color;
    reflectedLight.directDiffuse += mix( irradiance, sssIrr, step( 0.001, vHumanSurf.z ) ) * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
  }`;
// Realistic skin: a softer, redder wrap (light scattered under the skin reddens the terminator).
const WRAP_REAL = `{
    float sssNL = dot( geometryNormal, directLight.direction );
    vec3 sssW = vec3( 0.46, 0.24, 0.15 ) * vHumanSurf.z;
    vec3 sssIrr = clamp( ( vec3( sssNL ) + sssW ) / ( 1.0 + sssW ), 0.0, 1.0 );
    sssIrr *= sssIrr * ( 3.0 - 2.0 * sssIrr ) * 0.35 + sssIrr * 0.65;
    reflectedLight.directDiffuse += mix( irradiance, sssIrr * directLight.color, step( 0.001, vHumanSurf.z ) ) * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
  }`;

/** First-person dissolve (shared by both materials). */
const FP_DISCARD = `#include <clipping_planes_fragment>
	if ( vHumanPart > 0.5 ) discard;
	float fpFade = min( smoothstep( fpNear, fpFar, fpEyeY - vHumanWorldY ), smoothstep( 0.1, 0.16, length( vViewPosition ) ) );
	float fpDither = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
	if ( fpFade < 0.999 && fpFade <= fpDither ) discard;`;

function shadowOnlyMaterial() {
  const m = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  m.name = 'human-shadow-only';
  // The shadow pass draws its own depth material; in the main pass every vertex lands beyond the
  // far plane, so the triangles are clipped before rasterization (no skinning, no fragments).
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <skinning_vertex>', '')
      .replace(/}\s*$/, '\tgl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );\n}\n');
  };
  m.customProgramCacheKey = () => 'vibora-human-shadow-only-1';
  return m;
}

/**
 * The procedural human material. fp: the first-person body (head and arms are not drawn — the
 * first-person rig draws the forearms and hands — and everything within `near` of the eye
 * dissolves with a screen-space dither, like a VR body). shadowOnly: writes nothing.
 */
export function createHumanMaterial({ fp = false, shadowOnly = false } = {}) {
  if (shadowOnly) return shadowOnlyMaterial();
  const knit = knitNormalTexture();
  const m = new THREE.MeshPhysicalMaterial({
    vertexColors: true, roughness: 1, metalness: 0, sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color('#ffffff'),
    normalMap: knit, normalScale: new THREE.Vector2(0.42, 0.42), specularIntensity: 0.6,
  });
  m.name = fp ? 'human-fp' : 'human';
  m.userData.fpNear = { value: 0.14 };
  m.userData.fpFar = { value: 0.24 };
  m.userData.fpEyeY = { value: 1e4 };
  if (fp) m.side = THREE.DoubleSide;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.fpNear = m.userData.fpNear;
    shader.uniforms.fpFar = m.userData.fpFar;
    shader.uniforms.fpEyeY = m.userData.fpEyeY;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 surf;\nattribute float part;\nvarying vec3 vHumanSurf;\nvarying float vHumanPart;\nvarying float vHumanWorldY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvHumanSurf = surf;\n\tvHumanPart = part;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n\tvHumanWorldY = ( modelMatrix * vec4( transformed, 1.0 ) ).y;');
    let fs = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHumanSurf;\nvarying float vHumanPart;\nvarying float vHumanWorldY;\nuniform float fpNear;\nuniform float fpFar;\nuniform float fpEyeY;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vHumanSurf.x;')
      .replace('#include <normal_fragment_maps>', `#ifdef USE_NORMALMAP_TANGENTSPACE
	vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
	mapN.xy *= normalScale * vHumanSurf.y;
	normal = normalize( tbn * mapN );
#endif`)
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_SHEEN\n\tmaterial.sheenColor *= 0.6 * vHumanSurf.y * mix( vec3( 1.0 ), sqrt( max( diffuseColor.rgb, vec3( 0.0 ) ) ), 0.75 );\n#endif')
      .replace('#include <lights_physical_pars_fragment>', THREE.ShaderChunk.lights_physical_pars_fragment.replace(WRAP_FIND, WRAP_REPLACE));
    if (fp) {
      fs = fs.replace('#include <clipping_planes_fragment>', FP_DISCARD)
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tif ( ! gl_FrontFacing ) gl_FragColor.rgb *= 0.18;');
    }
    shader.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => (fp ? 'vibora-human-fp-3' : 'vibora-human-3');
  return m;
}

let sharedMaterial = null;
function humanMaterial() {
  if (!sharedMaterial) sharedMaterial = createHumanMaterial();
  return sharedMaterial;
}

// ------------------------------------------------------------------ realistic material

/** Detail normal textures of the realistic people (pores, cloth wrinkles; pmndrs/assets, CC0). */
let detailTex = null;
function detailTextures() {
  if (!detailTex) {
    const loader = new THREE.TextureLoader();
    const load = (f) => {
      const t = loader.load(`${PEOPLE_URL}${f}`);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.NoColorSpace;
      t.anisotropy = actorQuality().aniso;
      return t;
    };
    detailTex = { pores: load('pores.webp'), wrinkles: load('wrinkles.webp') };
  }
  return detailTex;
}

/** Tunables of the realistic material (dev pages tweak them). */
export const REAL_LOOK = {
  knitRepeat: 70, poreRepeat: 46, wrinkleRepeat: 3.2, knit: 0.32, pores: 0.24, wrinkles: 0.32,
};

/**
 * The realistic human material: kit colours as vertex colours times the skin detail atlas (skin),
 * the hair / eye atlas (alpha-to-coverage cards on MSAA tiers, alpha-tested otherwise), detail
 * normals (pores on skin; knit and soft wrinkles on cloth), skin wrap lighting, baked occlusion on
 * the indirect light, fabric sheen. Image-based light comes from scene.environment.
 */
export function createRealHumanMaterial(lib, { fp = false } = {}) {
  const det = detailTextures();
  const knit = knitNormalTexture();
  const m = new THREE.MeshPhysicalMaterial({
    vertexColors: true, roughness: 1, metalness: 0, sheen: 1, sheenRoughness: 0.55, sheenColor: new THREE.Color('#ffffff'),
    map: lib.textures.skin, normalMap: knit, normalScale: new THREE.Vector2(REAL_LOOK.knit, REAL_LOOK.knit), specularIntensity: 0.55,
    alphaTest: 0.5,
  });
  m.name = fp ? 'human-real-fp' : 'human-real';
  const a2c = (q) => (q ? q.msaa > 0 : actorQuality().level !== 'balanced');
  m.alphaToCoverage = a2c(null);
  m.userData.onTier = (q) => {
    const want = a2c(q);
    if (m.alphaToCoverage !== want) {
      m.alphaToCoverage = want;
      m.needsUpdate = true;
    }
  };
  m.userData.fpNear = { value: 0.14 };
  m.userData.fpFar = { value: 0.24 };
  m.userData.fpEyeY = { value: 1e4 };
  const U = {
    tHair: { value: lib.textures.hair }, tPores: { value: det.pores }, tWrinkle: { value: det.wrinkles },
    uDetail: { value: new THREE.Vector4(REAL_LOOK.knitRepeat, REAL_LOOK.poreRepeat, REAL_LOOK.wrinkleRepeat, 0) },
    uDetailK: { value: new THREE.Vector3(REAL_LOOK.pores, REAL_LOOK.wrinkles, 0) },
  };
  m.userData.uniforms = U;
  if (fp) m.side = THREE.DoubleSide;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U, { fpNear: m.userData.fpNear, fpFar: m.userData.fpFar, fpEyeY: m.userData.fpEyeY });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 surf;
attribute float part;
attribute float hmode;
attribute float hao;
varying vec3 vHumanSurf;
varying float vHumanPart;
varying float vHumanWorldY;
varying float vHumanMode;
varying float vHumanAO;`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvHumanSurf = surf;\n\tvHumanPart = part;\n\tvHumanMode = hmode;\n\tvHumanAO = hao;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n\tvHumanWorldY = ( modelMatrix * vec4( transformed, 1.0 ) ).y;');
    let fs = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vHumanSurf;
varying float vHumanPart;
varying float vHumanWorldY;
varying float vHumanMode;
varying float vHumanAO;
uniform float fpNear;
uniform float fpFar;
uniform float fpEyeY;
uniform sampler2D tHair;
uniform sampler2D tPores;
uniform sampler2D tWrinkle;
uniform vec4 uDetail;
uniform vec3 uDetailK;`)
      .replace('#include <map_fragment>', `{
	// Skin: the detail atlas (x0.5) times the skin tone; hair / brows / lashes: luminance (x0.5) times
	// the hair colour, alpha cards; the eye: true colour from the atlas.
	vec4 hSkin = texture2D( map, vMapUv );
	vec4 hHair = texture2D( tHair, vMapUv );
	if ( vHumanMode > 2.5 ) { diffuseColor.rgb *= pow( hHair.rgb, vec3( 2.2 ) ); diffuseColor.a *= hHair.a; }
	else if ( vHumanMode > 1.5 ) { diffuseColor.rgb *= hHair.r * 2.0; diffuseColor.a *= hHair.a; }
	else if ( vHumanMode > 0.5 ) diffuseColor.rgb *= hSkin.rgb * 2.0;
	// Cavities (armpits, the collar's inside, between the fingers) darken the direct light a little too.
	diffuseColor.rgb *= mix( 1.0, vHumanAO, 0.4 );
}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vHumanSurf.x;')
      .replace('#include <normal_fragment_maps>', `#ifdef USE_NORMALMAP_TANGENTSPACE
	{
		float kCloth = vHumanSurf.y * step( vHumanMode, 0.5 );
		vec2 dKnit = ( texture2D( normalMap, vNormalMapUv * uDetail.x ).xy * 2.0 - 1.0 ) * normalScale;
		vec2 dWrinkle = ( texture2D( tWrinkle, vNormalMapUv * uDetail.z ).xy * 2.0 - 1.0 ) * uDetailK.y;
		vec2 dPore = ( texture2D( tPores, vNormalMapUv * uDetail.y ).xy * 2.0 - 1.0 ) * uDetailK.x * vHumanSurf.z;
		vec2 d = ( dKnit + dWrinkle ) * kCloth + dPore;
		normal = normalize( tbn * normalize( vec3( d, 1.0 ) ) );
	}
#endif`)
      .replace('#include <aomap_fragment>', `{
	float ambientOcclusion = vHumanAO;
	reflectedLight.indirectDiffuse *= ambientOcclusion;
	#if defined( USE_SHEEN )
		sheenSpecularIndirect *= ambientOcclusion;
	#endif
	float dotNVao = saturate( dot( geometryNormal, geometryViewDir ) );
	reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNVao, ambientOcclusion, material.roughness );
}`)
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_SHEEN\n\tmaterial.sheenColor *= 0.55 * vHumanSurf.y * mix( vec3( 1.0 ), sqrt( max( diffuseColor.rgb, vec3( 0.0 ) ) ), 0.75 );\n#endif')
      .replace('#include <lights_physical_pars_fragment>', THREE.ShaderChunk.lights_physical_pars_fragment.replace(WRAP_FIND, WRAP_REAL));
    if (fp) {
      fs = fs.replace('#include <clipping_planes_fragment>', FP_DISCARD)
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tif ( ! gl_FrontFacing ) gl_FragColor.rgb *= 0.18;');
    }
    shader.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => (fp ? 'vibora-human-real-fp-1' : 'vibora-human-real-1');
  return m;
}

let realShared = null;
function realMaterial(lib) {
  if (!realShared) realShared = createRealHumanMaterial(lib);
  return realShared;
}

// ------------------------------------------------------------------ procedural geometry

const _c = new THREE.Color();
const _c2 = new THREE.Color();
const ARM_SHOULDER = { R: BONES.find((b) => b.name === 'upperArmR').pos, L: BONES.find((b) => b.name === 'upperArmL').pos };
const ARM_DIR = { R: [-Math.sin(0.349), -Math.cos(0.349), 0], L: [Math.sin(0.349), -Math.cos(0.349), 0] };

/** Albedo (linear) and surface parameters of one procedural vertex for a kit. */
function shadeVertex(kit, p, v, outCol, outSurf, cache) {
  const region = p.region[v];
  const x = p.positions[v * 3], y = p.positions[v * 3 + 1], z = p.positions[v * 3 + 2];
  let reg = region;
  let col = null;
  const ax = Math.abs(x);
  if (region === REGION.SKIN) {
    const a = p.aux[v * 2];
    const side = x < 0 ? 'R' : 'L';
    if (a < 8 && a < kit.sockHeight && p.part[v] === PART.BODY && y < 0.5) {
      reg = REGION.SOCK;
      col = cache.sock;
    } else if (a >= 5 && a < 5.065 && kit.wristband && (kit.wristband === 'both' || (kit.wristband === 'racket' && side === cache.racketSide))) {
      reg = REGION.BAND;
      col = cache.band;
    } else if (p.part[v] === PART.HEAD && y > 1.5 && a <= 1) {
      const brow = p.aux[v * 2], lip = p.aux[v * 2 + 1];
      _c.copy(cache.skin);
      if (lip > 0) _c.lerp(cache.lip, lip * 0.75);
      if (brow > 0) _c.lerp(cache.brow, brow * 0.85);
      const cheek = Math.exp(-(((ax - 0.045) / 0.02) ** 2 + ((y - 1.668 - HEAD_OFFSET) / 0.02) ** 2 + ((z - 0.06) / 0.03) ** 2));
      if (cheek > 0.01) _c.lerp(cache.blush, cheek * 0.12);
      if (kit.hairStyle !== 'none') {
        const hl = hairlineY(x, z);
        const sc = Math.min(1, Math.max(0, (y - (hl - 0.012)) / 0.016));
        if (sc > 0) _c.lerp(cache.scalp, sc * (kit.hairStyle === 'buzz' ? 0.9 : 0.75));
      }
      col = _c;
    } else col = cache.skin;
  } else if (region === REGION.SHIRT) {
    col = cache.shirt;
    const neckD = Math.hypot(x / 1.05, (y - 1.47) * 1.25, (z + 0.012) / 0.9);
    if (y > 1.38 && neckD < 0.086 && !cache.fp) { reg = REGION.TRIM; col = cache.trim; } else if (ax > 0.17) {
      const side = x < 0 ? 'R' : 'L';
      const S = ARM_SHOULDER[side], d = ARM_DIR[side];
      const t = (x - S[0]) * d[0] + (y - S[1]) * d[1] + (z - S[2]) * d[2];
      if (t > 0.115) { reg = REGION.TRIM; col = cache.trim; }
    }
    if (kit.panels && reg === REGION.SHIRT && ax > 0.115 && ax < 0.19 && Math.abs(z) < 0.035 && y < 1.36) { reg = REGION.TRIM; col = cache.trim; }
    if (reg === REGION.SHIRT && y < 0.995) { reg = REGION.TRIM; col = cache.trim; }
  } else if (region === REGION.SHORTS) {
    col = cache.shorts;
    if (kit.panels && ax > 0.135 && Math.abs(z) < 0.03 && y < 0.98) { reg = REGION.SHORTS_TRIM; col = cache.shortsTrim; }
    if (y < 0.612) { reg = REGION.SHORTS_TRIM; col = cache.shortsTrim; }
  } else {
    col = cache.byRegion[region] || cache.skin;
  }
  const ao = p.ao[v];
  const occl = 1 - (1 - ao) * (p.part[v] === PART.HEAD && (region === REGION.SKIN || region === REGION.HAIR) ? 0.5 : 0.9);
  outCol[0] = col.r * occl;
  outCol[1] = col.g * occl;
  outCol[2] = col.b * occl;
  const s = SURF[reg] || SURF[REGION.SKIN];
  outSurf[0] = s[0]; outSurf[1] = s[1]; outSurf[2] = s[2];
}

function kitCache(kit, handed, fp = false) {
  const lin = (hex) => new THREE.Color(hex);
  const skin = lin(kit.skin);
  return {
    fp,
    skin,
    sock: lin(kit.sock), band: lin(kit.band), shirt: lin(kit.shirt), trim: lin(kit.trim), shorts: lin(kit.shorts), shortsTrim: lin(kit.shortsTrim),
    lip: skin.clone().multiply(_c2.setRGB(0.92, 0.62, 0.6)),
    blush: skin.clone().multiply(_c2.setRGB(1.0, 0.8, 0.78)),
    brow: lin(kit.hair).multiplyScalar(0.8),
    scalp: lin(kit.hair).multiplyScalar(0.85),
    hair: lin(kit.hair),
    racketSide: handed === 'left' ? 'L' : 'R',
    byRegion: {
      [REGION.SHOE]: lin(kit.shoe), [REGION.SOLE]: lin(kit.sole), [REGION.SHOE_ACCENT]: lin(kit.shoeAccent), [REGION.LACE]: lin(kit.lace),
      [REGION.HAIR]: lin(kit.hair), [REGION.HEADWEAR]: lin(kit.headwear), [REGION.HEADWEAR_ACCENT]: lin(kit.headwearAccent),
      [REGION.EYE]: lin('#cfc6b8'), [REGION.IRIS]: lin(kit.iris), [REGION.PUPIL]: lin('#070707'), [REGION.BAND]: lin(kit.band),
      [REGION.TRIM]: lin(kit.trim), [REGION.SHIRT]: lin(kit.shirt), [REGION.SHORTS]: lin(kit.shorts), [REGION.SHORTS_TRIM]: lin(kit.shortsTrim),
      [REGION.SOCK]: lin(kit.sock), [REGION.INNER]: lin(kit.shirt).multiplyScalar(0.5),
    },
  };
}

/** One person's procedural BufferGeometry (shared bone layout) for a template LOD, kit and handedness. */
export function buildHumanGeometry(lod, kit, handed, { fp = false } = {}) {
  const tpl = humanTemplate(lod);
  const p = assembleHuman(tpl, { handed, hair: kit.hairStyle, headwear: kit.headwearKind, fp });
  const n = p.positions.length / 3;
  const color = new Float32Array(n * 3);
  const surf = new Float32Array(n * 3);
  const cache = kitCache(kit, handed, fp);
  const col = [0, 0, 0], sf = [0, 0, 0];
  for (let v = 0; v < n; v++) {
    shadeVertex(kit, p, v, col, sf, cache);
    color[v * 3] = col[0]; color[v * 3 + 1] = col[1]; color[v * 3 + 2] = col[2];
    surf[v * 3] = sf[0]; surf[v * 3 + 1] = sf[1]; surf[v * 3 + 2] = sf[2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(p.uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(color, 3));
  g.setAttribute('surf', new THREE.BufferAttribute(surf, 3));
  g.setAttribute('part', new THREE.BufferAttribute(Float32Array.from(p.part), 1));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(p.skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(p.skinWeight, 4));
  g.setIndex(new THREE.BufferAttribute(p.index, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0), 1.25);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-0.9, -0.3, -0.9), new THREE.Vector3(0.9, 2.4, 0.9));
  return g;
}

// ------------------------------------------------------------------ realistic geometry

/** Bone index swap for mirroring (R <-> L). */
const MIRROR_BONE = BONES.map((b) => {
  const n = b.name.endsWith('R') && !b.name.endsWith('LR') ? `${b.name.slice(0, -1)}L` : b.name.endsWith('L') ? `${b.name.slice(0, -1)}R` : b.name;
  const i = BONES.findIndex((c) => c.name === n);
  return i >= 0 ? i : BONES.indexOf(b);
});

/** Realistic surface per region: [roughness, fabric (sheen + knit), skin (wrap + pores)], texture mode. */
const REAL_SURF = {
  [REGION.SKIN]: [0.47, 0.16, 1, 1], [REGION.SHIRT]: [0.84, 1, 0, 0], [REGION.TRIM]: [0.72, 0.8, 0, 0], [REGION.SHORTS]: [0.76, 0.85, 0, 0],
  [REGION.SHORTS_TRIM]: [0.68, 0.6, 0, 0], [REGION.SOCK]: [0.95, 1, 0, 0], [REGION.SHOE]: [0.5, 0.25, 0, 0], [REGION.SOLE]: [0.82, 0, 0, 0],
  [REGION.SHOE_ACCENT]: [0.36, 0, 0, 0], [REGION.LACE]: [0.8, 0.6, 0, 0], [REGION.HAIR]: [0.4, 0.35, 0, 2], [REGION.BROW]: [0.6, 0, 0, 2],
  [REGION.LASH]: [0.6, 0, 0, 2], [REGION.EYE]: [0.04, 0, 0, 3], [REGION.HEADWEAR]: [0.82, 1, 0, 0], [REGION.HEADWEAR_ACCENT]: [0.5, 0.3, 0, 0],
  [REGION.BAND]: [0.95, 1, 0, 0], [REGION.INNER]: [0.9, 0.5, 0, 0],
};

/** Colour (linear) of a realistic vertex for a kit. */
function realShade(kit, cache, tpl, part, v, x, y, z, out) {
  const region = part.attributes._REGION.array[v];
  const aux = part.attributes._AUX.array;
  const pp = part.attributes._PART.array[v];
  let reg = region;
  let col = cache.byRegion[region] || cache.skin;
  if (region === REGION.SKIN) {
    col = cache.skin;
    const shin = aux[v * 2] / 255, fore = aux[v * 2 + 1] / 255; // m / 0.5, m / 0.4
    const side = x < 0 ? 'R' : 'L';
    if (shin < 1 && shin * 0.5 < kit.sockHeight + 0.035 && pp === PART.BODY) { reg = REGION.SOCK; col = cache.sock; } else if (fore < 1 && fore * 0.4 < 0.06 && kit.wristband && (kit.wristband === 'both' || (kit.wristband === 'racket' && side === cache.racketSide))) {
      reg = REGION.BAND;
      col = cache.band;
    } else if (pp === PART.HEAD) {
      // Scalp under the hair and a little stubble on men.
      const H = tpl.head;
      _c.copy(cache.skin);
      if (H) {
        const dz = z - H.center[2];
        const front = dz > H.radii[2] * 0.45;
        const hl = H.eyeY + (front ? 0.062 : 0.012);
        if (kit.hairStyle && kit.hairStyle !== 'none' && y > hl && !(front && y < H.eyeY + 0.035)) {
          const t = Math.min(1, (y - hl) / 0.02);
          _c.lerp(cache.scalp, t * (kit.hairStyle === 'buzz' ? 0.85 : 0.6));
        }
        if (kit.stubble > 0 && y < H.eyeY - 0.035 && dz > -0.02) {
          const jaw = Math.min(1, (H.eyeY - 0.035 - y) / 0.02);
          const lip = Math.abs(x) < 0.018 && y > H.eyeY - 0.075 && dz > H.radii[2] * 0.75 ? 0.3 : 1;
          _c.lerp(cache.stubble, jaw * kit.stubble * 0.45 * lip);
        }
      }
      col = _c;
    }
  } else if (region === REGION.SHIRT && kit.panels && Math.abs(z - (tpl.panelZ || 0)) < 0.03 && Math.abs(x) > (tpl.panelX || 0.13) && y < tpl.limbs.shoulderY - 0.12) {
    reg = REGION.TRIM;
    col = cache.trim;
  } else if (region === REGION.SHORTS && kit.panels && Math.abs(z) < 0.028 && Math.abs(x) > 0.12) {
    reg = REGION.SHORTS_TRIM;
    col = cache.shortsTrim;
  } else if (region === REGION.BROW) col = cache.brow;
  else if (region === REGION.LASH) col = cache.lash;
  else if (region === REGION.EYE) col = cache.white;
  out[0] = col.r; out[1] = col.g; out[2] = col.b;
  return reg;
}

/**
 * One person's realistic BufferGeometry: body (+ clothes, shoes, eyes) + hair + headwear of a
 * template LOD, coloured for a kit; mirrored for left-handers (the bake is right-handed).
 */
export function buildRealGeometry(lib, tplName, lod, kit, handed, { fp = false } = {}) {
  const tpl = lib.templates[tplName] || lib.templates.male;
  const pick = (k) => tpl.parts[k];
  const list = [pick(`body/${lod}`) || pick('body/0')];
  if (!fp) {
    let hs = REAL_HAIR[kit.hairStyle] === undefined ? 'short' : REAL_HAIR[kit.hairStyle];
    // Styles are baked for some bodies only: the nearest available one.
    if (hs && !pick(`hair/${hs}/0`)) hs = (HAIR_FALLBACK[hs] || []).find((h) => pick(`hair/${h}/0`)) || null;
    if (hs) list.push(pick(`hair/${hs}/${lod}`) || pick(`hair/${hs}/0`));
    if (kit.headwearKind && kit.headwearKind !== 'none') list.push(pick(`headwear/${kit.headwearKind}/${lod}`) || pick(`headwear/${kit.headwearKind}/0`));
  }
  const parts = list.filter(Boolean);
  let n = 0, ni = 0;
  for (const p of parts) { n += p.attributes.POSITION.array.length / 3; ni += p.index.length; }
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2), color = new Float32Array(n * 3);
  const surf = new Float32Array(n * 3), part = new Float32Array(n), hmode = new Float32Array(n), hao = new Float32Array(n);
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const index = n < 65536 ? new Uint16Array(ni) : new Uint32Array(ni);
  const mir = handed === 'left';
  const cache = kitCache(kit, handed, fp);
  cache.stubble = new THREE.Color(kit.hair).multiplyScalar(0.55).lerp(cache.skin, 0.35);
  cache.lash = new THREE.Color('#120d0a');
  cache.white = new THREE.Color('#ffffff');
  cache.brow = new THREE.Color(kit.hair).multiplyScalar(0.75);
  const col = [0, 0, 0];
  // The shorts' waistband under the shirt tucks 12 mm further in: crouches and lunges (the shorts
  // follow the thighs, the shirt the spine) otherwise push it through the shirt's hem as a ragged
  // dark edge. Full tuck from 6 cm below the hip joint up, none at 9.5 cm (where the hem ends).
  const hipY = tpl.limbs.hipY;
  let o = 0, oi = 0;
  for (const p of parts) {
    const A = p.attributes;
    const P = A.POSITION.array, N = A.NORMAL.array, T = A.TEXCOORD_0.array, J = A.JOINTS_0.array, W = A.WEIGHTS_0.array, AO = A._AO.array, PA = A._PART.array;
    const R = A._REGION.array;
    const m = P.length / 3;
    for (let v = 0; v < m; v++) {
      let x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
      if ((R[v] === REGION.SHORTS || R[v] === REGION.SHORTS_TRIM) && y > hipY - 0.095) {
        const tuck = 0.012 * THREE.MathUtils.smoothstep(y, hipY - 0.095, hipY - 0.06);
        x -= (N[v * 3] / 127) * tuck; y -= (N[v * 3 + 1] / 127) * tuck; z -= (N[v * 3 + 2] / 127) * tuck;
      }
      const k = o + v;
      pos[k * 3] = mir ? -x : x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      nrm[k * 3] = (mir ? -N[v * 3] : N[v * 3]) / 127; nrm[k * 3 + 1] = N[v * 3 + 1] / 127; nrm[k * 3 + 2] = N[v * 3 + 2] / 127;
      uv[k * 2] = T[v * 2] / 65535; uv[k * 2 + 1] = T[v * 2 + 1] / 65535;
      for (let j = 0; j < 4; j++) {
        si[k * 4 + j] = mir ? MIRROR_BONE[J[v * 4 + j]] : J[v * 4 + j];
        sw[k * 4 + j] = W[v * 4 + j] / 255;
      }
      const reg = realShade(kit, cache, tpl, p, v, mir ? -x : x, y, z, col);
      color[k * 3] = col[0]; color[k * 3 + 1] = col[1]; color[k * 3 + 2] = col[2];
      const s = REAL_SURF[reg] || REAL_SURF[REGION.SKIN];
      surf[k * 3] = s[0]; surf[k * 3 + 1] = s[1]; surf[k * 3 + 2] = s[2];
      hmode[k] = s[3];
      part[k] = PA[v];
      hao[k] = AO[v] / 255;
    }
    const I = p.index;
    for (let t = 0; t < I.length; t += 3) {
      // Mirroring flips the winding.
      index[oi + t] = I[t] + o;
      index[oi + t + 1] = (mir ? I[t + 2] : I[t + 1]) + o;
      index[oi + t + 2] = (mir ? I[t + 1] : I[t + 2]) + o;
    }
    o += m;
    oi += I.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(color, 3));
  g.setAttribute('surf', new THREE.BufferAttribute(surf, 3));
  g.setAttribute('part', new THREE.BufferAttribute(part, 1));
  g.setAttribute('hmode', new THREE.BufferAttribute(hmode, 1));
  g.setAttribute('hao', new THREE.BufferAttribute(hao, 1));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0), 1.25);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-0.9, -0.3, -0.9), new THREE.Vector3(0.9, 2.4, 0.9));
  return g;
}

// ------------------------------------------------------------------ bind data

const _m4 = new THREE.Matrix4();

/** Bind-pose quaternion of a hand's canonical frame (model space) from a basis { X, Y, Z }. */
function basisQuat(b, out) {
  _m4.makeBasis(new THREE.Vector3(...b.X), new THREE.Vector3(...b.Y), new THREE.Vector3(...b.Z));
  return out.setFromRotationMatrix(_m4);
}

/** Bind-pose quaternion of a procedural hand's canonical frame, see humanModel.handBindBasis. */
export function handBindQuat(side, out = new THREE.Quaternion()) {
  return basisQuat(handBindBasis(side), out);
}

/** The procedural bind (humanModel.js BONES / LIMBS). */
export const SDF_BIND = Object.freeze({
  positions: BONES.map((b) => b.pos),
  limbs: { ...LIMBS, hipX: 0.09, shoulderY: 1.445 },
  handBasis: { R: handBindBasis('R'), L: handBindBasis('L') },
  refHeight: REF_HEIGHT,
  bodyScale: 1,
  version: 0,
});

/** Bind data of a realistic template (mirrored for left-handers: L/R bones swapped, x negated). */
export function realBind(tpl, handed, version) {
  const mir = handed === 'left';
  const positions = BONES.map((b, i) => {
    const p = tpl.bones[mir ? MIRROR_BONE[i] : i];
    return mir ? [-p[0], p[1], p[2]] : p;
  });
  const mirrorBasis = (b) => {
    const Y = [-b.Y[0], b.Y[1], b.Y[2]], Z = [-b.Z[0], b.Z[1], b.Z[2]];
    const X = [Y[1] * Z[2] - Y[2] * Z[1], Y[2] * Z[0] - Y[0] * Z[2], Y[0] * Z[1] - Y[1] * Z[0]];
    return { X, Y, Z };
  };
  const handBasis = mir ? { R: mirrorBasis(tpl.hand.L), L: mirrorBasis(tpl.hand.R) } : { R: tpl.hand.R, L: tpl.hand.L };
  return { positions, limbs: { ...tpl.limbs }, handBasis, refHeight: tpl.refHeight, bodyScale: tpl.refHeight / REF_HEIGHT, version, realistic: true };
}

// ------------------------------------------------------------------ the person

/**
 * @param {object} o
 * @param {object} [o.kit] kit fields (DEFAULT_KIT / kitFor)
 * @param {'right'|'left'} [o.handed]
 * @param {number|null} [o.height] m (null: kit.height, else the body's own height)
 * @param {0|1|'auto'} [o.lod] 'auto': switch by camera distance (setLodFor)
 * @param {'normal'|'fp'} [o.mode] fp: first-person body (visible LOD0 without head/arms + a
 *   full-body LOD1 shadow caster)
 * @param {THREE.Object3D|null} [o.racket] racket group (origin = grip) put in the racket hand
 * @param {'auto'|'procedural'} [o.source] 'procedural' never uses the baked athletes
 * @returns {{ root, rig, bones, skeleton, meshes, racket, handQuat, bind, realistic, setKit, setHanded,
 *   setLod, setLodFor, kit, handed, scale, dispose }}
 */
export function createSkinnedHuman({ kit = {}, handed = 'right', height = null, lod = 'auto', mode = 'normal', racket = null, source = 'auto' } = {}) {
  const root = new THREE.Group();
  root.name = mode === 'fp' ? 'fp-body' : 'human';
  const rig = new THREE.Group(); // scaled model space
  rig.name = 'human-rig';
  root.add(rig);

  const bones = {};
  const list = BONES.map((b) => {
    const bone = new THREE.Bone();
    bone.name = b.name;
    bones[b.name] = bone;
    return bone;
  });
  BONES.forEach((b, i) => {
    if (b.parent >= 0) list[b.parent].add(list[i]);
    else rig.add(list[i]);
  });
  const skeleton = new THREE.Skeleton(list);

  let curKit = { ...DEFAULT_KIT, ...kit };
  let hand = handed === 'left' ? 'left' : 'right';
  let fixedHeight = height;
  const meshes = { 0: null, 1: null, shadow: null };
  let lodNow = lod === 1 ? 1 : 0;
  let bind = SDF_BIND;
  let bindVersion = 0;
  let scale = 1;
  const qHand = { R: new THREE.Quaternion(), L: new THREE.Quaternion() };
  let disposed = false;
  let fpMaterial = null, shadowMaterial = null;

  const libNow = () => (source === 'procedural' ? null : peopleLib());

  function chooseBind() {
    const lib = libNow();
    bindVersion++;
    if (lib) {
      const tpl = lib.templates[curKit.body] || lib.templates.male;
      bind = realBind(tpl, hand, bindVersion);
    } else bind = { ...SDF_BIND, version: bindVersion };
    basisQuat(bind.handBasis.R, qHand.R);
    basisQuat(bind.handBasis.L, qHand.L);
    applyHeight();
  }
  function applyHeight() {
    const h = fixedHeight || curKit.height || (bind.realistic ? bind.refHeight : REF_HEIGHT);
    scale = h / bind.refHeight;
    rig.scale.setScalar(scale);
  }

  function geometryFor(l, fp) {
    const lib = libNow();
    if (lib && bind.realistic) return buildRealGeometry(lib, curKit.body, l, curKit, hand, { fp });
    return buildHumanGeometry(l, curKit, hand, { fp });
  }
  function materialFor(fp) {
    const lib = libNow();
    const real = !!(lib && bind.realistic);
    if (!fp) return real ? realMaterial(lib) : humanMaterial();
    if (!fpMaterial || !!fpMaterial.userData.real !== real) {
      fpMaterial?.dispose();
      fpMaterial = real ? createRealHumanMaterial(lib, { fp: true }) : createHumanMaterial({ fp: true });
      fpMaterial.userData.real = real;
    }
    return fpMaterial;
  }

  function makeMesh(l, material, fp = false) {
    const g = geometryFor(l, fp);
    const m = new THREE.SkinnedMesh(g, material);
    m.name = `${root.name}-lod${l}`;
    rig.add(m);
    rig.updateMatrixWorld(true);
    m.bind(skeleton, m.matrixWorld);
    m.boundingSphere = g.boundingSphere.clone();
    m.receiveShadow = true;
    m.castShadow = true;
    return m;
  }

  function buildMeshes() {
    for (const k of ['0', '1', 'shadow']) {
      const m = meshes[k];
      if (m) {
        rig.remove(m);
        if (!m.userData.sharedGeometry) m.geometry.dispose();
        meshes[k] = null;
      }
    }
    chooseBind();
    // Bind at the rest pose: the rig is reset to identity while binding.
    const saved = root.matrix.clone();
    root.position.set(0, 0, 0);
    root.quaternion.identity();
    for (const b of list) b.quaternion.identity();
    BONES.forEach((b, i) => {
      const p = bind.positions[i];
      if (b.parent >= 0) {
        const pp = bind.positions[b.parent];
        list[i].position.set(p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]);
      } else list[i].position.set(p[0], p[1], p[2]);
    });
    root.updateMatrixWorld(true);
    skeleton.calculateInverses();
    if (mode === 'fp') {
      meshes[0] = makeMesh(0, materialFor(true), true);
      // Torso and legs only: a tight bound for frustum culling (model space, below the chest).
      meshes[0].boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.62, 0.02), 0.85);
      meshes[0].castShadow = false;
      meshes.shadow = makeMesh(1, shadowMaterial || (shadowMaterial = shadowOnlyMaterial()));
      meshes.shadow.receiveShadow = false;
      meshes.shadow.renderOrder = -10;
    } else {
      const mat = materialFor(false);
      if (lod === 'auto' || lod === 0) meshes[0] = makeMesh(0, mat);
      if (lod === 'auto' || lod === 1) meshes[1] = makeMesh(1, mat);
      // Near people draw the detailed mesh but cast their shadow from the light one (the shadow
      // passes of two key lights would otherwise draw the detailed mesh twice more).
      if (meshes[0] && meshes[1]) {
        const sm = new THREE.SkinnedMesh(meshes[1].geometry, shadowMaterial || (shadowMaterial = shadowOnlyMaterial()));
        sm.name = `${root.name}-shadow`;
        rig.add(sm);
        rig.updateMatrixWorld(true);
        sm.bind(skeleton, sm.matrixWorld);
        sm.boundingSphere = meshes[1].geometry.boundingSphere.clone();
        sm.castShadow = true;
        sm.receiveShadow = false;
        sm.renderOrder = -10;
        sm.userData.sharedGeometry = true;
        meshes.shadow = sm;
        meshes[0].castShadow = false;
      }
      applyLod();
    }
    saved.decompose(root.position, root.quaternion, root.scale);
    root.updateMatrixWorld(true);
    attachRacket();
  }

  function applyLod() {
    if (mode === 'fp') return;
    if (meshes[0]) meshes[0].visible = lodNow === 0 || !meshes[1];
    if (meshes[1]) meshes[1].visible = lodNow === 1 || !meshes[0];
    if (meshes.shadow) meshes.shadow.visible = !!(meshes[0] && meshes[0].visible);
  }

  // Racket in the racket hand: canonical grip (handPose.racketInHand) expressed in the hand bone's
  // local frame (bind rotations are identity, so the canonical frame is the bind basis).
  let racketObj = racket;
  const rihPos = new THREE.Vector3();
  const rihQuat = new THREE.Quaternion();
  function attachRacket() {
    if (!racketObj) return;
    const side = hand === 'left' ? 'L' : 'R';
    const r = racketInHand(hand);
    rihPos.copy(r.pos).applyQuaternion(qHand[side]);
    rihQuat.copy(qHand[side]).multiply(r.quat);
    bones[`hand${side}`].add(racketObj);
    racketObj.position.copy(rihPos);
    racketObj.quaternion.copy(rihQuat);
    racketObj.userData.setHanded?.(hand);
  }

  buildMeshes();
  // The baked athletes arrive after this person was built: rebuild once with them.
  if (!bind.realistic && source !== 'procedural') {
    onPeopleReady(() => {
      if (!disposed && !bind.realistic) {
        buildMeshes();
        requestWarmup(root);
        api.onRebuild?.(api);
      }
    });
  }

  const api = {
    root,
    rig,
    bones,
    skeleton,
    meshes,
    get racket() { return racketObj; },
    set racket(r) {
      if (racketObj && racketObj.parent) racketObj.parent.remove(racketObj);
      racketObj = r;
      attachRacket();
    },
    /** Canonical hand-frame bind quaternions (model space) per side. */
    handQuat: qHand,
    /** Bind skeleton: { positions, limbs, handBasis, refHeight, bodyScale, version, realistic? }. */
    get bind() { return bind; },
    get realistic() { return !!bind.realistic; },
    get kit() { return curKit; },
    get handed() { return hand; },
    get scale() { return scale; },
    get lod() { return lodNow; },
    mode,
    /** Called after the person rebuilt itself (the baked athletes arrived). */
    onRebuild: null,
    setHeight(h) {
      fixedHeight = h || null;
      applyHeight();
    },
    setKit(k) {
      const prevBody = curKit.body;
      curKit = { ...DEFAULT_KIT, ...curKit, ...k };
      void prevBody;
      buildMeshes();
    },
    setHanded(h) {
      const n = h === 'left' ? 'left' : 'right';
      if (n === hand) return;
      hand = n;
      buildMeshes();
    },
    setLod(l) {
      lodNow = l ? 1 : 0;
      applyLod();
    },
    /** Distance-based level of detail with hysteresis (camera within 8 m: LOD0, beyond 10 m: LOD1). */
    setLodFor(camPos) {
      if (lod !== 'auto') return;
      const d = Math.hypot(camPos.x - root.position.x, camPos.z - root.position.z);
      const want = lodNow === 0 ? (d > 10 ? 1 : 0) : (d < 8 ? 0 : 1);
      if (want !== lodNow) {
        lodNow = want;
        applyLod();
      }
    },
    /** Triangles drawn per view for this person (current LOD). */
    get triangles() {
      const m = mode === 'fp' ? meshes[0] : meshes[lodNow] || meshes[0] || meshes[1];
      return m ? m.geometry.index.count / 3 : 0;
    },
    dispose() {
      disposed = true;
      for (const k of ['0', '1', 'shadow']) if (meshes[k] && !meshes[k].userData.sharedGeometry) meshes[k].geometry.dispose();
      skeleton.dispose();
      fpMaterial?.dispose();
    },
  };
  return api;
}

export const KIT_OPTIONS = Object.freeze({ HAIR_STYLE_NAMES, HEADWEAR_NAMES, SKIN_TONES, HAIR_COLORS });
