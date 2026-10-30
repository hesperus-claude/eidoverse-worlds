// remotes — everyone else's bodies.
//
// Presence is lossy and arrives at ~15Hz. Rendering it means answering "where
// was this body ~100ms ago, between the two samples that bracket that moment",
// not "snap to (or lerp toward) the newest thing that arrived".

import { THREE, camera, scene } from './core.js';
import { report, angleDelta, CONFIG } from './base.js';
import { makeAvatar, makeCapsuleAvatar } from './avatar.js';
import { onceAnimOf } from '../../shared/onceanim.js';
import { avatarMounts, setBodySeat } from './world.js';
import { driveOccupied, releaseOccupied } from './occupybody.js';
import { declareOccupyState, clearOccupyState } from './occupants.js';
import { applyRemoteReach, noteReachEvents } from './reachnet.js';
import { syncClipPhase } from './poseclips.js';
import { applyWingFoldPresence } from '../../shared/wingpresence.js';
import { poseChannels } from '../../shared/humanoid.js';
import { applyPresenceWire, applyVoiceWire, applyBodyWire, sampleTime } from '../../shared/presencewire.js';
import { applyRemoteXR, resetFingers } from './xrbody.js';

export const remotes = new Map(); // id -> RemoteBody

// ?capsule=1: every remote arrives as the capsule too — the flag is about seeing the floor, not one body
const loadBody = (id, path) => CONFIG.params.has('capsule') ? Promise.reject(new Error('?capsule=1: body loads refused')) : makeAvatar(id, path);
// How far behind serverNow() each body is drawn: at least 110 ms, more on a slow link (interpdelay.js; I46).
import { noteLateness, interpDelay } from './interpdelay.js';
const BUF_MAX = 12;

// Server-to-local clock offset, smoothed: client/lib/serverclock.js (one clock for every realizer). Re-exported here,
// where net.js and the body code have always found it.
export { noteServerTime, serverNow } from './serverclock.js';
import { serverNow } from './serverclock.js';   // a re-export binds no local name: this module's own frame loop needs it too
import { climbAt } from './climb.js';
import { DEFAULT_BODY } from '../../shared/avatardefs.js';

/** Per-identity generation counter: every AUTHORITATIVE (re)creation of an id
 *  bumps it, and async continuations validate record identity before touching
 *  the scene, so a departed generation can neither delete nor repopulate its
 *  successor. Session-lifetime, monotonic. */
const gens = new Map();

/** The capsule is a FLOOR, not a verdict (tools/capsule-recovery-test.mjs): a
 *  body that failed to load once must be retryable. A record wearing the
 *  capsule carries `capsuleFor` = the path it still owes; this is the ONE owner
 *  that pays that debt. Guarded by RECORD IDENTITY (the record we started on
 *  must still be in the map, or the loaded body is disposed) and bounded by
 *  RETRY_MAX attempts with backoff. */
const RETRY_MAX = 3;
// Mutable so a test can shrink it: with the shipped delays the cap is unobservable inside a test window (the
// `retrying` latch never clears in time).
let RETRY_BACKOFF_MS = [400, 1600, 5000];
export function __setRetryBackoffForTest(ms) { RETRY_BACKOFF_MS = ms; }
function retryBody(r) {
  if (!r?.capsuleFor || r.retrying) return;
  const id = r.id, path = r.capsuleFor;
  const n = r.retries ?? 0;
  if (n >= RETRY_MAX) return;
  r.retrying = true;
  r.retries = n + 1;
  setTimeout(async () => {
    if (remotes.get(id) !== r) return;            // superseded while we waited: not ours to pay
    try {
      const av = await loadBody(id, path);
      if (remotes.get(id) !== r) { av.dispose(); return; }   // superseded while loading
      r.avatar?.dispose();                        // the capsule steps down
      r.avatar = av;
      r.capsuleFor = null;
      r.retries = 0;
      if (r.buf.length) applyImmediate(r);
    } catch (e) {
      report(`avatar ${id} retry`, e);            // still down; the capsule stays, the debt stands
    } finally {
      if (remotes.get(id) === r) r.retrying = false;
    }
  }, RETRY_BACKOFF_MS[Math.min(n, RETRY_BACKOFF_MS.length - 1)]);
}

export async function ensureRemote(id, avatarPath, meta = {}) {
  const existing = remotes.get(id);
  if (existing) {
    if (meta.declares !== undefined) existing.declares = meta.declares;   // the word they declared at the door (§6a), or null
    // same person, new body: rebuild. A switch landing while the OLD body is
    // still loading deletes the entry and lets the stale load's guard dispose
    // it. This dispose is the §19b release point: the VRM returns to the
    // instance pool intact, so a switch back skips the re-parse.
    if (avatarPath && existing.avatarPath !== avatarPath) {
      remotes.delete(id);
      existing.avatar?.dispose();
    } else {
      // Same body re-announced = a TAKEOVER (the server re-arrives the identity).
      // The successor must be a FRESH RECORD OBJECT: every continuation guard
      // here compares record identity. The loaded avatar transplants (no
      // flicker); streamed state (the pose buffer) stays on the orphaned record.
      if (meta.authority) {
        // the mesh transplants; its EXPRESSIONS (typing, bubble, held pose,
        // limp, gaze) were the predecessor's and do not
        existing.avatar?.resetTransients?.();
        const fresh = {
          id, avatar: existing.avatar, avatarPath: existing.avatarPath,
          loading: false, declares: meta.declares ?? existing.declares ?? null,
          gen: (gens.get(id) ?? 0) + 1,
          buf: [], lastClip: 'idle', lodAcc: 0, lodTick: 0, speakingUntil: 0,
        };
        // a capsule transplants as the floor, and its debt with it (takeover is
        // a natural moment to retry). The ATTEMPT COUNT transplants too, or a
        // flapping peer with a dead asset re-arms at the shortest backoff every
        // reconnect and never reaches the cap.
        fresh.capsuleFor = existing.capsuleFor ?? null;
        fresh.retries = existing.retries ?? 0;
        gens.set(id, fresh.gen);
        remotes.set(id, fresh);
        if (fresh.avatar && fresh.capsuleFor) retryBody(fresh);
        // predecessor still mid-load: its completion sees a record that isn't
        // its own and disposes; the successor starts its OWN (cached) load
        if (!fresh.avatar) {
          fresh.loading = true;
          try {
            const av = await loadBody(id, fresh.avatarPath || DEFAULT_BODY).catch((e) => { report(`avatar ${id}`, e); fresh.capsuleFor = fresh.avatarPath || DEFAULT_BODY; return makeCapsuleAvatar(id); });   // the capsule floor
            if (remotes.get(id) !== fresh) { av.dispose(); return fresh; }
            fresh.avatar = av;
            if (fresh.buf.length) applyImmediate(fresh);
          } catch (e) { report(`avatar ${id}`, e); }
          fresh.loading = false;
        }
        return fresh;
      }
      // Same body re-announced with no authority change: nothing to rebuild,
      // but a capsule still owes a body, and a reannounce says the peer is live.
      if (existing.capsuleFor) retryBody(existing);
      return existing;
    }
  }
  const r = {
    id, avatar: null, avatarPath, loading: true, declares: meta.declares ?? null,
    gen: (gens.get(id) ?? 0) + 1,
    buf: [],                 // [{ t, p:[x,y,z], yaw, speed, clip, pitch }]
    lastClip: 'idle',
    lodAcc: 0, lodTick: 0,
    speakingUntil: 0,
  };
  gens.set(id, r.gen);
  remotes.set(id, r);
  try {
    r.avatar = await loadBody(id, avatarPath || DEFAULT_BODY).catch((e) => { report(`avatar ${id}`, e); r.capsuleFor = avatarPath || DEFAULT_BODY; return makeCapsuleAvatar(id); });   // the capsule floor
    // Stale-load guard: they left OR switched bodies while this loaded.
    // Compare against OUR record, not key presence (a replacement re-occupies
    // the key, and the old avatar would load in as an undisposable ghost).
    if (remotes.get(id) !== r) { r.avatar.dispose(); return r; }
    if (r.buf.length) applyImmediate(r);
  } catch (e) { report(`avatar ${id}`, e); }
  r.loading = false;
  return r;
}

/** Remove a body. Idempotent, and GENERATION-CONDITIONAL when handed the
 *  record the caller believes it is dropping, so a predecessor's late cleanup
 *  cannot delete the successor. Returns the dropped record, or null. */
export function dropRemote(id, expected) {
  const r = remotes.get(id);
  if (!r) return null;
  if (expected && r !== expected) return null;   // a successor owns this id now
  remotes.delete(id);
  r.avatar?.dispose();
  setBodySeat(id, null);   // its seat rode its frames (presence): gone with the body, or a leave sits on forever (I15)
  return r;
}

/** Feed one presence sample. `t` is the server stamp when available. */
export function pushPose(id, pose, t) {
  const r = remotes.get(id);
  if (!r || !pose) return;
  // its own capture time when the sender stamped one and it's sane against the frame's (shared/presencewire.js sampleTime;
  // spec/PHYSICS.md §5.1), else the frame's
  const stamp = sampleTime(pose, typeof t === 'number' ? t : serverNow());
  const last = r.buf[r.buf.length - 1];
  if (last && stamp <= last.t) return;    // out of order — drop
  r.late = noteLateness(r.late ?? null, serverNow() - stamp);
  r.buf.push({ ...pose, t: stamp });
  setBodySeat(id, pose.seat ?? null);   // a seat rides the frame while it holds (presence; world.js)
  while (r.buf.length > BUF_MAX) r.buf.shift();
  // reach/touch events ride the RAW stream, not the applied one — a touch
  // that begins while this body's avatar is still loading must be heard
  noteReachEvents(r, pose);
}

function applyImmediate(r) {
  const s = r.buf[r.buf.length - 1];
  if (!r.avatar || !s) return;
  r.avatar.root.position.set(...s.p);
  if (s.q) r.avatar.root.quaternion.fromArray(s.q).normalize();   // a swimmer's whole-body turn (presence q)
  else r.avatar.root.rotation.set(0, s.yaw ?? 0, 0);
  r.avatar.locomotion = s.locomotion ?? null;
}

// Bone blending scratch. This runs per bone, per remote, per frame — nothing
// on that path may allocate.
const _up = new THREE.Vector3(0,1,0);
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qk = new THREE.Quaternion();
/** Marks "the bones are mid-blend": non-null so a later release still clears,
 *  and never `===` a sample's pose so a held pose always re-applies. */
const POSE_BLEND = {};

/** The held pose (bones), blended a→b by the SAME k as the root, so the limbs
 *  don't lead the body (or step at the send rate). Change detection is
 *  pose-object identity: every sample carries a freshly decoded pose. */
function applyPose(r, a, b, k) {
  const pa = a.pose, pb = b.pose;
  if (!pb) {                            // nobody is posed, or just released
    if (r.lastPose != null) { r.lastPose = null; r.avatar.clearPose(); }
    return;
  }
  if (!pa || pa === pb) {               // fading in, or the single-sample hold
    if (r.lastPose !== pb) { r.lastPose = pb; r.avatar.setPose(pb); }
    return;
  }
  // Re-plan per bracketing pair (~15Hz), not per frame: the merged bone list
  // and its output arrays outlive every frame of the span.
  if (r.poseA !== pa || r.poseB !== pb) planPoseBlend(r, pa, pb);
  for (const s of r.poseSlots) {
    if (s.a) { _qa.fromArray(s.a); _qb.fromArray(s.b); _qk.slerpQuaternions(_qa, _qb, k).toArray(s.q); }
    if (s.ta) for (let i = 0; i < 3; i++) s.t[i] = s.ta[i] + (s.tb[i] - s.ta[i]) * k;
    if (s.sa) for (let i = 0; i < 3; i++) s.s[i] = s.sa[i] + (s.sb[i] - s.sa[i]) * k;
  }
  r.lastPose = POSE_BLEND;
  r.avatar.setPose(r.poseOut);
}

// ---- C18: a tracked (VR) body's head + hands. The sample rides presence as `xr`
// (xrbody.js has the frame), blended a→b like the root and re-solved in the
// avatar's pre-vrm.update seam. No sample → hook off, the clip owns the bones.
const _xq1 = new THREE.Quaternion(), _xq2 = new THREE.Quaternion(), _xv1 = new THREE.Vector3(), _xv2 = new THREE.Vector3();
const blendQ = (qa, qb, k) => { _xq1.fromArray(qa); _xq2.fromArray(qb); return _xq1.slerp(_xq2, k).toArray(); };
const blendGrip = (ga, gb, k) => {
  if (!ga || !gb) return gb || ga;
  _xv1.fromArray(ga); _xv2.fromArray(gb); _xv1.lerp(_xv2, k);
  return [..._xv1.toArray(), ...blendQ(ga.slice(3), gb.slice(3), k)];
};
function blendXR(xa, xb, k) {
  if (!xa || xa === xb || k >= 1) return xb;
  const o = { h: blendQ(xa.h, xb.h, k), c: xb.c && xa.c ? xb.c.map((v, i) => xa.c[i] + (v - xa.c[i]) * k) : xb.c };
  const l = blendGrip(xa.l, xb.l, k), r = blendGrip(xa.r, xb.r, k);
  if (l) o.l = l; if (r) o.r = r;
  return o;
}
function applyXRPresence(r, a, b, k) {
  const xb = b?.xr;
  if (!xb) {
    if (r.xrOn) { r.xrOn = false; if (r.xrHookAv) { r.xrHookAv.onBeforeVrmUpdate = null; resetFingers(r.xrHookAv.vrm); } r.xrHookAv = null; }   // their last sample was a trigger pull: fingers back to the clip
    return;
  }
  r.xrOn = true;
  r.xrSample = blendXR(a?.xr, xb, k);
  if (r.xrHookAv !== r.avatar || r.avatar.onBeforeVrmUpdate !== r.xrHook) {   // fresh avatar (swap) or first sample
    r.xrState = r.xrState || { look: new THREE.Vector3() };
    r.xrHook = (dt) => applyRemoteXR(r.avatar, r.xrSample, r.xrState, dt);
    r.xrHookAv = r.avatar; r.avatar.onBeforeVrmUpdate = r.xrHook;
  }
}

/** Merged bone list for one pair, with the output arrays setPose will read.
 *  A bone named on only one side holds that side's rotation instead of
 *  blending toward rest — senders drop bones they aren't driving, and reading
 *  the gap as identity would fling the limb. */
function planPoseBlend(r, pa, pb) {
  r.poseA = pa; r.poseB = pb;
  r.poseSlots = []; r.poseOut = {};
  // Per channel (shared/humanoid.js poseChannels): rotation slerps, translation
  // and scale lerp; a channel only one side has is held, not blended from nothing.
  for (const n of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
    const ca = poseChannels(pa[n]), cb = poseChannels(pb[n]);
    if (!ca && !cb) continue;
    const pick = (ch) => { const x = ca?.[ch] ?? cb?.[ch], y = cb?.[ch] ?? ca?.[ch]; return x ? [x, y] : [null, null]; };
    const [qa, qb] = pick('q'), [ta, tb] = pick('t'), [sa, sb] = pick('s');
    const slot = { a: qa, b: qb, q: qa && [0, 0, 0, 1], ta, tb, t: ta && [0, 0, 0], sa, sb, s: sa && [1, 1, 1] };
    r.poseSlots.push(slot);
    r.poseOut[n] = !ta && !sa ? slot.q : { ...(qa ? { q: slot.q } : {}), ...(ta ? { t: slot.t } : {}), ...(sa ? { s: slot.s } : {}) };
  }
}

/** A remote's chosen size and plate lift (shared/presencewire.js bodyWire: clamped, absence = default). Written onto
 *  the record every sample and onto the Avatar — idempotent, and a body swap (a fresh Avatar at 1) picks it up on the
 *  very next sample. Exported for tools/bodyscale-test.ts (a stand-in avatar). */
export function applyRemoteBody(r, s) {
  applyBodyWire(r, s);
  r.avatar?.setUserScale?.(r.scale);
  r.avatar?.setPlateY?.(r.plateY);
}

/** Presence extras that aren't position or bones (once anim, locomotion clip):
 *  driven by the NEWER sample and never blended — half a wave is not a wave.
 *  Applied in BOTH the interpolated and single-sample paths. */
function applyPresenceExtras(r, s) {
  applyWingFoldPresence(r.avatar, s);
  applyPresenceWire(r, s);            // present / away / busy, for the Who panel
  applyVoiceWire(r, s);              // mic / hear, for the hover card
  applyRemoteBody(r, s);             // their chosen size / plate lift (absence = default)
  const clip = s.clip ?? 'idle';
  const once = onceAnimOf(s);
  if (once && once !== r.lastAnim) {
    r.lastAnim = once;
    r.avatar.playOnce(once);
  } else {
    // the once anim has passed: forget it, so the SAME one can fire again
    if (!once) r.lastAnim = null;
    if (clip !== r.lastClip) r.lastClip = clip;
    // 'ragdoll' is not a clip (setClip would no-op and the locomotion clip
    // would keep animating a limp body): the streamed pose owns the bones while down.
    if (clip === 'ragdoll') r.avatar.setLimp(true);
    else {
      r.avatar.setLimp(false); r.avatar.setClip(clip, s.speed ?? 0);
      // Apply each new owner's phase sample once; interpolation frames between
      // packets must keep advancing rather than repeatedly freezing the clip.
      syncClipPhase(r.avatar, s, r.clipPhaseStamp ??= {});
    }
  }
  // reach descriptors ride the same newest sample; the diff inside is
  // edge-triggered, so per-frame reapplication costs nothing when idle
  applyRemoteReach(r, s);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

// Camera-aware animation LOD: a full stage (24 bodies) can't run 24 complete
// VRM updates per frame. Position interpolation stays per-frame; skeletal
// updates tick at 1×/2×/4× by distance with accumulated dt, so a far avatar
// animates at lower temporal resolution, not in slow motion.
const LOD_NEAR = 8, LOD_MID = 20;
export let lodBias = 1;                 // raised by the perf governor under load
export function setLodBias(v) { lodBias = v; }

// Bodies whose sim runs on THIS machine right now (bodydrag takeover): their
// inbound presence is our own stream echoed back, so the local sim owns root
// and bones; springs/expressions still tick.
export const draggedLocal = new Set();

const _eye = new THREE.Vector3();
export function updateRemotes(dt, now = performance.now()) {
  const now0 = serverNow();
  // animation LOD by distance from the camera's WORLD position (in XR camera.position is the head's offset inside the rig)
  const eye = camera.getWorldPosition(_eye);

  for (const r of remotes.values()) {
    if (!r.avatar) continue;
    if (draggedLocal.has(r.id)) { r.avatar.update(dt, now); continue; }
    const buf = r.buf;
    const renderAt = now0 - interpDelay(r.late ?? null);

    // A mounted body is DERIVED, not streamed: the parent entity's live
    // transform (ticked by motion.js this frame) composed with the socket, so an
    // occupant rides the swing; presence samples are ignored while mounted.
    if (avatarMounts.has(r.id)) {
      const s0 = buf[buf.length - 1];
      // the same driver my own seat runs (occupybody.js): socket, anchor, signals, pose, reach, look — so an occupant looks
      // the same on every screen
      const seated = driveOccupied(r.avatar, r.id, { dt, nowMs: serverNow(), path: r.avatarPath, xr: s0?.xr ?? null });
      const sw = seated?.sw;
      if (sw) {
        r.avatar.root.position.copy(seated.pos);
        r.avatar.root.quaternion.copy(seated.q);   // the socket's whole rotation
        r.avatar.locomotion = null;
        // Declared seat state (#101): the ≈ marker and one console line per transition.
        r.avatar.setSeatApprox(sw.seatState === 'approximate');
        declareOccupyState(r.id, sw.host ?? sw.to, sw.slot, sw.seatState, sw.seatReason);
        // The seat owns WHERE the body is and its base clip, never its
        // expressiveness: the newest sample still delivers gestures (layered
        // over the sit) and held bone poses. `animate` streams never pass here.
        const s = buf[buf.length - 1];
        if (s) {
          applyPose(r, s, s, 1);
          // The seat owns root/clip, not semantic anatomy (a seated vigil still folds).
          applyWingFoldPresence(r.avatar, s);
          applyPresenceWire(r, s);
          applyVoiceWire(r, s);
          applyRemoteBody(r, s);
          const once = onceAnimOf(s);
          if (once && once !== r.lastAnim) {
            r.lastAnim = once;
            r.avatar.playOnce(once);
          } else if (!once) r.lastAnim = null;
          applyRemoteReach(r, s);   // a seated body still puts a hand out
          applyXRPresence(r, s, s, 1);   // …and still looks around / points
        }
        r.avatar.setLimp(false);
        r.lastClip = seated.clip;   // the seat's pose layer owns the base clips (avatar.setSeatBlend); gestures still play over it
        const d = r.avatar.root.position.distanceTo(eye);
        const every = Math.round((d < LOD_NEAR ? 1 : d < LOD_MID ? 2 : 4) * lodBias);
        r.lodAcc += dt;
        r.lodTick = (r.lodTick + 1) % Math.max(1, every);
        if (r.lodTick === 0) { r.avatar.update(r.lodAcc, now); r.lodAcc = 0; }
        continue;
      }
      // parent still downloading — fall through to normal presence meanwhile
    } else {
      if (r.avatar._seatState) releaseOccupied(r.avatar);   // stood up: the seat lets go of the body
      if (r.avatar._seatApprox) {
        // stood up: the marker comes off and the next sit declares afresh
        r.avatar.setSeatApprox(false);
        clearOccupyState(r.id);
      }
    }

    if (buf.length >= 2) {
      // find the pair bracketing renderAt
      let i = buf.length - 1;
      while (i > 0 && buf[i - 1].t > renderAt) i--;
      const b = buf[i], a = buf[i - 1] ?? b;
      const span = b.t - a.t;
      const limpEdge = (a.clip === 'ragdoll') !== (b.clip === 'ragdoll');
      const k = span > 0 && !limpEdge ? THREE.MathUtils.clamp((renderAt - a.t) / span, 0, 1) : 1;

      _a.set(...a.p); _b.set(...b.p);
      r.avatar.root.position.copy(_a).lerp(_b, k);
      if (a.q || b.q) {   // a swimmer's whole-body turn (presence q): slerped, so a dive tilts as smoothly as a turn
        if (a.q) _qa.fromArray(a.q).normalize(); else _qa.setFromAxisAngle(_up, a.yaw ?? 0);
        if (b.q) _qb.fromArray(b.q).normalize(); else _qb.setFromAxisAngle(_up, b.yaw ?? 0);
        r.avatar.root.quaternion.copy(_qa).slerp(_qb, k);
      } else r.avatar.root.rotation.set(0, (a.yaw ?? 0) + angleDelta(a.yaw ?? 0, b.yaw ?? a.yaw ?? 0) * k, 0);   // upright (a dismount from a tilted seat)
      // on a climb route: {host, progress} through the host's live pose, so a moving carrier never leaves its climber (shared/climb.js)
      if (b.climb) { const c = climbAt(a.climb?.host === b.climb.host ? { host: b.climb.host, progress: a.climb.progress + (b.climb.progress - a.climb.progress) * k } : b.climb);
        if (c) { r.avatar.root.position.fromArray(c.pos); r.avatar.root.rotation.set(0, c.yaw, 0); } }
      r.avatar.locomotion = b.locomotion ?? null;
      r.avatar.pitch = (a.pitch ?? 0) + ((b.pitch ?? 0) - (a.pitch ?? 0)) * k;
      // drop samples we've moved past, but always keep one behind renderAt
      while (buf.length > 2 && buf[1].t < renderAt - 400) buf.shift();
      applyPose(r, limpEdge ? b : a, b, k);
      applyXRPresence(r, a, b, k);
      applyPresenceExtras(r, b);
    } else if (buf.length === 1) {
      applyImmediate(r);
      // A late joiner with only the snapshot's single pose must still apply its
      // held bones, or a body that fell before you arrived stands sunk in the ground.
      applyPose(r, buf[0], buf[0], 1);
      applyXRPresence(r, buf[0], buf[0], 1);
      applyPresenceExtras(r, buf[0]);
    }

    const d = r.avatar.root.position.distanceTo(eye);
    const every = Math.round((d < LOD_NEAR ? 1 : d < LOD_MID ? 2 : 4) * lodBias);
    r.lodAcc += dt;
    r.lodTick = (r.lodTick + 1) % Math.max(1, every);
    if (r.lodTick === 0) { r.avatar.update(r.lodAcc, now); r.lodAcc = 0; }
  }
}

/** Mark someone as currently speaking, so other bodies turn to look at them. */
export function noteSpeaking(id, ms = 4000) {
  const r = remotes.get(id);
  if (r) r.speakingUntil = performance.now() + ms;
}

/** Point every body at whatever deserves attention: the most recent speaker if
 *  there is one, otherwise the nearest other body (the VRM lookAt rig). */
let _gazeAt = 0;
export function updateGaze(myPos, myAvatar, myName, now = performance.now()) {
  // Attention changes at conversational rate: 4Hz (§14.1); the VRM lookAt rig
  // eases the turn itself.
  if (now - _gazeAt < 250) return;
  _gazeAt = now;
  let speaker = null;
  for (const r of remotes.values()) {
    if (r.speakingUntil > now && r.avatar) {
      if (!speaker || r.speakingUntil > speaker.speakingUntil) speaker = r;
    }
  }

  const focusOf = (self) => {
    if (speaker && speaker !== self) {
      return _a.copy(speaker.avatar.root.position).setY(speaker.avatar.root.position.y + 1.5);
    }
    // nearest other body, including me
    let best = null, bestD = 9;
    const from = self ? self.avatar.root.position : myPos;
    if (self && myPos) {
      const d = from.distanceTo(myPos);
      if (d < bestD) { bestD = d; best = _a.copy(myPos).setY(myPos.y + 1.5); }
    }
    for (const o of remotes.values()) {
      if (o === self || !o.avatar) continue;
      const d = from.distanceTo(o.avatar.root.position);
      if (d < bestD) { bestD = d; best = _a.copy(o.avatar.root.position).setY(o.avatar.root.position.y + 1.5); }
    }
    return best;
  };

  for (const r of remotes.values()) {
    if (!r.avatar) continue;
    r.avatar.setGazeTarget(focusOf(r));
  }
  if (myAvatar) {
    const f = speaker ? _b.copy(speaker.avatar.root.position).setY(speaker.avatar.root.position.y + 1.5) : null;
    myAvatar.setGazeTarget(f);
  }
}
