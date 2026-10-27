// My identity and my body's handle: avatar path resolution, the `me` every module reads through getMe() (one owner,
// §14 6c), and the swap/update wiring. Nothing here may import main.js.

import { CONFIG, bus, report, tee } from './base.js';
import { releaseBodyGate } from './bodygate.js';
import { armFlight, folded } from './controller.js';
import { makeAvatar, contributeThumbnail } from './avatar.js';
import { setMyAvatarPath, wireAvatarSwitch } from './catalog.js';
import { toast } from './ui.js';
import { net } from './net.js';
import { loadBodyPrefs, saveBodyPrefs } from './bodyscale.js';
import { applyOwnBodyShadow } from './materials.js';
import { warmDepth, warmLit } from './warmqueue.js';

// ---------------------------------------------------------------- identity

// no boot-blocking roster fetch: a bare name resolves from the cache or the join snapshot's roster
const want = CONFIG.params.get('avatar') || localStorage.getItem('ew-avatar-name') || 'claude';
let myAvatarName = want.includes('/') ? want.split('/').pop().replace(/\.vrm.*$/, '') : want;
let myAvatarPath = want.includes('/') ? want : null;
if (!myAvatarPath) {
  try {
    const c = JSON.parse(localStorage.getItem('ew-avatar-path') ?? 'null');
    if (c?.name === want && typeof c.path === 'string') myAvatarPath = c.path;
  } catch { /* cold cache */ }
}
if (myAvatarPath) setMyAvatarPath(myAvatarPath);
export const rosterLazy = () => fetch('/avatars').then((r) => r.json()).catch(() => []);
// cold cache only: started now, never awaited, in parallel with parse and GPU init
const rosterEarly = myAvatarPath ? null : rosterLazy();
// warm boots refresh the cache too: its frozen ?v= stamp would replay a redeployed avatar forever; next reload wears it
if (myAvatarPath) {
  rosterLazy().then((list) => {
    const fresh = (list ?? []).find((a) => a.name === myAvatarName)?.path;
    if (fresh && fresh !== myAvatarPath) {
      try { localStorage.setItem('ew-avatar-path', JSON.stringify({ name: myAvatarName, path: fresh })); } catch { /* private mode */ }
      console.log(`[avatar] ${myAvatarName} was updated on the server — reload to wear the new version`);
    }
  });
}
/** The body path: cache, else whichever of (early fetch | snapshot roster) lands first. */
export async function resolveMyAvatarPath() {
  if (myAvatarPath) return myAvatarPath;
  const fromBus = new Promise((res) => {
    const off = bus.on('avatars', (l) => { off(); res(l); });
    setTimeout(() => { off(); res(null); }, 8000);   // offline: default body
  });
  const list = net.avatars ?? await Promise.race([rosterEarly, fromBus]) ?? [];
  myAvatarPath = (list ?? []).find((a) => a.name === want)?.path ?? 'eidoverse/assets/vrms/claude.vrm';
  try { localStorage.setItem('ew-avatar-path', JSON.stringify({ name: want, path: myAvatarPath })); } catch { /* private mode */ }
  setMyAvatarPath(myAvatarPath);
  return myAvatarPath;
}

/** The resolved path, or the bare name (the server resolves names for others either way). */
export function getMyAvatarPath() { return myAvatarPath ?? want; }
export function getMyAvatarName() { return myAvatarName; }
// the Avatar carries neither name nor path, so the two sites that know both announce it (main.js, the switch below)
export function announceWorn(name, path) { if (name) bus.emit('avatar-worn', { name, path: path ?? null }); }

/** `remember`: the first-run door's cache write; the bad-key re-door never persists. */
export function chooseAvatar(path, name, { remember = false } = {}) {
  myAvatarPath = path; myAvatarName = name; setMyAvatarPath(path);
  if (remember) {
    try { localStorage.setItem('ew-avatar-path', JSON.stringify({ name, path })); } catch { /* private mode */ }
  }
}

// ---------------------------------------------------------------- the handle

let me = null;
let seenFirstBody = false;
export function getMe() { return me; }
// ---------------------------------------------------------------- this body's size / plate lift
// per body name, per browser, applied on every setMe
let lsRef = null;
try { lsRef = globalThis.localStorage ?? null; } catch { lsRef = null; }
export function myBodyPrefs() { return loadBodyPrefs(lsRef, getMyAvatarName()); }
function applyMyBodyPrefs(av) {
  if (!av) return;
  const p = myBodyPrefs();
  av.setUserScale?.(p.scale);
  av.setPlateY?.(p.plateY);
  applyOwnBodyShadow(av, { warm: warmDepth, lit: warmLit, still: () => me === av }).catch((e) => report('my shadow', e));
}
bus.on('my-shadow', () => { if (me) applyMyBodyPrefs(me); });
/** { scale?, plateY? }, saved and worn at once. `name`: a write that outlived its body is saved, worn only if still on. */
export function setMyBodyPref(patch, name = getMyAvatarName()) {
  const p = saveBodyPrefs(lsRef, name, patch);
  if (name !== getMyAvatarName()) return p;
  if (me) { me.setUserScale?.(p.scale); me.setPlateY?.(p.plateY); }
  bus.emit('body-prefs', p);
  return p;
}

export function setMe(av) {
  me = av;
  applyMyBodyPrefs(av);
  if (me) {
    releaseBodyGate('body on screen');
    // ONE '[body] on screen' per page (the load metric); later calls are CHANGES, or swaps corrupt the series
    if (!seenFirstBody) { seenFirstBody = true; tee(`[body] on screen +${(performance.now() / 1000).toFixed(1)}s`); }
    else tee(`[body] changed → ${getMyAvatarName()}`);
  }
  bus.emit('avatar-worn', me ? getMyAvatarName() : null);
  if (me) me.wingsFolded = folded();
  armFlightFor(av);
}

/** Re-run on every swap, never cached: flight binds to the RIG. */
function armFlightFor(av) {
  try {
    if (!av?.vrm?.scene) return;
    const bones = [];
    av.vrm.scene.traverse((o) => { if (o.isBone && o.name) bones.push(o.name); });
    const ok = armFlight(bones, 'me');
    if (ok) toast?.('flight available on this body — press F');
  } catch { /* uninspectable: cannot fly */ }
}

// ---------------------------------------------------------------- avatar swap

wireAvatarSwitch(async (path, name) => {
  // same path is a no-op, except on the capsule: the path survives a failed load, and re-wearing is the retry (#196)
  if (path === myAvatarPath && !me?.isCapsule) return;
  toast(`changing into ${name}…`, 'info', 3000);
  try {
    // order is load-bearing (§19b): the new body is ready before the old sheds (to the pool: switching back is a hit)
    const next = await makeAvatar(CONFIG.name, path, { urgent: true });
    me?.dispose();
    // name and path FIRST: setMe announces 'avatar-worn' with the current name
    myAvatarPath = path;
    myAvatarName = name;
    announceWorn(name, path);
    setMyAvatarPath(path);
    setMe(next);
    localStorage.setItem('ew-avatar-name', name);
    contributeThumbnail(name, next.vrm, CONFIG.token, { path });
    if (net.joined) {
      // everyone rebuilds my remote with the new body
      const { sendJoin } = await import('./net.js');
      sendJoin();
    }
  } catch (e) { report(`avatar switch ${name}`, e); }
});

// `?.` is load-bearing (§14.1): on a cold cache the path is still null when this can arrive
bus.on('avatar-updated', ({ path, name, fresh }) => {
  if (myAvatarPath?.split('?')[0] === path) {
    toast(`your body "${name}" was updated — refreshing`, 'info');
    myAvatarPath = fresh;
    makeAvatar(CONFIG.name, fresh, { urgent: true }).then((av) => { me?.dispose(); setMe(av); }).catch((e) => report('reload avatar', e));
  }
});
