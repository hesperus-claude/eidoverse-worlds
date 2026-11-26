// gipref — the viewer's bounce-light dial, ew-gi: off | low | high. What a world's gi-volume COSTS this viewer (the
// world owns the look: render/gi.js). Its own module so the settings panels read and write it without loading the bake.
export const GI_LEVELS = ['off', 'low', 'high'];
const KEY = 'ew-gi';
const subs = new Set();
let held = null;   // the level set on this page when storage is blocked
/** The stored level; low when none is stored or what is stored is no level. */
export const giPref = () => { try { const v = localStorage.getItem(KEY); return GI_LEVELS.includes(v) ? v : 'low'; } catch { return held ?? 'low'; } };
/** Store a level (anything else is ignored) and tell the bake (gi.js onGiPref). Live: no reload. */
export function setGiPref(v) {
  if (!GI_LEVELS.includes(v)) return;
  try { localStorage.setItem(KEY, v); } catch { held = v; }   // blocked: this page still follows it
  for (const fn of subs) fn(v);
}
/** Follow the dial; returns unsubscribe. */
export function onGiPref(fn) { subs.add(fn); return () => subs.delete(fn); }
