// Binary glTF writer. Each mesh becomes one node, so one MeshPart in Roblox.
// Vertices are stored relative to the mesh centre, with the centre on the node.

const align4 = n => (n + 3) & ~3;

/**
 * meshes: [{name, center:[3], positions:Float32Array, normals:Float32Array, uvs?:Float32Array,
 *           indices:Uint32Array, material?:index}]
 * materials: [{name, png?:Buffer, normalPng?:Buffer, alpha?:'BLEND'|'MASK', color?:[r,g,b,a]}] (optional)
 */
export function writeGlb(meshes, materials = []) {
  const views = [], accessors = [], chunks = [];
  let offset = 0;
  const addView = (buf, target) => {
    const pad = align4(buf.length) - buf.length;
    views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, ...(target ? { target } : {}) });
    chunks.push(buf);
    if (pad) chunks.push(Buffer.alloc(pad));
    offset += buf.length + pad;
    return views.length - 1;
  };
  const typed = t => Buffer.from(t.buffer, t.byteOffset, t.byteLength);

  const gltfMeshes = [], nodes = [];
  meshes.forEach((m, i) => {
    const count = m.positions.length / 3;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < count; v++) {
      for (let k = 0; k < 3; k++) {
        const x = m.positions[v * 3 + k];
        if (x < min[k]) min[k] = x;
        if (x > max[k]) max[k] = x;
      }
    }
    accessors.push({ bufferView: addView(typed(m.positions), 34962), componentType: 5126, count, type: 'VEC3', min, max });
    const POSITION = accessors.length - 1;
    accessors.push({ bufferView: addView(typed(m.normals), 34962), componentType: 5126, count, type: 'VEC3' });
    const NORMAL = accessors.length - 1;
    const attributes = { POSITION, NORMAL };
    if (m.uvs) {
      accessors.push({ bufferView: addView(typed(m.uvs), 34962), componentType: 5126, count, type: 'VEC2' });
      attributes.TEXCOORD_0 = accessors.length - 1;
    }
    accessors.push({ bufferView: addView(typed(m.indices), 34963), componentType: 5125, count: m.indices.length, type: 'SCALAR' });
    const primitive = { attributes, indices: accessors.length - 1, mode: 4 };
    if (m.material !== undefined) primitive.material = m.material;
    gltfMeshes.push({ name: m.name, primitives: [primitive] });
    nodes.push({ name: m.name, mesh: i, translation: m.center });
  });

  const images = [], textures = [], gltfMats = [];
  const addImage = png => {
    images.push({ bufferView: addView(png), mimeType: 'image/png' });
    textures.push({ source: images.length - 1 });
    return textures.length - 1;
  };
  for (const mt of materials) {
    const pbr = { metallicFactor: 0, roughnessFactor: 0.8 };
    if (mt.color) pbr.baseColorFactor = mt.color;
    if (mt.png) pbr.baseColorTexture = { index: addImage(mt.png) };
    const g = { name: mt.name, pbrMetallicRoughness: pbr };
    if (mt.normalPng) g.normalTexture = { index: addImage(mt.normalPng) };
    if (mt.alpha) g.alphaMode = mt.alpha;
    gltfMats.push(g);
  }

  const json = {
    asset: { version: '2.0', generator: 'SourceMapImporter' },
    scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes, meshes: gltfMeshes, accessors, bufferViews: views,
    buffers: [{ byteLength: offset }],
  };
  if (gltfMats.length) json.materials = gltfMats;
  if (images.length) { json.images = images; json.textures = textures; }

  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = align4(jsonBuf.length) - jsonBuf.length;
  const bin = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + jsonPad + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonBuf.length + jsonPad, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonBuf, Buffer.alloc(jsonPad, 0x20), bh, bin]);
}
