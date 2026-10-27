# The light rig: a fixed slot topology

Code: `client/lib/lightrig.js`. Ground truth: TEL0S_NOTES.md §12.1 and §12.4; the weather seam: `docs/upstream-wrap-once.md`.

## Decision

The renderer's pipeline cache keys lights by `(id, castShadow)` in scene-traversal order; an intensity-0 light stays in
the hash, and `visible = false` culls it out. So the rig fixes the light **topology** at module init: `N_SLOTS` point
lights under one group, created before the first compile and never added, removed, reparented or visible-toggled. An
idle slot is intensity 0, the supported "off". Everything that used to add or remove a light (placed lights, emissive
lamps, the weather system's lightning) is a **request**, and slot churn is uniform writes. One slot (`SHADOW_SLOT`)
casts from construction; the rest never do (see `chest-lamp-shadow.md`).

**Why.** Adding a point light was a whole-scene recompile, so a small light budget, a compile per grant and a one-way
governor ratchet all existed to ration it. Fixed slots make the cost a boot-time constant.

## Assignment

Deterministic in (state, camera), so two clients standing in the same spot light it the same way:

1. Adopted foreign lights (the lightning) hold reserved slots, outside distance ranking and the governor's cap, so a
   pool shed to zero can't delete a storm's strikes.
2. Then by tier: `keep` (`spec/history/PROTOCOL-v1.md` §3.1: exempt from governor shedding), then authored placed lights, then inferred lamps;
   within a tier by camera distance, with incumbents' distance scored at 85% so a walk along the boundary doesn't flicker
   a porch light.
3. `keep` is priority, not a budget escape: with more keeps than slots the nearest win and the rest go unlit by a slot.
   The governor's slot cap applies only to the non-keep tail.
4. A request that wants shadows swaps into the casting slot; the incumbent takes its old slot, so nothing is evicted. A
   second shadow-wanter lights without casting rather than grow a second caster.

## Foreign lights

The weather system `scene.add()`s one lightning PointLight at construction. One rendered frame with a foreign light in
the scene is a recompile storm, so the catch happens at `add()`: the weather factory is handed a per-scene `Proxy` whose
`add`/`remove` divert lights into an adoption list, and the rig mirrors an adopted light's live properties into a slot
each frame. The proxy is stable per real scene (weather keys its one-system-per-scene registry on it). The seam goes
away if upstream grows a lightning-light injection.

## Why N = 8 (load-bearing)

With the compile at boot instead of mid-session, a full grass field compiled in about 1.4 / 1.5 / 1.55 / 1.6 s at
4 / 8 / 12 / 16 slots and held ~120 fps at every count on the measuring machine. 8 is the modest end of the target band
because per-fragment loop cost and shader compile time scale with slot count and weaker machines weren't measured; the
governor's `lights` lever handles them downward, and `?slots=N` (clamped 0..16) re-measures with `lightbench --measure`.

Rejected: adding and removing lights on demand (a recompile each); rationing a runtime budget of 4.
