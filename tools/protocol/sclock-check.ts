// tools/protocol/sclock-check.ts: the client's server clock slews (DESIGN-physics-responsiveness §3): a new min-RTT sample
// moves the shown offset gradually, a large one at once. usage: bun tools/protocol/sclock-check.ts
// @ts-nocheck
import { noteRoundTrip, serverNow, localNow, clockDebug, noteServerFloor, onClockDoubt } from "../../client/lib/serverclock.js";
import { pause } from "./wait.ts";
import { suite } from "./suite.ts";
const { ok, done } = suite("sclock-check", { quiet: true, cap: Infinity });
const t = localNow();
noteRoundTrip(t - 20, t + 1000 - 10, t);      // offset +1000 at rtt 20
serverNow(); const a = clockDebug();
noteRoundTrip(t - 10, t + 1100 - 5, t);       // a better sample (rtt 10) says +1100: a 100 ms correction
serverNow(); const b = clockDebug();
ok(Math.abs(b.best - 1100) < 1 && Math.abs(b.shown - 1000) < 5, "C1 a 100 ms correction is not taken in one read", { a, b });
await pause("the slew is measured over 300 ms", 300); serverNow(); const c = clockDebug();
ok(c.shown > 1005 && c.shown < 1030, "C2 …after 300 ms it has moved about 15 ms (5% of elapsed)", c);
await pause("a few seconds of slew", 2500); serverNow(); const d = clockDebug();
ok(Math.abs(d.shown - 1100) < 1, "C3 …and in a few seconds it is there", d);
noteRoundTrip(t - 8, t + 3000 - 4, t);        // a 1.9 s correction (and the best rtt yet): a resync, taken at once
serverNow(); const e = clockDebug();
ok(Math.abs(e.shown - 3000) < 1, "C4 a correction over half a second is taken at once", e);
// a clock that STEPS (wall-clock jump, laptop wake): older samples the new one proves impossible are retired, not kept as "best"
const s0 = localNow();
for (let i = 0; i < 8; i++) noteRoundTrip(s0 - 2, s0 + 3000 - 1, s0);   // a full window at +3000, rtt 2
noteRoundTrip(s0 - 2.4, s0 + 4620 - 1.2, s0);                          // the clock steps +1620; this sample's rtt is a hair worse
serverNow(); const f = clockDebug();
ok(Math.abs(f.best - 4620) < 1 && Math.abs(f.shown - 4620) < 1, "C5 a sample that contradicts the older ones by more than their round trips retires them (a clock step is taken at the next ask)", f);
noteRoundTrip(s0 - 40, s0 + 4620 + 15 - 20, s0);                       // a slow but honest sample, consistent within its rtt: kept, not a step
serverNow(); const g = clockDebug();
ok(Math.abs(g.best - 4620) < 1, "C6 …while a slow sample that agrees within its own round trip changes nothing", g);
// …and noticed before the next ask: a server stamp is a FLOOR on the offset, so one above the estimate re-asks at once (rate-limited)
let asks = 0; onClockDoubt(() => asks++);
const h0 = localNow();
noteServerFloor(h0 + 4620 - 30);                                     // an entry stamped a moment ago, on the estimate: fine
ok(asks === 0, "C7 a floor the estimate already clears asks nothing", { asks });
noteServerFloor(localNow() + 4620 + 1620);                           // stamped 1.6 s past what we think the authority's now is
ok(asks === 1, "C8 a floor above the estimate asks for a round trip at once", { asks });
noteServerFloor(localNow() + 4620 + 1620); noteServerFloor(localNow() + 4620 + 1700);
ok(asks === 1, "C9 …once, not per entry (one ask a second)", { asks });
done();
