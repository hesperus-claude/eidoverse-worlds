// serverclock — the client's estimate of the AUTHORITY's clock (spec/PHYSICS.md §5.1): the ONE "now" for anything it
// stamped (motion t0, sound t0, pose time, a flight's tick); never raw wall time, so a log running ahead draws right.
//
// Two estimates, best first:
//   a round trip   offset = t − (t0 + t1) / 2; the smallest of the last few wins (NTP's minimum filter: queuing only
//                  ever adds delay)
//   a message's t  one-way, so late by its delay; shared/clockoffset.js keeps the least-delayed; only until a round trip
// Its own module so a small realizer (sounds.js) reads it without pulling in the body code.
import { foldOffset } from '../../shared/clockoffset.js';
let oneWay = null;            // foldOffset's { offset, at, stream }
let rtt = [];                 // [{rtt, offset}], most recent
const RTT_KEEP = 8;
const STEP_SLACK_MS = 50;     // drift between asks a sample may show and still be the same clock (0.6 ms/s over 80 s)
export const localNow = () => performance.timeOrigin + performance.now();
/** `at`: performance.now() when `t`'s message event ran, for a message that waited to be handled. */
export function noteServerTime(t, at = performance.now()) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return;
  oneWay = foldOffset(oneWay, t - performance.timeOrigin - at, at);
  noteServerFloor(t);
}
/** t0 when the ask left (localNow), t the authority's clock in the answer, t1 when it came back. */
export function noteRoundTrip(t0, t, t1) {
  if (![t0, t, t1].every((x) => typeof x === 'number' && Number.isFinite(x)) || t1 < t0) return;
  const s = { rtt: t1 - t0, offset: t - (t0 + t1) / 2 };
  // samples of one clock agree within half their rtts summed; one that doesn't means it STEPPED: retire the older,
  // or the minimum filter keeps the stale offset for up to RTT_KEEP asks
  rtt = rtt.filter((x) => Math.abs(x.offset - s.offset) <= (x.rtt + s.rtt) / 2 + STEP_SLACK_MS);
  rtt.push(s);
  if (rtt.length > RTT_KEEP) rtt.shift();
}
const bestOffset = () => (rtt.length ? rtt.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset : oneWay?.offset ?? 0);
// the shown offset SLEWS (5% of elapsed: 100 ms takes 2 s), never steps: a step moves every flight in one frame
// (STRIKES PH-S2). Over SLEW_SNAP_MS is a real resync, taken at once.
const SLEW_RATE = 0.05, SLEW_SNAP_MS = 500;
let shown = null;   // { v: offset shown, at: localNow of the last read }
function shownOffset() {
  const best = bestOffset(), now = localNow();
  if (shown === null || Math.abs(best - shown.v) > SLEW_SNAP_MS) { shown = { v: best, at: now }; return best; }
  const step = Math.max(0, now - shown.at) * SLEW_RATE; shown.at = now;
  const d = best - shown.v; shown.v += Math.abs(d) <= step ? d : Math.sign(d) * step;
  return shown.v;
}
export const serverNow = () => localNow() + shownOffset();
/** Whole milliseconds: the authority refuses a fractional written time, and serverNow() carries performance.now()'s. */
export const serverUntil = (ms) => Math.round(serverNow() + ms);
// a floor: offset ≥ t − localNow(); above the estimate by more than the slack, the clock stepped: ask again, ≤ 1/s
let doubt = null, doubtAt = -Infinity;
const DOUBT_EVERY_MS = 1000;
export const onClockDoubt = (fn) => { doubt = fn; };
export function noteServerFloor(t) {
  if (typeof t !== 'number' || !Number.isFinite(t) || !rtt.length || !doubt) return;
  const now = localNow(); if (t - now <= bestOffset() + clockRtt() / 2 + STEP_SLACK_MS || now - doubtAt < DOUBT_EVERY_MS) return;
  doubtAt = now; doubt();
}
/** For probes. */
export const clockDebug = () => ({ best: bestOffset(), shown: shown?.v ?? null });
/** The smallest recent round trip (ms), or null: how sure the estimate is. */
export const clockRtt = () => (rtt.length ? Math.min(...rtt.map((x) => x.rtt)) : null);
