// KeyValues + VMT handling.

export function parseKeyValues(text) {
  let i = 0;
  const n = text.length;
  const ws = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text[i] === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
      if (text[i] === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i); i = e < 0 ? n : e + 2; continue; }
      return;
    }
  };
  const tok = () => {
    ws();
    if (i >= n) return null;
    const c = text[i];
    if (c === '{' || c === '}') { i++; return c; }
    if (c === '"') {
      i++;
      let s = '';
      while (i < n && text[i] !== '"') {
        // Backslashes are path separators in VMTs. Only \" is an escape here.
        if (text[i] === '\\' && text[i + 1] === '"') { s += '"'; i += 2; continue; }
        s += text[i++];
      }
      i++;
      return { s };
    }
    let s = '';
    while (i < n && !/[\s{}"]/.test(text[i])) s += text[i++];
    return { s };
  };
  const block = () => {
    const o = {};
    for (;;) {
      const k = tok();
      if (k === null || k === '}') return o;
      if (k === '{') { block(); continue; }
      const v = tok();
      if (v === null) return o;
      const key = k.s.toLowerCase();
      if (v === '{') {
        const child = block();
        if (!(key in o)) o[key] = child;
      } else if (v === '}') return o;
      else if (!(key in o)) o[key] = v.s;
    }
  };
  const root = {};
  for (;;) {
    const k = tok();
    if (k === null) break;
    if (k === '{' || k === '}') continue;
    const v = tok();
    if (v === null) break;
    if (v === '{') root[k.s.toLowerCase()] = block();
    else root[k.s.toLowerCase()] = v.s;
  }
  return root;
}

const truthy = v => v !== undefined && v !== '0' && v !== 0 && v !== 'false';

function parseColor(v) {
  if (typeof v !== 'string') return null;
  const nums = v.replace(/[[\]{}]/g, ' ').trim().split(/\s+/).map(Number);
  if (nums.length < 3 || nums.some(Number.isNaN)) return null;
  // {r g b} is 0-255, [r g b] is 0-1
  return v.includes('{') ? nums.slice(0, 3).map(x => x / 255) : nums.slice(0, 3);
}

const texPath = v => {
  if (typeof v !== 'string' || !v) return null;
  return v.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.vtf$/i, '').toLowerCase();
};

export function normMat(name) {
  return String(name).replace(/\\/g, '/').replace(/^\/+/, '').replace(/^materials\//i, '').replace(/\.vmt$/i, '').toLowerCase();
}

/** Resolve a material through `patch` VMTs (cubemap-patched BSP materials). */
export function loadMaterial(vfs, name, depth = 0) {
  const id = normMat(name);
  const buf = vfs.read(`materials/${id}.vmt`);
  if (!buf) return null;
  const kv = parseKeyValues(buf.toString('latin1'));
  const shader = Object.keys(kv)[0];
  if (!shader) return null;
  let body = kv[shader];
  if (typeof body !== 'object') return null;

  let shaderName = shader;
  if (shader === 'patch' && depth < 4) {
    const inc = typeof body.include === 'string' ? body.include : null;
    if (inc) {
      const base = loadMaterial(vfs, inc, depth + 1);
      if (base) {
        body = { ...base.params, ...(body.insert ?? {}), ...(body.replace ?? {}) };
        shaderName = base.shader;
      }
    }
  }
  return { id, shader: shaderName, params: body, raw: buf.toString('latin1') };
}

const TOOL_RE = /^tools\/|^tools$/;

export function describeMaterial(mat, nameIfMissing) {
  const id = mat?.id ?? normMat(nameIfMissing);
  const p = mat?.params ?? {};
  const shader = mat?.shader ?? '';
  const isWater = shader === 'water' || truthy(p['%compilewater']) || /^(liquids?|water|nature\/water)/.test(id) && /water/.test(id);
  const isTool = TOOL_RE.test(id) || truthy(p['%compilenodraw']) || truthy(p['%compileclip']) || truthy(p['%compilesky']) || truthy(p['%compile2dsky']) || truthy(p['%compileskip']) || truthy(p['%compilehint']) || truthy(p['%compiletrigger']);
  const isSky = truthy(p['%compilesky']) || truthy(p['%compile2dsky']) || /tools\/toolsskybox/.test(id);
  return {
    id,
    missing: !mat,
    shader,
    isWater,
    isTool,
    isSky,
    base: texPath(p.$basetexture) ?? texPath(p.$hdrbasetexture) ?? texPath(p.$iris),
    base2: texPath(p.$basetexture2),
    bump: texPath(p.$bumpmap) ?? texPath(p.$normalmap),
    translucent: truthy(p.$translucent) || truthy(p.$additive) && shader !== 'modulate',
    additive: truthy(p.$additive),
    alphatest: truthy(p.$alphatest),
    nocull: truthy(p.$nocull) || truthy(p.$decal) && false,
    decal: truthy(p.$decal),
    selfillum: truthy(p.$selfillum),
    phong: truthy(p.$phong),
    alpha: p.$alpha !== undefined ? Number(p.$alpha) : 1,
    color: parseColor(p.$color) ?? parseColor(p.$color2),
    keywords: typeof p['%keywords'] === 'string' ? p['%keywords'] : '',
    surfaceprop: typeof p.$surfaceprop === 'string' ? p.$surfaceprop.toLowerCase() : '',
    unlit: /^unlit/.test(shader) || shader === 'sky',
    decalscale: p.$decalscale !== undefined ? Number(p.$decalscale) : 1,
  };
}
