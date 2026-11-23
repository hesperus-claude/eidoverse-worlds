// restore — a rejoin's remembered sample put back on my body: net.js wireNet's onRestore, wired by main.js. Pure over
// its deps, so test/client/named-pose-test.ts runs this function rather than a copy lifted out of main.js.
import { foldedIn } from '../../../shared/wingpresence.js';
import { readBodyMode } from '../../../shared/bodymode.js';
import { standingYFromLyingRoot } from '../../../shared/presencewire.js';

/** @param deps {{ myState, setCamYaw, setPosture, setFolded, holdHeightUntilSolid }} */
export function restoreMyBody(r, { myState, setCamYaw, setPosture, setFolded, holdHeightUntilSolid }) {
  // a remembered pose can carry null (JSON has no NaN): only finite numbers are a place; anything else is the origin
  const fin = (v, fb = 0) => (Number.isFinite(v) ? v : fb);
  holdHeightUntilSolid();   // the floor it wakes on may still be downloading (arrivalhold.js)
  myState.q = r.q; myState.locomotion = r.locomotion;
  myState.pos.set(fin(r.p[0]), fin(r.p[1]), fin(r.p[2]));
  myState.yaw = r.yaw ?? 0;
  setCamYaw(myState.yaw + Math.PI); // camera behind you, facing your way
  { const m = readBodyMode(r); if (m === 'sit' || m === 'lie') setPosture(m); }   // the body-mode survives a rejoin (an older sample: read off its clip)
  // an enacted pose is authored content: wake holding it, like the spot you stood on. A remembered ragdoll
  // frame (pre-sanitizer entries) is wreckage: wake standing instead.
  // A record from before the server's sanitizer still says ragdoll: its root
  // lies below the floor the body lay on, so it wakes on that floor if the
  // record carries it, else at its root raised by how far a root lies below
  // its floor at its scale (shared/presencewire.js), not at height 0.
  // Current records arrive standing (server.ts settledPose).
  if (r.clip === 'ragdoll') { myState.pos.y = standingYFromLyingRoot(fin(r.p[1]), { floor: r.floor, scale: r.scale }); return; }
  if (r.pose) myState.pose = r.pose;
  setFolded(foldedIn(r) === true);   // the named pose wings-folded (or an older record's wingsFolded)
}
