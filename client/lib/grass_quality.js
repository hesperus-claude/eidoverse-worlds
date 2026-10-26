// grass_quality — the resident's local meadow budget, DOM-free (tools/grass-quality-test.ts).
// Drawn density = min(cap, shed): the persisted cap (#60) is a ceiling the governor's shed only goes below.
// Neither is a verb: blade count is per machine, not world state.

export const GRASS_QUALITY = ['full', 'medium', 'low', 'off'];
export const QUALITY_DENSITY = { full: 1, medium: 0.6, low: 0.35, off: 0 };

const KEY = 'ew-grass-quality';

/** `store`: localStorage, any getItem/setItem in tests, or absent (state lives for the session). */
export function makeGrassQuality(store) {
  const saved = store?.getItem?.(KEY);
  let quality = GRASS_QUALITY.includes(saved) ? saved : 'full';
  let shed = 1;
  return {
    /** the resident's chosen level ('full' | 'medium' | 'low' | 'off') */
    get quality() { return quality; },
    /** the governor's session dial, before the cap is applied */
    get shed() { return shed; },
    /** the resident's cap as a density factor */
    get cap() { return QUALITY_DENSITY[quality]; },
    /** what the field draws */
    effective() { return Math.min(QUALITY_DENSITY[quality], shed); },
    /** choose a level; unknown names are refused, the current level stands */
    setQuality(q) {
      if (!GRASS_QUALITY.includes(q)) return quality;
      quality = q;
      store?.setItem?.(KEY, q);
      return quality;
    },
    /** the governor's handle — clamped to [0, 1] */
    shedTo(f) {
      shed = Math.min(1, Math.max(0, Number.isFinite(f) ? f : 1));
      return shed;
    },
  };
}

/** How many of a stroke's `n` instances a density factor keeps: ≤0 is genuinely zero; any positive factor keeps at
 *  least one plant, so a thinned field never reads as mowed. */
export function densityCount(n, f) {
  if (f <= 0) return 0;
  return Math.max(1, Math.round(n * Math.min(1, Math.max(0.05, f))));
}
