// The relay adapter's PURE decision logic: #104's refusals (amendment 1) and incarnation rules (amendment 2), testable
// with no transport, sockets or clock.
//   incarnation — the durable relay identity: a durably advanced counter + entropy, not an epoch
//   mediaGen — this participant's relay-leg generation (the credential names exactly one)
//   nonce — a single-use credential id: a replayed bearer credential would re-admit a removed participant

export interface RelayClaims {
  world: string;
  id: string;
  primaryGen: number;
  mediaGen: number;
  incarnation: string;
  nonce: string;
}

export interface LiveLegState {
  world: string;
  incarnation: string;           // the adapter's CURRENT incarnation
  // the sequencer's live view of this identity, or undefined if absent:
  primaryGen?: number;           // gen of the embodied world session
  mediaGen?: number;             // gen of the CURRENT relay leg issued for id
  usedNonces: Set<string>;       // nonces already admitted once
}

export type Admission = { admit: true } | { admit: false; reason: string };

/** Eight refusal branches in amendment 1's order: six of its seven (expiry is upstream) plus "no living primary" and
 *  "no relay leg issued". Identity is the websocket's; every generation check is decided HERE. */
export function admitParticipant(claims: RelayClaims, live: LiveLegState): Admission {
  if (claims.world !== live.world) return { admit: false, reason: "wrong world" };
  if (!claims.id) return { admit: false, reason: "no identity" };
  if (live.primaryGen == null) return { admit: false, reason: "no living primary" };
  if (claims.primaryGen !== live.primaryGen) return { admit: false, reason: "retired primary generation" };
  if (live.mediaGen == null) return { admit: false, reason: "no relay leg issued" };
  if (claims.mediaGen !== live.mediaGen) return { admit: false, reason: "retired media generation" };
  if (claims.incarnation !== live.incarnation) return { admit: false, reason: "prior relay incarnation" };
  if (live.usedNonces.has(claims.nonce)) return { admit: false, reason: "credential replay" };
  return { admit: true };
}

/** Carries the accepted generation, so a stale leg is visibly stale in every roster and log line (amendment 1). */
export const relayIdentity = (id: string, mediaGen: number) => `${id}#g${mediaGen}`;
export function parseRelayIdentity(s: string): { id: string; mediaGen: number } | null {
  const m = /^(.{1,64})#g(\d{1,12})$/.exec(s);
  return m ? { id: m[1], mediaGen: Number(m[2]) } : null;
}

/** `prev`: the file's value, or null. The entropy suffix keeps a lost-file counter reuse from colliding; only the
 *  counter half is ordered, and only while the file survives. */
export function nextIncarnation(prev: string | null, entropy: string): string {
  const n = prev ? Number(/^i(\d+)-/.exec(prev)?.[1] ?? 0) : 0;
  return `i${n + 1}-${entropy}`;
}

/** May THIS listener's subscription to THIS speaker be active (amendment 3)? Self-mute is pre-encode and not consulted;
 *  moderation and consent are server-enforced. Fail closed. */
export interface AudibilityState {
  listenerConsent: boolean;      // listener-authored receive consent (default false)
  moderatorMuted: boolean;       // global track mute (moderation)
}
export const subscriptionActive = (s: AudibilityState) => s.listenerConsent && !s.moderatorMuted;

/** Generation-bound and idempotent (amendment 3): a stale generation never applies, so a reconnect can't silently
 *  broaden consent and the fresh leg starts fail-closed. */
export function applyConsentUpdate(
  current: Map<string, { gen: number; consent: boolean }>,
  listenerId: string, listenerGen: number, consent: boolean,
): { changed: boolean; reason?: string } {
  const prev = current.get(listenerId);
  if (prev && prev.gen > listenerGen) return { changed: false, reason: "stale listener generation" };
  if (prev && prev.gen === listenerGen && prev.consent === consent) return { changed: false, reason: "idempotent" };
  current.set(listenerId, { gen: listenerGen, consent });
  return { changed: true };
}
