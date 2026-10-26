// remotes — everyone else's bodies. Presence is lossy at ~15 Hz: each body is drawn where it was ~100 ms ago, between
// the two samples that bracket that moment, never lerped toward the newest (that stutters and teleports under loss).

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

const DEFAULT_AVATAR = 'eidoverse/assets/vrms/claude.vrm';
// ?capsule=1: every remote arrives as the capsule too, to see the floor
const loadBody = (id, path) => CONFIG.params.has('capsule') ? Promise.reject(new Error('?capsule=1: body loads refused')) : makeAvatar(id, path);
// how far behind serverNow() bodies are drawn: ≥ 110 ms, more on a slow link
import { noteLateness, interpDelay } from './interpdelay.js';
const BUF_MAX = 12;

// one clock for every realizer (serverclock.js), re-exported where net.js and the body code find it
export { noteServerTime, serverNow } from './serverclock.js';
import { serverNow } from './serverclock.js';   // a re-export binds no local name, and the frame loop needs it

/** Per-identity generation (#95): bumped by every AUTHORITATIVE (re)creation; async continuations check it, so a departed generation can
 *  neither delete nor repopulate its successor. Session-lifetime, monotonic. */
const gens = new Map();
export const remoteGen = (id) => gens.get(id) ?? 0;

/** The capsule is a floor, not a verdict: `capsuleFor` is the body still owed, paid here alone, guarded by record
 *  identity (a stale load is disposed); RETRY_MAX attempts with backoff. */
const RETRY_MAX = 3;
// mutable so a test can shrink it, or the cap is unobservable in a test window
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
    if (remotes.get(id) !== r) return;            // superseded while we waited
    try {
      const av = await loadBody(id, path);
      if (remotes.get(id) !== r) { av.dispose(); return; }   // superseded while loading
      r.avatar?.dispose();                        // the capsule steps down
      r.avatar = av;
      r.capsuleFor = null;
      r.retries = 0;
      if (r.buf.length) applyImmediate(r);
    } catch (e) {
      report(`avatar ${id} retry`, e);            // the capsule stays, the debt stands
    } finally {
      if (remotes.get(id) === r) r.retrying = false;
    }
  }, RETRY_BACKOFF_MS[Math.min(n, RETRY_BACKOFF_MS.length - 1)]);
}

export async function ensureRemote(id, avatarPath, meta = {}) {
  const existing = remotes.get(id);
  if (existing) {
    if (meta.declares !== undefined) existing.declares = meta.declares;   // declared at the door (§6a), or null
    // same person, new body: a switch while the OLD body still loads lets the stale load's guard dispose it
    // this dispose is the §19b release point: the VRM returns to the pool for a fast switch back
    if (avatarPath && existing.avatarPath !== avatarPath) {
      remotes.delete(id);
      existing.avatar?.dispose();
    } else {
      // same body re-announced = a TAKEOVER: the successor must be a FRESH record (every guard compares identity); the
      // avatar transplants, streamed state stays on the orphan (#95)
      if (meta.authority) {
        // its EXPRESSIONS do not transplant: typing, bubble, held pose, limp and gaze were the predecessor's (#97)
        existing.avatar?.resetTransients?.();
        const fresh = {
          id, avatar: existing.avatar, avatarPath: existing.avatarPath,
          loading: false, declares: meta.declares ?? existing.declares ?? null,
          gen: (gens.get(id) ?? 0) + 1,
          buf: [], lastClip: 'idle', lodAcc: 0, lodTick: 0, speakingUntil: 0,
        };
        // a capsule transplants with its debt (#196) and attempt count, or a flapping peer re-arms the shortest backoff forever
        fresh.capsuleFor = existing.capsuleFor ?? null;
        fresh.retries = existing.retries ?? 0;
        gens.set(id, fresh.gen);
        remotes.set(id, fresh);
        if (fresh.avatar && fresh.capsuleFor) retryBody(fresh);
        // the predecessor's load disposes on completion; the successor starts its OWN (cached) load
        if (!fresh.avatar) {
          fresh.loading = true;
          try {
            const av = await loadBody(id, fresh.avatarPath || DEFAULT_AVATAR).catch((e) => { report(`avatar ${id}`, e); fresh.capsuleFor = fresh.avatarPath || DEFAULT_AVATAR; return makeCapsuleAvatar(id); });   // the capsule floor
            if (remotes.get(id) !== fresh) { av.dispose(); return fresh; }
            fresh.avatar = av;
            if (fresh.buf.length) applyImmediate(fresh);
          } catch (e) { report(`avatar ${id}`, e); }
          fresh.loading = false;
        }
        return fresh;
      }
      // nothing to rebuild, but a reannounce means the peer is live: retry a capsule's debt (#196)
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
    r.avatar = await loadBody(id, avatarPath || DEFAULT_AVATAR).catch((e) => { report(`avatar ${id}`, e); r.capsuleFor = avatarPath || DEFAULT_AVATAR; return makeCapsuleAvatar(id); });   // the capsule floor
    // compare against OUR record, not the key: a replacement re-occupies the key, leaving an undisposable stale avatar
    if (remotes.get(id) !== r) { r.avatar.dispose(); return r; }
    if (r.buf.length) applyImmediate(r);
  } catch (e) { report(`avatar ${id}`, e); }
  r.loading = false;
  return r;
}

/** Idempotent; with `expected`, a predecessor's late cleanup can't delete the successor. Returns the dropped record or null (#95). */
export function dropRemote(id, expected) {
  const r = remotes.get(id);
  if (!r) return null;
  if (expected && r !== expected) return null;   // a successor owns this id now
  remotes.delete(id);
  r.avatar?.dispose();
  setBodySeat(id, null);   // or a leaver sits on forever
  return r;
}

/** `t` is the server stamp when available. */
export function pushPose(id, pose, t) {
  const r = remotes.get(id);
  if (!r || !pose) return;
  // the sender's capture time when sane, else the frame's (shared/presencewire.js sampleTime; spec/PHYSICS.md §5.1)
  const stamp = sampleTime(pose, typeof t === 'number' ? t : serverNow());
  const last = r.buf[r.buf.length - 1];
  if (last && stamp <= last.t) return;    // out of order
  r.late = noteLateness(r.late ?? null, serverNow() - stamp);
  r.buf.push({ ...pose, t: stamp });
  setBodySeat(id, pose.seat ?? null);   // a seat rides the frame while it holds
  while (r.buf.length > BUF_MAX) r.buf.shift();
  // reach/touch ride the RAW stream: a touch during the avatar's load must still be heard
  noteReachEvents(r, pose);
}

function applyImmediate(r) {
  const s = r.buf[r.buf.length - 1];
  if (!r.avatar || !s) return;
  r.avatar.root.position.set(...s.p);
  if (s.q) r.avatar.root.quaternion.fromArray(s.q).normalize();   // a swimmer's whole-body turn
  else r.avatar.root.rotation.set(0, s.yaw ?? 0, 0);
  r.avatar.locomotion = s.locomotion ?? null;
}

// per bone, per remote, per frame: nothing on this path may allocate
const _up = new THREE.Vector3(0,1,0);
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qk = new THREE.Quaternion();
/** "Mid-blend": non-null so a later release clears, never `===` a sample's pose so a held pose re-applies. */
const POSE_BLEND = {};

/** Blended a→b by the SAME k as the root, or the limbs lead the body. Change detection is pose-object identity
 *  (every sample decodes a fresh pose). */
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
  // re-plan per bracketing pair (~15 Hz), not per frame
  if (r.poseA !== pa || r.poseB !== pb) planPoseBlend(r, pa, pb);
  for (const s of r.poseSlots) {
    if (s.a) { _qa.fromArray(s.a); _qb.fromArray(s.b); _qk.slerpQuaternions(_qa, _qb, k).toArray(s.q); }
    if (s.ta) for (let i = 0; i < 3; i++) s.t[i] = s.ta[i] + (s.tb[i] - s.ta[i]) * k;
    if (s.sa) for (let i = 0; i < 3; i++) s.s[i] = s.sa[i] + (s.sb[i] - s.sa[i]) * k;
  }
  r.lastPose = POSE_BLEND;
  r.avatar.setPose(r.poseOut);
}

// ---- a tracked (VR) body's head + hands (presence `xr`, frame: xrbody.js): blended like the root, re-solved at the
// pre-vrm.update seam. No sample → hook off, the clip owns the bones.
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
    if (r.xrOn) { r.xrOn = false; if (r.xrHookAv) { r.xrHookAv.onBeforeVrmUpdate = null; resetFingers(r.xrHookAv.vrm); } r.xrHookAv = null; }   // fingers back to the clip
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

/** A bone on only one side holds that side's rotation: senders drop undriven bones, and reading the gap as identity
 *  would fling the limb. */
function planPoseBlend(r, pa, pb) {
  r.poseA = pa; r.poseB = pb;
  r.poseSlots = []; r.poseOut = {};
  // per channel (shared/humanoid.js poseChannels): rotation slerps, translation and scale lerp; a one-sided channel holds
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

/** Size and plate lift (shared/presencewire.js bodyWire), idempotent every sample, so a body swap picks it up next
 *  sample. Exported for tools/bodyscale-test.ts and tools/bodyscale-probe.mjs. */
export function applyRemoteBody(r, s) {
  applyBodyWire(r, s);
  r.avatar?.setUserScale?.(r.scale);
  r.avatar?.setPlateY?.(r.plateY);
}

/** From the NEWER sample, never blended (half a wave is not a wave); applied in BOTH paths so a late joiner gets them. */
function applyPresenceExtras(r, s) {
  applyWingFoldPresence(r.avatar, s);
  applyPresenceWire(r, s);            // for the Who panel
  applyVoiceWire(r, s);              // for the hover card
  applyRemoteBody(r, s);
  const clip = s.clip ?? 'idle';
  const once = onceAnimOf(s);
  if (once && once !== r.lastAnim) {
    r.lastAnim = once;
    r.avatar.playOnce(once);
  } else {
    // forget it, so the SAME one can fire again
    if (!once) r.lastAnim = null;
    if (clip !== r.lastClip) r.lastClip = clip;
    // 'ragdoll' is not a clip (setClip would no-op, leaving locomotion on a limp body): the streamed pose owns it
    if (clip === 'ragdoll') r.avatar.setLimp(true);
    else {
      r.avatar.setLimp(false); r.avatar.setClip(clip, s.speed ?? 0);
      // each new phase sample once: frames between packets keep advancing, not refreezing the clip
      syncClipPhase(r.avatar, s, r.clipPhaseStamp ??= {});
    }
  }
  // edge-triggered inside, so per-frame reapplication costs nothing idle
  applyRemoteReach(r, s);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

// skeletal updates tick 1×/2×/4× by distance on accumulated dt: far bodies at lower temporal resolution, not slow motion
const LOD_NEAR = 8, LOD_MID = 20;
export let lodBias = 1;                 // raised by the perf governor under load
export function setLodBias(v) { lodBias = v; }

// bodies simmed HERE (bodydrag takeover): their inbound presence is our own echo, a round trip stale; springs still tick
export const draggedLocal = new Set();

const _eye = new THREE.Vector3();
export function updateRemotes(dt, now = performance.now()) {
  const now0 = serverNow();
  // by the camera's WORLD position: in XR camera.position is the head's offset inside the rig
  const eye = camera.getWorldPosition(_eye);

  for (const r of remotes.values()) {
    if (!r.avatar) continue;
    if (draggedLocal.has(r.id)) { r.avatar.update(dt, now); continue; }
    const buf = r.buf;
    const renderAt = now0 - interpDelay(r.late ?? null);

    // a mounted body is DERIVED (parent transform + socket): presence is ignored so a stale stream can't fight the seat
    if (avatarMounts.has(r.id)) {
      const s0 = buf[buf.length - 1];
      // my own seat's driver (occupybody.js), so an occupant looks the same on every screen
      const seated = driveOccupied(r.avatar, r.id, { dt, nowMs: serverNow(), path: r.avatarPath, xr: s0?.xr ?? null });
      const sw = seated?.sw;
      if (sw) {
        r.avatar.root.position.copy(seated.pos);
        r.avatar.root.quaternion.copy(seated.q);
        r.avatar.locomotion = null;
        // seat state (#101): the ≈ marker and one console line per transition: an unprofiled seat renders, never silently
        r.avatar.setSeatApprox(sw.seatState === 'approximate');
        declareOccupyState(r.id, sw.host ?? sw.to, sw.slot, sw.seatState, sw.seatReason);
        // the seat owns position and base clip, never expressiveness: gestures and held poses still apply
        const s = buf[buf.length - 1];
        if (s) {
          applyPose(r, s, s, 1);
          applyWingFoldPresence(r.avatar, s);
          applyPresenceWire(r, s);
          applyVoiceWire(r, s);
          applyRemoteBody(r, s);
          const once = onceAnimOf(s);
          if (once && once !== r.lastAnim) {
            r.lastAnim = once;
            r.avatar.playOnce(once);
          } else if (!once) r.lastAnim = null;
          applyRemoteReach(r, s);
          applyXRPresence(r, s, s, 1);
        }
        r.avatar.setLimp(false);
        r.lastClip = seated.clip;   // the seat's pose layer owns the base clips (avatar.setSeatBlend)
        const d = r.avatar.root.position.distanceTo(eye);
        const every = Math.round((d < LOD_NEAR ? 1 : d < LOD_MID ? 2 : 4) * lodBias);
        r.lodAcc += dt;
        r.lodTick = (r.lodTick + 1) % Math.max(1, every);
        if (r.lodTick === 0) { r.avatar.update(r.lodAcc, now); r.lodAcc = 0; }
        continue;
      }
      // parent still downloading: normal presence meanwhile
    } else {
      if (r.avatar._seatState) releaseOccupied(r.avatar);
      if (r.avatar._seatApprox) {
        // the next sit declares afresh
        r.avatar.setSeatApprox(false);
        clearOccupyState(r.id);
      }
    }

    if (buf.length >= 2) {
      let i = buf.length - 1;
      while (i > 0 && buf[i - 1].t > renderAt) i--;
      const b = buf[i], a = buf[i - 1] ?? b;
      const span = b.t - a.t;
      const k = span > 0 ? THREE.MathUtils.clamp((renderAt - a.t) / span, 0, 1) : 1;

      _a.set(...a.p); _b.set(...b.p);
      r.avatar.root.position.copy(_a).lerp(_b, k);
      if (a.q || b.q) {   // slerped, so a dive tilts as smoothly as a turn
        if (a.q) _qa.fromArray(a.q).normalize(); else _qa.setFromAxisAngle(_up, a.yaw ?? 0);
        if (b.q) _qb.fromArray(b.q).normalize(); else _qb.setFromAxisAngle(_up, b.yaw ?? 0);
        r.avatar.root.quaternion.copy(_qa).slerp(_qb, k);
      } else r.avatar.root.rotation.set(0, (a.yaw ?? 0) + angleDelta(a.yaw ?? 0, b.yaw ?? a.yaw ?? 0) * k, 0);   // upright after a tilted seat
      r.avatar.locomotion = b.locomotion ?? null;
      r.avatar.pitch = (a.pitch ?? 0) + ((b.pitch ?? 0) - (a.pitch ?? 0)) * k;
      // always keep one sample behind renderAt
      while (buf.length > 2 && buf[1].t < renderAt - 400) buf.shift();
      applyPose(r, a, b, k);
      applyXRPresence(r, a, b, k);
      applyPresenceExtras(r, b);
    } else if (buf.length === 1) {
      applyImmediate(r);
      // a late joiner applies the snapshot's held bones, or a fallen body shows standing, sunk into the ground
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

/** Other bodies turn to look at the speaker. */
export function noteSpeaking(id, ms = 4000) {
  const r = remotes.get(id);
  if (r) r.speakingUntil = performance.now() + ms;
}

/** Every body looks at the latest speaker, else the nearest other body. */
let _gazeAt = 0;
export function updateGaze(myPos, myAvatar, myName, now = performance.now()) {
  // 4 Hz is past perceptual limits for gaze (the lookAt rig eases the turn; §14.1)
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

export function clearRemotes() {
  for (const r of remotes.values()) r.avatar?.dispose();
  remotes.clear();
}
