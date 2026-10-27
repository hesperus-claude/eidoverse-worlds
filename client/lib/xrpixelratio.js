// xrpixelratio — while presenting, the XR layer owns the pixel ratio (#32): three r186 scales every eye's viewport by
// getPixelRatio(), so a later setPixelRatio splits the eyes. Calls are deferred, not refused; takeDeferred() at exit.
export function guardPixelRatioInXR(renderer) {
  if (!renderer || renderer.__xrPixelRatioGuard) return null;
  const apply = renderer.setPixelRatio.bind(renderer);
  let deferred = null;
  renderer.setPixelRatio = function setPixelRatio(value = 1) {
    if (renderer.xr?.isPresenting) {
      // writing the current value (XR's pinned 1) ends a save/change/restore: clear, so exit uses the device ratio
      // known cost: a genuine request for exactly the pinned value reads the same
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
