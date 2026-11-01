// Source BSP reader. Handles v19-v21, including the L4D2 lump-header variant,
// LZMA-compressed lumps and compressed game lumps.
import { decodeValveLzma } from './lzma.js';

export const LUMP = {
  ENTITIES: 0, PLANES: 1, TEXDATA: 2, VERTEXES: 3, VISIBILITY: 4, NODES: 5, TEXINFO: 6, FACES: 7,
  LEAFS: 10, EDGES: 12, SURFEDGES: 13, MODELS: 14, LEAFFACES: 16, LEAFBRUSHES: 17, BRUSHES: 18,
  BRUSHSIDES: 19, AREAS: 20, DISPINFO: 26, ORIGINALFACES: 27, DISP_VERTS: 33, GAME_LUMP: 35,
  PAKFILE: 40, TEXDATA_STRING_DATA: 43, TEXDATA_STRING_TABLE: 44, OVERLAYS: 45,
  DISP_TRIS: 48,
};

export const CONTENTS = {
  SOLID: 0x1, WINDOW: 0x2, GRATE: 0x8, WATER: 0x20, SLIME: 0x10, MOVEABLE: 0x4000,
  PLAYERCLIP: 0x10000, MONSTERCLIP: 0x20000, DETAIL: 0x8000000, TRANSLUCENT: 0x10000000,
};
export const SURF = {
  LIGHT: 0x1, SKY2D: 0x2, SKY: 0x4, WARP: 0x8, TRANS: 0x10, NOPORTAL: 0x20, TRIGGER: 0x40,
  NODRAW: 0x80, HINT: 0x100, SKIP: 0x200, NOLIGHT: 0x400,
};

const f32 = (b, o) => b.readFloatLE(o);

function parseEntities(text) {
  const ents = [];
  let cur = null;
  const re = /"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"|([{}])/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[3] === '{') cur = {};
    else if (m[3] === '}') { if (cur) ents.push(cur); cur = null; } else if (cur) {
      // Repeated keys (connections) are kept as the first value.
      if (!(m[1] in cur)) cur[m[1]] = m[2];
    }
  }
  return ents;
}

export function parseBsp(buf) {
  if (buf.toString('latin1', 0, 4) !== 'VBSP') throw new Error('not a Source BSP (missing VBSP header)');
  const version = buf.readInt32LE(4);
  if (version < 19 || version > 25) throw new Error(`unsupported BSP version ${version}`);

  // Standard lump_t is {ofs,len,ver,fourCC}; L4D2 swapped to {ver,ofs,len,fourCC}.
  // Telling them apart: the entity lump's ofs must fall inside the file and past the header.
  const headerEnd = 8 + 64 * 16 + 4;
  const readLump = (i, swapped) => {
    const p = 8 + i * 16;
    const a = buf.readInt32LE(p), b = buf.readInt32LE(p + 4), c = buf.readInt32LE(p + 8);
    return swapped
      ? { ofs: b, len: c, ver: a, fourCC: buf.readInt32LE(p + 12) }
      : { ofs: a, len: b, ver: c, fourCC: buf.readInt32LE(p + 12) };
  };
  const sane = l => l.ofs >= headerEnd && l.len > 0 && l.ofs + l.len <= buf.length;
  let swapped = false;
  if (version === 21) {
    const std = readLump(LUMP.PLANES, false), alt = readLump(LUMP.PLANES, true);
    swapped = !sane(std) && sane(alt);
    if (!swapped && sane(std) && sane(alt)) {
      // Planes are 20 bytes each. Only the true length divides cleanly.
      swapped = std.len % 20 !== 0 && alt.len % 20 === 0;
    }
  }
  const lumps = [];
  for (let i = 0; i < 64; i++) lumps.push(readLump(i, swapped));

  const raw = i => {
    const l = lumps[i];
    if (!l.len) return Buffer.alloc(0);
    const b = buf.subarray(l.ofs, l.ofs + l.len);
    return decodeValveLzma(b) ?? b;
  };

  const map = { version, lumps, buf };

  map.entities = parseEntities(raw(LUMP.ENTITIES).toString('latin1').replace(/\0+$/, ''));

  const planesB = raw(LUMP.PLANES);
  const nPlanes = Math.floor(planesB.length / 20);
  map.planes = new Float32Array(nPlanes * 4);
  for (let i = 0; i < nPlanes; i++) {
    const o = i * 20;
    map.planes[i * 4] = f32(planesB, o);
    map.planes[i * 4 + 1] = f32(planesB, o + 4);
    map.planes[i * 4 + 2] = f32(planesB, o + 8);
    map.planes[i * 4 + 3] = f32(planesB, o + 12);
  }

  const vB = raw(LUMP.VERTEXES);
  map.verts = new Float32Array(vB.length / 4 | 0);
  for (let i = 0; i < map.verts.length; i++) map.verts[i] = f32(vB, i * 4);

  const eB = raw(LUMP.EDGES);
  map.edges = new Uint16Array(eB.length / 2 | 0);
  for (let i = 0; i < map.edges.length; i++) map.edges[i] = eB.readUInt16LE(i * 2);

  const seB = raw(LUMP.SURFEDGES);
  map.surfedges = new Int32Array(seB.length / 4 | 0);
  for (let i = 0; i < map.surfedges.length; i++) map.surfedges[i] = seB.readInt32LE(i * 4);

  // Material name tables
  const strData = raw(LUMP.TEXDATA_STRING_DATA);
  const strTab = raw(LUMP.TEXDATA_STRING_TABLE);
  const getStr = idx => {
    // Some shipped maps have corrupt entries here. Skip those, not the whole map.
    if (idx < 0 || idx * 4 + 4 > strTab.length) return '';
    const ofs = strTab.readInt32LE(idx * 4);
    if (ofs < 0 || ofs >= strData.length) return '';
    let e = ofs;
    while (e < strData.length && strData[e] !== 0) e++;
    return strData.toString('latin1', ofs, e);
  };
  const tdB = raw(LUMP.TEXDATA);
  map.texdata = [];
  for (let o = 0; o + 32 <= tdB.length; o += 32) {
    map.texdata.push({
      reflectivity: [f32(tdB, o), f32(tdB, o + 4), f32(tdB, o + 8)],
      name: getStr(tdB.readInt32LE(o + 12)).replace(/\\/g, '/').toLowerCase(),
      width: tdB.readInt32LE(o + 16), height: tdB.readInt32LE(o + 20),
    });
  }

  // A few bad names can be skipped. Mostly bad names means the file itself is damaged,
  // and importing it would produce garbage that looks like a successful port.
  const blank = map.texdata.filter(t => !t.name).length;
  if (map.texdata.length && blank / map.texdata.length > 0.05) {
    throw new Error(`this map file is damaged (${blank} of ${map.texdata.length} texture entries are invalid). Try re-downloading it, or use a different copy.`);
  }

  const tiB = raw(LUMP.TEXINFO);
  map.texinfo = [];
  for (let o = 0; o + 72 <= tiB.length; o += 72) {
    const v = [];
    for (let i = 0; i < 8; i++) v.push(f32(tiB, o + i * 4));
    map.texinfo.push({ s: v.slice(0, 4), t: v.slice(4, 8), flags: tiB.readInt32LE(o + 64), texdata: tiB.readInt32LE(o + 68) });
  }

  // dface_t is 56 bytes in every version we accept.
  const fB = raw(LUMP.FACES);
  map.faces = [];
  for (let o = 0; o + 56 <= fB.length; o += 56) {
    map.faces.push({
      plane: fB.readUInt16LE(o), side: fB[o + 2],
      firstEdge: fB.readInt32LE(o + 4), numEdges: fB.readInt16LE(o + 8),
      texinfo: fB.readInt16LE(o + 10), dispinfo: fB.readInt16LE(o + 12),
      area: f32(fB, o + 24),
    });
  }

  // Compiled per-vertex normals. These carry Hammer's smoothing groups, so
  // cylinders and arches shade smoothly instead of showing every facet.
  const vnB = raw(30), vniB = raw(31);
  map.vertNormals = new Float32Array(vnB.length / 4 | 0);
  for (let i = 0; i < map.vertNormals.length; i++) map.vertNormals[i] = f32(vnB, i * 4);
  map.vertNormalIndices = new Uint16Array(vniB.length / 2 | 0);
  for (let i = 0; i < map.vertNormalIndices.length; i++) map.vertNormalIndices[i] = vniB.readUInt16LE(i * 2);

  const mB = raw(LUMP.MODELS);
  map.models = [];
  for (let o = 0; o + 48 <= mB.length; o += 48) {
    map.models.push({
      mins: [f32(mB, o), f32(mB, o + 4), f32(mB, o + 8)],
      maxs: [f32(mB, o + 12), f32(mB, o + 16), f32(mB, o + 20)],
      origin: [f32(mB, o + 24), f32(mB, o + 28), f32(mB, o + 32)],
      headnode: mB.readInt32LE(o + 36), firstFace: mB.readInt32LE(o + 40), numFaces: mB.readInt32LE(o + 44),
    });
  }

  // Tree, for point-in-leaf queries (3D skybox detection).
  const nB = raw(LUMP.NODES);
  map.nodes = [];
  for (let o = 0; o + 32 <= nB.length; o += 32) {
    map.nodes.push({ plane: nB.readInt32LE(o), c0: nB.readInt32LE(o + 4), c1: nB.readInt32LE(o + 8), firstFace: nB.readUInt16LE(o + 24), numFaces: nB.readUInt16LE(o + 26) });
  }
  const lfL = lumps[LUMP.LEAFS];
  const lB = raw(LUMP.LEAFS);
  // v0 leafs carry a 24-byte ambient cube + padding (56 bytes); v1 leafs are 32.
  const leafSize = lfL.ver === 0 ? 56 : 32;
  map.leafs = [];
  for (let o = 0; o + leafSize <= lB.length; o += leafSize) {
    const af = lB.readInt16LE(o + 6);
    map.leafs.push({
      contents: lB.readInt32LE(o), cluster: lB.readInt16LE(o + 4), area: af & 0x1ff,
      firstLeafFace: lB.readUInt16LE(o + 20), numLeafFaces: lB.readUInt16LE(o + 22),
      firstLeafBrush: lB.readUInt16LE(o + 24), numLeafBrushes: lB.readUInt16LE(o + 26),
    });
  }
  const lbB = raw(LUMP.LEAFBRUSHES);
  map.leafBrushes = new Uint16Array(lbB.length / 2 | 0);
  for (let i = 0; i < map.leafBrushes.length; i++) map.leafBrushes[i] = lbB.readUInt16LE(i * 2);
  const lfB = raw(LUMP.LEAFFACES);
  map.leafFaces = new Uint16Array(lfB.length / 2 | 0);
  for (let i = 0; i < map.leafFaces.length; i++) map.leafFaces[i] = lfB.readUInt16LE(i * 2);

  // Brushes, used for collision and for water volumes.
  const bB = raw(LUMP.BRUSHES);
  map.brushes = [];
  for (let o = 0; o + 12 <= bB.length; o += 12) {
    map.brushes.push({ firstSide: bB.readInt32LE(o), numSides: bB.readInt32LE(o + 4), contents: bB.readInt32LE(o + 8) });
  }
  const bsB = raw(LUMP.BRUSHSIDES);
  map.brushSides = [];
  for (let o = 0; o + 8 <= bsB.length; o += 8) {
    map.brushSides.push({ plane: bsB.readUInt16LE(o), texinfo: bsB.readInt16LE(o + 2), disp: bsB.readInt16LE(o + 4), bevel: bsB.readInt16LE(o + 6) });
  }

  // Displacements. ddispinfo_t is 176 bytes, or larger in some engine branches.
  const dB = raw(LUMP.DISPINFO);
  map.dispInfos = [];
  const numDispFaces = map.faces.filter(f => f.dispinfo >= 0).length;
  const derived = numDispFaces ? Math.round(dB.length / numDispFaces) : 176;
  const dispSize = dB.length % 176 === 0 ? 176 : Math.max(derived, 176);
  for (let o = 0; o + dispSize <= dB.length; o += dispSize) {
    map.dispInfos.push({
      start: [f32(dB, o), f32(dB, o + 4), f32(dB, o + 8)],
      vertStart: dB.readInt32LE(o + 12), power: dB.readInt32LE(o + 20),
    });
  }
  const dvB = raw(LUMP.DISP_VERTS);
  map.dispVerts = new Float32Array(dvB.length / 4 | 0);
  for (let i = 0; i < map.dispVerts.length; i++) map.dispVerts[i] = f32(dvB, i * 4); // vec3,dist,alpha

  map.pak = raw(LUMP.PAKFILE);

  // Overlays: info_overlay, compiled straight into the BSP.
  const oB = raw(LUMP.OVERLAYS);
  map.overlays = [];
  for (let o = 0; o + 352 <= oB.length; o += 352) {
    const numFaces = oB.readInt16LE(o + 6) & 0x3fff;
    const faces = [];
    for (let i = 0; i < Math.min(numFaces, 64); i++) faces.push(oB.readInt32LE(o + 8 + i * 4));
    const q = o + 8 + 64 * 4;
    const uv = [f32(oB, q), f32(oB, q + 4), f32(oB, q + 8), f32(oB, q + 12)];
    const pts = [];
    for (let i = 0; i < 4; i++) pts.push([f32(oB, q + 16 + i * 12), f32(oB, q + 20 + i * 12), f32(oB, q + 24 + i * 12)]);
    const origin = [f32(oB, q + 64), f32(oB, q + 68), f32(oB, q + 72)];
    const norm = [f32(oB, q + 76), f32(oB, q + 80), f32(oB, q + 84)];
    map.overlays.push({ texinfo: oB.readInt16LE(o + 4), faces, uv, pts, origin, normal: norm });
  }

  map.gameLumps = parseGameLumps(buf, lumps[LUMP.GAME_LUMP], version);
  map.staticProps = parseStaticProps(buf, map.gameLumps);
  return map;
}

function parseGameLumps(buf, l) {
  const out = {};
  if (!l.len) return out;
  const count = buf.readInt32LE(l.ofs);
  let p = l.ofs + 4;
  const dir = [];
  for (let i = 0; i < count; i++, p += 16) {
    dir.push({
      id: buf.toString('latin1', p, p + 4).split('').reverse().join(''),
      flags: buf.readUInt16LE(p + 4), version: buf.readUInt16LE(p + 6),
      ofs: buf.readInt32LE(p + 8), len: buf.readInt32LE(p + 12),
    });
  }
  // Compressed game lumps end at the next entry's offset, because 'len' is the decompressed size.
  dir.forEach(e => {
    let data = buf.subarray(e.ofs, e.ofs + e.len);
    if (buf.toString('latin1', e.ofs, e.ofs + 4) === 'LZMA') {
      const dec = decodeValveLzma(buf.subarray(e.ofs));
      if (dec) data = dec;
    }
    out[e.id] = { version: e.version, data };
  });
  return out;
}

function parseStaticProps(buf, gameLumps) {
  const g = gameLumps.sprp;
  if (!g || g.data.length < 4) return [];
  const b = g.data;
  let p = 0;
  const nNames = b.readInt32LE(p); p += 4;
  const names = [];
  for (let i = 0; i < nNames; i++, p += 128) {
    let e = p;
    while (e < p + 128 && b[e] !== 0) e++;
    names.push(b.toString('latin1', p, e).replace(/\\/g, '/').toLowerCase());
  }
  const nLeaf = b.readInt32LE(p); p += 4 + nLeaf * 2;
  const nProps = b.readInt32LE(p); p += 4;
  if (!nProps) return [];
  // Entry size varies per version and per game branch, so derive it from the data.
  const size = Math.floor((b.length - p) / nProps);
  const ver = g.version;
  const props = [];
  for (let i = 0; i < nProps; i++) {
    const o = p + i * size;
    const r = {
      origin: [b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)],
      angles: [b.readFloatLE(o + 12), b.readFloatLE(o + 16), b.readFloatLE(o + 20)],
      model: names[b.readUInt16LE(o + 24)],
      solid: b[o + 30], flags: b[o + 31], skin: b.readInt32LE(o + 32), scale: 1,
      tint: [255, 255, 255, 255],
    };
    // Layout after 'skin' (v4 base):
    //  36 fademin, 40 fademax, 44 lighting origin(12) -> 56
    //  v5+: 56 forcedFadeScale -> 60
    //  v6/v7: 60 min/max dx (4) -> 64
    //  v7+: rendercolor at +4 past dx levels (v7: 64; v8: min/max cpu/gpu at 60 -> 64)
    //  v10 (64-byte-aligned branch): flags extras
    //  v11+: scale is the last float of the base record
    if (ver >= 7 && size >= 68) {
      const tintAt = 64;
      r.tint = [b[o + tintAt], b[o + tintAt + 1], b[o + tintAt + 2], b[o + tintAt + 3]];
    }
    if (ver >= 11 && size >= 80) {
      const s = b.readFloatLE(o + 76);
      if (s > 0.001 && s < 1000) r.scale = s;
    }
    props.push(r);
  }
  return props;
}

/** Every brush index reachable from one BSP model's head node. */
export function modelBrushes(map, modelIndex) {
  const seen = new Set();
  const stack = [map.models[modelIndex].headnode];
  while (stack.length) {
    const n = stack.pop();
    if (n < 0) {
      const leaf = map.leafs[-1 - n];
      if (!leaf) continue;
      for (let i = 0; i < leaf.numLeafBrushes; i++) seen.add(map.leafBrushes[leaf.firstLeafBrush + i]);
    } else {
      const node = map.nodes[n];
      if (node) stack.push(node.c0, node.c1);
    }
  }
  return seen;
}

/** Walk the tree from the world's headnode. Returns the leaf index for a point. */
export function pointLeaf(map, pt) {
  let n = map.models[0].headnode;
  while (n >= 0) {
    const node = map.nodes[n];
    const i = node.plane * 4;
    const d = map.planes[i] * pt[0] + map.planes[i + 1] * pt[1] + map.planes[i + 2] * pt[2] - map.planes[i + 3];
    n = d >= 0 ? node.c0 : node.c1;
  }
  return -1 - n;
}
