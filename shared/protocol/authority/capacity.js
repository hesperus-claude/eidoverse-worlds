// shared/protocol/authority/capacity.js — how much a world holds: the server's CAPACITY defaults and CAPACITY_CEILING,
// the world's @world.capacity, the guests' shared budget, and the check a write that adds entities meets.
import { resolveVersioned } from "../componentspec.js";
import { CTX } from "./ctx.js";
import { refuse } from "./refuse.js";
import { isE, opsQuiet } from "./storage.js";
import { SOCKETS_PER_HOST, isSocketC } from "./sockets.js";
import { RESERVED, entryBy } from "./rights.js";

// ONE budget: at most capacity.entities (sockets included, @world not), and account-less people TOGETHER at most
// capacity.guestEntities (a guest is a fresh identity per connection). Only adding is refused (full). CAPACITY and
// CAPACITY_CEILING are policy (PROTOCOL §9.2), never pinned. capacity.avatar isn't enforced yet.
export const CAPACITY = { entities: 10000, guestEntities: 500, avatar: 2000 };
export const CAPACITY_CEILING = { entities: 50000, guestEntities: 50000, avatar: 5000 };
const capacityOf = (st) => { const ok = (x) => Number.isInteger(x) && x >= 0;
  // the registry's one versioned-name reader (§4); with no capacity@n registered it is plain `capacity`
  const { name, value: v } = resolveVersioned(st.entities["@world"]?.c, "capacity"); const D = CAPACITY;
  return { ...Object.fromEntries(Object.keys(D).map((k) => [k, ok(v?.[k]) ? v[k] : D[k]])), name }; };   // name: the registry key it was read under, for refusals to cite
// counts in the guests' pool: an identity the directory calls anonymous or doesn't know (guests aren't written, so an old
// guest is unknown after a restart and still counts). The authority's own ids and an unknown author (a purged cause) are
// nobody's guest; with no directory, nobody is. → "anon" | "unknown" | null
const guestKind = (w, id) => { if (typeof id !== "string" || !w.kindOf || RESERVED.has(id)) return null; const k = w.kindOf(id);
  return k === "anon" ? "anon" : k == null ? "unknown" : null; };
// guest-pool entities still standing in st, how many an unknown creator made, and how many the write's state s no longer
// holds (a log view, kept incrementally like everIds)
function guestMade(w, st, s = st) {
  const G = (w.__guests ??= { n: 0, ids: new Map() });
  for (; G.n < w.entries.length; G.n++) { const e = w.entries[G.n]; if (!isE(e) || e.kind !== "change") continue; let kind;
    for (const o of opsQuiet(e)) { if (o.verb === "create") { kind ??= guestKind(w, entryBy(w, e).rights); if (kind) G.ids.set(o.id, kind); } else if (o.verb === "delete" && o.comp === undefined) G.ids.delete(o.id); } }
  let n = 0, unknown = 0, gone = 0; for (const [id, k] of G.ids) if (st.entities[id]) { n++; if (k === "unknown") unknown++; if (!s.entities[id]) gone++; }
  return { n, unknown, gone };
}
const entityCount = (st) => Object.keys(st.entities).length - (st.entities["@world"] ? 1 : 0);
function capacityCheck(w, st, s, who, norm) {
  if (who.lifting) return;   // the maintenance lift carries what the log already holds: never refused
  const made = norm.filter((o) => o.verb === "create" && s.entities[o.id]).length;
  // the hosts sockets join in this write: one holds at most SOCKETS_PER_HOST
  const joined = new Set();
  for (const id of new Set(norm.map((o) => o.id))) { const now = s.entities[id]?.c, was = st.entities[id]?.c;
    const h = isSocketC(now) ? now.parent?.to : null; if (h && (!isSocketC(was) || was.parent?.to !== h)) joined.add(h); }
  if (!made && !joined.size) return;
  const cap = capacityOf(s);
  if (made) { const before = entityCount(st), after = entityCount(s);
    if (after > before && after > cap.entities) refuse("full", `this world holds ${before} entities and its limit is ${cap.entities} (@world.${cap.name}.entities): ${after - before} more won't fit (every entity counts, sockets too)`, `delete something first; the world's owner may raise it: set {id: '@world', component: '${cap.name}', value: {entities: <n>}, merge: true} (at most ${CAPACITY_CEILING.entities} on this server)`, { limit: cap.entities, entities: before }); }
  if (joined.size) { const per = new Map([...joined].map((h) => [h, [0, 0]]));
    for (const e of Object.values(s.entities)) { const h = isSocketC(e.c) ? e.c.parent?.to : null; if (per.has(h)) per.get(h)[1]++; }
    for (const e of Object.values(st.entities)) { const h = isSocketC(e.c) ? e.c.parent?.to : null; if (per.has(h)) per.get(h)[0]++; }
    for (const [h, [before, after]] of per) if (after > before && after > SOCKETS_PER_HOST) refuse("full", `${h} has ${before} sockets, and one thing holds at most ${SOCKETS_PER_HOST}: ${after - before} more won't fit`, "a thing with that many seats is several things: split it, or delete some of its sockets", { limit: SOCKETS_PER_HOST, sockets: before, host: h }); }
  if (!made) return;
  const holder = who.cap?.kind === "reaction" ? who.cap.author : who.cap?.kind === "script" ? who.cap.sponsor : who.actor;
  if (!CTX.isAnon(holder)) return;
  // a write that leaves the pool no bigger is never refused (a delete in the same request makes room); one that grows it past the limit is
  const { n: g, unknown, gone } = guestMade(w, st, s); if (made <= gone || g - gone + made <= cap.guestEntities) return;
  const whose = unknown ? `things by account-less people (guests), and ${unknown} by creators this server doesn't know (a guest from before a restart, or someone from before its directory or another server), together make ${g}` : `account-less people (guests) together have ${g} entities standing here`;
  refuse("full", `${whose}, and this world lets them have ${cap.guestEntities} (@world.${cap.name}.guestEntities), all of them together: ${made - gone} more won't fit`, `delete something the guests made first (a delete in the same request makes room), sign in to build more, or ask the world's owner to raise it: set {id: '@world', component: '${cap.name}', value: {guestEntities: <n>}, merge: true} (at most ${CAPACITY_CEILING.guestEntities} on this server)`, { limit: cap.guestEntities, entities: g });
}
export { capacityCheck };
