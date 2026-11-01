// Turns convex solids into real Roblox colliders. Boxes and wedges become invisible
// Parts, which are exact and cheap. Anything else stays a convex hull mesh. This is
// the fix for "map collisions don't work": the visible mesh is never the collider.
import { sub, add, mul, dot, cross, len, unit, toRbx } from './math.js';

const EPS = 0.02;
const near = (a, b, e = 0.002) => Math.abs(a - b) < e;

/** Clip a plane-defined convex solid into polygons. planes: [{n:[x,y,z], d}], outward. */
export function brushPolys(planes) {
  const polys = [];
  for (let i = 0; i < planes.length; i++) {
    const { n, d } = planes[i];
    const ref = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
    const u = unit(cross(ref, n)), v = cross(n, u);
    const c = mul(n, d);
    const R = 65536;
    let w = [
      add(add(c, mul(u, -R)), mul(v, -R)), add(add(c, mul(u, R)), mul(v, -R)),
      add(add(c, mul(u, R)), mul(v, R)), add(add(c, mul(u, -R)), mul(v, R)),
    ];
    for (let j = 0; j < planes.length && w.length >= 3; j++) {
      if (j === i) continue;
      const p = planes[j];
      const next = [];
      for (let k = 0; k < w.length; k++) {
        const a = w[k], b = w[(k + 1) % w.length];
        const da = dot(a, p.n) - p.d, db = dot(b, p.n) - p.d;
        if (da <= EPS) next.push(a);
        if ((da > EPS && db < -EPS) || (da < -EPS && db > EPS)) next.push(add(a, mul(sub(b, a), da / (da - db))));
      }
      w = next;
    }
    if (w.length >= 3) polys.push({ n, pts: w, plane: i });
  }
  return polys;
}

function uniqPts(polys) {
  const out = [];
  const seen = new Set();
  for (const p of polys) {
    for (const v of p.pts) {
      const k = `${Math.round(v[0] * 4)},${Math.round(v[1] * 4)},${Math.round(v[2] * 4)}`;
      if (!seen.has(k)) { seen.add(k); out.push(v); }
    }
  }
  return out;
}

const extent = (pts, axis) => {
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) { const t = dot(p, axis); if (t < lo) lo = t; if (t > hi) hi = t; }
  return [lo, hi];
};

function asBox(polys, pts) {
  if (polys.length !== 6) return null;
  const axes = [];
  const used = new Set();
  for (let i = 0; i < 6; i++) {
    if (used.has(i)) continue;
    let j = -1;
    for (let k = i + 1; k < 6; k++) {
      if (!used.has(k) && near(dot(polys[i].n, polys[k].n), -1)) { j = k; break; }
    }
    if (j < 0) return null;
    used.add(i); used.add(j);
    axes.push(polys[i].n);
  }
  if (axes.length !== 3) return null;
  if (!near(dot(axes[0], axes[1]), 0) || !near(dot(axes[0], axes[2]), 0) || !near(dot(axes[1], axes[2]), 0)) return null;
  const size = [], center = [0, 0, 0];
  for (const a of axes) {
    const [lo, hi] = extent(pts, a);
    size.push(hi - lo);
    for (let i = 0; i < 3; i++) center[i] += a[i] * (lo + hi) / 2;
  }
  return { kind: 'box', center, axes, size };
}

/** The three Source axes of a box-shaped brush, or null if it isn't one. */
export function boxOf(polys) {
  return asBox(polys, uniqPts(polys))?.axes ?? null;
}

function asWedge(polys, pts) {
  if (polys.length !== 5 || pts.length !== 6) return null;
  const tris = polys.filter(p => p.pts.length === 3);
  if (tris.length !== 2 || !near(dot(tris[0].n, tris[1].n), -1)) return null;
  const axis = tris[0].n;
  const t = tris[0].pts;
  for (let i = 0; i < 3; i++) {
    const a = t[i], b = t[(i + 1) % 3], c = t[(i + 2) % 3];
    const ab = sub(b, a), ac = sub(c, a);
    if (Math.abs(dot(unit(ab), unit(ac))) < 0.002) {
      const [lo, hi] = extent(pts, axis);
      const h = len(ab), d = len(ac), w = hi - lo;
      const yAxis = unit(ab), zAxis = mul(unit(ac), -1);
      const xAxis = cross(yAxis, zAxis);
      // Centre of the bounding box of the prism.
      const mid = mul(add(b, c), 0.5);
      const along = dot(mid, axis);
      const center = add(mid, mul(axis, (lo + hi) / 2 - along));
      // In a WedgePart the right angle sits at local (-Y,+Z). Y runs along ab, -Z along ac.
      return { kind: 'wedge', center, xAxis, yAxis, zAxis, size: [w, h, d] };
    }
  }
  return null;
}

const cf = (center, x, y, z, scale) => {
  const c = mul(toRbx(center), scale);
  const X = toRbx(x), Y = toRbx(y), Z = toRbx(z);
  return [c[0], c[1], c[2], X[0], Y[0], Z[0], X[1], Y[1], Z[1], X[2], Y[2], Z[2]];
};
const r3 = a => a.map(v => Math.round(v * 1000) / 1000);

/**
 * Classify convex solids.
 * Returns { parts:[{t:'b'|'w', cf:[12], s:[3]}], hulls:[{polys}] } in Roblox space.
 * minSize stops needle-thin slivers from becoming Parts below Roblox's minimum.
 */
export function classifyBrushes(solids, scale) {
  const parts = [], hulls = [];
  for (const planes of solids) {
    const polys = brushPolys(planes);
    if (polys.length < 4) continue;
    const pts = uniqPts(polys);
    const box = asBox(polys, pts);
    if (box) {
      const [a, b] = box.axes;
      const c = cross(a, b);
      parts.push({ t: 'b', cf: r3(cf(box.center, a, b, c, scale)), s: r3(box.size.map(s => Math.max(s * scale, 0.05))) });
      continue;
    }
    const w = asWedge(polys, pts);
    if (w) {
      parts.push({ t: 'w', cf: r3(cf(w.center, w.xAxis, w.yAxis, w.zAxis, scale)), s: r3(w.size.map(s => Math.max(s * scale, 0.05))) });
      continue;
    }
    polys.toolOnly = !!planes.toolOnly;
    hulls.push(polys);
  }
  return { parts, hulls };
}

/** Greedy merge of axis-aligned boxes sharing a full face, to cut the Part count. */
export function mergeBoxes(parts) {
  const key = v => Math.round(v * 20);
  const isAligned = p => {
    const c = p.cf;
    return p.t === 'b'
      && [c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10], c[11]].every(x => Math.abs(x) < 1e-4 || Math.abs(Math.abs(x) - 1) < 1e-4);
  };
  const worldSize = p => {
    const c = p.cf, s = p.s;
    return [
      Math.abs(c[3]) * s[0] + Math.abs(c[4]) * s[1] + Math.abs(c[5]) * s[2],
      Math.abs(c[6]) * s[0] + Math.abs(c[7]) * s[1] + Math.abs(c[8]) * s[2],
      Math.abs(c[9]) * s[0] + Math.abs(c[10]) * s[1] + Math.abs(c[11]) * s[2],
    ];
  };
  const rest = parts.filter(p => !isAligned(p));
  let boxes = parts.filter(isAligned).map(p => ({ c: [p.cf[0], p.cf[1], p.cf[2]], s: worldSize(p) }));
  for (let pass = 0; pass < 6; pass++) {
    const axis = pass % 3;
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    const rows = new Map();
    for (const b of boxes) {
      const k = `${key(b.c[u])},${key(b.c[v])},${key(b.s[u])},${key(b.s[v])}`;
      (rows.get(k) ?? rows.set(k, []).get(k)).push(b);
    }
    const out = [];
    for (const row of rows.values()) {
      row.sort((a, b) => (a.c[axis] - a.s[axis] / 2) - (b.c[axis] - b.s[axis] / 2));
      let cur = row[0];
      for (let i = 1; i < row.length; i++) {
        const b = row[i];
        const curEnd = cur.c[axis] + cur.s[axis] / 2, bStart = b.c[axis] - b.s[axis] / 2;
        const merged = (b.c[axis] + b.s[axis] / 2) - (cur.c[axis] - cur.s[axis] / 2);
        if (Math.abs(curEnd - bStart) < 0.02 && merged <= 2000) {
          const lo = cur.c[axis] - cur.s[axis] / 2;
          const s = [...cur.s], c = [...cur.c];
          s[axis] = merged;
          c[axis] = lo + merged / 2;
          cur = { c, s };
        } else { out.push(cur); cur = b; }
      }
      out.push(cur);
    }
    boxes = out;
  }
  const merged = boxes.map(b => ({ t: 'b', cf: r3([...b.c, 1, 0, 0, 0, 1, 0, 0, 0, 1]), s: r3(b.s) }));
  return [...merged, ...rest];
}
