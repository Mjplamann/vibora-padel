// Realistic athlete assets (assets/people/*, baked by tools/people/bake.mjs from the MakeHuman 1.1
// CC0 base mesh, targets, weights and proxies): one GLB with the male and female bodies (LOD0 /
// LOD1, clothes, shoes, eyes, brows, lashes), hair styles and headwear, plus two textures (the skin
// detail atlas and the hair / eye atlas). Loaded once, lazily, in the background; until it arrives
// (or if it fails: offline without the files) the procedural humans (humanModel.js) stand in.
// The GLB reader is minimal (this project's own files only): accessors -> typed arrays.

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** Parses a GLB written by tools/people/glb.mjs -> { json, meshes: { name: { attributes, index } } }. */
export function parseGlb(buffer) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a glb');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen)));
  const binStart = 20 + jsonLen + 8;
  const acc = (i) => {
    const a = json.accessors[i];
    const bv = json.bufferViews[a.bufferView];
    const T = COMPONENT[a.componentType];
    const n = a.count * SIZE[a.type];
    // Copy out (aligned, owned): attribute buffers outlive the file buffer.
    const src = new T(buffer.slice(binStart + (bv.byteOffset || 0), binStart + (bv.byteOffset || 0) + n * T.BYTES_PER_ELEMENT));
    return { array: src, itemSize: SIZE[a.type], normalized: !!a.normalized };
  };
  const meshes = {};
  for (const m of json.meshes) {
    const prim = m.primitives[0];
    const attributes = {};
    for (const [k, i] of Object.entries(prim.attributes)) attributes[k] = acc(i);
    meshes[m.name] = { attributes, index: acc(prim.indices).array };
  }
  return { json, meshes };
}

let promise = null;
let lib = null;
let failed = false;
const listeners = new Set();

/** Base URL of the asset folder (relative to this module, so the site works from any sub-path). */
export const PEOPLE_URL = new URL('../../assets/people/', import.meta.url).href;

/**
 * Starts (once) loading the athlete library. Resolves to the library or null when unavailable.
 * opts.textures: (url) => Promise<THREE.Texture> (browser texture loader; omitted in tests).
 */
export function loadPeopleAssets({ fetchImpl = globalThis.fetch, textures = null } = {}) {
  if (promise) return promise;
  if (typeof fetchImpl !== 'function') {
    failed = true;
    promise = Promise.resolve(null);
    return promise;
  }
  promise = fetchImpl(`${PEOPLE_URL}athletes.glb`)
    .then((r) => {
      if (!r.ok) throw new Error(`athletes.glb ${r.status}`);
      return r.arrayBuffer();
    })
    .then(async (buf) => {
      const glb = parseGlb(buf);
      const extras = glb.json.scenes[0].extras;
      const tex = textures ? await Promise.all([textures(`${PEOPLE_URL}${extras.textures.skin.file}.webp`, 'skin'), textures(`${PEOPLE_URL}${extras.textures.hair.file}.webp`, 'hair')]) : [null, null];
      lib = {
        meta: extras,
        templates: Object.fromEntries(Object.entries(extras.templates).map(([name, t]) => [name, buildTemplate(t, glb.meshes, name)])),
        textures: { skin: tex[0], hair: tex[1] },
      };
      for (const f of listeners) f(lib);
      listeners.clear();
      return lib;
    })
    .catch(() => {
      failed = true;
      return null;
    });
  return promise;
}

function buildTemplate(t, meshes, name) {
  const parts = {};
  for (const key of Object.keys(t.meshes)) parts[key.slice(name.length + 1)] = meshes[key];
  return { ...t, parts };
}

/** The loaded library (sync), or null while loading / when unavailable. */
export function peopleLib() {
  return lib;
}
/** True once loading failed (procedural humans stay). */
export function peopleFailed() {
  return failed;
}
/**
 * Asks for a shader warm-up of the scene holding `obj` (people rebuilt with the realistic material
 * after the first frames): render/scene.js warmShaders re-runs when scene.userData.peopleVersion
 * changes, so the new programs compile in one batch instead of as a hitch on first draw.
 */
export function requestWarmup(obj) {
  let top = obj;
  while (top && top.parent) top = top.parent;
  if (top && top.isScene) top.userData.peopleVersion = (top.userData.peopleVersion || 0) + 1;
}
/** Calls f(lib) when the library is ready (now, if it already is). */
export function onPeopleReady(f) {
  if (lib) f(lib);
  else listeners.add(f);
}
