# Shadow-depth pre-warm: how three keys depth pipelines, and the restore trap

Code: `client/lib/warmqueue.js` (`ensureDepthWarm`, `configureFor`, `compileDepthRound`, `warmDepth`). Read against the
three.js build the client loads (`node_modules/three/build/three.webgpu.js`, 0.186.0 installed; `package.json` allows `^0.186.0`); three's
internals move between releases, so this describes the mechanism, not line numbers.

## Decision

The shadow-depth pass was the one pipeline family nothing warmed: every caster the rig enabled paid a synchronous
pipeline creation inside the next shadow render (TEL0S_NOTES §16.1c). `warmDepth` compiles a caster's depth pipelines
through `renderer.compileAsync` before `castShadow` flips, so the real pass is a cache hit. `?nodepthwarm=1` bypasses
it, to tell a wrongly warmed pipeline from a driver issue.

## Why a warm compile lands the real pipeline

- The pipeline cache is renderer-global and keys on program ids plus a value-only backend key (blend/depth/stencil/side
  state, target formats, sample count, topology, geometry): no object, scene or context identity.
- Programs dedupe by WGSL source text, and the node builder names uniforms and variables with builder-local counters and
  inlines constants by value, so structurally identical graphs emit identical text.
- So a warm compile that reproduces the real pass's material values, node graph, object and target formats gets the same
  GPU pipeline. Only formats matter for the target, which is why a 4×4 scratch target with the shadow map's formats
  stands in when the sun's map doesn't exist yet.

## The real pass

The shadow node sets `scene.overrideMaterial` to a per-light node material (`colorNode` vec4(0,0,0,1),
`isShadowPassMaterial`, `NoBlending`, no fog) and renders into a target typed by `shadow.mapType` with a depth texture.
Depth-pass codegen is scene-independent by design: the dynamic cache key skips lights/env/fog for shadow-pass materials.
Per caster material the renderer derives `colorNode`/`depthNode`/`positionNode` once and caches the instances on itself
(`_getShadowNodes`), then mutates the override material per object: alphaTest/alphaMap/transparent copied, side flipped
(through the shadow-side map, or the material's own side under VSM, unless `shadowSide` is set).

## The trap

`renderObject()` restores the override material's nodes and side right after queueing the object, and `compileAsync`
defers codegen until after that restore (in compile mode it pushes work items and builds them later). So a naive
"set overrideMaterial, call compileAsync" compiles the wrong pipeline for any caster with a map, alphaTest or a flipped
side. The fix: pre-configure the warm material to exactly the post-mutation state, using the same cached node instances
from `_getShadowNodes` (which also primes the renderer's cache for the real pass), so save → mutate → restore is the
identity and the deferred build sees the right state.

`compileAsync` captures its render target and context synchronously before its first yield (each work item carries the
render context), so the target, override material, visibility and culling flags are all restored in the same
synchronous block and no real frame sees them. Pipelines build through the async device call, so nothing stalls.

If `_getShadowNodes` disappears in a three update, the pre-warm disables itself with a console warning and casters
compile in-frame as before.

## Open

The current three build also copies `displacementMap`/`displacementScale`/`displacementBias` onto the override material
per object; `configureFor` doesn't. A caster with a displacement map may warm a different pipeline than the real pass
uses (a miss, not a wrong render). Unchecked against a displaced caster.
