// PNG encode/decode on top of node:zlib, plus a box-filter downscale.
import zlib from 'node:zlib';

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgba: w*h*4 bytes. alpha=false drops the channel (and keeps file sizes down). */
export function encodePng(rgba, w, h, { alpha = true, level = 6 } = {}) {
  const ch = alpha ? 4 : 3;
  const raw = Buffer.allocUnsafe((w * ch + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 1; // Sub filter: cheap, and much smaller than None on textures
    const row = y * w * 4;
    const left = [0, 0, 0, 0];
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < ch; c++) {
        const v = rgba[row + x * 4 + c];
        raw[o++] = (v - left[c]) & 255;
        left[c] = v;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Decodes 8-bit non-interlaced PNGs: enough for user replacement images. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let p = 8, w = 0, h = 0, depth = 0, type = 0, palette = null, trns = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const t = buf.toString('latin1', p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (t === 'IHDR') {
      w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9];
      if (d[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (t === 'PLTE') palette = d;
    else if (t === 'tRNS') trns = d;
    else if (t === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  if (depth !== 8) throw new Error('only 8-bit PNG supported');
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(w * h * 4);
  const prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  let s = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[s++];
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = raw[s++];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (type === 6) { cur.copy(out, o, x * 4, x * 4 + 4); } else if (type === 2) {
        out[o] = cur[x * 3]; out[o + 1] = cur[x * 3 + 1]; out[o + 2] = cur[x * 3 + 2]; out[o + 3] = 255;
      } else if (type === 0) { out[o] = out[o + 1] = out[o + 2] = cur[x]; out[o + 3] = 255; } else if (type === 4) {
        out[o] = out[o + 1] = out[o + 2] = cur[x * 2]; out[o + 3] = cur[x * 2 + 1];
      } else {
        const i = cur[x];
        out[o] = palette[i * 3]; out[o + 1] = palette[i * 3 + 1]; out[o + 2] = palette[i * 3 + 2];
        out[o + 3] = trns && i < trns.length ? trns[i] : 255;
      }
    }
    cur.copy(prev);
  }
  return { width: w, height: h, rgba: out };
}

export function downscale(rgba, w, h, maxSide) {
  const f = Math.max(w, h) / maxSide;
  if (f <= 1) return { rgba, width: w, height: h };
  const W = Math.max(1, Math.round(w / f)), H = Math.max(1, Math.round(h / f));
  const out = Buffer.alloc(W * H * 4);
  for (let Y = 0; Y < H; Y++) {
    const y0 = Math.floor(Y * h / H), y1 = Math.max(y0 + 1, Math.floor((Y + 1) * h / H));
    for (let X = 0; X < W; X++) {
      const x0 = Math.floor(X * w / W), x1 = Math.max(x0 + 1, Math.floor((X + 1) * w / W));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * w + x) * 4;
          r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2]; a += rgba[o + 3]; n++;
        }
      }
      const o = (Y * W + X) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { rgba: out, width: W, height: H };
}
