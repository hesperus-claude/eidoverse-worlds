# The particle sim: where it diverges from Godot's CPUParticles3D

Code: `shared/particlesim.js` (ported from Godot Engine 4.7.2-stable `scene/3d/cpu_particles_3d.cpp`,
`CPUParticles3D::_particles_process` and `_update_internal`; provenance and licence in the file header and
THIRD-PARTY.md). The renderer is `client/lib/particlefx.js`; the effect document is `shared/particle_effects.js`.

The module vocabulary (emission shapes, direction/spread/flatness, initial velocity, gravity, linear/radial/tangential
acceleration, damping, angle and angular velocity, scale and its curve, colour and its ramp, hue variation, flipbook
animation speed/offset, lifetime randomness, explosiveness, randomness, one-shot, preprocess, speed scale) is Godot's
ParticleProcessMaterial's. Each divergence, and why:

- **Local coordinates only.** A particles component hangs off its entity and moves with it, so the emission transform is
  the identity and every radial/tangential force is about the emitter's own origin.
- **Gravity alone is world-down** (Unity's convention). The document's gravity is a world-space vector; the renderer turns
  it into the emitter's frame every frame (`setGravity(localGravity(…))`: the inverse of the emitter's world rotation,
  its stretch undone, so it still scales with the emitter's mean size), so a tipped brazier's smoke still rises. Godot's `local_coords` turns gravity with the node.
  Velocity, linear/radial/tangential acceleration and the shape stay in the emitter's frame; tangential's axis is the
  document's gravity as written, read in that frame.
- **Not ported:** 2D (`DISABLE_Z`), emission points, attractors, turbulence, orbit velocity (Godot's is 2D-only here).
- **`sphere` is uniform by volume** (the cube root of the radial draw) with per-axis extents (an ellipsoid). Godot lerps a
  surface point toward the centre by a plain uniform draw, which crowds the centre; the toolkit builder whose look the
  Essentials keep was uniform by volume.
- **`velocity` may be a ranged vector** `{min, max}` per axis (Niagara's Add Velocity), beside Godot's cone, because the
  Essentials' launch was a box, not a cone.
- **Per-particle randoms come from `mulberry32`**, seeded per particle (through `idhash`) and cycled; Godot uses PCG32
  there. Godot's `rand_from_seed` (Park–Miller) and `idhash` are kept where Godot uses them.
- **Hue variation applies without a curve.** Godot 4.7's CPU path multiplies it by 0 unless a curve is set (its GPU path
  doesn't). The anim-offset curve also isn't the angle curve (a slip in the same Godot file, not copied).
- **Every angle is radians** (spread, a ring's cone, angle, angular velocity: PROTOCOL §9.2), where Godot's material
  speaks degrees; the arithmetic is Godot's with its `deg_to_rad` dropped.
- **Four positional modules of our own**, which the Essentials need and Godot has no word for, applied at output so they
  never feed back into the integration: drift (a slow sinusoidal sway), swirl (a small circle with age), converge (the
  horizontal offset from the axis narrows over life: a flame's taper), flicker (alpha twinkles).
