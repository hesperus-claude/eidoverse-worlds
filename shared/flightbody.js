// flightbody — what a body must HAVE to fly, checked by bone NAME and nothing else, not an avatar hash: re-export a
// body with the same names and flight keeps working; rename them and this says so. It returns a CAPABILITY REPORT, not
// a boolean: a wingless body still flies the physics, it just can't animate wings.
// PURE, per shared/README.md: the caller passes a list of bone names.

/** The wing chains, as authored by rigtest/hair_rig.py's sibling convention:
 *  <side>_Wing_<row> then _1, _2 outward. Two rows per side, three deep. */
export const WING_RE = /^([LR])_Wing_(Upper|Lower)(?:_(\d+))?$/;

/** Bones flight will DRIVE if they exist. Everything else the body has is its
 *  own business. */
export const WANTED = {
  wings: WING_RE,
  // The humanoid bones the flight pose actually leans on. VRM guarantees
  // these by its own spec, so their absence means something is deeply wrong
  // rather than merely different.
  core: /^(Hip|Spine01|Spine02|Head|NeckTwist01)$/,
};

/**
 * @param {string[]} boneNames  every bone in the body, in any order
 * @returns {{
 *   canFly: boolean, canAnimateWings: boolean,
 *   chains: Record<string, string[]>, wingCount: number,
 *   missing: string[], notes: string[]
 * }}
 */
export function inspectBody(boneNames) {
  const names = Array.isArray(boneNames) ? boneNames : [];
  const chains = /** @type {Record<string, string[]>} */ ({});
  for (const n of names) {
    const m = WING_RE.exec(n);
    if (!m) continue;
    const key = `${m[1]}_${m[2]}`;                 // L_Upper, R_Lower, ...
    (chains[key] ??= []).push(n);
  }
  // Sort each chain root-first. The INDEX in the name is the depth: counting
  // underscores instead collapses _1 and _2 to the same level, which is the
  // bug ammodoll.js documents having hit.
  for (const k of Object.keys(chains)) {
    chains[k].sort((a, b) => depthOf(a) - depthOf(b));
  }
  const wingCount = Object.values(chains).reduce((n, c) => n + c.length, 0);
  // core bones by any spelling: Tripo (`Hip`/`Spine02`), three-vrm's humanoid map (`hips`/`chest`) and Mixamo
  // (`Hips`/`Spine`) reach this; case-insensitive matching over a set per joint is true in all three
  const CORE = [
    ['hip', 'hips'],
    ['spine02', 'spine01', 'spine', 'chest', 'upperchest'],
    ['head'],
  ];
  const lower = new Set(names.map(n => String(n).toLowerCase()));
  const has = (alts) => alts.some(a => lower.has(a));
  const missing = CORE.filter(alts => !has(alts)).map(alts => alts[0]);

  const notes = [];
  const canAnimateWings = Object.keys(chains).length >= 2 && wingCount >= 4;
  if (!canAnimateWings) {
    notes.push(wingCount === 0
      ? 'no [LR]_Wing_* bones: physics will fly, wings will not animate'
      : `only ${wingCount} wing bone(s) in ${Object.keys(chains).length} chain(s); ` +
        'expected 4 chains (L/R x Upper/Lower)');
  }
  if (missing.length) notes.push(`missing core bone(s): ${missing.join(', ')}`);
  // Chains of differing depth are fine and worth SAYING: the wings grew from
  // two bones to three on 2026-08-17 and nothing in the pipeline counted them.
  const depths = [...new Set(Object.values(chains).map(c => c.length))];
  if (depths.length > 1) notes.push(`wing chains have uneven depth (${depths.join('/')})`);

  return {
    canFly: missing.length === 0,      // the integrator needs a root, not feathers
    canAnimateWings,
    chains, wingCount, missing, notes,
  };
}

function depthOf(name) {
  const m = WING_RE.exec(name);
  return m && m[3] ? Number(m[3]) : 0;
}

/** A one-line summary for a log or a HUD readout. */
export function describeBody(report) {
  if (!report.canFly) return `NOT FLIGHT-CAPABLE: ${report.missing.join(', ')} absent`;
  const wings = report.canAnimateWings
    ? `${report.wingCount} wing bones in ${Object.keys(report.chains).length} chains`
    : 'no animatable wings';
  return `flight-capable, ${wings}${report.notes.length ? ' -- ' + report.notes.join('; ') : ''}`;
}
