// The ws messages that reach a world's authority; server.ts consults this table first.
//
//   request {type: "request", id, verb, args} → {type: "reply", id, verb, ok, reply}, reply kept whole (it has fields
//           of its own, such as inspect's `id`). The asker is stamped from the connection (L4), never read from the
//           payload. Spectators may only read.
//   world-fork, world-reset
//           an owner copies the world to a new name, or erases it to zero (archived, refounded by its owners).
//   world-found
//           a signed-in person founds a new, empty world they own (server/worldlog.ts foundOwnedWorld).
// One client's requests run in order: an async warm-up never lets a later request overtake an earlier one.
import { forkWorld, foundOwnedWorld, recheckFix } from "./worldlog.ts";
import { worldExists, worlds } from "./world.ts";
import type { Client, World } from "./world.ts";
import { globalBans, saveGlobalBans, banKey, ADDR_BAN_MS, fileAddrSanction, liftAddrSanction } from "./moderation.ts";
import { directoryFor, foldName } from "./directory.ts";
import { WORLDS_DIR } from "./config.ts";
import { isBanned } from "../shared/protocol/authority.js";
import { txnRefusal } from "../shared/protocol/authority/storage.js";
import { WIRE_READS, PERSON_ACTS } from "../shared/protocol/verbclasses.js";
import { METER_SCALE, readMeter, authorityTime } from "./readmeter.ts";
import { isOperator } from "./operators.ts";
import { capture, recheck, type ReqCap } from "./reqcap.ts";
import { isOwner } from "../shared/protocol/roles.js";

type Ctx = { c: Client; ws: { send(d: string): void }; now: number; expel: (w: World, target: Client, why: string, until?: number | null) => void; sweep?: (w: World) => void };
type Any = any;
const READS = WIRE_READS;

/** whois {name|u-id}: scoped to THIS world (present, or named by its log, roles or moderator log), never the whole
 *  directory, never an account. Each match says its role, presence and ban. */
export function whois(w: World, args: Any) {
  const q = typeof args?.name === "string" ? args.name.trim() : typeof args?.id === "string" ? args.id.trim() : "";
  if (!q || q.length > 128) return { ok: false, refused: { code: "shape", reason: "whois {name} (or {id: 'u-…'})", fix: "the name someone goes by here, as their nameplate shows it" } };
  const log = w.log!; const dir = directoryFor(WORLDS_DIR);
  const here = new Map<string, string>(), said = new Map<string, string>();
  for (const c of w.clients) if (c.actorId && !c.spectator) { here.set(c.actorId, c.id); if (c.declares) said.set(c.actorId, c.declares); }
  const known = new Set<string>([...here.keys(), ...log.knownIds()]);
  const want = foldName(q);
  if (!want && !/^u-[a-z2-7]{20}$/.test(q)) return { ok: false, refused: { code: "shape", reason: `"${q.slice(0, 40)}" has no letters or digits to look up`, fix: "the name someone goes by here, as their nameplate shows it" } };
  const people = [...known].filter((id) => id === q || (dir.nameOf(id) != null && foldName(dir.nameOf(id)!) === want) || (here.has(id) && foldName(here.get(id)!) === want))
    .map((id) => { const k = dir.entry(id)?.kind;
      // no kind of participant (§6a rule 3): only their own declared word while here; account facts are about the
      // account, never about what holds it
      return { id, name: here.get(id) ?? dir.nameOf(id) ?? id, ...(said.has(id) ? { declares: said.get(id) } : {}), ...(k === "anon" ? { guest: true } : k === "imported" ? { imported: true } : {}), role: log.roleOf(id), here: here.has(id), banned: isBanned(log.live, id) }; });
  return { ok: true, name: q, people, ...(people.length ? {} : { note: `nobody called "${q}" has been in this world (it only knows people who were here)` }) };
}
const reads = readMeter(); // per connection: reads and dry runs, by count and authority time
// …and every request by authority time: nothing else bounds one connection's share of the shared thread (a guest is a
// fresh identity per connection). 3 s of 10 is far past any real use.
const busy = readMeter({ n: Infinity, ms: 3000 * METER_SCALE, window: 10_000 });
const refusalTimes = new WeakMap<Client, number[]>();
/** At most 20 refusal lines per connection per 10 s reach the flight recorder. */
function recordRefusal(c: Client): boolean {
  const now = Date.now(); const ts = (refusalTimes.get(c) ?? []).filter((t) => now - t < 10_000);
  if (ts.length >= 20) { refusalTimes.set(c, ts); return false; }
  ts.push(now); refusalTimes.set(c, ts); return true;
}
/** Bystanders get who did it, to whom (names). Never the reason (that's the person's and the moderator log's), an
 *  address, or an account. */
function modLine(w: World, by: string, verb: string, who: string) {
  const name = directoryFor(WORLDS_DIR).nameOf(who) ?? "someone";
  return verb === "ban" ? `${by} banned ${name} from this world` : verb === "kick" ? `${by} removed ${name} from this world` : verb === "mute" ? `${by} muted ${name}`
    : verb === "unmute" ? `${by} unmuted ${name}` : verb === "warn" ? `${by} warned ${name}` : `${by} lifted the ban on ${name}`;
}
/** A caption is a speech bubble; server.ts applies this before any handler. */
const QUIET = new Set(["typing", "anim", "puppet", "bodydrag", "drag", "caption"]);
export function gagged(c: Client, type: string): boolean {
  const w = c.world; if (!w?.log || !c.actorId || !QUIET.has(type)) return false;
  return type === "caption" && !!w.log.mutedHere(c.actorId);
}
/** A guest is a fresh identity per connection, so a guest's mute is also filed against their hashed address here
 *  (moderation.ts); unmute lifts it. Nothing is filed for signed-in people. */
export function guestSanctionByAddress(w: World, actor: string, by: string, verb: string, who: string, reason?: string) {
  const kind = verb === "mute" || verb === "unmute" ? "mute" : null;
  if (!kind || !w.log) return;
  const addrs = [...new Set([...w.clients].filter((t) => t.actorId === who && t.anonymous && t.addr).map((t) => t.addr as string))];
  if (verb.startsWith("un")) { liftAddrSanction(kind, w.name, who, addrs[0]); return; }
  const now = w.log.mutedHere(who);   // every channel muted
  if (!now) return;
  for (const addr of addrs) fileAddrSanction({ kind, world: w.name, addr, actor, by, who, until: now.until ?? null,
    ...(kind === "mute" ? { channels: now.channels } : {}), ...(reason ? { reason: reason.slice(0, 280) } : {}) });
}
export const actorOf = (c: Client) => { if (!c.actorId) throw new Error(`request from ${c.id} with no directory id (join didn't resolve one)`); return c.actorId; };

/** A throw never breaks the queue; one escaping unanswered is answered (`unanswered`'s id) as rolled-back
 *  server-error: WorldLog.request never throws, so nothing was written. */
function inOrder(c: Client, ws: Ctx["ws"], fn: () => Promise<void>, unanswered?: (r: Any) => void) {
  const tail = (c.verbQueue ?? Promise.resolve()).then(fn).catch((err) => {
    console.error(`[ws] request from ${c.id} failed server-side:`, err);
    try { if (unanswered) unanswered(txnRefusal({ outcome: "rolled-back" }));
      else ws.send(JSON.stringify({ type: "error", error: "that request failed server-side — it has been logged" })); } catch { /* gone */ }
  });
  c.verbQueue = tail;
  void tail.then(() => { if (c.verbQueue === tail) c.verbQueue = undefined; });
}

const FORK_GAP_MS = 60_000, FORK_PER_HOUR = 5;
const forkAt = new Map<string, number>(), forksBy = new Map<string, number[]>();
export const REQUEST_MESSAGES: Record<string, (ctx: Ctx, msg: Any) => void> = {
  "request": ({ c, ws, expel, sweep }, msg) => {
    const w = c.world; if (!w) return;
    const rid = msg.id ?? null;
    const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? msg.args : {};
    const verb = String(msg.verb ?? "");
    // the outcome rides as `txn` (PROTOCOL §7; ok only when committed). Never `outcome`: body verbs use it for asked | allowed
    let answered = false;
    const reply = (r: Any) => { answered = true; ws.send(JSON.stringify({ type: "reply", id: rid, verb, ok: r.ok === true, ...(typeof r?.txn === "string" ? { txn: r.txn } : {}), reply: r })); };
    if (c.spectator && !READS.has(verb)) { reply({ ok: false, refused: { code: "spectator", reason: "spectators may read, not write", fix: "join embodied" } }); return; }
    const metered = READS.has(verb) || args.dry === true;
    // reads counted on arrival; time checked as each is about to run, so a queue behind a slow one can't all be admitted
    // before the meter sees the cost. A meter's refusal reaches the flight recorder, bounded the same way
    const metered_no = (no: Any) => { if (recordRefusal(c)) w.debug("refused", { who: c.id, verb: verb.slice(0, 32), code: no.code, line: `${c.id}'s ${verb.slice(0, 32)} was refused (${no.code}): ${no.reason}`.slice(0, 300) }); reply({ ok: false, refused: no }); };
    if (metered) { const no = reads.check(c, Date.now()); if (no) { metered_no(no); return; } }
    const mark = metered ? reads.record(c, Date.now()) : null;
    if (verb === "whois") { reply(whois(w, args)); return; }   // the server's directory, not the authority's world
    // a caption carries the leg generation, stamped here (never the client's word): a taken-over captioner can't write
    // over its successor (shared/captions.js captionRefusal)
    if (verb === "caption") args.gen = c.legGen ?? 0;
    // ONE capability (server/reqcap.ts), frozen at arrival; rechecked at the queue (seam 1) and after warm() before the
    // write (seam 2, worldlog.ts). The authority gets cap.actorId, never one read after an await
    let cap: ReqCap;
    try { cap = capture(c, w); } catch (err) { console.error(`[ws] request from ${c.id}:`, err); reply({ ok: false, txn: "rolled-back", refused: { code: "identity", reason: "this connection has no identity here", fix: "join the world first" } }); return; }
    const still = () => recheck(cap);
    inOrder(c, ws, async () => {
      { const gone = still(); if (gone) { reply({ ok: false, txn: "rolled-back", refused: { code: "superseded", reason: gone, fix: recheckFix(gone) } }); return; } }
      { const no = (metered ? reads.check(c, Date.now(), { timeOnly: true }) : null) ?? busy.check(c, Date.now()); if (no) { metered_no(no); return; } }
      const spent = busy.record(c, Date.now());
      const wasBanned = (verb === "ban" || verb === "unban") && typeof args.who === "string" ? isBanned(w.log.live, String(args.who)) : false;
      const r = await w.log.request(cap.actorId, verb, args, still);
      const ms = (r && typeof r === "object" && authorityTime.get(r)) || 0; if (mark) mark.ms = ms; spent.ms = ms;
      reply(r);
      // every refusal reaches the flight recorder, bounded: the ring (read by anyone here) can quote what was sent
      if (r && !r.ok && r.refused && recordRefusal(c)) { const cap = (x: unknown, n: number) => { const t = String(x ?? ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
        const id = typeof args.id === "string" ? cap(args.id, 64) : null;
        w.debug("refused", { who: c.id, verb: cap(verb, 32), ...(id ? { id } : {}), code: cap(r.refused.code, 32),
          line: cap(`${c.id}'s ${verb}${id ? ` ${id}` : ""} was refused (${r.refused.code}): ${r.refused.reason ?? ""}${r.refused.fix ? ` — ${r.refused.fix}` : ""}`, 300) }); }
      // bystanders see a removal only when something happened (the moderator log is never a world entry);
      // a person-act applies now: voice mutes at once (the sweep), a warning as a notice, a mute told to its person
      if (r?.ok && PERSON_ACTS.has(verb)) { sweep?.(w);
        const who = String(args.who ?? ""); const notice = verb === "warn" ? { type: "warned", by: c.id, reason: String(args.reason ?? "") }
          : verb === "mute" ? { type: "moderated", verb: "mute", by: c.id, you: true, channels: r.channels, until: r.until, ...(args.reason ? { reason: String(args.reason) } : {}) } : null;
        if (notice) for (const t of w.clients) if (t.actorId === who) { try { t.ws.send(JSON.stringify(notice)); } catch { /* gone */ } }
        // a warning is private: its moderator alone is told it went, as the broadcast tells them of a mute or kick
        if (verb === "warn") try { ws.send(JSON.stringify({ type: "moderated", verb, by: c.id, text: modLine(w, c.id, verb, who) })); } catch { /* gone */ } }
      // a guest's mute also names their address here, and its lift lifts that
      if (r?.ok && ["mute", "unmute"].includes(verb) && typeof args.who === "string" && args.who !== cap.actorId)
        guestSanctionByAddress(w, cap.actorId, c.id, verb, String(args.who), typeof args.reason === "string" ? args.reason : undefined);
      if (r?.ok && (verb === "ban" || verb === "kick" || verb === "unban" || verb === "mute" || verb === "unmute") && typeof args.who === "string") {
        const who = String(args.who);
        const happened = verb === "kick" || verb === "mute" || verb === "unmute" ? [...w.clients].some((t) => t.actorId === who && !t.spectator) : wasBanned !== isBanned(w.log.live, who);
        if (happened) { const text = modLine(w, c.id, verb, who);
          for (const t of w.clients) if (t.actorId !== who) { try { t.ws.send(JSON.stringify({ type: "moderated", verb, by: c.id, text })); } catch { /* gone */ } } }
      }
      // an unban (or the end of a kick, lifted) also lifts the address entry a guest's ban or kick left
      if (r?.ok && verb === "unban" && typeof args.who === "string") { let n = 0;
        for (const [k, e] of Object.entries(globalBans)) if ((e as Any)?.who === args.who && (e as Any)?.world === w.name) { delete globalBans[k]; n++; }
        if (n) saveGlobalBans(); }
      // an accepted ban or kick takes the person out NOW (H4b)
      if (r?.ok && (verb === "ban" || verb === "kick")) {
        const who = String(args.who);
        for (const t of [...w.clients]) if (t.actorId === who) {
          // a guest's ban (at most a day) and kick cooldown also name its address here, or reconnecting would shed them
          if (t.anonymous && t.addr) {
            const until = Math.min(Date.now() + ADDR_BAN_MS, r.until ?? Infinity);
            globalBans[banKey(null, t.addr, w.name)] = { by: c.id, ts: Date.now(), name: t.id, addr: t.addr, until, world: w.name, who, ...(args.reason ? { reason: String(args.reason) } : {}) };
            saveGlobalBans();
          }
          const back = r.until ? ` — you may come back ${verb === "kick" ? `in ${Math.max(1, Math.round((r.until - Date.now()) / 60000))} min` : `on ${new Date(r.until).toISOString().slice(0, 16).replace("T", " ")} UTC`}` : "";
          expel(w, t, `you were ${verb === "ban" ? "banned from" : "removed from"} "${w.name}"${args.reason ? ` — ${String(args.reason)}` : ""}${back}`, r.until ?? null);
        }
      }
    }, (r) => { if (!answered) reply(r); });
  },
  // operator-repair: a WORLD_ADMIN account (isOperator, never the payload) mends the world through the authority.
  // NARROW (set/delete of @world's roles:<id>, access, default-role, role-defs; unban) and RECORDED (its act, a log line);
  // the world's rights don't gate it, its value/role/last-owner checks do.
  "operator-repair": ({ c, ws, sweep }, msg) => {
    const w = c.world; if (!w) return;
    const rid = msg.id ?? null; const verb = String(msg.verb ?? "");
    const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? msg.args : {};
    let answered = false;
    const reply = (r: Any) => { answered = true; ws.send(JSON.stringify({ type: "reply", id: rid, verb, ok: r.ok === true, operator: true, ...(typeof r?.txn === "string" ? { txn: r.txn } : {}), reply: r })); };
    if (!isOperator(c.account)) { reply({ ok: false, refused: { code: "rights", reason: "operator-repair needs a server operator's account (WORLD_ADMIN)", fix: "ask whoever runs this server" } }); return; }   // an owner can't repair what only an operator may (an operator's ban, a shape repair)
    if (!c.actorId) { reply({ ok: false, refused: { code: "identity", reason: "this connection has no identity here", fix: "join the world first" } }); return; }
    // the same one capability as request, still an operator's when the queue reaches it (the only await before the repair)
    const cap = capture(c, w);
    inOrder(c, ws, async () => {
      if (!cap.operator) { reply({ ok: false, txn: "rolled-back", refused: { code: "rights", reason: "operator repair is for this server's operator", fix: "ask whoever runs this server" } }); return; }
      const gone = recheck(cap, Date.now(), { role: false });
      if (gone) { reply({ ok: false, txn: "rolled-back", refused: { code: "superseded", reason: gone, fix: recheckFix(gone) } }); return; }
      const r = w.log.operatorRepair(cap.actorId, verb, args);
      console.log(`[world:${w.name}] operator repair by ${c.account} (${c.id}): ${verb.slice(0, 32)} ${String((args as Any).component ?? (args as Any).who ?? "").slice(0, 64)} → ${r?.ok ? "ok" : r?.refused?.code}`);
      reply(r);
      if (r?.ok) sweep?.(w);   // an unban or a role change applies now
    }, (r) => { if (!answered) reply(r); });
  },
  // a new world (its own identity) whose founding act names this one, holding its current state. Owner-only.
  "world-fork": ({ c, ws }, msg) => {
    const w = c.world; if (!w) return;
    const err = (e: string) => ws.send(JSON.stringify({ type: "error", error: e }));
    if (c.spectator) return err("spectators can't copy worlds — join embodied");
    const role = w.log.roleOf(actorOf(c)); if (!isOwner(role)) return err(`copying a world needs its owner — you are a ${role} here`);
    // synchronous on the shared thread: one at a time per world and FORK_PER_HOUR per person, so forking in a loop
    // can't stall every world
    const now = Date.now(), last = forkAt.get(w.name) ?? 0, mine = (forksBy.get(actorOf(c)) ?? []).filter((t) => now - t < 3600_000);
    if (now - last < FORK_GAP_MS) return err(`this world was copied ${Math.round((now - last) / 1000)} s ago — try again in a minute`);
    if (mine.length >= FORK_PER_HOUR) return err(`you've copied worlds ${mine.length} times in the last hour (at most ${FORK_PER_HOUR})`);
    const to = String(msg.to ?? "").slice(0, 64);
    const r = forkWorld(w.log, to, actorOf(c));
    if (!r.ok) return err(r.err);
    forkAt.set(w.name, now); forksBy.set(actorOf(c), [...mine, now]);   // only a fork that happened counts
    console.log(`[world:${w.name}] copied → "${to}" by ${c.id} (${r.things} things, ${r.acts} acts)`);
    ws.send(JSON.stringify({ type: "world-forked", from: w.name, to }));
  },
  // signed-in people only: a guest has no account to hold it, and an operator founds for an agent
  "world-found": ({ c, ws }, msg) => {
    const err = (e: string) => ws.send(JSON.stringify({ type: "error", error: e, about: "world-found" }));
    if (!c.world) return err("join a world first");
    if (c.spectator) return err("spectators can't found worlds — join embodied");
    if (c.anonymous || !c.account) return err("founding a world needs a signed-in account (a guest's world would have no one to own it)");
    if (/^(agent|aid1):/.test(c.account)) return err("an agent's account doesn't found worlds here — the server's operator can found one for it");
    const name = String(msg.name ?? "").trim().toLowerCase().slice(0, 64);
    const r = foundOwnedWorld(name, actorOf(c), c.account, typeof msg.title === "string" ? msg.title : undefined, worldExists);
    if (!r.ok) return err(r.err);
    console.log(`[world:${name}] founded by ${c.id} (${c.account}) from ${c.world.name}`);
    ws.send(JSON.stringify({ type: "world-founded", name, worldId: r.worldId }));
  },
  // Owner-only, and the request must carry the world's own name. History is archived beside it, never destroyed.
  "world-reset": ({ c, ws }, msg) => {
    const w = c.world; if (!w) return;
    const err = (e: string) => ws.send(JSON.stringify({ type: "error", error: e }));
    if (c.spectator) return err("spectators can't erase worlds — join embodied");
    const role = w.log.roleOf(actorOf(c)); if (!isOwner(role)) return err(`erasing a world needs its owner — you are a ${role} here`);
    // the most senior owner's act: a co-owner made later can't wipe the world from under the people who made it
    if (w.log.seniorOwner() !== actorOf(c)) return err("erasing a world is for its most senior owner (its founder) — ask them");
    if (String(msg.name ?? "") !== w.name) return err(`confirmation mismatch — reset must name "${w.name}"`);
    let arch: string; try { arch = w.resetWorld(); } catch (e: Any) {
      if (e?.movedTo) console.error(`[world:${w.name}] reset failed partway: old log in ${e.movedTo}, new one in ${e.freshAt}:`, e);
      if (e?.resetDone && e.opened) {   // the reset stands; its scripts are the operator's to look at
        console.error(`[world:${w.name}] reset by ${c.id}: the fresh world is open, but its scripts didn't start:`, e.cause ?? e); arch = e.resetDone; }
      else if (e?.resetDone) { console.error(`[world:${w.name}] reset by ${c.id}: erased (history archived in ${e.resetDone}), but the fresh log didn't open:`, e.cause ?? e);
        // the World in memory holds the erased world: drop it from the registry so the next join opens the fresh log
        if (worlds.get(w.name) === w) worlds.delete(w.name);
        w.broadcast({ type: "world-reset", world: w.name, by: c.id });
        return err("the world was erased (its history is archived), but the server couldn't open the fresh world just now: it opens again from disk at the next join, and if that fails too, ask whoever runs this server (what failed is in its log). Resetting again erases nothing more"); }
      // world.ts retires a log that was moved aside
      else return err(e?.logMoved
        ? "the reset failed partway: the world's old log was moved aside (the server's log says where), so this world takes no writes until the server's operator puts it back. Resetting again is safe: it finishes the erase, and the old log stays in the archive this attempt made"
        : `the reset failed and the world's log is where it was, so the world goes on as before: ${String(e?.message ?? e)}`); }
    console.log(`[world:${w.name}] ERASED to zero by ${c.id} — history archived in ${arch}`);
    w.broadcast({ type: "world-reset", world: w.name, by: c.id });
  },
};
/** A write from another surface (voice-moderate), down the same path: ONE capability, inOrder's queue, the busy meter,
 *  seams 1 and 2. Never throws. */
export function requestAs(c: Client, ws: Ctx["ws"], w: World, verb: string, args: Any): Promise<Any> {
  return new Promise((resolve) => {
    let cap: ReqCap;
    try { cap = capture(c, w); } catch (err) { console.error(`[ws] ${verb} from ${c.id}:`, err); resolve({ ok: false, txn: "rolled-back", refused: { code: "identity", reason: "this connection has no identity here", fix: "join the world first" } }); return; }
    inOrder(c, ws, async () => {
      { const gone = recheck(cap); if (gone) { resolve({ ok: false, txn: "rolled-back", refused: { code: "superseded", reason: gone, fix: recheckFix(gone) } }); return; } }
      { const no = busy.check(c, Date.now()); if (no) { resolve({ ok: false, txn: "rolled-back", refused: no }); return; } }
      const spent = busy.record(c, Date.now());
      const r = await w.log.request(cap.actorId, verb, args, () => recheck(cap));
      spent.ms = (r && typeof r === "object" && authorityTime.get(r)) || 0;
      resolve(r);
    }, (r) => resolve(r));
  });
}

export const requestHandler = (type: unknown) => (typeof type === "string" && Object.hasOwn(REQUEST_MESSAGES, type) ? REQUEST_MESSAGES[type] : undefined);
