// serverclock — the server's clock, as this client estimates it: the ONE place a client reads "now" for anything the
// authority stamped (motion t0, sound t0, a seat's pose time, a flight's tick). The server's clock is the AUTHORITY's
// (spec/PHYSICS.md §5.1): the same now() that stamps entries' ts, never raw wall time, so a world whose log runs ahead of
// wall time is drawn at the right tick.
//
// Two estimates, best first:
//   a round trip   clock {t0} → {t0, t}: offset = t − (t0 + t1) / 2, the sample with the smallest round trip of the last
//                  few wins (NTP's minimum filter: queuing only ever adds delay). noteRoundTrip.
//   a message's t  one-way (the clock message the server sends just before a join's snapshot, each frame), so late by
//                  its delay; kept by shared/clockoffset.js's rule (the least-delayed sample wins, so a message handled
//                  late moves it by no more than that rule's leak) and used only until a round trip lands.
// Its own module (it was remotes.js's) so a small realizer (sounds.js) can read it without pulling the body code in.
import { foldOffset } from '../../shared/clockoffset.js';
let oneWay = null;            // from one-way samples: shared/clockoffset.js foldOffset's { offset, at, stream }
let rtt = [];                 // [{rtt, offset}] most recent round trips
const RTT_KEEP = 8;
const STEP_SLACK_MS = 50;     // drift between asks a sample may show and still be the same clock (0.6 ms/s over 80 s)
export const localNow = () => performance.timeOrigin + performance.now();
/** One one-way sample. `at` is the performance.now() when `t`'s message event ran, for a message that waited to be
 *  handled (the early socket's drain, net.js connect()); otherwise now. */
export function noteServerTime(t, at = performance.now()) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return;
  oneWay = foldOffset(oneWay, t - performance.timeOrigin - at, at);
  noteServerFloor(t);
}
/** One round trip: t0 when the ask left (localNow), t the authority's clock in the answer, t1 when it came back. */
export function noteRoundTrip(t0, t, t1) {
  if (![t0, t, t1].every((x) => typeof x === 'number' && Number.isFinite(x)) || t1 < t0) return;
  const s = { rtt: t1 - t0, offset: t - (t0 + t1) / 2 };
  // Honest samples of one clock agree within half their rtts summed; one that doesn't means the clock STEPPED, so retire
  // the older ones, or the minimum filter keeps the stale offset for up to RTT_KEEP asks.
  rtt = rtt.filter((x) => Math.abs(x.offset - s.offset) <= (x.rtt + s.rtt) / 2 + STEP_SLACK_MS);
  rtt.push(s);
  if (rtt.length > RTT_KEEP) rtt.shift();
}
const bestOffset = () => (rtt.length ? rtt.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset : oneWay?.offset ?? 0);
// The offset the screen uses slews toward the best estimate (5% of elapsed time, so a 100 ms correction takes 2 s) instead
// of stepping to each new minimum-RTT sample: a step moved every flight by the delta in one frame (STRIKES PH-S2 'display
// clock jumps', R's 'steppy'). A correction over SLEW_SNAP_MS is a real resync and is taken at once.
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
/** A time `ms` from now on the authority's clock, in whole milliseconds: what a written time (a timed grant's until) must
 *  be, since the authority refuses a fraction (Number.isSafeInteger) and serverNow() carries performance.now()'s. */
export const serverUntil = (ms) => Math.round(serverNow() + ms);
// A floor: anything the authority stamped is ≤ its now, so offset ≥ t − localNow(). A floor above the estimate by more
// than its slack means the clock stepped: ask again at once (askClock from net.js), at most once a second.
let doubt = null, doubtAt = -Infinity;
const DOUBT_EVERY_MS = 1000;
export const onClockDoubt = (fn) => { doubt = fn; };
export function noteServerFloor(t) {
  if (typeof t !== 'number' || !Number.isFinite(t) || !rtt.length || !doubt) return;
  const now = localNow(); if (t - now <= bestOffset() + clockRtt() / 2 + STEP_SLACK_MS || now - doubtAt < DOUBT_EVERY_MS) return;
  doubtAt = now; doubt();
}
/** Probe/test surface: the raw best estimate and what is shown. */
export const clockDebug = () => ({ best: bestOffset(), shown: shown?.v ?? null });
/** The smallest recent round trip (ms), or null before the first: how sure the estimate is. */
export const clockRtt = () => (rtt.length ? Math.min(...rtt.map((x) => x.rtt)) : null);
