// flora_args — the `grass` verb's legacy makeGrass bags → createFlora options, and preset/variety stroke composition.
// The authority runs mapGrassArgs at write (shared/protocol/assetref.js) so a stored grass holds one spelling; a preset
// is stored by name and composed here on read.

// makeGrass's blade atlas has a known opaque mean: a legacy hex maps to the multiplier carrying that mean to the hex
export const ATLAS_MEAN = [91, 138, 35];
const LEGACY_KEYS = ['bladeHeight', 'spacing', 'perCell', 'colorTip',
  'windSpeed', 'lean', 'fade', 'fadeStart', 'fadeEnd', 'fadeColor', 'backlight'];

export function isLegacyArgs(a) {
  return LEGACY_KEYS.some((k) => a[k] !== undefined) || typeof a.color === 'number';
}

const splitHex = (h) => {
  const n = typeof h === 'string' ? parseInt(h.replace('#', ''), 16) : h;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export function hexToMultiplier(hex, tipHex) {
  const c = splitHex(hex);
  const t = tipHex !== undefined ? splitHex(tipHex) : c;
  // blade color reads mostly at the lit tip half
  return c.map((v, i) => {
    const blended = v * 0.4 + t[i] * 0.6;
    return Math.min(2.5, Math.max(0.2, blended / ATLAS_MEAN[i]));
  });
}

/** A persisted `grass` bag → createFlora options; legacy bags are translated. The log is never rewritten: old worlds
 *  replay forever through this mapping. */
export function mapGrassArgs(a) {
  if (!isLegacyArgs(a)) return { species: 'grass', ...a };
  const out = {
    species: 'grass',
    width: a.width, depth: a.depth, size: a.size, center: a.center, seed: a.seed,
    height: a.bladeHeight ?? 0.42,
    // legacy density knobs vs their own old defaults (spacing 0.26, perCell 4)
    density: Math.min(2.2, Math.max(0.25,
      ((0.26 / (a.spacing ?? 0.26)) ** 2) * ((a.perCell ?? 4) / 4))),
    wind: Math.min(2, Math.max(0, (a.wind ?? 0.24) / 0.24)),
  };
  if (a.color !== undefined) out.color = hexToMultiplier(a.color, a.colorTip);
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

// `grass` is a world singleton but a biome is several strokes: a `preset` composes them client-side under ONE field object
export function presetStrokes(args, presets = null) {
  // stored strokes ARE the planting (they win over a preset)
  if (Array.isArray(args.strokes) && args.strokes.length) return args.strokes.map((st) => ({ ...st }));
  const W = args.width ?? args.size ?? 80, D = args.depth ?? args.size ?? 70;
  const [cx, cz] = args.center ?? [0, 0];
  const seed = args.seed ?? 7;
  const sc = (f) => Math.round(f * Math.min(W, D));
  // the caller's density is a FACTOR over each stroke's authored fullness, or the sparse/lush dial does nothing on presets
  const k = args.density ?? 1;
  if (args.preset != null) {
    // presets are DATA (defs/flora/_presets.json). One this instance lacks fails LOUDLY: a logged bag must never drift into a default lawn.
    const p = presets?.[args.preset];
    if (!p?.strokes?.length) {
      throw new Error(`[flora] unknown preset '${args.preset}' — have: ${Object.keys(presets ?? {}).join(', ') || '(no presets hydrated)'}`);
    }
    return p.strokes.map((t) => {
      const { inset = 0, offset = [0, 0], seedAdd = 0, density = 1, ...rest } = t;
      return {
        ...rest,
        width: W - inset, depth: D - inset,
        center: [cx + sc(offset[0]), cz + sc(offset[1])],
        seed: seed + seedAdd,
        density: density * k,
      };
    });
  }
  if (args.species === 'corn' && !args.rows?.stride) {
    // one stroke clones one variant field-wide, so the recipe interleaves seeds by row stride
    const rows = { spacing: 0.9, plant: 0.26, ...(args.rows ?? {}) };
    const corn = args.corn ?? {};
    return [
      ...[0, 1, 3, 4].map((phase, i) => ({
        ...args, seed: seed + 31 + i * 17,
        rows: { ...rows, stride: 5, phase },
        corn: { peelChance: 0.12, ...corn },
      })),
      { ...args, seed: seed + 91, rows: { ...rows, stride: 5, phase: 2 },
        corn: { ...corn, peel: true, peelChance: 0.6 } },
    ];
  }
  if (args.species === 'sunflower' && !args.rows?.stride) {
    // three variants; the shared `heading` must match across strokes (a sunflower field faces one way)
    const rows = { spacing: 0.85, plant: 0.5, ...(args.rows ?? {}) };
    const heading = args.heading ?? -0.6;
    return [0, 1, 2].map((phase, i) => ({
      ...args, heading, seed: seed + 23 + i * 19,
      rows: { ...rows, stride: 3, phase },
    }));
  }
  return [args];
}
