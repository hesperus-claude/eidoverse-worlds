// Which voice transport is live, and the durable incarnation every credential
// carries. Transport-NEUTRAL by construction: this module imports no adapter.
//
// Kept apart so asking "are we on the SFU?" never imports a transport implementation.

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { nextIncarnation } from "./relaydecision.ts";

/** Which voice transport is live.
 *  - "sfu": our in-process SFU (no external service, so the flag alone enables it).
 *  - "off" (the default): NO VOICE AT ALL — text/presence/builds live, every voice control present and inert. It names
 *    no fallback: there is no P2P mesh behind it. */
export const voiceTransport = (): "sfu" | "off" =>
  process.env.VOICE_TRANSPORT === "sfu" ? "sfu" : "off";

export const relayEnabled = () => voiceTransport() !== "off";

// ---- durable incarnation ----------------------------------------------------
// Advanced atomically at every boot (tmp + rename; the entropy suffix keeps even a lost-file counter reuse
// non-colliding). Every credential and admission check carries it, so a restart strands every old credential.
// 🔴 SELF-INITIALISING: a process-unique value from the start, upgraded to the durable one when a server boots it.
// A fixed sentinel would be one incarnation shared by every process that never boots (tests, tools): the credential
// collision amendment 2 exists to prevent.
let incarnation = nextIncarnation(null, crypto.randomUUID().slice(0, 8));

export function bootIncarnation(dir: string): string {
  const file = join(dir, "relay-incarnation");
  const prev = existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  incarnation = nextIncarnation(prev, crypto.randomUUID().slice(0, 8));
  const tmp = file + ".tmp";
  writeFileSync(tmp, incarnation);
  renameSync(tmp, file);
  return incarnation;
}

export const currentIncarnation = () => incarnation;
