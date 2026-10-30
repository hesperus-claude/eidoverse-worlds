// XR PIXEL-RATIO GUARD (#32: the right eye painted over part of the left).
//
// three r186's WebGL backend renders the scene into its tone-mapping/colour-space target
// (isPostProcessingRenderTarget) and multiplies EVERY EYE'S VIEWPORT by renderer.getPixelRatio()
// (three.webgpu.js: `pixelRatio = (renderTarget === null || renderTarget.isPostProcessingRenderTarget)
// ? this.renderer.getPixelRatio() : 1`, then `vp.x * pixelRatio`). XRManager pins the ratio to 1 at
// session start, but nothing stops a later setPixelRatio: CanvasTarget writes _pixelRatio BEFORE its
// "can't resize while presenting" check, and that check reads an `xr` the CanvasTarget doesn't have.
// So when the frame governor shed pixels (1 → 0.75), the right eye's viewport started at 0.75·W.
//
// While presenting, the ratio belongs to the XR layer. Callers (governor, render-scale menu, diagnostics)
// are deferred, not refused: the last value asked for is handed back at exit via takeDeferred().
export function guardPixelRatioInXR(renderer) {
  if (!renderer || renderer.__xrPixelRatioGuard) return null;
  const apply = renderer.setPixelRatio.bind(renderer);
  let deferred = null;
  renderer.setPixelRatio = function setPixelRatio(value = 1) {
    if (renderer.xr?.isPresenting) {
      // A write of the value the ratio ALREADY reads (XR's pinned 1) means "back to where I found it" — the end of a
      // save/change/restore (getPixelRatio → set(x) → set(saved), as grassdiag.js does). It CLEARS the request, so the
      // exit falls back to the device ratio. Known cost: a genuine request for exactly the pinned value (render scale
      // 0.5 on a dpr-2 screen) also reads as "nothing" and exits at the device ratio until that caller asks again.
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
