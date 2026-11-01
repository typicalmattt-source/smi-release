// Hammer .vmf input. Produces the same scene shape as the BSP path. A VMF has no
// visibility data or pakfile, so custom content must sit in a folder beside it, or in a
// same-named .bsp, which the loader mounts.
import { materialCache, emitDisplacement, noteEntity } from './scene.js';
import { normMat } from './vmt.js';
import { vtfInfo } from './vtf.js';
import { brushPolys } from './collision.js';
import { clipOverlay } from './overlay.js';
import { sub, add, mul, dot, cross, unit, len, vec3 } from './math.js';

/** KeyValues keeping repeats: each node is {k:{key:[values]}, c:[{name,node}]}. */
export function parseVmf(text) {
  let i = 0;
  const n = text.length;
  const skip = () => {
    for (;;) {
      while (i < n && text.charCodeAt(i) <= 32) i++;
      if (text[i] === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
      return;
    }
  };
  const tok = () => {
    skip();
    if (i >= n) return null;
    const c = text[i];
    if (c === '{' || c === '}') { i++; return c; }
    if (c === '"') {
      const e = text.indexOf('"', i + 1);
      const s = text.slice(i + 1, e < 0 ? n : e);
      i = e < 0 ? n : e + 1;
      return { s };
    }
    const st = i;
    while (i < n && text.charCodeAt(i) > 32 && text[i] !== '{' && text[i] !== '}') i++;
    return { s: text.slice(st, i) };
  };
  const block = root => {
    const node = { k: {}, c: [] };
    for (;;) {
      const a = tok();
      if (a === null) { if (root) return node; return node; }
      if (a === '}') return node;
      if (a === '{') continue;
      const b = tok();
      if (b === null) return node;
      if (b === '{') node.c.push({ name: a.s.toLowerCase(), node: block(false) });
      else if (b === '}') return node;
      else (node.k[a.s.toLowerCase()] ??= []).push(b.s);
    }
  };
  return block(true);
}

const key = (node, k) => node.k[k]?.[0];
const nums = s => (s.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi) ?? []).map(Number);

/** As vbsp does: pull almost-whole coordinates onto the grid, then drop the points that merges. */
function cleanWinding(pts) {
  const snap = v => (Math.abs(v - Math.round(v)) < 0.01 ? Math.round(v) : v);
  const out = [];
  for (const p of pts) {
    const q = p.map(snap);
    const last = out[out.length - 1];
    if (!last || len(sub(q, last)) >= 0.1) out.push(q);
  }
  if (out.length > 1 && len(sub(out[0], out[out.length - 1])) < 0.1) out.pop();
  return out;
}

function axis(s) {
  const m = nums(s);
  return { v: m.slice(0, 3), off: m[3] ?? 0, scale: m[4] || 0.25 };
}

export function buildSceneFromVmf(text, vfs, opts = {}) {
  const root = parseVmf(text);
  const getMat = materialCache(vfs);
  const scene = {
    polys: new Map(), props: [], lights: [], water: [], decals: [], solids: [], overlays: [],
    getMat, sky: null, sun: null, mapName: opts.mapName ?? 'map', dispCount: 0,
  };
  const addPoly = (m, p) => (scene.polys.get(m) ?? scene.polys.set(m, []).get(m)).push(p);
  const texSize = new Map();
  // Tiling is fixed against the texture the map was compiled with. A high-res replacer has to
  // keep that size, or it would tile at double scale across every wall.
  const original = vfs.original();
  const originalMat = materialCache(original);
  const sizeOf = mat => {
    if (texSize.has(mat.id)) return texSize.get(mat.id);
    let s = [512, 512];
    const was = originalMat(mat.id).base;
    const b = (was && original.read(`materials/${was}.vtf`)) || (mat.base && vfs.read(`materials/${mat.base}.vtf`));
    if (b) { try { const v = vtfInfo(b); s = [v.width, v.height]; } catch { /* keep the default */ } }
    texSize.set(mat.id, s);
    return s;
  };

  const disps = [];
  // Each brush side's polygon by Hammer id, so overlays can find what they're attached to.
  const sideFaces = new Map();
  let doorCount = 0;
  const addSolid = (solid, opts2 = {}) => {
    const sides = solid.c.filter(c => c.name === 'side').map(c => c.node);
    if (sides.length < 4) return;
    const raw = sides.map(s => {
      const p = nums(key(s, 'plane') ?? '');
      return { p: [p.slice(0, 3), p.slice(3, 6), p.slice(6, 9)], s };
    }).filter(r => r.p[2].length === 3);
    // vbsp's PlaneFromPoints: cross(p0-p1, p2-p1) points outward.
    let planes = raw.map(r => {
      const nrm = unit(cross(sub(r.p[0], r.p[1]), sub(r.p[2], r.p[1])));
      return { n: nrm, d: dot(nrm, r.p[0]), side: r.s };
    });
    let c = [0, 0, 0];
    for (const r of raw) c = add(c, mul(add(add(r.p[0], r.p[1]), r.p[2]), 1 / 3));
    c = mul(c, 1 / raw.length);
    // Hand-edited or converted files can wind faces the other way. A convex solid's
    // interior point must be behind every plane, so each plane is checked on its own.
    planes = planes.map(p => (dot(p.n, c) - p.d > 0 ? { n: mul(p.n, -1), d: -p.d, side: p.side } : p));

    const polys = brushPolys(planes);
    for (const poly of polys) poly.pts = cleanWinding(poly.pts);
    let hasDisp = false;
    for (const poly of polys) {
      const s = planes[poly.plane].side;
      const disp = s.c.some(x => x.name === 'dispinfo');
      if (disp) hasDisp = true;
      sideFaces.set(key(s, 'id'), { pts: poly.pts, n: poly.n, disp });
    }
    for (const poly of polys) {
      const s = planes[poly.plane].side;
      const matName = key(s, 'material');
      if (!matName) continue;
      const mat = getMat(matName);
      const dispNode = s.c.find(x => x.name === 'dispinfo');
      if (!dispNode && hasDisp) continue; // the rest of a displacement's brush isn't rendered
      if (mat.isTool) continue;
      if (mat.isWater && opts.terrainWater !== false) continue;
      const [tw, th] = sizeOf(mat);
      const U = axis(key(s, 'uaxis') ?? ''), V = axis(key(s, 'vaxis') ?? '');
      const uvOf = p => [
        (dot(p, U.v) / U.scale + U.off) / tw,
        (dot(p, V.v) / V.scale + V.off) / th,
      ];
      if (dispNode) {
        const d = buildVmfDisp(poly, dispNode.node, uvOf);
        if (d) { d.mat = mat; disps.push(d); }
        continue;
      }
      addPoly(mat.id, { pts: poly.pts, nrm: poly.pts.map(() => poly.n), uv: poly.pts.map(uvOf), faceN: poly.n });
    }
    if (!hasDisp) {
      // The same solid again with its texture axes, for the optional Parts build.
      const faces = planes.map(p => {
        const m = getMat(key(p.side, 'material') ?? '');
        const [tw, th] = sizeOf(m);
        const U = axis(key(p.side, 'uaxis') ?? ''), V = axis(key(p.side, 'vaxis') ?? '');
        return {
          n: p.n, d: p.d, mat: m.isTool || m.isWater ? null : m.id, w: tw, h: th,
          s: [...mul(U.v, 1 / U.scale), U.off], t: [...mul(V.v, 1 / V.scale), V.off],
        };
      });
      if (faces.some(f => f.mat)) (scene.brushes ??= []).push({ faces, noCollide: !!opts2.noCollide, door: opts2.door ?? null });
    }
    if (hasDisp || opts2.noCollide) return;
    const matNames = sides.map(s => normMat(key(s, 'material') ?? ''));
    if (matNames.some(m => /^tools\/(toolstrigger|toolsskip|toolshint|toolsareaportal|toolsoccluder|toolsfog|toolsskybox)/.test(m))) return;
    const water = matNames.some(m => getMat(m).isWater);
    const pure = planes.map(p => ({ n: p.n, d: p.d }));
    pure.toolOnly = matNames.every(m => getMat(m).isTool);
    if (water) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const p of polys) {
        for (const v of p.pts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
      }
      scene.water.push({ lo, hi, slime: false });
    } else scene.solids.push(pure);
  };

  const world = root.c.find(c => c.name === 'world')?.node;
  if (world) {
    for (const c of world.c) if (c.name === 'solid') addSolid(c.node);
    const sky = key(world, 'skyname');
    if (sky) scene.sky = sky.toLowerCase();
  }

  for (const c of root.c) {
    if (c.name !== 'entity') continue;
    const e = c.node;
    const cls = key(e, 'classname') ?? '';
    if (/^(trigger_|func_areaportal|func_occluder|func_viscluster|func_clip|func_nav_|func_buyzone|func_ladder)/.test(cls)) continue;
    const solids = e.c.filter(x => x.name === 'solid');
    const noCollide = cls === 'func_illusionary';
    const door = /^func_door/.test(cls) ? { id: ++doorCount, name: key(e, 'targetname') ?? null } : null;
    for (const s of solids) addSolid(s.node, { noCollide, door });
    noteEntity(scene, e.k, solids.length > 0);
    const model = key(e, 'model');
    const origin = vec3(key(e, 'origin'));
    if (/^prop_(static|dynamic|dynamic_override|physics|physics_override|physics_multiplayer|door_rotating)$/.test(cls) && model && /\.mdl$/i.test(model)) {
      scene.props.push({
        model: model.replace(/\\/g, '/').toLowerCase(), origin, angles: vec3(key(e, 'angles')),
        scale: Number(key(e, 'modelscale') ?? key(e, 'uniformscale')) || 1, skin: Number(key(e, 'skin')) || 0, body: Number(key(e, 'body') ?? key(e, 'setbodygroup')) || 0,
        solid: key(e, 'solid') !== '0', tint: [...vec3(key(e, 'rendercolor'), [255, 255, 255]), Number(key(e, 'renderamt') ?? 255)], cls,
        name: key(e, 'targetname') ?? null,
        hardware: cls === 'prop_door_rotating' ? Number(key(e, 'hardware')) || 0 : null,
      });
    }
    if (cls === 'light' || cls === 'light_spot') {
      const raw = (key(e, '_light') ?? '255 255 255 200').trim().split(/\s+/).map(Number);
      const p = key(e, 'pitch');
      scene.lights.push({
        origin, color: raw.slice(0, 3), brightness: raw[3] ?? 200, spot: cls === 'light_spot',
        cone: Number(key(e, '_cone')) || 45, angles: vec3(key(e, 'angles')), pitch: p !== undefined ? Number(p) : null,
        distance: Number(key(e, '_distance')) || 0,
      });
    }
    if (cls === 'light_environment') {
      const raw = (key(e, '_light') ?? '255 255 255 200').trim().split(/\s+/).map(Number);
      const amb = (key(e, '_ambient') ?? '').trim().split(/\s+/).map(Number);
      const ang = vec3(key(e, 'angles'));
      if (Number(key(e, 'pitch'))) ang[0] = Number(key(e, 'pitch'));
      scene.sun = { color: raw.slice(0, 3), brightness: raw[3] ?? 200, ambient: amb.length >= 3 ? amb.slice(0, 3) : null, angles: ang };
    }
    if (cls === 'infodecal' && key(e, 'texture')) scene.decals.push({ material: normMat(key(e, 'texture')), origin });
    if (cls === 'info_overlay' && key(e, 'material')) {
      const basisU = vec3(key(e, 'basisu')), basisV = vec3(key(e, 'basisv')), n = vec3(key(e, 'basisnormal'));
      const org = vec3(key(e, 'basisorigin'), origin);
      const uvp = ['uv0', 'uv1', 'uv2', 'uv3'].map(k => vec3(key(e, k)));
      const su = Number(key(e, 'startu') ?? 0), eu = Number(key(e, 'endu') ?? 1);
      const sv = Number(key(e, 'startv') ?? 0), ev = Number(key(e, 'endv') ?? 1);
      scene.overlays.push({
        material: normMat(key(e, 'material')), normal: n,
        pts: uvp.map(p => add(add(org, mul(basisU, p[0])), mul(basisV, p[1]))),
        uv: [[su, sv], [su, ev], [eu, ev], [eu, sv]],
        sides: (key(e, 'sides') ?? '').trim().split(/\s+/).filter(Boolean),
      });
    }
  }

  // After the loop: an overlay can come before the brush entity it sits on.
  for (const o of scene.overlays) {
    const faces = o.sides.map(id => sideFaces.get(id)).filter(Boolean);
    const flat = faces.length > 0 && faces.every(f => !f.disp);
    o.pieces = flat ? clipOverlay(o.pts, o.uv, o.normal, faces) : null;
  }

  // Same treatment as the BSP path: welded smooth normals across displacements.
  const key3 = p => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)},${Math.round(p[2] * 2)}`;
  const acc = new Map();
  for (const d of disps) {
    for (let t = 0; t < d.tris.length; t += 3) {
      const a = d.pos[d.tris[t]], b = d.pos[d.tris[t + 1]], c = d.pos[d.tris[t + 2]];
      const f = cross(sub(b, a), sub(c, a));
      for (const p of [a, b, c]) {
        const k = key3(p);
        const v = acc.get(k) ?? [0, 0, 0];
        v[0] += f[0]; v[1] += f[1]; v[2] += f[2];
        acc.set(k, v);
      }
    }
  }
  for (const d of disps) {
    d.nrm = d.pos.map(p => unit(acc.get(key3(p)) ?? [0, 0, 1]));
    emitDisplacement(d, addPoly);
  }
  scene.dispCount = disps.length;
  return scene;
}

function buildVmfDisp(poly, node, uvOf) {
  if (poly.pts.length !== 4) return null;
  const power = Number(key(node, 'power'));
  const start = nums(key(node, 'startposition') ?? '');
  if (!power || start.length < 3) return null;
  const size = (1 << power) + 1;
  const section = name => node.c.find(c => c.name === name)?.node;
  const rows = name => {
    const s = section(name);
    if (!s) return null;
    const out = [];
    for (let r = 0; r < size; r++) out.push(nums(key(s, `row${r}`) ?? ''));
    return out;
  };
  const normals = rows('normals'), dists = rows('distances'), offs = rows('offsets'), alphas = rows('alphas');
  if (!normals || !dists) return null;

  // Rows run along Source's clockwise face winding. brushPolys winds the other way, which
  // would mirror every displacement across its diagonal, so put the corners in Source's order.
  const clockwise = dot(cross(sub(poly.pts[1], poly.pts[0]), sub(poly.pts[2], poly.pts[0])), poly.n) < 0;
  const pts = clockwise ? poly.pts : [...poly.pts].reverse();
  let first = 0, best = Infinity;
  pts.forEach((p, i) => {
    const d = sub(p, start);
    const dd = dot(d, d);
    if (dd < best) { best = dd; first = i; }
  });
  const c = [0, 1, 2, 3].map(i => pts[(first + i) % 4]);
  const leftStep = mul(sub(c[1], c[0]), 1 / (size - 1));
  const rightStep = mul(sub(c[2], c[3]), 1 / (size - 1));
  const lift = mul(poly.n, Number(key(node, 'elevation')) || 0);
  const pos = [], uv = [], alpha = [];
  for (let i = 0; i < size; i++) {
    const l = add(c[0], mul(leftStep, i));
    const r = add(c[3], mul(rightStep, i));
    const seg = mul(sub(r, l), 1 / (size - 1));
    for (let j = 0; j < size; j++) {
      const flat = add(l, mul(seg, j));
      const n = normals[i].slice(j * 3, j * 3 + 3);
      const dist = dists[i][j] ?? 0;
      const o = offs ? offs[i].slice(j * 3, j * 3 + 3) : [0, 0, 0];
      pos.push(add(add(add(flat, lift), o.length === 3 ? o : [0, 0, 0]), mul(n.length === 3 ? n : [0, 0, 0], dist)));
      uv.push(uvOf(flat));
      alpha.push((alphas?.[i]?.[j] ?? 0) / 255);
    }
  }
  const sign = dot(cross(sub(c[1], c[0]), sub(c[3], c[0])), poly.n) >= 0;
  const tris = [];
  for (let i = 0; i < size - 1; i++) {
    for (let j = 0; j < size - 1; j++) {
      const a = i * size + j, b = (i + 1) * size + j, cc = (i + 1) * size + j + 1, d = i * size + j + 1;
      const q = (i + j) & 1 ? [a, b, d, b, cc, d] : [a, b, cc, a, cc, d];
      for (let t = 0; t < 6; t += 3) {
        if (sign) tris.push(q[t], q[t + 1], q[t + 2]); else tris.push(q[t], q[t + 2], q[t + 1]);
      }
    }
  }
  return { pos, uv, alpha, tris };
}
