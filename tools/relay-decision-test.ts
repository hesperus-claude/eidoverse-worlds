// Incarnation and consent rules (#104 amendments 2, 3), pinned headless; the eight refusal branches (amendment 1) are one
// table in tools/sfu-adapter-test.ts. bun tools/relay-decision-test.ts
import { relayIdentity, parseRelayIdentity, nextIncarnation,
  subscriptionActive, applyConsentUpdate,
} from "../server/relaydecision.ts";

let pass = 0, fail = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const okv = JSON.stringify(got) === JSON.stringify(want);
  okv ? pass++ : fail++;
  console.log(`  ${okv ? "✅" : "❌"} ${name}${okv ? "" : ` — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

// the eight refusal branches: one table through admitParticipant AND admitSfuLeg in tools/sfu-adapter-test.ts

// ── identity carries the generation ─────────────────────────────────────────
t("relayIdentity embeds gen", relayIdentity("hesperus", 413), "hesperus#g413");
t("parse round-trips", parseRelayIdentity("hesperus#g413"), { id: "hesperus", mediaGen: 413 });
t("parse survives # in id", parseRelayIdentity("a#b#g7"), { id: "a#b", mediaGen: 7 });
t("parse refuses genless", parseRelayIdentity("hesperus"), null);

// ── incarnation (amendment 2) ───────────────────────────────────────────────
t("first incarnation", nextIncarnation(null, "abc"), "i1-abc");
t("advance past prev", nextIncarnation("i7-old", "new"), "i8-new");
t("lost-file restart cannot equal prev (entropy differs)",
  nextIncarnation(null, "x9") !== "i1-abc" || "i1-x9" !== "i1-abc", true);

// ── audibility: three independent states (amendment 3) ──────────────────────
t("no consent → inactive (fail closed)",
  subscriptionActive({ listenerConsent: false, moderatorMuted: false }), false);
t("consent alone → active",
  subscriptionActive({ listenerConsent: true, moderatorMuted: false }), true);
t("moderator mute beats consent",
  subscriptionActive({ listenerConsent: true, moderatorMuted: true }), false);

// ── consent updates: gen-bound, idempotent, reconnect never broadens ────────
{
  const m = new Map<string, { gen: number; consent: boolean }>();
  t("fresh consent applies", applyConsentUpdate(m, "listener-a", 500, true), { changed: true });
  t("repeat is idempotent", applyConsentUpdate(m, "listener-a", 500, true),
    { changed: false, reason: "idempotent" });
  t("stale generation cannot apply", applyConsentUpdate(m, "listener-a", 499, true),
    { changed: false, reason: "stale listener generation" });
  t("newer generation resets (fail-closed rejoin)",
    applyConsentUpdate(m, "listener-a", 501, false), { changed: true });
  t("…and the old ON cannot resurrect", applyConsentUpdate(m, "listener-a", 500, true),
    { changed: false, reason: "stale listener generation" });
}

console.log(`\n${fail === 0 ? "✅" : "❌"} relay-decision: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
