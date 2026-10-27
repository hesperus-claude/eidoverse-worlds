# ammodoll: the Bullet port

`client/lib/ammodoll.js` is the Bullet (ammo.js) body engine, ported from socketteer/ragdoll-physics. Its contract is
`BodyEngineBase` (`client/lib/bodyengine.js`), shared with the Verlet engine (`ragdoll.js`); `bodysim.js` picks one,
Bullet by default, Verlet as the floor every load failure lands on.

## Why port this source

ragdoll-physics tuned its joint-limit tables, finger springs, tendon coupling and grab against real avatars in
Blender, and Blender's rigid-body engine *is* Bullet. Its numbers transfer to ammo.js unchanged; a different solver
would have had to re-derive every constraint.

What does not transfer is the avatar contract. The source rig is a biped with a rig file baked from a hand-sculpted
proxy mesh, Z-up, bones along local +Y. Here the rig is measured from the live VRM skeleton at construction:

- body boxes from bone lengths (the source's own skeleton-only fallback); hair and wing segments are sized from the
  skinned mesh where there is one (`boneMeshExtents`);
- masses from Dempster segment fractions (`MASS_FRAC`), scaled from a 62 kg body at 1.70 m by (H/1.70)³; never from
  proxy volume;
- every joint frame from an anatomical basis: Y along the bone (twist), X the flexion axis derived from the rig's own
  forward/up. Never a node's local axes: VRM nodes sit near-identity at rest, so their local frames carry no anatomy.

## Structural laws

- **Rest-aligned bodies.** Each body's orientation is the rotation carrying its rest configuration to its live one
  (identity at rest), so a joint frame built from rest anatomy reads the born excursion, and limits mean "from rest"
  as the source's tables intend. Joint anchor origins are still mapped through the live transforms: handing the
  solver a position error at build drives it to the angular-velocity ceiling within a few frames.
- **A joint must contain the pose it was born in.** Every angular bound is widened to admit the build pose plus
  `BUILD_WIDEN` of slack, per axis, or the solver annihilates the difference on frame one. Axes locked at zero
  (trunk twist, knee side-bend) are exempt.
- **The trunk is three bodies** (pelvis, spine, chest) on the source's spine/chest limits. A single rigid torso was
  tried and rejected: it falls as a plank and overloads the arm joints. A rig with no spine/chest bones still gets
  the single-body fallback.

## What is taken from the source

- the joint table (rigdef.py JOINTS, degrees), re-expressed on the anatomical basis, then hand-tightened in-world
  (`JOINT_SPECS`), since a ragdoll has no muscle tone;
- fingers as real spring bodies (`btGeneric6DofSpringConstraint`, `FINGER_STIFFNESS` 12, `FINGER_DAMPING` 0.9),
  proximal and intermediate only; the distal link was a dead end (a three-link chain of tiny bodies blows far past
  its limit). The thumb is one body;
- tendons: neighbouring fingers (index→middle→ring→little, never the thumb) coupled by a weak orientation spring
  (`FINGER_TENDON` 8). Explicit torques on bodies this light went NaN at every gain; the solver couples them stably;
- solver settings: 30 iterations, split impulse, `stepSimulation(dt, 8, 1/120)`; limits held through `setParam`,
  since this ammo build binds no `getRotationalLimitMotor`. So there are no muscle-tone motors: limpness is the
  source's damping and limit ERP;
- the grab: `btPoint2PointConstraint` with an impulse clamp, which makes a distant pin a pull instead of a teleport;
- linear damping 0.12, friction 0.85, restitution 0.03.

One deliberate divergence: angular damping is 0.7, not the source's 0.45. Our bodies tumble at speed, and at 0.45
hands and head keep ringing and never sleep.

## WASM lifetime

The source leaked Ammo objects per frame before it learned this: every Ammo object an instance creates is tracked and
destroyed in `dispose()`, and per-frame math reuses module-level temporaries.
