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
