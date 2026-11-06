// WHO ACTS ON AN ENTRY FAILURE — the effect owner for the busy/absent/reload verdicts.
//
// xr_entry_policy.js decides what a failure MEANS; this acts on it, behind injected dependencies, so
// tools/xr-entry-effects-test.mjs executes the same module xr.js imports rather than source-checking it.
// State is per-owner rather than module-global, so a test can hold two independent entry owners and
// nothing leaks between page sessions.

/** @param deps {{ setTimer, clearTimer, tee, toast, enter, markAbsent }} */
export function makeEntryEffects(deps) {
  let pendingFor = null;   // the ENTRY INTENT that owns the pending retry (null = none pending)
  let timer = null;

  /** The retry belongs to the click that scheduled it. A later click — or a leave — makes it stale,
   *  and a stale callback must never request a session. */
  function cancel(why) {
    if (timer !== null) { deps.clearTimer(timer); timer = null; }
    if (pendingFor !== null && why) deps.tee(`[xr] busy-retry cancelled: ${why}`);
    pendingFor = null;
  }

  /** Act on a verdict. Returns what was done, so a caller (and a test) can assert on it rather than
   *  on a log line: 'retried' | 'gave-up' | 'absent' | 'reload' | 'surface'. */
  function apply(verdict, { intent, error } = {}) {
    switch (verdict.action) {
      case 'retry-once': {
        // EXACTLY ONE automatic retry per entry intent. The retry carries its intent forward, so ITS
        // failure is the second one and gives up (a flag reset inside the timeout retried forever).
        cancel(null);
        pendingFor = intent;
        deps.tee(`[xr] session busy (another page holds it) — retrying once in ${verdict.delayMs} ms`);
        deps.toast(verdict.toast, 'info', 3000);
        timer = deps.setTimer(() => {
          timer = null;
          if (pendingFor !== intent) { deps.tee('[xr] busy-retry dropped: a newer entry intent owns the visor'); return; }
          pendingFor = null;
          deps.enter({ retryOf: intent });
        }, verdict.delayMs);
        return 'retried';
      }
      case 'give-up':
        // No scheduling. The visor waits for an explicit click, which starts a fresh budget because
        // that click is a NEW intent and arrives with retryOf = null.
        deps.toast(verdict.toast, 'warn', 8000);
        deps.tee('[xr] session busy after retry — giving up until the visor is clicked again');
        return 'gave-up';
      case 'absent':
        deps.markAbsent(true);
        if (error && typeof error === 'object') error.userMessage = verdict.toast;
        return 'absent';
      case 'reload-webgl':
        deps.tee(`[xr] webgpu session refused (${error?.name ?? ''} ${error?.message ?? error}) — reloading on the WebGL backend`);
        deps.toast(verdict.toast, 'info', 6000);
        return 'reload';
      default:
        return 'surface';
    }
  }

  // `hasPending` reads the TIMER because that is what leaveVR must not swallow. It and `pendingFor` are
  // set and cleared together in every reachable state (no test can tell them apart), but they MEAN
  // different things — a handle vs an identity — so they stay separate.
  return { apply, cancel, get pendingFor() { return pendingFor; }, get hasPending() { return timer !== null; } };
}

/** THE FAILURE SEAM ITSELF — decide, act, and say what the caller must do next. `enterVR`'s catch
 *  does nothing but call this and obey the result, so the suite drives the boundary itself, including
 *  the argument construction (`isRetry` from retryOf, `gpu` from the backend).
 *
 *  @returns 'handled' (the effect owns what happens next — return) | 'throw' (surface to the outer
 *           catch) | 'reload' (the caller performs the navigation, which needs `location`) */
export function handleEntryFailure({ effects, decide, error, intent, retryOf, gpu }) {
  const verdict = decide(error, { isRetry: retryOf !== null, gpu });
  const did = effects.apply(verdict, { intent, error });
  if (did === 'retried' || did === 'gave-up') return 'handled';
  if (did === 'reload') return 'reload';
  return 'throw';   // 'absent' (userMessage already set) and 'surface' both rethrow
}
