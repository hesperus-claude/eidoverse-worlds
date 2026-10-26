// Which voice transport is live, and the durable incarnation every credential carries. Transport-NEUTRAL by
// construction: this module imports no adapter.

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { nextIncarnation } from "./relaydecision.ts";

/** Which voice transport is live: "sfu" (in-process, the flag alone enables it) or "off", which is NO VOICE AT ALL, not a
 *  mesh fallback (the mesh is gone since #132); the remedy for a failed cutover is the previous release
 *  (notes/CUTOVER-ROLLBACK.md). Default "off", opt-in. */
export const voiceTransport = (): "sfu" | "off" =>
  process.env.VOICE_TRANSPORT === "sfu" ? "sfu" : "off";

export const relayEnabled = () => voiceTransport() !== "off";

// ---- durable incarnation ----------------------------------------------------
// advanced atomically each boot (tmp + rename, entropy suffix): a restart strands every old credential. Process-unique
// from import and upgraded when a server boots it, never a shared sentinel (a fixed value would collide across processes).
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
