// autohooks — ownership marks for the engine's per-frame hook array (globalThis._autoParticleSystems).
// A claim-by-diff (the sky) must skip marked hooks, or it steals one registered mid-build and later removes it.

/** Never capture it in a module const: the toolkit makes it lazily and this file may load first. */
export const autoHooks = () => (globalThis._autoParticleSystems ||= []);

/** By identity, not index. */
const hostOwned = new Set();

/** For a hook upstream code pushed for us (makeParticles registers its own billboard update). */
export function ownHook(fn) {
  if (typeof fn === 'function') hostOwned.add(fn);
  return fn;
}

export function pushHostHook(fn) {
  autoHooks().push(ownHook(fn));
  return fn;
}

/** By IDENTITY; returns whether it was in the array. Safe to call twice. */
export function releaseHook(fn, autos = autoHooks()) {
  if (typeof fn !== 'function') return false;
  hostOwned.delete(fn);
  if (!Array.isArray(autos)) return false;
  const i = autos.indexOf(fn);
  if (i >= 0) autos.splice(i, 1);
  return i >= 0;
}

export const isHostOwned = (fn) => hostOwned.has(fn);

/** New since `before` (snapshotted at build start) AND unmarked: a hook registered mid-build isn't the builder's. */
export function claimUnowned(before, autos = autoHooks()) {
  const seen = before instanceof Set ? before : new Set(before ?? []);
  return (autos ?? []).filter((h) => !seen.has(h) && !hostOwned.has(h));
}

/** Test seam. */
export const hostOwnedCount = () => hostOwned.size;
