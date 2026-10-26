# Grass: tiling, the shared program, and distance density

Code: `client/lib/flora.js` (tileField, applyTiles, the §22 constants), `client/lib/flora_lod.js`. Design history: TEL0S_NOTES.md §13.2 and §16.2.B; the §22 entries in its changelog.

## Tiles

**Decision.** A big blades stroke is re-cut into XZ tiles after the density shuffle. Every tile's geometry shares the
stroke's `position`/`normal`/`uv`/`aH`/`color` attribute objects and index (the backend keys GPU buffers on the attribute
object, so they upload once). Each tile gets sliced copies of only the three instanced attributes (`aPosRot`,
`aScaleVar`, `aPhase`), and every tile shares the stroke's one material (wind, the clearing mask and the factory wrap are
bound to the material). Each tile carries its own world bounding sphere, set on both the mesh and the geometry, so
frustum culling works per tile.

**Why.** One monolithic InstancedMesh never culls a blade behind you and pays full fragment cost whatever the view.
Bucketing is a stable scan, so any count-prefix of a tile is still a uniform random subset of its plants, and a tile's
`count` becomes a distance-density budget for free.

**The grid comes from occupancy, not a fixed edge.** A fixed ~12 m edge shredded a sparse desert stroke into dozens of
tiles of ~50 instances, and every InstancedMesh is its own node-builder codegen run (the material cache key carries the
object for instanced objects). The grid aims at `threshold` instances per tile (`matrixPathCaps`: the uniform-buffer
limit / 64), is capped at `TILE_MAX_AXIS` per axis (`?grasstiles=N` overrides it) and then raised so no tile exceeds
`TILE_MAX_EDGE` metres (the edge rule wins over the axis cap), and refuses strokes under
`TILE_MIN_INSTANCES` or under `TILE_MIN_OCC` per tile (their whole-stroke sphere already culls them), and anything that
comes out under 2×2.

**Global-rank tiling.** A blades stroke those rules refuse (a sparse meadow) still tiles when `?grassgrank` isn't `0`,
with the lower `GR_MIN_INSTANCES` / `GR_MIN_OCC`: each tuft keeps the whole-stroke rank the untiled path writes, and a
tile's count is only a ceiling (the keep at its nearest XZ point, less `GR_MARGIN`) that the shader's own keep test
refines. Nothing about a blade changes.

## Why `instanceMatrix` is allocated past the uniform limit

The shader path reads the matrix attribute's *allocation*, never the live draw count. At or below the uniform-buffer
limit the identity matrices become a uniform array with the count baked into the WGSL text: a distinct program and
pipeline per tile size. Above it they ride an instanced attribute whose program is count-independent, so every tile of
a material shares one program and pipelines dedupe by source. So each tile allocates `max(count, cross)` matrices
(`cross` = limit / 64 + 1; about 64 KB of identity at the WebGPU default limit, skipped when it would pass 256 KB) and
sets `count` to its real size. The matrices stay identity on purpose: transforms ride `aPosRot`, and normals still
transform through the instance matrix. The sliced instanced attributes keep their real counts; the draw's instance count
comes from the live `count`, which never exceeds them.

Rejected: a fixed tile edge (above); leaving the matrix on the uniform path (one program per tile size).

## Distance density (§22)

- **Fewer tufts at distance, not thinner ones.** Distant tufts are subpixel cards, near-pure per-instance overhead and
  quad-overshading waste: cutting far-only instance count recovered as much as hiding the grass, while thinning blades
  on the same tiles bought little. The falloff is `(1 − (d − GRASS_NEAR)/(GRASS_FAR − GRASS_NEAR)) ^ GRASS_FALL_EXP`, and
  the shader's per-instance rank dither uses the same exponent, so the CPU tile budget (taken at the tile's nearest
  point, a ceiling) and the visible density are one law.
- **The per-tile blade-count swap was retired.** A whole tile flipping 8 → 4 blades was a visible pop, and blade count
  measured nearly free once the dither did the density shaping.
- **The coarse far twin (2 segments per blade instead of 4, same blade count, so no pop) is off by default.** It measured
  inert: vertex count was acquitted three times (blade thinning, the swap retirement, this). `?grassvlod=on` opts in for
  vertex-bound GPUs; `forceBladeLod('far')` uses it as a diagnostic lever.
- **Finer tiles (`TILE_MAX_AXIS` 12, was 8)** pin the nearest-edge budget closer to the dither curve: on the lush meadow
  12×12 submitted about 7k fewer instances for a small fps gain at identical visible density; 16 added nothing (the
  remaining waste is the curve's own integral). `TILE_MAX_EDGE` 28 m halves the over-submit a tile radius causes.
- **Shaped resident density (`DENSE_BASE`).** The remaining cost was the near/mid instance count. Uniform thinning looks
  bad; the shaped lever thins by `DENSE_BASE` at every distance through the rank dither, widens survivors by
  1/√`DENSE_BASE` (width only, so coverage holds and the height envelope doesn't change), and keeps a full-density guard
  ring at the feet (`DENSE_GUARD_NEAR`..`DENSE_GUARD_FAR`, smoothstep), where one missing tuft is legible. `denseAt` is the
  CPU mirror. `?grassdense=N` in (0, 1] overrides; `1` is the kill switch (byte-identical shader, untouched budgets).

**Load-bearing number.** `DENSE_DEFAULT = 0.65`: on the real-meadow probe at 2× (drift-controlled), 1.0 ran ~52 fps, 0.8
reached 60 but dipped, and 0.65 held a locked 60–61 with ~30% fewer submitted instances and screenshot means within
0.5 RGB. It's the least thinning that held the frame cap.

The fps logs behind each step stay in git history.
