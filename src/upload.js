// Open Cloud uploads. Keeps a ledger keyed by content hash, so a re-run or an
// interrupted upload never pays for the same asset twice.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BASE = 'https://apis.roblox.com/assets/v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const safeName = s => s.replace(/[^A-Za-z0-9_ -]+/g, '').slice(0, 40) || 'map';

async function createAsset({ key, creator, file, name, assetType, contentType }) {
  const request = {
    assetType, displayName: name, description: '',
    creationContext: { creator: creator.type === 'group' ? { groupId: String(creator.id) } : { userId: String(creator.id) } },
  };
  for (let attempt = 0; attempt < 8; attempt++) {
    const form = new FormData();
    form.append('request', JSON.stringify(request));
    form.append('fileContent', new Blob([fs.readFileSync(file)], { type: contentType }), path.basename(file));
    const res = await fetch(`${BASE}/assets`, { method: 'POST', headers: { 'x-api-key': key }, body: form });
    if (res.status === 429 || res.status >= 500) {
      const wait = Number(res.headers.get('retry-after')) || 2 ** attempt * 2;
      await sleep(wait * 1000);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Open Cloud ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }
  throw new Error('Open Cloud kept rate-limiting; try again later');
}

async function waitOperation(key, op) {
  const id = op.operationId ?? op.path?.split('/').pop();
  if (op.done) return op;
  let delay = 1500;
  const start = Date.now();
  while (Date.now() - start < 10 * 60 * 1000) {
    await sleep(delay);
    delay = Math.min(delay * 1.4, 15000);
    const res = await fetch(`${BASE}/operations/${id}`, { headers: { 'x-api-key': key } });
    if (res.status === 429 || res.status >= 500) continue;
    const j = await res.json();
    if (!res.ok) throw new Error(`operation ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
    if (j.done) return j;
  }
  throw new Error('timed out waiting for Roblox to process the asset');
}

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}

export function hashFile(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

/** Uploads every texture, then every GLB, from a built project. */
export async function uploadBuild({ outDir, key, creator, ledgerPath, onProgress = () => {} }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) : { images: {}, models: {}, imageType: 'Image' };
  const save = () => fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 1));
  const map = safeName(manifest.map);

  const texJobs = Object.entries(manifest.textures).filter(([h]) => !ledger.images[h]);
  const glbJobs = manifest.files.filter(f => !ledger.models[f.sha]);
  const total = texJobs.length + glbJobs.length;
  let done = 0;
  const problems = [];
  const report = stage => onProgress({ stage, done, total });
  report('Uploading');

  const finish = (rec, result) => {
    const state = result.response?.moderationResult?.moderationState;
    rec.moderation = state ?? 'Unknown';
    if (state === 'Rejected') problems.push(`${rec.label} rejected by Roblox moderation`);
  };

  await pool(texJobs, 4, async ([hash, file]) => {
    const fp = path.join(outDir, 'tex', file);
    const label = `texture ${hash}`;
    try {
      let op;
      try {
        op = await createAsset({ key, creator, file: fp, name: `${map} tex ${hash.slice(0, 8)}`, assetType: ledger.imageType, contentType: 'image/png' });
      } catch (e) {
        // Keys and accounts differ on whether Image is accepted. Decal always is.
        if (ledger.imageType === 'Image' && /\b400\b/.test(e.message)) {
          ledger.imageType = 'Decal';
          op = await createAsset({ key, creator, file: fp, name: `${map} tex ${hash.slice(0, 8)}`, assetType: 'Decal', contentType: 'image/png' });
        } else throw e;
      }
      const r = await waitOperation(key, op);
      const assetId = r.response?.assetId;
      if (!assetId) throw new Error(r.error?.message ?? 'no asset id returned');
      const rec = { id: assetId, label, type: ledger.imageType };
      finish(rec, r);
      ledger.images[hash] = rec;
      save();
    } catch (e) { problems.push(`${label}: ${e.message}`); }
    done++;
    report('Uploading textures');
  });

  await pool(glbJobs, 2, async f => {
    const label = f.file;
    try {
      const op = await createAsset({
        key, creator, file: path.join(outDir, 'glb', f.file), name: `${map} ${f.file.replace('.glb', '')}`,
        assetType: 'Model', contentType: 'model/gltf-binary',
      });
      const r = await waitOperation(key, op);
      const assetId = r.response?.assetId;
      if (!assetId) throw new Error(r.error?.message ?? 'no asset id returned');
      const rec = { id: assetId, label };
      finish(rec, r);
      ledger.models[f.sha] = rec;
      save();
    } catch (e) { problems.push(`${label}: ${e.message}`); }
    done++;
    report('Uploading geometry');
  });

  const ok = !problems.length;
  return { ok, problems, textures: Object.keys(ledger.images).length, models: Object.keys(ledger.models).length };
}
