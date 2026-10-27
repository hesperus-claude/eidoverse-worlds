// floradefs — the flora def contract (charter §3: content is data; code is for new KINDS of things). A def is
// defs/flora/<name>.json, validated at load and refused if it fails. Checks are type-level, not taste-level; unknown keys
// are PRESERVED, never dropped.

/** A def naming another archetype can't be built by any client and is refused at load (new archetypes are engine code).
 *  @type {string[]} */
export const FLORA_ARCHETYPES = ['blades', 'shrub', 'yucca', 'corn', 'sunflower'];

/** Def names double as wire values in `grass` verb args and as filenames. */
export const DEF_NAME_RE = /^[a-z][a-z0-9_-]{0,32}$/;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isVec = (v, n) => Array.isArray(v) && v.length === n && v.every(isNum);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** → problems; empty means servable.
 *  @param {string} name @param {unknown} def @returns {string[]} */
export function validateFloraDef(name, def) {
  const errs = [];
  if (!DEF_NAME_RE.test(name)) errs.push(`name "${name}" — lowercase letter first, then letters/digits/_/-, ≤33 chars`);
  if (!isObj(def)) return [...errs, 'def must be a JSON object'];
  const d = /** @type {Record<string, unknown>} */ (def);

  if (!isStr(d.archetype)) errs.push('archetype is required (string)');
  else if (!FLORA_ARCHETYPES.includes(d.archetype)) {
    errs.push(`archetype "${d.archetype}" unknown — engine builds: ${FLORA_ARCHETYPES.join(', ')}`);
  }
  // per-field type gates, checked only when present
  const num = ['density', 'clump', 'sss', 'rough', 'pushScale', 'footRadius', 'stemColor'];
  for (const k of num) if (d[k] != null && !isNum(d[k])) errs.push(`${k} must be a number`);
  const str = ['maps', 'stem', 'gen'];
  for (const k of str) if (d[k] != null && !isStr(d[k])) errs.push(`${k} must be a string`);
  const obj = ['blades', 'rosette', 'corn', 'sunflower', 'colors', 'wind', 'regionTint'];
  for (const k of obj) if (d[k] != null && !isObj(d[k])) errs.push(`${k} must be an object`);
  if (d.baseScale != null && !isVec(d.baseScale, 2)) errs.push('baseScale must be [lo, hi]');
  if (d.stemTint != null && !isVec(d.stemTint, 3)) errs.push('stemTint must be [r, g, b]');
  if (d.leafRecolor != null && !isStr(d.leafRecolor) && !isVec(d.leafRecolor, 3)) {
    errs.push('leafRecolor must be a GRASS_COLORS name or [r, g, b]');
  }
  if (isObj(d.wind)) {
    for (const k of ['base', 'gust', 'gustFreq', 'flutter']) {
      if (d.wind[k] != null && !isNum(d.wind[k])) errs.push(`wind.${k} must be a number`);
    }
  }
  return errs;
}

/** defs/flora/_presets.json: each preset has a non-empty `strokes` list; `species` required per stroke;
 *  `density`/`inset`/`seedAdd` numeric; `offset` an [fx, fz] pair; everything else passes through.
 *  @param {unknown} presets @returns {string[]} */
export function validateFloraPresets(presets) {
  if (!isObj(presets)) return ['_presets must be a JSON object'];
  const errs = [];
  for (const [name, p] of Object.entries(presets)) {
    if (name === 'doc') continue;
    if (!DEF_NAME_RE.test(name)) { errs.push(`preset name "${name}" fails the def-name rule`); continue; }
    if (!isObj(p) || !Array.isArray(/** @type {any} */ (p).strokes) || !(/** @type {any} */ (p).strokes.length)) {
      errs.push(`${name} must carry a non-empty strokes[]`); continue;
    }
    for (const [i, s] of /** @type {any} */ (p).strokes.entries()) {
      if (!isObj(s)) { errs.push(`${name}.strokes[${i}] must be an object`); continue; }
      if (!isStr(s.species)) errs.push(`${name}.strokes[${i}].species is required (string)`);
      for (const k of ['density', 'inset', 'seedAdd']) {
        if (s[k] != null && !isNum(s[k])) errs.push(`${name}.strokes[${i}].${k} must be a number`);
      }
      if (s.offset != null && !isVec(s.offset, 2)) errs.push(`${name}.strokes[${i}].offset must be [fx, fz]`);
    }
  }
  return errs;
}

/** defs/flora/_colors.json: each entry an [r,g,b] multiplier or a {recolor: [r,g,b]} hue-changer. Empty = servable.
 *  @param {unknown} colors @returns {string[]} */
export function validateFloraColors(colors) {
  if (!isObj(colors)) return ['_colors must be a JSON object'];
  const errs = [];
  for (const [name, v] of Object.entries(colors)) {
    if (name === 'doc') continue;
    const ok = isVec(v, 3) || (isObj(v) && isVec(/** @type {any} */ (v).recolor, 3));
    if (!ok) errs.push(`${name} must be [r,g,b] or {recolor: [r,g,b]}`);
  }
  return errs;
}
