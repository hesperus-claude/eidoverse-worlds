// xrfoveation — the fixed-foveation level a headset session starts at (xr.js calls it once, after setSession).
// Basis's split: a standalone headset starts at 1 (a mobile GPU, and the periphery is cheap to lose), a PC headset at 0
// (the periphery blur shows there). `?fov=0..1` overrides either way.
// Standalone is decided by a headset browser's own token in the user agent, and by nothing else: Quest Browser's
// default (desktop-mode) user agent is "X11; Linux x86_64; Quest 3", so the old extra rule "and not
// Windows|Macintosh|Linux x86" classed every Quest in its default mode as a PC (foveation 0), while it never excluded a
// real desktop (a desktop browser carries none of these tokens). Android stays in the list: a phone or an Android
// headset browser is a mobile GPU. test/client/xr-foveation-test.mjs.
export const STANDALONE_UA = /OculusBrowser|Quest|Pico|Wolvic|Android/i;

/** { fov, standalone, override } for this user agent and the ?fov= value (a string, or null when absent). */
export function foveationFor(ua, fovParam = null) {
  const standalone = STANDALONE_UA.test(String(ua ?? ''));
  const override = fovParam != null;
  const fov = override ? Math.min(1, Math.max(0, Number(fovParam) || 0)) : (standalone ? 1 : 0);
  return { fov, standalone, override };
}
