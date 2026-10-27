// shared/protocol/refusal.js — how an authority refusal reads, so edit mode and a tool caller see the same words (PARITY).
// The reply is {ok: false, refused: {code, reason, fix, …}}; `what` names the request. The tool's raw JSON is untouched.
import { dec, actorName, ACTOR_ID } from "./names.js";

// an actor id (u-…) reads as its display name (names.js registry); an escaped name reads back as spelled
const readable0 = (s) => String(s).replace(ACTOR_ID, (m) => actorName(m)).replace(/\bx--(?:[0-9a-f]{2})+\b/g, (m) => dec(m) ?? m);
const readable = readable0;

export function refusalText(what, reply) {
  const r = reply?.refused ?? {};
  return readable(`${what} refused by the authority (${r.code ?? "refused"}): ${r.reason ?? ""}${r.fix ? ` — ${r.fix}` : ""}`);
}

// ---- for the editor's reader ----
// What they tried and why in words: no code or tool syntax (fix kept only when plain), things named by label (`nameOf(id)`).
const TOOLISH = /[{}[\]`]|=>|\w\s*\(|\b\w+:\s*['"\d[{tf]|throughLock|merge: true/;
/** Ids in a sentence → names a person knows (a dotted path "lamp.light.intensity" → "Lamp's light intensity"). */
export function namedFor(text, nameOf = () => null) {
  return readable(String(text)).replace(/(?<![\w@-])([a-z0-9][a-z0-9-]{0,63})((?:\.[a-zA-Z][\w-]*(?::[\w-]+)?)*)(?![\w-])/g, (m, id, path) => {
    const n = nameOf(id); if (!n) return m;
    return path ? `${n}'s ${path.slice(1).split(".").join(" ")}` : n; });
}
/** "Couldn't move the crate: …" — a refusal as a person reads it. */
export function plainRefusal(what, reply, nameOf = () => null) {
  const r = reply?.refused ?? {};
  const fix = typeof r.fix === "string" && r.fix && !TOOLISH.test(r.fix) ? r.fix : "";
  const reason = String(r.reason ?? "it wasn't allowed").replace(/\s*\(§[^)]*\)/g, "");
  return namedFor(`Couldn't ${what}: ${reason}${fix ? `. ${fix.replace(/^./, (c) => c.toUpperCase())}` : ""}`, nameOf);
}

// ---- the lock question (PROTOCOL §5; research 44 #1) ----
// A person who may lift locks is asked "This is locked. Move anyway?" with three answers; an agent gets the same text and
// the same two ways through in the fix (throughLock, or unlock first).

/** The verb a lock refusal asks about: what the request would do to the locked thing. */
export function lockVerb(req) {
  if (req?.verb === "undo") return "Undo";
  const ops = req?.verb === "batch" ? (req.args?.ops ?? []) : [req];
  const comp = (o) => o?.args?.component;
  if (ops.some((o) => o?.verb === "delete" && comp(o) === undefined)) return "Delete";
  if (ops.some((o) => o?.verb === "set" && comp(o) === "model")) return "Replace";
  if (ops.some((o) => o?.verb === "place" || ((o?.verb === "set" || o?.verb === "delete") && ["transform", "parent"].includes(comp(o))))) return "Move";
  return "Change";
}
/** "This is locked. Move anyway?" */
export const lockQuestion = (verb) => `This is locked. ${verb} anyway?`;
/** Who locked it, and which thing when the lock is on a parent. The full refusal (teaching for agents) stays in log and console. */
export function lockBody(r, id, nameOf = null) {
  const k = r?.refused?.lock; const by = r?.refused?.by;
  const who = by ? ` by ${readable(by)}` : "";
  // the locked thing by its label or what it is (ids are opaque); with no nameOf, readable(k): the id
  return k && id && k !== id ? `It rides ${(nameOf && nameOf(k)) || readable(k)}, which is locked${who}.` : `Locked${who}.`;
}
/** `through` re-sends with throughLock (one act, the lock stays); `cancel` writes nothing and puts the thing back; `unlock`
 *  removes the lock then does it (two acts; Ctrl+Z undoes the edit first). */
export const lockChoices = (verb) => [
  { v: "through", label: `✓ ${verb} anyway` },
  { v: "cancel", label: "✕ Cancel" },
  { v: "unlock", label: "🔓 Unlock" },
];

/** An authority warning ({id, kind, …}) as one sentence for a person or an agent. */
export function warningText(w, nameOf = null) {
  if (!w || typeof w !== "object") return String(w);
  const readable = (x) => (nameOf ? namedFor(x, nameOf) : readable0(x));   // a person's surface names things by label
  const id = readable(w.id ?? "?");
  switch (w.kind) {
    case "overlap": return `${id} overlaps ${readable(w.with)} by ${w.by} m`;
    case "sunk": return `${id} sinks ${w.depth} m into ${readable(w.into)}`;
    case "floating": return `${id} floats ${w.gap} m above ${readable(w.above)}`;
    case "out-of-bounds": return w.bounds ? `${id} is outside the world's bounds (x ${w.bounds.min[0]}…${w.bounds.max[0]}, y ${w.bounds.min[1]}…${w.bounds.max[1]}, z ${w.bounds.min[2]}…${w.bounds.max[2]} m)` : `${id} is outside the world's bounds`;
    default: return `${id}: ${w.kind ?? JSON.stringify(w)}`;
  }
}

/** How long ago, in words a person reads at a glance. */
export function agoWords(ts, now = Date.now()) {
  const s = Math.max(0, (now - ts) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(ts).toISOString().slice(0, 10);
}
/** One component's provenance from inspect's `touched`, the same words in the Inspector and an agent's inspect: "set by <name> ·
 *  3 min ago", or past the window "unchanged since before act #N — history for older". Never claims more than the window saw. */
export function touchWords(t, now = Date.now()) {
  if (!t) return null;
  if (t.beyond !== undefined) return `unchanged since before act #${t.beyond} — history for older`;
  return `${t.created ? "as made by" : "set by"} ${readable(t.by)} · ${agoWords(t.ts, now)}`;
}
