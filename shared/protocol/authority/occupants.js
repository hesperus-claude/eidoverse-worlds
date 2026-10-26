// shared/protocol/authority/occupants.js — who occupies what (presence, never logged): setting, clearing, vacating when the
// station is moved or let go; the occupant rule that keeps an occupied thing from being punted, pushed, grabbed or thrown
// out from under them; and occupyRights, a socket joining a host.
import { TRACK } from "../../mover.js";
import { baseOf } from "../componentspec.js";
import { offChain } from "../simlayer.js";
import { feetOn } from "../../shove.js";
import { r3 } from "../round.js";
import { UP } from "./ctx.js";
import { refuse, said } from "./refuse.js";
import { lockedC } from "./storage.js";
import { aabb, ancestors, descendants, worldT } from "./math.js";
import { isSocketC } from "./sockets.js";
// layers above this one (a leaf may not import them), through UP (ctx.js)
const lacks = (...a) => UP.lacks(...a);
const lastTouch = (...a) => UP.lastTouch(...a);
const lockCheck = (...a) => UP.lockCheck(...a);
const needWords = (...a) => UP.needWords(...a);

// A body that walks more than a metre from its seat has stood up (a seated client sends no steps).
// Who sits where (presence, never logged): {to: <socket id>}. A seat whose socket is gone or switched off is no seat, so a reader never sees one.
function occupantOf(w, st, who) { const s = w.presence.occupants?.[who];
  return s && typeof s.to === "string" && isSocketC(st.entities[s.to]?.c) && !offChain(st, s.to) ? s : null; }
// `since`: the log's length when they sat: what was written from then on isn't part of the seat's own motion they consented to
// `near`: tracked within sitting reach when it sat: only then does vacating re-anchor the track at the seat
const setOccupant = (w, who, to, near = false) => { (w.presence.occupants ??= {})[who] = { to, since: w.entries.length, ...(near ? { near: true } : {}) }; w.presenceDirty = true; };
const clearOccupant = (w, who) => { if (w.presence.occupants?.[who]) { delete w.presence.occupants[who]; w.presenceDirty = true; } };
// vacating is presence: the track restarts from the seat's world pose with a full speed budget, writing nothing, so the
// next step is never too-fast from the boarding point. Only with `near`. → where, or null.
function vacateAt(w, st, who, seat) {
  const b = w.presence.bodies?.[who]; if (!b || !st?.entities[seat] || w.presence.occupants?.[who]?.near !== true) return null;
  const at = worldT(st, seat).pos.map(r3); if (!at.every(Number.isFinite)) return null;
  w.presence.bodies[who] = { ...b, at, ts: w.pace ? w.pace() : w.now(), tokens: TRACK.cap }; w.presenceDirty = true;
  return at;
}
// another present body seated on this socket (one body per socket), or the thing sitting in it
function occupantOn(w, st, sock, actor) {
  for (const who of Object.keys(w.presence.occupants ?? {})) if (who !== actor && w.presence.bodies[who] && occupantOf(w, st, who)?.to === sock) return { who };
  const thing = Object.keys(st.entities).find((k) => st.entities[k].c.parent?.to === sock); return thing ? { thing } : null; }
function leftOccupied(w, st, actor, to) {
  const s = occupantOf(w, st, actor); if (!s) return clearOccupant(w, actor);
  const p = worldT(st, s.to).pos;
  if (Math.hypot(to[0] - p[0], to[2] - p[2]) > 1) clearOccupant(w, actor);
}
// Who a hand or foot acting on `id` would move: a present body seated or standing on it or on anything it carries (else a
// punt, push, grab or throw goes round body consent through the chair). Bodies are presence, never things: this is the
// only way one is moved by moving a thing.
function occupant(w, st, id, actor) {
  const fam = new Set([id, ...descendants(st, id)]);
  for (const who of Object.keys(w.presence.occupants ?? {})) { const s = occupantOf(w, st, who); if (who !== actor && s && fam.has(s.to)) return { who, how: "sits on" }; }
  const boxes = [...fam].map((k) => aabb(st, k)).filter(Boolean);
  for (const [who, b] of Object.entries(w.presence.bodies)) if (who !== actor && Array.isArray(b?.at) && boxes.some((x) => feetOn(x, b.at))) return { who, how: "is standing on" };
  return null;
}
// occupants: sitting is consent, standing up is the exit. An edit is never refused for a body on a seat:
//   - another's edit that moves an occupied seat (or what it hangs from) VACATES every occupant, standing, told why;
//   - the seat's own assembly (a reaction or script with the seat's root: a swing, a carousel) carries its occupants;
//   - moving the seat you sit on yourself keeps you seated (others are let go);
//   - a standing body never blocks an edit (a griefer can't freeze a stage by standing on it).
// Follow-ups, a hand, the maintenance lift and a fork's copy vacate no one.
const MOVES_BODIES = (comp) => comp === "transform" || comp === "parent" || baseOf(comp) === "motion";
function vacatesFor(w, st, who, norm) {
  const cap = who.cap; if (cap && ["rest", "system", "handle"].includes(cap.kind)) return [];
  const occupants = Object.keys(w.presence.occupants ?? {}).filter((k) => k !== who.actor); if (!occupants.length) return [];
  const rootOf = (id) => { const a = ancestors(st, id); return a.length ? a[a.length - 1] : id; };
  const from = cap?.kind === "reaction" ? cap.ids[0] : cap?.kind === "script" ? cap.id : null;   // the thing whose own behaviour this is
  const own = from && st.entities[from] ? rootOf(from) : null;
  // the exemption covers the assembly as it was when they sat: the handler or script, and every parent link from its host
  // to the root, last written before then. A reaction or child added since is someone's edit, not the seat's own motion
  // (a builder can't move an occupied seat in two steps)
  const key = cap?.kind === "reaction" ? "reactions" : cap?.kind === "script" ? cap.key : null;
  // (follow-ups aren't edits: a reference cleared on the seat since is skipped, as §5 says)
  const unchangedSinceSat = (since) => Number.isInteger(since) && [from, ...ancestors(st, from)].every((id, k) =>
    (lastTouch(w, id, "parent", { authored: true })?.seq ?? -1) < since && (k > 0 || (lastTouch(w, from, key, { authored: true })?.seq ?? Infinity) < since));
  const out = new Map();
  for (const op of norm) {
    if (op.verb === "create" || op.comp === undefined || !MOVES_BODIES(op.comp) || !st.entities[op.id]) continue;
    const fam = new Set([op.id, ...descendants(st, op.id)]);
    for (const r of occupants) { if (out.has(r)) continue; const s = occupantOf(w, st, r); if (!s || !fam.has(s.to)) continue;
      if (own && rootOf(s.to) === own && unchangedSinceSat(s.since)) continue;   // the occupant exemption
      out.set(r, { who: r, socket: s.to, host: st.entities[s.to]?.c.parent?.to ?? null, id: op.id, field: op.comp }); } }
  return [...out.values()];
}
const vacateWhy = (u) => `${u.id}.${u.field} was changed by someone else, and it moves what ${u.who} occupied: they were let go where they were, standing (occupying is consent to the seat's own motion, not to anyone's edit)`;
function occupiedRefuse(w, st, id, actor, what) {
  const o = occupant(w, st, id, actor);
  if (o) refuse("occupied", `${said(o.who)} ${o.how} ${id} (or something on it), so it can't be ${what}`, "wait till they get up or step off", { by: o.who });
}
// a socket is part of its host: JOINING one (made under it, re-parented onto it, a child made a socket) needs the host's
// rights, and every write touching a socket child meets the locks over its old and new host chains. Lifted legacy creates
// are in `norm`; a host made in this write is the asker's own.
function occupyRights(w, st, s, who, role, norm, made) {
  const cap = who.cap; if (cap && cap.kind !== "reaction" && cap.kind !== "script") return;
  const holder = cap?.kind === "reaction" ? cap.author : cap?.kind === "script" ? cap.sponsor : who.actor;
  const hosts = new Map(); const joins = new Set();
  for (const op of norm) { const was = st.entities[op.id]?.c, now = s.entities[op.id]?.c;
    const h0 = isSocketC(was) ? was.parent?.to : null, h1 = isSocketC(now) ? now.parent?.to : null;
    for (const h of [h0, h1]) if (h && !hosts.has(h)) hosts.set(h, op);
    if (h1 && h1 !== h0) joins.add(h1); }
  for (const [h, op] of hosts) { if (made.has(h) || !st.entities[h]) continue;
    const at = h + "'s sockets (" + op.verb + " " + op.id + (op.comp !== undefined ? "." + op.comp : "") + ")"; const as = { verb: "set", id: h, comp: "sockets" };
    // joining h needs h's rights; an edit of a socket already on h is judged on its own rights in rights() (its creator, or the lift's builder: RL4)
    const n = joins.has(h) ? lacks(w, st, holder, as, made, { viaCap: !!cap }) : null;
    const whose = cap ? " (" + said(holder) + "'s, whose rights this write carries)" : "; you are " + role;
    if (n) refuse("rights", "a socket is part of its host, so " + op.id + " is an edit of " + at + ": that needs " + needWords(n) + whose, "ask " + h + "'s builder or an owner; a socket on a thing of your own needs nothing more", { needs: n, host: h });
    const k = lockedC(st.entities[h]?.c) ? h : ancestors(st, h).find((x) => lockedC(st.entities[x]?.c));
    if (k) lockCheck(w, st, who, role, k, { ...as, id: op.id }, at); }
}
export { clearOccupant, leftOccupied, occupiedRefuse, occupantOf, occupyRights, setOccupant, occupantOn, vacateAt, vacateWhy, vacatesFor };
