// the seven refusals of #104 amendment 1, through the in-process SFU adapter: relay-decision-test.ts proves them on the
// decision layer; this proves reusing relaydecision.ts is a real inheritance
import { mintSfuCredential, admitSfuLeg, setSfuConsent, setSfuModeratorMute,
  revokeSfuLeg, sfuDiag, sfuState, registerSfuSender } from "../server/sfuadapter.ts";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = "") => { console.log(`  ${c ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${n}${d ? "  " + d : ""}`); c ? pass++ : fail++; };

const W = "spike";
const s = sfuState(W);
const c = mintSfuCredential(W, "alice", 412, 413);
const live = { world: W, incarnation: c.incarnation, primaryGen: 412, mediaGen: 413, usedNonces: s.usedNonces };
const claims = (o = {}) => ({ world: W, id: "alice", primaryGen: 412, mediaGen: 413, incarnation: c.incarnation, nonce: crypto.randomUUID(), ...o });

check("1 wrong world refused", admitSfuLeg(W, claims({ world: "elsewhere" }), live).reason === "wrong world");
check("2 wrong identity refused", admitSfuLeg(W, claims({ id: "" }), live).reason === "no identity");
check("3 retired primary generation refused", admitSfuLeg(W, claims({ primaryGen: 411 }), live).reason === "retired primary generation");
check("4 retired media generation refused", admitSfuLeg(W, claims({ mediaGen: 409 }), live).reason === "retired media generation");
check("5 prior relay incarnation refused", admitSfuLeg(W, claims({ incarnation: "i0-old" }), live).reason === "prior relay incarnation");
const good = claims();
check("   (a valid credential IS admitted)", admitSfuLeg(W, good, live).admit === true);
check("6 removed participant cannot reuse its token", admitSfuLeg(W, good, live).reason === "credential replay");
// 7 expiry: no bearer token at all; the nonce is single-use and the leg dies with the websocket, so no window to expire INTO
check("7 expiry: no bearer token exists to replay (nonce is single-use)", s.usedNonces.has(good.nonce));

// amendment 3: three independent states
setSfuConsent(W, "bob", 1, true);
check("consent is listener-authored and gen-bound", s.consent.get("bob")?.consent === true);
setSfuModeratorMute(W, "alice", true);
check("moderator mute is a DIFFERENT state than consent",
  // ONE store: the SFU is the enforcement point and owns the fact; a shadow Set in the adapter is the duplication that diverges
  s.sfu.diag().muted.includes("alice") && s.consent.get("alice") === undefined);

// measurement hygiene: delivered and suppressed reported separately
const d = sfuDiag(W) as any;
check("diag separates forwarded from suppressed", typeof d.forwarded === "number" && typeof d.suppressed?.gated === "number");
// 🔴 ASSERT OPACITY, NOT LENGTH: a prefixed counter + a non-empty unpredictable suffix (transport.ts uses 8 hex, enough
// to keep a lost-file counter reuse from colliding)
check("incarnation is opaque, not a claimed-monotonic counter",
  /^i\d+-[0-9a-f]{6,}$/.test(d.incarnation));

revokeSfuLeg(W, "alice");
check("retirement clears the leg", (sfuDiag(W) as any).moderatorMuted.length === 0);

// ── THE REVOCATION FAMILY ─────────────────────────────────────────────────
// a privacy guarantee must hold under EVERY ordering: stale gen, newer gen, double revoke, reconnect, a late speaker.
// 🔴 These assert `allows()`, NOT route existence: a revoked route stays negotiated and is STARVED (a memory write,
// not an SDP round trip)
{
  const allowed = (w: string, l: string, sp: string) =>
    (sfuState(w).sfu as unknown as { allows(a: string, b: string): boolean }).allows(l, sp);

// 1. the exact bug: revoke at a stale gen must still silence
{ const W="w1"; mintSfuCredential(W,"L",1,2); mintSfuCredential(W,"S",1,4);
  setSfuConsent(W,"L",2,true);
  check("consent ON permits the pair", allowed(W,"L","S"));
  setSfuConsent(W,"L",0,false);                      // STALE gen
  check("revoke at a STALE gen still silences", !allowed(W,"L","S")); }

// 2. revoke at a NEWER gen (the reconnect case)
{ const W="w2"; mintSfuCredential(W,"L",1,2); mintSfuCredential(W,"S",1,4);
  setSfuConsent(W,"L",2,true);
  setSfuConsent(W,"L",99,false);
  check("revoke at a NEWER gen silences", !allowed(W,"L","S")); }

// 3. double revoke (idempotent NO must stay NO)
{ const W="w3"; mintSfuCredential(W,"L",1,2); mintSfuCredential(W,"S",1,4);
  setSfuConsent(W,"L",2,true); setSfuConsent(W,"L",2,false); setSfuConsent(W,"L",2,false);
  check("double revoke stays silent", !allowed(W,"L","S")); }

// 4. 🔴 THE RECONNECT: a retired leg's consent must NOT resurrect
{ const W="w4"; mintSfuCredential(W,"L",1,2); mintSfuCredential(W,"S",1,4);
  setSfuConsent(W,"L",2,true);
  revokeSfuLeg(W,"L");                               // listener disconnects
  mintSfuCredential(W,"L",1,6);                      // …and comes back, new gen
  check("a reconnected listener starts FAIL-CLOSED (no resurrected yes)", !allowed(W,"L","S")); }

// 5. consent BEFORE the speaker exists, then speaker joins
{ const W="w5"; mintSfuCredential(W,"L",1,2);
  setSfuConsent(W,"L",2,true);
  mintSfuCredential(W,"S",1,4);                      // arrives LATER
  check("a speaker joining after consent IS permitted", allowed(W,"L","S"));
  setSfuConsent(W,"L",2,false);
  check("…and revoking still silences that late speaker", !allowed(W,"L","S")); }

// 6. moderator mute vs consent: independent states (amendment 3)
{ const W="w6"; mintSfuCredential(W,"L",1,2); mintSfuCredential(W,"S",1,4);
  setSfuModeratorMute(W,"S",true);
  setSfuConsent(W,"L",2,true);
  const s = sfuState(W);
  check("consent does not un-mute a moderator-muted speaker", s.sfu.diag().muted.includes("S")); }


}

// ── RECONNECT MUST NOT RESURRECT CONSENT ──────
// 🔴 these call revokeSfuLeg themselves, so they pin that retirement CLEARS everything, not that server.ts
// retireRelayLeg REACHES it (tools/sfu-browser-smoke.mjs does). A new per-listener map: add it here AND check the live path
{
  const W = "reconnect";
  const st = sfuState(W);
  const allows = (l: string, sp: string) =>
    (st.sfu as unknown as { allows(a: string, b: string): boolean }).allows(l, sp);
  mintSfuCredential(W, "lis", 1, 2);
  mintSfuCredential(W, "spk", 1, 4);
  setSfuConsent(W, "lis", 1, true);
  check("consent ON permits the pair", allows("lis", "spk"));
  setSfuModeratorMute(W, "spk", true);

  revokeSfuLeg(W, "lis");                       // the leg dies WITHOUT a revoke
  mintSfuCredential(W, "lis", 1, 6);            // …and reconnects, new mediaGen
  check("a reconnected listener does NOT inherit consent", !allows("lis", "spk"));
  check("…and its standing answer is gone too", st.standingConsent.get("lis") === undefined);

  revokeSfuLeg(W, "spk");
  mintSfuCredential(W, "spk", 1, 8);            // the MUTED speaker reconnects
  // a fresh leg must not inherit a moderation act aimed at its predecessor
  check("a reconnected speaker does not inherit its predecessor's mute",
    !st.sfu.diag().muted.includes("spk"),
    `muted=${JSON.stringify(st.sfu.diag().muted)}`);
}

// 🔴 senders is world-keyed: the SAME listener id in two worlds is routine, and bare-id keying clobbers or revokes the
// other world's. The cross-world revoke comes BEFORE any negotiation, so bare-id keying shows as wsA=0
{
  const wsA: unknown[] = [], wsB: unknown[] = [];
  const WA = "senders-a", WB = "senders-b";
  mintSfuCredential(WA, "spk", 1, 2);
  mintSfuCredential(WA, "dupL", 1, 4);
  mintSfuCredential(WB, "dupL", 1, 4);
  registerSfuSender(WA, "dupL", (p) => wsA.push(p));
  registerSfuSender(WB, "dupL", (p) => wsB.push(p));  // bare keying: clobbers wsA…
  revokeSfuLeg(WB, "dupL");                           // …and this then deletes it
  setSfuConsent(WA, "dupL", 4, true);                 // negotiation fires in world A
  await new Promise((r) => setTimeout(r, 300));
  check("world A's offer reaches world A's socket despite world B's register+revoke",
    wsA.length > 0, `wsA=${wsA.length}`);
  check("…and nothing leaks into world B's socket", wsB.length === 0, `wsB=${wsB.length}`);
}

// ── adversarial-review regressions ────────────────────────────────
{
  const W2 = "rev-regress";
  const s2 = sfuState(W2);

  // #1 a refused revoke must also flip the STANDING answer: the future tense
  mintSfuCredential(W2, "lis", 1, 2);
  setSfuConsent(W2, "lis", 2, true);                       // consent ON at gen 2
  setSfuConsent(W2, "lis", 1, false);                      // revoke at STALE gen → refused
  check("refused revoke still flips standing consent (future speakers stay silent)",
    s2.standingConsent.get("lis") === false);
  mintSfuCredential(W2, "late-speaker", 3, 4);             // joins AFTER the refused revoke
  check("…and a speaker joining later is NOT consented to the revoked listener",
    !s2.sfu.diag().consent?.["lis"]?.includes?.("late-speaker"));

  // #2 a re-mint is a retirement first: no inherited consent, admission, or mute
  const W3 = "rev-remint";
  const s3 = sfuState(W3);
  const c1 = mintSfuCredential(W3, "amy", 1, 2);
  setSfuConsent(W3, "amy", 2, true);                       // predecessor's standing YES
  const v = admitSfuLeg(W3, { world: W3, id: "amy", primaryGen: 1, mediaGen: 2,
    incarnation: c1.incarnation, nonce: c1.nonce },
    { world: W3, incarnation: c1.incarnation, primaryGen: 1, mediaGen: 2, usedNonces: s3.usedNonces });
  if (v.admit) s3.admitted.add("amy");
  s3.sfu.setMuted("amy", true);                            // moderation aimed at THIS leg
  mintSfuCredential(W3, "amy", 1, 3);                      // takeover re-mint
  check("re-mint clears predecessor's admission (fresh leg must prove itself)",
    !s3.admitted.has("amy"));
  check("re-mint does not inherit predecessor's standing consent",
    s3.standingConsent.get("amy") === undefined);
  check("re-mint does not inherit a moderation mute aimed at the predecessor",
    !s3.sfu.diag().muted.includes("amy"));

  // consent given while NO leg existed must survive the first mint (no predecessor to inherit from); takeover still wipes
  const W4 = "rev-premint";
  const s4 = sfuState(W4);
  setSfuConsent(W4, "early-bird", 1, true);        // consent BEFORE any leg
  mintSfuCredential(W4, "early-bird", 1, 2);       // first mint: no predecessor
  check("pre-mint consent survives the FIRST mint (no predecessor to inherit from)",
    s4.standingConsent.get("early-bird") === true);
  mintSfuCredential(W4, "early-bird", 1, 3);       // takeover: predecessor existed
  check("…and a takeover re-mint still wipes it (fail-closed rejoin)",
    s4.standingConsent.get("early-bird") === undefined);

  // the gen WATERMARK survives with the answer: a delayed replay of an older YES must not re-grant a revoked consent
  const W5 = "rev-watermark";
  const s5 = sfuState(W5);
  setSfuConsent(W5, "careful", 1, true);           // yes at gen 1, pre-leg
  setSfuConsent(W5, "careful", 2, false);          // no at gen 2, pre-leg: the last word
  mintSfuCredential(W5, "careful", 1, 2);          // first mint
  setSfuConsent(W5, "careful", 1, true);           // delayed REPLAY of the old yes
  check("a replayed older YES after the first mint is refused (watermark preserved)",
    s5.standingConsent.get("careful") === false);
}

// ── #130 item 4: ICE IS GENERATION-BOUND, LIKE ANSWERS ─────────────────────
// A stale predecessor must not trickle candidates into its successor's pc.
{
  const { sfuAcceptIce } = await import("../server/sfuadapter.ts");
  const W = "ice-gen";
  const s6 = sfuState(W);
  mintSfuCredential(W, "walker", 1, 3);
  let accepted = 0;
  (s6.sfu as any).addIceCandidate = () => { accepted++; };
  sfuAcceptIce(W, "walker", { candidate: "c" });          // no gen at all
  check("ICE with NO generation is dropped (required, not opt-in)", accepted === 0);
  sfuAcceptIce(W, "walker", { candidate: "c" }, 2);        // predecessor's gen
  check("ICE claiming a RETIRED generation is dropped", accepted === 0);
  sfuAcceptIce(W, "walker", { candidate: "c" }, 3);        // the live gen
  check("ICE naming the LIVE generation is accepted", accepted === 1);
  mintSfuCredential(W, "walker", 1, 4);                    // takeover
  (s6.sfu as any).addIceCandidate = () => { accepted++; };
  sfuAcceptIce(W, "walker", { candidate: "c" }, 3);        // stale after takeover
  check("post-takeover, the predecessor's ICE gen is refused", accepted === 1);
}

// ── #130 item 2: DEGRADED NEVER AGES INTO GREEN; RECOVERY IS A RECEIPT ─────
// degraded is sticky (no silence timer) until a POSITIVE receipt: a completed negotiation calls markVoiceLive
{
  const { markVoiceDegraded, markVoiceLive, voiceServiceState } =
    await import("../server/sfusupervisor.ts");
  markVoiceDegraded("fault-1");
  markVoiceDegraded("fault-2");                            // repeat, mid-degraded
  check("repeat fault UPDATES the reason (latest fault is what an operator needs)",
    voiceServiceState().state === "degraded" && voiceServiceState().reason === "fault-2");
  await new Promise((r) => setTimeout(r, 50));
  check("degraded does NOT age into live — no silence timer exists to fire",
    voiceServiceState().state === "degraded");
  markVoiceLive("negotiation completed for test-leg");
  check("a positive receipt (completed negotiation) returns the service to live",
    voiceServiceState().state === "live" && /negotiation completed/.test(voiceServiceState().reason));
}

console.log(fail === 0 ? `\n\x1b[32m✅ sfu-adapter: ${pass} passed\x1b[0m` : `\n\x1b[31m❌ ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
