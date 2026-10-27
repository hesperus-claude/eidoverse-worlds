// bodysim — the body-physics engine is a CHOICE: Verlet or Bullet (ammo.js), one interface (contract: bodyengine.js header).
// Downstream (goLimp, drag, nails, presence) can't tell which answered; a world mod swaps engines through EW.bodysim.
// Rapier is retired (§24j); its decaying tone motors survive in tools/rapier-spike.ts.

import { Ragdoll } from './ragdoll.js';
import { report } from './base.js';

const KEY = 'ew-bodysim';

// name → { load, cls, failed }; Verlet is the floor every failure lands on. Order = the 🧩 panel's cycle.
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
  // a door that never opens must SAY so: "loading" forever looks like a broken toggle
  e.failed = true;
  return false;
}
if (engine !== 'verlet') loadEngine(engine);   // warm the wasm before the first fall

/** Says which engine actually answers the next fall while a wasm engine loads or after it fails. */
export const bodyEngine = () => {
  if (engine === 'verlet') return 'verlet';
  const e = ENGINES.get(engine);
  if (e?.cls) return engine;
  return e?.failed ? `${engine} FAILED TO LOAD — running verlet`
                   : `${engine} (loading — verlet meanwhile)`;
};

/** Bare id; the status string above is for humans. */
export const currentBodyEngine = () => engine;

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
  // re-read rest: a kneeling pose hands its hip drop to the root (avatar.js bakeHipsIntoRoot)
  if (avatar.bakeHipsIntoRoot?.() && rest) rest = avatar.restBonePositions();
  const e = ENGINES.get(engine);
  if (e?.cls && e.cls !== Ragdoll) {
    try { return new e.cls(avatar, lean, rest, seedVel); }
    catch (err) { report(`${engine} construct — verlet fallback`, err); }
  }
  return new Ragdoll(avatar, lean, rest, seedVel);
}
