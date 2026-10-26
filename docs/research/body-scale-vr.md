# Body scale in VR

`client/lib/bodyscale.js` (pure; `tools/bodyscale-test.ts` drives it), composed in `client/lib/xr.js`.

## Size

One multiplier `u` grows the body, its eye height, its stride (move speed) and its collider together, as Basis and
VRChat do. It lives on `vrm.scene`, never on the avatar root: the root also carries the nameplate, the typing pill and
the bubble, which stay screen-sized (`platesize.js` owns their size). `vrm.scene.scale = u · puppet`.

## The VR composition

The device fit (Basis's way) gives the puppet `1/k`, with `k` = avatar eye height / your eye height, so the authored
body's eyes land at your real eye height `H` and tracking is 1:1. A chosen size must not be undone by that fit, and
the eyes must still sit at the HMD and the hands on the controllers. So the **tracking space** (the rig: camera and
controllers) scales by `u` too (`xrScales`: `rig = u`, `body = u/k`, `puppet = 1/k`):

- the HMD reads `u·H` in the world, and the body is `u·(1/k)·E = u·H` tall at the eye;
- the controllers sit `u×` as far from the rig as your hands are from your feet, and the arms (`u/k` × authored)
  reach them: the same 1:1, one size up;
- the world looks `1/u` as big, which is what being big is.

Everything the rig measures in its own frame (the head-height samples that decide `k`, the recentre offsets) is in
rig-local units, i.e. divided by `u` (`toRigLocal`), so `k` stays your height whatever size you chose.

## Nameplate lift

Metres above the measured crown (`plateanchor.js`), at the body's authored size, applied × the live model→world scale
(`plateLift`), so it grows with the body and follows sitting and lying as the automatic placement does. 0 = automatic.
