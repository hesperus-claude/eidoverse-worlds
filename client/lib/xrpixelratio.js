// xrpixelratio — while presenting, the pixel ratio belongs to the XR layer (#32, split vision). three r186's WebGL
// backend scales every eye's viewport by getPixelRatio() into its post-processing target, and nothing stops a later
// setPixelRatio (the frame governor's shed moved the right eye over the left). Callers are deferred, not refused:
// the last value asked for is handed back at exit via takeDeferred().
export function guardPixelRatioInXR(renderer) {
  if (!renderer || renderer.__xrPixelRatioGuard) return null;
  const apply = renderer.setPixelRatio.bind(renderer);
  let deferred = null;
  renderer.setPixelRatio = function setPixelRatio(value = 1) {
    if (renderer.xr?.isPresenting) {
      // a write of the value the ratio already reads (XR's pinned 1) ends a save/change/restore: it clears the request,
      // so exit falls back to the device ratio. Known cost: a genuine request for exactly the pinned value reads the same.
      deferred = value === renderer.getPixelRatio() ? null : value;
      return;
    }
    apply(value);
  };
  const handle = {
    takeDeferred() { const v = deferred; deferred = null; return v; },
    get deferred() { return deferred; },
  };
  renderer.__xrPixelRatioGuard = handle;
  return handle;
}
