// Local app server: the moderation UI talks to it, and the Studio plugin pulls builds from it.
// Bound to 127.0.0.1 only. Host and Origin are checked, so a web page open in your browser
// cannot drive this API through your machine.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseBsp } from './bsp.js';
import { VFS, gmaMaps } from './vfs.js';
import { buildScene } from './scene.js';
import { buildSceneFromVmf } from './vmf.js';
import { scanScene } from './scan.js';
import { exportScene } from './export.js';
import { uploadBuild } from './upload.js';
import { decodeVtf } from './vtf.js';
import { encodePng } from './png.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// The packaged app's own folder gets replaced on every update, so saved work lives elsewhere.
const PROJECTS = path.join(process.env.SMI_DATA || ROOT, 'projects');
const PORT = Number(process.env.SMI_PORT) || 34871;

const state = { project: null, job: null };

// ---- update check -------------------------------------------------------
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const LATEST_RELEASE = 'https://api.github.com/repos/typicalmattt-source/smi-release/releases/latest';

/** True when version a is later than b. Both are dotted numbers such as 1.10.0. */
export function isNewer(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

// Once per launch. Being offline, or the check failing, should never get in the way.
let updateCheck = null;
const checkForUpdate = () => updateCheck ??= (async () => {
  try {
    const res = await fetch(LATEST_RELEASE, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'source-map-importer' }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return { current: VERSION };
    const latest = String((await res.json()).tag_name ?? '').replace(/^v/, '');
    return { current: VERSION, latest, available: /^\d+(\.\d+)*$/.test(latest) && isNewer(latest, VERSION) };
  } catch { return { current: VERSION }; }
})();

// ---- content mounting ---------------------------------------------------
/** Library folders named in Steam's libraryfolders.vdf. */
export function steamLibraries(vdf) {
  return [...vdf.matchAll(/"path"\s+"([^"]+)"/gi)].map(m => m[1].replace(/\\\\/g, '/'));
}

function steamInstallDir() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', windowsHide: true });
    return out.match(/SteamPath\s+REG_SZ\s+(.+)/)?.[1].trim() ?? null;
  } catch { return null; } // no Steam, or not Windows
}

function steamCommonDirs() {
  const roots = ['C:/Steam', 'C:/Program Files (x86)/Steam'];
  const steam = steamInstallDir();
  if (steam) roots.push(steam);
  for (const root of [...roots]) {
    const file = path.join(root, 'steamapps', 'libraryfolders.vdf');
    try { roots.push(...steamLibraries(fs.readFileSync(file, 'utf8'))); } catch { /* not installed here */ }
  }
  // The same library can arrive by several routes, spelled differently.
  const unique = new Map();
  for (const root of roots) {
    const dir = path.join(root, 'steamapps', 'common');
    if (fs.existsSync(dir)) unique.set(path.resolve(dir).toLowerCase(), dir);
  }
  return [...unique.values()];
}

const KNOWN_GAMES = [
  ['Half-Life 2', ['Half-Life 2/hl2', 'Half-Life 2/episodic', 'Half-Life 2/ep2']],
  ["Garry's Mod", ['GarrysMod/garrysmod', 'GarrysMod/sourceengine']],
  ['Counter-Strike: Source', ['Counter-Strike Source/cstrike']],
  ['Day of Defeat: Source', ['Day of Defeat Source/dod']],
  ['Portal', ['Portal/portal']],
  // DLC outranks the base game in these, as in their gameinfo.txt, so it comes first.
  ['Portal 2', ['Portal 2/portal2_dlc2', 'Portal 2/portal2_dlc1', 'Portal 2/portal2']],
  ['Left 4 Dead', ['left 4 dead/left4dead']],
  ['Left 4 Dead 2', ['Left 4 Dead 2/update', 'Left 4 Dead 2/left4dead2_dlc3', 'Left 4 Dead 2/left4dead2_dlc2', 'Left 4 Dead 2/left4dead2_dlc1', 'Left 4 Dead 2/left4dead2']],
  ['Black Mesa', ['Black Mesa/bms']],
  ['CS:GO', ['Counter-Strike Global Offensive/csgo']],
];

const SHARED_FOLDER = /^(hl2|ep2|episodic|portal2(_dlc\d)?|left4dead2?(_dlc\d)?|platform|sourceengine)$/i;

const subfolders = dir => {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; }
};

const gameTitle = (folder, fallback) => {
  try {
    const text = fs.readFileSync(path.join(folder, 'gameinfo.txt'), 'latin1');
    return text.match(/^\s*"?game"?\s+"?([^"\r\n]+?)"?\s*$/im)?.[1].trim() || fallback;
  } catch { return fallback; }
};

/**
 * Any Source game or mod the list above doesn't name, found by its gameinfo.txt, so a game
 * needn't be known in advance. Stock HL2 content sits beside the game in many installs.
 */
export function scanSourceGames(common, known = new Set()) {
  const out = [];
  for (const top of subfolders(common)) {
    if (known.has(top.toLowerCase())) continue;
    const root = path.join(common, top);
    const inside = subfolders(root).filter(s => fs.existsSync(path.join(root, s, 'gameinfo.txt')));
    if (!inside.length) continue;
    // Standalone games ship stock content in folders that carry their own gameinfo.txt.
    // Those belong with the game itself, as lower priority, not as games of their own.
    const main = inside.filter(s => !SHARED_FOLDER.test(s));
    const shared = inside.filter(s => SHARED_FOLDER.test(s));
    const hl2 = path.join(root, 'hl2');
    if (fs.existsSync(hl2) && !shared.some(s => s.toLowerCase() === 'hl2')) shared.push('hl2');
    const first = main.length ? main : [shared[0]];
    out.push({
      name: gameTitle(path.join(root, first[0]), top),
      dirs: [...first, ...shared.filter(s => !first.includes(s))].map(s => path.join(root, s)),
    });
  }
  const mods = path.join(common, '..', 'sourcemods');
  for (const mod of subfolders(mods)) {
    const dir = path.join(mods, mod);
    if (fs.existsSync(path.join(dir, 'gameinfo.txt'))) out.push({ name: gameTitle(dir, mod), dirs: [dir] });
  }
  return out;
}

// Polled constantly by the app, and finding Steam starts a process, so this runs once.
let gameList = null;
function detectGames() {
  if (gameList) return gameList;
  gameList = [];
  const known = new Set(KNOWN_GAMES.flatMap(([, rel]) => rel.map(r => r.split('/')[0].toLowerCase())));
  for (const common of steamCommonDirs()) {
    for (const [name, rel] of KNOWN_GAMES) {
      const dirs = rel.map(r => path.join(common, r)).filter(d => fs.existsSync(d));
      if (dirs.length) gameList.push({ name, dirs });
    }
    gameList.push(...scanSourceGames(common, known));
  }
  return gameList;
}

/** The game a map's own folder belongs to: <game>/maps/foo.bsp. */
function gameDirOf(file) {
  const dir = path.dirname(file);
  return path.basename(dir).toLowerCase() === 'maps' ? path.dirname(dir) : null;
}

function openVfs(cfg, pak) {
  const vfs = new VFS();
  const mounted = [];
  // Order is priority: first match wins, exactly like Source's search paths. Extra content is
  // chosen by hand to replace things, so it outranks everything, even files packed in the map.
  for (const p of cfg.content ?? []) if (p && vfs.addReplacer(p)) mounted.push(p);
  if (pak?.length) { vfs.addPak(Buffer.from(pak), 'embedded in map'); mounted.push('embedded in map'); }
  const base = cfg.map.replace(/\.[^.]+$/, '');
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) { vfs.addDir(base); mounted.push(base); }
  // A ticked game keeps its place in the list, so DLC still outranks the base game when the
  // map sits inside one of them. The map's own game only goes first when it isn't ticked.
  const own = gameDirOf(cfg.map);
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const games = cfg.games ?? [];
  if (own && !games.some(g => same(g, own)) && vfs.addGame(own)) mounted.push(own);
  for (const g of games) if (vfs.addGame(g)) mounted.push(g);
  return { vfs, mounted };
}

function loadProject(cfgIn) {
  const cfg = { ...cfgIn };
  // A workshop .gma: use the map inside it, and mount the addon's own content.
  if (/\.gma$/i.test(cfg.map)) {
    const maps = gmaMaps(cfg.map);
    if (!maps.length) throw new Error('this .gma has no map in it');
    const wanted = cfg.gmaMap ? maps.find(m => m.name === cfg.gmaMap) : maps[0];
    if (!wanted) throw new Error(`map not found in .gma: ${cfg.gmaMap}`);
    const cache = path.join(PROJECTS, '_gma');
    fs.mkdirSync(cache, { recursive: true });
    const out = path.join(cache, path.basename(wanted.name));
    fs.writeFileSync(out, wanted.read());
    cfg.content = [cfg.map, ...(cfg.content ?? [])];
    cfg.map = out;
  }
  const mapName = path.basename(cfg.map).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_.-]+/g, '_');
  const isVmf = /\.vmf$/i.test(cfg.map);
  let map = null, pak = null;
  if (!isVmf) {
    map = parseBsp(fs.readFileSync(cfg.map));
    pak = map.pak;
  } else {
    const twin = cfg.map.replace(/\.vmf$/i, '.bsp');
    if (fs.existsSync(twin)) { try { pak = parseBsp(fs.readFileSync(twin)).pak; } catch { /* VMF still loads alone */ } }
  }
  const { vfs, mounted } = openVfs(cfg, pak);
  const opts = { mapName, terrainWater: cfg.terrainWater !== false };
  const scene = isVmf
    ? buildSceneFromVmf(fs.readFileSync(cfg.map, 'latin1'), vfs, opts)
    : buildScene(map, vfs, opts);
  return { map, vfs, scene, mounted, mapName };
}

// ---- jobs ---------------------------------------------------------------
let jobSeq = 0;
function startJob(name, fn) {
  if (state.job?.running) throw new Error('another job is still running');
  // The id lets the UI notice jobs that finish between two status checks.
  const job = { id: ++jobSeq, name, running: true, stage: 'Starting', done: 0, total: 0, error: null, result: null };
  state.job = job;
  const onProgress = p => { job.stage = p.stage; job.done = p.done; job.total = p.total; };
  Promise.resolve().then(() => fn(onProgress)).then(r => { job.result = r ?? true; }).catch(e => {
    console.error(e);
    job.error = e.message;
  }).finally(() => { job.running = false; });
  return job;
}

// ---- moderation state ---------------------------------------------------
const proj = () => {
  if (!state.project) throw new Error('no map loaded');
  return state.project;
};
const decisionsFile = p => path.join(p.dir, 'decisions.json');
const saveDecisions = p => fs.writeFileSync(decisionsFile(p), JSON.stringify(p.decisions, null, 1));

/** Card decisions, expanded to every material that shares the card. */
function expandedDecisions(p) {
  const out = {};
  for (const a of p.scan.assets) {
    const d = p.decisions[a.id];
    if (!d) continue;
    for (const id of a.members ?? [a.id]) out[id] = d;
  }
  return out;
}

function reviewSummary(p) {
  const high = p.scan.assets.filter(a => a.flags.some(f => f.sev === 'high'));
  const pending = high.filter(a => !p.decisions[a.id]);
  return {
    assets: p.scan.assets.length, reviewed: Object.keys(p.decisions).length,
    flagged: high.length, pending: pending.length,
    removed: Object.values(p.decisions).filter(d => d.action === 'remove').length,
    ocr: p.scan.ocr,
  };
}

/** What stands between this project and an upload. */
function buildBlockers(p, ack) {
  const r = reviewSummary(p), out = [];
  if (r.pending) out.push(`${r.pending} high-priority asset(s) still need a decision`);
  if (!r.ocr?.ran && !ack) out.push(`text scan incomplete (${r.ocr?.error ?? 'OCR did not run'}): links inside textures may be missed`);
  return out;
}

// ---- HTTP ---------------------------------------------------------------
const readBody = req => new Promise((res, rej) => {
  const c = [];
  let n = 0;
  req.on('data', d => { n += d.length; if (n > 64 * 1024 * 1024) { rej(new Error('body too large')); req.destroy(); } else c.push(d); });
  req.on('end', () => res(Buffer.concat(c)));
  req.on('error', rej);
});
const json = (res, obj, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const png = (res, buf) => { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' }); res.end(buf); };

const PAGE = 2000;
function pluginSection(p, name, page) {
  const m = p.build.manifest;
  const list = {
    meshes: Object.entries(m.meshes), lib: Object.entries(m.lib), instances: m.instances, parts: m.parts,
    materials: m.materials, water: m.water, lights: m.lights,
    ropes: m.ropes ?? [], spawns: m.spawns ?? [], markers: m.markers ?? [], missingProps: m.missingProps ?? [],
    brushes: m.brushes ?? [], clipParts: m.clipParts ?? [], overlays: m.overlays ?? [],
  }[name];
  if (!list) throw new Error('unknown section');
  return { items: list.slice(page * PAGE, (page + 1) * PAGE), more: (page + 1) * PAGE < list.length };
}

async function route(req, res, url) {
  const p = url.pathname;

  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(path.join(ROOT, 'public', 'index.html')));
    return;
  }

  if (p === '/api/update') { json(res, await checkForUpdate()); return; }

  if (p === '/api/status') {
    const pr = state.project;
    json(res, {
      job: state.job, games: detectGames(),
      project: pr && {
        name: pr.name, map: pr.cfg.map, mounted: pr.mounted, review: reviewSummary(pr), blockers: buildBlockers(pr),
        build: pr.build?.stats ?? null, built: !!pr.build, stale: !!pr.buildStale,
        uploaded: pr.upload ?? null, notes: pr.scan.notes, overrides: pr.overrides ?? {},
      },
    });
    return;
  }

  if (p === '/api/scan' && req.method === 'POST') {
    const cfg = JSON.parse(await readBody(req));
    if (!cfg.map || !fs.existsSync(cfg.map)) throw new Error('map file not found');
    startJob('scan', async onProgress => {
      onProgress({ stage: 'Reading map', done: 0, total: 0 });
      // The new map loads first, so a bad file doesn't throw away the one already open.
      const lp = loadProject(cfg);
      state.project?.vfs.close();
      state.project = null;
      const dir = path.join(PROJECTS, lp.mapName);
      fs.mkdirSync(dir, { recursive: true });
      const scan = await scanScene({ scene: lp.scene, map: lp.map, vfs: lp.vfs, workDir: dir, ocr: cfg.ocr !== false, onProgress });
      const f = path.join(dir, 'decisions.json');
      const decisions = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
      state.project = { ...lp, name: lp.mapName, dir, cfg, scan, decisions, build: null, overrides: lp.vfs.takeOverrides() };
      const mf = path.join(dir, 'manifest.json');
      if (fs.existsSync(mf)) {
        state.project.build = {
          manifest: JSON.parse(fs.readFileSync(mf, 'utf8')),
          stats: JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8')),
        };
      }
      return { assets: scan.assets.length };
    });
    json(res, { ok: true });
    return;
  }

  if (p === '/api/assets') { const pr = proj(); json(res, { assets: pr.scan.assets, decisions: pr.decisions }); return; }

  if (p.startsWith('/thumb/')) {
    const h = p.slice(7).replace(/\.png$/, '');
    if (!/^[0-9a-f]{16}$/.test(h)) throw new Error('bad thumb');
    png(res, fs.readFileSync(path.join(proj().dir, 'thumbs', `${h}.png`)));
    return;
  }

  if (p === '/api/full') {
    const pr = proj();
    const a = pr.scan.assets.find(x => x.id === url.searchParams.get('id'));
    const tex = a?.textures?.[0];
    if (!tex) { json(res, { error: 'no texture' }, 404); return; }
    const buf = pr.vfs.read(`materials/${tex}.vtf`);
    const img = decodeVtf(buf, 1024);
    png(res, encodePng(img.rgba, img.width, img.height, { alpha: true, level: 1 }));
    return;
  }

  if (p === '/api/decide' && req.method === 'POST') {
    const pr = proj();
    const { ids, decision } = JSON.parse(await readBody(req));
    for (const id of ids) {
      if (decision) pr.decisions[id] = decision; else delete pr.decisions[id];
    }
    saveDecisions(pr);
    if (pr.build) pr.buildStale = true;
    json(res, { review: reviewSummary(pr), blockers: buildBlockers(pr) });
    return;
  }

  if (p === '/api/replace' && req.method === 'POST') {
    const pr = proj();
    const id = url.searchParams.get('id');
    const body = await readBody(req);
    if (body.readUInt32BE(0) !== 0x89504e47) throw new Error('replacement must be a PNG');
    const dir = path.join(pr.dir, 'replacements');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}.png`);
    fs.writeFileSync(file, body);
    pr.decisions[id] = { action: 'replace', file };
    saveDecisions(pr);
    if (pr.build) pr.buildStale = true;
    json(res, { ok: true, review: reviewSummary(pr), blockers: buildBlockers(pr) });
    return;
  }

  if (p === '/api/build' && req.method === 'POST') {
    const pr = proj();
    const opts = JSON.parse(await readBody(req) || '{}');
    const blockers = buildBlockers(pr, opts.ackNoOcr);
    if (blockers.length) { json(res, { error: blockers.join('; ') }, 409); return; }
    startJob('build', async onProgress => {
      // Rebuilt from a fresh load, because export appends overlays to the scene's polygon lists.
      const lp = loadProject(pr.cfg);
      const { manifest, stats } = await exportScene({
        scene: lp.scene, vfs: lp.vfs, outDir: pr.dir, decisions: expandedDecisions(pr), opts, onProgress: q => onProgress({ stage: `Building ${q.stage}`, done: q.done, total: q.total }),
      });
      lp.vfs.close();
      pr.build = { manifest, stats };
      pr.buildStale = false;
      return stats;
    });
    json(res, { ok: true });
    return;
  }

  if (p === '/api/upload' && req.method === 'POST') {
    const pr = proj();
    if (!pr.build) throw new Error('build the map first');
    if (pr.buildStale) throw new Error('decisions changed since the last build: rebuild first');
    const { apiKey, keyFile, creatorType, creatorId, ackNoOcr } = JSON.parse(await readBody(req));
    const blockers = buildBlockers(pr, ackNoOcr);
    if (blockers.length) { json(res, { error: blockers.join('; ') }, 409); return; }
    const key = (apiKey || (keyFile && fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : '')).trim();
    if (!key) throw new Error('no API key given');
    if (!/^\d+$/.test(String(creatorId))) throw new Error('creator id must be a number');
    startJob('upload', async onProgress => {
      const r = await uploadBuild({
        outDir: pr.dir, key, creator: { type: creatorType === 'group' ? 'group' : 'user', id: creatorId },
        ledgerPath: path.join(pr.dir, 'uploaded.json'), onProgress,
      });
      pr.upload = r;
      return r;
    });
    json(res, { ok: true });
    return;
  }

  // ---- Studio plugin ----
  if (p === '/plugin/info') {
    const pr = state.project;
    if (!pr?.build) { json(res, { ready: false, reason: pr ? 'Build the map in the app first.' : 'Load a map in the app first.' }); return; }
    const m = pr.build.manifest;
    const lf = path.join(pr.dir, 'uploaded.json');
    const ledger = fs.existsSync(lf) ? JSON.parse(fs.readFileSync(lf, 'utf8')) : { images: {}, models: {} };
    const images = {};
    for (const h of Object.keys(m.textures)) if (ledger.images[h]) images[h] = { id: ledger.images[h].id, type: ledger.images[h].type };
    const models = m.files.map(f => ({ file: f.file, id: ledger.models[f.sha]?.id ?? null }));
    json(res, {
      ready: true, stale: !!pr.buildStale, map: m.map, scale: m.scale, sky: m.sky, sun: m.sun, fog: m.fog, images, models, stats: pr.build.stats,
      counts: {
        meshes: Object.keys(m.meshes).length, instances: m.instances.length, parts: m.parts.length, water: m.water.length, lights: m.lights.length,
        ropes: m.ropes?.length ?? 0, spawns: m.spawns?.length ?? 0, markers: m.markers?.length ?? 0, missingProps: m.missingProps?.length ?? 0,
        brushes: m.brushes?.length ?? 0,
      },
      missing: { images: Object.keys(m.textures).length - Object.keys(images).length, models: models.filter(x => !x.id).length },
    });
    return;
  }
  if (p === '/plugin/section') {
    const pr = proj();
    if (!pr.build) throw new Error('not built');
    json(res, pluginSection(pr, url.searchParams.get('name'), Number(url.searchParams.get('page')) || 0));
    return;
  }

  json(res, { error: 'not found' }, 404);
}

const server = http.createServer(async (req, res) => {
  const host = (req.headers.host ?? '').toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) { res.writeHead(403); res.end(); return; }
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) { res.writeHead(403); res.end(); return; }
  try {
    await route(req, res, new URL(req.url, `http://127.0.0.1:${PORT}`));
  } catch (e) {
    if (!res.headersSent) json(res, { error: e.message }, 500); else res.end();
  }
});

/** Starts listening. Resolves with the local address, or rejects if the port is taken. */
export function startServer() {
  return new Promise((resolve, reject) => {
    server.once('error', e => {
      reject(e.code === 'EADDRINUSE' ? new Error(`Port ${PORT} is already in use by another program.`) : e);
    });
    server.listen(PORT, '127.0.0.1', () => resolve(`http://127.0.0.1:${PORT}`));
  });
}
