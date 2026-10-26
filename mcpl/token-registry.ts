import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export type TokenAuth = {
  id: string; name: string; world?: string; avatar?: string;
  /** NARROWING only ("*" = any). Absent = no narrowing: the worlds decide who comes in (server/access.ts). */
  worlds?: string[];
  /** `false` narrows founding away. Absent = founding as any member (the sequencer's daily cap applies). */
  create?: boolean;
};

type Log = Pick<Console, "error" | "warn">;

function readObject(path: string): Record<string, TokenAuth> {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("root must be a JSON object");
  }
  return parsed as Record<string, TokenAuth>;
}

/** Fail-closed: a missing or malformed registry authorizes nobody; keys from the public example file are rejected
 *  even in tokens.json. */
export function readTokenRegistry(tokensPath: string, examplePath: string, log: Log = console): Record<string, TokenAuth> {
  if (!existsSync(tokensPath)) {
    log.error(`[mcpl] token registry missing: ${tokensPath}; legacy token auth disabled`);
    return {};
  }

  let live: Record<string, TokenAuth>;
  try {
    live = readObject(tokensPath);
  } catch (error) {
    log.error(`[mcpl] token registry unreadable: ${(error as Error).message}; legacy token auth disabled`);
    return {};
  }

  if (!existsSync(examplePath)) {
    log.error(`[mcpl] example token registry missing: ${examplePath}; refusing legacy token auth`);
    return {};
  }

  let exampleKeys: Set<string>;
  try {
    exampleKeys = new Set(Object.keys(readObject(examplePath)));
  } catch (error) {
    log.error(`[mcpl] example token registry unreadable: ${(error as Error).message}; refusing legacy token auth`);
    return {};
  }

  // null prototype: an attacker token like `__proto__` must never resolve through Object.prototype
  const accepted: Record<string, TokenAuth> = Object.create(null);
  for (const [token, candidate] of Object.entries(live)) {
    const digest = createHash("sha256").update(token).digest("hex").slice(0, 12);
    if (exampleKeys.has(token)) {
      const id = candidate && typeof candidate === "object" && typeof candidate.id === "string" ? candidate.id : "unknown";
      log.warn(`[mcpl] rejected public example credential sha256:${digest} id=${id}`);
      continue;
    }
    const auth = candidate as Partial<TokenAuth> | null;
    if (!auth || typeof auth !== "object" || typeof auth.id !== "string" || !auth.id) {
      log.error(`[mcpl] token registry entry sha256:${digest} has no usable string id — ignored`);
      continue;
    }
    accepted[token] = {
      id: auth.id,
      name: typeof auth.name === "string" && auth.name ? auth.name : auth.id,
      world: typeof auth.world === "string" ? auth.world : undefined,
      avatar: typeof auth.avatar === "string" ? auth.avatar : undefined,
      // RFC-005: travel to an existing world and permission to found one are distinct
      worlds: Array.isArray(auth.worlds)
        ? auth.worlds.filter((world): world is string => typeof world === "string")
        : undefined,
      create: typeof auth.create === "boolean" ? auth.create : undefined,
    };
  }
  return accepted;
}
/** The credential is attacker-controlled: own keys only. */
export function lookupToken(registry: Record<string, TokenAuth>, token: string): TokenAuth | undefined {
  return Object.hasOwn(registry, token) ? registry[token] : undefined;
}

/** id -> display name for `author.name`; ids with no distinct or with conflicting names are absent (callers fall
 *  back to the id). Never keyed by the secret. */
export function displayNameIndex(registry: Record<string, TokenAuth>): Map<string, string> {
  const index = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const auth of Object.values(registry)) {
    const name = auth.name || auth.id;
    if (index.has(auth.id) && index.get(auth.id) !== name) ambiguous.add(auth.id);
    index.set(auth.id, name);
  }
  for (const [id, name] of index) if (ambiguous.has(id) || name === id) index.delete(id);
  return index;
}

export type WireAuthor = { id: string; name: string };

/** "Who said this" for every line, live or replayed: admitted names beat the registry (and outlive disconnect and a
 *  failed reload). `renderLine` prefixes the id, never the display name, so a host isn't woken by a display name
 *  that merely contains its own. Not an authorization cache. */
export function wireAuthors(index: ReadonlyMap<string, string>) {
  const admitted = new Map<string, string>();
  return {
    refreshIndex: (next: ReadonlyMap<string, string>): void => { index = next; },
    rememberAuthor: ({ id, name }: WireAuthor): void => { admitted.set(id, name); },
    authorOf: (id: string): WireAuthor => ({ id, name: admitted.get(id) ?? index.get(id) ?? id }),
    renderLine: (author: WireAuthor, text: string): string => (author.id === "world" ? text : `${author.id}: ${text}`),
  };
}
