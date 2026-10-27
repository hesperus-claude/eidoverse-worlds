// event-wire-test: each world event's tags against the kind facet (MCPL RFC-001 rev 3); mcpl/event-wire.ts.
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/event-wire-test.ts

const { eventTags, catchupHeaderTags, catchupReplayTags } = await import("../mcpl/event-wire.ts");
const { CHAT, EIDO } = await import("../mcpl/declaration.ts");

const { mkCheck } = await import("./harness.ts");
const { check, tally } = mkCheck();
const has = (t: string[], tag: string) => t.includes(tag);
const show = (t: string[]) => JSON.stringify(t);

// ---------------------------------------------------------------- notices: nobody spoke
for (const [kind, own] of [
  ["weather", EIDO.weather],
  ["world-change", EIDO.worldChange],
  ["arrive", EIDO.presence],
  ["leave", EIDO.presence],
  ["activity", EIDO.activityDigest],
] as const) {
  const t = eventTags(kind);
  check(`${kind} is a chat:system notice`, has(t, CHAT.system), show(t));
  check(`${kind} keeps chat:ambient, so ambient wake rules still match`, has(t, CHAT.ambient), show(t));
  check(`${kind} carries its own tag`, has(t, own), show(t));
  check(`${kind} is not addressed`, !has(t, CHAT.addressed), show(t));
}
check("world-change also names the emitter", has(eventTags("world-change"), EIDO.particles));
// a notice carries no sender facet; the declaration rides as metadata (§6a rule 3)
check("an arrival is the world's notice, with no sender facet",
  !has(eventTags("arrive"), CHAT.fromAgent));

{
  const h = catchupHeaderTags();
  check("the catch-up header is a notice", has(h, CHAT.system) && has(h, CHAT.ambient) && has(h, EIDO.catchup), show(h));
  const r = catchupReplayTags();
  check("a replayed mention keeps its addressing and is NOT a notice",
    has(r, CHAT.mention) && has(r, CHAT.addressed) && has(r, EIDO.catchup) && !has(r, CHAT.system), show(r));
}

// ---------------------------------------------------------------- people: someone did something
{
  const t = eventTags("act");
  check("act is ambient", has(t, CHAT.ambient), show(t));
  check("act is not a notice: someone did it", !has(t, CHAT.system), show(t));
}
{
  const overheard = eventTags("say");
  check("overheard speech is ambient, not a notice", has(overheard, CHAT.ambient) && !has(overheard, CHAT.system), show(overheard));
  const named = eventTags("say", { declares: "agent", mention: true });
  check("speech that names you is addressed, neither ambient nor a notice",
    has(named, CHAT.mention) && has(named, CHAT.addressed) && !has(named, CHAT.ambient) && !has(named, CHAT.system), show(named));
  check("...and says an agent spoke it", has(named, CHAT.fromAgent), show(named));
  check("a declared word other than \"agent\" is no kind", !has(eventTags("say", { declares: "bot" }), CHAT.fromAgent));
}

console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
