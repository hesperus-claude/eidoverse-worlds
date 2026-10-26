// autohooks — who owns what in the engine's per-frame hook array.
//
// Ownership marks for the toolkit's global per-frame hook array (globalThis._autoParticleSystems). A subsystem
// that claims hooks by diffing the array (the sky) must skip marked hooks, or it steals one registered mid-build
// and later removes it. DOM/THREE-free; tested in tools/particles-test.ts.

/** The engine's hook array, created on demand. Never captured in a module
 *  const — the toolkit makes it lazily and this file may load first. */
export const autoHooks = () => (globalThis._autoParticleSystems ||= []);

/** Hooks a host subsystem owns and will retire itself. Identity, not index. */
const hostOwned = new Set();

/** Mark an already-registered hook as host-owned. Used when the hook was
 *  pushed by upstream code we called (makeParticles registers its own
 *  billboard update) rather than by us. */
export function ownHook(fn) {
  if (typeof fn === 'function') hostOwned.add(fn);
  return fn;
}

/** Register a host-owned per-frame hook. */
export function pushHostHook(fn) {
  autoHooks().push(ownHook(fn));
  return fn;
}

/** Unregister a hook by IDENTITY and drop its ownership mark. Returns whether
 *  it was actually in the array. Safe to call twice. */
export function releaseHook(fn, autos = autoHooks()) {
  if (typeof fn !== 'function') return false;
  hostOwned.delete(fn);
  if (!Array.isArray(autos)) return false;
  const i = autos.indexOf(fn);
  if (i >= 0) autos.splice(i, 1);
  return i >= 0;
}

export const isHostOwned = (fn) => hostOwned.has(fn);

/** What a claim-by-diff may call its own: hooks new since `before` (a Set snapshotted at build start) AND
 *  unmarked; a hook registered during the build is new but not the builder's. */
export function claimUnowned(before, autos = autoHooks()) {
  const seen = before instanceof Set ? before : new Set(before ?? []);
  return (autos ?? []).filter((h) => !seen.has(h) && !hostOwned.has(h));
}

/** Test seam: how many hooks are currently marked host-owned. */
export const hostOwnedCount = () => hostOwned.size;
