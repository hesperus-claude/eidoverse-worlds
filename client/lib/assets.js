// assets — every byte the client pulls, and the host shims that let the
// toolkit modules run unmodified in a browser.
//
// Four caches, all keyed by library path and all "download+parse once":
//   byteCache  raw bytes (with progress reporting into the loading tray)
//   glbCache   parsed GLB prototypes — every use gets a skeleton clone
//   vrmaCache  animation bytes, retargeted per-VRM at use
//   vrmPool    whole parsed VRM instances at rest (§19b — no clone exists
//              for a bound rig, so released bodies are reworn intact)

import { keyFromVersion, negotiate, lodFromVersion } from '../../shared/ktx2.js';
import { tierOf, askFor } from './lod_policy.js';
import { awaitBodyGate, bodyGateArmed, bodyGateOpen } from './bodygate.js';
// ?bodyfirst=0 — the escape hatch (same convention as ?batching=0): world parses
// no longer wait for the body; for A/B measurement and for a body-less test
const BODY_FIRST = new URLSearchParams(globalThis.location?.search ?? '').get('bodyfirst') !== '0';   // globalThis: node-side suites import this without a window
import { THREE, renderer, camera, scene } from './core.js';
import { report, bus } from './base.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { MToonMaterialLoaderPlugin } from '@pixiv/three-vrm-materials-mtoon';
import { MToonNodeMaterial } from '@pixiv/three-vrm-materials-mtoon/nodes';
import { parsePoseAnimation, retargetPoseAnimation } from './poseclips.js';
import { CLIP_SLOTS, CLIP_FILES, CLIP_SPEED } from '../../shared/clipdefs.js';
export { CLIP_SLOTS, CLIP_FILES, CLIP_SPEED } from '../../shared/clipdefs.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { beginWork, enqueue, nextFrame, loadNote } from './loadwork.js';
import { warm } from './warmqueue.js';
import { prepareObject } from './materials.js';
import { registerFoliage } from './foliage.js';
import { markDrawBatchSource } from './draw_batches.js';
import { libRelOf, modelWord } from '../../shared/eido.js';

// ---- loading tray -----------------------------------------------------------
// Every in-flight asset is listed (downloads with bytes, builds as spinners); ui.js renders it, this owns the data.

const loads = new Map(); // key -> { label, done, total }
// Cumulative byte counters for the boot progress bar. Per-asset entries vanish
// when they finish, so a bar built from `loads` alone would leap backwards
// every time a download completed.
const bytes = { done: 0, total: 0 };
export const bootBytes = () => ({ ...bytes });
export const loadingItems = () => [...loads.values()];
function announce() { bus.emit('loading', loadingItems()); }
export function loadTrack(key, label) { loads.set(key, { label, done: 0, total: 0 }); announce(); }
export function loadProgress(key, done, total) {
  const l = loads.get(key);
  if (!l) return;
  if (total && !l.total) bytes.total += total;       // count each asset once
  bytes.done += Math.max(0, done - l.done);
  l.done = done; l.total = total;
  announce();
}
export function loadDone(key) { loads.delete(key); announce(); }

// ---- demand activity ----------------------------------------------------------
// The prefetcher (prefetch.js) must never cost a real load: each demand fetch emits 'demand', which aborts its
// stream, and demandState() keeps it parked until the network has been quiet a while.

let demandActive = 0;
let lastDemandAt = 0;
export const demandState = () => ({ active: demandActive, last: lastDemandAt });
function demandStart() { demandActive++; lastDemandAt = performance.now(); bus.emit('demand'); }
function demandEnd() { demandActive = Math.max(0, demandActive - 1); lastDemandAt = performance.now(); }

// ---- raw bytes --------------------------------------------------------------

const byteCache = new Map();
export function forgetBytes(match) {
  for (const key of [...byteCache.keys()]) {
    if (!key.includes(match)) continue;
    byteCache.delete(key);
    const s = byteSizes.get(key);   // the ledger forgets too, or byteTotal
    if (s !== undefined) { byteTotal -= s; byteSizes.delete(key); }   // drifts forever (review S1)
  }
}

// ---- the byte tier's budget (§13.3 R3) --------------------------------------
// An LRU byte budget on byteCache (JS heap only); Map order IS the LRU (touch re-inserts). The HTTP cache keeps
// the wire bytes, so a re-fetch after eviction is a disk read, which prefetch relies on.
const BYTE_BUDGET = 128 * 1024 * 1024;
const byteSizes = new Map();   // path -> resolved byteLength, insertion = LRU
let byteTotal = 0;
function touchBytes(path) {
  const size = byteSizes.get(path);
  if (size === undefined) return;
  byteSizes.delete(path);
  byteSizes.set(path, size);
}
function noteBytes(path, len) {
  const prev = byteSizes.get(path);
  if (prev !== undefined) { byteTotal -= prev; byteSizes.delete(path); }   // re-fetch: replace, never double-count
  byteSizes.set(path, len);
  byteTotal += len;
  while (byteTotal > BYTE_BUDGET && byteSizes.size > 1) {
    const oldest = byteSizes.keys().next().value;
    if (oldest === path) break;         // never evict what just landed
    byteTotal -= byteSizes.get(oldest) ?? 0;
    byteSizes.delete(oldest);
    byteCache.delete(oldest);
  }
}

export async function fetchBytes(path) {
  if (byteCache.has(path)) { touchBytes(path); return byteCache.get(path); }
  if (!byteCache.has(path)) {
    byteCache.set(path, (async () => {
      loadTrack(path, path.split('/').pop().split('?')[0]);
      demandStart();
      try {
        // Retry 5xx and network failures (3 tries, 0.7 s then 1.8 s); evict on final failure, or a rejected fetch
        // in byteCache poisons every later ask for that path.
        let r;
        for (let attempt = 0; ; attempt++) {
          try { r = await fetch(path); } catch (err) { if (attempt >= 2) throw err; r = null; }
          if (r && (r.ok || r.status < 500 || attempt >= 2)) break;
          await new Promise((res) => setTimeout(res, attempt === 0 ? 700 : 1800));
        }
        if (!r.ok) throw new Error(`fetch ${path}: ${r.status}`);
        const total = Number(r.headers.get('content-length') ?? 0);
        if (r.body && total > 200_000) { // stream big bodies for byte progress
          const reader = r.body.getReader();
          const chunks = [];
          let got = 0;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            chunks.push(value);
            got += value.length;
            lastDemandAt = performance.now(); // long downloads keep prefetch parked
            loadProgress(path, got, total);
          }
          const buf = new Uint8Array(got);
          let o = 0;
          for (const c of chunks) { buf.set(c, o); o += c.length; }
          noteBytes(path, buf.byteLength);
          return buf.buffer;
        }
        const ab = await r.arrayBuffer();
        noteBytes(path, ab.byteLength);
        return ab;
      } catch (err) { byteCache.delete(path); throw err; }
      finally { loadDone(path); demandEnd(); }
    })());
  }
  return byteCache.get(path);
}

// ---- loaders ----------------------------------------------------------------

// the decoder three ships, served by the /node_modules route like the KTX2 transcoder below: no third-party origin at run
// time (the page's CSP connect-src names none for it; security pass 3 N3)
const draco = new DRACOLoader().setDecoderPath('/node_modules/three/examples/jsm/libs/draco/gltf/');
// §20b: ONE KTX2 transcoder (vendored basis wasm via /node_modules) for every parse site. detectSupport at module
// scope is safe: core.js top-level-awaits renderer.init() before this module evaluates.
const ktx2 = new KTX2Loader()
  .setTranscoderPath('/node_modules/three/examples/jsm/libs/basis/')
  .detectSupport(renderer);
/** Whether this GPU/browser negotiates KTX2 variants (?ktx2=<key>, shared/ktx2.js) — prefetch
 *  must warm the SAME cache key demand fetches will use. */
export const ktx2Capable = () => !!ktx2.workerConfig;
// The negotiation key comes from the RUNNING server (/version, no-store), never from shared/ktx2.js it serves:
// between pull and restart those differ and a cache pins the wrong answer. No key = no negotiation. One fetch/page.
const versionReady = fetch('/version', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : null)).catch(() => null);
export const ktx2KeyReady = versionReady.then(keyFromVersion);
/** The geometry-LOD recipe the running sequencer bakes (#156, lodFromVersion)
 *  — or null: no tier is ever asked for that the running process did not
 *  declare, the same split-brain gate as the key. */
export const lodRecipeReady = versionReady.then(lodFromVersion);
// the resolved answers, for SYNCHRONOUS policy reads (the residency sweep
// runs at 2Hz and cannot await): null until /version answers, null forever
// when it published nothing
let ktx2Key = null, lodRecipe = null;
ktx2KeyReady.then((k) => { ktx2Key = k; }).catch(() => {});
lodRecipeReady.then((r) => { lodRecipe = r; }).catch(() => {});
/** Settles once /version has answered (or failed) — a tier choice made
 *  after this knows whether a lod ask can cross the wire. Never rejects. */
export const negotiationReady = Promise.all([ktx2KeyReady, lodRecipeReady]).then(() => {}, () => {});
/** Can a lod ask for this lib cross the wire now (#170)? It rides KTX2 negotiation: transcoder support, a running
 *  key AND recipe, a bare .glb path. "No" means no recipe: nothing is asked, or reported asked, that couldn't be. */
export const lodNegotiable = (libPath) => resolveLoadRequest(libPath, 'lod').tier === 'lod';
/** THE decision seam of a tiered load (#170): tier wish -> URL, asked tier (askFor over live state) and cache key.
 *  Exported so tools/lod-loader-probe.ts gates the real seam, not a restatement. */
export function resolveLoadRequest(libPath, tier = 'full') {
  // a model named by its content address (eido:sha256/…, review 10-07 H3) is fetched as /library/eido/sha256/<hex>.glb:
  // the host serves its rendition of the file it names; the cache keys stay the model value itself
  const ask = askFor({ libPath: libRelOf(libPath), key: ktx2Key, capable: !!ktx2.workerConfig, recipe: lodRecipe, tier });
  return { url: ask.url, tier: ask.tier, glbKey: ask.tier === 'lod' ? `${libPath}#lod` : libPath };
}
/** GPU memory against the proto budget — the policy's "device pressure". */
export const gpuPressure = () => (renderer.info?.memory?.total ?? 0) / GPU_BUDGET;
/** Tiered loading, one seam (#156 client contract): `loadGLB(lib, { tier })`
 *  — 'full' or 'lod' — is the only place a tier turns into bytes. */
/** The path a negotiating load fetches: the running server's key appended
 *  when this GPU decodes KTX2 and `eligible` (the asset class negotiates),
 *  the bare path otherwise. */
async function negotiated(path, eligible) {
  const key = eligible && ktx2.workerConfig ? await ktx2KeyReady : null;
  return negotiate(path, key);
}
export function makeLoader(vrm = false) {   // exported for tools/glbperf-parity-probe (the client's own loader)
  const l = new GLTFLoader();
  l.setDRACOLoader(draco);
  l.setKTX2Loader(ktx2);
  if (vrm) {
    l.register((p) => new VRMLoaderPlugin(p, {
      mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(p, { materialType: MToonNodeMaterial }),
    }));
  }
  return l;
}

// ---- texture priming --------------------------------------------------------
// Upload textures a budget-slice per frame so the first compile/render doesn't stall. Every material map is an
// own property, so the Object.values walk covers them (§16.1c); node-only textures are primed on decode below.
function collectTextures(obj) {
  const seen = new Set();
  const out = [];
  obj.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m)) {
        if (v?.isTexture && !seen.has(v)) { seen.add(v); out.push(v); }
      }
    }
  });
  return out;
}
// Bytes-per-frame upload budget: initTexture returns at once while the GPU does the work, so a CPU-ms budget
// alone lets several 4K textures land in one frame (§16.1g). Spent budget = wait a real frame.
const TEX_FRAME_BYTES = 16 * 1024 * 1024;
function textureUploadBytes(t) {
  const img = t.image;
  const w = img?.width ?? 0, h = img?.height ?? 0;
  // compressed (KTX2 → BC7/ASTC/ETC): the upload bill is the literal mip
  // bytes — the raw-RGBA w*h*4 estimate below over-charges BC7 4× and
  // squanders the per-frame budget the §17a spread runs on
  if (t.isCompressedTexture) return t.mipmaps?.reduce((s, m) => s + (m.data?.byteLength ?? 0), 0) || (w * h);
  if (!w || !h) return 4 * 1024 * 1024;   // dimensionless (data/undecoded):
                                          // charge something so a run of
                                          // unknowns still spreads
  return w * h * 4 * (t.generateMipmaps === false ? 1 : 1.33);
}
async function primeTextures(obj, work) {
  let spent = 0;
  for (const t of collectTextures(obj)) {
    const est = textureUploadBytes(t);
    // budget check BEFORE the upload; the `spent > 0` guard means one
    // oversized texture (a 4K map alone is ~89MB) still uploads — the
    // budget spreads, never skips — just alone in its own frame
    if (spent > 0 && spent + est > TEX_FRAME_BYTES) {
      await work.yield();
      spent = 0;
    }
    try { renderer.initTexture(t); } catch { /* first bind will get it */ }
    spent += est;
    await work.tick();   // the CPU-ms budget stays — decode-side cost is real
                         // too (a tick yield without a byte reset only makes
                         // the spread MORE generous, never less)
  }
}

// Prime-on-decode (§17a): node-graph textures are invisible to collectTextures, but all pass loadImageTexture, so
// each queues here under the same budget before a compile binds it. This spreads, never gates.
const texPrimeQueue = [];
let texPrimePumping = false;
function queueTexturePrime(tex) {
  texPrimeQueue.push(tex);
  if (texPrimePumping) return;
  texPrimePumping = true;
  (async () => {
    let spent = 0;
    while (texPrimeQueue.length) {
      const t = texPrimeQueue.shift();
      const est = textureUploadBytes(t);
      if (spent > 0 && spent + est > TEX_FRAME_BYTES) {
        await nextFrame();
        spent = 0;
      }
      try { renderer.initTexture(t); } catch { /* disposed/pre-init — bind pays */ }
      spent += est;
    }
    texPrimePumping = false;
  })();
}

export async function loadVRM(libPath, { priority = 1 } = {}) {
  // §19b: a body parsed and compiled this session never re-pays. The pool is
  // consulted FIRST — a hit skips download+parse+skeleton+textures entirely.
  const t0 = performance.now();
  const pooled = takePooledVrm(libPath);
  if (pooled) {
    loadNote(`vrm ${libPath.split('/').pop()}: pool-hit — ${Math.round(performance.now() - t0)}ms`);
    return pooled;
  }
  const work = beginWork(`vrm ${libPath.split('/').pop()}`);
  try {
    work.phase('download');
    // §20c: bodies negotiate KTX2 like GLBs; paths may already carry ?v=, so the flag appends. The full URL keys
    // byteCache; vrmPool and vrmMeta key on the untouched libPath.
    const url = await negotiated(libPath, libPath.split('?')[0].endsWith('.vrm'));
    const buf = await fetchBytes(`/library/${url}`);
    work.phase('queued');
    // Serialize the synchronous parse/skeleton passes and yield between them, so each stall is one pass long.
    // Bodies default to priority 1: people before furniture.
    return await enqueue(async () => {
      work.phase('parse');
      const gltf = await new Promise((res, rej) => makeLoader(true).parse(buf, '', res, rej));
      const vrm = gltf.userData.vrm;
      // Every bone's rest, read before anything writes it (avatar.js _rawRest); bind data can't stand in, since
      // the skeleton pass below drops unweighted joints, humanoid ones included.
      vrm.userData ??= {};
      vrm.userData.boneRest = {};
      vrm.scene.traverse((o) => {
        if (o.isBone && o.name && !(o.name in vrm.userData.boneRest)) {
          vrm.userData.boneRest[o.name] = { q: o.quaternion.toArray(), p: o.position.toArray(), s: o.scale.toArray() };
        }
      });
      // pool ledger (§19b): path for the release side, source bytes as the
      // VRAM proxy the pool budget counts
      vrmMeta.set(vrm, { libPath, bytes: buf.byteLength });
      await work.yield();
      work.phase('skeleton');
      VRMUtils.combineSkeletons?.(vrm.scene) ?? VRMUtils.removeUnnecessaryJoints?.(vrm.scene);
      // A SkinnedMesh's bounds are bind-pose, so a posed multi-primitive body (region-tight bounds per primitive)
      // loses parts to culling by camera angle.
      vrm.scene.traverse((o) => { if (o.isSkinnedMesh) o.frustumCulled = false; });
      VRMUtils.rotateVRM0(vrm); // VRM0 → faces +Z
      // through the factory BEFORE the first compile: the final graph shape
      // (wetness on MToon, sweep markers) is born with the body
      prepareObject(vrm.scene, { kind: 'body' });
      await work.yield();
      work.phase('textures');
      await primeTextures(vrm.scene, work);
      return vrm;
    }, { lane: 'cpu', priority });
  } finally { work.end(); }
}

// ---- the VRM instance pool (§19b) -------------------------------------------
// VRMs can't share a proto (three-vrm binds to specific nodes; no rebinding clone), so the pool shelves whole
// parsed instances, one body each. THE POOL OWNS DISPOSAL: never deepDispose a pooled body elsewhere (black
// avatar); only eviction (LRU caps or the GPU-budget drain) disposes.
const vrmPool = new Map();        // libPath -> [{ vrm, bytes, at }], oldest first
const vrmMeta = new WeakMap();    // vrm -> { libPath, bytes }, stamped at parse
const warmedVrms = new WeakSet(); // instances whose pipelines warmed once
const VRM_POOL_MAX = 2;                    // whole parsed bodies held at rest
const VRM_POOL_BYTES = 64 * 1024 * 1024;   // source-byte proxy for their VRAM
let vrmPoolBytes = 0;
let vrmPoolCount = 0;
let vrmPoolEvictions = 0;

/** Has this INSTANCE been warmed by makeAvatar? A pooled body's pipelines are cached, so it skips the conductor.
 *  Instance-keyed: a fresh parse of the same lib has new materials and warms like a first wear. */
export const vrmWarmed = (vrm) => warmedVrms.has(vrm);
export const markVrmWarmed = (vrm) => { warmedVrms.add(vrm); };

/** Reset a parsed instance to rest (humanoid, expressions, lookAt, springs; vendored three-vrm 3.5.2). The closing
 *  vrm.update(0) applies it; spring joints guard `delta <= 0`, so the settled state survives. */
function resetVrmInstance(vrm) {
  if (vrm.lookAt) { vrm.lookAt.target = null; vrm.lookAt.reset(); }
  vrm.humanoid?.resetNormalizedPose();
  vrm.humanoid?.resetRawPose();
  vrm.expressionManager?.resetValues();
  vrm.scene.updateMatrixWorld(true);   // spring tails derive from world matrices
  vrm.springBoneManager?.reset();
  vrm.update(0);
}

/** Deep-dispose the LRU pooled instance. `keep` is never evicted — the house
 *  pattern (noteBytes): what just landed doesn't leave, so one over-budget
 *  body still pools rather than thrashing. Returns false when nothing can go. */
function evictOldestPooled(keep = null) {
  let path = null, list = null;
  for (const [p, l] of vrmPool) {
    if (l[0] && (!list || l[0].at < list[0].at)) { path = p; list = l; }
  }
  const oldest = list?.[0];
  if (!oldest || oldest === keep) return false;
  list.shift();
  if (!list.length) vrmPool.delete(path);
  vrmPoolCount--; vrmPoolBytes -= oldest.bytes;
  vrmMeta.delete(oldest.vrm);          // a later stray release deep-disposes, never re-pools
  VRMUtils.deepDispose?.(oldest.vrm.scene);
  vrmPoolEvictions++;
  return true;
}

/** Give a body back. The instance pools INTACT — never disposed here — unless
 *  its reset throws (evict rather than pool a haunted body: correctness beats
 *  caching) or it never came from loadVRM (old contract: deep-dispose now). */
export function releaseVRM(vrm) {
  if (!vrm?.scene) return;
  for (const list of vrmPool.values()) {  // double-release guard, before any
    if (list.some((e) => e.vrm === vrm)) return;  // mutation: one slot per instance
  }
  vrm.scene.parent?.remove(vrm.scene); // detach from the scene before pooling
  const meta = vrmMeta.get(vrm);
  if (!meta) { VRMUtils.deepDispose?.(vrm.scene); return; }
  try { resetVrmInstance(vrm); } catch (e) {
    console.warn('[vrmpool] reset failed — evicting instead of pooling', e);
    vrmMeta.delete(vrm);
    VRMUtils.deepDispose?.(vrm.scene);
    vrmPoolEvictions++;
    return;
  }
  let list = vrmPool.get(meta.libPath);
  if (!list) vrmPool.set(meta.libPath, list = []);
  const entry = { vrm, bytes: meta.bytes, at: performance.now() };
  list.push(entry);
  vrmPoolCount++; vrmPoolBytes += entry.bytes;
  while ((vrmPoolCount > VRM_POOL_MAX || vrmPoolBytes > VRM_POOL_BYTES)
    && evictOldestPooled(entry)) { /* LRU out until within budget */ }
}

/** Pop an instance for re-wear. Re-resets (a borrower like the thumbnail pass may have posed it); if that throws,
 *  dispose and re-parse: a miss, never a haunted hit. */
function takePooledVrm(libPath) {
  const list = vrmPool.get(libPath);
  if (!list?.length) return null;
  const entry = list.pop();
  if (!list.length) vrmPool.delete(libPath);
  vrmPoolCount--; vrmPoolBytes -= entry.bytes;
  try { resetVrmInstance(entry.vrm); } catch (e) {
    console.warn('[vrmpool] take-reset failed — re-parsing instead', e);
    vrmMeta.delete(entry.vrm);
    VRMUtils.deepDispose?.(entry.vrm.scene);
    vrmPoolEvictions++;
    return null;
  }
  return entry.vrm;
}

/** Debug shape — rides EW.gpu() via protoStats, like the proto/byte tiers. */
export const poolStats = () => ({
  instances: vrmPoolCount,
  bytes: vrmPoolBytes,
  budget: { instances: VRM_POOL_MAX, bytes: VRM_POOL_BYTES },
  evictions: vrmPoolEvictions,
  libs: [...vrmPool.entries()].map(([p, l]) => `${p.split('/').pop()}×${l.length}`),
});

// Friendly names for library paths — store hashes are unreadable, and the
// loading tray should say "deco desk", not "4fee4b7c4794a2be".
export const libLabels = new Map();
/** A person's word for a model: its library name (libLabels: the catalogue's, an upload's), else its path's file name; an old
 *  address (stored before 10-17) nobody named is "thing", never its hex (shared/eido.js modelWord). */
export const modelName = (model) => modelWord(model, (m) => libLabels.get(m) ?? null);

const glbCache = new Map();
export async function loadGLB(libPath, { tier = 'full' } = {}) {
  // the WIRE decides which tier this load IS (review of #170, point 2): a
  // lod wish that cannot negotiate — no transcoder, no key, no recipe, not
  // a .glb — is a full load, keyed, fetched, and reported as one
  await negotiationReady;
  const req = resolveLoadRequest(libPath, tier);
  tier = req.tier;
  const glbKey = req.glbKey;
  const short = modelName(libPath).slice(0, 28) + (tier === 'lod' ? '·lod' : '');
  loadsInFlight.set(glbKey, (loadsInFlight.get(glbKey) ?? 0) + 1);
  try {
  if (!glbCache.has(glbKey)) {
    const key = `glb:${short}`;
    loadTrack(key, short);
    const p = (async () => {
      const work = beginWork(`glb ${short}`);
      try {
        work.phase('download');
        // §20 + #156: URL from resolveLoadRequest; a lod request is never a worse model (the server falls back to the
        // original). The full URL keys byteCache, so variant and original are distinct entries.
        const buf = await fetchBytes(`/library/${req.url}`);
        // body first: bytes are in hand, but the PARSE waits for your own
        // body (bodygate.js) — capped at 12 s so nothing can hold the world
        if (BODY_FIRST && bodyGateArmed() && !bodyGateOpen()) {
          work.phase('body-first');
          await awaitBodyGate(12000);
        }
        work.phase('queued');
        return await enqueue(async () => {
          work.phase('parse');
          const gltf = await new Promise((res, rej) => makeLoader(false).parse(buf, '', res, rej));
          // the PROTOTYPE goes through the factory once; every skeletonClone
          // shares its wrapped materials and copies its mesh markers
          prepareObject(gltf.scene, { kind: 'model', foliage: false });   // foliage cores go on each clone, below
          markDrawBatchSource(gltf.scene);
          // identity the realizer reads: which cache entry this proto is (for
          // retain/release/eviction) and which tier the SERVER actually sent
          gltf.scene.userData.glbKey = glbKey;
          gltf.scene.userData.tierServed = tierOf(gltf.parser?.json, lodRecipe);   // the reducer's stamp, this recipe
          gltf.scene.userData.tierAsked = tier;   // what crossed the wire — the sweep compares against THIS
          await work.yield();
          work.phase('textures');
          await primeTextures(gltf.scene, work);
          return gltf.scene;
        }, { lane: 'cpu', priority: 0 });
      } finally { loadDone(key); work.end(); }
    })();
    // a REJECTED promise must not be the lib's answer forever — the residency
    // sweep re-promotes near placeholders, and a cached rejection turned one
    // bad fetch into an instant-fail loop (review S3; models backs off too)
    p.catch(() => { if (glbCache.get(glbKey) === p) glbCache.delete(glbKey); });
    glbCache.set(glbKey, p);
  }
  const proto = await glbCache.get(glbKey);
  const obj = skeletonClone(proto); // safe for rigged + static alike
  registerFoliage(obj);             // this placement's foliage cores (foliage.js: per instance, state per material)
  // Precompile off the render path, or a new material's first frame stalls. ALL THREE compile paths go through
  // the warm conductor (warmqueue.js, §16.2.A); a bare compileAsync starves rAF. Repeats are cache hits.
  if (compiledLibs.has(glbKey)) {
    await warm(`compile ${short}`, () => renderer.compileAsync(obj, camera, scene).catch(() => {}));
    return obj;
  }
  // Clones share materials, so one compile warms them all: the first caller compiles, racers await it and cache-hit.
  if (!libCompiles.has(glbKey)) {
    // In the loading tray too: a compile can take seconds (Safari), and a named spinner beats mystery jank.
    loadTrack(`compile:${glbKey}`, `⚙ ${short}`);
    // Per mesh with a real frame between: one compileAsync over a multi-material object is one GPU gulp.
    // frustumCulled defeats culling for detached clones with stale world matrices.
    const p = warm(`compile ${short}`, async () => {
      const meshes = [];
      obj.traverse((o) => { if (o.isMesh) meshes.push(o); });
      for (const mesh of meshes) {
        const culled = mesh.frustumCulled;
        mesh.frustumCulled = false;
        try { await renderer.compileAsync(mesh, camera, scene).catch(() => {}); }
        finally { mesh.frustumCulled = culled; }
        await nextFrame();
      }
    })
      .then(() => compiledLibs.add(glbKey))
      .finally(() => { libCompiles.delete(glbKey); loadDone(`compile:${glbKey}`); });
    libCompiles.set(glbKey, p);
    await p;
    return obj;
  }
  // Await the first compile OUTSIDE the conductor (item-awaits-item deadlocks at concurrency 1), then warm cheaply.
  await libCompiles.get(glbKey).catch(() => {});
  await warm(`compile ${short}`, () => renderer.compileAsync(obj, camera, scene).catch(() => {}));
  return obj;
  } finally {
    const n = (loadsInFlight.get(glbKey) ?? 1) - 1;
    if (n <= 0) loadsInFlight.delete(glbKey); else loadsInFlight.set(glbKey, n);
  }
}
// Libs whose pipelines have been compiled once this session — repeat spawns
// skip the queue. Compiled once is compiled: graph shapes are fixed at birth.
const compiledLibs = new Set();
const libCompiles = new Map(); // libPath -> in-flight first compile
// loads mid-flight count as references: eviction during a clone's compile
// yield would dispose the proto it shares (review S2)
const loadsInFlight = new Map();

// ---- proto residency (§13.3 R2) ---------------------------------------------
// GPU bytes live on the protos and only dispose() frees VRAM, so protos are refcounted by clones and zero-ref ones
// evict over budget (a re-promote is a parse). NEVER call this per-entity: disposal reaches every clone.
const libRefs = new Map();     // lib -> count of realized clones in the scene
export function retainGLB(lib) { libRefs.set(lib, (libRefs.get(lib) ?? 0) + 1); }
export function releaseGLB(lib) {
  const n = (libRefs.get(lib) ?? 0) - 1;
  if (n <= 0) libRefs.delete(lib); else libRefs.set(lib, n);
}
const GPU_BUDGET = 1_500_000_000;   // bytes of renderer.info.memory.total
export async function evictIdleProtos() {
  if ((renderer.info?.memory?.total ?? 0) < GPU_BUDGET) return 0;
  let evicted = 0;
  // The VRM pool drains first (§19b): pooled bodies are zero-ref by
  // construction — nobody wears an instance that sits in the pool — so under
  // real GPU pressure they are the cheapest correct thing to give back.
  while ((renderer.info?.memory?.total ?? 0) >= GPU_BUDGET && evictOldestPooled()) evicted++;
  if ((renderer.info?.memory?.total ?? 0) < GPU_BUDGET) return evicted;
  for (const [lib, promise] of [...glbCache]) {
    if (libRefs.has(lib) || loadsInFlight.has(lib)) continue;   // worn, or being fitted
    const proto = await promise.catch(() => null);
    // the awaits yield — re-check before touching anything (review S2)
    if (libRefs.has(lib) || loadsInFlight.has(lib)) continue;
    glbCache.delete(lib);
    compiledLibs.delete(lib);
    if (proto) {
      const seenMats = new Set();
      proto.traverse((o) => {
        o.geometry?.dispose?.();
        for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
          if (seenMats.has(m)) continue;
          seenMats.add(m);
          // the factory's shared cloud-noise texture rides the node graph,
          // not a material property — Object.values never reaches it
          for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
          m.dispose();
        }
      });
      evicted++;
    }
    if ((renderer.info?.memory?.total ?? 0) < GPU_BUDGET) break;
  }
  return evicted;
}
export const protoStats = () => ({
  protos: glbCache.size, referenced: libRefs.size,
  bytesCached: byteSizes.size, byteTotal,
  vrmPool: poolStats(),   // §19b — rides EW.gpu() like the other tiers
});

// ---- VRMA clips -------------------------------------------------------------

// 'fly' and 'soar' are the airborne pair: fallIdle (limbs trailing, no contact), not a run cycle.

const vrmaCache = new Map();
// sha256 of the clip bytes this page loaded (#101): the seat gate matches it to the server's profile digest,
// so a fallback or divergent clip can't wear a profile derived from other bytes.
const vrmaSha = new Map(); // slot → hex sha256, present only once resolved
export function vrmaShaLoaded(slot) { return vrmaSha.get(slot) ?? null; }
// Clip URLs carry ?v=<mtime> from /animations (stamped on the file actually served), the only invalidation that
// reaches caches we don't control. Fetched lazily (a top-level fetch gates the module graph); a roster failure
// falls back to the bare URL, never worse.
let clipRoster = null;
function clipPath(file) {
  clipRoster ??= fetch('/animations', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`animations ${r.status}`))))
    .then((list) => new Map(list.map((e) => [e.name, e.path])))
    .catch((e) => {
      console.warn('[clips] roster unavailable — clips load unversioned, and a changed clip may serve stale', e);
      return new Map();
    });
  return clipRoster.then((m) => m.get(file) ?? `eidoverse/assets/animations/${file}.vrma`);
}

export function vrmaBytes(slot) {
  if (!vrmaCache.has(slot)) {
    const p = clipPath(CLIP_FILES[slot] ?? slot).then((rel) => fetchBytes(`/library/${rel}`));
    vrmaCache.set(slot, p);
    p.then(async (buf) => {
      const d = await crypto.subtle.digest('SHA-256', buf);
      vrmaSha.set(slot, [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''));
    }).catch(() => { /* fetch failure already surfaces via the caller */ });
  }
  return vrmaCache.get(slot);
}

// The parsed VRMAnimation is avatar-independent (only the cheap createVRMAnimationClip needs the vrm): parse once.
const vrmaAnimCache = new Map(); // slot -> Promise<VRMAnimation>
function vrmaAnimation(slot, priority = 1) {
  if (!vrmaAnimCache.has(slot)) {
    const p = (async () => {
      const buf = await vrmaBytes(slot);
      const work = beginWork(`vrma ${slot}`);
      try {
        work.phase('queued');
        return await enqueue(async () => {
          work.phase('parse');
          return parsePoseAnimation(buf);
        }, { lane: 'cpu', priority });
      } finally { work.end(); }
    })();
    p.catch(() => vrmaAnimCache.delete(slot)); // a transient failure must not stick
    vrmaAnimCache.set(slot, p);
  }
  return vrmaAnimCache.get(slot);
}

export async function clipFor(vrm, slot, { priority = 1 } = {}) {
  return retargetPoseAnimation(await vrmaAnimation(slot, priority), vrm);
}

// ---- procedural textures ----------------------------------------------------

/** Small tinted-noise CanvasTexture — lets log verbs specify terrain layers as
 *  colors (serializable) while clients bake the actual maps locally. */
export function noiseTexture(hex, scale = 0.22) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const base = new THREE.Color(hex);
  const img = ctx.createImageData(64, 64);
  for (let i = 0; i < 64 * 64; i++) {
    const n = 1 - scale + Math.random() * scale * 2;
    img.data[i * 4] = Math.min(255, base.r * 255 * n);
    img.data[i * 4 + 1] = Math.min(255, base.g * 255 * n);
    img.data[i * 4 + 2] = Math.min(255, base.b * 255 * n);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ============================================================================
// The eidoverse module host
// ============================================================================
// Toolkit modules are written for Deno and read files SYNCHRONOUSLY; a browser can't, so prime an in-memory
// file system first and let the sync reads hit it (sky_worlds.js runs unedited).

const denoFiles = new Map(); // library-relative path -> Uint8Array
const textDecoder = new TextDecoder();

/** Warm the virtual filesystem before any toolkit eval-load or asset read. Paths are library-relative
 *  ("eidoverse/sky_system.js"); missing files are reported, not fatal, so a world degrades rather than aborts. */
export async function primeFiles(paths, { concurrency = 6 } = {}) {
  const missing = [];
  const q = paths.filter((p) => !denoFiles.has(p));
  await Promise.all(Array.from({ length: Math.min(concurrency, q.length) }, async () => {
    while (q.length) {
      const p = q.shift();
      try {
        // §20d: loose images negotiate KTX2; only the WIRE URL changes, denoFiles keys on the bare path (identities
        // hold), and loadImageTexture sniffs the container magic.
        const url = await negotiated(p, /\.(png|jpe?g)$/i.test(p));
        const buf = await fetchBytes(`/library/${url}`);
        denoFiles.set(p, new Uint8Array(buf));
      } catch (e) { missing.push(p); }
    }
  }));
  if (missing.length) console.warn('[host] not primed:', missing.join(', '));
  return missing;
}

/** Directory listing from the sequencer, so prefetch lists are discovered
 *  rather than hardcoded (the no-manifest rule applies to us too). */
export async function listLibrary(dir) {
  try {
    const r = await fetch(`/library-list?dir=${encodeURIComponent(dir)}`);
    // null, NOT [] — an empty directory and a sequencer that has never heard of
    // this endpoint are different facts, and treating them the same made an
    // old server look like a world with no sky assets in it.
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

const normDeno = (p) => String(p).replace(/^\.?\//, '');

globalThis.Deno = {
  readFileSync(p) {
    const f = denoFiles.get(normDeno(p));
    if (!f) throw new Error(`[host] not primed: ${p}`);
    return f;
  },
  readTextFileSync(p) {
    return textDecoder.decode(globalThis.Deno.readFileSync(p));
  },
  async readFile(p) { return globalThis.Deno.readFileSync(p); },
  async readTextFile(p) { return globalThis.Deno.readTextFileSync(p); },
  // Toolkit writes are swallowed (nowhere to put them); a later read gets a clear "not primed".
  writeFileSync() {}, writeTextFileSync() {},
  async writeFile() {}, async writeTextFile() {},
  mkdirSync() {}, statSync() { throw new Error('[host] statSync unsupported'); },
  // Engine-side look-dev knobs, not scene parameters: the client supplies only the tier the hardware can hold.
  env: {
    get: (k) => globalThis.__ewEnv?.[k],
    set: (k, v) => { (globalThis.__ewEnv ??= {})[k] = v; },
    has: (k) => globalThis.__ewEnv?.[k] !== undefined,
  },
  // Subprocess (ffmpeg for the asteroid bake) — declaring it absent is more
  // honest than a stub that pretends to succeed.
  Command: class { constructor() { throw new Error('[host] no subprocesses in a browser'); } },
  build: { os: 'browser' },
};

/** Decode image bytes into a three texture: the browser side of the engine's loadImageTexture (render_scene.mjs).
 *  Cached by bytes identity + opts in a WeakMap (readFileSync returns the same Uint8Array per path, §16.2.B). Cached
 *  textures are shared, so their dispose() is a no-op (userData.ewShared): a disposed shared texture is black. */
const imageTexCache = new WeakMap(); // bytes object -> Map<opts key, Promise<Texture>>
// The full 12-byte KTX2 identifier («KTX 20»\r\n\x1a\n) — the file-format spec's
// own magic, matched byte-for-byte so nothing else can ever route to the
// transcoder by accident.
const KTX2_MAGIC = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
globalThis.loadImageTexture = async (bytes, opts = {}) => {
  // only srgb + flipY alter the constructed texture; wrap/anisotropy are caller-side and agree per URL
  const cacheable = typeof bytes === 'object' && bytes !== null;
  const key = `${opts.srgb ? 's' : 'l'}:${opts.flipY !== false ? 'f' : 'n'}`;
  if (cacheable) {
    const hit = imageTexCache.get(bytes)?.get(key);
    if (hit) return hit;
  }
  const p = (async () => {
    const u8 = bytes instanceof Uint8Array ? bytes
      : bytes instanceof ArrayBuffer ? new Uint8Array(bytes)
        : new Uint8Array(bytes);
    // §20d: bytes may arrive as KTX2: route by the 12-byte container magic, never the path.
    if (u8.length >= 12 && KTX2_MAGIC.every((v, i) => u8[i] === v)) {
      // Flip and colorSpace were baked at encode (server --ktx2-img): don't override colorSpace here.
      // ktx2.parse DETACHES its buffer, so pass a copy: readFileSync returns the same Uint8Array per path.
      const tex = await new Promise((res, rej) => ktx2.parse(u8.slice().buffer, res, rej));
      // As the raster path: repeat wrap; flipY false (the flip is baked); mips and filters come from the container.
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      if (cacheable) {
        tex.userData.ewShared = true;   // served from cache — teardowns must skip it
        tex.dispose = () => {};         // session-pinned, same as the raster path
      }
      queueTexturePrime(tex);           // §17a: initTexture sums literal mip bytes
      return tex;
    }
    // Engine contract (render_scene.mjs loadImageTexture): the flip is BAKED into the pixels and tex.flipY stays
    // false; { flipY: false } skips it for glTF images. Must match, or authored-UV textures arrive mirrored.
    const bitmap = await createImageBitmap(new Blob([u8]), {
      colorSpaceConversion: 'none',
      imageOrientation: opts.flipY !== false ? 'flipY' : 'none',
    });
    const tex = new THREE.Texture(bitmap);
    tex.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.flipY = false;         // matches the engine's bitmap orientation
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    if (cacheable) {
      tex.userData.ewShared = true;   // served from cache — teardowns must skip it
      tex.dispose = () => {};         // session-pinned (see above)
    }
    queueTexturePrime(tex);           // §17a: upload spread, ahead of the compile
    return tex;
  })();
  if (cacheable) {
    let per = imageTexCache.get(bytes);
    if (!per) imageTexCache.set(bytes, per = new Map());
    per.set(key, p);
    p.catch(() => per.delete(key));   // a transient decode failure must not stick
  }
  return p;
};

// Toolkit modules construct their own loader for celestial meshes. The Deno
// host has it as a global, so ours must too — without it the sky died on
// `globalThis.GLTFLoader is not a constructor` and fell back to the basic sky.
globalThis.GLTFLoader = GLTFLoader;
globalThis.DRACOLoader = DRACOLoader;
// the configured SINGLETON, not the class: a toolkit module constructing its
// own GLTFLoader attaches it via setKTX2Loader(globalThis.KTX2Loader) and
// gets the transcoder path + detectSupport it could not redo itself
globalThis.KTX2Loader = ktx2;

/** GLB bytes → scene, for toolkit modules that load their own meshes. */
globalThis.loadGLBBytes = async (bytes) => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const gltf = await new Promise((res, rej) =>
    makeLoader(false).parse(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), '', res, rej));
  return gltf.scene;
};

// ---- module loading ---------------------------------------------------------

const eidoModules = new Map();
/** Eval-load a toolkit module by name ("terrain.js"). Idempotent; concurrent
 *  callers share one fetch. */
export function loadEidoModule(name) {
  if (!eidoModules.has(name)) {
    eidoModules.set(name, (async () => {
      const r = await fetch(`/library/eidoverse/${name}`);
      if (!r.ok) throw new Error(`module ${name}: ${r.status}`);
      const src = await r.text();
      denoFiles.set(`eidoverse/${name}`, new TextEncoder().encode(src)); // self-prime
      (0, eval)(src); // same indirect-eval hosting as the engine
    })());
  }
  return eidoModules.get(name);
}

export { VRMUtils, skeletonClone };
