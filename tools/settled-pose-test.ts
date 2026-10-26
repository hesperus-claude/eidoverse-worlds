// settled-pose-test: what a body looks like TO SOMEONE ELSE (#61). A pose handed to someone else is the SETTLED result, never a
// frame of physics in flight: both join-snapshot paths (`restore`, your own body; `present`, everyone else's) call
// settledPose. Pure logic, no assets (the solver's tests are tools/ragdoll-test.ts).
//   bun tools/settled-pose-test.ts

import { withoutOnceAnim, ONCE_KEYS } from "../shared/onceanim.js";

// mirror of server.ts's settledPose, held in sync by the source assertions below
function settledPose(pose: unknown): Record<string, unknown> | null {
  if (!pose) return null;
  const { mic: _mic, hear: _hear, ...still } = withoutOnceAnim(pose as Record<string, unknown>);
  if (still.clip === "ragdoll") { still.clip = "idle"; delete still.pose; }
  return still;
}

let pass = 0, fail = 0;
const ck = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "  ✓ " : "  ✗ ") + n + (ok ? "" : `  [got ${JSON.stringify(got)}, want ${JSON.stringify(want)}]`));
  ok ? pass++ : fail++;
};

// ── the bug itself ──────────────────────────────────────────────────────────
{
  const midFall = { clip: "ragdoll", pose: { hips: [0, 0, 0, 1], spine: [0.4, 0, 0, 0.9] }, p: [1, 0.6, 2] };
  const out = settledPose(midFall)!;
  ck("a mid-ragdoll frame never leaves as ragdoll", out.clip, "idle");
  ck("  ...and its tumble bones do not travel", out.pose, undefined);
  ck("  ...but position survives (she is still standing there)", out.p, [1, 0.6, 2]);
}

// ── an ENACTED pose is a place, and must survive ───────────────────────────
{
  const sitting = { clip: "sitchair", pose: { spine: [0.1, 0, 0, 0.99] }, p: [3, 0, 1] };
  const out = settledPose(sitting)!;
  ck("a held pose is a place, not physics", out.clip, "sitchair");
  ck("  ...and its bones are kept", out.pose, { spine: [0.1, 0, 0, 0.99] });
}

// ── semantic body posture survives reconnect and late join ─────────────────
{
  const vigil = { clip: "idle", poses: ["wings-folded"], p: [4, 0, 2] };
  const out = settledPose(vigil)!;
  ck("folded wings (the named pose) survive settled presence", JSON.stringify(out.poses), '["wings-folded"]');
  ck("  ...without becoming a bone override", out.pose, undefined);
}

// ── a gesture is a MOMENT, not a place ──────────────────────────────
{
  const waving = { clip: "idle", anim: "wave", p: [0, 0, 0] };
  const out = settledPose(waving)!;
  ck("a gesture (pose.anim) does not persist (a wave would become a tic)", out.anim, undefined);
  ck("  ...nor under its pre-release key", ONCE_KEYS[1] in settledPose({ clip: "idle", [ONCE_KEYS[1]]: "wave", p: [0, 0, 0] })!, false);
  ck("  ...the underlying clip does", out.clip, "idle");
}

// ── voice state is a LIVE reading, not a place ──────────
// remembered, a replayed `restore` would claim a mic state the new session never had; size and plate lift are the body, and stay
{
  const talking = { clip: "idle", mic: true, hear: false, scale: 1.5, plateY: 0.3, p: [0, 0, 0] };
  const out = settledPose(talking)!;
  ck("mic does not persist", "mic" in out, false);
  ck("  ...nor hear", "hear" in out, false);
  ck("  ...the body's size and plate lift do", [out.scale, out.plateY], [1.5, 0.3]);
}

// ── a ragdoll mid-gesture: both rules apply, neither leaks ───────────────────
{
  const knockedMidWave = { clip: "ragdoll", anim: "wave", pose: { hips: [0, 0, 0, 1] }, p: [5, 1.2, 5] };
  const out = settledPose(knockedMidWave)!;
  ck("knocked over mid-wave: clip settles", out.clip, "idle");
  ck("  ...gesture dropped", out.anim, undefined);
  ck("  ...tumble bones dropped", out.pose, undefined);
}

// ── restore and present must give the same body the same answer (both through settledPose) ──
{
  const live = { clip: "ragdoll", pose: { hips: [0, 0, 0, 1] }, p: [2, 0.8, 2] };
  const whatSheSees   = settledPose(live);          // restore, via rememberPose
  const whatTheySee   = settledPose(live);          // present, now via settledPose too
  ck("a body looks the same to its owner and to a joiner", whatTheySee, whatSheSees);
  ck("  ...and that shared answer is upright", whatTheySee!.clip, "idle");
}

// ── degenerate inputs must not throw on the join path ──────────────────────
{
  ck("null pose stays null (a spectator, or nobody home)", settledPose(null), null);
  ck("undefined pose stays null", settledPose(undefined), null);
  ck("an empty pose object survives", settledPose({}), {});
}

// ── the mirror must not drift, and the call site must actually use it ──────
// server.ts imports the whole world, so this asserts against the SOURCE: a changed function or reverted call site fails
{
  const src = await Bun.file(new URL("../server/server.ts", import.meta.url)).text();
  ck("server still defines settledPose", /function settledPose\(/.test(src), true);
  ck("the ragdoll rule is still in the real function",
     /still\.clip === "ragdoll".*still\.clip = "idle".*delete still\.pose/s.test(src), true);
  ck("the real function drops mic and hear",
     /function settledPose\([^]*?const \{[^}]*\bmic: _\w+[^}]*\bhear: _\w+[^}]*\.\.\.still \}/.test(src), true);
  ck("the real function drops the once anim (pose.anim, either key)",
     /function settledPose\([^]*?= withoutOnceAnim\(pose/.test(src), true);
  ck("the JOIN SNAPSHOT uses it (this is the fix; reverting it fails here)",
     /pose: settledPose\(o\.lastPose\)/.test(src), true);
  ck("no raw lastPose ships to other clients",
     /pose: o\.lastPose\b/.test(src), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
