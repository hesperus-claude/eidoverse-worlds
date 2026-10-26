// emitter_field — the `particles` component's LIFECYCLE, DOM-free and
// THREE-free so it can be unit-tested without a browser (tools/particles-test.ts).
//
// Upstream particles.js gives no undo, so this registry owns every emitter's lifecycle. Apply and remove are
// idempotent; a build that lands after its entity changed retires itself.

import { releaseHook } from './autohooks.js';

/**
 * Retire one built emitter completely (hook, GPU resources, mesh); safe twice. Hooks come off by IDENTITY,
 * never index: the array is global and shared.
 */
export function retireEmitter(handle, autos) {
  if (!handle || handle.retired) return;
  handle.retired = true;
  const hooks = handle.hooks ?? (handle.update ? [handle.update] : []);
  for (const h of hooks) releaseHook(h, autos);
  try {
    handle.dispose?.();
  } catch { /* a failed teardown must not strand the registry entry */ }
}

/**
 * Give back a RAW upstream system that no handle owns yet (adoptSystem unwinds to this if a host step throws).
 * Disposes geometry and material, never the texture: it is cached and shared (emitters.js).
 */
export function retireRawSystem(sys, autos) {
  if (!sys || sys.__retired) return;
  sys.__retired = true;
  releaseHook(sys.update, autos);
  const mesh = sys.mesh;
  if (!mesh) return;
  try {
    mesh.parent?.remove?.(mesh);
    mesh.geometry?.dispose?.();
    const m = mesh.material;
    if (Array.isArray(m)) m.forEach((x) => x?.dispose?.()); else m?.dispose?.();
  } catch { /* a failed teardown must not mask the error that caused it */ }
}

/**
 * Run the host's attach steps over a fresh upstream system, unwinding it if any throws (no handle exists yet).
 */
export function adoptSystem(sys, autos, attach) {
  try {
    return attach(sys);
  } catch (e) {
    retireRawSystem(sys, autos);
    throw e;
  }
}

/**
 * The world's emitter registry. `build(emitter, {id})` (THREE-bound) returns or resolves to a handle
 * `{mesh?, update?, hooks?, dispose()}`; `autos` = globalThis._autoParticleSystems.
 * `apply(id, emitter)` is the fold's ONLY entry point: an emitter to attach or replace, `null` to end it.
 */
export function makeEmitterRegistry({ autos, build, onError } = {}) {
  /** id -> { gen, key, handle|null, emitter } — one live emitter per entity. */
  const live = new Map();
  let gen = 0;

  const keyOf = (emitter) => (emitter ? JSON.stringify(emitter) : null);

  async function apply(id, emitter) {
    const key = keyOf(emitter);
    const cur = live.get(id);
    // an identical bag (a replay) must not rebuild: it would churn GPU resources and re-register a hook
    if (cur && cur.key === key) return cur.handle;

    const mine = ++gen;
    // Retire the old one FIRST. Replacement is not two emitters overlapping
    // for the duration of an await: the world says one thing is burning there.
    if (cur) {
      retireEmitter(cur.handle, autos);
      live.delete(id);
    }
    if (!emitter) return null;

    const slot = { gen: mine, key, handle: null, emitter };
    live.set(id, slot);
    let handle = null;
    try {
      handle = await build(emitter, { id });
    } catch (e) {
      if (live.get(id) === slot) live.delete(id);
      onError?.(e, id);
      return null;
    }
    // The entity was replaced, removed, or the world was cleared while the
    // texture downloaded. Whatever we just built belongs to nobody: retire it
    // here or it is a mesh in the scene with no entry to reach it by.
    if (live.get(id) !== slot) {
      retireEmitter(handle, autos);
      return null;
    }
    slot.handle = handle;
    return handle;
  }

  function retire(id) {
    const cur = live.get(id);
    if (!cur) return false;
    live.delete(id);           // delete BEFORE retiring: an in-flight build
    retireEmitter(cur.handle, autos);  // sees the slot is gone and retires itself
    return true;
  }

  function retireAll() {
    for (const id of [...live.keys()]) retire(id);
  }

  return {
    apply,
    retire,
    retireAll,
    has: (id) => live.has(id),
    get: (id) => live.get(id)?.handle ?? null,
    emitterOf: (id) => live.get(id)?.emitter ?? null,
    /** The same emitter stops or resumes spawning (emitters.js's playing-only path): the slot's key follows, so the bag it
     *  now matches is recognised as already applied. */
    setPlaying(id, on) { const s = live.get(id); if (!s) return false; s.emitter.playing = on; s.key = keyOf(s.emitter); s.handle?.setEmitting?.(on); return true; },
    get size() { return live.size; },
  };
}
