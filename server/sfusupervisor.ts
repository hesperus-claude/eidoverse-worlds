// Voice service health — amendment 2's "separate participant-leg death from relay-service death", for an in-process SFU.
//
// 🔴 Being in-process makes SFU death total, not impossible, so amendment 2's observable behaviour still applies:
//   text/world service remains live · voice visibly becomes degraded · all old credentials become stale ·
//   clients perform ONE clean fresh join · no duplicate participant, playback or `performed` receipt survives
// A restart already advances the DURABLE incarnation (transport.ts), staling every prior credential; what this module
// owes is a degraded STATE visible while the process lives (an SFU can be broken without being dead).

import { currentIncarnation } from "./transport.ts";

export type VoiceState = "live" | "degraded";

let state: VoiceState = "live";
let reason = "";
let notify: ((s: VoiceState, incarnation: string, reason: string) => void) | null = null;

/** server.ts supplies the broadcast; the supervisor owns the decision. */
export function onVoiceServiceChange(fn: typeof notify) { notify = fn; }

/** Called by anything that discovers the SFU cannot do its job. Repeated
 *  faults update the reason (the LATEST fault is the one an operator needs). */
export function markVoiceDegraded(why: string) {
  const wasDegraded = state === "degraded";
  state = "degraded"; reason = why;
  if (!wasDegraded) {
    console.error(`[sfu] voice DEGRADED: ${why}`);
    try { notify?.(state, currentIncarnation(), reason); } catch { /* never recurse */ }
  }
  // 🔴 NO SILENCE TIMER: a dead subsystem is silent forever. Recovery needs a POSITIVE receipt (markVoiceLive, when an
  // owned negotiation completes end-to-end: offer → browser answer → setRemoteDescription OK).
}

/** A supervised recovery, on a POSITIVE health receipt only: a completed
 *  negotiation proves the SFU is usable. Clients rejoin under the CURRENT
 *  incarnation — which, after a process restart, is a new one, so no stale
 *  leg can be resurrected by a client that missed the transition. */
export function markVoiceLive(why = "") {
  if (state === "live") return;
  state = "live"; reason = why;
  console.log(`[sfu] voice LIVE again${why ? `: ${why}` : ""}`);
  try { notify?.(state, currentIncarnation(), reason); } catch { /* never recurse */ }
}

export const voiceServiceState = () => ({ state, reason, incarnation: currentIncarnation() });
