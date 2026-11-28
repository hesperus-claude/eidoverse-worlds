// refresh — the display's refresh rate, estimated from the frame cadence, for the governor's target (governor.js
// targetFps). A zero-import leaf (like perf.js): frameloop.js feeds it every frame interval, the governor reads it.
//
// There is no web API for a flat display's refresh, and a rAF interval under load is LONGER than the refresh (a missed
// vsync doubles it), so no single interval is trusted. The estimate is the fastest SUSTAINED cadence this page has seen:
//   * intervals are read in blocks of 15; a block is steady only if every sum of two consecutive intervals is within
//     ±12% of the block's mean pair (pairs, not single intervals, so timestamp jitter that alternates short/long around
//     one period still counts, while a GPU-bound 60 Hz machine's 33/50/67 ms mix — doubled and tripled vsyncs — does not);
//   * steady blocks form a RUN while they agree on one rate (same snapped rate, or within 2%); an unsteady block or a
//     different rate ends the run. A run's rate is the median of its last 9 blocks, snapped to a common panel rate when
//     within 4%, and nothing rises until two blocks agree: one lucky block, or the rise-only maximum of noisy blocks,
//     cannot creep the estimate up (an 85 Hz panel reading 85.9; a jittery 72 Hz headset reading 75 and then never
//     smooth);
//   * the estimate only ever RISES within a page (a slow minute cannot talk it down);
//   * below 45 Hz nothing is believed at all. Cadence alone cannot tell a 30 Hz panel from a 60 Hz panel whose machine is
//     vsync-locked at half rate (both are a steady 33.3 ms), and believing the second would make its crawl "smooth": the
//     weak laptop stops shedding for good. So a real 30 Hz panel is not recognised yet; it keeps the old behaviour.
//     48 and 50 Hz are believed (a 60 Hz panel cannot produce them steadily), but only after a run of 8 steady blocks at
//     that one rate, and any rate under 57 Hz needs the same.
//   Until an estimate exists the caller behaves as 60 (flat) or as the headset default.
// A headset is measured on its own channel, forgotten whenever presenting starts or stops, so one session's cadence (or
// the desktop's 144) never carries into the next. Known limits: a panel that SLOWS mid-page (a battery saver capping rAF,
// a window dragged to a slower monitor) keeps the faster estimate, which is the old behaviour; a fast panel whose
// machine is vsync-locked at a third or a half (144/3 = 48, 100/2 = 50) from its first frame would read as a 48 or 50 Hz
// panel. test/client/governor-refresh-test.ts (E and W rows).

const BLOCK = 15;
const PAIR_TOL = 0.12;
const AGREE = 0.02;
const RUN_MEDIAN = 9;
const MIN_HZ = 45;
const SLOW_PANEL_HZ = 57;
const SLOW_PANEL_BLOCKS = 8;
const RATES = [24, 30, 48, 50, 60, 72, 75, 80, 90, 100, 120, 144, 165, 240];
const MIN_MS = 2, MAX_MS = 100;   // outside this an interval is a resume, a stall or nonsense: not cadence

const snap = (hz) => {
  for (const r of RATES) if (Math.abs(hz - r) <= r * 0.04) return r;
  return Math.round(hz * 10) / 10;
};
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const agree = (a, b) => snap(a) === snap(b) || Math.abs(a - b) <= b * AGREE;

/** One estimator: note(ms) per frame interval; hz() is the estimate, or null while there is none worth trusting. */
export function makeRefreshEstimator() {
  let block = [];
  let best = 0;
  let run = [];      // the current run's last RUN_MEDIAN steady block rates (raw)
  let runLen = 0;    // steady blocks in the current run, uncapped
  const closeBlock = () => {
    const b = block; block = [];
    const pairs = [];
    for (let i = 1; i < b.length; i++) pairs.push(b[i - 1] + b[i]);
    const mean = pairs.reduce((a, x) => a + x, 0) / pairs.length;
    if (!pairs.every((p) => Math.abs(p - mean) <= mean * PAIR_TOL)) { run = []; runLen = 0; return; }
    const raw = (b.length * 1000) / b.reduce((a, x) => a + x, 0);
    if (run.length && !agree(raw, median(run))) { run = []; runLen = 0; }
    run.push(raw); runLen++;
    if (run.length > RUN_MEDIAN) run.shift();
    if (runLen < 2) return;
    const hz = snap(median(run));
    if (hz < MIN_HZ) return;
    if (hz < SLOW_PANEL_HZ && runLen < SLOW_PANEL_BLOCKS) return;
    if (hz > best) best = hz;
  };
  return {
    note(ms) {
      if (!(ms >= MIN_MS && ms <= MAX_MS)) { block = []; return; }   // a gap breaks the block: blocks are consecutive frames
      block.push(ms);
      if (block.length >= BLOCK) closeBlock();
    },
    hz: () => best || null,
    reset() { block = []; best = 0; run = []; runLen = 0; },
    debug: () => ({ best, runLen, run: run.map((x) => +x.toFixed(2)), pending: block.length }),
  };
}

const flat = makeRefreshEstimator();
const xr = makeRefreshEstimator();
let wasPresenting = false;

/** Feed every frame interval (frameloop.js), with whether a headset session drew it. */
export function noteFrameInterval(ms, presenting = false) {
  presenting = !!presenting;
  if (presenting !== wasPresenting) { xr.reset(); wasPresenting = presenting; }
  (presenting ? xr : flat).note(ms);
}

/** The measured refresh for a flat display (presenting false) or the current headset session (true); null if unknown. */
export const refreshEstimate = (presenting = false) => (presenting ? xr : flat).hz();

/** Forget everything measured (a test's fresh page; nothing in the client calls it). */
export function resetRefresh() { flat.reset(); xr.reset(); wasPresenting = false; }

export const refreshDebug = () => ({ flat: flat.debug(), xr: xr.debug() });
