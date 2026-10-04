// Smooth skinned athletes (coach, AI players, the player's own body). The body template from
// humanModel.js (signed-distance anatomy, clothing shells, smooth weights) becomes one SkinnedMesh
// per person and level of detail, all sharing one physical material: kit colours, baked ambient
// occlusion and per-region surface parameters (roughness, fabric sheen + knit normal, skin wrap
// lighting) are vertex attributes, so a whole person is one draw call (plus the racket).
import * as THREE from 'three';
import {
  humanTemplate, assembleHuman, BONES, REGION, PART, handBindBasis, REF_HEIGHT, LIMBS, HAIR_STYLE_NAMES, HEADWEAR_NAMES, hairlineY, HEAD_OFFSET,
} from './humanModel.js';
import { knitNormalTexture } from './actorKit.js';
import { racketInHand } from './handPose.js';

export { BONES, LIMBS, REF_HEIGHT };

// ------------------------------------------------------------------ kits

export const SKIN_TONES = ['#f2cdb0', '#e3b08e', '#c99170', '#a8714f', '#875638', '#5f3b27'];
export const HAIR_COLORS = ['#16110e', '#2a1d16', '#47301f', '#6f4a2c', '#9c7247', '#c9a46b', '#3a3a3a'];
const SHIRTS = [
  ['#e8572a', '#1d2b4a'], ['#eef1f4', '#1d2b4a'], ['#c8263c', '#16181d'], ['#1f6fd1', '#eef1f4'], ['#14a37f', '#0f1b2e'],
  ['#f2c21b', '#16181d'], ['#7a3fc4', '#eef1f4'], ['#16181d', '#d7ff3a'], ['#2b9be8', '#16181d'], ['#f06a9b', '#1b1b25'],
];
const SHORTS = ['#16181d', '#1b2a44', '#eef1f4', '#2b2f36', '#0f1b2e'];
const SHOES = [['#f4f4f4', '#e8572a'], ['#16181d', '#d7ff3a'], ['#eef1f4', '#1f6fd1'], ['#f4f4f4', '#14a37f'], ['#2b2f36', '#f06a9b']];

/** Default kit (every field may be overridden). */
export const DEFAULT_KIT = Object.freeze({
  skin: '#c58c6a', shirt: '#1d2b4a', trim: '#e8572a', shorts: '#10131a', shortsTrim: '#e8572a', sock: '#f2f2ef',
  shoe: '#f4f4f4', sole: '#e8e5de', shoeAccent: '#e8572a', lace: '#fbfbfb', hair: '#2a1d16', headwear: '#e8572a',
  headwearAccent: '#1d2b4a', band: '#f4f4f2', iris: '#4a3423', hairStyle: 'short', headwearKind: 'none',
  sockHeight: 0.11, wristband: 'racket', panels: true,
});

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * A plausible club kit from a seed string (deterministic): shirt + trim, shorts, shoes, skin tone,
 * hair colour and style, headwear. `base` fields win (team colours, the coach's orange shirt).
 */
export function kitFor(seed, base = {}) {
  let h = hashStr(String(seed));
  const pick = (arr) => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    return arr[h % arr.length];
  };
  const shirt = pick(SHIRTS);
  const shoe = pick(SHOES);
  const kit = {
    ...DEFAULT_KIT,
    shirt: shirt[0], trim: shirt[1], shorts: pick(SHORTS), shortsTrim: shirt[0],
    shoe: shoe[0], shoeAccent: shoe[1], skin: pick(SKIN_TONES), hair: pick(HAIR_COLORS),
    hairStyle: pick(HAIR_STYLE_NAMES), headwearKind: pick(['none', 'cap', 'visor', 'headband', 'none']),
    headwear: pick(['#eef1f4', '#16181d', shirt[0], shirt[1]]), headwearAccent: shirt[1],
    iris: pick(['#4a3423', '#2f4f6f', '#3e5b3a', '#6b4b2a']), sockHeight: pick([0.06, 0.11, 0.14]),
    wristband: pick(['racket', 'both', null]), panels: pick([true, false]),
  };
  if (kit.hairStyle === 'bun' || kit.hairStyle === 'ponytail') kit.headwearKind = pick(['none', 'visor', 'headband']);
  return { ...kit, ...base };
}

// ------------------------------------------------------------------ material

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

/**
 * The human material. fp: the first-person body (head and arms are not drawn — the first-person
 * rig draws the forearms and hands — and everything within `near` of the eye dissolves with a
 * screen-space dither, like a VR body). shadowOnly: writes nothing (the shadow pass still draws it).
 */
export function createHumanMaterial({ fp = false, shadowOnly = false } = {}) {
  if (shadowOnly) {
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
  const knit = knitNormalTexture();
  const m = new THREE.MeshPhysicalMaterial({
    vertexColors: true, roughness: 1, metalness: 0, sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color('#ffffff'),
    normalMap: knit, normalScale: new THREE.Vector2(0.42, 0.42), specularIntensity: 0.6,
  });
  m.name = fp ? 'human-fp' : 'human';
  // First-person dissolve: by height below the eye (the shoulders and the top of the chest right
  // under the camera), and by distance for anything at the lens.
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
      fs = fs.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
	if ( vHumanPart > 0.5 ) discard;
	float fpFade = min( smoothstep( fpNear, fpFar, fpEyeY - vHumanWorldY ), smoothstep( 0.1, 0.16, length( vViewPosition ) ) );
	float fpDither = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
	if ( fpFade < 0.999 && fpFade <= fpDither ) discard;`)
        // Seen through the dissolved shoulders: the inside of the shirt, dark.
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

// ------------------------------------------------------------------ geometry

const _c = new THREE.Color();
const _c2 = new THREE.Color();
const ARM_SHOULDER = { R: BONES.find((b) => b.name === 'upperArmR').pos, L: BONES.find((b) => b.name === 'upperArmL').pos };
const ARM_DIR = { R: [-Math.sin(0.349), -Math.cos(0.349), 0], L: [Math.sin(0.349), -Math.cos(0.349), 0] };

/** Albedo (linear) and surface parameters of one vertex for a kit. */
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
      // Eyebrows and lips (soft paint), a little colour in the cheeks and ears.
      const brow = p.aux[v * 2], lip = p.aux[v * 2 + 1];
      _c.copy(cache.skin);
      if (lip > 0) _c.lerp(cache.lip, lip * 0.75);
      if (brow > 0) _c.lerp(cache.brow, brow * 0.85);
      const cheek = Math.exp(-(((ax - 0.045) / 0.02) ** 2 + ((y - 1.668 - HEAD_OFFSET) / 0.02) ** 2 + ((z - 0.06) / 0.03) ** 2));
      if (cheek > 0.01) _c.lerp(cache.blush, cheek * 0.12);
      // Scalp under the hair: hair colour fading out just below the hairline (no "swim cap" edge).
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
      // Sleeve hem.
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
    racketSide: handed === 'left' ? 'L' : 'R',
    byRegion: {
      [REGION.SHOE]: lin(kit.shoe), [REGION.SOLE]: lin(kit.sole), [REGION.SHOE_ACCENT]: lin(kit.shoeAccent), [REGION.LACE]: lin(kit.lace),
      [REGION.HAIR]: lin(kit.hair), [REGION.HEADWEAR]: lin(kit.headwear), [REGION.HEADWEAR_ACCENT]: lin(kit.headwearAccent),
      [REGION.EYE]: lin('#cfc6b8'), [REGION.IRIS]: lin(kit.iris), [REGION.PUPIL]: lin('#070707'), [REGION.BAND]: lin(kit.band),
      [REGION.TRIM]: lin(kit.trim),
    },
  };
}

/** One person's BufferGeometry (shared bone layout) for a template LOD, kit and handedness. */
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

// ------------------------------------------------------------------ the person

const _m4 = new THREE.Matrix4();

/** Bind-pose quaternion of a hand's canonical frame (model space), see humanModel.handBindBasis. */
export function handBindQuat(side, out = new THREE.Quaternion()) {
  const { X, Y, Z } = handBindBasis(side);
  _m4.makeBasis(new THREE.Vector3(...X), new THREE.Vector3(...Y), new THREE.Vector3(...Z));
  return out.setFromRotationMatrix(_m4);
}

/**
 * @param {object} o
 * @param {object} [o.kit] kit fields (DEFAULT_KIT / kitFor)
 * @param {'right'|'left'} [o.handed]
 * @param {number} [o.height] m (the template is a 1.80 m athlete, scaled uniformly)
 * @param {0|1|'auto'} [o.lod] 'auto': switch by camera distance (setLodFor)
 * @param {'normal'|'fp'} [o.mode] fp: first-person body (visible LOD0 without head/arms + a
 *   full-body LOD1 shadow caster)
 * @param {THREE.Object3D|null} [o.racket] racket group (origin = grip) put in the racket hand
 * @returns {{ root, rig, bones, skeleton, meshes, racket, handQuat, setKit, setHanded, setLod,
 *   setLodFor, kit, handed, scale, dispose }}
 */
export function createSkinnedHuman({ kit = {}, handed = 'right', height = REF_HEIGHT, lod = 'auto', mode = 'normal', racket = null } = {}) {
  const root = new THREE.Group();
  root.name = mode === 'fp' ? 'fp-body' : 'human';
  const rig = new THREE.Group(); // scaled model space
  rig.name = 'human-rig';
  root.add(rig);
  let scale = height / REF_HEIGHT;
  rig.scale.setScalar(scale);

  // Skeleton at bind pose (identity rotations, offsets from the parent).
  const bones = {};
  const list = BONES.map((b) => {
    const bone = new THREE.Bone();
    bone.name = b.name;
    bones[b.name] = bone;
    return bone;
  });
  BONES.forEach((b, i) => {
    const bone = list[i];
    if (b.parent >= 0) {
      const pp = BONES[b.parent].pos;
      bone.position.set(b.pos[0] - pp[0], b.pos[1] - pp[1], b.pos[2] - pp[2]);
      list[b.parent].add(bone);
    } else {
      bone.position.set(b.pos[0], b.pos[1], b.pos[2]);
      rig.add(bone);
    }
  });
  rig.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(list);

  let curKit = { ...DEFAULT_KIT, ...kit };
  let hand = handed === 'left' ? 'left' : 'right';
  const meshes = { 0: null, 1: null, shadow: null };
  let lodNow = lod === 1 ? 1 : 0;

  function makeMesh(l, material, fp = false) {
    const g = buildHumanGeometry(l, curKit, hand, { fp });
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
    // Bind at the rest pose: the rig is reset to identity while binding.
    const saved = root.matrix.clone();
    root.position.set(0, 0, 0);
    root.quaternion.identity();
    for (const b of list) b.quaternion.identity();
    BONES.forEach((b, i) => {
      if (b.parent >= 0) {
        const pp = BONES[b.parent].pos;
        list[i].position.set(b.pos[0] - pp[0], b.pos[1] - pp[1], b.pos[2] - pp[2]);
      } else list[i].position.set(b.pos[0], b.pos[1], b.pos[2]);
    });
    root.updateMatrixWorld(true);
    skeleton.calculateInverses();
    if (mode === 'fp') {
      meshes[0] = makeMesh(0, fpMaterial || (fpMaterial = createHumanMaterial({ fp: true })), true);
      // Torso and legs only: a tight bound for frustum culling (model space, below the chest).
      meshes[0].boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.62, 0.02), 0.85);
      meshes[0].castShadow = false;
      meshes.shadow = makeMesh(1, shadowMaterial || (shadowMaterial = createHumanMaterial({ shadowOnly: true })));
      meshes.shadow.receiveShadow = false;
      meshes.shadow.renderOrder = -10;
    } else {
      const mat = humanMaterial();
      if (lod === 'auto' || lod === 0) meshes[0] = makeMesh(0, mat);
      if (lod === 'auto' || lod === 1) meshes[1] = makeMesh(1, mat);
      // Near people draw the detailed mesh but cast their shadow from the light one (the shadow
      // passes of two key lights would otherwise draw the detailed mesh twice more).
      if (meshes[0] && meshes[1]) {
        const sm = new THREE.SkinnedMesh(meshes[1].geometry, shadowMaterial || (shadowMaterial = createHumanMaterial({ shadowOnly: true })));
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
  let fpMaterial = null, shadowMaterial = null;

  function applyLod() {
    if (mode === 'fp') return;
    if (meshes[0]) meshes[0].visible = lodNow === 0 || !meshes[1];
    if (meshes[1]) meshes[1].visible = lodNow === 1 || !meshes[0];
    if (meshes.shadow) meshes.shadow.visible = !!(meshes[0] && meshes[0].visible);
  }

  // Racket in the racket hand: canonical grip (handPose.racketInHand) expressed in the hand bone's
  // local frame (bind rotations are identity, so the canonical frame is the bind basis).
  const qHand = { R: handBindQuat('R'), L: handBindQuat('L') };
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
    get kit() { return curKit; },
    get handed() { return hand; },
    get scale() { return scale; },
    get lod() { return lodNow; },
    mode,
    setHeight(h) {
      scale = (h || REF_HEIGHT) / REF_HEIGHT;
      rig.scale.setScalar(scale);
    },
    setKit(k) {
      curKit = { ...DEFAULT_KIT, ...curKit, ...k };
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
      for (const k of ['0', '1', 'shadow']) if (meshes[k] && !meshes[k].userData.sharedGeometry) meshes[k].geometry.dispose();
      skeleton.dispose();
      fpMaterial?.dispose();
    },
  };
  return api;
}

export const KIT_OPTIONS = Object.freeze({ HAIR_STYLE_NAMES, HEADWEAR_NAMES, SKIN_TONES, HAIR_COLORS });
