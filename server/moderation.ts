// Ban DATA (TEL0S_NOTES §15, step 7a): the instance-wide ban list, its persistence, and the lookup both doors share.
// Owns what is REMEMBERED, not what is done (`expel` stays in server.ts). Imported right after auth: restore runs at boot.

import { existsSync, readFileSync } from "node:fs";
import { atomicWrite } from "./fsutil.ts";
import { join } from "node:path";
import { WORLDS_DIR } from "./config.ts";

// ---- global bans ------------------------------------------------------------
// A JSON file INSIDE WORLDS_DIR. Keyed by ACCOUNT: a display name is typed, not proven.
// A guest's ban names its HASHED address and expires (ADDR_BAN_MS).
export type BanRec = { by: string; ts: number; reason?: string; name?: string; account?: string; addr?: string; until?: number; world?: string; legacySub?: boolean };
export const ADDR_BAN_MS = 24 * 3600 * 1000;
export const BANS_FILE = join(WORLDS_DIR, ".bans.json");
export const globalBans: Record<string, BanRec> = {};
export function saveGlobalBans() {
  try {
    atomicWrite(BANS_FILE, JSON.stringify(globalBans, null, 2), { mode: 0o600 });
  } catch (e) { console.log(`[mod] global ban save failed: ${e}`); }
}
/** A pre-account record's bare `sub` becomes `legacySub`; a name-keyed record with neither would hit namesakes: dropped. */
export function restoreBans(raw: Record<string, BanRec>): Record<string, BanRec> {
  const out: Record<string, BanRec> = {}; const dropped: string[] = [];
  for (const [k, b] of Object.entries(raw ?? {})) {
    if (!b || typeof b.by !== "string") continue;
    const sub = (b as any).sub;
    if (b.account || b.addr) out[k] = b;
    else if (typeof sub === "string" && sub) { const { sub: _s, ...rest } = b as any; out[k] = { ...rest, account: sub, legacySub: true }; }
    else dropped.push(b.name ?? k);
  }
  if (dropped.length) console.log(`[mod] ${dropped.length} name-only global ban(s) from before accounts dropped (they would hit namesakes): ${dropped.join(", ")}`);
  return out;
}
try {
  if (existsSync(BANS_FILE)) {
    const raw = JSON.parse(readFileSync(BANS_FILE, "utf8")) as Record<string, BanRec>;
    Object.assign(globalBans, restoreBans(raw));
    if (Object.keys(globalBans).length) console.log(`[mod] ${Object.keys(globalBans).length} global ban(s) loaded`);
  }
} catch (e) { console.log(`[mod] global ban restore failed (starting empty): ${e}`); }

/** A `legacySub` record matches that aid1 sub under any issuer. */
export function banHoldsAgainst(b: BanRec, account: string | null | undefined): boolean {
  if (!account || !b.account) return false;
  return b.account === account || (!!b.legacySub && account.startsWith("aid1:") && account.endsWith(`:${b.account}`));
}
/** Filed under `id` or that name, or holding against one of `accounts`, by the rule a door checks. */
export function bansLiftedBy(map: Record<string, BanRec>, id: string, accounts: Iterable<string>, fold: (s: string) => string): string[] {
  const accts = [...accounts];
  return Object.entries(map).filter(([k, b]) => k === id.toLowerCase() || (b.name && fold(b.name) === fold(id)) || accts.some((a) => banHoldsAgainst(b, a)) || (b as any).sub === id).map(([k]) => k);
}
/** A guest (no account) is matched by hashed address while unexpired. */
export function findBan(map: Record<string, BanRec> | undefined, account: string | null | undefined, addr?: string | null, now = Date.now(), world: string | null = null): BanRec | null {
  if (!map) return null;
  for (const b of Object.values(map)) {
    if (b.world && b.world !== world) continue;   // a guest's per-world ban (a world ban can't name a guest)
    if (banHoldsAgainst(b, account)) return b;
    if (!account && addr && b.addr === addr && (b.until ?? 0) > now) return b;
  }
  return null;
}
export const banKey = (account: string | null | undefined, addr?: string | null, world?: string | null) => `${world ? `world:${world}:` : ""}${account ? `acct:${account}` : `addr:${addr}`}`;

// ---- a guest's mute, by address ----------------------
// filed against the HASHED address in that world (≤ ADDR_BAN_MS), applied to new guests from it at join;
// kept apart from the ban list so nothing reading bans mistakes a mute for a ban
export type AddrSanction = { kind: "mute"; world: string; addr: string; actor: string; by: string; ts: number; until: number; channels?: string[]; reason?: string; ids: string[] };
export const ADDR_SANCTIONS_FILE = join(WORLDS_DIR, ".addr-sanctions.json");
export const addrSanctions: Record<string, AddrSanction> = {};
export const addrSanctionKey = (kind: string, world: string, addr: string) => `world:${world}:addr:${addr}:${kind}`;
export function saveAddrSanctions(now = Date.now()) {
  for (const [k, s] of Object.entries(addrSanctions)) if (!(s.until > now)) delete addrSanctions[k];
  try { atomicWrite(ADDR_SANCTIONS_FILE, JSON.stringify(addrSanctions, null, 2), { mode: 0o600 }); }
  catch (e) { console.log(`[mod] address sanction save failed: ${e}`); }
}
try {
  if (existsSync(ADDR_SANCTIONS_FILE)) {
    const raw = JSON.parse(readFileSync(ADDR_SANCTIONS_FILE, "utf8")) as Record<string, AddrSanction>;
    for (const [k, s] of Object.entries(raw)) if (s && s.kind === "mute" && typeof s.addr === "string" && typeof s.world === "string" && typeof s.actor === "string" && s.until > Date.now()) addrSanctions[k] = { ...s, ids: Array.isArray(s.ids) ? s.ids : [] };
  }
} catch (e) { console.log(`[mod] address sanction restore failed (starting empty): ${e}`); }
export function addrSanctionsFor(world: string, addr: string | null | undefined, now = Date.now()): AddrSanction[] {
  if (!addr) return [];
  return (["mute"] as const).map((k) => addrSanctions[addrSanctionKey(k, world, addr)]).filter((s): s is AddrSanction => !!s && s.until > now);
}
/** At most a day, never past the sanction's own end. */
export function fileAddrSanction(s: Omit<AddrSanction, "ts" | "ids" | "until"> & { until?: number | null; who: string }, now = Date.now()) {
  const until = Math.min(now + ADDR_BAN_MS, s.until ?? Infinity);
  const key = addrSanctionKey(s.kind, s.world, s.addr); const prev = addrSanctions[key];
  const { who, ...rest } = s;
  addrSanctions[key] = { ...rest, ts: now, until, ids: [...new Set([...(prev?.ids ?? []), who])] };
  saveAddrSanctions(now);
}
/** Lifts the address record filed under that identity or its current address. Returns the count. */
export function liftAddrSanction(kind: "mute", world: string, who: string, addr?: string | null): number {
  let n = 0;
  for (const [k, s] of Object.entries(addrSanctions)) if (s.kind === kind && s.world === world && (s.ids.includes(who) || (addr && s.addr === addr))) { delete addrSanctions[k]; n++; }
  if (n) saveAddrSanctions();
  return n;
}
