// refresh — the display's refresh rate, estimated from the frame cadence, for the governor's target (governor.js
// targetFps). A zero-import leaf (like perf.js): frameloop.js feeds it every frame interval, the governor reads it.
//
// There is no web API for a flat display's refresh, and a rAF interval under load is LONGER than the refresh (a missed
// vsync doubles it), so no single interval is trusted. The estimate is the fastest SUSTAINED cadence this page has seen:
//   * intervals are read in blocks of 15; a block counts only if it is steady: every sum of two consecutive intervals
//     within ±12% of the block's mean pair (pairs, not single intervals, so timestamp jitter that alternates short/long
//     around one period still counts, while a GPU-bound 60 Hz machine's 33/50/67 ms mix — doubled and tripled vsyncs —
//     does not); its rate is frames over time, snapped to a common panel rate when within 4%;
//   * the estimate only ever RISES within a page (a slow minute cannot talk it down: on a 60 Hz panel the boot's
//     near-empty scene runs at 60 long before the world is heavy);
//   * a slow panel (< 57 Hz) is believed only after 8 steady blocks, because the mistake is asymmetric: reading a weak
//     60 Hz machine as a 30 Hz panel would stop it shedding at 25 fps, while missing a real 30 Hz panel only costs it
//     what the old absolute thresholds always did. Until an estimate exists the caller behaves as 60 (flat) or as the
//     headset default.
// A headset is measured on its own channel, forgotten whenever presenting starts or stops, so one session's cadence (or
// the desktop's 144) never carries into the next. Known limit: a panel that SLOWS mid-page (a battery saver capping rAF
// at 30, a window dragged to a slower monitor) keeps the faster estimate, which is the old behaviour, not a new fault.
// test/client/governor-refresh-test.ts (E rows).

const BLOCK = 15;
const PAIR_TOL = 0.12;
const SLOW_PANEL_HZ = 57;
const SLOW_PANEL_BLOCKS = 8;
const RATES = [24, 30, 48, 50, 60, 72, 75, 80, 90, 100, 120, 144, 165, 240];
const MIN_MS = 2, MAX_MS = 100;   // outside this an interval is a resume, a stall or nonsense: not cadence

const snap = (hz) => {
  for (const r of RATES) if (Math.abs(hz - r) <= r * 0.04) return r;
  return Math.round(hz * 10) / 10;
};

/** One estimator: note(ms) per frame interval; hz() is the estimate, or null while there is none worth trusting. */
export function makeRefreshEstimator() {
  let block = [];
  let best = 0;
  let steady = 0;
  const closeBlock = () => {
    const b = block; block = [];
    const pairs = [];
    for (let i = 1; i < b.length; i++) pairs.push(b[i - 1] + b[i]);
    const mean = pairs.reduce((a, x) => a + x, 0) / pairs.length;
    if (!pairs.every((p) => Math.abs(p - mean) <= mean * PAIR_TOL)) return;
    steady++;
    const hz = snap((b.length * 1000) / b.reduce((a, x) => a + x, 0));
    if (hz > best) best = hz;
  };
  return {
    note(ms) {
      if (!(ms >= MIN_MS && ms <= MAX_MS)) { block = []; return; }   // a gap breaks the run: blocks are consecutive frames
      block.push(ms);
      if (block.length >= BLOCK) closeBlock();
    },
    hz() {
      if (!best) return null;
      if (best < SLOW_PANEL_HZ && steady < SLOW_PANEL_BLOCKS) return null;
      return best;
    },
    reset() { block = []; best = 0; steady = 0; },
    debug: () => ({ best, steady, pending: block.length }),
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
