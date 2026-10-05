// Minimal glTF 2.0 binary writer for the baked athletes: meshes with arbitrary vertex attributes
// (custom ones prefixed with "_", as glTF allows), one buffer, data in scene extras. Pure Node.
const COMPONENT = new Map([[Float32Array, 5126], [Uint32Array, 5125], [Uint16Array, 5123], [Int16Array, 5122], [Uint8Array, 5121], [Int8Array, 5120]]);
const TYPE = { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' };

/**
 * @param {{ meshes: { name: string, attributes: Record<string, { array: TypedArray, itemSize: number, normalized?: boolean }>, index: Uint16Array|Uint32Array, extras?: object }[], extras?: object }} doc
 * @returns {Buffer}
 */
export function writeGlb(doc) {
  const chunks = [];
  let offset = 0;
  const bufferViews = [], accessors = [];
  function addArray(arr, itemSize, normalized, target, withBounds) {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
    const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    chunks.push(buf);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, ...(target ? { target } : {}) });
    offset += buf.length;
    const acc = { bufferView: bufferViews.length - 1, componentType: COMPONENT.get(arr.constructor), count: arr.length / itemSize, type: TYPE[itemSize] };
    if (normalized) acc.normalized = true;
    if (withBounds) {
      const mn = new Array(itemSize).fill(Infinity), mx = new Array(itemSize).fill(-Infinity);
      for (let i = 0; i < arr.length; i++) { const k = i % itemSize; if (arr[i] < mn[k]) mn[k] = arr[i]; if (arr[i] > mx[k]) mx[k] = arr[i]; }
      acc.min = mn; acc.max = mx;
    }
    accessors.push(acc);
    return accessors.length - 1;
  }
  const meshes = doc.meshes.map((m) => {
    const attributes = {};
    for (const [name, a] of Object.entries(m.attributes)) attributes[name] = addArray(a.array, a.itemSize, a.normalized, 34962, name === 'POSITION');
    const indices = addArray(m.index, 1, false, 34963, false);
    return { name: m.name, primitives: [{ attributes, indices, mode: 4 }], ...(m.extras ? { extras: m.extras } : {}) };
  });
  const json = {
    asset: { version: '2.0', generator: 'vibora-padel tools/people/bake.mjs' },
    scene: 0,
    scenes: [{ nodes: meshes.map((_, i) => i), extras: doc.extras || {} }],
    nodes: meshes.map((m, i) => ({ mesh: i, name: m.name })),
    meshes, accessors, bufferViews,
    buffers: [{ byteLength: offset }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]);
  let bin = Buffer.concat(chunks);
  if (bin.length % 4) bin = Buffer.concat([bin, Buffer.alloc(4 - (bin.length % 4))]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}
