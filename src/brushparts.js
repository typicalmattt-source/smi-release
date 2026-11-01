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
  const signed = axes.flatMap(a => [a, mul(a, -1)]);
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
  let boxes = 0, cuts = 0, unbaked = 0;
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
        gu: mul(toRbx(src.s), 1 / (scale * src.w)), ou: src.s[3] / src.w,
        gv: mul(toRbx(src.t), 1 / (scale * src.h)), ov: src.t[3] / src.h,
      });
    }
    if (!faces.some(f => f.mat !== null)) continue;

    const box = boxOf(polys);
    const frames = framesFrom(box ? box.map(toRbx) : [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    const { frame, shape, mapped } = bestLayout(faces, frames, pts);
    const entry = {
      t: box ? 'b' : 'c',
      cf: [...shape.centre, frame[0][0], frame[1][0], frame[2][0], frame[0][1], frame[1][1], frame[2][1], frame[0][2], frame[1][2], frame[2][2]].map(r3),
      s: shape.size.map(v => r3(Math.max(v, 0.05))),
      m: faces.filter(f => f.mat !== null).sort((a, b) => b.area - a.area)[0].mat,
      f: [...mapped.values()].map(v => {
        const variant = v.xf ? variantOf(v.mat, v.xf) : null;
        if (variant === null && v.xf) unbaked++;
        return [v.face, variant ?? v.mat, r3(v.su), r3(v.sv), r3(v.ou), r3(v.ov)];
      }),
    };
    for (const v of mapped.values()) {
      areas[v.kind] += v.area;
      onFace?.(v);
    }
    if (box) boxes++;
    else {
      cuts++;
      entry.c = faces.map(f => [...f.n.map(v => Math.round(v * 100000) / 100000), r3(f.d), f.mat ?? -1]);
    }
    if (brush.noCollide) entry.nc = 1;
    if (brush.door) {
      entry.dr = brush.door.id;
      if (brush.door.name) entry.dn = brush.door.name;
    }
    out.push(entry);
  }
  return { brushes: out, stats: { boxes, cuts, unbaked, areas: Object.fromEntries(Object.entries(areas).map(([k, v]) => [k, Math.round(v)])) } };
}
