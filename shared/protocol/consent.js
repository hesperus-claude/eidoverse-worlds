// Body consent (PROTOCOL L6; research 42 §4). PRESENCE ONLY: never appended to a log or written to world state.
// The authority keeps one table per body in its presence plane and refuses before delivery; the target's client has the final word.
//   classes: near, follow, touch (social points), intimate (intimate points), pose, shove, displace, voice
//   silence is no: a body that never chose gets the default; an ask nobody answers within 20 s is a no.
// Old words (strangers, everyone|ask|nobody, move) are read on the wire (LEGACY_*), never written; migratePresence rewrites
// an old presence file at load. Enforced: touch/intimate, pose, shove, displace; near, follow and voice are not yet.
import { CONTACT_POINTS, canonicalPoint } from "../contact.js";
export const CLASSES = ["near", "follow", "touch", "intimate", "pose", "shove", "displace", "voice"];
export const ENFORCED = ["touch", "intimate", "pose", "shove", "displace"];
export const TIERS = ["everyone", "friends"];
export const MODES = ["allow", "ask", "deny"];
/** Old words, read on the wire and in a stored table; never written. */
export const LEGACY_TIER = Object.freeze({ strangers: "everyone" });
export const LEGACY_MODE = Object.freeze({ everyone: "allow", nobody: "deny" });
export const LEGACY_CLASS = Object.freeze({ move: "displace" });
const tierOf = (t) => (Object.hasOwn(LEGACY_TIER, t) ? LEGACY_TIER[t] : t);
const modeOf = (m) => (Object.hasOwn(LEGACY_MODE, m) ? LEGACY_MODE[m] : m);
const classOf = (c) => (Object.hasOwn(LEGACY_CLASS, c) ? LEGACY_CLASS[c] : c);
const NORMAL_FRIENDS = { near: "allow", follow: "allow", touch: "allow", intimate: "ask", pose: "ask", shove: "allow", displace: "ask", voice: "allow" };
export const PRESETS = {
  normal: { everyone: { near: "ask", follow: "ask", touch: "ask", intimate: "deny", pose: "deny", shove: "deny", displace: "deny", voice: "ask" }, friends: NORMAL_FRIENDS },
  open: { everyone: { near: "allow", follow: "ask", touch: "allow", intimate: "deny", pose: "ask", shove: "ask", displace: "ask", voice: "allow" }, friends: NORMAL_FRIENDS },
  "friends-only": { everyone: Object.fromEntries(CLASSES.map((c) => [c, "deny"])), friends: NORMAL_FRIENDS },
  performer: { everyone: { near: "allow", follow: "ask", touch: "allow", intimate: "deny", pose: "allow", shove: "allow", displace: "ask", voice: "allow" }, friends: NORMAL_FRIENDS },
};
export const DEFAULT_PRESET = "normal"; // never a property of what kind of participant it is (42 §4.3)
export const ASK_MS = 20000, COOL_MS = 600000;
// a reach the relay strips (server/reachgate.ts → authority.js reachAdmits) is told to the reacher once per
// (reacher, target, class) per this long: a stream of frames is one attempt, never one message a frame
export const REACH_NOTE_MS = 15000;
export const KIND_CLASS = { pose: "pose", anim: "pose", shove: "shove", drag: "displace", occupy: "displace", carry: "displace", touch: "touch" };
// touch is judged by where a hand is, not how it was aimed: ONE classifier (namedPointClass) for the relay, the reach verb and the agent
export const INTIMATE_POINTS = new Set(["chest_front", "waist_l", "waist_r", "hip_l", "hip_r"]);
export const REACH_POINTS = Object.keys(CONTACT_POINTS);
/** a named contact point (any spelling canonicalPoint takes) → { point (canonical), cls: touch | intimate }; null if not a point */
export function namedPointClass(name) { const point = canonicalPoint(name); return point ? { point, cls: INTIMATE_POINTS.has(point) ? "intimate" : "touch" } : null; }
// a yes is ONE touch and lasts at most COOL_MS even while held; letting go, leaving, or the cell moving off allow ends it sooner
export const REACH_GRANT_MS = COOL_MS;
// The asker hears the same words for every refusal (deny, per-person no, pause, ask refused or unanswered): the reason
// must never leak a per-person deny. The real cause (decide's why) goes to the target's own attempt ring only.
export const refusalWords = (to, cls) => `${to} isn't taking ${cls} right now`;
export const REFUSAL_FIX = "leave it be: it is theirs to open";
// a world-space point at a body: inside its capsule (r 0.25 m, feet to 1.8 m) is a touch; the torso/pelvis core is intimate
export function pointClass(bodyAt, p) {
  const h = Math.hypot(p[0] - bodyAt[0], p[2] - bodyAt[2]), y = p[1] - bodyAt[1];
  if (h > 0.25 + 0.05 || y < -0.05 || y > 1.85) return null; // TOUCH_GAP 5 cm (42 §4.5)
  return h <= 0.2 && y >= 0.8 && y <= 1.5 ? "intimate" : "touch";
}

/** What the authority holds for one body: its switch (undefined = never chosen) and its per-person answers. */
export function tableOf(P, who) { const t = P.consent?.[who]; return { switch: t?.switch, overrides: t?.over ?? {} }; }
// accept | ask | refuse, and what each means as a decision
export const SWITCHES = ["accept", "ask", "refuse"];
export const DEFAULT_SWITCH = "accept";   // a world's body-default changes it for people who haven't chosen
const SWITCH_MODE = { accept: "allow", ask: "ask", refuse: "deny" };
/** What `to` says about `from` doing class `cls` now: { mode: allow | ask | deny, why }. One order, every body kind:
 *  a per-person answer (yours, for that person) > your switch > the world's body-default > accept. */
export function decide(P, from, to, cls, now, worldDefault) {
  cls = classOf(cls); const t = tableOf(P, to);
  const o = t.overrides[from]?.[cls];
  if (o && (o.until === undefined || o.until > now)) return o.mode === "deny" ? { mode: "deny", why: `${to} said no to ${cls} from ${from}` } : { mode: "allow", why: `${to} allowed ${cls} from ${from}` };
  worldDefault ??= P.bodyDefault;   // the authority keeps P.bodyDefault = @world.body-default
  const which = t.switch ?? (SWITCHES.includes(worldDefault) ? worldDefault : DEFAULT_SWITCH);
  return { mode: SWITCH_MODE[which], why: t.switch !== undefined ? `${to}'s body is set to ${t.switch}` : `this world's default for bodies is ${which}` };
}
// Only you change your body's answers: no one decides for you.
// Names and classes arrive from the wire: every table is prototype-less and a "who" must look like an identity ('__proto__' once polluted Object.prototype).
const BAD_KEY = new Set(["__proto__", "constructor", "prototype"]);
const isWho = (w) => typeof w === "string" && /^[A-Za-z0-9_.:@+-]{1,64}$/.test(w) && !BAD_KEY.has(w);
const bag = () => Object.create(null);
export const RETIRED_CONSENT = ["preset", "set", "pause", "friend", "unfriend", "delegate", "undelegate", "of"];
export function setConsent(P, actor, a, now) {
  if (a == null || typeof a !== "object") return { ok: false, code: "shape", reason: "consent takes an object" };
  const gone = RETIRED_CONSENT.find((k) => a[k] !== undefined);
  if (gone) return { ok: false, code: "shape", reason: `consent has no '${gone}' since the switch replaced the table`, fix: `consent {switch: ${SWITCHES.join("|")}}, or {allow|deny: <who>, class?} for one person` };
  if (a.switch !== undefined && !SWITCHES.includes(a.switch)) return { ok: false, code: "shape", reason: `switch: one of ${SWITCHES.join(", ")}, got ${JSON.stringify(a.switch)}` };
  const who = a.allow ?? a.deny; const cls = a.class !== undefined ? [classOf(a.class)] : CLASSES;
  if (a.allow !== undefined || a.deny !== undefined) {
    if (!isWho(who)) return { ok: false, code: "shape", reason: "allow/deny: an identity" };
    if (!cls.every((c) => CLASSES.includes(c))) return { ok: false, code: "shape", reason: `class: one of ${CLASSES.join(", ")}` };
    // an allowance lasts its `for` (positive ms); with none it stands until revoked, as a deny does
    if (a.allow !== undefined && a.for != null && !(typeof a.for === "number" && a.for > 0)) return { ok: false, code: "shape", reason: `for: how long it lasts, in ms (a positive number), got ${JSON.stringify(a.for)}`, fix: "leave for out to allow until you revoke it" };
  }
  const t = ((P.consent ??= bag())[actor] ??= bag());
  if (a.switch !== undefined) t.switch = a.switch;
  if (a.allow !== undefined || a.deny !== undefined) {
    const until = a.allow !== undefined && a.for != null ? now + a.for : undefined;
    for (const c of cls) ((t.over ??= bag())[who] ??= bag())[c] = { mode: a.allow !== undefined ? "allow" : "deny", ...(until !== undefined ? { until } : {}) }; }
  return { ok: true, target: actor };
}
/** Shape of today's tables; P.consentShape marks the plane done. */
export const CONSENT_SHAPE = 3;
/** A pre-switch table becomes a switch only ever NARROWER than it was: paused, or any enforced class denied for everyone →
 *  refuse; else any ask → ask; else accept. Friends, delegates and presets go (a friend's wider answer is lost, never a
 *  stranger's narrower one); per-person answers stay. → tables changed; in place, idempotent. */
export function migratePresence(P) {
  if (!P || typeof P !== "object" || P.consentShape === CONSENT_SHAPE) return 0;
  let n = 0;
  for (const t of Object.values(P.consent ?? {})) { if (!t || typeof t !== "object") continue;
    for (const row of Object.values(t.over ?? {})) if (row && typeof row === "object" && Object.hasOwn(row, "move")) { if (!Object.hasOwn(row, "displace")) row.displace = row.move; delete row.move; }
    if (t.switch === undefined && (t.preset !== undefined || t.cells !== undefined || t.paused)) {
      const pre = PRESETS[t.preset] ?? PRESETS[DEFAULT_PRESET]; const row = { ...pre.everyone };
      for (const [tier, r] of Object.entries(t.cells ?? {})) if (tierOf(tier) === "everyone" && r && typeof r === "object") for (const [c, m] of Object.entries(r)) row[classOf(c)] = modeOf(m);
      const modes = ENFORCED.map((c) => row[c]);
      t.switch = t.paused || modes.includes("deny") ? "refuse" : modes.includes("ask") ? "ask" : "accept"; }
    for (const k of ["preset", "cells", "paused", "friends", "delegates"]) if (Object.hasOwn(t, k)) { delete t[k]; n++; } }
  for (const r of P.ring ?? []) if (r && Object.hasOwn(LEGACY_CLASS, r.cls)) r.cls = classOf(r.cls);
  for (const k of Object.values(P.asks ?? {})) if (k && Object.hasOwn(LEGACY_CLASS, k.cls)) k.cls = classOf(k.cls);
  for (const r of Object.values(P.reaches ?? {})) if (r && Object.hasOwn(LEGACY_CLASS, r.cls)) r.cls = classOf(r.cls);
  P.consentShape = CONSENT_SHAPE; return n;
}
