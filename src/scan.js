// Pre-import moderation scan. Nothing here uploads anything: it lists every asset that
// would be ported, plus heuristic flags, so a person decides before Roblox sees any of it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeVtf } from './vtf.js';
import { encodePng, downscale } from './png.js';
import { loadModel } from './mdl.js';
import { normMat } from './vmt.js';
import { baseMatId } from './scene.js';
import { sub, cross, dot, unit } from './math.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- word lists ---------------------------------------------------------
const CONTAINS = [
  ['gore', 'high', /blood|gore(?![a-z]{2})|corpse|cadaver|viscera|entrail|severed|mutilat|dismember|decapit|disembowel|bloodstain|skeleton_gib|hgib|agib/],
  ['sexual', 'high', /porn|hentai|nude|naked|boob|penis|vagina|genital|nipple|lingerie|xxx|sexy|playboy|ahegao|futanari/],
  ['hate', 'high', /nazi|swastika|hitler|reichsadler|kkk|klansman|confederate/],
  ['drugs', 'high', /marijuana|cannabis|cocaine|heroin|meth_?lab|crackpipe/],
];
const TOKENS = [
  ['gore', 'high', ['gib', 'gibs', 'guts', 'flesh', 'wound', 'wounds', 'splat', 'torso', 'skull', 'bodybag']],
  ['sexual', 'high', ['sex', 'cum', 'tits', 'dildo', 'anal', 'nsfw']],
  ['drugs', 'low', ['weed', 'syringe', 'bong', 'pills']],
  ['alcohol', 'low', ['beer', 'wine', 'vodka', 'whiskey', 'whisky', 'liquor', 'bourbon', 'alcohol']],
  ['tobacco', 'low', ['cigar', 'cigars', 'cigarette', 'cigarettes', 'tobacco', 'ashtray']],
  ['weapon', 'low', ['gun', 'pistol', 'rifle', 'shotgun']],
];
const PROFANITY = /\b(fuck|shit|bitch|cunt|nigg|fag+ot|retard|whore|slut)/i;

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s"'<>]+|\b[a-z0-9][a-z0-9-]{1,40}\.(?:com|net|org|gg|io|tv|co|ru|de|uk|info|me|xyz|link|ly|fm|us|eu|cc|to)\b(?:\/\S*)?/i;
const SOCIAL_RE = /discord|steamcommunity|steampowered|youtube|youtu\.be|twitch|patreon|facebook|twitter|instagram|tiktok|telegram|paypal/i;

/** Text that could point players off-platform. Roblox treats this as a violation. */
export function findLinks(text) {
  if (!text) return [];
  const out = [];
  const m = text.match(URL_RE);
  if (m) out.push(m[0]);
  const s = text.match(SOCIAL_RE);
  if (s) out.push(s[0]);
  return out;
}

export function nameFlags(name) {
  const flags = [];
  const low = name.toLowerCase();
  for (const [cat, sev, re] of CONTAINS) {
    const m = low.match(re);
    if (m) flags.push({ cat, sev, why: `name contains "${m[0]}"` });
  }
  const tokens = new Set(low.split(/[^a-z]+/).filter(Boolean));
  for (const [cat, sev, words] of TOKENS) {
    for (const w of words) {
      if (tokens.has(w)) { flags.push({ cat, sev, why: `name contains "${w}"` }); break; }
    }
  }
  for (const l of findLinks(low)) flags.push({ cat: 'link', sev: 'high', why: `name contains "${l}"` });
  return flags;
}

// ---- image heuristics. These find candidates for review; they do not judge. ----
export function imageFlags(img) {
  const { rgba, width, height } = img;
  const step = Math.max(1, Math.floor(Math.sqrt(width * height / 40000)));
  let n = 0, red = 0, skin = 0;
  let sr = 0, sg = 0, sb = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const o = (y * width + x) * 4;
      if (rgba[o + 3] < 40) continue;
      const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      n++; sr += r; sg += g; sb += b;
      if (r > 55 && r > g * 2.3 && r > b * 2.3) red++;
      const cb = 128 - 0.169 * r - 0.331 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.419 * g - 0.081 * b;
      if (r > 95 && g > 40 && b > 20 && r > g && r > b && r - Math.min(g, b) > 15 && cr >= 135 && cr <= 173 && cb >= 85 && cb <= 127) skin++;
    }
  }
  const flags = [];
  if (!n) return { flags, avg: [128, 128, 128] };
  const redPct = red / n, skinPct = skin / n;
  if (redPct > 0.06) flags.push({ cat: 'red', sev: 'low', why: `${Math.round(redPct * 100)}% deep red pixels (possible blood)` });
  if (skinPct > 0.55) flags.push({ cat: 'skin', sev: 'low', why: `${Math.round(skinPct * 100)}% skin-toned pixels` });
  return { flags, avg: [sr / n | 0, sg / n | 0, sb / n | 0], redPct, skinPct };
}

// ---- OCR ----------------------------------------------------------------
function runOcr(files, onLine) {
  return new Promise(resolve => {
    if (!files.length) { resolve({ ok: true }); return; }
    const list = path.join(os.tmpdir(), `smi_ocr_${process.pid}_${Date.now()}.txt`);
    fs.writeFileSync(list, files.join('\r\n'));
    const script = fs.readFileSync(path.join(HERE, 'ocr.ps1'), 'utf8');
    // EncodedCommand runs under any execution policy. Piping over stdin looks like it
    // works but silently executes nothing, because multi-line blocks never complete.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      env: { ...process.env, SMI_OCR_LIST: list }, windowsHide: true,
    });
    ps.stdin.end();
    let buf = '', fatal = null;
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try {
          const j = JSON.parse(line);
          if (j.fatal) fatal = j.fatal; else onLine(j);
        } catch { /* partial or noisy console output */ }
      }
    });
    let err = '';
    ps.stderr.on('data', d => { err += d; });
    ps.on('error', e => resolve({ ok: false, error: e.message }));
    ps.on('close', () => {
      try { fs.unlinkSync(list); } catch { /* temp file */ }
      resolve(fatal ? { ok: false, error: fatal } : { ok: true, stderr: err.slice(0, 500) });
    });
  });
}

/** Nearest-neighbour upscale, so tiny texture text is big enough for the OCR engine. */
function upscale(rgba, w, h, f) {
  const W = w * f, H = h * f;
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = (y / f | 0) * w;
    for (let x = 0; x < W; x++) {
      const s = (sy + (x / f | 0)) * 4, o = (y * W + x) * 4;
      out[o] = rgba[s]; out[o + 1] = rgba[s + 1]; out[o + 2] = rgba[s + 2]; out[o + 3] = 255;
    }
  }
  return { rgba: out, width: W, height: H };
}

// ---- model thumbnails ---------------------------------------------------
function renderModel(md, avgColorOf, size = 160) {
  const { pos, nrm } = md.vvd;
  const a = 0.7, b = 0.5;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
  const view = i => {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const rx = x * ca - y * sa, ry = x * sa + y * ca;
    return [rx, z * cb + ry * sb, ry * cb - z * sb];
  };
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const m of md.meshes) {
    for (const i of m.indices) {
      const v = view(i);
      lo = [Math.min(lo[0], v[0]), Math.min(lo[1], v[1])];
      hi = [Math.max(hi[0], v[0]), Math.max(hi[1], v[1])];
    }
  }
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], 1e-3);
  const f = (size - 12) / span;
  const ox = size / 2 - (lo[0] + hi[0]) / 2 * f, oy = size / 2 + (lo[1] + hi[1]) / 2 * f;
  const zbuf = new Float32Array(size * size).fill(Infinity);
  const px = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) { px[i * 4] = 34; px[i * 4 + 1] = 37; px[i * 4 + 2] = 43; px[i * 4 + 3] = 255; }
  const L = unit([0.4, -0.5, 0.75]);
  for (const m of md.meshes) {
    const col = avgColorOf(m.material);
    for (let t = 0; t < m.indices.length; t += 3) {
      const ids = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
      const v = ids.map(view).map(p => [ox + p[0] * f, oy - p[1] * f, p[2]]);
      const area = (v[1][0] - v[0][0]) * (v[2][1] - v[0][1]) - (v[1][1] - v[0][1]) * (v[2][0] - v[0][0]);
      if (Math.abs(area) < 1e-6) continue;
      const nx = nrm[ids[0] * 3], ny = nrm[ids[0] * 3 + 1], nz = nrm[ids[0] * 3 + 2];
      const shade = 0.35 + 0.65 * Math.max(0, dot([nx, ny, nz], L));
      const x0 = Math.max(0, Math.floor(Math.min(v[0][0], v[1][0], v[2][0]))), x1 = Math.min(size - 1, Math.ceil(Math.max(v[0][0], v[1][0], v[2][0])));
      const y0 = Math.max(0, Math.floor(Math.min(v[0][1], v[1][1], v[2][1]))), y1 = Math.min(size - 1, Math.ceil(Math.max(v[0][1], v[1][1], v[2][1])));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const w0 = ((v[1][0] - x) * (v[2][1] - y) - (v[1][1] - y) * (v[2][0] - x)) / area;
          const w1 = ((v[2][0] - x) * (v[0][1] - y) - (v[2][1] - y) * (v[0][0] - x)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * v[0][2] + w1 * v[1][2] + w2 * v[2][2];
          if (z >= zbuf[y * size + x]) continue;
          zbuf[y * size + x] = z;
          const o = (y * size + x) * 4;
          px[o] = col[0] * shade; px[o + 1] = col[1] * shade; px[o + 2] = col[2] * shade;
        }
      }
    }
  }
  return encodePng(px, size, size, { alpha: false });
}

// ---- the scan -----------------------------------------------------------
export async function scanScene({ scene, map, vfs, workDir, ocr = true, onProgress = () => {} }) {
  const thumbs = path.join(workDir, 'thumbs');
  fs.mkdirSync(thumbs, { recursive: true });
  const getMat = scene.getMat;

  // Usage: which materials appear, and how often.
  const uses = new Map();
  const bump = (id, kind, n = 1) => {
    const base = baseMatId(id);
    const u = uses.get(base) ?? { faces: 0, overlays: 0, decals: 0, models: new Set() };
    if (kind === 'overlay') u.overlays += n; else if (kind === 'decal') u.decals += n; else u.faces += n;
    uses.set(base, u);
  };
  for (const [id, list] of scene.polys) bump(id, 'face', list.length);
  for (const o of scene.overlays ?? []) bump(o.material, 'overlay');
  for (const d of scene.decals ?? []) bump(d.material, 'decal');

  const assets = [];
  const avgByMat = new Map();
  const modelGroups = new Map();
  for (const p of scene.props) {
    const g = modelGroups.get(p.model) ?? { model: p.model, count: 0, variants: new Map() };
    g.count++;
    g.variants.set(`${p.skin}|${p.body}|${p.hardware ?? ''}`, p);
    modelGroups.set(p.model, g);
  }

  // Models are read first, because they contribute materials of their own. Every skin and
  // door handle the map uses counts: each can bring textures the others don't have.
  const modelData = new Map();
  for (const g of modelGroups.values()) {
    const seen = new Set();
    for (const p of g.variants.values()) {
      try {
        const md = loadModel(vfs, g.model, { skin: p.skin, body: p.body, hardware: p.hardware });
        if (!modelData.has(g.model)) modelData.set(g.model, md);
        for (const m of md.meshes) {
          const id = normMat(m.material);
          if (seen.has(id)) continue;
          seen.add(id);
          bump(id, 'model', 1);
          uses.get(id).models.add(g.model);
        }
      } catch (e) { g.error ??= e.message; }
    }
  }

  // OCR input is written here and deleted after the scan.
  const ocrDir = path.join(workDir, 'ocr_tmp');
  fs.rmSync(ocrDir, { recursive: true, force: true });
  fs.mkdirSync(ocrDir, { recursive: true });
  const ocrFiles = new Map();
  const textureDone = new Map();

  const readTexture = (name, hasOwnAlpha) => {
    if (textureDone.has(name)) return textureDone.get(name);
    let res = null;
    const buf = vfs.read(`materials/${name}.vtf`);
    if (buf) {
      try {
        const img = decodeVtf(buf, 1024);
        const hash = crypto.createHash('sha1').update(name).digest('hex').slice(0, 16);
        // Text on a transparent decal is only readable composited over a flat colour.
        const flat = Buffer.from(img.rgba);
        let cutout = false;
        for (let i = 3; i < flat.length; i += 4) if (flat[i] < 200) { cutout = true; break; }
        if (cutout && hasOwnAlpha) {
          for (let i = 0; i < flat.length; i += 4) {
            const a = flat[i + 3] / 255;
            flat[i] = flat[i] * a + 128 * (1 - a);
            flat[i + 1] = flat[i + 1] * a + 128 * (1 - a);
            flat[i + 2] = flat[i + 2] * a + 128 * (1 - a);
          }
        }
        const thumb = downscale(img.rgba, img.width, img.height, 160);
        fs.writeFileSync(path.join(thumbs, `${hash}.png`), encodePng(thumb.rgba, thumb.width, thumb.height, { alpha: true }));
        const info = imageFlags({ rgba: flat, width: img.width, height: img.height });
        res = { hash, w: img.origWidth, h: img.origHeight, avg: info.avg, flags: info.flags };
        if (ocr) {
          // Small textures get an upscale: this is the case the moderation pass exists for.
          const f = Math.max(img.width, img.height) <= 256 ? 3 : Math.max(img.width, img.height) <= 512 ? 2 : 1;
          const big = f > 1 ? upscale(flat, img.width, img.height, f) : { rgba: flat, width: img.width, height: img.height };
          const file = path.join(ocrDir, `${hash}.png`);
          fs.writeFileSync(file, encodePng(big.rgba, big.width, big.height, { alpha: false, level: 1 }));
          ocrFiles.set(file, res);
        }
      } catch (e) { res = { hash: null, error: e.message, flags: [] }; }
    }
    textureDone.set(name, res);
    return res;
  };

  const ids = [...uses.keys()];
  let done = 0;
  for (const id of ids) {
    onProgress({ stage: 'Reading textures', done: done++, total: ids.length });
    if (done % 4 === 0) await new Promise(r => setImmediate(r));
    const desc = getMat(id);
    if (desc.isTool) continue;
    const u = uses.get(id);
    const tex = [];
    for (const t of [desc.base, desc.base2]) {
      if (!t) continue;
      const r = readTexture(t, desc.translucent || desc.alphatest || desc.decal);
      if (r) tex.push({ name: t, ...r });
    }
    const primary = tex.find(t => t.hash);
    if (primary) avgByMat.set(id, primary.avg);
    const kind = u.overlays || u.decals ? 'decal' : 'material';
    const a = {
      id, kind, name: id, thumb: primary?.hash ?? null, width: primary?.w, height: primary?.h,
      textures: tex.map(t => t.name), texHashes: tex.map(t => t.hash).filter(Boolean),
      uses: { faces: u.faces, overlays: u.overlays, decals: u.decals, models: u.models.size },
      shader: desc.shader, missing: desc.missing || !primary,
      flags: dedupeFlags([...nameFlags(id), ...tex.flatMap(t => nameFlags(t.name)), ...tex.flatMap(t => t.flags)]),
    };
    if (desc.missing) a.flags.push({ cat: 'missing', sev: 'low', why: 'material file not found in any mounted content' });
    else if (!primary) a.flags.push({ cat: 'missing', sev: 'low', why: 'texture not found in any mounted content' });
    assets.push(a);
  }

  for (const g of modelGroups.values()) {
    onProgress({ stage: 'Rendering models', done: assets.length, total: ids.length + modelGroups.size });
    await new Promise(r => setImmediate(r));
    const md = modelData.get(g.model);
    const id = `model:${g.model}`;
    const a = {
      id, kind: 'model', name: g.model, thumb: null, uses: { instances: g.count },
      materials: md ? [...new Set(md.meshes.map(m => normMat(m.material)))] : [],
      flags: nameFlags(g.model), missing: !md,
    };
    if (md) {
      const hash = crypto.createHash('sha1').update(id).digest('hex').slice(0, 16);
      const avg = m => avgByMat.get(normMat(m)) ?? [150, 150, 150];
      fs.writeFileSync(path.join(thumbs, `${hash}.png`), renderModel(md, avg));
      a.thumb = hash;
    } else a.flags.push({ cat: 'broken', sev: 'low', why: `could not decode: ${g.error}` });
    assets.push(a);
  }

  if (scene.sky) {
    const faces = [];
    for (const s of ['ft', 'bk', 'lf', 'rt', 'up', 'dn']) {
      const d = getMat(`skybox/${scene.sky}${s}`);
      const r = readTexture(d.base ?? `skybox/${scene.sky}${s}`, false);
      if (r?.hash) faces.push({ s, ...r });
    }
    assets.push({
      id: `sky:${scene.sky}`, kind: 'sky', name: `Skybox: ${scene.sky}`, thumb: faces[0]?.hash ?? null,
      texHashes: faces.map(f => f.hash), uses: { faces: 6 }, flags: faces.flatMap(f => f.flags),
    });
  }

  // OCR
  let ocrStatus = { ran: false };
  if (ocr && ocrFiles.size) {
    let n = 0;
    onProgress({ stage: 'Reading text in textures (OCR)', done: 0, total: ocrFiles.size });
    const r = await runOcr([...ocrFiles.keys()], ({ p, t, e }) => {
      onProgress({ stage: 'Reading text in textures (OCR)', done: ++n, total: ocrFiles.size });
      if (e) n--; // an unreadable image is not a scanned image
      const res = ocrFiles.get(p);
      if (!res || !t) return;
      const text = t.replace(/\s+/g, ' ').trim();
      if (text.length < 3) return;
      res.ocr = text;
      const links = findLinks(text.toLowerCase());
      if (links.length) res.flags.push({ cat: 'link', sev: 'high', why: `readable text looks like a link: "${links[0]}"` });
      const bad = text.match(PROFANITY);
      if (bad) res.flags.push({ cat: 'profanity', sev: 'high', why: `readable text contains "${bad[0]}"` });
      // Short garbage is common on noisy textures. Only real words count as text.
      if (/[a-z]{3,}/i.test(text)) res.flags.push({ cat: 'text', sev: 'low', why: `readable text: "${text.slice(0, 60)}"` });
    });
    // "Ran" means every image came back. A silent failure must never read as a clean scan.
    const complete = r.ok && n === ocrFiles.size;
    ocrStatus = {
      ran: complete, files: ocrFiles.size, read: n,
      error: complete ? undefined : (r.error ?? `OCR only returned ${n} of ${ocrFiles.size} images`),
    };
    // Flags were added to texture records after the assets were built, so merge them in.
    for (const a of assets) {
      for (const name of a.textures ?? []) {
        const t = textureDone.get(name);
        if (!t) continue;
        for (const f of t.flags) {
          if (!a.flags.some(x => x.why === f.why)) a.flags.push(f);
        }
        if (t.ocr) a.ocr = t.ocr;
      }
    }
  }
  fs.rmSync(ocrDir, { recursive: true, force: true });

  // Cubemap-patched copies are the same picture many times over. One card, one decision.
  const groups = new Map();
  for (const a of assets) {
    if (a.kind !== 'material' && a.kind !== 'decal') continue;
    const key = a.textures?.length ? a.textures.join('|') : null;
    if (!key) continue;
    const g = groups.get(key);
    if (!g) { groups.set(key, a); a.members = [a.id]; continue; }
    g.members.push(a.id);
    g.uses.faces += a.uses.faces; g.uses.overlays += a.uses.overlays; g.uses.decals += a.uses.decals;
    g.uses.models = Math.max(g.uses.models, a.uses.models);
    if (a.kind === 'decal') g.kind = 'decal';
    // Prefer the plain name over a generated maps/<map>/..._x_y_z one.
    if (/^maps\//.test(g.name) && !/^maps\//.test(a.name)) g.name = a.name;
    for (const f of a.flags) if (!g.flags.some(x => x.why === f.why)) g.flags.push(f);
    a.mergedInto = g.id;
  }
  for (let i = assets.length - 1; i >= 0; i--) if (assets[i].mergedInto) assets.splice(i, 1);
  for (const a of assets) {
    if (a.members?.length > 1 && /^maps\//.test(a.name) && a.textures?.[0]) a.name = a.textures[0];
  }

  // A model inherits the worst flags of its materials: the model card is where a viewer looks.
  const byId = new Map();
  for (const a of assets) for (const id of a.members ?? [a.id]) byId.set(id, a);
  for (const a of assets) {
    if (a.kind !== 'model') continue;
    for (const m of a.materials) {
      const mat = byId.get(m);
      if (!mat) continue;
      for (const f of mat.flags) {
        if (f.sev === 'high' && !a.flags.some(x => x.why === f.why)) a.flags.push({ ...f, why: `material: ${f.why}` });
      }
    }
  }

  // Text that lives in the map but is never ported. Shown so nothing is a surprise.
  const notes = [];
  const seen = new Set();
  const note = (where, text) => {
    const k = `${where}|${text}`;
    if (seen.has(k)) return;
    seen.add(k);
    notes.push({ where, text: text.slice(0, 200) });
  };
  for (const e of map?.entities ?? []) {
    for (const [k, v] of Object.entries(e)) {
      if (typeof v === 'string' && findLinks(v.toLowerCase()).length) note(`entity ${e.classname ?? '?'} (${k})`, v);
    }
  }

  assets.sort((x, y) => sevRank(y) - sevRank(x) || x.name.localeCompare(y.name));
  return { assets, notes, ocr: ocrStatus };
}

const sevRank = a => (a.flags.some(f => f.sev === 'high') ? 2 : a.flags.length ? 1 : 0);

function dedupeFlags(flags) {
  const seen = new Set();
  return flags.filter(f => !seen.has(f.why) && seen.add(f.why));
}
