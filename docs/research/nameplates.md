# Nameplates: where a plate hangs and how big it is

`client/lib/plateanchor.js` (where) and `client/lib/platesize.js` (how big, how visible). Both are pure and tested
(`tools/plateanchor-test.ts`, `tools/platesize-test.ts`); `avatar.js` measures each body once and calls them per frame.

## Where: over the live hips at the rest crown height

**Decision (BasisVR's method, `BasisNamePlateAnchorMath.cs`).** Measure the crown once at rest (`EYE_K`, `NO_EYE_K`,
`BOUNDS_CAP_K` are Basis's), then hang the plate over the live hips at the rest hips→crown height, plus a gap of 5 % of
height clamped to 3–15 cm. Sitting lowers the hips, so the plate comes down with them for free. The head term (head +
head span) wins only when the head rises above where the hips say it should be (a stretch, a jump's reach).

**Rejected:** a fixed height above the feet (wrong for short and tall bodies; can't follow sitting or lying), and
tracking the live head (a plate that moves with the wearer's neck reads as broken).

**Lying** (Basis doesn't handle it; its plate floats a torso-length above a lying body). The anchor blends to over the
head, smoothly, so lying down is a glide. A low head alone is not lying: sitting on the ground puts the head at about
40 % of its rest height, inside the band, which slid the plate most of the way to the head of someone sitting upright.
The torso tells them apart: head-over-hips as a fraction of rest is about 0.9 sitting and about 0.4 lying. So lying is
a low head (`LIE_START`→`LIE_FULL`) **and** a torso gone over (`TORSO_START`→`TORSO_FULL`); the lower of the two
blends wins (`lieAmount`). A bow or a crouch keeps the head high, so it doesn't count either.

**Smoothing.** Y is chased critically damped (`TAU`, by eye) with a small dead zone (`DEAD`) for breathing and head
sway; X/Z are not smoothed, because a plate that trails its walking body sideways reads as lag.

**Standing is rigid.** A jump clip moves the hips under the root (crouch, tuck, land), so chasing the live anchor made
the plate lag visibly on jumps. In the standing slots (`STAND_SLOTS`) the plate rides the rest crown over the root,
with no dead zone, and a clip can't move it; the chase runs only on a posture change (stand, sit, lie).

## How big and how visible

**Decision: legibility as the anchor.** Nobody publishes a nameplate curve (BasisVR and Hubs keep plates world-sized;
VRChat hides names past 30 m). Mixed-reality typography guidance puts the legible floor at about 0.4° of text height
and comfortable reading at 0.6–0.75°. So up close the plate is a world object (`s = 1`, it doesn't balloon in your
face); once its capitals would fall under 0.6° (`TEXT_DEG`, from about 5 m: `PLATE_D0`) it holds 0.6°; past `MAX_GROW`
perspective shrinks it again, so a far crowd recedes instead of becoming a wall of equal labels. Plates fade from 20 m
and are gone by 30 m (VRChat's cut, softened).

**Occlusion.** A plate is hidden by scenery and by other bodies, never by its own: the sprite is depth-tested, but its
depth is written as if it stood `plateClear()` metres nearer the eye, that clearance being the farthest its own body
reaches from the anchor (points well below it skipped) (`ownClearance`, measured once per body, so a crown of tentacles through the plate doesn't cut
it). The picture and its stereo depth stay put; only the depth test moves.

**Hold to reveal.** While the reveal key is held, every plate in range comes forward: drawn through everything, at
least 0.6° at any distance (no `MAX_GROW` shrink), faded only past `REVEAL_FULL`–`REVEAL_GONE`. Press and release both
ease over `REVEAL_EASE_MS`.
