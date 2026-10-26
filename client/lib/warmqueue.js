// warmqueue — one serialized queue for pipeline warms (GLB libs, terrain, sky domes, shadow depth). Concurrency
// is one on purpose: compiles must not fight. Between items, a real rAF yield, never scheduler.yield (it starves
// rAF on Chromium). Errors are swallowed but counted (warmStats()). See TEL0S_NOTES.md §16.

import { renderer, scene, sun, camera, THREE, TSL } from './core.js';
import { beginWork, nextFrame } from './loadwork.js';
import { turn, spent, reportPending } from './framebudget.js';

// ---- the queue --------------------------------------------------------------

const queue = [];
let running = false;
const stats = { queued: 0, done: 0, failed: 0, lastLabel: null };

// priority classes: FIFO let ambient compiles queue ahead of the terrain the curtain waits on. Stable FIFO within a class.
export const P_GATE = 0;     // arrival waits on this (terrain)
export const P_MODEL = 1;    // a thing someone is about to see (default)
export const P_AMBIENT = 2;  // sky domes, shadow-depth variants

/** Enqueue an async warm: runs fn() alone, highest class first, then arrival order, one real frame between items.
 *  Resolves when the item has run and never rejects (errors are counted). */
export function warm(label, fn, { p = P_MODEL } = {}) {
  return new Promise((resolve) => {
    // the record starts at enqueue so the wait is visible as its own phase
    // (loadwork's doctrine: queue time must not masquerade as work time)
    const work = beginWork(label);
    work.phase('queued');
    const item = { label, fn, work, resolve, p };
    // stable insert: after the last item of an equal-or-higher class
    let at = queue.length;
    while (at > 0 && queue[at - 1].p > p) at--;
    queue.splice(at, 0, item);
    stats.queued++;
    reportPending('warm', queue.length + (running ? 1 : 0));
    pump();
  });
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const grant = await turn('warm');   // the frame's shared budget (framebudget), not a private pace
    const item = queue.shift();
    if (!item) continue;
    stats.lastLabel = item.label;
    item.work.phase('warm');
    try {
      // Charged: the warm's synchronous head only (for compileAsync, projection and render-list building). Its codegen
      // runs after compileAsync's first yield in three's own yielding slices, and the link on the driver's thread;
      // neither is measurable per frame from here. For warms the budget gates when an item STARTS.
      const t0 = performance.now();
      const p = item.fn();
      spent('warm', performance.now() - t0, t0, grant);
      await p;
      stats.done++;
    } catch (e) {
      stats.failed++;               // swallowed, but never silently: counted
    } finally {
      item.work.end();
      item.resolve();
    }
    reportPending('warm', queue.length + 1);
    await nextFrame();              // a REAL frame between items (§16.1a)
  }
  running = false;
  reportPending('warm', 0);
}

// `pending` excludes the item being warmed, so `running` is part of the busy answer (§16.2.D)
export const warmStats = () => ({ ...stats, pending: queue.length, running });

// ---- shadow-depth pre-warm --------------------------------------------------
// Compile a caster's depth pipelines via compileAsync before castShadow flips, so the real pass is a cache hit.
// The warm material is pre-set to the post-mutation state (the same _getShadowNodes instances) because renderObject
// restores before compileAsync's deferred codegen; target and override restore in the same sync block.

const SHADOW_SIDE = {
  [THREE.FrontSide]: THREE.BackSide,
  [THREE.BackSide]: THREE.FrontSide,
  [THREE.DoubleSide]: THREE.DoubleSide,
};

let warmMat = null;       // our shadow-pass material — value-identical to three's
let baseColorNode = null; // vec4(0,0,0,1), inlined by value in WGSL
let scratchRT = null;     // format-matched fallback target (never drawn into)
let depthWarmBroken = new URLSearchParams(globalThis.location?.search ?? '').has('nodepthwarm');   // ?nodepthwarm=1 — R 09-07 19:22: casters compile in-frame, the pre-warm bypassed, to tell a wrong warmed pipeline from a driver compare issue

function ensureDepthWarm() {
  if (warmMat) return true;
  if (depthWarmBroken) return false;
  // the one internal this leans on — if the vendored build ever moves it,
  // degrade to today's behavior (flip immediately, compile in-frame) loudly
  if (typeof renderer._getShadowNodes !== 'function') {
    depthWarmBroken = true;
    console.warn('[warm] three internals moved (_getShadowNodes) — depth pre-warm disabled, casters compile in-frame as before');
    return false;
  }
  baseColorNode = TSL.vec4(0, 0, 0, 1);
  warmMat = new THREE.NodeMaterial();
  warmMat.name = 'ShadowMaterial';       // matches getShadowMaterial (label only)
  warmMat.colorNode = baseColorNode;
  warmMat.isShadowPassMaterial = true;   // scene-independent codegen + real-pass parity
  warmMat.blending = THREE.NoBlending;
  warmMat.fog = false;
  return true;
}

// the warm target: the real shadow map RT when it exists (shared render context); else a 4×4 scratch RT with
// setupRenderTarget's formats (only formats enter the pipeline key; nothing draws into it)
function warmTarget() {
  if (sun.shadow?.map?.isRenderTarget) return sun.shadow.map;
  if (!scratchRT) {
    const depthTexture = new THREE.DepthTexture(4, 4);
    depthTexture.compareFunction = renderer.reversedDepthBuffer
      ? THREE.GreaterEqualCompare : THREE.LessEqualCompare;
    scratchRT = new THREE.RenderTarget(4, 4);
    scratchRT.texture.type = sun.shadow.mapType;
    scratchRT.depthTexture = depthTexture;
  }
  return scratchRT;
}

/** Configure warmMat to the exact state renderObject() leaves the real
 *  per-light shadow material in for this caster material (:61181-61209) —
 *  so the compile path's save/mutate/restore is identity. */
function configureFor(m) {
  const sn = renderer._getShadowNodes(m); // cached per material ON THE RENDERER —
                                          // the same instances the real pass uses
  warmMat.alphaTest = m.alphaTest;
  warmMat.alphaMap = m.alphaMap;
  warmMat.transparent = m.transparent || m.transmission > 0
    || Boolean(m.transmissionNode?.isNode) || Boolean(m.backdropNode?.isNode);
  warmMat.side = (m.shadowSide !== null && m.shadowSide !== undefined)
    ? m.shadowSide
    : (renderer.shadowMap.type === THREE.VSMShadowMap ? m.side : SHADOW_SIDE[m.side]);
  warmMat.positionNode = sn.positionNode ?? (m.positionNode?.isNode ? m.positionNode : null);
  warmMat.colorNode = sn.colorNode ?? baseColorNode;
  warmMat.depthNode = sn.depthNode ?? null;
  // bump the version or a multi-material mesh's second round would reuse the
  // first round's cached builder state ('version' itself is in no cache key)
  warmMat.needsUpdate = true;
}

// one compile round per unique material: a multi-material mesh's groups dedupe to the same pipeline key
async function compileDepthRound(mesh, material) {
  configureFor(material);
  const saveVisible = mesh.visible;
  const saveCulled = mesh.frustumCulled;
  const prevOverride = scene.overrideMaterial;
  const prevTarget = renderer.getRenderTarget();
  mesh.visible = true;         // compile's projectObject skips invisible (:60819)
  mesh.frustumCulled = false;  // …and out-of-frustum (:60869) — restored below
  scene.overrideMaterial = warmMat;
  renderer.setRenderTarget(warmTarget());
  let compiled;
  try {
    // the live scene as targetScene: the builder's env/fog inputs match the
    // real pass exactly (both inert for an unlit shadow material — :30264)
    compiled = renderer.compileAsync(mesh, sun.shadow.camera, scene);
  } finally {
    // same synchronous block — no frame can observe any of these mutated
    renderer.setRenderTarget(prevTarget);
    scene.overrideMaterial = prevOverride;
    mesh.visible = saveVisible;
    mesh.frustumCulled = saveCulled;
  }
  await (compiled?.catch(() => {}) ?? Promise.resolve());
}

/** Warm the lit pipelines a body needs once it receives shadows: receiveShadow is in the render-object cache key,
 *  so the first lit frame after the flip would build a program per material in-frame. Same save/mutate/restore shape
 *  as compileDepthRound. */
export function warmLit(label, getMeshes) {
  if (typeof renderer?.compileAsync !== 'function') return Promise.resolve();
  return warm(label, async () => {
    for (const mesh of getMeshes() ?? []) {
      if (!mesh?.isMesh) continue;
      const rs = mesh.receiveShadow, fc = mesh.frustumCulled, vis = mesh.visible;
      let compiled;
      try {
        mesh.receiveShadow = true; mesh.frustumCulled = false; mesh.visible = true;
        compiled = renderer.compileAsync(mesh, camera, scene);
      } finally {
        mesh.receiveShadow = rs; mesh.frustumCulled = fc; mesh.visible = vis;
      }
      await (compiled?.catch(() => {}) ?? Promise.resolve());
      await nextFrame();
    }
  }, { p: P_AMBIENT });
}

/** Warm every shadow-depth pipeline a caster will need. `getMeshes` is re-read when the item runs, so a caster
 *  released while queued warms nothing; resolves when done or unsupported. */
export function warmDepth(label, getMeshes) {
  if (!ensureDepthWarm()) return Promise.resolve();
  return warm(label, async () => {
    for (const mesh of getMeshes() ?? []) {
      if (!mesh?.isMesh) continue;
      const mats = Array.isArray(mesh.material)
        ? [...new Set(mesh.material)]
        : mesh.material ? [mesh.material] : [];
      for (const m of mats) {
        await compileDepthRound(mesh, m);
        await nextFrame();     // breathe between rounds too — real frames
      }
    }
  }, { p: P_AMBIENT });        // background warmth: never ahead of arrivals
}
