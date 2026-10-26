// flora_field — field lifecycle assembly, DOM-free (tools/flora.test.ts). A "field" is the setGrass-shaped object
// the grass verb owns: possibly several engine strokes under one group.

import { ownHook, releaseHook } from './autohooks.js';
import { densityCount } from './grass_quality.js';

// applied truth (#74): read the LIVE instanced count, never the policy arithmetic (wireDensityDial can silently no-op on skew)

/** One stroke's draw truth for a requested density factor. */
export function strokeApplied(f, eff, i = 0) {
  const stroke = f.strokeLabel ?? `stroke ${i}`;
  const total = f.count ?? 0;
  // planted nothing: any factor is vacuously on
  if (!total) return { stroke, total: 0, drawn: 0, expected: 0, dial: false, ok: true, why: 'empty' };
  const drawn = f.mesh?.count ?? total;
  const stemDrawn = f.stemMesh?.count;
  const expected = densityCount(total, eff);
  const dial = typeof f.setDensity === 'function';
  if (f.tiled) {
    // a tiled stroke legitimately under-draws (distance falloff, culled tiles); the cap binds from above, with
    // slack for per-tile rounding and the max(1,…) floor
    const slack = f.tiles?.length ?? 0;
    const ok = dial && drawn <= expected + slack;
    return { stroke, total, drawn, expected, dial, ok, falloff: true,
      why: ok ? 'applied-with-falloff' : dial ? 'count-over-cap' : 'no-density-dial' };
  }
  const ok = drawn === expected && (stemDrawn == null || stemDrawn === expected);
  return {
    stroke, total, drawn, ...(stemDrawn != null ? { stemDrawn } : {}), expected, dial, ok,
    why: ok ? 'applied' : dial ? 'count-mismatch' : 'no-density-dial',
  };
}

/** The whole field's draw truth: `off` (eff ≤ 0) is enforced by group visibility, so it holds even where count
 *  dialing is unsupported; a positive factor needs every live stroke's count to match densityCount. */
export function fieldApplied({ fields, groupVisible }, eff) {
  if (eff <= 0) {
    const ok = groupVisible === false;
    return {
      status: ok ? 'applied' : 'not-applied',
      via: 'visibility',
      strokes: fields.map((f, i) => ({
        stroke: f.strokeLabel ?? `stroke ${i}`, total: f.count ?? 0,
        drawn: ok ? 0 : (f.mesh?.count ?? f.count ?? 0), expected: 0,
        dial: typeof f.setDensity === 'function', ok,
        why: ok ? 'hidden' : 'group-still-visible',
      })),
    };
  }
  const strokes = fields.map((f, i) => strokeApplied(f, eff, i));
  const live = strokes.filter((s) => s.total > 0);
  const status = live.every((s) => s.ok) ? 'applied'
    : live.some((s) => s.ok) ? 'partial' : 'unavailable';
  return { status, via: 'count', strokes };
}

/** Compose createFlora results + a clearing mask into ONE field. The caller supplies the parent group (THREE lives
 *  with the caller) and appends host hooks (pushers) to autoHooks. */
export function composeField({ group, fields, mask }) {
  return {
    mesh: group,
    material: fields[0]?.material,
    update: fields[0]?.update,
    setPushers: (list) => { for (const f of fields) f.setPushers?.(list); },
    setDensity: (k) => { for (const f of fields) f.setDensity?.(k); },
    /** group.visible read at call time, so `off` reports what the scene shows */
    applied: (eff) => fieldApplied({ fields, groupVisible: group.visible }, eff),
    // marks the meadow as these hooks' owner, so a subsystem diffing the global hook array can't adopt them (autohooks.js)
    autoHooks: fields.map((f) => ownHook(f.update)).filter(Boolean),
    dispose: () => {
      for (const f of fields) f.dispose?.();
      mask?.dispose?.();
    },
  };
}

/** Prefers the field's own dispose() (engine fields know their textures), else single-mesh teardown. Double-removal safe. */
export function retireField(field, autos, scene) {
  if (!field) return;
  const hooks = field.autoHooks ?? (field.update ? [field.update] : []);
  for (const h of hooks) releaseHook(h, autos);
  if (field.dispose) {
    field.dispose();
  } else if (field.mesh) {
    field.mesh.geometry?.dispose?.();
    const m = field.mesh.material;
    if (Array.isArray(m)) m.forEach((x) => x?.dispose?.()); else m?.dispose?.();
  }
  if (field.mesh) scene?.remove?.(field.mesh);
}
