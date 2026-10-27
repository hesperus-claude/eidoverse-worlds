// approach-dwell-test: an approach means they STOPPED, and a departure means they had arrived first.
// declaration.ts promises eidoverse:approach means "someone walked up AND STOPPED within arm's reach"; the re-arm,
// refractory and #39 baseline gates only suppress REPEATS, none tells a knock from a body crossing on its way past. The
// outward crossing must close the bracket.
// Runs on an INJECTED clock (notePose's third argument): a suite that can't move the clock sleeps (slow, racy against
// the refractory) or asserts nothing.
// Run: bun tools/approach-dwell-test.ts

import { noWorldUrl } from "./no-world.ts";
import { WorldAgent } from "../mcpl/agent.ts";
import { APPROACH_DWELL_MS, APPROACH_MAX_WAIT_MS, APPROACH_RADIUS, REARM_RADIUS } from "../mcpl/denoise.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** A body at (x,z); `clip` and `speed` are the SENDER's claims, deliberately mismatched with reality below. */
const pose = (x: number, z: number, clip = "walk", speed = 0) =>
  ({ p: [x, 0, z], yaw: 0, speed, clip });

function rig() {
  const ag = new WorldAgent({ url: noWorldUrl(), name: "dwelltest" }) as any;
  ag.pos = { x: 0, y: 0, z: 0 };
  // a real epoch, not 0: `cooled` compares against a last-approach default of 0, so a near-zero clock refuses the first knock
  const T0 = Date.now();
  const seen: { kind: string; who: string; text?: string }[] = [];
  ag.onPing = (p: any) => seen.push({ kind: p.kind, who: p.who, ...(p.text != null ? { text: p.text } : {}) });
  return {
    ag, T0, seen,
    at: (t: number, x: number, z: number, clip?: string, speed?: number, who = "digi") =>
      ag.notePose(who, pose(x, z, clip, speed), T0 + t),
    count: (kind: string) => seen.filter((p) => p.kind === kind).length,
  };
}

const DIST = (x: number, z: number) => Math.hypot(x, z);

// ---------------------------------------------------------------- the headline: passing through is not a knock

{
  const { at, count } = rig();
  // a 1.4 m/s stroll sampled at 5Hz (0.28m/sample) along z = 1.5: closest approach 1.5m, ~2.9s inside APPROACH_RADIUS
  let t = 0, inside = 0;
  for (let x = -6; x <= 6.0001; x += 0.28) {
    at(t, x, 1.5);
    if (DIST(x, 1.5) < APPROACH_RADIUS) inside++;
    t += 200;
  }
  // VACUITY GUARD: if the path never entered the radius, "no ping" is true for the wrong reason
  check("(guard) the pass-through really did enter arm's reach", inside >= 10, `${inside} samples inside`);
  check("walking straight past you is NOT an approach", count("approach") === 0,
    `${count("approach")} pings`);
  check("...and a body that never arrived never departs either", count("depart") === 0);
}

// ---------------------------------------------------------------- the control: same walk, but they stop

{
  const { at, count } = rig();
  // the identical approach leg, then they stop at 1.5m
  let t = 0;
  for (let x = -6; x <= -1.5; x += 0.28) { at(t, x, 1.5); t += 200; }
  check("(control) still nothing while they are still moving", count("approach") === 0);
  for (let i = 0; i <= APPROACH_DWELL_MS + 600; i += 200) at(t + i, -1.5, 1.5);
  check("walking up and STOPPING is an approach", count("approach") === 1, `${count("approach")} pings`);
  check("...and it knocks exactly once while they stand there", count("approach") === 1);
}

// ---------------------------------------------------------------- stillness is observed, never taken on trust

{
  const { at, count } = rig();
  at(0, 10, 0);
  at(100, 1.2, 0, "walk", 9.9);  // crosses in, LOUDLY claiming to be sprinting
  for (let i = 0; i <= APPROACH_DWELL_MS + 400; i += 200) at(100 + i, 1.2, 0, "walk", 9.9);
  check("a body whose own pose says 'walking at 9.9 m/s' still counts as still, because it did not move",
    count("approach") === 1, `${count("approach")} pings`);
}

{
  const { at, count } = rig();
  at(0, 10, 0);
  // crosses in and keeps moving fast, while claiming clip "idle" at speed 0
  let t = 100, x = 2.4;
  for (; x > -2.4; x -= 0.3) { at(t, x, 0.4, "idle", 0); t += 200; }
  check("a body claiming 'idle, speed 0' while crossing at 1.5 m/s is NOT an approach",
    count("approach") === 0, `${count("approach")} pings`);
}

// ---------------------------------------------------------------- someone who never settles is still someone who came over

{
  const { at, count } = rig();
  at(0, 10, 0);
  at(100, 2.0, 0);   // crossing
  // circling inside arm's reach, never still, for longer than the max wait
  let t = 300;
  for (let i = 0; t <= 100 + APPROACH_MAX_WAIT_MS + 1000; i++) {
    const a = i * 0.6;
    at(t, Math.cos(a) * 1.8, Math.sin(a) * 1.8);
    t += 200;
  }
  check("pacing in your face never reads as 'still' — but still announces, once, via the max wait",
    count("approach") === 1, `${count("approach")} pings`);
}

// ---------------------------------------------------------------- the closing bracket

{
  const { at, count, seen } = rig();
  at(0, 10, 0);
  at(100, 1.5, 0);
  for (let i = 0; i <= APPROACH_DWELL_MS + 400; i += 200) at(100 + i, 1.5, 0);
  check("(setup) approached", count("approach") === 1);

  at(20_000, 4.0, 0);   // drifts out of arm's reach, but stays nearby
  check("drifting to 4m is not a departure — the bracket closes at the re-arm radius, not the approach one",
    count("depart") === 0, `${count("depart")} pings`);

  at(21_000, REARM_RADIUS + 2, 0);
  check("going properly away IS a departure", count("depart") === 1);
  check("...and their own movement carried them out, so the wire may say so",
    seen.find((p) => p.kind === "depart")?.text === "walked away",
    JSON.stringify(seen.filter((p) => p.kind === "depart")));

  at(22_000, REARM_RADIUS + 5, 0);
  at(23_000, REARM_RADIUS + 9, 0);
  check("...and it fires once, not once per sample out there", count("depart") === 1,
    JSON.stringify(seen.map((p) => p.kind)));
}

// ---------------------------------------------------------------- a passer-by's exit is traffic, not a departure

{
  const { at, count } = rig();
  let t = 0;
  for (let x = -6; x <= 6.0001; x += 0.28) { at(t, x, 1.5); t += 200; }
  at(t + 1000, 12, 1.5);   // walks off past the re-arm radius
  check("the body that only passed through leaves without a departure",
    count("approach") === 0 && count("depart") === 0,
    `approach=${count("approach")} depart=${count("depart")}`);
}

// ---------------------------------------------------------------- the filter must not deafen you

{
  const { at, count } = rig();
  // first a pass-through, which must be swallowed
  let t = 0;
  for (let x = -6; x <= 6.0001; x += 0.28) { at(t, x, 1.5); t += 200; }
  check("(setup) the pass-through was swallowed", count("approach") === 0);
  // then a real return well past the refractory: the cancelled pending must not have left the gate stuck
  at(700_000, 12, 0);
  at(700_100, 1.4, 0);
  for (let i = 0; i <= APPROACH_DWELL_MS + 400; i += 200) at(700_100 + i, 1.4, 0);
  check("a real walk-up AFTER a swallowed pass-through still knocks",
    count("approach") === 1, `${count("approach")} pings`);
}

// ---------------------------------------------------------------- two bodies do not share a gate

{
  const { at, count, seen } = rig();
  at(0, 10, 0, "walk", 0, "digi");
  at(0, 10, 0, "walk", 0, "rabscuttle");
  // digi walks up and stays; rabscuttle merely passes through
  at(100, 1.5, 0, "walk", 0, "digi");
  let t = 100;
  for (let x = -6; x <= 6.0001; x += 0.28) { at(t, x, 1.5, "walk", 0, "rabscuttle"); t += 200; }
  for (let i = 0; i <= APPROACH_DWELL_MS + 400; i += 200) at(100 + i, 1.5, 0, "walk", 0, "digi");
  check("the stopper is announced and the passer-by is not",
    count("approach") === 1 && seen.find((p) => p.kind === "approach")?.who === "digi",
    JSON.stringify(seen));
}

// ---------------------------------------------------------------- who moved? the wire must not author OUR walk as THEIRS

// a teleported AGENT must still close the bracket, but "walked away" only if the body is beyond the re-arm edge from
// where we stood at approach; otherwise "is no longer nearby" (PR #145)

{
  const { ag, at, count, seen } = rig();
  at(0, 10, 0);
  at(100, 1.5, 0);
  for (let i = 0; i <= APPROACH_DWELL_MS + 400; i += 200) at(100 + i, 1.5, 0);
  check("(setup) approached", count("approach") === 1);

  ag.pos = { x: 10, y: 0, z: 0 };       // WE move; digi does not
  at(20_000, 1.5, 0);                    // digi's unmoved pose, now 8.5m from us
  check("self walking away still closes the bracket", count("depart") === 1,
    `${count("depart")} pings`);
  check("...but the wire does not claim digi moved",
    seen.find((p) => p.kind === "depart")?.text === "is no longer nearby",
    JSON.stringify(seen.filter((p) => p.kind === "depart")));
}

{
  const { ag, at, count, seen } = rig();
  at(0, 10, 0);
  at(100, 1.5, 0);
  for (let i = 0; i <= APPROACH_DWELL_MS + 400; i += 200) at(100 + i, 1.5, 0);
  check("(setup) approached", count("approach") === 1);

  // both drift apart 8m (past the re-arm edge), but digi is only 4m from where we stood: no single party "walked away"
  ag.pos = { x: -4, y: 0, z: 0 };
  at(20_000, 4, 0);
  check("a separation both parties caused is worded neutrally",
    count("depart") === 1 && seen.find((p) => p.kind === "depart")?.text === "is no longer nearby",
    JSON.stringify(seen.filter((p) => p.kind === "depart")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
