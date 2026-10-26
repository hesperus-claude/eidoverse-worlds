# Ragdoll tuning: wings

`WING_TUNING` in `client/lib/ammodoll.js` (live, pushed into running wings without a rebuild, like `HAIR_TUNING`).
A limp wing should be dead weight that swings from the shoulder and trails the body: neither flapping (it is
unconscious) nor rigid (it is not a prop).

## Method

Each row is measured over several lean directions, because one fall's number is noise. The metric that matters is the
bend a wing **keeps** at rest, not the peak bend it reaches; jitter is mean angular change per frame after settling.
Hair has no such headless metric ("flows" vs "whips"), so `HAIR_TUNING` is tuned by eye.

## Tension and damping

The first guess (tension 140, damping 0.5, reasoning "a wing has a shoulder that resists") resisted all the way to
rigid: the joint spiked on impact and snapped back to its born pose, which reads as rigid and twitchy.

At damping 0.15, sweeping tension 140 → 3, **8 is the knee**: it keeps the most bend (about 12° at rest against
under 1.5° at 20 and above) with the least jitter. Below it nothing more is gained in fold, and jitter climbs again (a
spring too weak to hold its joint quiet against contact). Doubling the damping cost fold and doubled jitter at every
tension. Bullet's spring "damping" is a target-velocity gain, not dissipation, so more of it is snappier, not calmer.

## The limit ramp

Per-segment limit is `limit * ((j+1)/n)^rootExp`. The ramp is where the remaining stiffness lived: with a steep
exponent, growing the chains from two bones to three halved the shoulder's range without any number changing.
On the three-bone rig, `limit 70, rootExp 1.0` (linear: the shoulder gets a third of the range, the tip all of it)
beat the old `38 / 1.6` on fold and jitter both, so there was no trade to make.

`rootExp 0.7` looked calmer still over four leans, but a paired re-test over ten leans showed no difference
(t ≈ 0.13). Gaps that size have fooled this tuning before; the cheap paired re-test is what settles them.

## Mass and gravity

`mass 0.55` kg per segment: real wings this size would be lighter, but a 20 g plate a metre long is all lever and no
inertia, and reads as paper. `gravity 1.0` (full world gravity), unlike hair's fractional gravity.

The raw sweep tables are in git history (the `WING_TUNING` comment before the comment clean-up).
