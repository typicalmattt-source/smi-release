// An info_overlay is a quad, but Source only ever draws the parts of it that land on the faces it
// is attached to. A door overlay around a real doorway is mostly hole: only its frame shows. So
// each attached face cuts its own piece out of the quad, and that piece is pressed onto the face.
import { sub, add, mul, dot, cross, len, unit } from './math.js';

const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function areaVector(pts) {
  let total = [0, 0, 0];
  for (let i = 1; i + 1 < pts.length; i++) total = add(total, cross(sub(pts[i], pts[0]), sub(pts[i + 1], pts[0])));
  return total;
}

/** Sutherland-Hodgman against one edge. Vertices carry their UVs through the cut. */
function clipEdge(poly, a, inward) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const v = poly[i], w = poly[(i + 1) % poly.length];
    const dv = dot(sub(v.p, a), inward), dw = dot(sub(w.p, a), inward);
    if (dv >= 0) out.push(v);
    if ((dv > 0 && dw < 0) || (dv < 0 && dw > 0)) {
      const t = dv / (dv - dw);
      out.push({ p: lerp(v.p, w.p, t), uv: lerp(v.uv, w.uv, t) });
    }
  }
  return out;
}

/**
 * quad and uv are the overlay's four corners. faces are convex, as { pts, n }.
 * Returns the visible pieces as { pts, uv, n }, already lying on their faces.
 */
export function clipOverlay(quad, uv, normal, faces) {
  const n = unit(normal);
  const origin = quad[0];
  const toPlane = p => sub(p, mul(n, dot(sub(p, origin), n)));
  const start = quad.map((p, i) => ({ p: toPlane(p), uv: uv[i] }));
  const pieces = [];
  for (const face of faces) {
    // Pressing along the overlay's normal can't reach a face seen edge-on.
    const facing = dot(face.n, n);
    if (Math.abs(facing) < 0.01) continue;
    const outline = face.pts.map(toPlane);
    const turn = dot(areaVector(outline), n) >= 0 ? 1 : -1;
    let poly = start;
    for (let i = 0; i < outline.length && poly.length >= 3; i++) {
      const a = outline[i], b = outline[(i + 1) % outline.length];
      if (len(sub(b, a)) < 1e-6) continue;
      poly = clipEdge(poly, a, mul(cross(n, sub(b, a)), turn));
    }
    if (poly.length < 3 || len(areaVector(poly.map(v => v.p))) < 1e-4) continue;
    const d = dot(face.n, face.pts[0]);
    pieces.push({
      pts: poly.map(v => sub(v.p, mul(n, (dot(face.n, v.p) - d) / facing))),
      uv: poly.map(v => v.uv),
      n: face.n,
    });
  }
  return pieces;
}
