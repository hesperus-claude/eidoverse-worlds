// ONE AudioContext for the whole page.
//
// Chrome caps a document at roughly six AudioContexts; a refused one does not throw, it simply never produces sound.
// One context is also the only way distance, the category sliders and the ambient bed compose as one gain graph.
let ctx = null;

/** The page's AudioContext. Created on first use, resumed opportunistically. */
export function audioContext() {
  if (!ctx) ctx = new (window.AudioContext ?? window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** TEST-ONLY: drop the cached context so a suite can swap the constructor
 *  (deterministic graph-construction failure needs a FRESH broken context —
 *  the cache would happily keep serving the working one). */
export function __resetForTest() { ctx = null; }

/** Has one been made yet? (Probes: do not CREATE one just to look at it.) */
export const audioContextState = () => ctx?.state ?? 'none';

/** Resume on a real user gesture — the only thing that reliably works. */
export function resumeOnGesture(after) {
  const kick = () => {
    if (!ctx) return;
    ctx.resume().then(() => {
      if (ctx.state === 'running') {
        try { after?.(); } catch { /* caller's problem, not ours */ }
        for (const e of ['pointerdown', 'keydown', 'touchstart']) removeEventListener(e, kick);
      }
    }).catch(() => {});
  };
  for (const e of ['pointerdown', 'keydown', 'touchstart']) addEventListener(e, kick);
}
