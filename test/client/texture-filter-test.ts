// texture-filter — texture filtering at grazing angles (anisotropy) is the VIEWER's quality dial, never the world's look:
// pref ew-anisotropy 1/2/4/8/16, default 4 (Godot's rendering/textures/default_filters/anisotropic_filtering_level; Unity's
// Anisotropic Textures quality setting), clamped to what the renderer reports it can do (three's getMaxAnisotropy), and
// set on a model's textures BEFORE their upload, since the sampler is built from it then (both of three's backends read
// texture.anisotropy when a texture's version changes: WebGPUTextureUtils.updateSampler, WebGLTextureUtils.setTextureParameters).
//
// Runs the REAL client/lib/assets.js loadGLB: a glTF with two textures (base colour + normal) parsed by three's GLTFLoader
// and primed through primeTextures. Below it, test/stubs/texture-filter-stub.mjs: lod-loader-stub's renderer that never
// draws, with getMaxAnisotropy the suite sets and an initTexture that records each texture's anisotropy at the upload.
// Above it, a fetch shim that answers every /library/ URL with that glTF and /version with 404 (no KTX2 key, no recipe).
// The rows that turn red, and the line of the product that turns them:
//   · primeTextures without the assignment (assets.js)           → A1, A3
//   · the default not 4 (render/anisotropy.js)                    → A1, A2
//   · a junk pref accepted                                       → A2
//   · no clamp to getMaxAnisotropy                               → A4
//   · queueTexturePrime without the assignment (assets.js)      → I1, I2, I3
//   · queueTexturePrime writing the renderer's 0 (no floor at 1) → I5
//   · loadImageTexture ignoring a caller's { anisotropy }        → C1, C2, C4, C5, V1, V2, V3
//   · a stated level not clamped / not floored at 1             → C2, C2b
//   · the cache not keyed on the stated level                   → C5
//   · vegetation.js not stating its level (writing it after the load) → V1, V2, V3 (the upload says the dial)
//   · setAnisotropy writing a value not in the list              → M2
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/texture-filter-test.ts
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
import { stubResolve } from '../harness/stub.ts';
import { suite } from '../gate/suite.ts';

const S = suite('texture-filter');
const check = (name: string, ok: unknown, detail?: unknown) => S.check(name, ok, detail);

// ---- the page's surfaces Bun has no copy of: storage, image decode, ProgressEvent (below the seam, like the renderer)
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
};
(globalThis as any).createImageBitmap = async () => ({ width: 4, height: 4, close() {} });
if (!(globalThis as any).ProgressEvent) {
  (globalThis as any).ProgressEvent = class ProgressEvent extends Event {
    lengthComputable: boolean; loaded: number; total: number;
    constructor(type: string, init: any = {}) { super(type); this.lengthComputable = !!init.lengthComputable; this.loaded = init.loaded ?? 0; this.total = init.total ?? 0; }
  };
}

// ---- a glTF with one triangle and one material carrying two textures, each its own image in the BIN chunk
function glb(): ArrayBuffer {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const uv = new Float32Array([0, 0, 1, 0, 0, 1]);
  const img = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);   // the bytes never decode: createImageBitmap is shimmed
  const parts = [new Uint8Array(pos.buffer), new Uint8Array(uv.buffer), img, img];
  const views: any[] = []; let off = 0;
  for (const p of parts) { views.push({ buffer: 0, byteOffset: off, byteLength: p.byteLength }); off += (p.byteLength + 3) & ~3; }
  const bin = new Uint8Array(off); off = 0;
  for (const p of parts) { bin.set(p, off); off += (p.byteLength + 3) & ~3; }
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 } }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],   // LINEAR / LINEAR_MIPMAP_LINEAR: where anisotropy applies
    images: [{ bufferView: 2, mimeType: 'image/png', name: 'albedo' }, { bufferView: 3, mimeType: 'image/png', name: 'normal' }],
    textures: [{ sampler: 0, source: 0, name: 'albedo' }, { sampler: 0, source: 1, name: 'normal' }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
    ],
    bufferViews: views, buffers: [{ byteLength: bin.byteLength }],
  };
  let js = new TextEncoder().encode(JSON.stringify(json));
  const jsPad = (js.byteLength + 3) & ~3;
  const out = new Uint8Array(12 + 8 + jsPad + 8 + bin.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.byteLength, true);
  dv.setUint32(12, jsPad, true); dv.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsPad); out.set(js, 20);
  dv.setUint32(20 + jsPad, bin.byteLength, true); dv.setUint32(24 + jsPad, 0x004e4942, true);
  out.set(bin, 28 + jsPad);
  return out.buffer;
}

// ---- the network seam: /version absent, every library URL the glTF; blob: and data: (three's image path) pass through
const realFetch = globalThis.fetch;
const RealRequest = globalThis.Request;
globalThis.Request = class extends RealRequest { constructor(input: any, init?: any) { super(typeof input === 'string' && input.startsWith('/') ? 'http://page.invalid' + input : input, init); } } as any;
globalThis.fetch = (async (input: any, init?: any) => {
  const url: string = typeof input === 'string' ? input : input.url;
  if (/^(blob|data):/.test(url)) return realFetch(input, init);
  if (url.includes('/library/')) return new Response(glb(), { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
  return new Response('', { status: 404 });
}) as any;

const STUB = fileURLToPath(new URL('../stubs/texture-filter-stub.mjs', import.meta.url));
plugin({ name: 'texture-filter-stub', setup(b) {
  for (const f of ['^\\./core\\.js$', '^(\\.\\.?/)+(render/)?loadwork\\.js$', '^(\\.\\.?/)+(render/)?warmqueue\\.js$', '^(\\.\\.?/)+(render/)?materials\\.js$', '^(\\.\\.?/)+(render/)?draw_batches\\.js$'])
    stubResolve(b, new RegExp(f), () => ({ path: STUB }));
  stubResolve(b, /^\.\.\/(core|render\/warmqueue)\.js$/, (a) => (/\/vegetation\/foliage\.js$/.test(a.importer.replace(/\\/g, '/')) ? { path: STUB } : undefined));
} });

const stub: any = await import('../stubs/texture-filter-stub.mjs');
const A: any = await import('../../client/lib/assets.js');
await A.negotiationReady;

// one fresh model per call (a new library path: the proto cache keys on it), the pref and the GPU's maximum as given
let n = 0;
async function load(pref: string | null, max = 16) {
  if (pref === null) localStorage.removeItem('ew-anisotropy'); else localStorage.setItem('ew-anisotropy', pref);
  stub.gpu.maxAnisotropy = max;
  const from = stub.uploads.length;
  let obj: any = null, error = '';
  try { obj = await A.loadGLB(`aniso/m${n++}.glb`); } catch (e: any) { error = String(e?.stack ?? e).split('\n')[0]; }
  const up = stub.uploads.slice(from);
  const maps: any[] = [];
  obj?.traverse((o: any) => { if (o.material) for (const k of ['map', 'normalMap']) if (o.material[k]) maps.push(o.material[k]); });
  return { up, levels: up.map((u: any) => u.anisotropy), now: maps.map((t) => t.anisotropy), error };
}
const all = (r: any, v: number) => r.up.length === 2 && r.levels.every((x: number) => x === v) && r.now.length === 2 && r.now.every((x: number) => x === v);

console.log('BASE — the glTF parses through the real loader and both textures go through primeTextures');
{ const r = await load(null);
  check('B1 the model loads with its two textures, each uploaded once', !r.error && r.up.length === 2 && r.now.length === 2, r); }

console.log('DEFAULT — 4 when the pref is absent or junk');
{ const r = await load(null);
  check('A1 no ew-anisotropy: both textures upload at 4', all(r, 4), r);
  for (const junk of ['3', '0', '32', 'abc', '', '4.5', '-4']) {
    const j = await load(junk);
    check(`A2 ew-anisotropy=${JSON.stringify(junk)} is not a level: 4`, all(j, 4), j);
  } }

console.log('LEVELS — each level the viewer can choose reaches the model\'s textures, set before the upload');
for (const v of [1, 2, 4, 8, 16]) {
  const r = await load(String(v));
  check(`A3 ew-anisotropy=${v}: both textures upload at ${v}`, all(r, v), r);
}

console.log('CLAMP — never above what the renderer says it can do');
{ const r = await load('16', 8);
  check('A4 16 on a GPU that reports 8: the textures upload at 8', all(r, 8), r);
  const q = await load('4', 2);
  check('A4b 4 on a GPU that reports 2: 2', all(q, 2), q);
  const z = await load('8', 0);
  check('A4c a WebGL context without EXT_texture_filter_anisotropic reports 0: the textures keep three\'s 1', all(z, 1), z);
  const u = await load('8', 16);
  check('A4d 8 on a GPU that reports 16: 8 (the maximum is a ceiling, not a level)', all(u, 8), u); }

// The other door: an image that is not inside a model. A `material` component's texture and a hung picture arrive through
// globalThis.loadImageTexture (realize/pictures.js imageTexture; assets.js queueTexturePrime uploads them), never through
// primeTextures. That is the dial's own headline case, the floor ahead of you: a `mesh` plane wearing a texture.
console.log('IMAGE — a texture loaded as an image (a material component\'s, a picture\'s) uploads at the viewer\'s level too');
async function image(pref: string | null, max = 16) {
  if (pref === null) localStorage.removeItem('ew-anisotropy'); else localStorage.setItem('ew-anisotropy', pref);
  stub.gpu.maxAnisotropy = max;
  const from = stub.uploads.length;
  let tex: any = null, error = '';
  try { tex = await (globalThis as any).loadImageTexture(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n++ & 255]), { srgb: true, flipY: false }); } catch (e: any) { error = String(e?.stack ?? e).split('\n')[0]; }
  for (let i = 0; i < 4; i++) await Promise.resolve();   // the prime queue's pump starts on a microtask
  const up = stub.uploads.slice(from);
  return { at: up.map((u: any) => u.anisotropy), now: tex?.anisotropy, uploads: up.length, error };
}
{ const r = await image(null);
  check('I0 (setup) the image loads and is uploaded once', !r.error && r.uploads === 1, r);
  check('I1 no ew-anisotropy: it uploads at 4', r.at[0] === 4 && r.now === 4, r);
  const s = await image('16');
  check('I2 ew-anisotropy=16: it uploads at 16', s.at[0] === 16 && s.now === 16, s);
  const c = await image('16', 8);
  check('I3 16 on a GPU that reports 8: 8', c.at[0] === 8 && c.now === 8, c);
  const one = await image('1');
  check('I4 (control) ew-anisotropy=1: three\'s 1, as before', one.at[0] === 1 && one.now === 1, one);
  // a WebGL 2 context without EXT_texture_filter_anisotropic reports 0: the door must not write that 0 (A4c's twin)
  const z = await image('8', 0);
  check('I5 the image door on a renderer that reports 0 (no EXT_texture_filter_anisotropic): it stays three\'s 1', z.at[0] === 1 && z.now === 1, z); }

// A caller that knows what its texture is states the level itself (loadImageTexture(bytes, { anisotropy })): vegetation's
// atlases (4, and 1 for the fast-shade albedo), a particle sprite or a data mask (1). The door applies it before the upload
// in place of the dial, clamped as the dial is. A caller writing tex.anisotropy AFTER the load cannot do this: on WebGL 2
// the sampler's parameters are set at the upload, which happens inside loadImageTexture (C0), so the write is lost there,
// and on WebGPU the sampler is built at first bind, so the same write wins there: the two backends disagree.
console.log('CALLER — a caller\'s own level is what uploads, in place of the dial');
async function stated(level: unknown, pref = '16', max = 16) {
  localStorage.setItem('ew-anisotropy', pref); stub.gpu.maxAnisotropy = max;
  const from = stub.uploads.length;
  const tex: any = await (globalThis as any).loadImageTexture(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xc0, n++ & 255]), { srgb: true, anisotropy: level });
  const before = stub.uploads.slice(from).filter((u: any) => u.tex === tex).length;   // uploads done before the promise resolved
  for (let i = 0; i < 4; i++) await Promise.resolve();
  const up = stub.uploads.slice(from).filter((u: any) => u.tex === tex);
  return { at: up.map((u: any) => u.anisotropy), now: tex.anisotropy, before, uploads: up.length };
}
{ const a = await stated(4);
  check('C0 (order) the image is uploaded before loadImageTexture resolves: a caller\'s write after it is post-upload', a.before === 1 && a.uploads === 1, a);
  check('C1 dial 16, the caller states 4: it uploads at 4', a.at[0] === 4 && a.now === 4, a);
  const b = await stated(1);
  check('C1b dial 16, the caller states 1: it uploads at 1', b.at[0] === 1 && b.now === 1, b);
  const c = await stated(16, '1');
  check('C1c dial 1, the caller states 16: 16 (the caller\'s level stands in place of the dial)', c.at[0] === 16 && c.now === 16, c);
  const d = await stated(16, '4', 8);
  check('C2 the caller states 16 on a renderer that reports 8: 8', d.at[0] === 8 && d.now === 8, d);
  const e = await stated(4, '4', 0);
  check('C2b the caller states 4 on a renderer that reports 0: three\'s 1', e.at[0] === 1 && e.now === 1, e);
  for (const junk of [0, -2, NaN, Infinity, '4', null]) {
    const j = await stated(junk, '8');
    check(`C3 a stated level that is not a finite number >= 1 (${typeof junk === 'string' ? JSON.stringify(junk) : String(junk)}): the dial's 8`, j.at[0] === 8 && j.now === 8, j);
  } }
{ // the other order: several images landing together, the first far over a frame's byte budget, so the prime queue's
  // frame wait is the only thing that could hold the rest. Each still uploads before its own promise resolves, at its
  // own level: the queue drains as each image is pushed, so today no image waits a frame (and the level is set before
  // the push, so a wait could not change it)
  localStorage.setItem('ew-anisotropy', '16'); stub.gpu.maxAnisotropy = 16;
  const realBitmap = (globalThis as any).createImageBitmap;
  let first = true;
  (globalThis as any).createImageBitmap = async () => (first ? (first = false, { width: 4096, height: 4096, close() {} }) : { width: 4, height: 4, close() {} });
  const from = stub.uploads.length;
  const order: string[] = [];
  const one = (lvl: number | undefined, tag: string) => (globalThis as any).loadImageTexture(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xc2, n++ & 255]), lvl === undefined ? {} : { anisotropy: lvl })
    .then((t: any) => { order.push(`${tag}:${stub.uploads.slice(from).some((u: any) => u.tex === t) ? 'up' : 'waiting'}`); return t; });
  const [big, s1, s4] = await Promise.all([one(undefined, 'big'), one(1, 'one'), one(4, 'four')]);
  (globalThis as any).createImageBitmap = realBitmap;
  for (let i = 0; i < 4; i++) await Promise.resolve();
  const lv = (t: any) => stub.uploads.slice(from).filter((u: any) => u.tex === t).map((u: any) => u.anisotropy);
  check('C4 three images at once, the first a 4096² far over the frame budget: each uploaded before it resolved, at its own level (16, 1, 4)',
    order.every((o) => o.endsWith(':up')) && lv(big).join() === '16' && lv(s1).join() === '1' && lv(s4).join() === '4', { order, big: lv(big), one: lv(s1), four: lv(s4)}); }
{ // the cache: the same bytes object asked for at two levels is two textures, each at its own (one shared texture
  // cannot be both, and the second ask would get the first's sampler); the same level again is the cached one
  localStorage.setItem('ew-anisotropy', '16'); stub.gpu.maxAnisotropy = 16;
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xc1, n++ & 255]);
  const L = (globalThis as any).loadImageTexture;
  const t1 = await L(bytes, { srgb: true, anisotropy: 1 }), t4 = await L(bytes, { srgb: true, anisotropy: 4 });
  const again = await L(bytes, { srgb: true, anisotropy: 1 }), dial = await L(bytes, { srgb: true });
  check('C5 the cache keys on a stated level: 1 and 4 are two textures at 1 and 4, 1 again is the first, the dial\'s is its own at 16',
    t1 !== t4 && again === t1 && dial !== t1 && dial !== t4 && t1.anisotropy === 1 && t4.anisotropy === 4 && dial.anisotropy === 16,
    { same14: t1 === t4, again: again === t1, levels: [t1.anisotropy, t4.anisotropy, dial.anisotropy] }); }

// The grass: the REAL client/lib/vegetation/vegetation.js createFlora, its atlases read through a Deno.readFile shim and
// loaded through the real door above. It states its own level: 4, and 1 for the albedo when the field is fast-shaded
// (flora.js passes fastShade at build, before any map loads, so the level is known before the upload on both backends).
console.log('VEGETATION — the grass atlases upload at vegetation\'s own level (4; the fast-shade albedo 1), never the dial');
const VEG: any = await (async () => {
  const W: any = await import('../../client/node_modules/three/build/three.webgpu.js');
  const TSL: any = await import('../../client/node_modules/three/build/three.tsl.js');
  const prev = (globalThis as any).THREE;
  (globalThis as any).THREE = { ...W, ...TSL };   // vegetation.js reads THREE (node build + TSL) at module scope, as the page gives it
  try { return await import('../../client/lib/vegetation/vegetation.js'); } finally { (globalThis as any).THREE = prev; }
})();
const GRASS = JSON.parse(await Bun.file(fileURLToPath(new URL('../../defs/flora/grass.json', import.meta.url))).text());
async function flora(fastShade: boolean, pref = '16') {
  localStorage.setItem('ew-anisotropy', pref); stub.gpu.maxAnisotropy = 16;
  const g: any = globalThis, D = g.Deno;
  const saved = { readFile: D.readFile, readTextFile: D.readTextFile, fetch: g.fetch, door: g.loadImageTexture };
  const pathOf = new WeakMap<object, string>();
  const maps = new Map<string, any>();   // albedo / normal / roughness / translucency -> the texture the door returned
  D.readFile = async (p: string) => { const b = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xd0, n++ & 255]); pathOf.set(b, p); return b; };
  D.readTextFile = async () => { throw new Error('no fit data in this suite'); };
  g.fetch = async (u: any, i?: any) => (String(typeof u === 'string' ? u : u.url).endsWith('/defs') ? new Response(JSON.stringify({ flora: { grass: GRASS } })) : saved.fetch(u, i));
  g.loadImageTexture = async (bytes: any, opts: any) => { const t = await saved.door(bytes, opts); maps.set(String(pathOf.get(bytes)).split('_').pop()!.replace('.png', ''), t); return t; };
  const from = stub.uploads.length;
  let error = '';
  try { await VEG.createFlora({ species: 'grass', width: 2, depth: 2, fastShade }); } catch (e: any) { error = String(e?.stack ?? e).split('\n')[0]; }
  finally { Object.assign(D, { readFile: saved.readFile, readTextFile: saved.readTextFile }); g.fetch = saved.fetch; g.loadImageTexture = saved.door; }
  const up = stub.uploads.slice(from);
  const out: Record<string, { at: number[]; now: number }> = {};
  for (const [name, t] of maps) out[name] = { at: up.filter((u: any) => u.tex === t).map((u: any) => u.anisotropy), now: t.anisotropy };
  return { out, error };
}
const at = (r: any, name: string, v: number) => r.out[name]?.at.length === 1 && r.out[name].at[0] === v && r.out[name].now === v;
{ const r = await flora(false);
  check('V0 (setup) createFlora builds a grass field and loads its four atlases through the door', !r.error && ['albedo', 'normal', 'roughness', 'translucency'].every((k) => r.out[k]), r);
  check('V1 dial 16, full shade: all four atlases upload at 4 and still say 4 after the build (upload and texture agree)', ['albedo', 'normal', 'roughness', 'translucency'].every((k) => at(r, k, 4)), r.out);
  const f = await flora(true);
  check('V2 dial 16, fast shade: the albedo uploads at 1 and still says 1; the other three at 4', at(f, 'albedo', 1) && ['normal', 'roughness', 'translucency'].every((k) => at(f, k, 4)), f.out);
  const low = await flora(false, '1');
  check('V3 dial 1, full shade: vegetation\'s own 4 (its level stands in place of the dial)', ['albedo', 'normal', 'roughness', 'translucency'].every((k) => at(low, k, 4)), low.out); }

console.log('MODULE — render/anisotropy.js: the levels, the getter and the setter the Settings rows call');
{ let M: any = null, why = '';
  try { M = await import('../../client/lib/render/anisotropy.js'); } catch (e: any) { why = String(e?.message ?? e).split('\n')[0]; }
  check('M1 ANISO_LEVELS is 1, 2, 4, 8, 16', M?.ANISO_LEVELS?.join(',') === '1,2,4,8,16', why || M?.ANISO_LEVELS);
  localStorage.removeItem('ew-anisotropy');
  check('M1b anisotropy() is 4 with nothing stored', M?.anisotropy?.() === 4, M?.anisotropy?.());
  M?.setAnisotropy?.(8);
  check('M2 setAnisotropy(8) stores "8" and anisotropy() reads it back', localStorage.getItem('ew-anisotropy') === '8' && M?.anisotropy?.() === 8, localStorage.getItem('ew-anisotropy'));
  for (const bad of [3, 0, 32, 'x', NaN]) {
    M?.setAnisotropy?.(bad);
    check(`M2b setAnisotropy(${String(bad)}) is refused: still "8"`, !!M && localStorage.getItem('ew-anisotropy') === '8', localStorage.getItem('ew-anisotropy'));
  }
  M?.setAnisotropy?.('2');
  check('M2c a level as a string (a select\'s value) is taken: "2"', localStorage.getItem('ew-anisotropy') === '2', localStorage.getItem('ew-anisotropy'));
  const realLS = (globalThis as any).localStorage;
  (globalThis as any).localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  let threw = false, got: unknown;
  try { got = M?.anisotropy?.(); M?.setAnisotropy?.(8); } catch { threw = true; }
  (globalThis as any).localStorage = realLS;
  check('M3 storage that throws (site data blocked): 4, and the setter does not throw', !!M && !threw && got === 4, { threw, got }); }

S.done();
