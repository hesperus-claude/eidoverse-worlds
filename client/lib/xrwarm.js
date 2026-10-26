// Dual warm: compileAsync also compiles the other mode's variant, so entering or leaving VR compiles nothing.
//   desktop  through three's XR camera and eyes (xrpass.js withXREyes; a look-alike would rebind stereo uniforms)
//   in VR    the main camera into a 1×1 twin of the desktop target (the desktop frames' render context)
// Only main-camera, no-target calls are doubled. tools/xr-dual-warm-probe.mjs.
// Pattern from BasisVR (MIT, © 2024 Luke B Doolan, https://github.com/BasisVR/Basis).
import { withXREyes } from './xrpass.js';

export function installDualWarm({ THREE, renderer, camera, presenting }) {
  if (!renderer || renderer.__dualWarm) return false;
  const compile = renderer.compileAsync.bind(renderer);
  let twin = null;
  // the desktop tone-mapping target's attachment key: count:format:type:samples:depth:stencil (three RenderContexts.get)
  const desktopTwin = () => (twin ??= new THREE.RenderTarget(1, 1, {
    type: renderer._outputBufferType, samples: renderer.samples, depthBuffer: renderer.depth, stencilBuffer: renderer.stencil }));
  // culling is off only for compileAsync's synchronous walk (it reads frustumCulled before its first await); an
  // uninitialised renderer awaits init() before the walk, so then the flag stays down until the promise settles
  const unculled = (obj, fn) => {
    const off = []; obj.traverse?.((o) => { if (o.isMesh && o.frustumCulled) { off.push(o); o.frustumCulled = false; } });
    const restore = () => { for (const o of off) o.frustumCulled = true; };
    let p;
    try { p = fn(); } catch (e) { restore(); throw e; }
    if (renderer._initialized !== false) { restore(); return p; }
    return p.finally(restore);
  };
  const other = (obj, target) => {
    if (presenting()) {
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(desktopTwin());
      // compileAsync captures its context synchronously: restore before the first await (warmqueue.js's rule)
      try { return unculled(obj, () => { const p = compile(obj, camera, target); renderer.setRenderTarget(prev); return p; }); }
      finally { renderer.setRenderTarget(prev); }
    }
    // the eyes share the desktop's tone-mapping target shape (measured), so only the eye COUNT differs
    return unculled(obj, () => withXREyes(renderer, (eyes) => compile(obj, eyes, target)));
  };
  // three r186 leaves the eye buffer bound after an XR frame (a context the headset never draws with): a bound target
  // that is just the leaked output target counts as unbound for the synchronous pass
  const compileAsRendered = (obj, cam, target, onProgress) => {
    const rt = renderer.getRenderTarget(), out = renderer.getOutputRenderTarget();
    if (rt === null || rt !== out) return compile(obj, cam, target, onProgress);
    renderer.setRenderTarget(null);
    try { return compile(obj, cam, target, onProgress); } finally { renderer.setRenderTarget(rt); }
  };
  renderer.compileAsync = function compileAsync(obj, cam, target = null, onProgress = null) {
    const first = compileAsRendered(obj, cam, target, onProgress);
    // a caller's OWN target (portrait, bake) opts out; three itself leaves the XR output target bound while presenting
    const rt = renderer.getRenderTarget();
    if (cam !== camera || (rt !== null && rt !== renderer.getOutputRenderTarget())) return first;
    return first.then(async (v) => { try { await other(obj, target); } catch { /* a warm is best-effort */ } return v; });
  };
  renderer.__dualWarm = true;
  return true;
}
