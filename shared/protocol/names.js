// shared/protocol/names.js — the ONE mapping from an engine name (actor, entity id, role key, component name) to the §2.3
// grammar, shared by translator and live authority: spelled two ways, nobody in a translated world would match their own role.
//
//   enc(s)     an identity / entity id / key: [a-z0-9-]{1,64}. A name the grammar already accepts, and that doesn't
//              start with an escape prefix, is kept as it is. Anything else becomes "x--" + hex(utf8) or, when that
//              would pass 64 characters, "h--" + the first 61 hex of its sha256 (not invertible: decode says so).
//              An id already hashed is kept: it's what readers hold and send back.
//   encName(s) a component name: [a-z][a-z0-9-]* (+ domain/version/key per §2.3). A name the grammar accepts is
//              kept; anything else is escaped the same way (x--/h--, which start with a letter), except the hashed form.
//   dec(s)     the inverse of enc for x-- names, but for a lone surrogate (below), which comes back as U+FFFD; null for
//              an h-- name (a hash can't be read back).
//
// Injective but for two cases, neither reachable on import (encRaw/encNameRaw escape the hashed form; a lone surrogate
// fails the strict reader): a literal name in the hashed form (HASHED), and names differing only in a lone surrogate
// (both written as U+FFFD's bytes). A refused component name always takes the x-- form, never a letter prefix, so
// "0abc" and "n0abc" can't collide. See docs/research/name-escaping.md.
import { sha256, utf8Hex } from "./hash.js";
import { isComponent } from "./fold.js";

const ESC = /^[xh]--/;
// a hashed id is the one spelling the view can't decode, so readers send it back as is and enc keeps it. Anyone can write a
// name's sha256 spelling as a literal name, which then encodes to the same key (what import does with both is above)
const HASHED = /^h--[0-9a-f]{61}$/;
const escape = (s) => { const hex = utf8Hex(s); return hex.length + 3 <= 64 ? `x--${hex}` : `h--${sha256(s).slice(0, 61)}`; };

/** @param {unknown} s @returns {string} */
export function enc(s) {
  s = String(s);
  return HASHED.test(s) || (/^[a-z0-9-]{1,64}$/.test(s) && !ESC.test(s)) ? s : escape(s);
}
/** @param {unknown} s @returns {string} */
export function encName(s) {
  s = String(s);
  return HASHED.test(s) || (isComponent(s) && !ESC.test(s)) ? s : escape(s);
}
/** For a name that was never an id (an old log's, for the translator): one already in the hashed form is escaped, never
 *  kept, or it would become that long name's id.
 *  @param {unknown} s @returns {string} */
export function encRaw(s) {
  s = String(s);
  return /^[a-z0-9-]{1,64}$/.test(s) && !ESC.test(s) ? s : escape(s);
}
/** @param {unknown} s @returns {string} */
export function encNameRaw(s) {
  s = String(s);
  return isComponent(s) && !ESC.test(s) ? s : escape(s);
}
/** motion:<partSlot(node)> {node, …}. A node's name is DATA: a valid §2.3 tag that isn't an escape is its own tag; any other
 *  is lowercased, dashed, cut to 48 and given 8 hex of its sha256 ("Tripo_Part" and "tripo-part" still differ). Readers never
 *  parse it, they read `node`.
 *  @param {unknown} node @returns {string} */
export function partSlot(node) {
  const s = String(node);
  if (/^[a-z0-9-]{1,64}$/.test(s) && !ESC.test(s)) return s;
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return `${base || "node"}-${sha256(s).slice(0, 8)}`;
}
// the node a motion moves: a keyed motion's `node`, else its key's tag (older), else a whole motion's `part` (oldest);
// null = the whole thing. The one reading every reader shares.
/** @param {string} key @param {any} m @returns {string | null} */
export function motionNode(key, m) {
  if (key === "motion") return m && typeof m.part === "string" && m.part ? m.part : null;
  if (typeof key !== "string" || !key.startsWith("motion:")) return null;
  return m && typeof m.node === "string" && m.node ? m.node : key.slice(7);
}

// a motion's type: the old spelling (OLD_MOTION_TYPES) is now `oscillate`, READ for one release (the door stores today's,
// shaperepair.js renameFields renames stored ones). Spelled here only (tools/protocol/vocab-check.ts).
export const OLD_MOTION_TYPES = Object.freeze({ bob: "oscillate" });
/** @param {any} m a motion value @returns {any} its type in today's spelling (anything else as it is) */
export function motionType(m) {
  const t = m?.type;
  return typeof t === "string" && Object.hasOwn(OLD_MOTION_TYPES, t) ? OLD_MOTION_TYPES[t] : t;
}

/** @param {string} s @returns {string | null} the original name, or null when it was hashed (h--) */
export function dec(s) {
  if (typeof s !== "string") return null;
  if (s.startsWith("h--")) return null;
  if (!s.startsWith("x--")) return s;
  const hex = s.slice(3);
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)))); }
  catch { return null; }
}

// ---- display names for actors ----
// An actor is an opaque id (u- + 20 base32); its name lives in the directory, outside the log (§2.3).
// actorName(id): the name, else an escaped identity read back, else the id.
export const ACTOR_ID = /\bu-[a-z2-7]{20}\b/g;
const NAMES = Object.create(null);
export function learnNames(o) { if (o && typeof o === "object") for (const [k, n] of Object.entries(o)) if (typeof n === "string" && n) NAMES[k] = n; }
export const actorName = (id) => NAMES[String(id)] ?? dec(String(id)) ?? String(id);
