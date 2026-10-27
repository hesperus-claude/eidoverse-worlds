// A world's log as this server holds it: the authority over its directory. Every write is a REQUEST through the
// authority (shared/protocol/authority.js); request() is the only way in.
// Every client folds the log itself: a joiner adopts the cut (clientCut) and folds raw {type: "log"} entries. `state`
// is the VIEW (view.js viewState) plus the chat window, for this server's own readers, rebuilt lazily after a write.
// Chat lines are numbered seq × 1000.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { WORLDS_DIR } from "./config.ts";
import { directoryFor } from "./directory.ts";
import { atomicWrite } from "./fsutil.ts";
import { mkdirDurable, replaceDurable, syncDir, syncTree } from "./durable.ts";
import { forkCopy, operatorRepair as authorityOperatorRepair, request as authorityRequest, actIndexOf, roleIn, isBanned, kickOf, muteOf, sanctionsNow, effectiveIn, seniorOwnerOf, tick as authorityTick, settle as authoritySettle, presenceEvent, scriptsView, settleOrphans, liftWorld, reachAdmits, reachLetGo, expireRoles as authorityExpireRoles } from "../shared/protocol/authority.js";
import { authorityTime } from "./readmeter.ts";
import { txnOutcome, txnRefusal, wedgedOf } from "../shared/protocol/authority/storage.js";
import { clientCutOf, spokenOf } from "../shared/protocol/replica.js";
import { viewState } from "../shared/protocol/view.js";
import { holdWire } from "../shared/grab.js";
import { hear } from "../shared/chatwindow.js";
import { dec } from "../shared/protocol/names.js";
import { openLive, isWorldDir, isPreNamesDir } from "./livehost.ts";
import { ENGINE_CATALOGUE, warm, modelsIn } from "./modelcatalogue.ts";
import { backupBeforeRepair, sealBackup, dropBackup } from "./repairfiles.ts";

type Any = any;
/** Numbered seq × 1000, its actor a display name. */
export type ChatLine = { seq: number; ts: number; actor: string; verb: "say"; args: { text: string; to?: string; spoken?: boolean; utt?: number; t0?: number } };
export type WorldView = { entities: Record<string, Any>; terrain: Any; grass: Any; sky: Any; assets: Any[]; recentChat: Any[]; chatTotal: number; roles: Record<string, Any>; bans: Record<string, Any> };
const idOut = (s: string) => dec(s) ?? s;

/** Without the chain fields and an act/say body's salt: nothing client-side reads them, and on a short say they were
 *  380 of 488 bytes (Commons audit #8). The log on disk and the authority's history keep them whole. */
export function wireEntry(e: Any) {
  if (!e || typeof e !== "object") return e;
  const { world: _w, head: _h, sig: _s, ...rest } = e;
  if ((rest.kind === "say" || rest.kind === "act") && rest.body && typeof rest.body === "object" && !Array.isArray(rest.body) && "salt" in rest.body) { const { salt: _t, ...b } = rest.body; rest.body = b; }
  return rest;
}
/** Decided once, when the world is first opened. */
export function isWorldSaved(name: string): boolean { return isWorldDir(path.join(WORLDS_DIR, name)); }
/** livehost isPreNamesDir */
export function isPreNamesSaved(name: string): boolean { return isPreNamesDir(path.join(WORLDS_DIR, name)); }

/** Injected: this file never imports world.ts. */
export type LogHost = {
  broadcast(msg: unknown): void;
  rightsChanged(): void;
  debug(kind: string, detail: Record<string, unknown>): void;
  /** embodied, not spectating. Scripts' timers sleep when empty; world.near(r) reads it (research 41 §3.5, §3.8) */
  present?(): { id: string; at: number[] | null }[];
  /** false when they aren't here */
  toActor?(actor: string, msg: unknown): boolean;
  /** speech is arrival-only (world.ts sayFloor); null = an admin, no floor */
  sayFloor?(actor: string): number | null;
  /** after a request, so a hand a consent no longer allows leaves at once, table-allowed or ask-granted */
  regateReaches?(): void;
};

/** Resending helps only when the connection changed under the request; a changed door, role or operator status
 *  meets the same answer. */
export function recheckFix(reason: string): string {
  // operator status granted while it waited: sending again is decided anew, as a role change is
  if (/became a server operator/.test(reason)) return "send it again if you still mean it, as the operator this account is now";
  if (/door no longer lets|operator status changed|needs a server operator/.test(reason)) return "sending it again won't change this: what this account may do here changed";
  if (/role here changed/.test(reason)) return "send it again if you still mean it, under your role as it is now";
  return "reconnect, then send it again from the connection that is in the world now";
}

export class WorldLog {
  name: string;
  live: Any;
  /** Rebuilt lazily by its next reader after a write. */
  private _state!: WorldView;
  get state(): WorldView { if (this.stale) this.freshen(); return this._state; }
  /** the last 256 says: a voice leg's attest receipt names one by seq */
  recentSays: ChatLine[] = [];
  poses: Record<string, unknown> = {};
  /** newest last */
  private hist: ChatLine[] = [];
  private dir: string;
  private posesPath: string;
  private host: LogHost | null = null;
  stats = { requests: 0, writes: 0 };
  /** A request that was awaiting warm() must not append the old world's line into the new world's file. */
  retired = false;
  /** RESET, or HALF_RESET for a reset that failed partway */
  private retiredAs: Any = WorldLog.RESET;
  retire(as: Any = WorldLog.RESET) { this.retired = true; this.retiredAs = as; }
  private static RESET = { ok: false, refused: { code: "reset", reason: "this world was reset while the request waited; it is a new world now", fix: "reload, then send it again" } };
  /** After a half-reset no writes: appendDurable opens by path and would start a broken-chain world.jsonl. */
  static HALF_RESET = { ok: false, refused: { code: "reset", reason: "this world's reset failed partway and its log was moved aside, so this world takes no writes until the server's operator puts it back",
    fix: "sending it again won't change that; the world's senior owner may reset it again, which is safe: it finishes the erase, and the old log stays in the archive the first attempt made" } };
  /** opaque ids; clients are sent their display names (§2.3) */
  private actors = new Set<string>();
  private names(ids: Iterable<string>) { return directoryFor(WORLDS_DIR).names(ids); }

  constructor(name: string) {
    this.name = name;
    this.dir = path.join(WORLDS_DIR, name);
    this.posesPath = path.join(this.dir, "poses.json");
    // no host attached yet: a floor at the head hides every say (fail closed)
    this.live = openLive(this.dir, name, { catalogue: ENGINE_CATALOGUE, present: () => this.host?.present?.() ?? [],
      sayFloor: (a: string) => (this.host?.sayFloor ? this.host.sayFloor(a) : Infinity) });
    for (const e of this.live.entries) if (e && typeof e.actor === "string") this.actors.add(e.actor);
    // after a crash, what was held is settled and logged now, so a joiner's cut has it back (authority.js settleOrphans)
    try { const settled = settleOrphans(this.live, []); if (settled.length) console.log(`[world:${name}] settled ${settled.length} hold(s) left from before the restart: ${JSON.stringify(settled).slice(0, 300)}`); }
    catch (err) { console.error(`[world:${name}] settling orphaned holds`, err); }
    // the load (liftWorld) writes nothing: needed maintenance goes to the console and, once attached, the flight recorder
    try { const lifted = liftWorld(this.live) as Any[];
      const skipped = lifted.filter((x) => x.skipped);
      for (const k of skipped) console.warn(`[world:${name}] this server can't sign for this world (${k.skipped}): ${k.why}`);
      // and whether writes are refused meanwhile (repair-needed), naming the command
      const need = lifted.find((x) => x.repairNeeded)?.repairNeeded;
      if (need) console.warn(`[world:${name}] needs maintenance (${need.steps.join(", ")}): ${need.why}. ${need.fix.replace("<name>", name)}`);
      this.liftNotes = [...skipped.map((k) => ({ skipped: k.skipped, why: k.why })), ...(need ? [{ repair: true, needed: true, ...need }] : [])]; }
    catch (err) { console.error(`[world:${name}] lifting sockets`, err); }
    const st = this.live.state();
    if (st.status !== "ok") console.warn(`[world:${name}] log folds to '${st.status}': the authority will refuse writes`);
    // §12: a value stripped to its commit that no purge names was changed outside the purge rule. Said, not enforced:
    // it reads as unknown and writes go on (#260)
    const altered = (st.diagnostics ?? []).filter(([, c]: Any) => c === "commit-unpurged");
    if (altered.length) console.warn(`[world:${name}] log was changed outside its purge rule at line(s) ${altered.map(([q]: Any) => q).join(", ")} (a value stripped to its commit, no purge naming it): it reads as unknown. The operator can, with the world closed, restore those lines from a backup of the log and reopen it (each restored whole keeps its commit, so later lines still verify)`);
    this._state = this.view();
    // the last 40 says; chatTotal counts every line ever said here
    const says = this.live.entries.filter((e: Any) => e && e.kind === "say");
    if (this._state) this._state.chatTotal = Math.max(0, says.length - 40);
    for (const e of says.slice(-40)) this.hearSay(e);
    if (fs.existsSync(this.posesPath)) { try { this.poses = JSON.parse(fs.readFileSync(this.posesPath, "utf8")); } catch { /* corrupt = fresh */ } }
    // a request waits for them, or one just after a load meets unsized models and its outcome is logged for good
    this.standing = warm(Object.values(st.entities ?? {}).map((e: Any) => e.c.model)).catch(() => {});
  }
  /** what the socket lift couldn't do, whether the world still needs the shape repair, a rename's failure: said to the flight recorder when a world attaches */
  private liftNotes: Record<string, unknown>[] = [];
  private standing: Promise<unknown> = Promise.resolve();
  attach(host: LogHost) { this.host = host; for (const n of this.liftNotes) host.debug(n.repair ? "repair-needed" : "custody", n); }

  private view(): WorldView {
    return viewState(this.live.state(), { recentChat: this._state?.recentChat ?? [], chatTotal: this._state?.chatTotal ?? 0 }) as WorldView;
  }
  private sayLine(e: Any): ChatLine {
    const who = (x: string) => directoryFor(WORLDS_DIR).nameOf(x) ?? idOut(x);
    return { seq: e.seq * 1000, ts: e.ts, actor: who(String(e.actor)), verb: "say", args: { text: String(e.body?.text ?? ""), ...(e.body?.to ? { to: who(String(e.body.to)) } : {}), ...spokenOf(e.body) } } as ChatLine;
  }
  private hearSay(e: Any) {
    const line = this.sayLine(e);
    hear(this._state, { actor: line.actor, text: (line.args as Any).text, ts: line.ts, seq: line.seq });
    this.record(line);
  }
  get head(): number { return this.live.entries.length - 1; }
  /** seq × 1000 + 999: legs opened after it number above it. */
  get snapSeq(): number { return this.head * 1000 + 999; }

  /** `actor` already encoded. Warms named models first; the authority call itself is synchronous.
   *  `still` (reqcap.ts recheck) runs after the last await, right before the commit: non-null refuses, writing nothing.
   *  Never throws. */
  async request(actor: string, verb: string, args: Record<string, unknown> = {}, still?: () => string | null) {
    let gone: string | null | undefined;
    try { await this.standing; await warm(modelsIn(args)); gone = still?.(); }
    catch (err) { console.error(`[world:${this.name}] ${verb.slice(0, 32)} by ${actor}: failed before the authority saw it`, err); return txnRefusal({ outcome: "rolled-back" }); }
    if (gone) return { ok: false, txn: "rolled-back", refused: { code: "superseded", reason: gone, fix: recheckFix(gone) } };
    return this.requestSync(actor, verb, args);
  }
  /** PROTOCOL §7: `txn` (never `outcome`, a body verb's word); ambiguous `from` = the first unknown seq. Persist before
   *  publish; what reached entries is published in a finally, even on a throw, or clients' chains fall behind. */
  requestSync(actor: string, verb: string, args: Record<string, unknown> = {}) {
    if (this.retired) return { ...this.retiredAs, txn: "rolled-back" };
    this.stats.requests++;
    const live = this.live;
    const from = live.entries.length; const held = this.holdsKey(); const wedgedBefore = wedgedOf(live);
    const t0 = performance.now(); let r: Any = null; let threw: unknown = null;
    try { r = authorityRequest(live, actor, verb, args); }
    catch (err) { threw = err ?? new Error("the authority threw"); }
    finally { this.publish(from, held); }
    const o = txnOutcome(live, from, { threw: threw !== null, error: threw, refused: !!r && typeof r === "object" && r.ok === false, wedgedBefore });
    if (threw !== null) {
      console.error(`[world:${this.name}] ${verb.slice(0, 32)} by ${actor} threw in the authority (${o.outcome}${o.outcome === "ambiguous" ? ` from seq ${o.from}` : ""}):`, threw);
      if (o.outcome === "ambiguous") this.host?.debug("ambiguous", { verb: verb.slice(0, 32), from: o.from, wedged: !!o.wedged, line: `a ${verb.slice(0, 32)} ended ambiguous at seq ${o.from}${o.wedged ? ": storage failed mid-write; writes are refused until the world is reopened" : ""}` });
      r = txnRefusal(o);
    } else if (r && typeof r === "object") { r.txn = o.outcome; }
    if (r && typeof r === "object") authorityTime.set(r, performance.now() - t0);
    return r;
  }
  /** A failed publish is logged, never the request's outcome: its lines are durable whatever a socket did. */
  private publish(from: number, held: string) {
    try { if (this.live.entries.length > from) this.afterWrite(from); } catch (err) { console.error(`[world:${this.name}] publishing seq ${from}… failed`, err); }
    try { if (this.holdsKey() !== held) this.host?.broadcast({ type: "holds", world: this.name, holds: this.holds() }); this.forwardInbox(); }
    catch (err) { console.error(`[world:${this.name}] holds/inbox after a request failed`, err); }
    // a request may have closed someone's table: held to it now, not at the reacher's next packet
    try { this.host?.regateReaches?.(); } catch (err) { console.error(`[world:${this.name}] re-gating reaches after a request failed`, err); }
  }
  /** Only requestwire.ts's operator-repair reaches it, behind isOperator. Synchronous: no await between the check and
   *  the write. */
  operatorRepair(actor: string, verb: string, args: Record<string, unknown> = {}) {
    if (this.retired) return { ...this.retiredAs, txn: "rolled-back" };
    const live = this.live;
    const from = live.entries.length; const held = this.holdsKey(); const wedgedBefore = wedgedOf(live);
    let r: Any = null; let threw: unknown = null;
    // the pre-repair log is kept for `bun tools/protocol/world.ts repair <name> --rollback` (server stopped)
    try {
      const backup = (verb === "repair" || verb === "repair-shapes") && args.dryRun !== true ? backupBeforeRepair(this.dir, { by: actor }) : null;
      // a durable write's throw is ambiguous, so it keeps the backup; only a repair that wrote nothing drops it
      let threwHere = true;
      try { r = authorityOperatorRepair(live, actor, verb, args); threwHere = false; }
      finally { if (backup) { if (threwHere || live.entries.length > from) sealBackup(backup); else dropBackup(backup); } }
    } catch (err) { threw = err ?? new Error("the repair threw"); }
    finally { this.publish(from, held); }   // what reached the log is published, as requestSync
    const o = txnOutcome(live, from, { threw: threw !== null, error: threw, refused: !!r && typeof r === "object" && r.ok === false, wedgedBefore });
    if (threw !== null) { console.error(`[world:${this.name}] operator repair ${verb.slice(0, 32)} threw (${o.outcome}):`, threw); return txnRefusal(o); }
    if (r && typeof r === "object") r.txn = o.outcome;
    return r;
  }
  /** Per packet: presence only, never a request (nothing appended). A refusal goes straight to the reacher's socket. */
  reachAdmits(from: string, to: string, cls: string, extra: { point?: string | null; limb?: string; quiet?: boolean } = {}) {
    if (this.retired) return { ok: false, code: "reset", reason: "this world was reset", noted: false };
    const r = reachAdmits(this.live, from, to, cls, extra);
    if (r.noted) this.forwardInbox();
    return r;
  }
  /** A yes whose hand is no longer on its body ends (authority.js reachLetGo). Presence only. */
  reachLetGo(from: string, aimed: Set<string>) {
    if (this.retired) return false;
    return reachLetGo(this.live, from, aimed);
  }
  /** the last forwarded `n`, never the array's length (it caps at 200) */
  private inboxSent = new Map<string, number>();
  /** PROTOCOL L6; the inbox is left as is, so `inbox` still answers an agent that polls. */
  private forwardInbox() {
    const box = this.live.presence?.inbox as Record<string, { n?: number }[]> | undefined; if (!box || !this.host?.toActor) return;
    for (const [who, msgs] of Object.entries(box)) {
      const sent = this.inboxSent.get(who) ?? 0; const fresh = msgs.filter((m) => (m?.n ?? 0) > sent); if (!fresh.length) continue;
      if (this.host.toActor(who, { type: "body-inbox", world: this.name, messages: fresh })) this.inboxSent.set(who, fresh[fresh.length - 1].n ?? sent);
    }
    for (const who of this.inboxSent.keys()) if (!box[who]) this.inboxSent.delete(who);   // drained: what comes next is all new
  }
  /** design 20 P2. Never logged: sent whenever it changes, and in every join cut. */
  holds(): Record<string, { by: string }> {
    const out: Record<string, { by: string }> = {};
    // shared/grab.js holdWire: every client draws the hold from these
    for (const [id, h] of Object.entries(this.live.presence.holds ?? {}) as [string, Any][]) out[id] = holdWire(h) as { by: string };
    return out;
  }
  private holdsKey() { return JSON.stringify(this.holds()); }
  /** Not a takeover: what they held drops into the world (orphans, 18a) and the authority forgets their body. */
  departed(actor: string) {
    if (!this.live.presence.bodies?.[actor]) return;
    try { this.requestSync(actor, "leave", {}); } catch (err) { console.error(`[world:${this.name}] leave for ${actor}`, err); }
  }

  /** Scripts (research 41) on this server's clock, once a second. */
  tickScripts() {
    if (this.retired) return;
    if (this.live.state().status !== "ok") return;
    const from = this.live.entries.length;
    try { authorityTick(this.live); } finally { if (this.live.entries.length > from) this.afterWrite(from); }
  }
  /** expire-roles, once a second (access.ts sweepAccess). → the identities whose grant ended. */
  expireRoles(): string[] {
    if (this.retired || this.live.state().status !== "ok") return [];
    const from = this.live.entries.length; let ended: string[] = [];
    try { ended = authorityExpireRoles(this.live); } finally { if (this.live.entries.length > from) this.afterWrite(from); }
    return ended;
  }
  /** Rests log at tick cadence, so requests don't carry the settling (DESIGN-physics-responsiveness §1: 150–500 ms per
   *  request during a cascade). */
  settle() {
    if (this.retired) return;
    if (this.live.state().status !== "ok") return;
    const from = this.live.entries.length; const held = this.holdsKey();
    try { authoritySettle(this.live); }
    finally { if (this.live.entries.length > from) this.afterWrite(from); if (this.holdsKey() !== held) this.host?.broadcast({ type: "holds", world: this.name, holds: this.holds() }); }
  }
  presenceScripts(kind: "enter" | "leave", who: string) {
    if (this.retired) return;
    if (this.live.state().status !== "ok") return;
    const from = this.live.entries.length;
    try { presenceEvent(this.live, kind, who); } finally { if (this.live.entries.length > from) this.afterWrite(from); }
  }
  /** debug panel, world_debug {behaviors} */
  scriptsView(id?: string) { return scriptsView(this.live, id); }

  /** Raw entries to every client; chat into the window; the view goes stale; a role change re-sends rights. */
  private stale = false;
  private afterWrite(from: number) {
    this.stats.writes++;
    const fresh = this.live.entries.slice(from);
    const newActors = [...new Set(fresh.map((e: Any) => e?.actor).filter((a: Any) => typeof a === "string" && !this.actors.has(a)))] as string[];
    newActors.forEach((a) => this.actors.add(a));
    // a role for someone who never acted here: clients need their name too, or the narration says "made u-…"
    const named = new Set<string>(newActors);
    for (const e of fresh) { if (e?.kind !== "change") continue; let ops: Any[] = []; try { ops = opsOf(e); } catch { /* malformed: nothing to name */ }
      for (const o of ops) if (o?.id === "@world" && String(o.comp ?? "").startsWith("roles:")) named.add(String(o.comp).slice(6)); }
    const msg = { type: "log", world: this.name, from, entries: fresh.map(wireEntry), ...(named.size ? { names: this.names(named) } : {}) };
    this.host?.broadcast(msg);
    for (const e of fresh) if (e?.kind === "say") this.hearSay(e);
    this.stale = true;
    const roles = (e: Any) => { try { return e?.kind === "change" && opsOf(e).some((o: Any) => o.id === "@world" && (String(o.comp ?? "").startsWith("roles:") || ["role-defs", "default-role", "access"].includes(o.comp))); } catch { return false; } };
    if (fresh.some(roles)) this.host?.rightsChanged();
  }
  private record(e: ChatLine) {
    this.hist.push(e); if (this.hist.length > 512) this.hist.splice(0, this.hist.length - 512);
    if (e.verb === "say") { this.recentSays.push(e); if (this.recentSays.length > 256) this.recentSays.shift(); }
  }

  // ---- what the World and server.ts read ----
  /** Newest first by `before`. `floor`: arrival-only speech (null = an admin: every say). */
  readHistory({ before = Infinity, after = -Infinity, limit = 50, verbs = null as Set<string> | null, floor = Infinity as number | null }) {
    // every chat line ever said (live.entries), never only those since load: 40 lines once read as "the beginning" (Commons audit #2)
    if (verbs && !verbs.has("say")) return { entries: [], oldestSeq: null, hasMore: false };
    const out: ChatLine[] = []; let more = false; const E = this.live.entries;
    for (let i = E.length - 1; i >= 0; i--) { const e = E[i]; if (!e || e.kind !== "say" || e.body?.commit !== undefined) continue;
      if (floor !== null && !(e.seq > floor)) break;   // older lines are older still
      const seq = e.seq * 1000; if (seq >= before) continue; if (seq <= after) break;
      if (out.length === limit) { more = true; break; } out.push(this.sayLine(e)); }
    out.reverse();
    return { entries: out, oldestSeq: out.length ? out[0].seq : null, hasMore: more };
  }
  /** The chat window is kept. */
  private freshen() {
    this.stale = false;
    this._state = this.view();
  }
  roleOf(actor: string): string { return roleIn(this.live.state(), actor, { anon: directoryFor(WORLDS_DIR).entry(actor)?.kind === "anon" }); }
  /** An ended timed grant is absent at `now` before the sweep writes its end, as the door reads it (access.ts listedIn). */
  may(actor: string, permission: string, now = Date.now()): boolean {
    const st: Any = this.live.state(); const wc = st?.entities?.["@world"]?.c ?? {}; const g = wc[`roles:${actor}`];
    const ended = g && typeof g === "object" && Number.isSafeInteger(g.until) && g.until <= now;
    const view = ended ? { ...st, entities: { ...st.entities, "@world": { ...st.entities["@world"], c: Object.fromEntries(Object.entries(wc).filter(([k]) => k !== `roles:${actor}`)) } } } : st;
    return effectiveIn(view, actor, { anon: directoryFor(WORLDS_DIR).entry(actor)?.kind === "anon" })?.can?.[permission] === true;
  }
  /** Actors, role holders, moderated people, remembered bodies. requestwire.ts whois is scoped to these, never the
   *  whole directory. */
  knownIds(): Set<string> {
    const out = new Set<string>([...this.actors, ...Object.keys(this.poses)]);
    for (const k of Object.keys(this.live.state().entities?.["@world"]?.c ?? {})) if (k.startsWith("roles:")) out.add(k.slice(6));
    for (const m of this.live.mod ?? []) if (typeof m?.who === "string") out.add(m.who);
    for (const id of [...out]) if (!/^u-[a-z2-7]{20}$/.test(id)) out.delete(id);   // system, world, script:… aren't people
    return out;
  }
  /** join must refuse it too */
  bannedHere(actor: string): boolean { return isBanned(this.live, actor); }
  private anon(actor: string) { return directoryFor(WORLDS_DIR).entry(actor)?.kind === "anon"; }
  /** roles.js effectiveOf */
  rightsOf(actor: string) { return effectiveIn(this.live.state(), actor, { anon: this.anon(actor) }); }
  /** join refuses a running one */
  kickedHere(actor: string): Any { return kickOf(this.live, actor); }
  mutedHere(actor: string, channel?: "voice" | "chat"): Any { return muteOf(this.live, actor, channel); }
  /** the voice-mute sweep reads it */
  sanctions(): Record<string, Any> { return sanctionsNow(this.live); }
  /** reset is theirs alone */
  seniorOwner(): string | null { return seniorOwnerOf(this.live); }
  access(): Any { const a = this.live.state().entities?.["@world"]?.c?.access; return a && typeof a === "object" ? a : null; }
  /** access.join 'listed' */
  listedHere(actor: string): boolean { return !!this.live.state().entities?.["@world"]?.c?.[`roles:${actor}`]; }
  /** The fold (replica.js wireState), its head, and the asker's undoable acts (newest last), so Ctrl+Z survives a reload. */
  clientCut(actor: string) {
    const X = actIndexOf(this.live); const E = this.live.entries;
    const mine = (X.actsOf.get(actor) ?? []).filter((q: number) => !["undo", "create-world", "throw", "drop", "leave", "move", "grab"].includes(E[q].verb) && !X.undone.has(q) && X.resultOf.has(q)).slice(-40);
    return { ...clientCutOf(this.live), head: this.head, mine, you: actor, names: this.names([...this.actors, actor]), holds: this.holds() };
  }
  rememberPose(id: string, pose: unknown, settle: (p: unknown) => unknown) {
    if (!pose) return;
    this.poses[id] = settle(pose);
    try { fs.mkdirSync(this.dir, { recursive: true }); atomicWrite(this.posesPath, JSON.stringify(this.poses)); } catch (err) { console.error(`[world:${this.name}] poses`, err); }
  }
  /** agents read it to route their tools */
  info() { return { dialect: DIALECT, v: VERSION, head: this.head, worldId: this.live.worldId, verbs: "send {type: 'request', id, verb, args}; reply {type: 'reply', id, …}" }; }
}

// ---- founding and translating (tools/protocol/world.ts is the command line) ----
import { opsOf, DIALECT, VERSION } from "../shared/protocol/fold.js";
import { isOwner } from "../shared/protocol/roles.js";
import { envNumber, WORLD_NAME_RE } from "./limits.ts";

/** `dir` must not hold a world. */
export function foundWorld(dir: string, name: string, owner: string, title?: string, now?: () => number) {
  if (fs.existsSync(path.join(dir, "world.jsonl")) || fs.existsSync(path.join(dir, "log.jsonl"))) throw new Error(`${dir} already holds a world`);
  mkdirDurable(dir);   // a crash can lose the directory's name like the log's first line
  const w = openLive(dir, name, { now });
  // a bare name means `local:<name>`, as a TRUST_NAMES server gives it
  const acct = /^(human|agent|aid1|local):/.test(owner) ? owner : `local:${owner.toLowerCase()}`;
  const id = directoryFor(path.dirname(dir)).resolve({ sub: acct, name: acct.startsWith("local:") ? owner : acct.split(":").pop()! });
  const r = authorityRequest(w, id, "create-world", { title: title ?? name });
  if (!r.ok) throw new Error(`founding refused: ${JSON.stringify(r.refused)}`);
  return { worldId: w.worldId, owner: id, account: acct, entries: w.entries.length };
}

// ---------- a person founds a world they own ----------
// who may is requestwire.ts world-found's call. Ledger caps: perAccount is a lifetime cap, perHour stops a land rush.
export const FOUNDING = {
  perAccount: envNumber("FOUND_PER_ACCOUNT", 3),
  perHour: envNumber("FOUND_PER_HOUR", 12),
  gapMs: envNumber("FOUND_GAP_MS", 10 * 60_000),
};
export const FOUND_NAME = /^[a-z0-9][a-z0-9-]{2,31}$/;
const foundersPath = () => path.join(WORLDS_DIR, ".founders.json");
export function foundersLedger(): Record<string, { account: string; actor: string; ts: number }> {
  try { const v = JSON.parse(fs.readFileSync(foundersPath(), "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
/** A sentence for the person, or null when it may. */
export function foundRefusal(account: string, name: string, exists: (n: string) => boolean, now = Date.now()): string | null {
  if (!FOUND_NAME.test(name)) return `"${name.slice(0, 40)}" can't be a world's name: 3 to 32 lowercase letters, digits and '-', starting with a letter or digit`;
  if (exists(name)) return `there's already a world called "${name}" — pick another name`;
  const L = Object.values(foundersLedger());
  const mine = L.filter((x) => x.account === account);
  if (mine.length >= FOUNDING.perAccount) return `you've founded ${mine.length} worlds here, the most one account may (${FOUNDING.perAccount})`;
  const last = Math.max(0, ...mine.map((x) => x.ts));
  if (now - last < FOUNDING.gapMs) return `you founded a world ${Math.round((now - last) / 60000)} min ago — one every ${Math.round(FOUNDING.gapMs / 60000)} min`;
  if (L.filter((x) => now - x.ts < 3600_000).length >= FOUNDING.perHour) return `this server has had ${FOUNDING.perHour} new worlds in the last hour, its limit — try again later`;
  return null;
}
/** Built aside, renamed into place: nothing half-made. */
export function foundOwnedWorld(name: string, actor: string, account: string, title?: string, exists: (n: string) => boolean = (n) => fs.existsSync(path.join(WORLDS_DIR, n)), now = Date.now()):
  { ok: true; worldId: string } | { ok: false; err: string } {
  const why = foundRefusal(account, name, exists, now); if (why) return { ok: false, err: why };
  const dest = path.join(WORLDS_DIR, name);
  const tmp = path.join(WORLDS_DIR, `.founding-${name}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    fs.mkdirSync(tmp, { recursive: true });
    const w = openLive(tmp, name, { catalogue: ENGINE_CATALOGUE });
    const r = authorityRequest(w, actor, "create-world", { title: String(title || name).slice(0, 80) });
    if (!r.ok) throw new Error(`the authority refused the founding: ${r.refused?.reason}`);
    if (fs.existsSync(dest)) throw new Error(`there's already a world called "${name}"`);   // taken meanwhile
    // answered only once the new name and the ledger are durable
    fs.renameSync(tmp, dest); syncDir(WORLDS_DIR);
    const L = foundersLedger(); L[name] = { account, actor, ts: now }; replaceDurable(foundersPath(), JSON.stringify(L, null, 1));
    return { ok: true, worldId: w.worldId };
  } catch (e: Any) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { ok: false, err: String(e?.message ?? e) };
  }
}

// ---------- fork and reset ----------
const headOf = (live: Any) => live.headAt(live.entries.length - 1);
function parentsFirst(st: Any): string[] {
  const out: string[] = [], seen = new Set<string>();
  const visit = (id: string, depth = 0) => { if (seen.has(id) || depth > 64) return; seen.add(id);
    const p = st.entities[id]?.c.parent?.to; if (typeof p === "string" && st.entities[p]) visit(p, depth + 1); out.push(id); };
  for (const id of Object.keys(st.entities)) if (id !== "@world") visit(id);
  return out;
}
/** Ordinary requests (the same gate as a hand edit), batched under the 1 MiB line cap. Locks and pins go last. */
function copyInto(w: Any, actor: string, st: Any, skipWorld: (k: string) => boolean) {
  const reqs: Any[] = [], late: Any[] = [];
  for (const [k, v] of Object.entries<Any>(st.entities["@world"]?.c ?? {})) if (!skipWorld(k)) reqs.push({ verb: "set", args: { id: "@world", component: k, value: v } });
  for (const id of parentsFirst(st)) {
    const { model, lock, ...comps } = st.entities[id].c;
    reqs.push({ verb: "create", args: { id, ...(model !== undefined ? { model } : {}), components: comps } });
    if (lock !== undefined) late.push({ verb: "set", args: { id, component: "lock", value: lock } });
  }
  const all = [...reqs, ...late]; let batch: Any[] = [], size = 0, acts = 0;
  const flush = () => { if (!batch.length) return; const r = forkCopy(w, actor, { ops: batch, throughLock: true });   // fork-copy: inherited, not born
    if (!r.ok) throw new Error(`the copy was refused at ${JSON.stringify(batch[r.refused?.op ?? 0]?.args?.id ?? "?")}: ${r.refused?.code} ${r.refused?.reason}`); acts++; batch = []; size = 0; };
  for (const q of all) { const n = JSON.stringify(q).length; if (size + n > 400_000) flush(); batch.push(q); size += n; }
  flush();
  return acts;
}
const canonOf = (st: Any, skipWorld: (k: string) => boolean) => JSON.stringify(Object.keys(st.entities).sort().map((id) => [id,
  Object.keys(st.entities[id].c).filter((k) => id !== "@world" || !skipWorld(k)).sort().map((k) => [k, st.entities[id].c[k]])]));

/** A NEW world naming its source, renamed into place only once its state equals the source's. Chat isn't copied. */
export function forkWorld(src: WorldLog, to: string, forker: string): { ok: true; worldId: string; things: number; acts: number } | { ok: false; err: string } {
  if (!WORLD_NAME_RE.test(to)) return { ok: false, err: `bad world name "${to}" — letters, digits, - and _ only` };
  if (to === src.name) return { ok: false, err: "a world can't be copied onto itself" };
  const dest = path.join(WORLDS_DIR, to);
  if (fs.existsSync(dest)) return { ok: false, err: `world "${to}" already exists` };
  const tmp = path.join(WORLDS_DIR, `.forking-${to}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    const st = src.live.state();
    fs.mkdirSync(tmp, { recursive: true });
    const blobs = path.join(WORLDS_DIR, src.name, "blobs");   // content-addressed: all of them travel
    if (fs.existsSync(blobs)) { fs.cpSync(blobs, path.join(tmp, "blobs"), { recursive: true }); syncTree(path.join(tmp, "blobs")); }   // cpSync syncs nothing
    const w = openLive(tmp, to, { catalogue: ENGINE_CATALOGUE });
    const title = st.entities["@world"]?.c.about?.name ?? to;
    const at = src.live.entries.length - 1;   // the merge base (PROTOCOL §13)
    const r0 = authorityRequest(w, forker, "create-world", { title, from: { world: src.live.worldId, name: src.name, seq: at, head: src.live.headAt(at) } });
    if (!r0.ok) throw new Error(`founding refused: ${r0.refused?.reason}`);
    // the founding act wrote about and the forker's role; canonOf uses the same skip, so they agree
    const skip = (k: string) => k === "about" || k === `roles:${forker}`;
    const acts = copyInto(w, forker, st, skip);
    const back = w.state();
    if (canonOf(back, skip) !== canonOf(st, skip)) throw new Error("the copy doesn't match the source (nothing was kept)");
    fs.renameSync(tmp, dest); syncDir(WORLDS_DIR);   // durable before it is answered
    return { ok: true, worldId: w.worldId, things: Object.keys(st.entities).length - 1, acts };
  } catch (e: Any) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { ok: false, err: String(e?.message ?? e) };
  }
}
/** Log and poses archived (never deleted; blobs stay) into reset-<time>/, refounded by the same owners. Returns the
 *  archive directory; the caller swaps in a fresh WorldLog. */
export function resetWorld(log: WorldLog): string {
  const st = log.live.state();
  const owners = Object.entries<Any>(st.entities["@world"]?.c ?? {}).filter(([k, v]) => k.startsWith("roles:") && isOwner(v)).map(([k]) => k.slice(6));
  if (!owners.length) throw new Error("this world has no owner to found it again");
  const prev = { world: log.live.worldId, name: log.name, head: headOf(log.live) };
  const dir = path.join(WORLDS_DIR, log.name);
  // found ASIDE first: a refused founding changes nothing
  const fresh = path.join(WORLDS_DIR, `.refound-${log.name}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    fs.mkdirSync(fresh, { recursive: true });
    const w = openLive(fresh, log.name, { catalogue: ENGINE_CATALOGUE });
    const r0 = authorityRequest(w, owners[0], "create-world", { title: st.entities["@world"]?.c.about?.name ?? log.name, from: prev });
    if (!r0.ok) throw new Error(`founding again refused: ${r0.refused?.reason}`);
    for (const o of owners.slice(1)) { const r = authorityRequest(w, owners[0], "set", { id: "@world", component: `roles:${o}`, value: { role: "owner" } });
      if (!r.ok) throw new Error(`restoring owner ${o} refused: ${r.refused?.reason}`); }
    // erasing content must not open a world's door (#258): access, default-role and live roles come back
    const wc = st.entities["@world"]?.c ?? {};
    if (wc.access != null) {
      const now = Date.now();
      const keep: [string, Any][] = Object.entries<Any>(wc).filter(([k, v]) => (k === "access" || k === "default-role" || k === "role-defs"
        || (k.startsWith("roles:") && !isOwner(v))) && !(Number.isSafeInteger(v?.until) && v.until <= now));
      keep.sort(([a], [b]) => (a === "role-defs" ? -1 : b === "role-defs" ? 1 : 0));   // a role refers to custom roles
      for (const [k, v] of keep) { const r = authorityRequest(w, owners[0], "set", { id: "@world", component: k, value: v });
        if (!r.ok) throw new Error(`keeping ${k} through the reset refused: ${r.refused?.reason}`); }
    }
  } catch (e) { fs.rmSync(fresh, { recursive: true, force: true }); throw e; }
  const arch = path.join(dir, `reset-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirDurable(arch);
  // past the first rename a failure says where the old log went
  try {
    for (const f of ["world.jsonl", "poses.json"]) if (fs.existsSync(path.join(dir, f))) fs.renameSync(path.join(dir, f), path.join(arch, f));
    syncDir(arch);   // the archive's names first: a crash never loses the old log
    fs.renameSync(path.join(fresh, "world.jsonl"), path.join(dir, "world.jsonl")); syncDir(dir);
  } catch (e: Any) { const err: Any = new Error(String(e?.message ?? e)); err.movedTo = arch; err.freshAt = fresh;
    // if the old log is still in place the world is as it was and stays live
    err.logMoved = fs.existsSync(path.join(arch, "world.jsonl")) || !fs.existsSync(path.join(dir, "world.jsonl")); throw err; }
  // failing to remove the scratch directory leaves litter for the operator, not a failed reset
  try { fs.rmSync(fresh, { recursive: true, force: true }); } catch (e) { console.warn(`[world] reset left its scratch directory ${fresh}: ${e}`); }
  return arch;
}
