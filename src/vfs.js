// Virtual filesystem over the places Source looks for content: BSP pakfiles,
// custom-content folders, VPKs, GMA addons and loose game folders.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { lzmaDecode } from './lzma.js';

const norm = p => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '').toLowerCase();

// ---- ZIP (BSP pakfile) --------------------------------------------------
export function parseZip(buf) {
  let eocd = -1;
  // Valve's zips sometimes carry padding after the EOCD, so scan the tail widely.
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 0x110000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return new Map();
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = norm(buf.toString('latin1', p + 46, p + 46 + nlen));
    out.set(name, { method, csize, usize, lho });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

function readZipEntry(buf, e) {
  const nlen = buf.readUInt16LE(e.lho + 26);
  const xlen = buf.readUInt16LE(e.lho + 28);
  const start = e.lho + 30 + nlen + xlen;
  const data = buf.subarray(start, start + e.csize);
  if (e.method === 0) return data;
  if (e.method === 8) return zlib.inflateRawSync(data);
  if (e.method === 14) {
    // zip LZMA: u16 version, u16 propsSize, props, stream
    const psize = data.readUInt16LE(2);
    return lzmaDecode(data.subarray(4, 4 + psize), data, 4 + psize, e.usize);
  }
  throw new Error(`unsupported zip method ${e.method}`);
}

class PakMount {
  constructor(buf, label) { this.buf = buf; this.label = label; this.entries = parseZip(buf); }
  has(p) { return this.entries.has(p); }
  read(p) { return Buffer.from(readZipEntry(this.buf, this.entries.get(p))); }
  *list() { yield* this.entries.keys(); }
}

// ---- VPK ----------------------------------------------------------------
class VpkMount {
  constructor(dirPath) {
    this.path = dirPath;
    this.label = path.basename(dirPath);
    this.base = dirPath.replace(/_dir\.vpk$/i, '').replace(/\.vpk$/i, '');
    this.entries = new Map();
    const buf = fs.readFileSync(dirPath);
    if (buf.readUInt32LE(0) !== 0x55aa1234) throw new Error(`not a VPK: ${dirPath}`);
    const version = buf.readUInt32LE(4);
    const treeSize = buf.readUInt32LE(8);
    let headerSize = 12;
    if (version === 2) headerSize = 28;
    this.dirData = headerSize + treeSize;
    this.handles = new Map();
    let p = headerSize;
    const str = () => {
      const s = p;
      while (buf[p] !== 0) p++;
      const r = buf.toString('latin1', s, p);
      p++;
      return r;
    };
    for (;;) {
      const ext = str();
      if (!ext) break;
      for (;;) {
        const dir = str();
        if (!dir) break;
        for (;;) {
          const file = str();
          if (!file) break;
          const crc = buf.readUInt32LE(p);
          const preload = buf.readUInt16LE(p + 4);
          const archive = buf.readUInt16LE(p + 6);
          const offset = buf.readUInt32LE(p + 8);
          const length = buf.readUInt32LE(p + 12);
          p += 18; // includes the 0xffff terminator
          const preloadData = preload ? buf.subarray(p, p + preload) : null;
          p += preload;
          const full = norm(dir === ' ' ? `${file}.${ext}` : `${dir}/${file}.${ext}`);
          this.entries.set(full, { crc, archive, offset, length, preload: preloadData ? Buffer.from(preloadData) : null });
        }
      }
    }
  }
  has(p) { return this.entries.has(p); }
  read(p) {
    const e = this.entries.get(p);
    const body = Buffer.allocUnsafe(e.length);
    if (e.length) {
      const file = e.archive === 0x7fff
        ? this.path
        : `${this.base}_${String(e.archive).padStart(3, '0')}.vpk`;
      let fd = this.handles.get(file);
      if (fd === undefined) { fd = fs.openSync(file, 'r'); this.handles.set(file, fd); }
      const at = e.archive === 0x7fff ? this.dirData + e.offset : e.offset;
      fs.readSync(fd, body, 0, e.length, at);
    }
    return e.preload ? Buffer.concat([e.preload, body]) : body;
  }
  *list() { yield* this.entries.keys(); }
  close() { for (const fd of this.handles.values()) fs.closeSync(fd); this.handles.clear(); }
}

// ---- GMA (Garry's Mod addon) --------------------------------------------
class GmaMount {
  constructor(file) {
    this.path = file;
    this.label = path.basename(file);
    this.entries = new Map();
    const buf = fs.readFileSync(file);
    if (buf.toString('latin1', 0, 4) !== 'GMAD') throw new Error(`not a GMA: ${file}`);
    const version = buf[4];
    let p = 5 + 8 + 8; // ident+version, steamid, timestamp
    if (version > 1) { while (buf[p] !== 0) { while (buf[p] !== 0) p++; p++; } p++; }
    const skipStr = () => { while (buf[p] !== 0) p++; p++; };
    skipStr(); skipStr(); skipStr(); // name, description, author
    p += 4; // addon version
    const list = [];
    for (;;) {
      const idx = buf.readUInt32LE(p); p += 4;
      if (idx === 0) break;
      const s = p;
      while (buf[p] !== 0) p++;
      const name = norm(buf.toString('latin1', s, p));
      p++;
      const size = Number(buf.readBigInt64LE(p)); p += 8;
      p += 4; // crc
      list.push({ name, size });
    }
    let off = p;
    for (const f of list) { this.entries.set(f.name, { off, size: f.size }); off += f.size; }
    this.buf = buf;
  }
  has(p) { return this.entries.has(p); }
  read(p) { const e = this.entries.get(p); return Buffer.from(this.buf.subarray(e.off, e.off + e.size)); }
  *list() { yield* this.entries.keys(); }
}

// ---- loose folders ------------------------------------------------------
class DirMount {
  constructor(dir) {
    this.dir = dir;
    this.label = dir;
    this.entries = new Map();
    const walk = (d, rel) => {
      let items;
      try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        const r = rel ? `${rel}/${it.name}` : it.name;
        if (it.isDirectory()) {
          const low = it.name.toLowerCase();
          if (!rel && !CONTENT_DIRS.has(low)) continue;
          walk(path.join(d, it.name), r);
        } else this.entries.set(norm(r), path.join(d, it.name));
      }
    };
    walk(dir, '');
  }
  has(p) { return this.entries.has(p); }
  read(p) { return fs.readFileSync(this.entries.get(p)); }
  *list() { yield* this.entries.keys(); }
}
const CONTENT_DIRS = new Set(['materials', 'models', 'sound', 'maps']);

// ---- search path --------------------------------------------------------
/** Every map inside a workshop .gma, plus a reader for each. */
export function gmaMaps(file) {
  const g = new GmaMount(file);
  return [...g.list()].filter(n => /^maps\/[^/]+\.bsp$/.test(n)).map(n => ({ name: n, read: () => g.read(n) }));
}

export class VFS {
  constructor() { this.mounts = []; }
  addFirst(m) { this.mounts.unshift(m); return m; }
  add(m) { this.mounts.push(m); return m; }
  addPak(buf, label) { return this.add(new PakMount(buf, label)); }
  addVpk(file) { return this.add(new VpkMount(file)); }
  addDir(dir) { return this.add(new DirMount(dir)); }
  addGma(file) { return this.add(new GmaMount(file)); }

  /** Add anything: a folder, a .vpk or a .gma. Returns false if it is unusable. */
  addAny(p) {
    if (!fs.existsSync(p)) return false;
    const st = fs.statSync(p);
    if (st.isDirectory()) return this.addFolder(p);
    if (/\.vpk$/i.test(p)) { this.addVpk(p); return true; }
    if (/\.gma$/i.test(p)) { this.addGma(p); return true; }
    return false;
  }

  /**
   * A folder may hold loose content, archives, or a mod's own folder wrapped around those.
   * Part files such as pak01_003.vpk are skipped: their _dir.vpk reads them.
   */
  addFolder(dir, depth = 0) {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    let added = false;
    if (items.some(i => i.isDirectory() && CONTENT_DIRS.has(i.name.toLowerCase()))) {
      this.addDir(dir);
      added = true;
    }
    const archives = items.filter(i => i.isFile() && /\.(vpk|gma)$/i.test(i.name) && !/_\d{3}\.vpk$/i.test(i.name));
    for (const a of archives.sort((x, y) => x.name.localeCompare(y.name))) {
      try { added = this.addAny(path.join(dir, a.name)) || added; } catch { /* unreadable archive */ }
    }
    if (!added && depth < 4) {
      for (const i of items) if (i.isDirectory()) added = this.addFolder(path.join(dir, i.name), depth + 1) || added;
    }
    return added;
  }

  /** Mount extra content ahead of everything else, marked as a replacer. */
  addReplacer(p) {
    const held = this.mounts;
    this.mounts = [];
    let ok = false;
    try { ok = this.addAny(p); } finally {
      for (const m of this.mounts) { m.replacer = true; m.source = p; }
      this.mounts = [...held.filter(m => m.replacer), ...this.mounts, ...held.filter(m => !m.replacer)];
    }
    return ok;
  }

  /** The same search path without replacers: what the map was compiled against. */
  original() {
    const view = new VFS();
    view.mounts = this.mounts.filter(m => !m.replacer);
    return view;
  }

  /** Every copy of a file, highest priority first, for choosing between them. */
  copies(p) {
    const n = norm(p);
    return this.mounts.filter(m => m.has(n)).map(m => ({
      data: m.read(n),
      use: () => { if (m.replacer) (m.used ??= new Set()).add(n); },
    }));
  }

  /** Replacer files actually used, per source, and clear the count. */
  takeOverrides() {
    const out = {};
    for (const m of this.mounts) {
      if (!m.replacer || !m.used?.size) continue;
      out[m.source] = (out[m.source] ?? 0) + m.used.size;
      m.used.clear();
    }
    return out;
  }

  /** Mount a game folder the way the engine does: loose files first, then its VPKs. */
  addGame(dir) {
    if (!fs.existsSync(dir)) return false;
    this.addDir(dir);
    for (const f of fs.readdirSync(dir)) {
      if (!/_dir\.vpk$/i.test(f)) continue;
      if (/sound/i.test(f)) continue; // never needed for geometry or textures
      try { this.addVpk(path.join(dir, f)); } catch { /* unreadable archive */ }
    }
    return true;
  }

  find(p) {
    const n = norm(p);
    for (const m of this.mounts) if (m.has(n)) return m;
    return null;
  }
  has(p) { return !!this.find(p); }
  read(p) {
    const n = norm(p);
    for (const m of this.mounts) {
      if (!m.has(n)) continue;
      if (m.replacer && n.endsWith('.vtf')) (m.used ??= new Set()).add(n);
      return m.read(n);
    }
    return null;
  }
  close() { for (const m of this.mounts) m.close?.(); }
}
