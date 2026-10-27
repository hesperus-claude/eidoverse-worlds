// warmqueue — one serialized queue for pipeline warms (GLB libs, terrain, sky, shadow depth); compiles must not fight.
// Between items a real rAF yield, never scheduler.yield (it starves rAF on Chromium). TEL0S_NOTES.md §16.

import { renderer, scene, sun, camera, THREE, TSL } from './core.js';
import { beginWork, nextFrame } from './loadwork.js';
import { turn, spent, reportPending } from './framebudget.js';

// ---- the queue --------------------------------------------------------------

const queue = [];
let running = false;
const stats = { queued: 0, done: 0, failed: 0, lastLabel: null };

// classes, so ambient compiles never queue ahead of the terrain the curtain waits on; FIFO within a class
export const P_GATE = 0;     // arrival waits on this (terrain)
export const P_MODEL = 1;    // a thing someone is about to see (default)
export const P_AMBIENT = 2;  // sky domes, shadow-depth variants

/** Never rejects: errors are counted in warmStats(). */
export function warm(label, fn, { p = P_MODEL } = {}) {
  return new Promise((resolve) => {
    // starts at enqueue: queue time must not masquerade as work time
    const work = beginWork(label);
    work.phase('queued');
    const item = { label, fn, work, resolve, p };
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
      // charges only the synchronous head; later codegen and the driver link aren't measurable here, so for
      // warms the budget gates when an item STARTS
      const t0 = performance.now();
      const p = item.fn();
      spent('warm', performance.now() - t0, t0, grant);
      await p;
      stats.done++;
    } catch (e) {
      stats.failed++;
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
// compile a caster's depth pipelines before castShadow flips, so the real pass is a cache hit — see docs/research/shadow-depth-prewarm.md
// warmMat is pre-set to the post-mutation state because renderObject restores before compileAsync's deferred codegen

const SHADOW_SIDE = {
  [THREE.FrontSide]: THREE.BackSide,
  [THREE.BackSide]: THREE.FrontSide,
  [THREE.DoubleSide]: THREE.DoubleSide,
};

let warmMat = null;       // value-identical to three's shadow-pass material
let baseColorNode = null; // vec4(0,0,0,1), inlined by value in WGSL
let scratchRT = null;     // format-matched fallback target (never drawn into)
let depthWarmBroken = new URLSearchParams(globalThis.location?.search ?? '').has('nodepthwarm');   // ?nodepthwarm=1 bypasses the pre-warm: tells a wrong warmed pipeline from a driver compare issue

function ensureDepthWarm() {
  if (warmMat) return true;
  if (depthWarmBroken) return false;
  // the one internal this leans on; if a three update moves it, degrade loudly to compiling in-frame
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

// else a 4×4 scratch RT with setupRenderTarget's formats: only formats enter the pipeline key
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

/** the exact state renderObject() leaves the per-light shadow material in, so restore is identity */
function configureFor(m) {
  const sn = renderer._getShadowNodes(m); // cached on the renderer: the same instances the real pass uses
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
  // else a multi-material mesh's second round reuses the first's builder state
  warmMat.needsUpdate = true;
}

// per unique material: a multi-material mesh's groups dedupe to the same pipeline key
async function compileDepthRound(mesh, material) {
  configureFor(material);
  const saveVisible = mesh.visible;
  const saveCulled = mesh.frustumCulled;
  const prevOverride = scene.overrideMaterial;
  const prevTarget = renderer.getRenderTarget();
  mesh.visible = true;         // compile's projectObject skips invisible
  mesh.frustumCulled = false;  // …and out-of-frustum
  scene.overrideMaterial = warmMat;
  renderer.setRenderTarget(warmTarget());
  let compiled;
  try {
    // live scene: env/fog inputs match the real pass (both inert for an unlit shadow material)
    compiled = renderer.compileAsync(mesh, sun.shadow.camera, scene);
  } finally {
    // same synchronous block: no frame can observe these mutated
    renderer.setRenderTarget(prevTarget);
    scene.overrideMaterial = prevOverride;
    mesh.visible = saveVisible;
    mesh.frustumCulled = saveCulled;
  }
  await (compiled?.catch(() => {}) ?? Promise.resolve());
}

/** receiveShadow is in the render-object cache key: unwarmed, the first lit frame builds a program per material */
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

/** `getMeshes` is re-read when the item runs, so a caster released while queued warms nothing. */
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
        await nextFrame();
      }
    }
  }, { p: P_AMBIENT });
}
