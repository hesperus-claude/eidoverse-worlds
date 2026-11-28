// Shadows from the sun, not the head: while presenting, three r186 swaps in xr.getCamera() for every render call,
// the shadow pass included, so the map was drawn from the eyes. xr.enabled off around the pass (render.js
// renderAside's cure). Import-free: core.js applies it at boot; test/client/xrshadow-test.mjs drives it.
export function patchShadowNodeForXR(proto) {
  const orig = proto?.updateShadow;
  if (typeof orig !== 'function' || orig.__xrPatched) return false;
  const patched = function (frame) {
    const xr = frame?.renderer?.xr;
    if (!xr?.isPresenting) return orig.call(this, frame);
    const was = xr.enabled; xr.enabled = false;
    try { return orig.call(this, frame); } finally { xr.enabled = was; }
  };
  patched.__xrPatched = true;
  proto.updateShadow = patched;
  return true;
}

// Every caster in every shadow map: three draws a light's map the first time a pass meets that light in a frame, with the
// renderer.transparent / .opaque that pass set (its RendererUtils reset leaves both alone). The AO pre-pass draws opaque
// only (post.js), and it runs first, so a see-through caster (transparent: true) lost its shadow for the whole frame.
// Both on around the map's draw, put back after (also on a throw). Import-free, like the XR patch; core.js applies both.
export function patchShadowNodeDrawsAll(proto) {
  const orig = proto?.updateShadow;
  if (typeof orig !== 'function' || orig.__drawsAll) return false;
  const patched = function (frame) {
    const r = frame?.renderer;
    if (!r || (r.transparent !== false && r.opaque !== false)) return orig.call(this, frame);
    const t = r.transparent, o = r.opaque; r.transparent = true; r.opaque = true;
    try { return orig.call(this, frame); } finally { r.transparent = t; r.opaque = o; }
  };
  patched.__drawsAll = true;
  if (orig.__xrPatched) patched.__xrPatched = true;   // a second patch over the first still reads as XR-patched
  proto.updateShadow = patched;
  return true;
}
