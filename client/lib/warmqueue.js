// warmqueue — the warm conductor (TEL0S_NOTES §16.2.A).
//
// One serialized queue for pipeline warms: GLB lib compiles (assets.js),
// terrain (world.js), sky domes (sky.js) and shadow-depth variants (below,
// driven by lightrig's casterPass). Concurrency is ONE — that is the point: the
// GPU process compiles one thing at a time while frames keep presenting (a
// 2-wide lane let compiles fight each other, §16.1d).
//
// Between items: one REAL requestAnimationFrame yield — never scheduler.yield,
// whose same-turn continuation storm starves rAF on Chromium (§16.1a). Errors
// are swallowed (house warm pattern) but counted in warmStats().

import { renderer, scene, sun, camera, THREE, TSL } from './core.js';
import { beginWork, nextFrame } from './loadwork.js';
import { turn, spent, reportPending } from './framebudget.js';

// ---- the queue --------------------------------------------------------------

const queue = [];
let running = false;
const stats = { queued: 0, done: 0, failed: 0, lastLabel: null };

// Priority classes: under plain FIFO, ambient compiles queued ahead of the
// terrain compile the curtain waits on and slowed boot ~8×. GATE = what the
// splash waits for; AMBIENT = background warmth. Stable FIFO within a class.
export const P_GATE = 0;     // arrival waits on this (terrain)
export const P_MODEL = 1;    // a thing someone is about to see (default)
export const P_AMBIENT = 2;  // sky domes, shadow-depth variants

/** Enqueue an async warm. Runs fn() alone — highest class first, arrival order
 *  within a class — one real frame between items. Resolves when the item has
 *  RUN; never rejects (errors are swallowed and counted). */
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

// `pending` counts queued items only — the item currently being warmed has
// been shifted off the queue, so `running` is part of the honest busy answer
// (the governor's loading grace reads both, §16.2.D).
export const warmStats = () => ({ ...stats, pending: queue.length, running });

// ---- shadow-depth pre-warm --------------------------------------------------
// Warms a caster's depth pipelines through compileAsync BEFORE castShadow
// flips, so the real shadow pass is a pure cache hit (§16.1c). The warm
// material is pre-configured to the exact state three's renderObject() leaves
// the real shadow material in, because compileAsync defers codegen past its
// restore. Mechanism + three.webgpu.js line refs: docs/research/shadow-depth-prewarm.md

const SHADOW_SIDE = {
  [THREE.FrontSide]: THREE.BackSide,
  [THREE.BackSide]: THREE.FrontSide,
  [THREE.DoubleSide]: THREE.DoubleSide,
};

let warmMat = null;       // our shadow-pass material — value-identical to three's
let baseColorNode = null; // vec4(0,0,0,1), inlined by value in WGSL
let scratchRT = null;     // format-matched fallback target (never drawn into)
let depthWarmBroken = new URLSearchParams(globalThis.location?.search ?? '').has('nodepthwarm');   // ?nodepthwarm=1: casters compile in-frame, the pre-warm bypassed, to tell a wrong warmed pipeline from a driver compare issue

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

// The warm target: the REAL shadow map RT once it exists (same render context
// as the real pass). Before the first shadow render, a 4×4 scratch RT with
// setupRenderTarget's FORMATS (:44272-4285) — only formats enter the pipeline
// key, and the compile never draws into it.
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
  // first round's cached builder state (RenderObjects.get version-checks the
  // material on chain reuse, :30436 — 'version' itself is in no cache key)
  warmMat.needsUpdate = true;
}

// One compile round: this mesh, this material's depth config. A multi-material
// mesh's groups dedupe to one pipeline key per round, so per-unique-material
// rounds warm everything with zero waste.
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

/** Warm the LIT pipelines a body needs once it RECEIVES shadows: receiveShadow IS in the render-object cache key
 *  (three 0.186 RenderObject.js:856/:945; AnalyticLightNode only generates the shadow taps when the object
 *  receives), so the first lit frame after the flip would build a new program per material in-frame. Same
 *  save/mutate/restore shape as compileDepthRound: compileAsync captures the render object synchronously, the
 *  pipeline is cached by its shader code, and the later flip finds it. */
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

/** Warm every shadow-depth pipeline a caster will need, through the
 *  conductor. `getMeshes` is re-read when the item RUNS, so a caster
 *  released while queued warms nothing. Resolves when done (or when the
 *  warm is unsupported — the caller's flip then behaves exactly as today). */
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
