// BSP -> engine-neutral scene: polygons per material, displacements, props,
// colliders, water, lights, sky. Everything stays in Source units until export.
import { CONTENTS, SURF, pointLeaf, modelBrushes } from './bsp.js';
import { loadMaterial, describeMaterial, normMat } from './vmt.js';
import { sub, add, mul, dot, cross, unit, len, vec3, angleMatrix, applyM } from './math.js';
import { brushPolys } from './collision.js';
import { clipOverlay } from './overlay.js';

const SKIP_CLASSES = /^(trigger_|func_areaportal|func_occluder|func_viscluster|func_clip|func_precipitation|func_dustmotes|func_dustcloud|func_smokevolume|func_buyzone|func_bomb_target|func_hostage_rescue|func_ladder|func_nav_|func_playerinfected|func_lod$|func_vehicleclip|func_vehicle_clip)/;
const MOVE_ANGLES = /^(func_door$|func_movelinear|func_button|momentary_door|func_water_analog)/;
const PROP_CLASSES = /^(prop_static|prop_dynamic|prop_dynamic_override|prop_dynamic_ornament|prop_physics|prop_physics_override|prop_physics_multiplayer|prop_door_rotating|prop_door_rotating_checkpoint|prop_detail)$/;

export function materialCache(vfs) {
  const cache = new Map();
  return name => {
    const id = normMat(name);
    let d = cache.get(id);
    if (!d) {
      d = describeMaterial(loadMaterial(vfs, id), id);
      // HDR skies name a plain 8-bit version as their fallback, which is ready to use as it is.
      if (d.fallback && (!d.base || d.hdrCompressed)) {
        const plain = describeMaterial(loadMaterial(vfs, d.fallback), d.fallback);
        if (plain.base && vfs.read(`materials/${plain.base}.vtf`)) d = { ...d, base: plain.base, hdrCompressed: false };
      }
      cache.set(id, d);
    }
    return d;
  };
}

/** A rotating door can start open: spawnpos 1 swings it forward, 2 swings it back. */
export function doorAngles(angles, cls, spawnpos, distance) {
  if (!/^prop_door_rotating/.test(cls)) return angles;
  const pos = Number(spawnpos) || 0;
  if (pos !== 1 && pos !== 2) return angles;
  const swing = Number(distance) || 90;
  return [angles[0], angles[1] + (pos === 1 ? swing : -swing), angles[2]];
}

function facePolygon(map, face) {
  const pts = [];
  for (let i = 0; i < face.numEdges; i++) {
    const se = map.surfedges[face.firstEdge + i];
    const v = se >= 0 ? map.edges[se * 2] : map.edges[-se * 2 + 1];
    pts.push([map.verts[v * 3], map.verts[v * 3 + 1], map.verts[v * 3 + 2]]);
  }
  return pts;
}

function faceNormal(map, face) {
  const i = face.plane * 4;
  const n = [map.planes[i], map.planes[i + 1], map.planes[i + 2]];
  return face.side ? mul(n, -1) : n;
}

/** Skybox-room test. Returns the area id holding sky_camera, or -1. */
function skyArea(map) {
  const cam = map.entities.find(e => e.classname === 'sky_camera');
  if (!cam) return -1;
  const leaf = map.leafs[pointLeaf(map, vec3(cam.origin))];
  return leaf ? leaf.area : -1;
}

function buildDisplacement(map, face, info, uvOf) {
  const corners = facePolygon(map, face);
  if (corners.length !== 4) return null;
  let first = 0, best = Infinity;
  for (let i = 0; i < 4; i++) {
    const d = sub(corners[i], info.start);
    const dd = dot(d, d);
    if (dd < best) { best = dd; first = i; }
  }
  const c = [0, 1, 2, 3].map(i => corners[(first + i) % 4]);
  const size = (1 << info.power) + 1;
  const pos = [], uv = [], alpha = [];
  const leftStep = mul(sub(c[1], c[0]), 1 / (size - 1));
  const rightStep = mul(sub(c[2], c[3]), 1 / (size - 1));
  for (let i = 0; i < size; i++) {
    const l = add(c[0], mul(leftStep, i));
    const r = add(c[3], mul(rightStep, i));
    const seg = mul(sub(r, l), 1 / (size - 1));
    for (let j = 0; j < size; j++) {
      const flat = add(l, mul(seg, j));
      const o = (info.vertStart + i * size + j) * 5;
      const v = [map.dispVerts[o], map.dispVerts[o + 1], map.dispVerts[o + 2]];
      const dist = map.dispVerts[o + 3];
      pos.push(add(flat, mul(v, dist)));
      uv.push(uvOf(flat));
      alpha.push(map.dispVerts[o + 4] / 255);
    }
  }
  const n = faceNormal(map, face);
  const sign = dot(cross(sub(c[1], c[0]), sub(c[3], c[0])), n) >= 0;
  const tris = [];
  for (let i = 0; i < size - 1; i++) {
    for (let j = 0; j < size - 1; j++) {
      const a = i * size + j, b = (i + 1) * size + j, cc = (i + 1) * size + j + 1, d = i * size + j + 1;
      // Source alternates the quad diagonal, which keeps slopes from looking saw-toothed.
      const q = (i + j) & 1 ? [a, b, d, b, cc, d] : [a, b, cc, a, cc, d];
      for (let t = 0; t < 6; t += 3) {
        if (sign) tris.push(q[t], q[t + 1], q[t + 2]); else tris.push(q[t], q[t + 2], q[t + 1]);
      }
    }
  }
  return { pos, uv, alpha, tris };
}

/** Position-welded smooth normals across every displacement, so seams don't show. */
function smoothDisplacements(disps) {
  const acc = new Map();
  const key = p => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)},${Math.round(p[2] * 2)}`;
  for (const d of disps) {
    for (let t = 0; t < d.tris.length; t += 3) {
      const a = d.pos[d.tris[t]], b = d.pos[d.tris[t + 1]], c = d.pos[d.tris[t + 2]];
      // CCW-from-outside after our winding choice in the builder; see makeDisp below.
      const n = cross(sub(b, a), sub(c, a));
      for (const p of [a, b, c]) {
        const k = key(p);
        const v = acc.get(k) ?? [0, 0, 0];
        v[0] += n[0]; v[1] += n[1]; v[2] += n[2];
        acc.set(k, v);
      }
    }
  }
  for (const d of disps) d.nrm = d.pos.map(p => unit(acc.get(key(p)) ?? [0, 0, 1]));
}

// Blend contours. Between each pair sits one band, drawn with a baked opaque mix.
// Eight steps: at four, the bands showed as contour lines on grass-to-sand edges.
const BLEND_BANDS = 8;
const BLEND_STEPS = Array.from({ length: BLEND_BANDS }, (_, i) => (i + 0.5) / BLEND_BANDS);
/** Material suffix per band: plain first texture, the baked mixes, plain second texture. */
export const BLEND_SUFFIX = ['', ...Array.from({ length: BLEND_BANDS - 1 }, (_, i) => `#m${i + 1}`), '#2'];
export const BLEND_MIX = Object.fromEntries(Array.from({ length: BLEND_BANDS - 1 }, (_, i) => [`#m${i + 1}`, (i + 1) / BLEND_BANDS]));
export const baseMatId = id => id.replace(/#(?:2|m[1-7])$/, '');

/** Cut triangles along one alpha contour. Returns [below, above], winding preserved. */
function clipAtAlpha(tris, level) {
  const below = [], above = [];
  const lerp = (i, j, t) => ({
    p: add(i.p, mul(sub(j.p, i.p), t)), u: [i.u[0] + (j.u[0] - i.u[0]) * t, i.u[1] + (j.u[1] - i.u[1]) * t],
    n: unit(add(i.n, mul(sub(j.n, i.n), t))), a: level,
  });
  for (const tri of tris) {
    const up = tri.map(x => x.a >= level);
    const cnt = up.filter(Boolean).length;
    if (cnt === 0) { below.push(tri); continue; }
    if (cnt === 3) { above.push(tri); continue; }
    // One vertex is alone on its side. Rotating it to slot 0 keeps the winding.
    const lone = cnt === 1 ? up.indexOf(true) : up.indexOf(false);
    const p0 = tri[lone], p1 = tri[(lone + 1) % 3], p2 = tri[(lone + 2) % 3];
    const q1 = lerp(p0, p1, (level - p0.a) / (p1.a - p0.a));
    const q2 = lerp(p0, p2, (level - p0.a) / (p2.a - p0.a));
    const tip = [p0, q1, q2], rest = [[q1, p1, p2], [q1, p2, q2]];
    if (cnt === 1) { above.push(tip); below.push(...rest); } else { below.push(tip); above.push(...rest); }
  }
  return [below, above];
}

// Point entities with no geometry that are only engine plumbing, so not worth a marker.
const NOT_MARKER = /^(prop_|light|func_|trigger_|env_|ambient_|logic_|point_|beam_|info_(overlay|decal|node|hint|lighting|particle|no_dynamic|target_tutorial|cubemap)|infodecal|sky_camera|shadow_control|worldspawn|filter_|math_|game_|phys|path_|keyframe_|move_rope|npc_|scripted_|aiscripted|ai_|assault_|water_lod)/;

/** Ropes, spawns and scriptable markers, from a plain key/value entity (BSP or VMF). */
export function noteEntity(scene, raw, isBrush, inSkybox) {
  if (isBrush) return;
  const e = {};
  for (const [k, v] of Object.entries(raw)) e[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  const cls = e.classname ?? '';
  if (!cls) return;
  // Mappers often tuck the fog controller into the skybox room, so this comes before that check.
  if (cls === 'env_fog_controller' || cls === 'env_fog') {
    const fog = {
      color: vec3(e.fogcolor, [128, 128, 128]), start: Number(e.fogstart) || 0, end: Number(e.fogend) || 0,
      maxDensity: Number(e.fogmaxdensity ?? 1), enabled: e.fogenable !== '0',
    };
    // Maps can hold several, for triggers to switch between. One that starts on wins.
    if (!scene.fog?.enabled) scene.fog = fog;
    return;
  }
  const origin = vec3(e.origin);
  if (inSkybox?.(origin)) return;
  const yaw = vec3(e.angles)[1];
  if (cls === 'keyframe_rope' || cls === 'move_rope') {
    (scene.ropes ??= []).push({
      name: e.targetname?.toLowerCase() ?? null, next: e.nextkey?.toLowerCase() ?? null, origin,
      slack: Number(e.slack) || 0, width: Number(e.width ?? 2) || 2, material: (e.ropematerial ?? '').toLowerCase(),
      // The engine's segment count for each Type, and 5 for a rope with no Type key.
      nodes: e.type === undefined ? 5 : [10, 4, 2][Number(e.type)] ?? 10,
    });
  } else if (/^info_player_/.test(cls)) {
    (scene.spawns ??= []).push({ cls, origin, yaw });
  } else if (!NOT_MARKER.test(cls)) {
    (scene.markers ??= []).push({ cls, name: e.targetname ?? null, origin, yaw });
  }
}

/** Add one finished displacement to the scene, slicing two-texture blends into bands. */
export function emitDisplacement(d, addPoly, grids) {
  // The whole surface, kept for colliders: the drawn pieces below are split up by material.
  if (!d.noPhysics) grids.push({ pos: d.pos, nrm: d.nrm, mat: d.mat.id });
  const vert = i => ({ p: d.pos[i], u: d.uv[i], n: d.nrm[i], a: d.alpha[i] });
  let rest = [];
  for (let t = 0; t < d.tris.length; t += 3) rest.push([vert(d.tris[t]), vert(d.tris[t + 1]), vert(d.tris[t + 2])]);
  const emit = (id, list) => {
    for (const t of list) addPoly(id, { pts: t.map(x => x.p), nrm: t.map(x => x.n), uv: t.map(x => x.u), disp: true });
  };
  if (!d.mat.base2) { emit(d.mat.id, rest); return; }
  BLEND_STEPS.forEach((level, band) => {
    const [below, above] = clipAtAlpha(rest, level);
    emit(`${d.mat.id}${BLEND_SUFFIX[band]}`, below);
    rest = above;
  });
  emit(`${d.mat.id}#2`, rest);
}

export function buildScene(map, vfs, opts = {}) {
  const getMat = materialCache(vfs);
  const scene = {
    polys: new Map(), // materialId -> [{pts,nrm,uv,disp?}]
    entitiesUsed: [], props: [], lights: [], water: [], decals: [], solids: [], dispSolids: [], dispGrids: [],
    getMat, warnings: [], sky: null, sun: null, mapName: opts.mapName ?? 'map', stats: {},
  };
  const addPoly = (mat, poly) => {
    let l = scene.polys.get(mat);
    if (!l) scene.polys.set(mat, (l = []));
    l.push(poly);
  };

  const skyId = opts.keep3DSkybox ? -1 : skyArea(map);
  const skyFaces = new Set();
  if (skyId >= 0) {
    for (const leaf of map.leafs) {
      if (leaf.area !== skyId) continue;
      for (let i = 0; i < leaf.numLeafFaces; i++) skyFaces.add(map.leafFaces[leaf.firstLeafFace + i]);
    }
  }
  const inSkybox = p => {
    if (skyId < 0) return false;
    const l = map.leafs[pointLeaf(map, p)];
    return !!l && l.area === skyId;
  };

  // Offsets into the vertex-normal index table, per face.
  let vnOffsets = null;
  const totalEdges = map.faces.reduce((s, f) => s + f.numEdges, 0);
  if (map.vertNormalIndices.length === totalEdges) {
    vnOffsets = new Int32Array(map.faces.length);
    let o = 0;
    map.faces.forEach((f, i) => { vnOffsets[i] = o; o += f.numEdges; });
  }

  const disps = [];

  const addFace = (fi, xf) => {
    const face = map.faces[fi];
    if (face.texinfo < 0) return;
    const ti = map.texinfo[face.texinfo];
    if (!ti || ti.flags & (SURF.NODRAW | SURF.SKY | SURF.SKY2D | SURF.HINT | SURF.SKIP | SURF.TRIGGER)) return;
    const td = map.texdata[ti.texdata];
    if (!td || !td.name) return;
    const mat = getMat(td.name);
    if (mat.isTool) return;
    if (mat.isWater && opts.terrainWater !== false) return;

    const w = td.width || 512, h = td.height || 512;
    const uvOf = p => [
      (ti.s[0] * p[0] + ti.s[1] * p[1] + ti.s[2] * p[2] + ti.s[3]) / w,
      (ti.t[0] * p[0] + ti.t[1] * p[1] + ti.t[2] * p[2] + ti.t[3]) / h,
    ];

    if (face.dispinfo >= 0) {
      const info = map.dispInfos[face.dispinfo];
      if (!info) return;
      const d = buildDisplacement(map, face, info, uvOf);
      if (d) { d.mat = mat; disps.push(d); }
      return;
    }

    const pts = facePolygon(map, face);
    if (pts.length < 3) return;
    const n = faceNormal(map, face);
    let nrm = pts.map(() => n);
    if (vnOffsets) {
      const base = vnOffsets[fi];
      const vn = pts.map((_, i) => {
        const k = map.vertNormalIndices[base + i] * 3;
        return [map.vertNormals[k], map.vertNormals[k + 1], map.vertNormals[k + 2]];
      });
      // Guard against a bad table entry: a real smoothed normal stays on the face's side.
      if (vn.every(v => dot(v, n) > 0.05)) nrm = vn;
    }
    const uv = pts.map(uvOf);
    let P = pts, N = nrm;
    if (xf) { P = pts.map(xf.point); N = nrm.map(xf.dir); }
    addPoly(mat.id, { pts: P, nrm: N, uv, faceN: xf ? xf.dir(n) : n });
  };

  const world = map.models[0];
  for (let i = 0; i < world.numFaces; i++) {
    const fi = world.firstFace + i;
    if (!skyFaces.has(fi)) addFace(fi, null);
  }

  // Brush entities (func_detail is already merged into the world by vbsp).
  const brushOwner = new Map();
  for (const b of modelBrushes(map, 0)) brushOwner.set(b, { xf: null, cls: 'world' });

  for (const e of map.entities) {
    const cls = e.classname ?? '';
    if (typeof e.model !== 'string' || e.model[0] !== '*') continue;
    if (SKIP_CLASSES.test(cls)) continue;
    const idx = Number(e.model.slice(1));
    const m = map.models[idx];
    if (!m) continue;
    const origin = vec3(e.origin);
    const angles = MOVE_ANGLES.test(cls) ? [0, 0, 0] : vec3(e.angles);
    const R = angleMatrix(angles);
    const xf = { point: p => add(applyM(R, p), origin), dir: n => applyM(R, n) };
    const hidden = e.startdisabled === '1' || e.rendermode === '10';
    if (!hidden) for (let i = 0; i < m.numFaces; i++) addFace(m.firstFace + i, xf);
    if (cls !== 'func_illusionary' && !/^func_(water|reflective)/.test(cls)) {
      const door = /^func_door/.test(cls) ? { id: idx, name: e.targetname ?? null } : null;
      for (const b of modelBrushes(map, idx)) if (!brushOwner.has(b)) brushOwner.set(b, { xf, cls, door });
    }
  }

  // Displacements: smooth once, then split two-texture blends.
  if (disps.length) smoothDisplacements(disps);
  for (const d of disps) emitDisplacement(d, addPoly, scene.dispGrids);
  scene.dispCount = disps.length;

  // Convex solids: colliders and water volumes.
  const planeOf = (ps, xf) => {
    const i = ps.plane * 4;
    const n = [map.planes[i], map.planes[i + 1], map.planes[i + 2]];
    const d = map.planes[i + 3];
    if (!xf) return { n, d };
    const N = xf.dir(n), P = xf.point(mul(n, d));
    return { n: N, d: dot(N, P) };
  };
  map.brushes.forEach((b, i) => {
    const owner = brushOwner.get(i);
    if (!owner) return;
    const solid = b.contents & (CONTENTS.SOLID | CONTENTS.PLAYERCLIP | CONTENTS.WINDOW | CONTENTS.GRATE | CONTENTS.MOVEABLE);
    const water = b.contents & (CONTENTS.WATER | CONTENTS.SLIME);
    if (!solid && !water) return;
    const planes = [];
    const faces = [];
    let hasDisp = false, visible = false;
    for (let s = 0; s < b.numSides; s++) {
      const side = map.brushSides[b.firstSide + s];
      if (side.bevel) continue;
      const plane = planeOf(side, owner.xf);
      planes.push(plane);
      if (side.disp) hasDisp = true;
      // The same side again with its texture axes, for the optional Parts build.
      const ti = side.texinfo >= 0 ? map.texinfo[side.texinfo] : null;
      const td = ti && map.texdata[ti.texdata];
      const skip = !td?.name || ti.flags & (SURF.NODRAW | SURF.SKY | SURF.SKY2D | SURF.HINT | SURF.SKIP | SURF.TRIGGER);
      const m = skip ? null : getMat(td.name);
      const mat = m && !m.isTool && !m.isWater ? m.id : null;
      if (mat) visible = true;
      const move = (v) => {
        if (!owner.xf) return v;
        const dir = owner.xf.dir(v);
        return [...dir, v[3] - dot(dir, owner.xf.point([0, 0, 0]))];
      };
      faces.push({ ...plane, mat, w: td?.width || 512, h: td?.height || 512, s: ti ? move(ti.s) : [1, 0, 0, 0], t: ti ? move(ti.t) : [0, 1, 0, 0] });
    }
    if (planes.length < 4) return;
    const mid = brushCentre(planes);
    if (mid && inSkybox(mid)) return;
    if (visible && !hasDisp && !water) (scene.brushes ??= []).push({ faces, noCollide: false, door: owner.door ?? null });
    planes.toolOnly = !visible;
    if (water) {
      const polys = brushPolys(planes);
      if (polys.length < 4) return;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const p of polys) {
        for (const v of p.pts) {
          for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
        }
      }
      scene.water.push({ lo, hi, slime: !!(b.contents & CONTENTS.SLIME) });
    } else scene.solids.push(planes);
  });

  // Props: static-prop lump plus prop entities.
  for (const p of map.staticProps) {
    if (inSkybox(p.origin)) continue;
    scene.props.push({ model: p.model, origin: p.origin, angles: p.angles, scale: p.scale, skin: p.skin, body: 0, solid: p.solid !== 0, tint: p.tint, cls: 'prop_static' });
  }
  for (const e of map.entities) {
    const cls = e.classname ?? '';
    noteEntity(scene, e, typeof e.model === 'string' && e.model.startsWith('*'), inSkybox);
    if (PROP_CLASSES.test(cls) && typeof e.model === 'string' && /\.mdl$/i.test(e.model)) {
      const origin = vec3(e.origin);
      if (inSkybox(origin)) continue;
      const rc = vec3(e.rendercolor, [255, 255, 255]);
      scene.props.push({
        model: e.model.replace(/\\/g, '/').toLowerCase(), origin, angles: doorAngles(vec3(e.angles), cls, e.spawnpos, e.distance), scale: Number(e.modelscale) || 1,
        skin: Number(e.skin) || 0, body: Number(e.body ?? e.SetBodyGroup ?? e.setbodygroup) || 0, solid: e.solid !== '0',
        tint: [...rc, Number(e.renderamt) || 255], cls, name: e.targetname ?? null,
        hardware: cls === 'prop_door_rotating' ? Number(e.hardware) || 0 : null,
      });
    }
    if (/^light(_spot)?$/.test(cls)) {
      const raw = (e._light ?? '255 255 255 200').trim().split(/\s+/).map(Number);
      const origin = vec3(e.origin);
      if (inSkybox(origin)) continue;
      scene.lights.push({
        origin, color: raw.slice(0, 3), brightness: raw[3] ?? 200, spot: cls === 'light_spot',
        cone: Number(e._cone) || 45, angles: vec3(e.angles), pitch: e.pitch !== undefined ? Number(e.pitch) : null,
        distance: Number(e._distance) || 0,
      });
    }
    if (cls === 'light_environment') {
      const raw = (e._light ?? '255 255 255 200').trim().split(/\s+/).map(Number);
      const amb = (e._ambient ?? '').trim().split(/\s+/).map(Number);
      const ang = vec3(e.angles);
      if (Number(e.pitch)) ang[0] = Number(e.pitch);
      scene.sun = { color: raw.slice(0, 3), brightness: raw[3] ?? 200, ambient: amb.length >= 3 && amb.every(n => !Number.isNaN(n)) ? amb.slice(0, 3) : null, ambientBrightness: amb[3] ?? 200, angles: ang };
    }
    if (cls === 'infodecal' && e.texture) {
      const origin = vec3(e.origin);
      if (!inSkybox(origin)) scene.decals.push({ material: normMat(e.texture), origin });
    }
  }
  const ws = map.entities.find(e => e.classname === 'worldspawn');
  if (ws?.skyname) scene.sky = ws.skyname.toLowerCase();

  // Overlays
  scene.overlays = [];
  for (const o of map.overlays) {
    const ti = map.texinfo[o.texinfo];
    const td = ti && map.texdata[ti.texdata];
    if (!td) continue;
    if (inSkybox(o.origin)) continue;
    const basisU = [o.pts[0][2], o.pts[1][2], o.pts[2][2]];
    const basisN = o.normal;
    let basisV = cross(basisN, basisU);
    if (o.pts[3][2] === 1) basisV = mul(basisV, -1);
    const pts = o.pts.map(p => add(add(o.origin, mul(basisU, p[0])), mul(basisV, p[1])));
    const [U0, U1, V0, V1] = o.uv;
    const uv = [[U0, V0], [U0, V1], [U1, V1], [U1, V0]];
    const faces = o.faces.map(i => map.faces[i]).filter(Boolean);
    const flat = faces.length > 0 && faces.every(f => f.dispinfo < 0);
    scene.overlays.push({
      material: normMat(td.name), pts, normal: basisN, uv,
      pieces: flat ? clipOverlay(pts, uv, basisN, faces.map(f => ({ pts: facePolygon(map, f), n: faceNormal(map, f) }))) : null,
    });
  }
  return scene;
}

function brushCentre(planes) {
  // Cheap, adequate: average of the plane points after clipping is wasteful, so
  // use the mean of the plane anchor points. Only used for skybox-room tests.
  let c = [0, 0, 0];
  for (const p of planes) c = add(c, mul(p.n, p.d));
  return mul(c, 1 / planes.length);
}
