// Test stand-in for client/lib/world.js AND client/lib/colliders.js — see
// tools/parts-test.ts. Both resolve here so the test never drags in the
// renderer cone.
export const entities = new Map();
export const comps = new Map();
export const entityMeta = new Map();
export const bagOf = (id) => comps.get(id) ?? null;
export function* bags() { yield* comps; }
export const metaOf = (id) => entityMeta.get(id) ?? null;
export const reindexCollider = () => {};

// motion.js's import cone reaches ragdoll.js, which imports resolveColliders from this stubbed './colliders.js';
// nothing here collides, so return the bare terrain height
export const resolveColliders = (pos, terrainAt) => terrainAt(pos.x, pos.z);

// remotes.js (same cone) reads the mount table; nothing here mounts, so an empty table and a null mountTransform (an
// occupant with no mount) are the honest stubs
export const avatarMounts = new Map();
export const mountTransform = () => null;

// same contract as world.js findPart: name → node, misses retry after 1s
const _partCache = new WeakMap();
export function findPart(root, name) {
  let map = _partCache.get(root);
  if (!map) { map = new Map(); _partCache.set(root, map); }
  const hit = map.get(name);
  if (hit && (hit.obj || Date.now() - hit.at < 1000)) return hit.obj;
  let found = null;
  root.traverse((c) => { if (!found && c !== root && c.name === name) found = c; });
  map.set(name, { obj: found, at: Date.now() });
  return found;
}
