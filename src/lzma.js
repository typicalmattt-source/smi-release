// Minimal LZMA1 decoder. Source uses it for BSP lumps and for pakfile entries
// (zip method 14). Node has no built-in LZMA, and the project has no dependencies.

const kNumBitModelTotalBits = 11;
const kBitModelTotal = 1 << kNumBitModelTotalBits;
const kNumMoveBits = 5;
const kNumStates = 12;
const kNumPosBitsMax = 4;
const kNumLenToPosStates = 4;
const kEndPosModelIndex = 14;
const kNumFullDistances = 1 << (kEndPosModelIndex >> 1);
const kNumAlignBits = 4;
const kMatchMinLen = 2;

const initProbs = n => new Uint16Array(n).fill(kBitModelTotal >>> 1);

class RangeDecoder {
  constructor(buf, pos) {
    this.buf = buf;
    this.pos = pos + 1; // first byte is always 0
    this.range = 0xffffffff;
    this.code = 0;
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | buf[this.pos++]) >>> 0;
  }
  normalize() {
    if (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.buf[this.pos++]) >>> 0;
    }
  }
  bit(probs, i) {
    this.normalize();
    const p = probs[i];
    const bound = (this.range >>> kNumBitModelTotalBits) * p;
    if (this.code < bound) {
      this.range = bound;
      probs[i] = p + ((kBitModelTotal - p) >>> kNumMoveBits);
      return 0;
    }
    this.code = (this.code - bound) >>> 0;
    this.range = (this.range - bound) >>> 0;
    probs[i] = p - (p >>> kNumMoveBits);
    return 1;
  }
  direct(n) {
    let r = 0;
    for (let i = 0; i < n; i++) {
      this.normalize();
      this.range >>>= 1;
      this.code = (this.code - this.range) >>> 0;
      const t = 0 - (this.code >>> 31);
      this.code = (this.code + (this.range & t)) >>> 0;
      r = ((r << 1) + t + 1) >>> 0;
    }
    return r;
  }
}

function bitTree(rc, probs, offset, numBits) {
  let m = 1;
  for (let i = 0; i < numBits; i++) m = (m << 1) + rc.bit(probs, offset + m);
  return m - (1 << numBits);
}

function reverseBitTree(rc, probs, offset, numBits) {
  let m = 1, sym = 0;
  for (let i = 0; i < numBits; i++) {
    const b = rc.bit(probs, offset + m);
    m = (m << 1) + b;
    sym |= b << i;
  }
  return sym;
}

class LenDecoder {
  constructor() {
    this.choice = initProbs(2);
    this.low = initProbs(1 << (kNumPosBitsMax + 3));
    this.mid = initProbs(1 << (kNumPosBitsMax + 3));
    this.high = initProbs(1 << 8);
  }
  decode(rc, posState) {
    if (rc.bit(this.choice, 0) === 0) return bitTree(rc, this.low, posState << 3, 3);
    if (rc.bit(this.choice, 1) === 0) return 8 + bitTree(rc, this.mid, posState << 3, 3);
    return 16 + bitTree(rc, this.high, 0, 8);
  }
}

/** Decode a raw LZMA stream. props = 5 bytes (lc/lp/pb + dict size). */
export function lzmaDecode(props, input, inputPos, outSize) {
  const d = props[0];
  if (d >= 225) throw new Error('bad LZMA props');
  const lc = d % 9;
  const rem = Math.floor(d / 9);
  const lp = rem % 5;
  const pb = Math.floor(rem / 5);

  const out = Buffer.allocUnsafe(outSize);
  const rc = new RangeDecoder(input, inputPos);

  const literal = initProbs(0x300 << (lc + lp));
  const isMatch = initProbs(kNumStates << kNumPosBitsMax);
  const isRep = initProbs(kNumStates);
  const isRepG0 = initProbs(kNumStates);
  const isRepG1 = initProbs(kNumStates);
  const isRepG2 = initProbs(kNumStates);
  const isRep0Long = initProbs(kNumStates << kNumPosBitsMax);
  const posSlot = initProbs(kNumLenToPosStates << 6);
  const posDecoders = initProbs(1 + kNumFullDistances - kEndPosModelIndex);
  const align = initProbs(1 << kNumAlignBits);
  const lenDec = new LenDecoder();
  const repLenDec = new LenDecoder();

  const pbMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;
  let state = 0, rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0, pos = 0;

  while (pos < outSize) {
    const posState = pos & pbMask;
    if (rc.bit(isMatch, (state << kNumPosBitsMax) + posState) === 0) {
      const prev = pos > 0 ? out[pos - 1] : 0;
      const litState = ((pos & lpMask) << lc) + (prev >> (8 - lc));
      const base = 0x300 * litState;
      let sym = 1;
      if (state >= 7) {
        let matchByte = out[pos - rep0 - 1];
        do {
          const matchBit = (matchByte >> 7) & 1;
          matchByte <<= 1;
          const b = rc.bit(literal, base + ((1 + matchBit) << 8) + sym);
          sym = (sym << 1) | b;
          if (matchBit !== b) break;
        } while (sym < 0x100);
      }
      while (sym < 0x100) sym = (sym << 1) | rc.bit(literal, base + sym);
      out[pos++] = sym & 0xff;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }

    let len;
    if (rc.bit(isRep, state) !== 0) {
      if (rc.bit(isRepG0, state) === 0) {
        if (rc.bit(isRep0Long, (state << kNumPosBitsMax) + posState) === 0) {
          state = state < 7 ? 9 : 11;
          out[pos] = out[pos - rep0 - 1];
          pos++;
          continue;
        }
      } else {
        let dist;
        if (rc.bit(isRepG1, state) === 0) dist = rep1;
        else {
          if (rc.bit(isRepG2, state) === 0) dist = rep2;
          else { dist = rep3; rep3 = rep2; }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = dist;
      }
      len = repLenDec.decode(rc, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2; rep2 = rep1; rep1 = rep0;
      len = lenDec.decode(rc, posState);
      state = state < 7 ? 7 : 10;
      const lenState = Math.min(len, kNumLenToPosStates - 1);
      const slot = bitTree(rc, posSlot, lenState << 6, 6);
      if (slot < 4) rep0 = slot;
      else {
        const numDirect = (slot >> 1) - 1;
        let dist = ((2 | (slot & 1)) << numDirect) >>> 0;
        if (slot < kEndPosModelIndex) {
          dist = (dist + reverseBitTree(rc, posDecoders, dist - slot, numDirect)) >>> 0;
        } else {
          dist = (dist + (rc.direct(numDirect - kNumAlignBits) << kNumAlignBits)) >>> 0;
          dist = (dist + reverseBitTree(rc, align, 0, kNumAlignBits)) >>> 0;
        }
        rep0 = dist;
      }
      if (rep0 === 0xffffffff) break; // end marker
    }
    len += kMatchMinLen;
    if (rep0 >= pos) throw new Error('LZMA: bad distance');
    const n = Math.min(len, outSize - pos);
    for (let i = 0; i < n; i++, pos++) out[pos] = out[pos - rep0 - 1];
  }
  return out;
}

/** Valve's LZMA lump wrapper: 'LZMA' uint32 actualSize, uint32 lzmaSize, props[5], data. */
export function decodeValveLzma(buf) {
  if (buf.length < 17 || buf.toString('latin1', 0, 4) !== 'LZMA') return null;
  const actual = buf.readUInt32LE(4);
  return lzmaDecode(buf.subarray(12, 17), buf, 17, actual);
}
