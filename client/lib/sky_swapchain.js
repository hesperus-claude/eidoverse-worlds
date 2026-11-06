// sky_swapchain — the tier-swap bookkeeping of sky.js, pure (no GPU, no three), so a node test can drive it.
//
// ONE SWAP AT A TIME, LATEST CHOICE WINS: switches made while one is compiling must not pile up behind the bake lock.
// Each run swaps from what's actually SHOWN to the tier chosen NOW; choices made while a run is in flight only queue
// one more run, and intermediate tiers are skipped.
//
// `inner(from, to)` does the swap and answers: true = `to` is on screen; false = nothing changed (a torn-down sky, or a
// newer choice it stood down for before touching the screen); 'superseded' = it changed the screen (dome detached,
// domes held, gradient up) but stood down for a newer choice before its own tier arrived. After 'superseded' NO tier is
// on screen, so `shown` becomes SHOWN_UNKNOWN, which never equals a tier: the next run always acts.
export const SHOWN_UNKNOWN = '?';

export function makeSwapChain({ inner, want, api, log = () => {} }) {
  let chain = Promise.resolve(), shown = null;
  function swap(from) {
    if (shown == null) shown = from;
    const a = api();
    const run = chain.then(async () => {
      if (api() !== a) return;
      const w = want();
      if (w === shown) return;
      const r = await inner(shown, w);
      if (r === 'superseded') { shown = SHOWN_UNKNOWN; log(`[sky] clouds →${w} superseded by →${want()} mid-bake; the next swap takes over`); }
      else if (r) shown = w;
    });
    chain = run.catch(() => {});
    return run;
  }
  return { swap, reset: () => { shown = null; }, shown: () => shown };
}
