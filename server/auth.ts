// eidoverse-worlds sequencer — identity doors (TEL0S_NOTES §15, step 7a).
// Archipelago-home sessions (cookie ⇄ aid1 token), their persistence across
// restarts, and the per-agent bearer roster from mcpl/tokens.json. Imported
// by server.ts right after config, so the restore-at-boot block below runs
// exactly where it always did in the boot sequence.

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { JtiCache, verifyToken, aid1Slug, type Aid1Payload } from "./aid1.ts";
import { ROOT } from "./config.ts";
import { atomicWrite } from "./fsutil.ts";

// ---- archipelago-home identity (connectome docs/home-node.md §7) ----------------------
// The second door beside JOIN_TOKEN: an aid1 token from the home node swaps for a session cookie at /auth.
// Verification is offline (pinned key), so with the home node down sessions and JOIN_TOKEN keep working.
//   HN_ISSUER_KEY (pinned `ed25519:…`, unset disables the door), HN_ISS, HN_AUD (staging: eidoverse2), HN_LOGIN_URL,
//   HN_REQUIRE_LOGIN=1 (sessionless browser clients go to login; JOIN_TOKEN joins still pass)
export const HN_ISSUER_KEY = process.env.HN_ISSUER_KEY ?? "";
export const HN_ISS = process.env.HN_ISS ?? "id.animalabs.ai";
export const HN_AUD = process.env.HN_AUD ?? "eidoverse";
export const HN_LOGIN_URL = process.env.HN_LOGIN_URL ?? `https://${HN_ISS}/login?audience=${HN_AUD}`;
export const HN_REQUIRE_LOGIN = process.env.HN_REQUIRE_LOGIN === "1";
export const SESSION_TTL_MS = 12 * 60 * 60_000; // event-length; re-login is two clicks

/** Verify a forwarded aid1 credential at a join-scoped door and return its identity (§24l R1); the MCPL door
 *  shares aid1Slug but keeps its own verify. */
export function aid1JoinIdentity(tok: string): { slug: string; payload: Aid1Payload } | null {
  if (!HN_ISSUER_KEY || !tok.startsWith("aid1.")) return null;
  const v = verifyToken(tok, { issuerId: HN_ISSUER_KEY, iss: HN_ISS, aud: HN_AUD, requireScopes: ["worlds:join"] });
  return v.ok ? { slug: aid1Slug(v.payload), payload: v.payload } : null;
}

// `native`: issued to a native client by browser-approved pairing (native-login.ts). It is an ordinary session
// for every world the account may join; the mark only stops it approving another native pairing. Sessions paired
// before native sessions became ordinary ones carry `nativeWorld` instead, which means the same thing now.
export type HnSession = { sub: string; name: string; scopes: string[]; claims?: Record<string, unknown>; exp: number; native?: true; nativeWorld?: string };
export const hnSessions = new Map<string, HnSession>();
export const hnJti = new JtiCache();
export function sessionFromCookie(cookie: string | null): HnSession | null {
  const m = /(?:^|;\s*)ew_sess=([a-f0-9]{64})/.exec(cookie ?? "");
  if (!m) return null;
  const s = hnSessions.get(m[1]!);
  if (!s) return null;
  if (s.exp < Date.now()) { hnSessions.delete(m[1]!); return null; }
  return s;
}

// ---- session persistence ----------------------------------------------------
// Sessions survive restarts; the file holds bearer-equivalent ids, so 0600 and gitignored (as mcpl/tokens.json).
// SESSIONS_PATH (or HN_SESSIONS_FILE) keeps a self-contained test's sessions in its scratch dir
export const SESSIONS_FILE = resolve(process.env.SESSIONS_PATH ?? process.env.HN_SESSIONS_FILE ?? join(ROOT, ".sessions.json"));
export function saveSessions() {
  try {
    const live = [...hnSessions].filter(([, s]) => s.exp > Date.now());
    // atomicWrite IS the write-then-rename: renaming the consumed .tmp again would throw on every good save
    atomicWrite(SESSIONS_FILE, JSON.stringify(Object.fromEntries(live)), { mode: 0o600 });
  } catch (e) { console.log(`[auth] session save failed: ${e}`); }
}
try {
  if (existsSync(SESSIONS_FILE)) {
    const raw = JSON.parse(readFileSync(SESSIONS_FILE, "utf8")) as Record<string, HnSession>;
    for (const [sid, s] of Object.entries(raw)) {
      if (/^[a-f0-9]{64}$/.test(sid) && s.exp > Date.now()) hnSessions.set(sid, s);
    }
    if (hnSessions.size) console.log(`[auth] restored ${hnSessions.size} live session(s)`);
  }
} catch (e) { console.log(`[auth] session restore failed (starting empty): ${e}`); }

// Agent identity from the MCPL door's per-agent tokens (hot-reloaded by mtime): an agent's name is RESERVED against
// plain browser joins, and a join with the right token is a verified agent.
// AGENT_TOKENS_PATH lets a self-contained test own a scratch tokens.json; production leaves it unset.
export const AGENT_TOKENS_PATH = resolve(process.env.AGENT_TOKENS_PATH ?? join(ROOT, "mcpl", "tokens.json"));
let agentTokCache: { mtime: number; byToken: Map<string, string>; names: Set<string>; bySub: Map<string, string> } | null = null;
export function agentTokens() {
  try {
    const mtime = existsSync(AGENT_TOKENS_PATH) ? Math.round(Bun.file(AGENT_TOKENS_PATH).lastModified) : 0;
    if (!agentTokCache || agentTokCache.mtime !== mtime) {
      const byToken = new Map<string, string>();
      const names = new Set<string>();
      // an enrolled agent may also arrive through the home node with an aid1 credential: `subs` lists the aid1 subjects
      // that ARE this agent (a reserved name is satisfied by a proven subject, never by a
      // display name that happens to slug the same)
      const bySub = new Map<string, string>();
      if (mtime) {
        const raw = JSON.parse(readFileSync(AGENT_TOKENS_PATH, "utf8")) as Record<string, { id?: string; subs?: string[] }>;
        for (const [tok, v] of Object.entries(raw)) {
          if (!v?.id) continue;
          byToken.set(tok, v.id);
          names.add(v.id.toLowerCase());
          for (const s of v.subs ?? []) if (typeof s === "string") bySub.set(s, v.id);
        }
      }
      agentTokCache = { mtime, byToken, names, bySub };
    }
  } catch (e) {
    console.error("[perm] mcpl/tokens.json unreadable:", (e as Error).message);
    agentTokCache ??= { mtime: 0, byToken: new Map(), names: new Set(), bySub: new Map() };
  }
  return agentTokCache;
}
