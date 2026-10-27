# The chest lamp's shadow: what the tuned values mean

Code: `client/lib/lightrig.js` (`SHADOW_SLOT`, `SHADOW_MAP`, `SHADOW_WORK_DIST`, `SHADOW_BIAS_TEXELS`, `SHADOW_FORWARD`,
`SHADOW_UP`, `setLampShadow`).

## Decision

Slot 0 is a shadow caster from construction (flipping `castShadow` on a live slot is a recompile); a request that wants
shadows is assigned there. A body lit from inside, throwing its own shadows, is the point of the lamp.

The values were tuned by eye with the live dials (`setLampShadow`) against a moving body in real light:

| constant | value | meaning |
|---|---|---|
| `SHADOW_MAP` | 256 | a point light renders six cube faces; 2048 would be ~24 MB of cube map for a 12 cm bulb |
| `SHADOW_WORK_DIST` | 12 | the lamp's range, so the texel and the bias scale to the whole volume it reaches |
| `SHADOW_BIAS_TEXELS` | 8 | texel = 2 × 12 / 256 = 93.75 mm, so normalBias = 0.75 m at the default shadow resolution (2048); `setLampShadow` scales the map with `ew-shadow-res` (128 at 1024, 512 at 4096) and re-derives the bias (1.5 m, 0.375 m) |
| `SHADOW_FORWARD` | −0.02 | the bulb sits 2 cm back into the chest, toward the wings |
| `SHADOW_UP` | 0.15 | 15 cm up, about collarbone height |

## What normalBias 0.75 actually is

Seventy-five centimetres of offset along each surface normal is most of the torso it lights. At that size the shadow
term is mostly pushed out of the scene: little occludes anything, and what reaches the wings is close to unoccluded
point-light falloff. Raising the texel count is what finally lit the wings. So the setting isn't a contact-offset bias;
it says "light the body from inside and mostly don't shadow it". It looks right, which is the criterion here, but
`SHADOW_BIAS_TEXELS` is not 8 texels of contact offset in any useful sense.

**Why the wings are hard.** The wing mass sits wholly behind the bulb in bind space, so light reaching a wing travels
backward out of the chest. That's also why the bulb is nudged back (negative forward). No dial changes that geometry.

## Untried alternative

`PointLightShadow.intensity` (0..1) scales how dark the shadow term gets without distorting geometry: something like a
small bias (~1.5 texels) with intensity ~0.25 would likely land in the same place with the bias meaning what it says.
It hasn't been looked at, so it isn't shipped; a measured value outranks a plausible one. (The rig does use
`shadow.intensity` today, but only as the shadows on/off preference: 0 or 1.)
