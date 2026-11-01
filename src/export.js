// Scene + moderation decisions -> GLBs, PNG textures and manifest.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeGlb } from './glb.js';
import { decodeVtf } from './vtf.js';
import { encodePng, decodePng, downscale } from './png.js';
import { loadModel } from './mdl.js';
import { materialCache, baseMatId, BLEND_MIX } from './scene.js';
import { classifyBrushes, mergeBoxes } from './collision.js';
import { buildBrushParts, XFORMS } from './brushparts.js';
import { nameFlags } from './scan.js';
import { sub, add, mul, dot, cross, unit, len, toRbx, angleMatrix, rotToRbx, applyM, lightDir } from './math.js';

const MAX_TRIS = 19000;          // Roblox's cap is 20k. Stay clear of auto-decimation.
const MAX_VERTS = 50000;
const CELL = 2048;               // Source units per chunk: about 140 studs
const MAX_MESHES_PER_GLB = 150;
const MAX_GLB_BYTES = 15 * 1024 * 1024; // Open Cloud's limit is 20 MB

const round3 = v => Math.round(v * 1000) / 1000;

/** Text that ends up inside the place. Map authors wrote it, so anything the scanner dislikes is dropped. */
const safeText = s => (s && !nameFlags(s).length ? s.slice(0, 80) : null);

/** A real door entity, or a door model placed as a plain prop. "outdoor", cars and appliances don't count. */
const isDoorProp = p => p.cls === 'prop_door_rotating'
  || (/(^|[/_-]|blast)doors?(\d|[_./-])/.test(p.model) && !/vehicle|[/_-]car[/_-]|truck|vending|fridge|refrigerator|cabinet|locker/.test(p.model));

const ROPE_COLORS = [[/red/, [150, 30, 30]], [/blue/, [35, 60, 150]], [/green/, [40, 110, 50]], [/rope/, [120, 92, 62]]];
const ropeColor = mat => ROPE_COLORS.find(([re]) => re.test(mat))?.[1] ?? [24, 24, 26];

/** One segment per NextKey link. Names repeat in real maps, so take the nearest match. */
function buildRopes(nodes, conv, scale) {
  const byName = new Map();
  for (const n of nodes) if (n.name) (byName.get(n.name) ?? byName.set(n.name, []).get(n.name)).push(n);
  const seen = new Set();
  const out = [];
  for (const n of nodes) {
    if (!n.next) continue;
    let to = null, best = Infinity;
    for (const c of byName.get(n.next) ?? []) {
      const d = len(sub(c.origin, n.origin));
      if (c !== n && d < best) { best = d; to = c; }
    }
    if (!to) continue;
    const a = conv(n.origin).map(round3), b = conv(to.origin).map(round3);
    const id = `${a}|${b}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ a, b, l: round3((best + Math.max(n.slack, 0)) * scale), w: round3(Math.max(n.width * 2 * scale, 0.08)), c: ropeColor(n.material) });
  }
  return out;
}

export function halfTurn(img) {
  const n = img.width * img.height;
  const rgba = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const s = i * 4, d = (n - 1 - i) * 4;
    for (let c = 0; c < 4; c++) rgba[d + c] = img.rgba[s + c];
  }
  return { rgba, width: img.width, height: img.height };
}

/** A 2:1 sky side is only the top half of its cube face. Roblox stretches it over the whole face,
 *  which moves the horizon, so extend the bottom row down to make it square. */
export function squareSkySide(img) {
  if (img.width !== img.height * 2) return img;
  const row = img.width * 4;
  const rgba = Buffer.alloc(row * img.width);
  rgba.set(img.rgba.subarray(0, row * img.height));
  const last = img.rgba.subarray(row * (img.height - 1), row * img.height);
  for (let y = img.height; y < img.width; y++) rgba.set(last, y * row);
  return { rgba, width: img.width, height: img.width };
}

// ---- mesh assembly ------------------------------------------------------
class MeshBuilder {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; this.idx = []; this.map = new Map(); }
  vert(p, n, u) {
    const key = `${p[0].toFixed(3)},${p[1].toFixed(3)},${p[2].toFixed(3)},${n[0].toFixed(2)},${n[1].toFixed(2)},${n[2].toFixed(2)},${u[0].toFixed(4)},${u[1].toFixed(4)}`;
    let i = this.map.get(key);
    if (i === undefined) {
      i = this.pos.length / 3;
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(n[0], n[1], n[2]);
      this.uv.push(u[0], u[1]);
      this.map.set(key, i);
    }
    return i;
  }
  tri(a, b, c) {
    // A single non-finite vertex would corrupt the whole mesh's bounds, so refuse it here.
    for (const v of [a, b, c]) {
      if (!Number.isFinite(v[0][0] + v[0][1] + v[0][2] + v[1][0] + v[1][1] + v[1][2] + v[2][0] + v[2][1])) {
        MeshBuilder.dropped++;
        return;
      }
    }
    this.idx.push(this.vert(...a), this.vert(...b), this.vert(...c));
  }
  get tris() { return this.idx.length / 3; }
  get verts() { return this.pos.length / 3; }
  finish(name, hasUv = true) {
    const n = this.pos.length / 3;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < n; v++) {
      for (let k = 0; k < 3; k++) {
        const x = this.pos[v * 3 + k];
        if (x < lo[k]) lo[k] = x;
        if (x > hi[k]) hi[k] = x;
      }
    }
    const center = lo.map((l, k) => (l + hi[k]) / 2);
    const positions = new Float32Array(this.pos);
    for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) positions[v * 3 + k] -= center[k];
    return {
      name, center: center.map(round3), size: lo.map((l, k) => round3(hi[k] - l)),
      positions, normals: new Float32Array(this.nrm), uvs: hasUv ? new Float32Array(this.uv) : undefined,
      indices: new Uint32Array(this.idx), triCount: this.idx.length / 3,
    };
  }
}

MeshBuilder.dropped = 0;

function polyToTris(poly) {
  const { pts, nrm, uv } = poly;
  const out = [];
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = 0, b = i, c = i + 1;
    const n = cross(sub(pts[b], pts[a]), sub(pts[c], pts[a]));
    if (dot(n, n) < 1e-6) continue;
    // The reference normal decides the winding, so faces can never come out inside-out.
    const ref = poly.faceN ?? add(add(nrm[a], nrm[b]), nrm[c]);
    out.push(dot(n, ref) >= 0 ? [a, b, c] : [a, c, b]);
  }
  return out;
}

// ---- textures -----------------------------------------------------------
/** Bilinear resize that wraps at the edges, because these textures tile. */
function resample(src, w, h, W, H) {
  const out = Buffer.alloc(W * H * 4);
  for (let Y = 0; Y < H; Y++) {
    const fy = (Y + 0.5) * h / H - 0.5;
    const y0 = (Math.floor(fy) + h) % h, y1 = (y0 + 1) % h, ty = fy - Math.floor(fy);
    for (let X = 0; X < W; X++) {
      const fx = (X + 0.5) * w / W - 0.5;
      const x0 = (Math.floor(fx) + w) % w, x1 = (x0 + 1) % w, tx = fx - Math.floor(fx);
      for (let c = 0; c < 4; c++) {
        const top = src[(y0 * w + x0) * 4 + c] * (1 - tx) + src[(y0 * w + x1) * 4 + c] * tx;
        const bot = src[(y1 * w + x0) * 4 + c] * (1 - tx) + src[(y1 * w + x1) * 4 + c] * tx;
        out[(Y * W + X) * 4 + c] = top * (1 - ty) + bot * ty;
      }
    }
  }
  return out;
}

const averageColor = px => {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < px.length; i += 16) { r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; }
  return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [128, 128, 128];
};

class TextureStore {
  constructor(vfs, dir, opts) {
    this.vfs = vfs; this.dir = dir; this.opts = opts;
    this.byKey = new Map(); this.files = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }
  save(png) {
    const hash = crypto.createHash('sha1').update(png).digest('hex').slice(0, 16);
    if (!this.files.has(hash)) {
      const file = `${hash}.png`;
      fs.writeFileSync(path.join(this.dir, file), png);
      this.files.set(hash, { file, bytes: png.length });
    }
    return hash;
  }
  vtf(name, maxSize) {
    const buf = this.vfs.read(`materials/${name}.vtf`);
    if (!buf) return null;
    try { return decodeVtf(buf, maxSize); } catch { return null; }
  }
  color(desc, texName) {
    const key = `c|${texName}|${desc.translucent}|${desc.alphatest}|${desc.additive}|${desc.shader}`;
    if (this.byKey.has(key)) return this.byKey.get(key);
    let res = null;
    const img = this.vtf(texName, this.opts.maxTexture);
    if (img) {
      const px = img.rgba;
      let alpha = desc.translucent || desc.alphatest;
      if (desc.additive) {
        // Additive has no Roblox equivalent: brightness becomes opacity.
        for (let i = 0; i < px.length; i += 4) px[i + 3] = Math.max(px[i], px[i + 1], px[i + 2]);
        alpha = true;
      } else if (desc.shader === 'decalmodulate') {
        // 128 grey means no change, darker darkens. Becomes black with opacity.
        for (let i = 0; i < px.length; i += 4) {
          const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
          px[i + 3] = Math.max(0, Math.min(255, (128 - l) * 2));
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
        alpha = true;
      }
      if (alpha) {
        let any = false;
        for (let i = 3; i < px.length; i += 4) if (px[i] < 250) { any = true; break; }
        alpha = any;
      }
      res = { hash: this.save(encodePng(px, img.width, img.height, { alpha })), alpha, w: img.width, h: img.height, avg: averageColor(px) };
    }
    this.byKey.set(key, res);
    return res;
  }
  /** A flipped or rotated copy of a saved image. Roblox's Texture can't do either by itself. */
  oriented(hash, xf, alpha) {
    const key = `o|${hash}|${xf}`;
    if (this.byKey.has(key)) return this.byKey.get(key);
    const img = decodePng(fs.readFileSync(path.join(this.dir, this.files.get(hash).file)));
    const w = img.width, h = img.height;
    const turned = xf === 't' || xf === 'at' || xf === 'r1' || xf === 'r3';
    const W = turned ? h : w, H = turned ? w : h;
    const out = Buffer.alloc(W * H * 4);
    for (let Y = 0; Y < H; Y++) {
      for (let X = 0; X < W; X++) {
        const [u, v] = XFORMS[xf]((X + 0.5) / W, (Y + 0.5) / H);
        const i = (Math.floor(v * h) * w + Math.floor(u * w)) * 4;
        img.rgba.copy(out, (Y * W + X) * 4, i, i + 4);
      }
    }
    const res = this.save(encodePng(out, W, H, { alpha: !!alpha }));
    this.byKey.set(key, res);
    return res;
  }
  /** Opaque mix of two textures. Displacement blends share one set of UVs, so this tiles. */
  mix(nameA, nameB, t) {
    const key = `m|${nameA}|${nameB}|${t}`;
    if (this.byKey.has(key)) return this.byKey.get(key);
    let res = null;
    // Mixes only cover narrow strips, so 512 is enough and keeps the upload small.
    const size = Math.min(512, this.opts.maxTexture);
    const a = this.vtf(nameA, size), b = this.vtf(nameB, size);
    if (a && b) {
      const B = a.width === b.width && a.height === b.height ? b.rgba : resample(b.rgba, b.width, b.height, a.width, a.height);
      const px = Buffer.alloc(a.rgba.length);
      for (let i = 0; i < px.length; i += 4) {
        for (let c = 0; c < 3; c++) px[i + c] = a.rgba[i + c] * (1 - t) + B[i + c] * t + 0.5;
        px[i + 3] = 255;
      }
      res = { hash: this.save(encodePng(px, a.width, a.height, { alpha: false })), alpha: false, w: a.width, h: a.height };
    }
    this.byKey.set(key, res);
    return res;
  }
  normal(texName) {
    const key = `n|${texName}`;
    if (this.byKey.has(key)) return this.byKey.get(key);
    let res = null;
    const buf = this.vfs.read(`materials/${texName}.vtf`);
    // Self-shadowed bump maps are not tangent-space normals and would shade wrongly.
    const ssbump = buf && buf.length > 24 && (buf.readUInt32LE(20) & 0x8000000) !== 0;
    if (buf && !ssbump) {
      try {
        const img = decodeVtf(buf, Math.min(512, this.opts.maxTexture));
        const px = img.rgba;
        // Source normals are DirectX style; Roblox wants OpenGL style (green up).
        for (let i = 0; i < px.length; i += 4) { px[i + 1] = 255 - px[i + 1]; px[i + 3] = 255; }
        res = { hash: this.save(encodePng(px, img.width, img.height, { alpha: false })) };
      } catch { /* left without a normal map */ }
    }
    this.byKey.set(key, res);
    return res;
  }
}

function rbxMaterial(desc) {
  const s = `${desc.surfaceprop} ${desc.id}`;
  if (/glass|window/.test(s)) return 'Glass';
  if (/metal|chain|grate|grenade|vent|duct|canister|combine/.test(s)) return 'Metal';
  if (/grass/.test(s)) return 'Grass';
  if (/wood|plywood|crate/.test(s)) return 'Wood';
  if (/brick/.test(s)) return 'Brick';
  if (/tile|ceramic|porcelain/.test(s)) return 'Slate';
  if (/gravel|rock|stone/.test(s)) return 'Rock';
  if (/dirt|mud|sand|snow/.test(s)) return 'Ground';
  if (/concrete|plaster/.test(s)) return 'Concrete';
  if (/carpet|cloth|fabric/.test(s)) return 'Fabric';
  return 'SmoothPlastic';
}

// ---- main ---------------------------------------------------------------
const breathe = () => new Promise(r => setImmediate(r));

export async function exportScene({ scene, vfs, outDir, decisions = {}, opts = {}, onProgress = () => {} }) {
  const scale = opts.scale ?? 0.068;
  MeshBuilder.dropped = 0;
  const texDir = path.join(outDir, 'tex');
  const glbDir = path.join(outDir, 'glb');
  fs.rmSync(glbDir, { recursive: true, force: true });
  fs.rmSync(texDir, { recursive: true, force: true });
  fs.mkdirSync(glbDir, { recursive: true });

  const textures = new TextureStore(vfs, texDir, { maxTexture: opts.maxTexture ?? 1024 });
  const getMat = scene.getMat ?? materialCache(vfs);
  const decisionOf = id => decisions[baseMatId(id)] ?? null;
  const conv = p => mul(toRbx(p), scale);
  const convN = n => toRbx(n);

  // Material table
  const materials = [];
  const matIndex = new Map();
  const matFor = idRaw => {
    if (matIndex.has(idRaw)) return matIndex.get(idRaw);
    const isSecond = idRaw.endsWith('#2');
    const mixAmount = BLEND_MIX[idRaw.slice(-3)];
    const desc = getMat(baseMatId(idRaw));
    const dec = decisionOf(idRaw);
    const m = { id: materials.length, material: rbxMaterial(desc), alpha: desc.alpha, nocull: desc.nocull };
    const src = safeText(baseMatId(idRaw));
    if (src) m.src = src;
    let tex = isSecond ? desc.base2 : desc.base;
    if (dec?.action === 'color') { m.solid = dec.color ?? '#808080'; tex = null; }
    if (dec?.action === 'replace' && dec.file) {
      const img = decodePng(fs.readFileSync(dec.file));
      const small = downscale(img.rgba, img.width, img.height, opts.maxTexture ?? 1024);
      m.color = textures.save(encodePng(small.rgba, small.width, small.height, { alpha: true }));
    } else if (tex) {
      const mixed = mixAmount && desc.base2 ? textures.mix(desc.base, desc.base2, mixAmount) : null;
      const c = mixed ?? textures.color(desc, tex);
      if (c) { m.color = c.hash; m.hasAlpha = c.alpha; m.tw = c.w; m.th = c.h; if (c.avg) m.avg = c.avg; } else m.solid = m.solid ?? '#808080';
      if (desc.bump && !isSecond && opts.normalMaps !== false) {
        const n = textures.normal(desc.bump);
        if (n) m.normal = n.hash;
      }
    } else if (!m.solid) m.solid = '#808080';
    if (desc.color && !m.solid) m.tint = desc.color.map(round3);
    materials.push(m);
    matIndex.set(idRaw, m);
    return m;
  };

  const allMeshes = [];
  const pushMesh = (mesh, extra) => { Object.assign(mesh, extra); allMeshes.push(mesh); return mesh; };

  // World geometry: per material, per spatial cell.
  let meshNo = 0;
  const removed = { faces: 0, props: 0, overlays: 0, decals: 0 };
  const isRemoved = id => decisionOf(id)?.action === 'remove';

  const addOverlayPolys = () => {
    const OFFSET = 0.3;
    (scene.overlays ?? []).forEach((o, i) => {
      if (isRemoved(o.material)) { removed.overlays++; return; }
      const off = mul(o.normal, OFFSET + (i % 8) * 0.02);
      const pts = o.pts.map(p => add(p, off));
      const list = scene.polys.get(o.material) ?? scene.polys.set(o.material, []).get(o.material);
      list.push({ pts, nrm: pts.map(() => o.normal), uv: o.uv, faceN: o.normal, overlay: true });
    });
    if (!scene.decals?.length) return;
    // infodecals are projected at runtime in Source, so find the surface they hit.
    const faces = [];
    for (const l of scene.polys.values()) for (const p of l) if (p.faceN && !p.overlay) faces.push(p);
    for (const d of scene.decals) {
      if (isRemoved(d.material)) { removed.decals++; continue; }
      const desc = getMat(d.material);
      const tname = desc.base;
      const img = tname ? textures.vtf(tname, 64) : null;
      if (!img) continue;
      let best = null, bestD = 16;
      for (const f of faces) {
        const n = unit(f.faceN);
        const dist = dot(sub(d.origin, f.pts[0]), n);
        if (Math.abs(dist) >= bestD) continue;
        const q = sub(d.origin, mul(n, dist));
        let inside = true;
        for (let i = 0; i < f.pts.length && inside; i++) {
          const a = f.pts[i], b = f.pts[(i + 1) % f.pts.length];
          const s = dot(cross(sub(b, a), sub(q, a)), n);
          if (s > 0.5) inside = false;
        }
        if (!inside) {
          inside = true;
          for (let i = 0; i < f.pts.length && inside; i++) {
            const a = f.pts[i], b = f.pts[(i + 1) % f.pts.length];
            if (dot(cross(sub(b, a), sub(q, a)), n) < -0.5) inside = false;
          }
        }
        if (inside) { bestD = Math.abs(dist); best = { n, q }; }
      }
      if (!best) continue;
      const n = best.n;
      const up = Math.abs(n[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
      const u = unit(cross(up, n)), v = cross(n, u);
      const sc = Number(desc.decalscale ?? 1) || 1;
      const hw = img.origWidth * sc / 2, hh = img.origHeight * sc / 2;
      const c = add(best.q, mul(n, 0.4));
      const pts = [
        add(add(c, mul(u, -hw)), mul(v, hh)), add(add(c, mul(u, hw)), mul(v, hh)),
        add(add(c, mul(u, hw)), mul(v, -hh)), add(add(c, mul(u, -hw)), mul(v, -hh)),
      ];
      const list = scene.polys.get(d.material) ?? scene.polys.set(d.material, []).get(d.material);
      list.push({ pts, nrm: pts.map(() => n), uv: [[0, 0], [1, 0], [1, 1], [0, 1]], faceN: n, overlay: true });
    }
  };
  addOverlayPolys();

  let done = 0;
  const matIds = [...scene.polys.keys()];
  for (const id of matIds) {
    const polys = scene.polys.get(id);
    onProgress({ stage: 'world', done: done++, total: matIds.length });
    await breathe(); // keeps the app responsive, and the progress bar moving
    if (isRemoved(id)) { removed.faces += polys.length; continue; }
    const mt = matFor(id);
    const cells = new Map();
    for (const p of polys) {
      let cx = 0, cy = 0, cz = 0;
      for (const v of p.pts) { cx += v[0]; cy += v[1]; cz += v[2]; }
      const n = p.pts.length;
      // Displacement triangles and flat faces are kept apart: they collide differently.
      const k = `${Math.floor(cx / n / CELL)},${Math.floor(cy / n / CELL)},${Math.floor(cz / n / CELL)},${p.disp ? 1 : 0}`;
      (cells.get(k) ?? cells.set(k, []).get(k)).push(p);
    }
    for (const [k, list] of cells) {
      const isDisp = k.endsWith(',1');
      const flush = mb => {
        if (!mb.tris) return;
        pushMesh(mb.finish(`W${String(meshNo++).padStart(5, '0')}`), { mat: mt.id, kind: isDisp ? 'disp' : 'world', coll: isDisp ? 'precise' : 'none', overlay: list.every(p => p.overlay) });
      };
      let mb = new MeshBuilder();
      for (const p of list) {
        // Recentre tiling UVs per polygon. Whole-number shifts don't change the look.
        let du = 0, dv = 0;
        if (!p.disp) {
          du = Math.floor(Math.min(...p.uv.map(u => u[0])));
          dv = Math.floor(Math.min(...p.uv.map(u => u[1])));
        }
        const V = i => [conv(p.pts[i]), convN(p.nrm[i]), [p.uv[i][0] - du, p.uv[i][1] - dv]];
        for (const [a, b, c] of polyToTris(p)) {
          if (mb.tris + (mt.nocull ? 2 : 1) > MAX_TRIS || mb.verts + 6 > MAX_VERTS) { flush(mb); mb = new MeshBuilder(); }
          mb.tri(V(a), V(b), V(c));
          if (mt.nocull) {
            const flip = i => { const v = V(i); return [v[0], mul(v[1], -1), v[2]]; };
            mb.tri(flip(a), flip(c), flip(b));
          }
        }
      }
      flush(mb);
    }
  }

  // Prop library: each model+skin+body is one set of meshes, reused by every instance.
  const lib = {};
  const libIndex = new Map();
  const instances = [];
  const failures = [];
  const passedOver = [];
  const missingProps = [];
  const uniq = new Map();
  for (const p of scene.props) {
    const key = `${p.model}|${p.skin}|${p.body}|${p.hardware ?? ''}`;
    (uniq.get(key) ?? uniq.set(key, []).get(key)).push(p);
  }
  let propNo = 0, pd = 0;
  for (const [key, list] of uniq) {
    onProgress({ stage: 'props', done: pd++, total: uniq.size });
    await breathe();
    const { model, skin, body, hardware } = list[0];
    if (isRemoved(`model:${model}`)) { removed.props += list.length; continue; }
    let md;
    try { md = loadModel(vfs, model, { skin, body, hardware }); } catch (e) {
      failures.push({ model, error: e.message, count: list.length });
      const label = safeText(model.replace(/^models\//, '').replace(/\.mdl$/, '')) ?? 'unnamed model';
      for (const p of list) missingProps.push({ m: label, p: conv(p.origin).map(round3) });
      continue;
    }
    if (md.passedOver) passedOver.push(model);
    const k = `P${String(propNo++).padStart(4, '0')}`;
    const parts = [];
    let sub_ = 0;
    const bigSolid = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const m of md.meshes) {
      const mid = m.material;
      if (isRemoved(mid)) continue;
      const desc = getMat(mid);
      if (desc.isTool) continue;
      const mt = matFor(mid);
      let mb = new MeshBuilder();
      const { pos, nrm, uv } = md.vvd;
      const P = i => conv([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
      const N = i => convN([nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]]);
      const U = i => [uv[i * 2], uv[i * 2 + 1]];
      const flush = () => {
        if (!mb.tris) return;
        const mesh = pushMesh(mb.finish(`${k}_${sub_++}`), { mat: mt.id, kind: 'prop', coll: 'prop' });
        parts.push(mesh.name);
        for (let a = 0; a < 3; a++) {
          bigSolid.min[a] = Math.min(bigSolid.min[a], mesh.center[a] - mesh.size[a] / 2);
          bigSolid.max[a] = Math.max(bigSolid.max[a], mesh.center[a] + mesh.size[a] / 2);
        }
      };
      for (let t = 0; t < m.indices.length; t += 3) {
        if (mb.tris + 2 > MAX_TRIS || mb.verts + 6 > MAX_VERTS) { flush(); mb = new MeshBuilder(); }
        let [a, b, c] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
        const pa = [pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]];
        const pb = [pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]];
        const pc = [pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2]];
        const fn = cross(sub(pb, pa), sub(pc, pa));
        if (dot(fn, fn) < 1e-9) continue;
        const vn = [nrm[a * 3] + nrm[b * 3] + nrm[c * 3], nrm[a * 3 + 1] + nrm[b * 3 + 1] + nrm[c * 3 + 1], nrm[a * 3 + 2] + nrm[b * 3 + 2] + nrm[c * 3 + 2]];
        if (dot(fn, vn) < 0) [b, c] = [c, b];
        mb.tri([P(a), N(a), U(a)], [P(b), N(b), U(b)], [P(c), N(c), U(c)]);
        if (mt.nocull) {
          const F = i => [P(i), mul(N(i), -1), U(i)];
          mb.tri(F(a), F(c), F(b));
        }
      }
      flush();
    }
    if (!parts.length) continue;
    const shortName = safeText(model.split('/').pop().replace(/\.mdl$/, ''));
    lib[k] = { parts, ...(shortName ? { n: shortName } : {}) };
    libIndex.set(key, k);
    for (const p of list) {
      const R = rotToRbx(angleMatrix(p.angles));
      const pos2 = conv(p.origin).map(round3);
      const inst = { k, cf: [...pos2, ...R.map(v => Math.round(v * 100000) / 100000)] };
      if (p.scale !== 1) inst.s = p.scale;
      if (!p.solid) inst.ns = 1;
      const tint = p.tint ?? [255, 255, 255];
      if (tint[0] < 255 || tint[1] < 255 || tint[2] < 255) inst.t = tint.slice(0, 3);
      if (tint[3] !== undefined && tint[3] < 255) inst.a = Math.round((1 - tint[3] / 255) * 100) / 100;
      if (/^prop_physics/.test(p.cls ?? '')) inst.phys = 1;
      if (isDoorProp(p)) inst.door = 1;
      const entityName = safeText(p.name);
      if (entityName) inst.n = entityName;
      instances.push(inst);
    }
  }

  // Colliders
  onProgress({ stage: 'collision', done: 0, total: 1 });
  await breathe();
  const cls = classifyBrushes(scene.solids, scale);
  const parts = opts.mergeColliders === false ? cls.parts : mergeBoxes(cls.parts);
  let hullNo = 0;
  for (const polys of cls.hulls) {
    const mb = new MeshBuilder();
    for (const p of polys) {
      const pts = p.pts;
      const n = convN(p.n);
      for (let i = 1; i + 1 < pts.length; i++) {
        const a = pts[0], b = pts[i], c = pts[i + 1];
        const fn = cross(sub(b, a), sub(c, a));
        const order = dot(fn, p.n) >= 0 ? [a, b, c] : [a, c, b];
        mb.tri([conv(order[0]), n, [0, 0]], [conv(order[1]), n, [0, 0]], [conv(order[2]), n, [0, 0]]);
      }
    }
    if (mb.tris) pushMesh(mb.finish(`H${String(hullNo++).padStart(5, '0')}`), { kind: 'hull', coll: polys.toolOnly ? 'clip' : 'hull' });
  }

  // The Parts alternative. Exact orientation needs extra images, so those only exist on request.
  const variants = new Map();
  const variantOf = (matId, xf) => {
    if (!opts.brushParts) return null;
    const base = materials[matId];
    if (!base.color) return null;
    const key = `${matId}|${xf}`;
    if (!variants.has(key)) {
      const color = textures.oriented(base.color, xf, base.hasAlpha);
      const m = { ...base, id: materials.length, color, normal: undefined };
      materials.push(m);
      variants.set(key, m.id);
    }
    return variants.get(key);
  };
  for (const b of scene.brushes ?? []) if (b.door) b.door.name = safeText(b.door.name);
  const brushBuild = buildBrushParts(scene.brushes ?? [], scale, id => matIndex.get(id) ?? null, variantOf, opts.onBrushFace);
  const clipParts = mergeBoxes(classifyBrushes(scene.solids.filter(s => s.toolOnly), scale).parts);

  // Batch into GLB files small enough for Open Cloud.
  onProgress({ stage: 'glb', done: 0, total: 1 });
  await breathe();
  const files = [];
  let batch = [], bytes = 0;
  const flushGlb = () => {
    if (!batch.length) return;
    const name = `geo_${String(files.length).padStart(3, '0')}.glb`;
    const glb = writeGlb(batch);
    fs.writeFileSync(path.join(glbDir, name), glb);
    const sha = crypto.createHash('sha1').update(glb).digest('hex').slice(0, 16);
    files.push({ file: name, bytes: glb.length, meshes: batch.length, sha });
    for (const m of batch) m.file = name;
    batch = []; bytes = 0;
  };
  // Hulls are grouped last so geometry stays spatially coherent in each file.
  for (const m of allMeshes) {
    const est = m.positions.byteLength + m.normals.byteLength + (m.uvs?.byteLength ?? 0) + m.indices.byteLength + 500;
    if (batch.length >= MAX_MESHES_PER_GLB || bytes + est > MAX_GLB_BYTES) flushGlb();
    batch.push(m);
    bytes += est;
  }
  flushGlb();

  // Skybox
  let sky = null;
  if (scene.sky && !isRemoved(`sky:${scene.sky}`) && opts.sky !== false) {
    const out = {};
    // Source: rt=+X, lf=-X, bk=+Y, ft=-Y. Measured in Studio: SkyboxLf shows +X, SkyboxRt shows -X,
    // SkyboxFt shows -Z (Source +Y), and Source's up face needs a half turn to meet the sides.
    const map = { rt: 'Lf', lf: 'Rt', bk: 'Ft', ft: 'Bk', up: 'Up', dn: 'Dn' };
    for (const [src, dst] of Object.entries(map)) {
      const desc = getMat(`skybox/${scene.sky}${src}`);
      const name = desc.base ?? `skybox/${scene.sky}${src}`;
      const img = textures.vtf(name, 1024);
      if (!img) continue;
      const face = dst === 'Up' ? halfTurn(img) : dst === 'Dn' ? img : squareSkySide(img);
      out[dst] = textures.save(encodePng(face.rgba, face.width, face.height, { alpha: false }));
    }
    if (Object.keys(out).length === 6) sky = out;
  }

  // Lights: brightest first, capped, because each one has a runtime cost.
  const lights = [...scene.lights].sort((a, b) => b.brightness - a.brightness).slice(0, opts.maxLights ?? 150).map(l => {
    let dir = null;
    if (l.spot) {
      const a = [...l.angles];
      if (l.pitch) a[0] = l.pitch; // a zero pitch key falls back to angles, as in VRAD
      dir = toRbx(lightDir(a)).map(round3);
    }
    return {
      p: conv(l.origin).map(round3), c: l.color,
      b: round3(Math.min(3, l.brightness / 200)),
      r: Math.round(Math.min(60, l.distance > 0 ? l.distance * scale : Math.sqrt(l.brightness) * 2.2)),
      ...(dir ? { d: dir, a: Math.round(l.cone) } : {}),
    };
  });

  const ropes = buildRopes(scene.ropes ?? [], conv, scale);
  const facing = yaw => toRbx([Math.cos(yaw * Math.PI / 180), Math.sin(yaw * Math.PI / 180), 0]).map(round3);
  const spawns = (scene.spawns ?? []).map(s => ({ c: safeText(s.cls), p: conv(s.origin).map(round3), d: facing(s.yaw) }));
  const markers = (scene.markers ?? []).map(k => ({
    c: safeText(k.cls), n: safeText(k.name), p: conv(k.origin).map(round3), d: facing(k.yaw),
  })).filter(k => k.c);

  const water = scene.water.map(w => {
    const lo = conv(w.lo), hi = conv(w.hi);
    const min = lo.map((v, i) => Math.min(v, hi[i])), max = lo.map((v, i) => Math.max(v, hi[i]));
    return { c: min.map((v, i) => round3((v + max[i]) / 2)), s: min.map((v, i) => round3(max[i] - v)) };
  });

  const sun = scene.sun && {
    dir: toRbx(mul(lightDir(scene.sun.angles), -1)).map(round3),
    color: scene.sun.color, ambient: scene.sun.ambient,
  };

  const usedTex = new Set();
  materials.forEach(m => { if (m.color) usedTex.add(m.color); if (m.normal) usedTex.add(m.normal); });
  if (sky) Object.values(sky).forEach(h => usedTex.add(h));
  const texList = {};
  for (const h of usedTex) texList[h] = textures.files.get(h).file;

  const meshes = {};
  for (const m of allMeshes) {
    meshes[m.name] = { f: m.file, c: m.center, s: m.size, k: m.kind, cl: m.coll, ...(m.mat !== undefined ? { m: m.mat } : {}), ...(m.overlay ? { ov: 1 } : {}) };
  }

  const manifest = {
    format: 1, map: scene.mapName, scale, materials, meshes, lib, instances, parts, water, lights, ropes, spawns, markers, missingProps, sky, sun,
    brushes: brushBuild.brushes, clipParts,
    fog: scene.fog?.enabled ? { color: scene.fog.color, start: round3(scene.fog.start * scale), end: round3(scene.fog.end * scale) } : null,
    files, textures: texList,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest));

  const worldTris = allMeshes.filter(m => m.kind === 'world' || m.kind === 'disp').reduce((s, m) => s + m.triCount, 0);
  const propTris = instances.reduce((s, i) => s + lib[i.k].parts.reduce((t, n) => t + allMeshes.find(x => x.name === n).triCount, 0), 0);
  const stats = {
    glbFiles: files.length, glbBytes: files.reduce((s, f) => s + f.bytes, 0),
    meshParts: allMeshes.filter(m => m.kind !== 'hull' && m.kind !== 'prop').length + instances.reduce((s, i) => s + lib[i.k].parts.length, 0),
    uniqueMeshes: allMeshes.length, hullColliders: cls.hulls.length, partColliders: parts.length,
    textures: usedTex.size, textureBytes: [...usedTex].reduce((s, h) => s + textures.files.get(h).bytes, 0),
    worldTris, propTris, propInstances: instances.length, propModels: Object.keys(lib).length,
    water: water.length, lights: lights.length, ropes: ropes.length, spawns: spawns.length, markers: markers.length,
    brushParts: brushBuild.stats,
    removed, modelFailures: failures, replacerModelsPassedOver: [...new Set(passedOver)],
    droppedBadTriangles: MeshBuilder.dropped,
    maxMeshTris: allMeshes.reduce((s, m) => Math.max(s, m.triCount), 0),
    oversizeMeshes: allMeshes.filter(m => Math.max(...m.size) > 2048).length,
  };
  fs.writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify(stats, null, 2));
  return { manifest, stats };
}
