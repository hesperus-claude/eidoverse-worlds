// flightbody — what a body must HAVE to fly, checked by bone NAME only (re-export with the same names and flight works).
// A CAPABILITY REPORT, not a boolean: a wingless body still flies the physics, it just can't animate wings. PURE: bone names in.

/** <side>_Wing_<row> then _1, _2 outward (the rig tooling's sibling convention). Two rows per side, three deep. */
export const WING_RE = /^([LR])_Wing_(Upper|Lower)(?:_(\d+))?$/;

/** Nothing reads this table: inspectBody matches WING_RE and its own CORE list below. */
export const WANTED = {
  wings: WING_RE,
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
  // root-first by the INDEX in the name: counting underscores collapses _1 and _2 to one level
  for (const k of Object.keys(chains)) {
    chains[k].sort((a, b) => depthOf(a) - depthOf(b));
  }
  const wingCount = Object.values(chains).reduce((n, c) => n + c.length, 0);
  // core bones by any spelling (Tripo `Hip`/`Spine02`, three-vrm `hips`/`chest`, Mixamo `Hips`/`Spine`): case-insensitive, a set per joint
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
  // chains of differing depth are fine and worth SAYING
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

/** For a log or a HUD readout. */
export function describeBody(report) {
  if (!report.canFly) return `NOT FLIGHT-CAPABLE: ${report.missing.join(', ')} absent`;
  const wings = report.canAnimateWings
    ? `${report.wingCount} wing bones in ${Object.keys(report.chains).length} chains`
    : 'no animatable wings';
  return `flight-capable, ${wings}${report.notes.length ? ' -- ' + report.notes.join('; ') : ''}`;
}
