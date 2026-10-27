// event-wire: the tags each world event goes out with, pure so they are testable (net-server.ts listens at import).
// Receipt: tools/event-wire-test.ts. A notice nobody sent carries chat:system beside chat:ambient (RFC-001 rev 3).

import { CHAT, EIDO, tags, speechTags } from "./declaration.ts";

export type WireEventKind =
  | "say" | "act" | "activity" | "weather" | "world-change" | "arrive" | "leave";

/** A live event's tags; only speech and acts carry the sender facet (`declares`, PROTOCOL §6a rule 3; speechTags). */
export function eventTags(kind: WireEventKind, opts: { declares?: string | null; mention?: boolean } = {}): string[] {
  switch (kind) {
    case "say":
      return speechTags("say", opts.declares, !!opts.mention);
    case "act":
      return speechTags("act", opts.declares);
    case "activity":
      // the door's own summary of nearby activity: a notice, and the most frequent one
      return tags(CHAT.ambient, CHAT.system, EIDO.activityDigest);
    case "weather":
      return tags(CHAT.ambient, CHAT.system, EIDO.weather);
    case "world-change":
      return tags(CHAT.ambient, CHAT.system, EIDO.worldChange, EIDO.particles);
    case "arrive":
    case "leave":
      return tags(CHAT.ambient, CHAT.system, EIDO.presence);
  }
}

/** The "While you were away" header: the door's notice, nobody's speech. */
export function catchupHeaderTags(): string[] {
  return tags(CHAT.ambient, CHAT.system, EIDO.catchup);
}

/** A replayed mention: its original addressing plus the catch-up marker (#39), never a notice. */
export function catchupReplayTags(): string[] {
  return tags(CHAT.mention, EIDO.catchup);
}
