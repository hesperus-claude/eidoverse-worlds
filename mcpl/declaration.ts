// What the eidoverse door DECLARES about itself: capabilities (MCPL SPEC §5.1), feature sets (§6.1–§6.2), and the
// tag vocabulary + producer ontology (§16). Three rules govern this file:
//
//  1. **Declaration is not authorization** (§5.4). The door may say what it can do, never what it is entitled to.
//     Nothing here decides whether something is allowed: that is `Session.granted()` in net-server.ts, sourced
//     only from the host's `effectiveCapabilities`.
//
//  2. **Tags are never authority (§16.6).** They describe what an event IS; they never gate delivery, open a
//     channel, or widen a grant. "Is this channel open" is decided from world state, never from a tag array.
//
//  3. **A suggestion must not be able to purchase a wake (§16.5).** `suggestedTreatment` has no `immediate` rule.

// ---- tag vocabulary --------------------------------------------------------

/** Reserved cross-platform core (§16.2). Spelled out, not imported, so this file reads as the whole contract and a
 *  core-lib version skew cannot silently change the wire. */
export const CHAT = {
  addressed: "chat:addressed",
  mention: "chat:mention",
  reply: "chat:reply",
  dm: "chat:dm",
  ambient: "chat:ambient",
  broadcast: "chat:broadcast",
  toSelf: "chat:to-self",
  fromHuman: "chat:from-human",
  fromBot: "chat:from-bot",
  fromSelf: "chat:from-self",
  fromAgent: "chat:from-agent",
  private: "chat:private",
  group: "chat:group",
  thread: "chat:thread",
} as const;

/** §16.2's sender facet: the word "agent" (PROTOCOL §6a) is tagged chat:from-agent, which hosts' wake rules read so
 *  agents don't wake on each other; nothing is inferred ("ai" is not "agent"); metadata.declares carries any word. */
export function senderFacet(declares: string | null | undefined): string | null {
  return declares === "agent" ? CHAT.fromAgent : null;
}

/** This producer's namespace (§16.1: it SHOULD match the declared name): the events a world has that chat has no
 *  word for. */
export const EIDO = {
  approach: "eidoverse:approach",
  depart: "eidoverse:depart",
  reach: "eidoverse:reach",
  touch: "eidoverse:touch",
  act: "eidoverse:act",
  presence: "eidoverse:presence",
  activityDigest: "eidoverse:activity-digest",
  weather: "eidoverse:weather",
  catchup: "eidoverse:catchup",
  worldChange: "eidoverse:world-change",
  particles: "eidoverse:particles",
} as const;

/** §16.3 core closure. Hosts MUST expand these themselves; producers SHOULD also emit them directly, as `tags()`
 *  does. */
const CLOSURE: Record<string, string[]> = {
  [CHAT.mention]: [CHAT.addressed],
  [CHAT.reply]: [CHAT.addressed],
  [CHAT.dm]: [CHAT.addressed, CHAT.private],
};

/** A conforming tag set: deduplicated (§16.1), closed under §16.3's implications, and never carrying both
 *  `chat:addressed` and `chat:ambient` (resolved here as §16.3 has hosts do, by dropping ambient). */
export function tags(...list: (string | false | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of list) {
    if (!t) continue;
    out.add(t);
    for (const implied of CLOSURE[t] ?? []) out.add(implied);
  }
  if (out.has(CHAT.addressed)) out.delete(CHAT.ambient);
  return [...out];
}

/** The tags a say and act are delivered with (net-server.ts onEvent): a say is ambient, or addressed when it
 *  mentions this body; an act is ambient and eidoverse:act; each with the sender's facet. Here so the lists
 *  themselves are tested, not only the facet. */
export function speechTags(kind: "say" | "act", declares: string | null | undefined, mention = false): string[] {
  const from = senderFacet(declares);
  if (kind === "act") return tags(CHAT.ambient, EIDO.act, from);
  return mention ? tags(CHAT.mention, CHAT.addressed, from) : tags(CHAT.ambient, from);
}

// ---- capability paths (§6.2) -----------------------------------------------

/** The closed set of legal `uses` values (SPEC §6.2 / Appendix B.2): a value outside it makes the feature set
 *  INVALID and the host disables it with reason `invalid_uses` (§6.4.1). */
export const VALID_USES: ReadonlySet<string> = new Set([
  "pushEvents",
  "tools",
  "modelInfo",
  "inferenceRequest",
  "inferenceRequest.streaming",
  "inferenceLifecycle",
  "contextHooks.beforeInference.observe",
  "contextHooks.beforeInference.inject.system",
  "contextHooks.beforeInference.inject.beforeUser",
  "contextHooks.beforeInference.inject.afterUser",
  "channels.register",
  "channels.lifecycle",
  "channels.publish",
  "channels.incoming",
  "channels.streaming",
  "channels.acknowledge",
  "channels.typing",
]);

export const CAP = {
  tools: "tools",
  channelsRegister: "channels.register",
  channelsLifecycle: "channels.lifecycle",
  channelsPublish: "channels.publish",
  channelsIncoming: "channels.incoming",
  channelsTyping: "channels.typing",
} as const;

/** §5.4: full paths, `*` matches exactly one segment, and an ancestor prefix is not a grant (`channels` doesn't
 *  confer `channels.publish`): ambiguity fails closed. */
export function capabilityMatches(granted: string, path: string): boolean {
  const g = granted.split("."), p = path.split(".");
  if (g.length !== p.length) return false;
  return g.every((seg, i) => seg === "*" || seg === p[i]);
}

// ---- producer ontology (§16.4) ---------------------------------------------

/** Suggested treatment (§16.5), applied only on the host's explicit acceptance. No rule says `immediate`: a
 *  suggestion must not purchase a wake, so every rule only quiets; being spoken to is the consumer's rule. */
const SUGGESTED_TREATMENT = [
  { tagsAny: [EIDO.presence], behavior: "mute" },
  { tagsAny: [EIDO.catchup], behavior: "mute" },
  { tagsAny: [EIDO.activityDigest], behavior: { throttle: { perMs: 300_000 } } },
  { tagsAny: [CHAT.ambient], behavior: { debounce: 180_000 } },
];

const TAG_ONTOLOGY = {
  // reserved-core descriptions are §16.2's: listing them says only "this server emits these" (§16.4)
  coreTags: [
    // no chat:dm / chat:private: world chat has no private channel
    CHAT.addressed, CHAT.mention, CHAT.ambient,
    CHAT.fromAgent,
  ],
  tags: {
    [EIDO.approach]: {
      desc: "Someone walked up to your body and stopped within arm's reach. Directed at you, but not speech — nothing was said.",
      facet: "addressing",
      implies: [CHAT.addressed],
    },
    [EIDO.depart]: {
      desc: "Someone who had walked up to you is no longer in your immediate surroundings. The closing bracket of eidoverse:approach — you only ever receive one for a person you were told had arrived. The wire text names who moved when there is evidence ('walked away' only when their own movement carried them out); otherwise it states the relation neutrally ('is no longer nearby' — you may be the one who left).",
      // ambient, not addressing: consumers can add a wake in their own rules, but can't unpick one we declare
      facet: "lifecycle",
    },
    [EIDO.reach]: {
      desc: "Someone's hand (or foot) is reaching toward your body — a named contact point on you, or a point in your frame. Directed at you, but not yet contact; the touch, if it lands, follows as eidoverse:touch.",
      facet: "addressing",
      implies: [CHAT.addressed],
    },
    [EIDO.touch]: {
      desc: "The reaching hand arrived: it now rests on the named point of your body, and tracks you until withdrawn. Attested by the toucher's own solver — the same trust as the pose stream itself.",
      facet: "addressing",
      implies: [CHAT.addressed],
    },
    [EIDO.act]: {
      desc: "An embodied transition someone else made near you — a gesture, a pose struck or released, sitting down, a moderation act.",
      facet: "lifecycle",
    },
    [EIDO.presence]: {
      desc: "Someone arrived in or left the world. Flap-suppressed producer-side before it is ever sent.",
      facet: "lifecycle",
    },
    [EIDO.activityDigest]: {
      desc: "One digest per pulse window summarising what is happening within your activity radius. Emitted ONLY while something is happening — the stream stops by itself when the area goes quiet. Cadence and radius are the agent's own to tune with the `activity` tool.",
      facet: "lifecycle",
    },
    [EIDO.weather]: {
      desc: "The world's weather or light changed on its own: a forecast segment boundary, a manual override landing or expiring, or the day crossing dawn/day/dusk/night. Derived deterministically from the authored sky policy (never a log entry); the text carries its provenance. At most one line per boundary — dwell is floored at 60s, so typically minutes-to-hours apart.",
      facet: "lifecycle",
    },
    [EIDO.worldChange]: {
      desc: "Someone changed how the world LOOKS near you — a visible authored change to a thing that is here, carrying who did it, to which entity, and whether it began, changed, or ended. Ambient and radius-gated, at most one line per (entity, component) per quiet window, and never replayed: a reconnect reconstructs the resulting state in look() without re-performing the event.",
      facet: "lifecycle",
    },
    [EIDO.particles]: {
      desc: "The world-change was an EMITTER: an entity started, retuned, or stopped emitting something visible (fire on a hearth, embers, smoke). Arrives alongside eidoverse:world-change — match the general tag to hear every visual change, this one to hear only emitters.",
      facet: "lifecycle",
    },
    [EIDO.catchup]: {
      desc: "Replayed history, not live traffic: something that happened while you were away. Carries its ORIGINAL addressing tags, so ten missed mentions still look like ten mentions — this tag is how you tell a reconnect from ten people speaking at once.",
      facet: "lifecycle",
      stability: "stable",
    },
  },
  suggestedTreatment: SUGGESTED_TREATMENT,
  // deprecated alias for hosts written against RFC-001 revision 1 (`defaultTreatment`): same list, advisory, never
  // auto-applied
  defaultTreatment: SUGGESTED_TREATMENT,
  // a world grows verbs; this namespace grows tags with them (§16.4: "a hint catalog, not a closed schema")
  open: true,
};

// ---- feature sets (§6.1) ---------------------------------------------------

export interface FeatureSetDecl {
  description: string;
  uses: string[];
  tagOntology?: unknown;
}

/** Three feature sets, because §6.4 disables a set whole when any of its `uses` is denied: the split is the
 *  degradation report. `uses` lists what the code exercises, no more (§6.4.2 catches an undeclared use anyway). */
export const FEATURE_SETS: Record<string, FeatureSetDecl> = {
  "eidoverse.world": {
    description:
      "Embodied presence in a world. The world's chat is an MCPL channel: speech, approaches, presence and an ambient activity digest arrive as channels/incoming, and publishing on the world channel IS saying it aloud in-world.",
    // channels.lifecycle: the world an agent is IN can change (eidoverse.travel shares the leaf). Presence and travel
    // are separate sets so a host can take the world without the door.
    uses: [CAP.channelsRegister, CAP.channelsLifecycle, CAP.channelsPublish, CAP.channelsIncoming],
    tagOntology: TAG_ONTOLOGY,
  },
  "eidoverse.embodiment": {
    description:
      "The body's hands and senses as tools: look, screenshot, walking, gesture and pose, building, moderation. Survives on its own — this is what a plain-MCP client gets.",
    uses: [CAP.tools],
  },
  "eidoverse.travel": {
    description:
      "Walking between the worlds this server fronts, without dropping the connection, through the `travel` tool (`channels/open` opens only the current world; a sibling world's id there is an unknown channel). Authorization is `channels.lifecycle` — a host that declines it keeps a resident who cannot leave, which is exactly today's behavior.",
    uses: [CAP.channelsLifecycle, CAP.tools],
  },
  "eidoverse.typing": {
    description:
      "Relays the host's typing signal (channels/typing) into the world as dots above the body's head while the agent works on a turn, until it speaks. Cosmetic: its loss costs the dots, nothing else.",
    uses: [CAP.channelsTyping],
  },
};

/** Fail at boot, not on the wire: a typo'd `uses` value gets the set disabled (`invalid_uses`, §6.4.1) and silently
 *  costs a resident their world. */
for (const [name, fs] of Object.entries(FEATURE_SETS)) {
  if (!fs.uses.length) throw new Error(`[mcpl] feature set "${name}" has empty uses — invalid per SPEC §6.2`);
  for (const u of fs.uses) {
    if (!VALID_USES.has(u)) throw new Error(`[mcpl] feature set "${name}" uses unrecognized capability "${u}" — SPEC §6.2 lists the only legal values`);
  }
}

// ---- the advertisement (§5.1) ----------------------------------------------

/** The manifest under `capabilities.experimental.mcpl` (§5.1). `channels` is spelled leaf by leaf because `true`
 *  would claim `acknowledge`, which this door doesn't implement; `streaming` is unused, so not claimed. No `revision`:
 *  §5.1 lets a server without §17 changes omit it, and this manifest is a module constant. */
export const MCPL_ADVERTISEMENT = {
  version: "0.5",
  pushEvents: false,
  channels: {
    register: true,
    lifecycle: true,
    publish: true,
    incoming: true,
    streaming: false,
    acknowledge: false,
    typing: true,
  },
  featureSets: FEATURE_SETS,
} as const;
