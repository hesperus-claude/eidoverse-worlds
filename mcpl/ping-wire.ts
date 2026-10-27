// ping-wire: the two renderings of a ping, pure so they are testable (net-server.ts listens at import).
// Receipt: tools/approach-wire-test.ts.
//  - pingLine:     the pending_pings queue line (plain-MCP hosts, server.ts)
//  - pingDelivery: the channel frame (MCPL hosts, net-server.ts deliver())

import { CHAT, EIDO, tags, senderFacet } from "./declaration.ts";

export type WirePing = {
  ts: number;
  kind: "mention" | "approach" | "depart" | "reach" | "touch";
  who: string;
  text?: string;
};

/** Every kind renders as itself; depart carries the agent's wording, since only it knows who moved. */
export function pingLine(p: WirePing): string {
  switch (p.kind) {
    case "mention": return `@ ${p.who}: ${p.text}`;
    case "approach": return `≈ ${p.who} walked up to you`;
    case "depart": return `≈ ${p.who} ${p.text ?? "is no longer nearby"}`;
    default: return `≈ ${p.who} ${p.text}`;
  }
}

/** null for kinds the event path already delivers (a mention rides its say). approach/reach/touch: chat:addressed
 *  + mentioned; depart: ambient + chat:system (nobody said it), never mentioned. `declares` (PROTOCOL §6a rule 3)
 *  rides verbatim; only "agent" maps to a tag (declaration.ts senderFacet). */
export function pingDelivery(p: WirePing, declares: string | null):
  { text: string; tags: string[]; mentioned?: true; declares?: string } | null {
  const d = typeof declares === "string" && declares ? { declares } : {};
  const from = senderFacet(declares);
  switch (p.kind) {
    case "approach":
      return { text: `* ${p.who} walked up to you`, tags: tags(CHAT.addressed, EIDO.approach, from), mentioned: true, ...d };
    case "depart":
      return { text: `* ${p.who} ${p.text ?? "is no longer nearby"}`, tags: tags(CHAT.ambient, CHAT.system, EIDO.depart, from), ...d };
    case "reach":
    case "touch":
      return { text: `* ${p.who} ${p.text}`, tags: tags(CHAT.addressed, p.kind === "touch" ? EIDO.touch : EIDO.reach, from), mentioned: true, ...d };
    default:
      return null;
  }
}
