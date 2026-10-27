// Which voice transport is live, and the durable incarnation every credential carries. Transport-NEUTRAL by
// construction: this module imports no adapter.

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { nextIncarnation } from "./relaydecision.ts";

/** "sfu" (in-process) or "off" (default), which is NO VOICE AT ALL, not a mesh fallback (gone since #132); a failed cutover rolls back
 *  to the previous release (notes/CUTOVER-ROLLBACK.md). */
export const voiceTransport = (): "sfu" | "off" =>
  process.env.VOICE_TRANSPORT === "sfu" ? "sfu" : "off";

export const relayEnabled = () => voiceTransport() !== "off";

// ---- durable incarnation ----------------------------------------------------
// advanced atomically each boot (tmp + rename): a restart strands every old credential.
// Process-unique from import, never a fixed sentinel (it would collide across processes).
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
