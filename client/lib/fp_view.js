// fp_view — first-person eye placement and own-body exclusion; reuse it rather than guess a head height (#75).
// The eye anchors on the LIVE rig (head bone, else bounds) so it follows a moving socket; only this avatar is hidden.
// DOM-free and import-free so tools/fp-view-test.ts can pin it under bun.

// FORWARD matches controller.js's eye (0.16 ahead of the head, so nothing behind the eye plane clips); LIFT raises
// the head JOINT (neck top) to eye height. GAZE_*: level look dropped 0.6 over 8 m, holding ground and horizon.
export const FP_FORWARD = 0.16;
export const FP_EYE_LIFT = 0.06;
export const FP_GAZE_AHEAD = 8;
export const FP_GAZE_DROP = 0.6;

// bounds-anchored eye: a fraction of mesh height, without claiming to know the anatomy
export const FP_BOUNDS_EYE = 0.85;

/** Returns { eye, mode:"head"|"bounds" } in world space; throws naming the rig when neither exists, rather than
 *  render from inside the mesh. */
export function resolveFirstPersonAnchor({ head, bounds, name = "this body" } = {}) {
  if (head && head.length === 3 && head.every(Number.isFinite)) {
    return { eye: [head[0], head[1] + FP_EYE_LIFT, head[2]], mode: "head" };
  }
  if (bounds && bounds.min?.every(Number.isFinite) && bounds.max?.every(Number.isFinite)
    && bounds.max[1] > bounds.min[1]) {
    const h = bounds.max[1] - bounds.min[1];
    return {
      eye: [
        (bounds.min[0] + bounds.max[0]) / 2,
        bounds.min[1] + h * FP_BOUNDS_EYE,
        (bounds.min[2] + bounds.max[2]) / 2,
      ],
      mode: "bounds",
    };
  }
  throw new Error(
    `${name}: rig has no head bone and no measurable mesh bounds — first-person view unsupported for this avatar`);
}

/** yaw is root.rotation.y (mounted: the socket's). render must be synchronous (a thenable is rejected); the body is
 *  restored in finally, or a throw would hide it from every other viewer. */
export function composeFirstPerson({ camera, yaw, pitch, head, bounds, name, setOwnVisible, render }) {
  const { eye } = resolveFirstPersonAnchor({ head, bounds, name });
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const ex = eye[0] + fx * FP_FORWARD, ey = eye[1], ez = eye[2] + fz * FP_FORWARD;
  camera.position.set(ex, ey, ez);
  if (Number.isFinite(pitch)) {
    // an asked-for gaze tilt (degrees, + up): same eye, same heading
    const r = pitch * Math.PI / 180, flat = Math.cos(r) * FP_GAZE_AHEAD;
    camera.lookAt(ex + fx * flat, ey + Math.sin(r) * FP_GAZE_AHEAD, ez + fz * flat);
  } else camera.lookAt(ex + fx * FP_GAZE_AHEAD, ey - FP_GAZE_DROP, ez + fz * FP_GAZE_AHEAD);
  setOwnVisible(false);
  try {
    const frame = render();
    if (frame && typeof frame.then === 'function') {
      throw new Error(`${name ?? 'this body'}: async first-person render unsupported — exclusion is synchronous`);
    }
    return frame;
  } finally {
    setOwnVisible(true);
  }
}
