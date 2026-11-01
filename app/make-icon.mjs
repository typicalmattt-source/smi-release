// Draws the app icon (an isometric block) into a PNG-based .ico.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../src/png.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const S = 256;
const px = Buffer.alloc(S * S * 4);
const set = (x, y, c, a = 255) => {
  const o = (y * S + x) * 4;
  px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = a;
};
const inTri = (p, a, b, c) => {
  const s = (q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
const quad = (p, q) => inTri(p, q[0], q[1], q[2]) || inTri(p, q[0], q[2], q[3]);

const top = [[128, 44], [212, 90], [128, 136], [44, 90]];
const left = [[44, 90], [128, 136], [128, 222], [44, 176]];
const right = [[212, 90], [128, 136], [128, 222], [212, 176]];
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const R = 44, ex = Math.max(R - x - 0.5, x + 0.5 - (S - R), 0), ey = Math.max(R - y - 0.5, y + 0.5 - (S - R), 0);
    if (Math.hypot(ex, ey) > R) continue; // rounded corners stay transparent
    const p = [x, y];
    if (quad(p, top)) set(x, y, [248, 178, 92]);
    else if (quad(p, left)) set(x, y, [232, 145, 45]);
    else if (quad(p, right)) set(x, y, [176, 100, 22]);
    else set(x, y, [28, 31, 37]);
  }
}
const png = encodePng(px, S, S, { alpha: true });
const head = Buffer.alloc(22);
head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4); // ICO with one image
head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12); // planes, bit depth
head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(here, 'icon.ico'), Buffer.concat([head, png]));
console.log('icon written');
