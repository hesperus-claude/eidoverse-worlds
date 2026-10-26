# Leaf flutter: forces on the real ragdoll

`shared/leafforce.js` (pure: plain numbers in, force/torque vectors out; callers apply them with their engine's
central-force and torque calls). Bullet integrates; nothing here moves anything.

## Decision: forces, not a curve

`shared/flight.js`'s `leafAt()` is kinematics: a closed form, deterministic to the bit, which the spec's acceptance
tests and the capture path need. But a scripted curve can't be hit by a thrown prop, catch a wing on a rail, or land
badly. The ragdoll can, so this adds the forces a leaf feels to whatever rigid bodies are falling, and the assembly
tumbles the way a falling leaf does.

## The physics

A flat plate falling is unstable: it stalls, slips sideways, sheds a vortex and rolls the other way (the "flutter"
mode). Two terms reproduce it:

1. **Normal drag.** Drag opposes the velocity at ½ρ·speed²·Cd·A, with Cd blended from `cdEdge` to `cdNormal` by |vn|/speed: huge broadside,
   nearly nothing edge-on (`cdNormal` 1.28, a flat plate's classic value; `cdEdge` 0.06). That alone makes a plate
   seek edge-on, and overshoot, because it has inertia.
2. **A displaced centre of pressure** (`copOffset`). On a plate at an angle the aerodynamic force acts forward of
   the centre of mass; the offset is a torque, and it turns the overshoot into a periodic tumble instead of a damped
   wobble.

## The period problem

The period isn't authored: it falls out of mass, area and speed. That is the appeal and the catch, since the spec asks
for 3.4 s. `periodAssist` bridges the gap with a weak couple about world-up, phase-locked to the caller's clock
(0 = purely physical, 1 = herded; default 0.6). It is a thumb on the scale, on purpose.
