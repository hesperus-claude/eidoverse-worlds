// sky_bakelock — ONE BAKE AT A TIME over the sky engine's bakeEnv, kept out of sky.js so a node test can drive it
// (test/client/sky-bakelock-test.mjs). No GPU, no three: it only wraps a function.
export const BAKE_INTERCEPT = Symbol.for('ew.bakeIntercept');   // the same symbol sky_baked.js exports (Symbol.for)
export const BAKE_GUARD = Symbol.for('ew.bakeGuard');
export const BAKE_AFTER = Symbol.for('ew.bakeAfter');
export const BAKE_HELD = Symbol.for('ew.bakeHeld');   // the caller already holds the lock (the prebuild's own bake)
// ONE BAKE AT A TIME: every bake shares the engine's single _envTarget and _envBake, and a bake that swaps in a
// temporary target (the VR prebuild) must not have another bake draw into it. Every sys.bakeEnv queues behind the one
// before, and the prebuild holds the queue around its whole swap. Callers stop on a generation/skyApi change.
export function serializeBakes(sys, { log = () => {}, report = () => {} } = {}) {
  if (!sys?.bakeEnv || sys.__rawBakeEnv) return;
  const raw = sys.bakeEnv.bind(sys);
  let tail = Promise.resolve();
  sys.__rawBakeEnv = raw;
  sys.__withBakeLock = (fn) => { const run = tail.then(fn, fn); tail = run.catch(() => {}); return run; };
  // a bake still queued when its sky is torn down is skipped: it would rebuild a target and a giant graph on the dead
  // system that nothing frees.
  // BAKE_GUARD (a function, optional): asked INSIDE the lock, right before the bake; false skips it, so a queued bake
  // decides whether it's still wanted when its turn comes.
  // BAKE_AFTER (a function, optional): called INSIDE the lock once the bake is done (or skipped/failed), with
  // { ok, skipped }. Whatever reads _envTarget/_envBake after a bake must run here, before a queued bake can swap or
  // resize them. Called exactly once, synchronously; it must not throw or await the lock.
  sys.bakeEnv = (r, o, ...rest) => (o?.[BAKE_HELD] ? raw(r, o, ...rest) : sys.__withBakeLock(async () => {
    const after = (res) => { try { o?.[BAKE_AFTER]?.(res); } catch (e) { report('sky bake (after)', e); } };
    if (sys.__dead) { log('[sky] a bake queued for a torn-down sky: skipped'); after({ ok: false, skipped: true }); return; }
    if (o?.[BAKE_GUARD] && !o[BAKE_GUARD]()) { after({ ok: false, skipped: true }); return; }
    const restore = o?.[BAKE_INTERCEPT]?.();
    let ok = false;
    try { const v = await raw(r, o, ...rest); ok = true; return v; } finally { restore?.(); after({ ok, skipped: false }); }
  }));
}
