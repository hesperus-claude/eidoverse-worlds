// Voice health: a visible 'degraded' state for an SFU broken but alive (#104 amendment 2; a dead one dies with the server, and the
// restart's new incarnation, transport.ts, stales every credential).

import { currentIncarnation } from "./transport.ts";

export type VoiceState = "live" | "degraded";

let state: VoiceState = "live";
let reason = "";
let notify: ((s: VoiceState, incarnation: string, reason: string) => void) | null = null;

/** server.ts supplies the broadcast; the supervisor owns the decision. */
export function onVoiceServiceChange(fn: typeof notify) { notify = fn; }

/** Repeated faults update the reason: the LATEST is the one an operator needs. */
export function markVoiceDegraded(why: string) {
  const wasDegraded = state === "degraded";
  state = "degraded"; reason = why;
  if (!wasDegraded) {
    console.error(`[sfu] voice DEGRADED: ${why}`);
    try { notify?.(state, currentIncarnation(), reason); } catch { /* never recurse */ }
  }
  // no silence timer (a dead subsystem is silent forever): recovery needs a POSITIVE receipt via markVoiceLive
}

/** Positive health receipt only. Clients rejoin under the CURRENT incarnation, so no stale leg is resurrected. */
export function markVoiceLive(why = "") {
  if (state === "live") return;
  state = "live"; reason = why;
  console.log(`[sfu] voice LIVE again${why ? `: ${why}` : ""}`);
  try { notify?.(state, currentIncarnation(), reason); } catch { /* never recurse */ }
}

export const voiceServiceState = () => ({ state, reason, incarnation: currentIncarnation() });
