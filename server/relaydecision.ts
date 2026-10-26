// relaydecision — the relay adapter's PURE decision logic, so #104's refusal proofs (amendment 1) and incarnation
// rules (amendment 2) are tested with no transport, sockets or clock.
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
  world: string;                 // the world this admission gate serves
  incarnation: string;           // the adapter's CURRENT incarnation
  // the sequencer's live view of this identity, or undefined if absent:
  primaryGen?: number;           // gen of the embodied world session
  mediaGen?: number;             // gen of the CURRENT relay leg issued for id
  usedNonces: Set<string>;       // nonces already admitted once
}

export type Admission = { admit: true } | { admit: false; reason: string };

/** The seven refusals, in amendment 1's order. The world websocket already authenticated the identity; everything about
 *  our generations is decided HERE. */
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

/** Participant identity on the relay carries the accepted generation, so a
 *  stale leg is visibly stale in every roster and log line (amendment 1's
 *  "relay participant identity that includes the accepted generation"). */
export const relayIdentity = (id: string, mediaGen: number) => `${id}#g${mediaGen}`;
export function parseRelayIdentity(s: string): { id: string; mediaGen: number } | null {
  const m = /^(.{1,64})#g(\d{1,12})$/.exec(s);
  return m ? { id: m[1], mediaGen: Number(m[2]) } : null;
}

/** Advance the durable incarnation past `prev` (the file's value, null if none); the entropy suffix keeps a lost-file
 *  counter reuse from colliding. Only the counter half is ordered, and only while the file survives. */
export function nextIncarnation(prev: string | null, entropy: string): string {
  const n = prev ? Number(/^i(\d+)-/.exec(prev)?.[1] ?? 0) : 0;
  return `i${n + 1}-${entropy}`;
}

/** Three audibility states (amendment 3) resolved into one question: may THIS listener's subscription to THIS speaker be
 *  active? Publisher self-mute is pre-encode and not consulted; moderation and consent are server-enforced. Fail closed. */
export interface AudibilityState {
  listenerConsent: boolean;      // listener-authored receive consent (default false)
  moderatorMuted: boolean;       // global track mute (moderation)
}
export const subscriptionActive = (s: AudibilityState) => s.listenerConsent && !s.moderatorMuted;

/** Consent updates are generation-bound and idempotent (amendment 3): a stale listener generation never applies, so a
 *  reconnect can't silently broaden consent and the fresh leg starts fail-closed. */
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
