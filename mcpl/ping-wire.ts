// ping-wire — the two renderings of a ping, extracted so they are TESTABLE.
//
// net-server.ts cannot be imported by a test (it listens at module level), so
// the ping→channel mapping used to exist only as source assertions inside its
// onPing closure — declaration.ts promised "approach is addressed, depart is
// ambient" and nothing executable held it to that. Both servers now consume
// these two pure functions, and tools/approach-wire-test.ts is the receipt.
//
//  - pingLine:     the pending_pings queue line (plain-MCP hosts, server.ts)
//  - pingDelivery: the channel frame (MCPL hosts, net-server.ts deliver())

import { CHAT, EIDO, tags, senderFacet } from "./declaration.ts";

export type WirePing = {
  ts: number;
  kind: "mention" | "approach" | "depart" | "reach" | "touch";
  who: string;
  text?: string;
};

/** One pending_pings line; every kind renders as itself. Depart carries the agent's wording, since only it knows
 *  who moved (see WorldAgent.stepApproach). */
export function pingLine(p: WirePing): string {
  switch (p.kind) {
    case "mention": return `@ ${p.who}: ${p.text}`;
    case "approach": return `≈ ${p.who} walked up to you`;
    case "depart": return `≈ ${p.who} ${p.text ?? "is no longer nearby"}`;
    default: return `≈ ${p.who} ${p.text}`;   // reach / touch carry their own phrasing
  }
}

/** The channel frame for a ping, or null for kinds the event path already delivers (a mention rides its say).
 *  approach, reach, touch: chat:addressed + mentioned. depart: ambient, never mentioned (being left isn't being
 *  addressed). `declares` (PROTOCOL §6a rule 3) rides verbatim; only "agent" maps to a tag (declaration.ts senderFacet). */
export function pingDelivery(p: WirePing, declares: string | null):
  { text: string; tags: string[]; mentioned?: true; declares?: string } | null {
  const d = typeof declares === "string" && declares ? { declares } : {};
  const from = senderFacet(declares);
  switch (p.kind) {
    case "approach":
      return { text: `* ${p.who} walked up to you`, tags: tags(CHAT.addressed, EIDO.approach, from), mentioned: true, ...d };
    case "depart":
      return { text: `* ${p.who} ${p.text ?? "is no longer nearby"}`, tags: tags(CHAT.ambient, EIDO.depart, from), ...d };
    case "reach":
    case "touch":
      return { text: `* ${p.who} ${p.text}`, tags: tags(CHAT.addressed, p.kind === "touch" ? EIDO.touch : EIDO.reach, from), mentioned: true, ...d };
    default:
      return null;
  }
}
