// xrpass — stereo renders get their own pass. The XR ArrayCamera changes a render object's dynamic cache key, so
// sharing the default chain map made every VR switch dispose and rebuild every object (tools/xr-switch-compile-probe.mjs).
// Stereo cameras route to their own maps ('xr', 'xr:backSide'), so both variants live side by side; passId is only a
// map key in three, and compileAsync resolves through the same get(), so a stereo warm lands where the headset reads.
const isStereo = (camera) => camera?.isArrayCamera === true && camera.cameras.length > 0;

export function separateXRPass(renderer) {
  const objects = renderer?._objects;
  if (!objects || objects.__xrPass || typeof objects.get !== 'function') return false;
  const get = objects.get.bind(objects);
  objects.get = function (object, material, scene, camera, lightsNode, renderContext, clippingContext, passId) {
    // three's own rebuild re-enters get() with the passId it was given: prefix once
    if (isStereo(camera) && !(typeof passId === 'string' && passId.startsWith('xr'))) passId = passId ? `xr:${passId}` : 'xr';
    return get(object, material, scene, camera, lightsNode, renderContext, clippingContext, passId);
  };
  objects.__xrPass = true;
  return true;
}

/** Run a stereo warm through three's own XR camera and its persistent eyes, never a look-alike: r186 binds stereo
 *  uniforms once to whichever ArrayCamera built a shader last (tools/xr-eye-binding-probe.mjs). Before a session the
 *  camera has no eyes, so two are put in for the warm and taken out if no session started meanwhile. */
// overlapping warms share the pushed eyes: a count in flight, and only the last one out takes them back; a session
// that starts meanwhile owns them from then on
const eyeHolds = new WeakMap();   // xr camera → number of warms currently relying on eyes WE pushed
export async function withXREyes(renderer, fn) {
  const xr = renderer.xr, cam = xr.getCamera();
  const held = eyeHolds.get(cam) ?? 0;
  if (cam.cameras.length > 0 && held === 0) return fn(cam);   // three's own eyes (a live session): not ours to touch
  const eyes = (xr._cameras ?? []).slice(0, 2);
  if (eyes.length !== 2) throw new Error('withXREyes: renderer.xr._cameras is not the two persistent eyes (three changed?)');
  if (held === 0) cam.cameras.push(...eyes);
  eyeHolds.set(cam, held + 1);
  try { return await fn(cam); }
  finally {
    const left = (eyeHolds.get(cam) ?? 1) - 1;
    eyeHolds.set(cam, left);
    if (left === 0 && !xr.isPresenting && cam.cameras[0] === eyes[0] && cam.cameras.length === 2) cam.cameras.length = 0;
  }
}
