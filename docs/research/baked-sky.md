# The baked sky: clouds as a texture

Code: `client/lib/sky_baked.js` (`attachBakedDome`), the tiers in `client/lib/sky.js`, band cuts in `client/lib/sky_bands.js`.

## Decision

Below the `high` cloud tier, the volumetric clouds are shown as an equirect bake on a static dome instead of a per-pixel
raymarch, and the bake is kept alive.

## Why

The dome's march re-shades every screen pixel every frame, but the sky it draws is a function of view direction alone:
the domes are camera-centred and the cloud shell is hundreds of metres up, so walking around a world produces no
parallax a person can see. Re-marching a direction-only signal every frame was where the frame budget went (on the
measuring machine about 120 fps without clouds against about 30 with). The sky system already renders that signal into
an equirect target by per-texel direction (`bakeEnv`); this module shows that bake and keeps it fresh.

## How it stays alive

- **Two targets, front and back.** The dome cross-dissolves between them, so the sky is always easing toward a bake a few
  seconds newer and clouds keep their slow evolution. Rejected: swapping one texture in place, which made the cloud
  field's nucleate-and-grow read as stepwise jumps.
- **Banded bakes.** The cached bake material renders a horizontal strip per frame (a few ms each) instead of one blocking
  full-quad pass; one full 8-pass draw at the `medium` size trips the GPU watchdog. Banding is what makes the `medium`
  tier's 4096×2048 bake affordable (`low` is 2048×1024). Rejected: 2048 wide everywhere, about 4× undersampled against
  the screen, which read as mush.
- **Environment agrees with the sky.** Each bake is blitted into one small persistent `scene.environment` target (a
  different texture object there recompiles every PBR material, and PMREM from the full bake stalled), so IBL matches the
  visible sky.

## Traded away, on purpose

Per-frame lightning illumination inside the clouds (bolts and the scene flash stay live), and the fine per-pixel shimmer
of the true march. The live march remains the `high` tier.

## Coupling

The module reaches through `skyApi._internals.sky` (the declared engine-work escape hatch) for `domes`, `_envTarget` and
the cached `_envBake` {scene, camera}. If a toolkit update moves any of them, `attachBakedDome()` returns false and
`sky.js` stays on the live march: slower, never a broken sky.
