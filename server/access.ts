// WORLD ACCESS: who may come in, decided by the world (#258 / #259, docs/DESIGN-world-access.md). The facts are the world's own
// components, read by one pure function server and client share (shared/protocol/access.js):
//   @world.access {join: anyone|signed-in|listed, watch?: "anyone", max?, soft?, minAccountDays?}
//   @world.default-role, roles:<id> {role, …, until?}
// The one place every DOOR asks. It never imports server.ts: expel is injected. Not ported from upstream: the design doc.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { WORLDS_DIR, JOIN_TOKEN } from "./config.ts";
import { globalBans, findBan } from "./moderation.ts";
import { isOperator } from "./operators.ts";
import { sessionFromCookie, agentTokens, aid1JoinIdentity, bearerOf } from "./auth.ts";
import { directoryFor } from "./directory.ts";
import { accountAgeRefusal } from "./accountage.ts";
import { effectiveOf, isOwner, MOD_POWERS } from "../shared/protocol/roles.js";
import { opsOf } from "../shared/protocol/fold.js";
import { isBanned, kickOf } from "../shared/protocol/authority.js";
import { modLogAt } from "./custody.ts";
import { entryOf, doorOf as doorOfWc, listedIn, timedGrants, leftWords, ACCESS_WARN_MS } from "../shared/protocol/access.js";
import type { World, Client } from "./world.ts";
import { WORLD_NAME_RE } from "./limits.ts";

/** "This world is not open to you", at the door or on removal. Clients don't redial it (4006 moderation, 4005 a refused join; only 4005 "full" is retried). */
export const ACCESS_CLOSE = 4010;
/** "Nothing here YET" (an unfounded world). Not a refusal: clients redial with their usual backoff. */
export const NOT_YET_CLOSE = 4011;

/** `account`: null = a guest; `actorId`: opaque (server/directory.ts); `trustedRenderer`: may watch anywhere, never
 *  embody; `addr`: a guest's hashed address (bans name it). */
export type Who = { account: string | null; actorId?: string | null; trustedRenderer?: boolean; addr?: string | null };
/** `mod`: an unloaded world's moderator log, read from disk with its door (a loaded world's own log is the truth). */
export type Door = { name: string; wc: Record<string, any>; label: string; world?: World; mod?: any[] };
export type EntryMode = "embody" | "watch";
export type Refusal = { code: number; reason: "banned" | "kicked" | "no-access" | "full" | "age"; why: string; until?: number };

const wcOfWorld = (w: World): Record<string, any> => (w.log?.live?.state?.().entities?.["@world"]?.c ?? {}) as Record<string, any>;

export function doorOfWorld(w: World): Door { const wc = wcOfWorld(w); return { name: w.name, wc, label: doorOfWc(wc), world: w }; }
/** the label a listing shows */
export function doorOf(w: World): string { return doorOfWc(wcOfWorld(w)); }

// ---- a world's door, without loading the world ----------------------------------------------------------------------
// folds only @world's access/role keys plus world.mod.jsonl (loading is forever): a ban or kick must close the door
// before the world loads, as after
const doorCache = new Map<string, { key: string; wc: Record<string, any>; mod: any[] }>();
const DOOR_LINE = /"id"\s*:\s*"@world"/;
const isDoorComp = (k: unknown) => typeof k === "string" && (k === "access" || k === "default-role" || k === "role-defs" || k.startsWith("roles:"));   // role-defs: a custom role's powers (the moderation bypass)
/** Set by server.ts; a loaded world's own fold is the truth. */
let loadedWorlds: () => Map<string, World> = () => new Map();
export function setLoadedWorlds(fn: () => Map<string, World>) { loadedWorlds = fn; }

/** null when there is no such world. */
export function doorFor(name: string): Door | null {
  const live = loadedWorlds().get(name);
  if (live) return doorOfWorld(live);
  if (!WORLD_NAME_RE.test(name)) return null;
  const file = join(WORLDS_DIR, name, "world.jsonl");
  let st; try { st = statSync(file); } catch { return null; }
  const modFile = join(WORLDS_DIR, name, "world.mod.jsonl");
  let ms: { size: number; mtimeMs: number } | null = null; try { ms = statSync(modFile); } catch { ms = null; }
  const key = `${st.size}:${st.mtimeMs}:${ms ? `${ms.size}:${ms.mtimeMs}` : "-"}`;
  const hit = doorCache.get(name);
  if (hit?.key === key) return { name, wc: hit.wc, label: doorOfWc(hit.wc), mod: hit.mod };
  // unreadable moderator log: no door (as an unreadable world log), never a door that forgets its bans
  let mod: any[]; try { mod = modLogAt(modFile).mod; } catch { return null; }
  const wc: Record<string, any> = {};
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line || !DOOR_LINE.test(line)) continue;
      let e: any; try { e = JSON.parse(line); } catch { continue; }
      if (e?.kind !== "change") continue;
      let ops: any[] = []; try { ops = opsOf(e); } catch { continue; }   // a batch's ops, or a single set/delete's own body
      for (const o of ops) {
        if (o?.id !== "@world" || !isDoorComp(o.comp)) continue;
        if (o.verb === "set" && o.value && typeof o.value === "object") wc[o.comp] = o.value;
        else if (o.verb === "delete") delete wc[o.comp];
      }
    }
  } catch { return null; }
  doorCache.set(name, { key, wc, mod });
  return { name, wc, label: doorOfWc(wc), mod };
}

/** null = yes. `here` (embodied joins only): bodies in the world now, for access.max. */
export function entryFor(door: Door, who: Who, mode: EntryMode, { now = Date.now(), here = null as number | null } = {}): Refusal | null {
  const { account, actorId, addr } = who;
  // exclusion outranks everything but the operator (never locked out: the unban path of last resort), watching included:
  // a ban is exclusion, not just silencing
  if (!isOperator(account)) {
    // the loaded world's moderator log, else the one read with its door
    const off = !door.world && door.mod ? { mod: door.mod, now: () => now } : null;
    const bannedHere = (id: string) => door.world ? !!door.world.log?.bannedHere(id) : !!off && isBanned(off, id);
    const kickedHere = (id: string) => door.world ? door.world.log?.kickedHere(id) : off ? kickOf(off, id) : null;
    // the instance-wide ban, then one scoped to this world, then the world's own moderator log
    const gb = findBan(globalBans, account, addr);
    const ban = gb ?? findBan(globalBans, account, addr, now, door.name) ?? (actorId && bannedHere(actorId) ? { by: "a moderator" } as any : null);
    if (ban) return { code: 4006, reason: "banned", why: `you are banned from ${gb ? "these worlds" : `"${door.name}"`}${ban.reason ? ` — ${ban.reason}` : ""}` };
    const k = actorId ? kickedHere(actorId) : null;
    if (k) { const mins = Math.max(1, Math.ceil((k.until - now) / 60000));
      return { code: 4006, reason: "kicked", why: `you were removed from "${door.name}" and may come back in ${mins} min${k.reason ? ` — ${k.reason}` : ""}`, until: k.until }; }
  }
  // operators, owners and holders of a moderation power always get in
  const eff = actorId ? effectiveOf(door.wc, actorId, { anon: !account }) : null;
  // the bypass is for people this world LISTS: a power given through default-role or role-defs opens no members-only door;
  // an ended timed grant reads as unlisted before the authority's expire-roles sweep writes its end
  const listed = !!actorId && listedIn(door.wc, actorId, now);
  const bypass = isOperator(account) || (listed && (isOwner(eff) || MOD_POWERS.some((p: string) => eff?.permissions?.includes(p))));
  const e = entryOf(door.wc, { actor: actorId ?? undefined, anon: !account, bypass, trustedRenderer: !!who.trustedRenderer }, door.name, now);
  if (e.may === "none" || (mode === "embody" && e.may === "watch")) return { code: ACCESS_CLOSE, reason: "no-access", why: e.why ?? `"${door.name}" isn't open to you` };
  if (bypass) return null;
  const acc = door.wc.access && typeof door.wc.access === "object" ? door.wc.access : null;
  // a trusted renderer has no account and never embodies: the account-age rule is about accounts (#260)
  const age = acc && !who.trustedRenderer ? accountAgeRefusal({ world: door.name, minDays: acc.minAccountDays, account, anonymous: !account, now }) : null;
  if (age && !(mode === "watch" && acc?.watch === "anyone")) return { code: ACCESS_CLOSE, reason: "age", why: age };
  // "full" is transient: its own close (4005 "full"), which clients wait out and retry
  if (mode === "embody" && here != null && acc && Number.isInteger(acc.max) && here >= acc.max) return { code: 4005, reason: "full", why: `"${door.name}" is full (${acc.max} at once)` };
  return null;
}

/** Watching: it is on their map, its reads answer. */
export function visibleTo(door: Door | null, who: Who | null, now = Date.now()): boolean {
  return !!door && entryFor(door, who ?? { account: null }, "watch", { now }) === null;
}
export function youAt(door: Door, who: Who | null): { you: "enter" | "watch" | "none"; why?: string } {
  const embody = entryFor(door, who ?? { account: null }, "embody");
  if (!embody || embody.reason === "full") return { you: "enter" };
  const watch = entryFor(door, who ?? { account: null }, "watch");
  return { you: watch ? "none" : "watch", why: embody.why };
}

/** Session cookie or `Authorization: Bearer`. Null = anonymous (a JOIN_TOKEN bearer proves the door key, not who).
 *  Never the URL: credentials in query strings end up in logs. */
export function httpCaller(req: Request): Who | null {
  const s = sessionFromCookie(req.headers.get("cookie"));
  const dir = directoryFor(WORLDS_DIR);
  const who = (account: string): Who => ({ account, actorId: dir.idOfSub(account) });
  if (s && (s.scopes.includes("worlds:join") || s.scopes.includes("worlds:spectate"))) return who(s.sub);   // one sign-in, every world (#255: a legacy nativeWorld no longer narrows it)
  const tok = bearerOf(req);
  if (tok) {
    if (JOIN_TOKEN && tok === JOIN_TOKEN) return null;
    const at = agentTokens();
    const name = at.byToken.get(tok);
    if (name) return who(`agent:token:${name.toLowerCase()}`);
    const a = aid1JoinIdentity(tok);
    if (a && a.payload.kind === "agent") { const via = at.bySub.get(a.payload.sub); return who(via ? `agent:token:${via.toLowerCase()}` : `aid1:${a.payload.iss}:${a.payload.sub}`); }
  }
  return null;
}

export function whoOf(c: Client): Who {
  return { account: c.account ?? null, actorId: c.actorId ?? null, trustedRenderer: !!c.trustedRenderer, addr: c.addr ?? null };
}

export type Expel = (w: World, target: Client, why: string, until?: number | null, code?: number) => void;

/** After a roles/access change, removes with 4010 everyone no longer admitted. Aux legs go with their primary.
 *  Capacity never removes anyone. */
export function settleAccess(w: World, expel: Expel, now = Date.now()) {
  if (!w.log) return;
  const door = doorOfWorld(w);
  for (const c of [...w.clients]) {
    if (c.superseded || (c.surface ?? "world") !== "world") continue;   // an aux leg follows its primary
    const r = entryFor(door, whoOf(c), c.spectator ? "watch" : "embody", { now });
    if (!r || r.reason === "full") continue;
    console.log(`[world:${w.name}] ${c.id} may no longer be here (${r.reason}): removed`);
    expel(w, c, r.reason === "no-access" ? `your access to "${w.name}" ended or changed — ${r.why}` : r.why, r.until ?? null, r.code === 4006 ? 4006 : ACCESS_CLOSE);
  }
}

// timed grants: who has been warned about which end (world\0actor\0until)
const warned = new Set<string>();
/** Every second: warn once of a timed grant ending within five minutes; the authority writes passed ends (expire-roles),
 *  and whoever lost entry is removed. */
export function sweepAccess(worlds: Iterable<World>, expel: Expel, now = Date.now()) {
  for (const w of worlds) {
    if (!w.log) continue;
    const wc = wcOfWorld(w);
    for (const g of timedGrants(wc)) {
      if (g.until - now > ACCESS_WARN_MS || g.until <= now) continue;
      const k = `${w.name}\u0000${g.actor}\u0000${g.until}`;
      if (warned.has(k)) continue;
      const closes = listedIn(wc, g.actor) && wc.access?.join === "listed";
      // marked warned only once it reached them
      for (const c of w.clients) if (c.actorId === g.actor && (c.surface ?? "world") === "world")
        try { c.ws.send(JSON.stringify({ type: "notice", text: `your ${g.role} grant in "${w.name}" ends in ${leftWords(g.until, now).replace(" left", "")}${closes ? ` — this world admits only people listed, so you'll have to leave then` : ""}` })); warned.add(k); } catch { /* gone */ }
    }
    const ended = w.log.expireRoles();
    if (ended.length) { console.log(`[world:${w.name}] timed grant(s) ended: ${ended.join(", ")}`); settleAccess(w, expel, now); }
  }
  if (warned.size > 4096) warned.clear();
}
