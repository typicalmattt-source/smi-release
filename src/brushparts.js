// Brushes as real Roblox Parts, the optional alternative to the World meshes. A box becomes a
// Part. Anything else becomes one bounding Part that the plugin cuts along each brush plane.
// Both carry Texture objects positioned from the brush's own texture axes.
import { sub, add, mul, dot, cross, unit, len, toRbx } from './math.js';
import { brushPolys, boxOf } from './collision.js';

// How Roblox lays a Texture on each face, measured in Studio: +U and +V in part space.
// The sampled coordinate is (distance + Offset) / StudsPerTile, from the corner where both start.
const FACES = [
  { n: [1, 0, 0], r: [0, 0, -1], d: [0, -1, 0] },  // Right
  { n: [0, 1, 0], r: [-1, 0, 0], d: [0, 0, -1] },  // Top
  { n: [0, 0, 1], r: [1, 0, 0], d: [0, -1, 0] },   // Back
  { n: [-1, 0, 0], r: [0, 0, 1], d: [0, -1, 0] },  // Left
  { n: [0, -1, 0], r: [1, 0, 0], d: [0, 0, -1] },  // Bottom
  { n: [0, 0, -1], r: [-1, 0, 0], d: [0, -1, 0] }, // Front
];

const r3 = v => Math.round(v * 1000) / 1000;
const EPS = 0.02;
const worldOf = (frame, v) => add(add(mul(frame[0], v[0]), mul(frame[1], v[1])), mul(frame[2], v[2]));

function polyArea(pts) {
  let total = [0, 0, 0];
  for (let i = 1; i + 1 < pts.length; i++) total = add(total, cross(sub(pts[i], pts[0]), sub(pts[i + 1], pts[0])));
  return len(total) / 2;
}

/** Every right-handed way of laying a Part's axes along these three. */
function framesFrom(axes) {
  const out = [];
  // A brush counts as a box with its corners slightly off square, but a Part's axes must be exact.
  // Near the edge of a large map, even a 0.1 degree error moves the Part by a visible amount.
  const a = unit(axes[0]);
  const b = unit(sub(axes[1], mul(a, dot(axes[1], a))));
  const signed = [a, b, cross(a, b)].flatMap(v => [v, mul(v, -1)]);
  for (const x of signed) {
    for (const y of signed) {
      if (Math.abs(dot(x, y)) > 1e-6) continue;
      out.push([x, y, cross(x, y)]);
    }
  }
  return out;
}

/** The Part's size and centre in a frame, from the brush's corners. */
function fit(frame, pts) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    for (let k = 0; k < 3; k++) {
      const t = dot(p, frame[k]);
      lo[k] = Math.min(lo[k], t); hi[k] = Math.max(hi[k], t);
    }
  }
  const size = hi.map((h, k) => h - lo[k]);
  const centre = worldOf(frame, hi.map((h, k) => (h + lo[k]) / 2));
  return { size, centre };
}

/**
 * Express one brush face's texture as a Roblox Texture on the Part face nearest to it.
 * The brush face may be slanted against that Part face, so the texture gradients are
 * flattened along the Part's normal, which is how a Texture projects onto a union.
 */
function mapFace(face, frame, shape) {
  let best = -1, F = null;
  for (let i = 0; i < 6; i++) {
    const d = dot(face.n, worldOf(frame, FACES[i].n));
    if (d > (F ? F.c : -2)) { best = i; F = { c: d }; }
  }
  if (F.c < 0.3) return null;
  const fn = worldOf(frame, FACES[best].n), R = worldOf(frame, FACES[best].r), D = worldOf(frame, FACES[best].d);
  const flat = g => {
    const along = dot(g, fn) / F.c;
    return [dot(g, R) - along * dot(face.n, R), dot(g, D) - along * dot(face.n, D)];
  };
  const [ua, ub] = flat(face.gu), [va, vb] = flat(face.gv);

  // Corner where a and b start, moved onto the brush face along the Part's normal.
  const half = shape.size.map(v => v / 2);
  const local = [0, 1, 2].map(k => FACES[best].n[k] * half[k] - FACES[best].r[k] * half[k] - FACES[best].d[k] * half[k]);
  const corner = add(shape.centre, worldOf(frame, local));
  const onFace = add(corner, mul(fn, (face.d - dot(face.n, corner)) / F.c));
  const ku = dot(onFace, face.gu) + face.ou, kv = dot(onFace, face.gv) + face.ov;

  const lenU = Math.hypot(ua, ub), lenV = Math.hypot(va, vb);
  if (lenU < 1e-9 || lenV < 1e-9) return null;
  const straight = Math.abs(ub) < EPS * lenU && Math.abs(va) < EPS * lenV;
  const swapped = Math.abs(ua) < EPS * lenU && Math.abs(vb) < EPS * lenV;
  const wrap = (v, t) => ((v % t) + t) % t;
  const place = (sKey, tKey, su, sv, xf, kind) => ({
    face: best, kind, xf, su, sv, ou: wrap(sKey * su, su), ov: wrap(tKey * sv, sv),
    corner, R, D,
  });
  // A Texture can only slide an image, so any other orientation needs a baked copy (see XFORMS).
  if (straight) {
    const xf = ua > 0 ? (vb > 0 ? '' : 'fv') : (vb > 0 ? 'fu' : 'r2');
    return place(ua > 0 ? ku : 1 - ku, vb > 0 ? kv : 1 - kv, 1 / Math.abs(ua), 1 / Math.abs(vb), xf, xf ? 'flip' : 'exact');
  }
  if (swapped) {
    const xf = ub > 0 ? (va > 0 ? 't' : 'r1') : (va > 0 ? 'r3' : 'at');
    return place(va > 0 ? kv : 1 - kv, ub > 0 ? ku : 1 - ku, 1 / Math.abs(va), 1 / Math.abs(ub), xf, 'swap');
  }
  return { face: best, kind: 'skew', xf: '', su: 1 / lenU, sv: 1 / lenV, ou: 0, ov: 0, corner, R, D };
}

// Each extra orientation costs another uploaded image, so the plain one wins a close call.
const WEIGHT = { exact: 1, flip: 0.8, skew: 0.5, swap: 0.8 };

function bestLayout(faces, frames, pts) {
  let best = null;
  for (const frame of frames) {
    const shape = fit(frame, pts);
    const mapped = new Map();
    let score = 0;
    for (const f of faces) {
      if (f.mat === null) continue;
      const m = mapFace(f, frame, shape);
      if (!m) continue;
      // Slanted faces can share a Part face. Only one Texture fits, so the largest wins.
      const held = mapped.get(m.face);
      if (held && held.area >= f.area) continue;
      if (held) score -= WEIGHT[held.kind] * held.area;
      mapped.set(m.face, { ...m, area: f.area, mat: f.mat, src: f });
      score += WEIGHT[m.kind] * f.area;
    }
    // A Part standing upright is easier to work with, so that wins a tie.
    score += frame[1][1] * 1e-3;
    if (!best || score > best.score) best = { frame, shape, mapped, score };
  }
  return best;
}

// A union paints each surface with the Texture of the box side it faces most (measured in Studio,
// right up to 44 degrees). So a slanted brush's union can show its own faces, one per side, and
// each one saves a plate. A face that doesn't fit gets a plate, which just covers whatever the
// union painted there. The margin keeps a face off the tie between two sides.
const SIDE_MARGIN = 0.15, FIT_TILES = 0.01;

const offBy = d => { const t = Math.abs(d) % 1; return Math.min(t, 1 - t); };

/** True when a Texture shows this face's image correctly at all its corners. */
function fitsFace(m, f) {
  return f.pts.every(p => {
    const a = dot(sub(p, m.corner), m.R), b = dot(sub(p, m.corner), m.D);
    const [u, v] = XFORMS[m.xf]((a + m.ou) / m.su, (b + m.ov) / m.sv);
    return offBy(u - dot(p, f.gu) - f.ou) < FIT_TILES && offBy(v - dot(p, f.gv) - f.ov) < FIT_TILES;
  });
}

/** The box that lets a slanted brush's union show the most faces itself, or null if it can't. */
function bodyLayout(faces, pts) {
  const drawn = faces.filter(f => f.mat !== null);
  if (!drawn.length || drawn.some(f => f.clear)) return null;
  const axes = [[[1, 0, 0], [0, 1, 0], [0, 0, 1]]];
  // Lining the box up with a face's texture is what makes that texture fit a side exactly.
  for (const f of drawn) {
    const along = sub(f.gu, mul(f.n, dot(f.gu, f.n)));
    if (len(along) > 1e-9) axes.push([f.n, along, cross(f.n, along)]);
  }
  for (const a of faces) {
    for (const b of faces) {
      if (a !== b && Math.abs(dot(a.n, b.n)) < 0.9) axes.push([a.n, b.n, cross(a.n, b.n)]);
    }
  }
  let best = null;
  for (const set of axes) {
    for (const frame of framesFrom(set)) {
      const shape = fit(frame, pts);
      const mapped = new Map();
      for (const f of drawn) {
        const lean = FACES.map(s => dot(f.n, worldOf(frame, s.n))).sort((x, y) => y - x);
        if (lean[0] - lean[1] < SIDE_MARGIN) continue;
        const m = mapFace(f, frame, shape);
        if (!m || m.kind === 'skew' || !fitsFace(m, f)) continue;
        const held = mapped.get(m.face);
        if (!held || f.area > held.area) mapped.set(m.face, { ...m, area: f.area, mat: f.mat, src: f });
      }
      if (!mapped.size) continue;
      // Every face held is one object fewer, so that outweighs how neat the images are.
      let score = mapped.size * 1e9 + frame[1][1] * 1e-3;
      for (const v of mapped.values()) score += WEIGHT[v.kind] * v.area;
      if (!best || score > best.score) best = { frame, shape, mapped, score };
    }
  }
  return best;
}

const PLATE_THICK = 0.02, PLATE_LIFT = 0.004, PLATE_PAD = 0.004;
const r5 = v => Math.round(v * 100000) / 100000;
const cframe = (centre, f) => [
  ...centre.map(r3),
  ...[f[0][0], f[1][0], f[2][0], f[0][1], f[1][1], f[2][1], f[0][2], f[1][2], f[2][2]].map(r5),
];

/**
 * A union gets one Texture per box side, so a face that can't have a side to itself gets a thin
 * plate lying on it instead, turned so the Part's axes run along the face's texture axes. That
 * maps exactly, at any angle. Plates only show the texture: the union stays the solid shape.
 */
function plateFor(face, variantOf, onFace) {
  const n = face.n;
  const flat = g => sub(g, mul(n, dot(g, n)));
  const fu = flat(face.gu), fv = flat(face.gv);
  const lu = len(fu), lv = len(fv);
  // A texture axis pointing into the face leaves only rounding noise here, not a direction.
  if (lu < 1e-6 * len(face.gu) || lv < 1e-6 * len(face.gv)) return null;
  const U = mul(fu, 1 / lu);
  const rawV = mul(fv, 1 / lv);
  const skew = Math.abs(dot(U, rawV)) > EPS;
  // Always exactly square: the plate's position below is built along these axes, so a small error
  // here lands it several studs away on a map far from the origin. Crossing with the normal also
  // holds up on a face where the texture's two axes are almost parallel.
  const across = cross(n, U);
  const V = dot(across, rawV) >= 0 ? across : mul(across, -1);
  // Seen from outside, an unflipped image has U x V pointing inward.
  const mirrored = dot(cross(U, V), n) > 0;
  const frame = [mirrored ? mul(U, -1) : U, mul(V, -1), n];

  const span = axis => {
    const t = face.pts.map(p => dot(p, axis));
    return [Math.min(...t), Math.max(...t)];
  };
  const [fx0, fx1] = span(frame[0]), [fy0, fy1] = span(frame[1]);
  if (fx1 - fx0 < 0.01 || fy1 - fy0 < 0.01) return null;
  const rectangle = face.area >= (fx1 - fx0) * (fy1 - fy0) * 0.995;
  // Lifted plates would leave a hairline at every outside corner, so each one overlaps a touch.
  // The image start is worked out from this padded edge, so the texture doesn't move.
  const x0 = fx0 - PLATE_PAD, x1 = fx1 + PLATE_PAD, y0 = fy0 - PLATE_PAD, y1 = fy1 + PLATE_PAD;
  const w = x1 - x0, h = y1 - y0;

  const onPlane = (x, y) => add(add(mul(frame[0], x), mul(frame[1], y)), mul(n, face.d));
  const centre = add(onPlane((x0 + x1) / 2, (y0 + y1) / 2), mul(n, PLATE_LIFT - PLATE_THICK / 2));
  // A plate's texture goes on its Back face (+Z), whose image starts at local (-X, +Y).
  const start = onPlane(x0, y1);
  const ku = dot(start, face.gu) + face.ou, kv = dot(start, face.gv) + face.ov;
  const su = 1 / lu, sv = 1 / lv;
  const wrap = (v, t) => ((v % t) + t) % t;
  const ou = wrap((mirrored ? 1 - ku : ku) * su, su), ov = wrap(kv * sv, sv);

  const baked = mirrored ? variantOf(face.mat, 'fu') : null;
  const mapped = { face: 2, kind: skew ? 'skew' : mirrored ? 'flip' : 'exact', xf: mirrored ? 'fu' : '', su, sv, ou, ov, corner: start, R: frame[0], D: mul(frame[1], -1), src: face, area: face.area };
  onFace?.(mapped);

  const entry = {
    t: 'b', pl: 1, cf: cframe(centre, frame), s: [r3(w), r3(h), PLATE_THICK], m: face.mat,
    f: [[2, baked ?? face.mat, r3(su), r3(sv), r3(ou), r3(ov)]],
  };
  // Anything but a rectangle is trimmed along its own edges. The Part is already the right thickness.
  if (!rectangle) {
    const c = face.pts.reduce((s, p) => add(s, p), [0, 0, 0]).map(v => v / face.pts.length);
    const cuts = [];
    face.pts.forEach((a, i) => {
      const b = face.pts[(i + 1) % face.pts.length];
      if (len(sub(b, a)) < 1e-4) return;
      let e = unit(cross(sub(b, a), n));
      if (dot(c, e) > dot(a, e)) e = mul(e, -1);
      cuts.push([...e.map(r5), r3(dot(a, e) + PLATE_PAD), face.mat]);
    });
    entry.t = 'c';
    entry.c = cuts;
  }
  return { entry, mapped, baked };
}

/**
 * Source image coordinates (u,v) for a point (s,t) of each baked copy. Written so that a
 * copy's pixel at (s,t) is the original's pixel at XFORMS[xf](s,t).
 */
export const XFORMS = {
  '': (s, t) => [s, t],
  fu: (s, t) => [1 - s, t],
  fv: (s, t) => [s, 1 - t],
  r2: (s, t) => [1 - s, 1 - t],
  t: (s, t) => [t, s],
  at: (s, t) => [1 - t, 1 - s],
  r1: (s, t) => [t, 1 - s],
  r3: (s, t) => [1 - t, s],
};

/**
 * scene.brushes -> manifest entries. matOf(id) gives the manifest material, or null.
 * variantOf(material id, xf) gives a material with a baked copy, or null to use the plain image.
 * onFace is for tests: it sees each placed Texture with the brush face it came from.
 */
export function buildBrushParts(brushes, scale, matOf, variantOf = () => null, onFace = null) {
  const out = [];
  const areas = { exact: 0, flip: 0, skew: 0, swap: 0 };
  let boxes = 0, cuts = 0, merged = 0, unbaked = 0, plates = 0, trimmed = 0;
  const textureOf = v => {
    const variant = v.xf ? variantOf(v.mat, v.xf) : null;
    if (variant === null && v.xf) unbaked++;
    return [v.face, variant ?? v.mat, r3(v.su), r3(v.sv), r3(v.ou), r3(v.ov)];
  };
  for (const brush of brushes) {
    const polys = brushPolys(brush.faces);
    if (polys.length < 4) continue;
    const faces = [];
    const seen = new Set();
    const pts = [];
    for (const poly of polys) {
      const src = brush.faces[poly.plane];
      const world = poly.pts.map(p => mul(toRbx(p), scale));
      for (const p of world) {
        const k = p.map(v => Math.round(v * 200)).join();
        if (!seen.has(k)) { seen.add(k); pts.push(p); }
      }
      const n = toRbx(poly.n);
      const m = src.mat ? matOf(src.mat) : null;
      faces.push({
        n, d: dot(n, world[0]), area: polyArea(world), mat: m ? m.id : null, pts: world,
        clear: !!m && (m.hasAlpha || m.alpha < 1),
        gu: mul(toRbx(src.s), 1 / (scale * src.w)), ou: src.s[3] / src.w,
        gv: mul(toRbx(src.t), 1 / (scale * src.h)), ov: src.t[3] / src.h,
      });
    }
    if (!faces.some(f => f.mat !== null)) continue;

    const box = boxOf(polys);
    const body = faces.filter(f => f.mat !== null).sort((a, b) => b.area - a.area)[0].mat;
    const door = entry => {
      if (!brush.door) return;
      entry.dr = brush.door.id;
      if (brush.door.name) entry.dn = brush.door.name;
    };

    if (box) {
      const { frame, shape, mapped } = bestLayout(faces, framesFrom(box.map(toRbx)), pts);
      const entry = {
        t: 'b', cf: cframe(shape.centre, frame), s: shape.size.map(v => r3(Math.max(v, 0.05))), m: body,
        f: [...mapped.values()].map(textureOf),
      };
      for (const v of mapped.values()) {
        areas[v.kind] += v.area;
        onFace?.(v);
      }
      boxes++;
      if (brush.noCollide) entry.nc = 1;
      door(entry);
      out.push(entry);
      continue;
    }

    // The solid shape. It shows the faces it can hold, and plates draw the rest.
    const layout = bodyLayout(faces, pts);
    const frame = layout?.frame ?? [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const shape = layout?.shape ?? fit(frame, pts);
    const held = [...(layout?.mapped.values() ?? [])];
    const entry = {
      t: 'c', cf: cframe(shape.centre, frame), s: shape.size.map(v => r3(Math.max(v, 0.05))), m: body,
      f: held.map(textureOf),
      c: faces.map(f => [...f.n.map(r5), r3(f.d), f.mat ?? -1]),
    };
    for (const v of held) {
      areas[v.kind] += v.area;
      onFace?.(v);
    }
    if (held.length === faces.filter(f => f.mat !== null).length) merged++;
    if (faces.every(f => f.mat === null || f.clear)) entry.tr = 1;
    if (brush.noCollide) entry.nc = 1;
    door(entry);
    out.push(entry);
    cuts++;
    for (const f of faces) {
      if (f.mat === null || held.some(v => v.src === f)) continue;
      const p = plateFor(f, variantOf, onFace);
      if (!p) continue;
      areas[p.mapped.kind] += f.area;
      plates++;
      if (p.entry.t === 'c') trimmed++;
      if (p.mapped.xf && p.baked === null) unbaked++;
      door(p.entry);
      out.push(p.entry);
    }
  }
  return { brushes: out, stats: { boxes, cuts, merged, plates, trimmed, unbaked, areas: Object.fromEntries(Object.entries(areas).map(([k, v]) => [k, Math.round(v)])) } };
}
