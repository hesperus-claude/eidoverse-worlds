// net_capture — the world's 'capture' request, the one protocol message that needs a renderer; out of net.js so a
// scene-less client (client/lite.js) can carry the protocol. Returns a result and never sends: net.js owns the wire.
import { THREE, camera } from './core.js';
import { remotes } from './remotes.js';
import { composeFirstPerson } from './fp_view.js';
import { captureFrame, captureFrom } from './capture.js';
import { entities } from './world.js';
import { normalizeSnapFrame } from '../../shared/snapframe.js';

const _snapHead = new THREE.Vector3();
const _snapBox = new THREE.Box3();

// No partial worlds: aim at the followed body and wait until it, the builds and the models are realized, steady for
// a second; else an explicit error with the counts. The bound is the snap's `wait` (server/snapshots.ts), else SETTLE_MS.
const SETTLE_MS = 20_000, MAX_SETTLE_MS = 240_000, STEADY_CHECKS = 4, CHECK_MS = 250;
/** ms: the server's `wait`, capped at MAX_SETTLE_MS; SETTLE_MS without one. */
export const settleBudget = (msg) => (typeof msg?.wait === 'number' && Number.isFinite(msg.wait) && msg.wait >= 0)
  ? Math.min(msg.wait, MAX_SETTLE_MS) : SETTLE_MS;
// the probe is INJECTED (main.js wires the real one); without it the world counts as ready
let readiness = async () => ({ ready: true });
export function setSnapReadiness(fn) { readiness = fn; }
function aimAt(p) {
  if (!p || !camera?.position) return;
  camera.position.set(p.x, p.y + 2, p.z + 3); camera.lookAt(p); camera.updateMatrixWorld();
}
async function settle(follow, budget = SETTLE_MS) {
  let last = await readiness(follow);
  if (last.ready) return;                     // a settled renderer: no wait at all
  const near = remotes.get(follow)?.avatar?.root?.position;
  aimAt(near);
  const t0 = performance.now();
  let steady = 0;
  while (performance.now() - t0 < budget) {
    last = await readiness(follow);
    if (last.ready) { if (++steady >= STEADY_CHECKS) return; } else steady = 0;
    // the body may have arrived only now: keep the camera (and so residency) on it
    if (!near) aimAt(remotes.get(follow)?.avatar?.root?.position);
    await new Promise((res) => setTimeout(res, CHECK_MS));
  }
  const why = !last?.body ? `${follow} has not loaded yet`
    : `${last.loading} model${last.loading === 1 ? '' : 's'} still loading (${last.models} in)${last.builds ? ', the ground still building' : ''}${last.compiling ? `, ${last.compiling} shader${last.compiling === 1 ? '' : 's'} compiling` : ''}`;
  throw new Error(`the renderer is still loading this world — ${why}; try again in a few seconds`);
}

/** @returns {Promise<{dataUrl: string} | {error: string}>} */
export async function capture(msg) {
  // first (their eyes on the live head bone, own body hidden, #75), third (chase cam), selfie (from in front); or `at` a thing
  try {
    // a just-arrived (roaming) renderer may not have the body or the world built yet
    await settle(msg.follow, settleBudget(msg));
    const r = remotes.get(msg.follow);
    if (!r?.avatar) throw new Error(`${msg.follow} not in local scene (still loading?)`);
    const root = r.avatar.root;
    const fwd = new THREE.Vector3(Math.sin(root.rotation.y), 0, Math.cos(root.rotation.y));
    // framing lives nested in msg.frame, so no top-level message field is read as the camera's
    const frame = normalizeSnapFrame(msg.frame);
    let dataUrl;
    if (msg.at) {
      // a placed thing, seen from where the asker stands, fitted to its bounds
      const obj = entities.get(msg.at);
      // a picture of the grey stand-in would be a confident lie about what was built: say it is loading instead
      if (obj === null || obj?.userData?.placeholder) throw new Error(`"${msg.at}" is still loading — try again in a moment`);
      if (!obj) throw new Error(`"${msg.at}" is not a placed thing in this scene`);
      _snapBox.setFromObject(obj);
      if (_snapBox.isEmpty()) _snapBox.setFromCenterAndSize(obj.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(1, 1, 1));
      const center = _snapBox.getCenter(new THREE.Vector3());
      const radius = Math.max(0.3, _snapBox.getSize(new THREE.Vector3()).length() / 2);
      const from = root.position.clone().sub(center).setY(0);
      if (from.lengthSq() < 1e-6) from.set(0, 0, 1);
      from.normalize();
      const dist = radius / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * 1.1;
      const eye = center.clone().addScaledVector(from, dist).add(new THREE.Vector3(0, radius * 0.25, 0));
      dataUrl = captureFrom(eye, center);
    } else if (msg.view === 'third') {
      // look-ahead scales with distance (4 m at the default 3.4 m), so a near camera still tilts down onto the body
      const dist = frame.dist ?? 3.4;
      const eye = root.position.clone().add(new THREE.Vector3(0, frame.height ?? 2.1, 0)).addScaledVector(fwd, -dist);
      dataUrl = captureFrom(eye,
        root.position.clone().add(new THREE.Vector3(0, 1.2, 0)).addScaledVector(fwd, 4 * dist / 3.4));
    } else if (msg.view === 'selfie') {
      const eye = root.position.clone().add(new THREE.Vector3(0, frame.height ?? 1.6, 0)).addScaledVector(fwd, frame.dist ?? 2.6);
      dataUrl = captureFrom(eye, root.position.clone().add(new THREE.Vector3(0, 1.25, 0)));
    } else {
      const head = r.avatar.headWorldPosition(_snapHead);
      const box = head ? null : r.avatar.visualBounds(_snapBox);
      dataUrl = composeFirstPerson({
        camera,
        yaw: root.rotation.y,
        pitch: frame.pitch,
        head: head ? [head.x, head.y, head.z] : null,
        bounds: box ? { min: box.min.toArray(), max: box.max.toArray() } : null,
        name: msg.follow,
        setOwnVisible: (v) => { root.visible = v; },
        render: captureFrame,
      });
    }
    return { dataUrl };
  } catch (e) {
    return { error: e.message };
  }
}
