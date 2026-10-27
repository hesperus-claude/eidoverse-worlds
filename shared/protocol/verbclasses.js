// shared/protocol/verbclasses.js — the verb classes the authority and the ws door agree on. Pure data, no imports.
// Pinned by tools/protocol/verbclasses-check.ts; changing a class is a decision.

// verbs that write nothing to the log (the custody guard lets them through: a world you can't sign for can still be read)
export const READ_ONLY = new Set(["help", "look", "inspect", "measure", "find", "lint", "history", "schema", "scripts", "modlog", "bans", "effect"]);


// the authority's reads a SPECTATOR is refused at the door. Empty: scripts and effects are part of what a spectator sees,
// and reading changes nothing. Kept so a future gate is one entry here, not a second literal.
export const SPECTATOR_GATED = new Set([]);

// the door's reads: metered as reads and the only requests a spectator may send: the authority's reads less the gated ones,
// plus `wait` and `whois`. `inbox` is a body's, never a spectator's (no body to be asked).
export const WIRE_READS = new Set([...[...READ_ONLY].filter((v) => !SPECTATOR_GATED.has(v)), "wait", "whois"]);

// acts on a person: after one succeeds the server sweeps (expels, re-rolls badges) — not the authority's concern
export const PERSON_ACTS = new Set(["warn", "mute", "unmute", "kick", "ban", "unban"]);

// READBACK: old entry fields the AUTHORITY reads back (the fold never reads acts, §1); §12 may purge a body, so each goes
// through storage.js readback(w, seq), null = UNKNOWN, and the value says what the reader does then. A new readback is a
// new row here, never a bare `entries[seq].body` read. Keys are `<kind>:<verb>` (`act:*` = any act).
export const READBACK = Object.freeze({
  "act:undo":    { fields: ["undoes", "rollback.acts"], where: "buildUndo depthOf/undoneBy, the act index, history rows", unknown: "undoes nothing we can name: the chain ends there and its target isn't counted undone" },
  "act:use":     { fields: ["capability.author", "capability.reaction", "request.id"], where: "rights.js entryBy (creatorOf, lastSetterOf), undo of your own use", unknown: "rights null (matches nobody); undo falls back to your own rights" },
  "act:script":  { fields: ["sponsor"], where: "rights.js entryBy (sponsorOf), the sponsor budget", unknown: "no sponsor: nothing runs on nobody's rights" },
  "act:sculpt":  { fields: ["request.brush", "clamped"], where: "buildUndo sculptInverse", unknown: "not exact: restore-before (refused if changed since)" },
  "act:*":       { fields: ["request.label", "request.id", "request.component", "request (a physics-engine version it typed)"], where: "undo {label}, undo's reply, restampEngine's chose()", unknown: "no label match; an unknown chooser of an engine version is the owner's: never restamped" },
  "act:system":  { fields: ["rest", "id", "onto", "home"], where: "the act index (restAfter, per rest and body), recentRests and wait's lost notice", unknown: "no rest link; no `onto` in the view; a lost body whose return names no home reads as back where it was picked up" },
  "act:create-world": { fields: ["shapes"], where: "shaperepair shapesMarked (the once-per-world shape repair command, a founding made before the repair-shapes marker act)", unknown: "marked: a purged founding never re-runs the repair" },
  "act:translated":   { fields: ["from.translator"], where: "shaperepair shapesMarked (a translation by translate-v1@12 before the marker act)", unknown: "marked: a purged translation never re-runs the repair" },
  "sim:launch":  { fields: ["id", "handled"], where: "restampEngine's in-flight walk, recentRests", unknown: "maybe in flight: no restamp; handled falls back to the launch's actor" },
  "sim:lift":    { fields: ["id"], where: "restampEngine's in-flight walk, orphanLifts", unknown: "maybe held: no restamp" },
  "sim:catch":   { fields: ["id"], where: "restampEngine's in-flight walk, orphanLifts", unknown: "maybe held: no restamp" },
});
