# Attribute-aware LOD simplification: the weights and why

Code: `server/optimize.ts` (`simplifyAttributes`, `LOD_NORMAL_WEIGHT` / `LOD_UV_WEIGHT` / `LOD_COLOR_WEIGHT`, the
regular-then-permissive passes). Look-check harness: `tools/lod-look-probe.mjs`.

## Decision

Each primitive is simplified with meshoptimizer's `simplifyWithAttributes`, with normals, `COLOR_0` and `TEXCOORD_0` in
the error metric, never gltf-transform's `simplify()`. Weights: normals 0.25, UVs 1, colour 1. Flags: `ErrorClamped`
and `ErrorAbsolute`, plus `Permissive` only on the retry pass. Nothing is locked. Weld, strip/fan conversion and
compaction use gltf-transform's own exported helpers, as its `simplify()` does.

## Why

gltf-transform's `simplify()` hands meshoptimizer positions only, so every collapse was judged on shape alone: across
hard-edge normals (wheel arches smeared dark, a rear wheel gone) and across UV seams (white blotches, foliage gone
dull). meshoptimizer's README says to use Permissive only with attribute-aware simplification; we had been using it
without.

## How the weights were chosen

Six library models rendered at the client's LOD switch distances, compared against the served KTX2 tier:

- **Normals 0.25.** At 1.0 (meshoptimizer's demo, Godot) or 0.5 (gltfpack) some models (a desk, a streetlight) couldn't
  reach the reduction bar and went `ineffective`.
- **No locking.** Protecting UV-seam and crease vertices (`meshopt_SimplifyVertex_Protect`) froze the seamed models and
  changed nothing on the rest. Weighted UVs let the simplifier trade instead of refuse; a model that can't reach the bar
  without tearing its UVs keeps its geometry: served as a texture-only LOD when its textures shrink enough (`LOD_TEX_ONLY`),
  otherwise refused `ineffective` (a pallet); never served torn.
- **`ErrorClamped` (meshoptimizer 1.3)** clamps attribute error to the position-error scale. Without it the normal error
  used up the budget and every pass stopped early: all six test models went `ineffective`. The README recommends it for
  any attribute-aware use.

Result at the switch distance: the worst model went from about a quarter of its pixels visibly different to a few
percent, with its wheels and arches kept; a foliage-heavy tree went from about half to under a third, its foliage colour
kept. The per-model tables stay in git history.
