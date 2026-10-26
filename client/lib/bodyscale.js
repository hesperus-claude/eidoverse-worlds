// bodyscale — the wearer's chosen size u and nameplate lift for the body they have on (Profile › Avatar). Pure
// (tools/bodyscale-test.ts). Size lives on vrm.scene, never the root (plates stay screen-sized); in VR the tracking space
// scales by u too, so tracking stays 1:1 — see docs/research/body-scale-vr.md.
import { clampBodyScale, clampPlateY, BODY_SCALE_MIN, BODY_SCALE_MAX, PLATE_Y_MIN, PLATE_Y_MAX } from '../../shared/presencewire.js';
import { capsule, canMantle } from '../../shared/mover.js';
export { clampBodyScale, clampPlateY, BODY_SCALE_MIN, BODY_SCALE_MAX, PLATE_Y_MIN, PLATE_Y_MAX };

/** The VR composition. u = chosen size, k = measured device ratio (avatar eye / your eye; 1 unmeasured).
 *  → { body: what vrm.scene wears, rig: what the tracking space wears, puppet: the device fit alone } */
export function xrScales(u, k) {
  const uu = clampBodyScale(u), kk = typeof k === 'number' && k > 0 && Number.isFinite(k) ? k : 1;
  return { puppet: 1 / kk, body: uu / kk, rig: uu };
}

/** A head height measured in the WORLD while presenting, back into the playspace (rig-local) units k is defined in. */
export const toRigLocal = (worldY, rigScale) => worldY / (rigScale > 0 ? rigScale : 1);

/** The desktop follow camera's standing eye (controller.js: 1.45 m over the root for a 1.0 body). */
export const DESK_EYE = 1.45;
export const deskEyeY = (u) => DESK_EYE * clampBodyScale(u);

/** Move speed for a size: stride grows with the legs. */
export const scaledSpeed = (base, u) => base * clampBodyScale(u);

/** A ledge the body can climb onto (controller.js's mantle): over the mover's step (what it walks onto) up to its
 *  height, in proportion to the size. Jump height and gravity stay absolute — the mantle is a judgement about the
 *  body, the jump is physics. The mover's (shared/mover.js), so the client, the agent and the authority agree. */
export { canMantle };
/** How far onto the ledge the mantle carries the root. */
export const mantleStep = (u) => 0.6 * clampBodyScale(u);

/** The walking capsule (colliders.resolveColliders r / tall): the mover's body, grown with the size; a scaled body
 *  still climbs. */
export const colliderFor = (u) => { const c = capsule(u); return { r: c.r, tall: c.tall }; };

/** A locomotion clip's playback rate: a u× body covers u× the ground per cycle, so the same speed is 1/u the cadence.
 *  Same clamp as Avatar.setClip always used. */
export function clipRate(speed, natural, u) {
  const nat = natural * clampBodyScale(u);
  return nat > 0 && speed > 0 ? Math.min(1.6, Math.max(0.6, speed / nat)) : 1;
}

/** Where the plate hangs above the crown, WORLD metres: the authored lift × the live model→world scale. */
export const plateLift = (plateY, s) => clampPlateY(plateY) * (typeof s === 'number' && s > 0 ? s : 1);

// ---- per body, per browser (like ew-xr-scale: keyed by the worn body's NAME) ----
export const PREFS_LS = 'ew-body-prefs';
function readAll(storage) {
  try { const v = JSON.parse(storage?.getItem(PREFS_LS) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  catch { return {}; }
}
/** → { scale, plateY } for this body name, defaults when unknown/garbled. */
export function loadBodyPrefs(storage, name) {
  const v = name ? readAll(storage)[name] : null;
  return { scale: clampBodyScale(v?.scale), plateY: clampPlateY(v?.plateY) };
}
/** Merge a change for this body name and persist. Defaults are forgotten, not stored. → the stored { scale, plateY }. */
export function saveBodyPrefs(storage, name, patch) {
  const cur = loadBodyPrefs(storage, name);
  const next = { scale: clampBodyScale(patch?.scale ?? cur.scale), plateY: clampPlateY(patch?.plateY ?? cur.plateY) };
  if (!name) return next;
  const all = readAll(storage);
  if (next.scale === 1 && next.plateY === 0) delete all[name]; else all[name] = { ...next, t: Date.now() };
  try { storage?.setItem(PREFS_LS, JSON.stringify(all)); } catch { /* private mode */ }
  return next;
}
