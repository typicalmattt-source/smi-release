// VTF texture decoding to RGBA8. Covers every format Source maps realistically use.

const FMT = {
  RGBA8888: 0, ABGR8888: 1, RGB888: 2, BGR888: 3, RGB565: 4, I8: 5, IA88: 6, P8: 7, A8: 8,
  RGB888_BLUESCREEN: 9, BGR888_BLUESCREEN: 10, ARGB8888: 11, BGRA8888: 12, DXT1: 13, DXT3: 14, DXT5: 15,
  BGRX8888: 16, BGR565: 17, BGRX5551: 18, BGRA4444: 19, DXT1_ONEBITALPHA: 20, BGRA5551: 21, UV88: 22,
  UVWQ8888: 23, RGBA16161616F: 24, RGBA16161616: 25, UVLX8888: 26,
};

function imageSize(fmt, w, h) {
  const blocks = () => Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2);
  switch (fmt) {
    case FMT.DXT1: case FMT.DXT1_ONEBITALPHA: return blocks() * 8;
    case FMT.DXT3: case FMT.DXT5: return blocks() * 16;
    case FMT.RGBA8888: case FMT.ABGR8888: case FMT.ARGB8888: case FMT.BGRA8888: case FMT.BGRX8888:
    case FMT.UVWQ8888: case FMT.UVLX8888: return w * h * 4;
    case FMT.RGB888: case FMT.BGR888: case FMT.RGB888_BLUESCREEN: case FMT.BGR888_BLUESCREEN: return w * h * 3;
    case FMT.RGB565: case FMT.BGR565: case FMT.BGRX5551: case FMT.BGRA4444: case FMT.BGRA5551:
    case FMT.IA88: case FMT.UV88: return w * h * 2;
    case FMT.I8: case FMT.A8: case FMT.P8: return w * h;
    case FMT.RGBA16161616F: case FMT.RGBA16161616: return w * h * 8;
    default: return -1;
  }
}

const c565 = v => [((v >> 11) & 31) * 255 / 31 + 0.5 | 0, ((v >> 5) & 63) * 255 / 63 + 0.5 | 0, (v & 31) * 255 / 31 + 0.5 | 0];

function decodeBC1Block(src, s, out, w, h, x, y, oneBit) {
  const c0 = src.readUInt16LE(s), c1 = src.readUInt16LE(s + 2);
  const a = c565(c0), b = c565(c1);
  const pal = [a, b];
  if (c0 > c1 || !oneBit && false) {
    pal.push([(2 * a[0] + b[0]) / 3 | 0, (2 * a[1] + b[1]) / 3 | 0, (2 * a[2] + b[2]) / 3 | 0]);
    pal.push([(a[0] + 2 * b[0]) / 3 | 0, (a[1] + 2 * b[1]) / 3 | 0, (a[2] + 2 * b[2]) / 3 | 0]);
  } else {
    pal.push([(a[0] + b[0]) / 2 | 0, (a[1] + b[1]) / 2 | 0, (a[2] + b[2]) / 2 | 0]);
    pal.push([0, 0, 0]);
  }
  const transparentIdx = c0 <= c1 ? 3 : -1;
  const bits = src.readUInt32LE(s + 4);
  for (let py = 0; py < 4; py++) {
    for (let px = 0; px < 4; px++) {
      const X = x + px, Y = y + py;
      if (X >= w || Y >= h) continue;
      const idx = (bits >>> ((py * 4 + px) * 2)) & 3;
      const o = (Y * w + X) * 4;
      out[o] = pal[idx][0]; out[o + 1] = pal[idx][1]; out[o + 2] = pal[idx][2];
      out[o + 3] = idx === transparentIdx ? 0 : 255;
    }
  }
}

function decodeDXT(src, off, w, h, fmt) {
  const out = Buffer.alloc(w * h * 4);
  const bs = fmt === FMT.DXT1 || fmt === FMT.DXT1_ONEBITALPHA ? 8 : 16;
  let s = off;
  for (let y = 0; y < h; y += 4) {
    for (let x = 0; x < w; x += 4, s += bs) {
      if (bs === 8) { decodeBC1Block(src, s, out, w, h, x, y, true); continue; }
      decodeBC1Block(src, s + 8, out, w, h, x, y, false);
      if (fmt === FMT.DXT3) {
        for (let py = 0; py < 4; py++) {
          const row = src.readUInt16LE(s + py * 2);
          for (let px = 0; px < 4; px++) {
            const X = x + px, Y = y + py;
            if (X < w && Y < h) out[(Y * w + X) * 4 + 3] = ((row >> (px * 4)) & 15) * 17;
          }
        }
      } else {
        const a0 = src[s], a1 = src[s + 1];
        const pal = [a0, a1];
        if (a0 > a1) for (let i = 1; i <= 6; i++) pal.push(((7 - i) * a0 + i * a1) / 7 | 0);
        else {
          for (let i = 1; i <= 4; i++) pal.push(((5 - i) * a0 + i * a1) / 5 | 0);
          pal.push(0, 255);
        }
        const lo = src.readUInt32LE(s + 2), hi = src.readUInt16LE(s + 6);
        for (let i = 0; i < 16; i++) {
          const shift = i * 3;
          const v = shift < 30
            ? (lo >>> shift) & 7
            : shift === 30 ? ((lo >>> 30) | (hi << 2)) & 7 : (hi >>> (shift - 32)) & 7;
          const X = x + (i & 3), Y = y + (i >> 2);
          if (X < w && Y < h) out[(Y * w + X) * 4 + 3] = pal[v];
        }
      }
    }
  }
  return out;
}

function decodeRaw(src, off, w, h, fmt) {
  const out = Buffer.alloc(w * h * 4);
  const n = w * h;
  const p = (i, r, g, b, a) => { out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a; };
  for (let i = 0; i < n; i++) {
    switch (fmt) {
      case FMT.RGBA8888: case FMT.UVWQ8888: case FMT.UVLX8888: { const s = off + i * 4; p(i, src[s], src[s + 1], src[s + 2], src[s + 3]); break; }
      case FMT.ABGR8888: { const s = off + i * 4; p(i, src[s + 3], src[s + 2], src[s + 1], src[s]); break; }
      case FMT.ARGB8888: { const s = off + i * 4; p(i, src[s + 1], src[s + 2], src[s + 3], src[s]); break; }
      case FMT.BGRA8888: { const s = off + i * 4; p(i, src[s + 2], src[s + 1], src[s], src[s + 3]); break; }
      case FMT.BGRX8888: { const s = off + i * 4; p(i, src[s + 2], src[s + 1], src[s], 255); break; }
      case FMT.RGB888: { const s = off + i * 3; p(i, src[s], src[s + 1], src[s + 2], 255); break; }
      case FMT.BGR888: { const s = off + i * 3; p(i, src[s + 2], src[s + 1], src[s], 255); break; }
      case FMT.RGB888_BLUESCREEN: { const s = off + i * 3; const k = src[s] === 0 && src[s + 1] === 0 && src[s + 2] === 255; p(i, src[s], src[s + 1], src[s + 2], k ? 0 : 255); break; }
      case FMT.BGR888_BLUESCREEN: { const s = off + i * 3; const k = src[s] === 255 && src[s + 1] === 0 && src[s + 2] === 0; p(i, src[s + 2], src[s + 1], src[s], k ? 0 : 255); break; }
      case FMT.RGB565: { const [r, g, b] = c565(src.readUInt16LE(off + i * 2)); p(i, r, g, b, 255); break; }
      case FMT.BGR565: { const [b, g, r] = c565(src.readUInt16LE(off + i * 2)); p(i, r, g, b, 255); break; }
      case FMT.BGRX5551: case FMT.BGRA5551: { const v = src.readUInt16LE(off + i * 2); p(i, ((v >> 10) & 31) * 8.226 | 0, ((v >> 5) & 31) * 8.226 | 0, (v & 31) * 8.226 | 0, fmt === FMT.BGRA5551 ? (v >> 15) * 255 : 255); break; }
      case FMT.BGRA4444: { const v = src.readUInt16LE(off + i * 2); p(i, ((v >> 8) & 15) * 17, ((v >> 4) & 15) * 17, (v & 15) * 17, ((v >> 12) & 15) * 17); break; }
      case FMT.I8: { const v = src[off + i]; p(i, v, v, v, 255); break; }
      case FMT.A8: p(i, 255, 255, 255, src[off + i]); break;
      case FMT.IA88: { const v = src[off + i * 2]; p(i, v, v, v, src[off + i * 2 + 1]); break; }
      case FMT.UV88: p(i, src[off + i * 2], src[off + i * 2 + 1], 255, 255); break;
      case FMT.RGBA16161616: { const s = off + i * 8; p(i, src[s + 1], src[s + 3], src[s + 5], src[s + 7]); break; }
      case FMT.RGBA16161616F: {
        const s = off + i * 8;
        const f = o => {
          const h16 = src.readUInt16LE(o);
          const e = (h16 >> 10) & 31, m = h16 & 1023;
          const v = (e === 0 ? m / 16777216 : (1 + m / 1024) * 2 ** (e - 15)) * (h16 >> 15 ? -1 : 1);
          // Simple Reinhard tonemap: HDR cubemaps and skies only need to look right.
          const t = Math.max(0, v) / (1 + Math.max(0, v));
          return Math.min(255, Math.pow(t, 1 / 2.2) * 255) | 0;
        };
        p(i, f(s), f(s + 2), f(s + 4), 255);
        break;
      }
      default: throw new Error(`unsupported VTF format ${fmt}`);
    }
  }
  return out;
}

export function vtfInfo(buf) {
  if (buf.length < 64 || buf.toString('latin1', 0, 4) !== 'VTF\0') throw new Error('not a VTF');
  const major = buf.readUInt32LE(4), minor = buf.readUInt32LE(8);
  const headerSize = buf.readUInt32LE(12);
  return {
    major, minor, headerSize,
    width: buf.readUInt16LE(16), height: buf.readUInt16LE(18), flags: buf.readUInt32LE(20),
    frames: Math.max(1, buf.readUInt16LE(24)), firstFrame: buf.readUInt16LE(26),
    format: buf.readInt32LE(52), mipCount: buf[56],
    lowFormat: buf.readInt32LE(57), lowW: buf[61], lowH: buf[62],
    depth: major > 7 || minor >= 2 ? Math.max(1, buf.readUInt16LE(63)) : 1,
    resourceCount: minor >= 3 ? buf.readUInt32LE(68) : 0,
  };
}

/** Decode one mip of frame 0. maxSize picks the largest mip that fits, downscaling Source's data for free. */
export function decodeVtf(buf, maxSize = 1024) {
  const v = vtfInfo(buf);
  if (imageSize(v.format, 4, 4) < 0) throw new Error(`unsupported VTF format ${v.format}`);

  let dataStart = v.headerSize;
  const hasEnvmap = (v.flags & 0x4000) !== 0;
  let faces = 1;
  if (hasEnvmap) faces = v.minor >= 5 ? 6 : (v.firstFrame === 0xffff ? 6 : 7);
  if (v.minor >= 3 && v.resourceCount) {
    for (let i = 0; i < v.resourceCount; i++) {
      const p = 80 + i * 8;
      const tag = buf.readUInt32LE(p) & 0xffffff;
      if (tag === 0x30) dataStart = buf.readUInt32LE(p + 4); // high-res image resource
    }
  } else if (v.lowFormat !== -1 && v.lowFormat !== 0xffffffff && v.lowW) {
    dataStart += imageSize(v.lowFormat, v.lowW, v.lowH);
  }

  const mipW = m => Math.max(1, v.width >> m), mipH = m => Math.max(1, v.height >> m);
  const mipD = m => Math.max(1, v.depth >> m);
  let target = 0;
  while (target < v.mipCount - 1 && Math.max(mipW(target), mipH(target)) > maxSize) target++;

  // Mips are stored smallest first, so skip everything smaller than the target.
  let off = dataStart;
  for (let m = v.mipCount - 1; m > target; m--) {
    off += imageSize(v.format, mipW(m), mipH(m)) * mipD(m) * v.frames * faces;
  }
  const w = mipW(target), h = mipH(target);
  const need = imageSize(v.format, w, h);
  if (off + need > buf.length) throw new Error('VTF truncated');

  const fmt = v.format;
  const dxt = fmt === FMT.DXT1 || fmt === FMT.DXT1_ONEBITALPHA || fmt === FMT.DXT3 || fmt === FMT.DXT5;
  const rgba = dxt ? decodeDXT(buf, off, w, h, fmt) : decodeRaw(buf, off, w, h, fmt);
  return { width: w, height: h, rgba, origWidth: v.width, origHeight: v.height, frames: v.frames, format: fmt };
}
