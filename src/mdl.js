// Studio model reader: .mdl + .vvd + .vtx (MDL versions 44-49), LOD0 only.
// A $staticprop's VVD positions are final. Anything else is stored in a rotated pose space
// and only looks right through its bones, so those models get skinned to frame 0 of their
// first sequence, which is what the engine draws for a prop that isn't playing anything.

const cstr = (b, o) => {
  if (o <= 0 || o >= b.length) return '';
  let e = o;
  while (e < b.length && b[e] !== 0) e++;
  return b.toString('latin1', o, e);
};

function parseVvd(buf) {
  if (buf.toString('latin1', 0, 4) !== 'IDSV') throw new Error('bad VVD');
  const numLodVerts0 = buf.readInt32LE(16);
  const numFixups = buf.readInt32LE(48);
  const fixupStart = buf.readInt32LE(52);
  const dataStart = buf.readInt32LE(56);

  // Fixups rebuild LOD0's order from the on-disk vertex pool.
  let order;
  if (numFixups > 0) {
    order = new Int32Array(numLodVerts0);
    let n = 0;
    for (let i = 0; i < numFixups; i++) {
      const o = fixupStart + i * 12;
      const lod = buf.readInt32LE(o), src = buf.readInt32LE(o + 4), cnt = buf.readInt32LE(o + 8);
      if (lod < 0) continue;
      for (let k = 0; k < cnt && n < numLodVerts0; k++) order[n++] = src + k;
    }
  }
  const pos = new Float32Array(numLodVerts0 * 3);
  const nrm = new Float32Array(numLodVerts0 * 3);
  const uv = new Float32Array(numLodVerts0 * 2);
  const weights = new Float32Array(numLodVerts0 * 3);
  const bones = new Uint8Array(numLodVerts0 * 3);
  const boneCount = new Uint8Array(numLodVerts0);
  for (let i = 0; i < numLodVerts0; i++) {
    const o = dataStart + (order ? order[i] : i) * 48;
    for (let k = 0; k < 3; k++) {
      weights[i * 3 + k] = buf.readFloatLE(o + k * 4);
      bones[i * 3 + k] = buf[o + 12 + k];
    }
    boneCount[i] = buf[o + 15];
    pos[i * 3] = buf.readFloatLE(o + 16); pos[i * 3 + 1] = buf.readFloatLE(o + 20); pos[i * 3 + 2] = buf.readFloatLE(o + 24);
    nrm[i * 3] = buf.readFloatLE(o + 28); nrm[i * 3 + 1] = buf.readFloatLE(o + 32); nrm[i * 3 + 2] = buf.readFloatLE(o + 36);
    uv[i * 2] = buf.readFloatLE(o + 40); uv[i * 2 + 1] = buf.readFloatLE(o + 44);
  }
  return { count: numLodVerts0, pos, nrm, uv, weights, bones, boneCount };
}

const DOOR_HARDWARE_GROUP = 1;
const STATIC_PROP = 0x10;
const ANIM_ALLZEROS = 0x20, ANIM_FRAMEANIM = 0x40;
const FRAME_CONST_POS = 0x01, FRAME_CONST_ROT = 0x02, FRAME_ANIM_POS = 0x04, FRAME_ANIM_ROT = 0x08;
const BONE_SIZE = 216, SEQ_SIZE = 212, ANIMDESC_SIZE = 100;
const RAWPOS = 0x01, RAWROT = 0x02, ANIMPOS = 0x04, ANIMROT = 0x08, DELTA = 0x10, RAWROT2 = 0x20;

function quatToMatrix([x, y, z, w], [px, py, pz]) {
  const l = Math.hypot(x, y, z, w) || 1;
  x /= l; y /= l; z /= l; w /= l;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), px],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), py],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y), pz],
  ];
}

/** Source's matrix3x4 concat: a * b, both rotation plus translation. */
function concat(a, b) {
  const out = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let c = 0; c < 4; c++) {
      row.push(a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c] + (c === 3 ? a[r][3] : 0));
    }
    out.push(row);
  }
  return out;
}

/** Source's AngleQuaternion for a RadianEuler. */
function eulerToQuat([rx, ry, rz]) {
  const sr = Math.sin(rx / 2), cr = Math.cos(rx / 2), sp = Math.sin(ry / 2), cp = Math.cos(ry / 2);
  const sy = Math.sin(rz / 2), cy = Math.cos(rz / 2);
  const srcp = sr * cp, crsp = cr * sp, crcp = cr * cp, srsp = sr * sp;
  return [srcp * cy - crsp * sy, crsp * cy + srcp * sy, crcp * sy - srsp * cy, crcp * cy + srsp * sy];
}

function half(u) {
  const s = u & 0x8000 ? -1 : 1, e = (u >> 10) & 31, m = u & 1023;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return 0; // infinity or NaN: never meaningful for a bone offset
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

function quat48(b, o) {
  const x = (b.readUInt16LE(o) - 32768) / 32768, y = (b.readUInt16LE(o + 2) - 32768) / 32768;
  const zw = b.readUInt16LE(o + 4), z = ((zw & 0x7fff) - 16384) / 16384;
  const w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
  return [x, y, z, zw & 0x8000 ? -w : w];
}

function quat64(b, o) {
  const v = b.readBigUInt64LE(o);
  const x = (Number(v & 0x1fffffn) - 1048576) / 1048576.5;
  const y = (Number((v >> 21n) & 0x1fffffn) - 1048576) / 1048576.5;
  const z = (Number((v >> 42n) & 0x1fffffn) - 1048576) / 1048576.5;
  const w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
  return [x, y, z, v >> 63n ? -w : w];
}

/** Frame 0 of an RLE channel: the first run's first value. A zero offset means the channel is empty. */
const channelStart = (b, valuePtr, i) => {
  const off = b.readInt16LE(valuePtr + i * 2);
  return off ? b.readInt16LE(valuePtr + off + 2) : 0;
};

const vec48 = (b, o) => [half(b.readUInt16LE(o)), half(b.readUInt16LE(o + 2)), half(b.readUInt16LE(o + 4))];

/**
 * L4D-era frame animation. A 24-byte header gives the offsets of the constants and the frame
 * data, then one flag byte per bone. Constants hold a Quaternion48 and then a Vector48, in
 * that order, for each bone flagged with them, and frames repeat the same for animated bones.
 */
function frameAnimPose(b, at, bones) {
  const pose = new Map();
  let constant = at + b.readInt32LE(at);
  let frame = at + b.readInt32LE(at + 4);
  bones.forEach((info, bone) => {
    const flags = b[at + 24 + bone];
    if (!flags) return;
    let q = info.quat, p = info.pos;
    if (flags & FRAME_CONST_ROT) { q = quat48(b, constant); constant += 6; }
    if (flags & FRAME_CONST_POS) { p = vec48(b, constant); constant += 6; }
    if (flags & FRAME_ANIM_ROT) { q = quat48(b, frame); frame += 6; }
    if (flags & FRAME_ANIM_POS) { p = vec48(b, frame); frame += 6; }
    pose.set(bone, { q, p });
  });
  return pose;
}

/** Local pose overrides for frame 0 of sequence 0, keyed by bone. Empty when it's the rest pose. */
function firstFrame(b, bones) {
  const pose = new Map();
  if (b.readInt32LE(188) < 1 || b.readInt32LE(180) < 1) return pose;
  const seq = b.readInt32LE(192);
  const animIndex = b.readInt16LE(seq + b.readInt32LE(seq + 60));
  const desc = b.readInt32LE(184) + animIndex * ANIMDESC_SIZE;
  if (b.readInt32LE(desc + 12) & ANIM_ALLZEROS) return pose;
  let animblock = b.readInt32LE(desc + 52), animOfs = b.readInt32LE(desc + 56);
  const sectionFrames = b.readInt32LE(desc + 84);
  if (sectionFrames > 0) {
    const sec = desc + b.readInt32LE(desc + 80);
    animblock = b.readInt32LE(sec);
    animOfs = b.readInt32LE(sec + 4);
  }
  if (animblock !== 0) return pose; // lives in a separate .ani file; the rest pose is the closest we have
  let at = desc + animOfs;
  if (b.readInt32LE(desc + 12) & ANIM_FRAMEANIM) return frameAnimPose(b, at, bones);
  for (let guard = 0; guard < 512; guard++) {
    const bone = b[at], flags = b[at + 1], next = b.readInt16LE(at + 2);
    const info = bones[bone];
    if (info && !(flags & DELTA)) {
      let q = info.quat, p = info.pos;
      let cur = at + 4;
      if (flags & RAWROT) { q = quat48(b, cur); cur += 6; }
      if (flags & RAWROT2) { q = quat64(b, cur); cur += 8; }
      if (flags & ANIMROT) {
        const e = [0, 1, 2].map(i => info.rot[i] + channelStart(b, cur, i) * info.rotScale[i]);
        q = eulerToQuat(e);
        cur += 6;
      }
      if (flags & RAWPOS) p = [half(b.readUInt16LE(cur)), half(b.readUInt16LE(cur + 2)), half(b.readUInt16LE(cur + 4))];
      else if (flags & ANIMPOS) p = [0, 1, 2].map(i => info.pos[i] + channelStart(b, cur, i) * info.posScale[i]);
      pose.set(bone, { q, p });
    }
    if (next === 0) break;
    at += next;
  }
  return pose;
}

/** Skin every vertex to frame 0. Returns false for a static prop, whose data is already final. */
function applyDrawnPose(buf, vvd) {
  if (buf.readInt32LE(152) & STATIC_PROP) return false;
  const numBones = buf.readInt32LE(156), boneOfs = buf.readInt32LE(160);
  if (numBones < 1) return false;
  const f3 = o => [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)];
  const bones = [];
  for (let i = 0; i < numBones; i++) {
    const o = boneOfs + i * BONE_SIZE;
    const row = r => [0, 1, 2, 3].map(c => buf.readFloatLE(o + 96 + (r * 4 + c) * 4));
    bones.push({
      parent: buf.readInt32LE(o + 4), pos: f3(o + 32),
      quat: [buf.readFloatLE(o + 44), buf.readFloatLE(o + 48), buf.readFloatLE(o + 52), buf.readFloatLE(o + 56)],
      rot: f3(o + 60), posScale: f3(o + 72), rotScale: f3(o + 84), poseToBone: [row(0), row(1), row(2)],
    });
  }
  let pose = new Map();
  try { pose = firstFrame(buf, bones); } catch { /* odd animation data: fall back to the rest pose */ }

  const world = [];
  const skin = [];
  for (let i = 0; i < numBones; i++) {
    const b = bones[i], at = pose.get(i);
    const local = quatToMatrix(at?.q ?? b.quat, at?.p ?? b.pos);
    world.push(b.parent >= 0 && b.parent < i ? concat(world[b.parent], local) : local);
    skin.push(concat(world[i], b.poseToBone));
  }

  for (let v = 0; v < vvd.count; v++) {
    const px = vvd.pos[v * 3], py = vvd.pos[v * 3 + 1], pz = vvd.pos[v * 3 + 2];
    const nx = vvd.nrm[v * 3], ny = vvd.nrm[v * 3 + 1], nz = vvd.nrm[v * 3 + 2];
    const out = [0, 0, 0], nOut = [0, 0, 0];
    const links = Math.max(1, Math.min(3, vvd.boneCount[v]));
    let total = 0;
    for (let k = 0; k < links; k++) total += links === 1 ? 1 : vvd.weights[v * 3 + k];
    for (let k = 0; k < links; k++) {
      const m = skin[vvd.bones[v * 3 + k]] ?? skin[0];
      const w = links === 1 ? 1 : vvd.weights[v * 3 + k] / (total || 1);
      for (let r = 0; r < 3; r++) {
        out[r] += w * (m[r][0] * px + m[r][1] * py + m[r][2] * pz + m[r][3]);
        nOut[r] += w * (m[r][0] * nx + m[r][1] * ny + m[r][2] * nz);
      }
    }
    const nl = Math.hypot(...nOut) || 1;
    for (let r = 0; r < 3; r++) {
      vvd.pos[v * 3 + r] = out[r];
      vvd.nrm[v * 3 + r] = nOut[r] / nl;
    }
  }
  return true;
}

function parseVtx(buf, mdlVersion) {
  if (buf.readInt32LE(0) !== 7) throw new Error('bad VTX version');
  const numBodyParts = buf.readInt32LE(28);
  const bodyOfs = buf.readInt32LE(32);

  const tryLayout = (sgSize, stripSize) => {
    const parts = [];
    for (let bp = 0; bp < numBodyParts; bp++) {
      const bpo = bodyOfs + bp * 8;
      const nModels = buf.readInt32LE(bpo);
      const modelOfs = bpo + buf.readInt32LE(bpo + 4);
      const models = [];
      for (let m = 0; m < nModels; m++) {
        const mo = modelOfs + m * 8;
        const nLods = buf.readInt32LE(mo);
        const lodOfs = mo + buf.readInt32LE(mo + 4);
        const meshes = [];
        if (nLods > 0) {
          const nMeshes = buf.readInt32LE(lodOfs);
          const meshOfs = lodOfs + buf.readInt32LE(lodOfs + 4);
          for (let me = 0; me < nMeshes; me++) {
            const mho = meshOfs + me * 9;
            const nSg = buf.readInt32LE(mho);
            const sgOfs = mho + buf.readInt32LE(mho + 4);
            const groups = [];
            for (let g = 0; g < nSg; g++) {
              const sg = sgOfs + g * sgSize;
              const numV = buf.readInt32LE(sg), vOfs = sg + buf.readInt32LE(sg + 4);
              const numI = buf.readInt32LE(sg + 8), iOfs = sg + buf.readInt32LE(sg + 12);
              const numS = buf.readInt32LE(sg + 16), sOfs = sg + buf.readInt32LE(sg + 20);
              if (numV < 0 || numI < 0 || numS < 0 || numS > 100000) throw new Error('layout');
              if (vOfs + numV * 9 > buf.length || iOfs + numI * 2 > buf.length) throw new Error('layout');
              const strips = [];
              for (let s = 0; s < numS; s++) {
                const so = sOfs + s * stripSize;
                const cnt = buf.readInt32LE(so), start = buf.readInt32LE(so + 4), flags = buf[so + 18];
                if (start < 0 || cnt < 0 || start + cnt > numI) throw new Error('layout');
                strips.push({ cnt, start, flags });
              }
              groups.push({ numV, vOfs, numI, iOfs, strips });
            }
            meshes.push(groups);
          }
        }
        models.push(meshes);
      }
      parts.push(models);
    }
    return parts;
  };

  // MDL v49 usually (not always) has the 8-byte topology extension. Validate, then fall back.
  const layouts = mdlVersion >= 49 ? [[33, 35], [25, 27]] : [[25, 27], [33, 35]];
  let err;
  for (const [a, b] of layouts) {
    try { return tryLayout(a, b); } catch (e) { err = e; }
  }
  throw err;
}

/**
 * A model is three files, and a replacer may ship only some of them. Like the engine, go by
 * checksum: take the highest-priority .mdl whose .vvd and .vtx match it, wherever they live.
 * A mod's .mdl with no matching mesh is passed over rather than paired with the wrong one.
 */
function modelFiles(vfs, mdlPath) {
  const base = mdlPath.replace(/\.mdl$/i, '');
  const mdls = vfs.copies(mdlPath);
  if (!mdls.length) throw new Error('model file missing');
  const vvds = vfs.copies(`${base}.vvd`);
  const vtxs = ['.dx90.vtx', '.dx80.vtx', '.sw.vtx', '.vtx'].flatMap(ext => vfs.copies(base + ext));
  for (let i = 0; i < mdls.length; i++) {
    const sum = mdls[i].data.readInt32LE(8);
    const vvd = vvds.find(c => c.data.readInt32LE(8) === sum);
    const vtx = vtxs.find(c => c.data.readInt32LE(16) === sum);
    if (vvd && vtx) {
      mdls[i].use();
      return { buf: mdls[i].data, vvdBuf: vvd.data, vtxBuf: vtx.data, passedOver: i };
    }
  }
  if (!vvds.length) throw new Error('VVD missing');
  if (!vtxs.length) throw new Error('VTX missing');
  // Nothing matches at all. Some old stock models are like this, so keep the first of each.
  return { buf: mdls[0].data, vvdBuf: vvds[0].data, vtxBuf: vtxs[0].data, passedOver: 0 };
}

/** Returns { version, vvd, meshes:[{material, indices}], passedOver } for LOD0. */
export function loadModel(vfs, mdlPath, { skin = 0, body = 0, hardware = null } = {}) {
  const { buf, vvdBuf, vtxBuf, passedOver } = modelFiles(vfs, mdlPath);
  if (buf.toString('latin1', 0, 4) !== 'IDST') throw new Error('bad MDL header');
  const version = buf.readInt32LE(4);
  if (version < 44 || version > 49) throw new Error(`unsupported MDL version ${version}`);

  const numTex = buf.readInt32LE(204), texOfs = buf.readInt32LE(208);
  const numCd = buf.readInt32LE(212), cdOfs = buf.readInt32LE(216);
  const skinRefs = buf.readInt32LE(220), skinFam = buf.readInt32LE(224), skinOfs = buf.readInt32LE(228);
  const numBody = buf.readInt32LE(232), bodyOfs = buf.readInt32LE(236);

  const texNames = [];
  for (let i = 0; i < numTex; i++) {
    const o = texOfs + i * 64;
    texNames.push(cstr(buf, o + buf.readInt32LE(o)).replace(/\\/g, '/').toLowerCase());
  }
  const cdDirs = [];
  for (let i = 0; i < numCd; i++) {
    cdDirs.push(cstr(buf, buf.readInt32LE(cdOfs + i * 4)).replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase());
  }
  const resolveMat = name => {
    for (const d of cdDirs) {
      const p = `${d}${d && !d.endsWith('/') ? '/' : ''}${name}`.replace(/\/+/g, '/');
      if (vfs.has(`materials/${p}.vmt`)) return p;
    }
    return `${cdDirs[0] ?? ''}${name}`;
  };
  const family = Math.max(0, Math.min(skin, skinFam - 1));
  const skinMap = i => {
    if (!skinRefs || i >= skinRefs) return i;
    return buf.readInt16LE(skinOfs + (family * skinRefs + i) * 2);
  };

  const vvd = parseVvd(vvdBuf);
  const vtx = parseVtx(vtxBuf, version);
  applyDrawnPose(buf, vvd);

  const out = [];
  let bodyDiv = 1;
  for (let bp = 0; bp < numBody; bp++) {
    const bpo = bodyOfs + bp * 16;
    const nModels = buf.readInt32LE(bpo + 4);
    const modelOfs = bpo + buf.readInt32LE(bpo + 12);
    // Same decode as the engine's SetBodygroup/GetBodygroup.
    let choose = nModels > 0 ? Math.floor(body / bodyDiv) % nModels : 0;
    // A door's handle lives in bodygroup 1 and comes from its hardware key. Like SetBodygroup,
    // an option the model doesn't have is ignored, which leaves the door without a handle.
    if (bp === DOOR_HARDWARE_GROUP && hardware !== null && hardware >= 0 && hardware < nModels) choose = hardware;
    bodyDiv *= Math.max(1, nModels);
    const mo = modelOfs + choose * 148;
    const nMeshes = buf.readInt32LE(mo + 72);
    const meshOfs = mo + buf.readInt32LE(mo + 76);
    const firstVert = buf.readInt32LE(mo + 84) / 48 | 0;
    const vtxMeshes = vtx[bp]?.[choose] ?? [];
    for (let me = 0; me < nMeshes; me++) {
      const mho = meshOfs + me * 116;
      const material = buf.readInt32LE(mho);
      const vertexOffset = buf.readInt32LE(mho + 12);
      const groups = vtxMeshes[me] ?? [];
      const indices = [];
      for (const g of groups) {
        const remap = new Int32Array(g.numV);
        for (let i = 0; i < g.numV; i++) {
          const orig = vtxBuf.readUInt16LE(g.vOfs + i * 9 + 4);
          remap[i] = firstVert + vertexOffset + orig;
        }
        const ix = i => remap[vtxBuf.readUInt16LE(g.iOfs + i * 2)];
        for (const s of g.strips) {
          if (s.flags & 2) {
            for (let i = 0; i + 2 < s.cnt; i++) {
              const a = ix(s.start + i), b = ix(s.start + i + 1), c = ix(s.start + i + 2);
              if (a === b || b === c || a === c) continue;
              if (i & 1) indices.push(a, c, b); else indices.push(a, b, c);
            }
          } else {
            for (let i = 0; i + 2 < s.cnt; i += 3) indices.push(ix(s.start + i), ix(s.start + i + 1), ix(s.start + i + 2));
          }
        }
      }
      if (!indices.length) continue;
      const tex = texNames[skinMap(material)] ?? texNames[material] ?? '';
      out.push({ material: resolveMat(tex), indices });
    }
  }
  if (!out.length) throw new Error('model has no LOD0 triangles');
  return { version, vvd, meshes: out, passedOver };
}
