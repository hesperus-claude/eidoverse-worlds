// My identity and my body's handle — the avatar path resolution, the `me`
// avatar every module reads through getMe(), and the swap/update wiring that
// replaces it. Extracted from main.js (§14 6c): `me` was closed over by ~18
// sites; now there is one owner and everyone else holds the getter. Nothing
// here may import main.js.

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

// No boot-blocking roster fetch: a bare name resolves from the cached last resolution or the join snapshot's roster.
// UI that wants the full roster (first-run door, avatar panel) fetches it lazily at open.
const want = CONFIG.params.get('avatar') || localStorage.getItem('ew-avatar-name') || 'claude';
let myAvatarName = want.includes('/') ? want.split('/').pop().replace(/\.vrm.*$/, '') : want;
let myAvatarPath = want.includes('/') ? want : null;
if (!myAvatarPath) {
  try {
    const c = JSON.parse(localStorage.getItem('ew-avatar-path') ?? 'null');
    if (c?.name === want && typeof c.path === 'string') myAvatarPath = c.path;
  } catch { /* cold cache — the snapshot roster resolves it */ }
}
if (myAvatarPath) setMyAvatarPath(myAvatarPath);
export const rosterLazy = () => fetch('/avatars').then((r) => r.json()).catch(() => []);
// Cold cache only: start the roster fetch now and never await it, so it rides in parallel with parse and GPU init.
const rosterEarly = myAvatarPath ? null : rosterLazy();
// Warm boots still refresh the stored resolution: the cached path carries a frozen ?v= stamp, so a redeployed avatar
// would replay from HTTP cache forever. The cached path wins this boot; the next reload wears the new version.
if (myAvatarPath) {
  rosterLazy().then((list) => {
    const fresh = (list ?? []).find((a) => a.name === myAvatarName)?.path;
    if (fresh && fresh !== myAvatarPath) {
      try { localStorage.setItem('ew-avatar-path', JSON.stringify({ name: myAvatarName, path: fresh })); } catch { /* private mode */ }
      console.log(`[avatar] ${myAvatarName} was updated on the server — reload to wear the new version`);
    }
  });
}
/** The body path: cache, else whichever of (early fetch | snapshot roster)
 *  lands first. Nothing here ever blocked the module graph. */
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

/** What the wire announces as my body: the resolved path, or the bare name —
 *  the server resolves names for everyone else's view either way. */
export function getMyAvatarPath() { return myAvatarPath ?? want; }
export function getMyAvatarName() { return myAvatarName; }
// the bodies panel (bodies.js) lists what you have worn; the Avatar object itself carries neither name nor path,
// so the two sites that know both announce it: the initial body (main.js) and a switch (wireAvatarSwitch below)
export function announceWorn(name, path) { if (name) bus.emit('avatar-worn', { name, path: path ?? null }); }

/** The door (and the bad-key re-door) hands a choice here. `remember` is the
 *  first-run door's cache write; the bad-key path never persisted, and still
 *  doesn't. */
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
// Per body name, per browser (bodyscale.js: ew-body-prefs), applied on every setMe; net.js sendPose reads it off the Avatar.
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
/** Profile › Avatar writes here: { scale?, plateY? } for the body you have on, saved and worn at once. `name` is for a
 *  write that outlived its body (bodies.js's rest-timer save after a switch): saved under it, worn only if still on. */
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
    // ONE '[body] on screen' per page — it is the load metric. Later setMe calls
    // are body CHANGES (09-05: three swaps in the avatars tab read as +291 s
    // 'loads' on the tee and corrupted the series).
    if (!seenFirstBody) { seenFirstBody = true; tee(`[body] on screen +${(performance.now() / 1000).toFixed(1)}s`); }
    else tee(`[body] changed → ${getMyAvatarName()}`);
  }
  bus.emit('avatar-worn', me ? getMyAvatarName() : null);
  if (me) me.wingsFolded = folded();
  armFlightFor(av);
}

/** Arm (or disarm) human flight for whatever body this is now.
 *
 *  Re-run on every swap, never cached: the capability binds to the RIG, so
 *  putting on a winged body grants it and putting on a commons one takes it
 *  away. That is the same action-time rule the agent side follows, and the
 *  reason it is a function rather than a flag set once at boot. */
function armFlightFor(av) {
  try {
    if (!av?.vrm?.scene) return;
    const bones = [];
    av.vrm.scene.traverse((o) => { if (o.isBone && o.name) bones.push(o.name); });
    const ok = armFlight(bones, 'me');
    if (ok) toast?.('flight available on this body — press F');
  } catch { /* a body that cannot be inspected simply cannot fly */ }
}

// ---------------------------------------------------------------- avatar swap

wireAvatarSwitch(async (path, name) => {
  // Same path is a no-op, except on the capsule: myAvatarPath survives a failed load, and re-wearing is the retry (#196).
  if (path === myAvatarPath && !me?.isCapsule) return;
  toast(`changing into ${name}…`, 'info', 3000);
  try {
    // Switch order is load-bearing (§19b): the new body is fully ready before the old one sheds; dispose() returns its
    // VRM to the pool, so switching back is a pool-hit.
    const next = await makeAvatar(CONFIG.name, path, { urgent: true }); // build before shedding the old
    me?.dispose();
    // name and path FIRST: setMe announces 'avatar-worn' with the current name,
    // and My Avatars / the profile read it — set after, they heard the old body
    myAvatarPath = path;
    myAvatarName = name;
    announceWorn(name, path);
    setMyAvatarPath(path);
    setMe(next);
    localStorage.setItem('ew-avatar-name', name);
    contributeThumbnail(name, next.vrm, CONFIG.token, { path });
    if (net.joined) {
      // re-announce: everyone rebuilds my remote with the new body
      const { sendJoin } = await import('./net.js');
      sendJoin();
    }
  } catch (e) { report(`avatar switch ${name}`, e); }
});

// The `?.` on myAvatarPath is load-bearing (§14.1 found bug): on a cold cache
// the path is still null when an avatar-updated event can already arrive —
// the old handler threw before resolve had run.
bus.on('avatar-updated', ({ path, name, fresh }) => {
  if (myAvatarPath?.split('?')[0] === path) {
    toast(`your body "${name}" was updated — refreshing`, 'info');
    myAvatarPath = fresh;
    makeAvatar(CONFIG.name, fresh, { urgent: true }).then((av) => { me?.dispose(); setMe(av); }).catch((e) => report('reload avatar', e));
  }
});
