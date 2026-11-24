// Which voice transport is live, and the incarnation (kept across restarts) every credential carries. Imports no adapter, so asking
// "are we on the SFU?" never loads one.

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { replaceDurable } from "./durable.ts";
import { nextIncarnation } from "./relaydecision.ts";

/** Which voice transport is live.
 *  - "sfu": our in-process SFU (no external service, so the flag alone enables it).
 *  - "off" (the default): NO VOICE AT ALL — text/presence/builds live, every voice control present and inert. It names
 *    no fallback: there is no P2P mesh behind it. */
export const voiceTransport = (): "sfu" | "off" =>
  process.env.VOICE_TRANSPORT === "sfu" ? "sfu" : "off";

export const relayEnabled = () => voiceTransport() !== "off";

// ---- the incarnation, kept across restarts ----------------------------------------
// Advanced atomically and durably at every boot (replaceDurable: fsynced, so a power loss can't undo the advance); every credential carries it, so a restart strands every old one. Starts process-unique
// (not a fixed sentinel: processes that never boot, like tests and tools, would otherwise share one incarnation).
let incarnation = nextIncarnation(null, crypto.randomUUID().slice(0, 8));

export function bootIncarnation(dir: string): string {
  const file = join(dir, "relay-incarnation");
  const prev = existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  incarnation = nextIncarnation(prev, crypto.randomUUID().slice(0, 8));
  // main refused a missing dir at boot (atomicWrite's ENOENT); replaceDurable would make one, so a typo in RELAY_STATE_DIR is refused here
  if (!existsSync(dir)) throw new Error(`the relay incarnation's directory ${dir} doesn't exist (RELAY_STATE_DIR, or OPT_DIR when it is unset): create it, or fix the path`);
  replaceDurable(file, incarnation);
  return incarnation;
}

export const currentIncarnation = () => incarnation;
