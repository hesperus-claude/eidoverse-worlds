// A World: its log (server/worldlog.ts) and the embodied plane in flight (never persisted), plus the registry.
// An old-protocol directory is refused at open with its translate command (tools/protocol/import-v1/).
// Waking scripted worlds at boot is boot policy: it stays in server.ts.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { WORLDS_DIR } from "./config.ts";
import { WorldLog, isWorldSaved, resetWorld } from "./worldlog.ts";
import { WorldScripts, type ScriptHost } from "./scripts.ts";
import type { HnSession } from "./auth.ts";
import { isOperator } from "./operators.ts";
import { gateReach } from "./reachgate.ts";
import { WORLD_NAME_RE } from "./limits.ts";

// the settle rule stays in server.ts, pinned by tools/settled-pose-test.ts's source gates (§15.1); injected at boot
let settle: (pose: unknown) => Record<string, unknown> | null = () => {
  throw new Error("settledPose not wired — server.ts wires it at boot");
};
export function wireSettledPose(fn: typeof settle) { settle = fn; }

// a role change re-sends everyone's rights via server.ts's rightsFor, injected like settle (never import server.ts)
let onRightsChanged: (w: World) => void = () => {};
export function wireRights(rights: typeof onRightsChanged) { onRightsChanged = rights; }

// ------------------------------------------------------------------- clients

export type Client = {
  renamed?: boolean; renameRefused?: { tried: string; until: number };   // the join's rename and its cooldown
  id: string;          // display name in this world (identity is actorId)
  ws: { send(data: string): void; close?(code?: number, reason?: string): void; getBufferedAmount?(): number; readyState?: number };
  world: World | null;
  /** forwarded to late joiners; only `.p` is dereferenced, the rest is opaque */
  lastPose: ({ p?: [number, number, number] } & Record<string, unknown>) | null | undefined;
  avatar: string;      // VRM library path
  spectator: boolean;  // retina/observer connections: receive everything, appear as nothing
  declares?: string;   // declared at join in its own word (PROTOCOL §6a); absent = undeclared. Never inferred
  auth?: HnSession;    // home-node session bound at WS upgrade (verified human)
  sub?: string;        // durable principal id when authenticated (`human:discord:…`)
  superseded?: boolean; // kicked by identity takeover: its stale pose must not overwrite the successor's
  // what the sanctions sweep (server.ts sanctionSweep) last applied to this connection
  sfuMuted?: boolean; sanctionKey?: string;
  tokenVerified?: boolean; // this leg presented the identity's own bearer at join
  trustedRenderer?: boolean; // a renderer that presented RENDERER_TOKEN: may watch any world (access.ts)
  auxBound?: boolean;  // this aux leg proved its primary's account (admitJoin); the voice gates read it
  gen?: number;        // surfaceSession (#57): server-issued transport epoch for THIS leg
  legGen?: number;     // WORLD-scoped, survives restarts; never reused: takeover retires the GENERATION, deferred verbs recheck it
  presenceSession?: string; // `session` on arrive and snapshot.present: the page's id, else a token for this leg
  surface?: string;    // "world" = the embodied primary (default); anything else = an aux media leg (voice, vr-hands, …):
                       // invisible, poseless, log-mute, REAPED with its primary; last-writer-wins per surface
  renderer?: boolean;  // an invisible browser renderer (legacy): donates rendering for its world
  roam?: boolean;      // a renderer the snapshot broker may send to any world that has none (snapshots.ts)
  capture?: import("./snapshots.ts").CaptureCapability; // opt-in embodied/native donor
  account?: string | null; // PROVED at first join, fixed for the socket's life; null = anonymous
  addr?: string | null; // hashed at upgrade (a guest's ban names it)
  anonymous?: boolean; // no account: a guest (an inhabitant unless the world raises guests; named as one)
  actorId?: string;      // opaque, from the authority directory (server/directory.ts)
  replica?: boolean;    // it folds the log stream itself; one that doesn't is refused at join
  bcRing?: unknown[];  // dev crash forensics (?bc=1): last N breadcrumbs, printed on close
  // rate windows: a griefer or a stuck client gets silence, not fanout
  msgs: import("./msgrate.ts").MsgBucket;   // all messages
  /** one at a time, in the order sent (server/requestwire.ts) */
  verbQueue?: Promise<void>;
  /** log head at arrival. Speech is arrival-only: a say at or below it is never sent back unless it is an admin's. */
  arrivedSeq?: number;
};

// --------------------------------------------------------------- the world

export class World {
  name: string;
  /** What DIDN'T happen and why; in memory, capped, and public like the log (ws `debug`, MCPL `world_debug`). */
  debugLog: Record<string, unknown>[] = [];
  debug(kind: string, detail: Record<string, unknown>): void {
    this.debugLog.push({ ts: Date.now(), kind, ...detail });
    if (this.debugLog.length > 300) this.debugLog.splice(0, this.debugLog.length - 300);
  }
  /** script:<name> components (server/scripts.ts) */
  scripts!: ScriptHost;
  /** Replaced in place by resetWorld. */
  log: WorldLog;
  /** Never persisted. Poses since the last stage-frame tick: latest wins, one frame per world per tick. */
  clients = new Set<Client>();
  dirty = new Map<string, unknown>();
  frameSeq = 0;
  recPath: string | null = null; // created lazily on first recorded frame
  lastRoster = "";               // deltas only

  /** A leg's GENERATION is `openSeq × 1e6 + count`: increasing within an opening and above every earlier opening's;
   *  past a million admissions it refuses rather than issue an ambiguous one. */
  readonly openSeq: number;
  private legCount = 0;
  legGen(): number {
    if (this.legCount >= 1_000_000) throw new Error(`world "${this.name}": a million legs admitted since opening — restart the sequencer to open a new generation space`);
    return this.openSeq * 1_000_000 + (++this.legCount);
  }

  modStateKey?: string;   // the last mod-state (muted badges) the sweep sent
  sfuMutedIds?: Set<string>;   // display ids the sweep has muted at the SFU (released when that connection is gone)
  /** Also on the sanctions tick: a timed allow can end with no request at all. Quiet: nothing recorded, nothing said
   *  to a reacher for a packet they didn't send. */
  regateReaches(): void {
    for (const c of this.clients) {
      if (!c.lastPose?.reach) continue;
      const p = structuredClone(c.lastPose) as Record<string, unknown>; gateReach(c, p, { quiet: true });
      if (JSON.stringify(p.reach ?? null) === JSON.stringify(c.lastPose.reach)) continue;
      c.lastPose = p as Client["lastPose"]; this.dirty.set(c.id, p);   // the next frame carries the pose without the hand
    }
  }
  /** Speech is arrival-only: the log keeps every say, but only an ADMIN reads it back past arrival: a server operator
   *  (WORLD_ADMIN), or whoever holds readChat (owners hold every permission). */
  isAdmin(c: Client): boolean { return isOperator(c.account) || (!!c.actorId && this.log.may(c.actorId, "readChat")); }
  /** null for an admin, else the earliest arrival among its connections here; none here = Infinity (all hidden). */
  sayFloor(actor: string): number | null {
    let floor = Infinity;
    for (const c of this.clients) if (c.actorId === actor) { if (this.isAdmin(c)) return null; if (Number.isInteger(c.arrivedSeq)) floor = Math.min(floor, c.arrivedSeq!); }
    return floor;
  }
  /** an identity-less connection: its own arrival */
  sayFloorFor(c: Client): number | null {
    if (this.isAdmin(c)) return null;
    return c.actorId ? this.sayFloor(c.actorId) : (Number.isInteger(c.arrivedSeq) ? c.arrivedSeq! : Infinity);
  }
  private logHost(log: WorldLog) {
    return {
      broadcast: (msg: unknown) => this.broadcast(msg),
      rightsChanged: () => onRightsChanged(this),
      debug: (kind: string, detail: Record<string, unknown>) => this.debug(kind, detail),
      present: () => [...this.clients].filter((c) => !c.spectator && c.actorId && (c.surface ?? "world") === "world").map((c) => ({ id: c.actorId!, at: Array.isArray(c.lastPose?.p) ? c.lastPose!.p! : null, ...(Number.isFinite(c.lastPose?.yaw) ? { yaw: c.lastPose!.yaw as number } : {}) })),   // yaw: the facing a carried thing turns by (heldQ)
      toActor: (actor: string, msg: unknown) => { const d = JSON.stringify(msg); let n = 0;
        for (const c of this.clients) if (c.actorId === actor && !c.spectator && (c.surface ?? "world") === "world") { try { c.ws.send(d); n++; } catch { /* gone */ } }
        return n > 0; },
      sayFloor: (actor: string) => this.sayFloor(actor),
      regateReaches: () => this.regateReaches(),
    };
  }

  constructor(name: string) {
    this.name = name;
    if (!isWorldSaved(name)) throw new Error(`world "${name}" holds no log here (a world saved by the old protocol is translated once, in place: bun tools/protocol/world.ts translate <its name>)`);
    this.log = this.openLog();
    this.openSeq = this.log.snapSeq + 1;   // past every chat line this world has numbered (seq × 1000)
    // scripts wake with the world: a timer keeps running with nobody connected
    this.scripts = new WorldScripts(this.log);
    this.scripts.sync();
    console.log(`[world:${name}] loaded — ${Object.keys(this.state.entities).length} things, head ${this.log.head}, `
      + `${Object.keys(this.poses).length} remembered poses`);
  }
  private openLog(): WorldLog {
    const log = new WorldLog(this.name);
    log.attach(this.logHost(log));
    return log;
  }

  /** shared/protocol/view.js plus the chat window */
  get state() { return this.log.state; }
  get recentSays() { return this.log.recentSays; }
  get poses() { return this.log.poses; }

  broadcast(msg: unknown, except?: Client) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c !== except) c.ws.send(data);
  }
  readHistory(opts: { before?: number; after?: number; limit?: number; verbs?: Set<string> | null; floor?: number | null }) {
    return this.log.readHistory(opts);
  }
  rememberPose(id: string, pose: unknown) { this.log.rememberPose(id, pose, settle); }

  /** Archived beside it and refounded by the same owners; replaced in place, so people rejoin on reload. Returns the
   *  archive directory. */
  resetWorld(): string {
    // a failure after the move retires this log (it would write a world.jsonl holding only what came after);
    // a second reset finishes the erase, and the old log stays in the first attempt's archive
    let arch: string;
    try { arch = resetWorld(this.log); } catch (e: any) { if (e?.logMoved) this.log.retire(WorldLog.HALF_RESET); throw e; }
    // erased whatever follows: an error carries `resetDone` and `opened`, so none reads as a reset that changed nothing
    let opened = false;
    try {
      this.log.retire();           // a request still awaiting warm() on the old log refuses instead of writing into the new file
      this.scripts.disposeAll();   // the fresh world has none
      this.log = this.openLog(); opened = true;
      this.scripts = new WorldScripts(this.log);
      this.scripts.sync();
    } catch (e) { throw Object.assign(new Error(String((e as Error)?.message ?? e)), { resetDone: arch, opened, cause: e }); }
    return arch;
  }
}

// -------------------------------------------------------------- the registry

export const worlds = new Map<string, World>();

// a function DECLARATION on purpose (§15.1): module-scope callers rely on hoisting
/** In memory or on disk, WITHOUT founding it (getWorld founds on miss; RFC-005 §3.2.7: founding is not joining). */
export function worldExists(name: string): boolean {
  if (!WORLD_NAME_RE.test(name)) return false;
  return worlds.has(name) || existsSync(join(WORLDS_DIR, name));
}

export function getWorld(name: string): World {
  if (!WORLD_NAME_RE.test(name)) throw new Error(`bad world name: ${name}`);
  let w = worlds.get(name);
  if (!w) { w = new World(name); worlds.set(name, w); }
  return w;
}

/** The authority clock (spec/PHYSICS.md §5.1): stamps entries' ts, never behind the log or backwards. Wall time only
 *  for a world with no log. */
export const authorityNow = (w: any): number => { try { const t = w?.log?.live?.now?.(); if (typeof t === "number" && Number.isFinite(t)) return t; } catch {} return Date.now(); };
