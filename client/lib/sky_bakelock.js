// sky_bakelock — serialises the sky engine's bakeEnv; no GPU or three, so tools/sky-bakelock-test.mjs drives it in node
export const BAKE_INTERCEPT = Symbol.for('ew.bakeIntercept');   // the same symbol sky_baked.js exports
export const BAKE_GUARD = Symbol.for('ew.bakeGuard');
export const BAKE_AFTER = Symbol.for('ew.bakeAfter');
export const BAKE_HELD = Symbol.for('ew.bakeHeld');   // the caller already holds the lock (the prebuild's own bake)
// bakes share one _envTarget/_envBake: unserialised, another bake draws into the VR prebuild's temp target and disposes it (black sky)
export function serializeBakes(sys, { log = () => {}, report = () => {} } = {}) {
  if (!sys?.bakeEnv || sys.__rawBakeEnv) return;
  const raw = sys.bakeEnv.bind(sys);
  let tail = Promise.resolve();
  sys.__rawBakeEnv = raw;
  sys.__withBakeLock = (fn) => { const run = tail.then(fn, fn); tail = run.catch(() => {}); return run; };
  // a bake queued past its sky's teardown is skipped: it would build on a dead system nothing frees
  // BAKE_GUARD (optional fn): asked inside the lock right before the bake; false skips it
  // BAKE_AFTER (optional fn): once, synchronously, inside the lock, with { ok, skipped }; read _envTarget/_envBake only
  // here (once unlocked, a queued bake can swap them). It must not throw or await the lock.
  sys.bakeEnv = (r, o, ...rest) => (o?.[BAKE_HELD] ? raw(r, o, ...rest) : sys.__withBakeLock(async () => {
    const after = (res) => { try { o?.[BAKE_AFTER]?.(res); } catch (e) { report('sky bake (after)', e); } };
    if (sys.__dead) { log('[sky] a bake queued for a torn-down sky: skipped'); after({ ok: false, skipped: true }); return; }
    if (o?.[BAKE_GUARD] && !o[BAKE_GUARD]()) { after({ ok: false, skipped: true }); return; }
    const restore = o?.[BAKE_INTERCEPT]?.();
    let ok = false;
    try { const v = await raw(r, o, ...rest); ok = true; return v; } finally { restore?.(); after({ ok, skipped: false }); }
  }));
}
