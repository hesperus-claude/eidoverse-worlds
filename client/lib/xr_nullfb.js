// A NULL EYE FRAMEBUFFER IS THE DEFAULT FRAMEBUFFER (tools/xr-render-errors-probe.mjs).
//
// three r186, WebGL backend: XRManager hands the session layer's framebuffer to backend.setXRTarget, and
// _setFramebuffer then calls WebGLState.drawBuffers(renderContext, fb), which caches per framebuffer in a WeakMap —
// `currentDrawbuffers.set(fb, …)`. A WebGL emulator (IWER, and the Immersive Web Emulator extension built on it)
// answers XRWebGLLayer.framebuffer with null by design (iwer lib/layers/XRWebGLLayer.js:44: it draws to the canvas and
// splits it per eye), so the set throws `Invalid value used as weak map key` — inside renderer._renderOutput before
// `xr.enabled` is restored (no finally), leaving the renderer with XR OFF: later frames drew the desktop camera.
//
// A real immersive runtime returns an opaque WebGLFramebuffer, never null (WebXR § XRWebGLLayer: only an INLINE
// session's layer has a null framebuffer). So the wrapper installs at sessionstart, and only when that session's base
// layer really has a null framebuffer — the condition itself, not a guess at which emulator is present. For null, the
// draw-buffer state the default framebuffer needs is [BACK] (what three issues for a context with no textures).
// Revisit at every three bump: if drawBuffers stops keying a WeakMap on the framebuffer, delete this file.
export function tolerateNullXRFramebuffer(renderer) {
  const state = renderer?.backend?.isWebGLBackend ? renderer.backend.state : null;
  const xr = renderer?.xr;
  if (!state || !xr || typeof state.drawBuffers !== 'function') return null;
  const handle = { armed: true, installed: false, disarm() { handle.armed = false; } };   // disarm: the probe's --control
  xr.addEventListener('sessionstart', () => {
    if (!handle.armed || handle.installed || xr._glBaseLayer?.framebuffer !== null) return;   // undefined = no base layer (projection layers)
    const drawBuffers = state.drawBuffers;
    state.drawBuffers = function (renderContext, framebuffer) {
      if (framebuffer === null && renderContext?.textures != null) return drawBuffers.call(this, { textures: null, renderTarget: renderContext.renderTarget }, null);
      return drawBuffers.call(this, renderContext, framebuffer);
    };
    handle.installed = true;
  });
  return handle;
}
