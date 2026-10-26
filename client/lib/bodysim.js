// bodysim — the body-physics engine is a CHOICE, not a fact of the client.
//
// Engines, one interface (the contract prose lives in ammodoll.js's header;
// it descends from the retired rapierdoll's — §24j retirement, survey B2):
// the pure-JS Verlet that shipped first, and the Bullet (ammo.js) rig ported
// from socketteer/ragdoll-physics. The Rapier articulated solver is RETIRED
// (2026-08-27): panel-only reachability, no hair/finger/wing parity, flat
// ground, and a permanent two-way divergence tax on every physics fix — its
// one unshipped capability (decaying tone motors) is recoverable from git
// history and tools/rapier-spike.ts if ever wanted. Everything
// downstream — goLimp, drag, nails, the presence stream — asks this factory
// and cannot tell which engine answered. A world mod can swap engines through
// EW.bodysim: the lease thesis applied to our own house physics.

import { Ragdoll } from './ragdoll.js';
import { report } from './base.js';

const KEY = 'ew-bodysim';

// name → { load, cls, failed }. Verlet is the floor: always present, needs no
// wasm door, and every other engine's failure lands on it. Order here is the
// order the 🧩 panel cycles through.
const ENGINES = new Map([
  ['verlet', { load: null, cls: Ragdoll, failed: false }],
  ['ammo', {
    load: async () => {
      const mod = await import('./ammodoll.js');
      return (await mod.ensureAmmo()) ? mod.AmmoRagdoll : null;
    }, cls: null, failed: false,
  }],
]);

// Default is Bullet; while its wasm warms (or if it never opens) falls run verlet, and a stored choice always wins.
const stored = localStorage.getItem(KEY);
let engine = ENGINES.has(stored) ? stored : 'ammo';

async function loadEngine(name) {
  const e = ENGINES.get(name);
  if (!e) return false;
  if (e.cls) return true;
  e.failed = false;
  try {
    const cls = await e.load();
    if (cls) { e.cls = cls; return true; }
  } catch (err) { report(`${name} load`, err); }
  // A door that never opens must SAY so. Reporting "loading" forever is
  // indistinguishable from a toggle that does not work, and that ambiguity
  // cost a full round of debugging the wrong engine.
  e.failed = true;
  return false;
}
if (engine !== 'verlet') loadEngine(engine);   // warm the wasm before the first fall

/** Status string, not a bare id: while a wasm engine loads (or after it fails)
 *  the string says which engine actually answers the next fall. */
export const bodyEngine = () => {
  if (engine === 'verlet') return 'verlet';
  const e = ENGINES.get(engine);
  if (e?.cls) return engine;
  return e?.failed ? `${engine} FAILED TO LOAD — running verlet`
                   : `${engine} (loading — verlet meanwhile)`;
};

/** The selected engine's bare id (the status string above is for humans). */
export const currentBodyEngine = () => engine;

/** Registered engine ids, in panel-cycle order. */
export const listBodyEngines = () => [...ENGINES.keys()];

export function setBodyEngine(name) {
  engine = ENGINES.has(name) ? name : 'verlet';
  localStorage.setItem(KEY, engine);
  const e = ENGINES.get(engine);
  if (e?.load && !e.cls) loadEngine(engine);
}

/** The one door every fall goes through; same signature as `new Ragdoll`. seedVel is LOAD-BEARING: main.js passes
 *  the drag-release handover as the 4th argument, and dropping it silently resets every release. */
export function makeRagdoll(avatar, lean = null, rest = null, seedVel = null) {
  // A kneeling pose hands its hip drop to the root (avatar.js bakeHipsIntoRoot), so re-read rest: the sim measures
  // its hips offset against it.
  if (avatar.bakeHipsIntoRoot?.() && rest) rest = avatar.restBonePositions();
  const e = ENGINES.get(engine);
  if (e?.cls && e.cls !== Ragdoll) {
    try { return new e.cls(avatar, lean, rest, seedVel); }
    catch (err) { report(`${engine} construct — verlet fallback`, err); }
  }
  return new Ragdoll(avatar, lean, rest, seedVel);
}
