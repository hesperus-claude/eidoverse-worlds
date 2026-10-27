# Arm IK: the swivel-solver port

`client/lib/xrbody.js`, a port of Basis's `BasisArmSolveCore.cs` (com.basis.eeriemovement, `6377b3eb`). The dials
are the `ARM` table.

## What it replaced

A two-bone solve with a fixed chest-local pole: the elbow flipped at the pole singularity, and the wrist wrapped
because the hand bone took the whole grip twist.

## The solve

- The elbow lives on the circle of radius `upper·sinα` about the shoulder→hand axis. A stable frame on that circle
  is built from the torso, so the swivel angle is continuous across reach directions.
- `SAMPLES` (36) samples plus a golden-section refine pick the cheapest angle under three costs: a prior (the rest
  direction blended toward the head's line of sight), last frame's angle, and a torso-capsule penalty.
- Hysteresis: a far-cheaper basin only wins after a `DWELL` (0.2 s), so the elbow doesn't flicker between two
  solutions. The chosen angle is smoothed (`SMOOTH` 0.08 s, at most `MAX_RATE` 720°/s) and reset outright on a
  teleport (a target jump over `TELEPORT` × the chain length).
- Reach is soft at the end (exponential, `SOFT` 0.02), so full extension never pops.
- The wrist twist is split: the forearm rolls and the hand takes the remainder, so the grip orientation still lands
  exactly.
- Lost tracking: hold the last solve `HOLD` (0.5 s), then relax toward the clip at `RELAX_HZ` (3 Hz), Basis's
  tracker-loss rule, instead of snapping in one frame.
- Gestures trump IK.

## Not ported

Basis's joint-limit costs (humeral, pronation, wrist): they need its per-joint limit tables.
