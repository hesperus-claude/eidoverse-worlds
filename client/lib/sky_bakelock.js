// sky_bakelock — ONE BAKE AT A TIME over the sky engine's bakeEnv, kept out of sky.js so a node test can drive it
// (tools/sky-bakelock-test.mjs). No GPU, no three: it only wraps a function.
export const BAKE_INTERCEPT = Symbol.for('ew.bakeIntercept');   // the same symbol sky_baked.js exports (Symbol.for)
export const BAKE_GUARD = Symbol.for('ew.bakeGuard');
export const BAKE_AFTER = Symbol.for('ew.bakeAfter');
export const BAKE_HELD = Symbol.for('ew.bakeHeld');   // the caller already holds the lock (the prebuild's own bake)
// one bake at a time: every bake shares the engine's single _envTarget and _envBake, so a bake that swaps a temporary
// target in (the VR prebuild) would have another bake draw into it and then dispose it (black sky). Every
// sys.bakeEnv queues behind the one before; the prebuild holds the queue around its whole swap.
export function serializeBakes(sys, { log = () => {}, report = () => {} } = {}) {
  if (!sys?.bakeEnv || sys.__rawBakeEnv) return;
  const raw = sys.bakeEnv.bind(sys);
  let tail = Promise.resolve();
  sys.__rawBakeEnv = raw;
  sys.__withBakeLock = (fn) => { const run = tail.then(fn, fn); tail = run.catch(() => {}); return run; };
  // a bake still queued when its sky is torn down is skipped (it would build on a dead system nothing frees).
  // BAKE_GUARD (optional fn): asked inside the lock right before the bake; false skips it, so a long-queued bake
  // decides then whether it's still wanted.
  // BAKE_AFTER (optional fn): called inside the lock exactly once, synchronously, with { ok, skipped }. Anything
  // reading _envTarget/_envBake after a bake must run here: once unlocked, a queued bake can swap or resize them.
  // It must not throw or await the lock.
  sys.bakeEnv = (r, o, ...rest) => (o?.[BAKE_HELD] ? raw(r, o, ...rest) : sys.__withBakeLock(async () => {
    const after = (res) => { try { o?.[BAKE_AFTER]?.(res); } catch (e) { report('sky bake (after)', e); } };
    if (sys.__dead) { log('[sky] a bake queued for a torn-down sky: skipped'); after({ ok: false, skipped: true }); return; }
    if (o?.[BAKE_GUARD] && !o[BAKE_GUARD]()) { after({ ok: false, skipped: true }); return; }
    const restore = o?.[BAKE_INTERCEPT]?.();
    let ok = false;
    try { const v = await raw(r, o, ...rest); ok = true; return v; } finally { restore?.(); after({ ok, skipped: false }); }
  }));
}
