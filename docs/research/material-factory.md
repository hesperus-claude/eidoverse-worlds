# The material factory: wrap at creation

Code: `client/lib/materials.js`. Ground truth: TEL0S_NOTES.md §12.1–§12.3.

## Decision

Every material that enters the world scene passes through the factory at creation, before its first compile, and comes
out with its final shader-graph shape: the wetness wrap, the cloud-shade term and its shadow-receiving policy. After
that, everything weather or sky does to a surface is a uniform write. Nothing rewraps, nothing recompiles, nothing waits
for the sky to arrive.

## Why

On three's WebGPU renderer a material's compiled pipeline dies whenever its node graph changes shape. Upstream's weather
and sky systems integrate by sweeping the scene and rewrapping materials that are already compiled; one Safari join
measured dozens of rewraps at seconds per graph. The cure is to apply the wraps before the first compile, so they can't
depend on upstream systems that arrive seconds later. The wraps are client-owned and driven by folded state
(`effectiveSky` from `shared/forecast.js`, the same derivation the sequencer and the agent use), not by reading the
weather system's internals. Wet ground in rain works the same under the plain-sky fallback.

## The two wraps

- **Wetness:** a shape-identical port of upstream `weather_system.js` `wrapMaterial` (same node structure, same
  `noPuddles` gate, our uniforms). Upstream's own transitions only write the wetness uniform after wrapping, so driving
  the same uniforms is upstream's behaviour minus the recompile.
- **Cloud shade:** our own cheap field, not a port. Upstream's is a multi-tap march over textures made inside the sky
  system, which can't exist before the sky modules do. Ground shadows need to read as clouds, not match the dome tap for
  tap: two taps of a boot-made tileable noise texture, wind-scrolled and sun-projected.

## Interop and determinism

- Every prepared mesh is marked `userData.noWet` and `userData.noCloudShadow`, so upstream's sweeps find nothing to do.
  Unprepared materials (the mods escape hatch) are still swept as before: that path degrades, it doesn't break.
- The noise lattice is seeded (`mulberry32`), not `Math.random`: every client grows the same cloud field, so two people
  standing together watch the same shadow cross the same meadow.

Rejected: letting upstream sweep and rewrap (a recompile per material, after the sky lands); porting upstream's cloud
shadow march (it needs the sky's textures first).
