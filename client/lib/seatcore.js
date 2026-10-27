// seatcore — the seat-profile contract (#101) as pure functions: validation, the serve-time verdict, the runtime
// gate, and the subtraction that puts a pelvis on a cushion. One copy for browser, sequencer and mcpl agent; no
// THREE, DOM, clock or fetch.
// Invariants:
//  - a profile applies ONLY behind the full gate (surface socket ∧ countersigned profile ∧ the action that actually
//    ran ∧ exact clip bytes); otherwise a DECLARED approximation, never silence;
//  - the correction subtracts along world +Y (a tilted parent normal smears bodies sideways);
//  - no minimum vertex is promoted to truth without its support patch (an isolated hem is detectable);
//  - a stale hash never reads as fresh, and an old fetch never overwrites a newer generation.

import { qApply } from "./motioneval.js";

// ---- constants (versioned by derivation.toolVersion — change them, bump it) --

export const SEAT_METHOD = "skinned-pelvis-contact-v1";
import { SEAT_CLIP_FILE } from "../../shared/clipdefs.js";
export { SEAT_CLIP_FILE };
export const CONTACT_MIN = 0.02;   // metres root-local; below this the "contact" is the root itself
export const CONTACT_MAX = 1.0;    // above this no humanoid sit pose is plausible
export const MIN_PATCH_VERTS = 8;  // fewer neighbours than this = the winner sits alone
export const MAX_PATCH_SPREAD_Y = 0.02; // a real pelvis underside clusters within 2cm
export const SCALE_UNIFORM_EPS = 1e-3;  // |sx−sy|,|sy−sz| beyond this = nonuniform, abstain

const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_NAME = /^[a-zA-Z0-9_-]{1,48}$/;   // roster-name syntax — also what keeps map keys inert
const fin = Number.isFinite;
const fin3 = (v) => Array.isArray(v) && v.length === 3 && v.every(fin);

// ---- profile schema ---------------------------------------------------------

/** Validate a seat-profile record (POST /seat-profile, profiles.json). Returns {ok:true, kind:"contact"|"unsupported"}
 *  or {ok:false, why}, the why a 4xx body naming the field. "unsupported" stores a derivation's refusal as a named reason. */
export function validateProfile(p) {
  if (!p || typeof p !== "object") return { ok: false, why: "profile must be an object" };
  // the store indexes maps by this name and a profile moves every wearer: exact roster syntax only
  if (typeof p.avatar !== "string" || !SAFE_NAME.test(p.avatar))
    return { ok: false, why: "avatar must be a roster name ([a-zA-Z0-9_-], ≤48 chars)" };
  // legal syntax that indexes inherited slots: refused here, and again by the store's null-prototype maps
  if (p.avatar === "__proto__" || p.avatar === "constructor" || p.avatar === "prototype")
    return { ok: false, why: `"${p.avatar}" is not an avatar` };
  if (typeof p.avatarSha256 !== "string" || !HEX64.test(p.avatarSha256))
    return { ok: false, why: "avatarSha256 must be 64 hex chars" };
  if (p.pose !== "sitchair") return { ok: false, why: 'this slice profiles pose "sitchair" only' };

  if (p.unsupported) {
    if (typeof p.unsupported.refusal !== "string" || !p.unsupported.refusal)
      return { ok: false, why: "unsupported record must carry its refusal string" };
    return { ok: true, kind: "unsupported" };
  }

  if (typeof p.clipSha256 !== "string" || !HEX64.test(p.clipSha256))
    return { ok: false, why: "clipSha256 must be 64 hex chars" };
  if (!fin(p.seatContactY) || p.seatContactY <= CONTACT_MIN || p.seatContactY >= CONTACT_MAX)
    return { ok: false, why: `seatContactY out of plausible range (${CONTACT_MIN}..${CONTACT_MAX})` };

  const d = p.derivation;
  if (!d || typeof d !== "object") return { ok: false, why: "derivation record required" };
  if (typeof d.toolVersion !== "string" || !d.toolVersion) return { ok: false, why: "derivation.toolVersion required" };
  if (d.method !== SEAT_METHOD) return { ok: false, why: `derivation.method must be ${SEAT_METHOD}` };
  const w = d.winner;
  if (!w || typeof w.mesh !== "string" || !w.mesh || !Number.isInteger(w.vertexIndex) || w.vertexIndex < 0 || !fin3(w.rootLocal))
    return { ok: false, why: "derivation.winner must name mesh, vertexIndex, rootLocal" };
  if (Math.abs(w.rootLocal[1] - p.seatContactY) > 1e-6)
    return { ok: false, why: "winner.rootLocal[1] disagrees with seatContactY" };
  const sp = d.supportPatch;
  if (!sp || !Number.isInteger(sp.count) || !fin(sp.spreadY) || !fin(sp.radiusXZ) || sp.radiusXZ <= 0)
    return { ok: false, why: "derivation.supportPatch must carry count, spreadY, radiusXZ" };
  // placeholder-shaped evidence is invalid: a measured patch is never empty or one zero-spread vertex
  if (sp.count < MIN_PATCH_VERTS)
    return { ok: false, why: `support patch too sparse (${sp.count} < ${MIN_PATCH_VERTS}) — winner may be a hem, accessory, or outlier` };
  if (sp.spreadY > MAX_PATCH_SPREAD_Y)
    return { ok: false, why: `support patch spread ${sp.spreadY} exceeds ${MAX_PATCH_SPREAD_Y} — surface is not a contact cluster` };
  if (!Number.isInteger(d.runs) || d.runs < 3 || d.deterministic !== true)
    return { ok: false, why: "derivation requires ≥3 runs and deterministic:true" };

  const r = p.review;
  if (!r || (r.status !== "proposed" && r.status !== "accepted"))
    return { ok: false, why: "review.status must be proposed or accepted" };
  if (r.status === "accepted" && (typeof r.receipt !== "string" || !r.receipt || typeof r.by !== "string" || !r.by))
    return { ok: false, why: "accepted requires review.receipt and review.by" };
  return { ok: true, kind: "contact" };
}

// ---- serve-time status verdict ----------------------------------------------

/** Judged against the CURRENT bytes on disk; consumers receive this verdict and never rehash.
 *  `missing` = no record at all. */
export function profileStatus(profile, currentAvatarSha256, currentClipSha256) {
  if (!profile) return { status: "missing" };
  if (profile.unsupported)
    return profile.avatarSha256 === currentAvatarSha256
      ? { status: "unsupported", refusal: profile.unsupported.refusal }
      : { status: "stale", which: "avatar" };
  if (profile.avatarSha256 !== currentAvatarSha256) return { status: "stale", which: "avatar" };
  if (profile.clipSha256 !== currentClipSha256) return { status: "stale", which: "clip" };
  if (profile.review?.status !== "accepted") return { status: "proposed" };
  return { status: "accepted", contactY: profile.seatContactY };
}

// ---- the socket's word (B1) -------------------------------------------------

/** Legacy sockets (root-at-socket) may encode a physical plane or an empirical root target; nothing infers which. Only
 *  `body.anchor: 'surface'` (shared/sockbody.js ANCHORS) consumes a profile; anything else is legacy. */
export function socketAnchor(sock) {
  // the station component (anchor top-level), or the older socket-with-a-body-block a fixture or lifted log may hand in
  return (sock?.anchor ?? sock?.body?.anchor) === "surface" ? "surface" : "legacy-root";
}

// ---- occupant scale (B5) ----------------------------------------------------

/** Root world scale × body size (occupants.js; text tier: mcpl/effective.ts). Nonuniform scale abstains, never averages. */
export function occupantScalar(scaleVec3) {
  if (scaleVec3 == null) return { ok: true, s: 1 };
  const [sx, sy, sz] = scaleVec3;
  if (!fin(sx) || !fin(sy) || !fin(sz)) return { ok: false, why: "non-finite occupant scale" };
  if (Math.abs(sx - sy) > SCALE_UNIFORM_EPS || Math.abs(sy - sz) > SCALE_UNIFORM_EPS)
    return { ok: false, why: "nonuniform occupant scale" };
  return { ok: true, s: sy };
}

// ---- the gate (B1 ∧ served verdict ∧ B3) -----------------------------------

/** The contract half of the gate (surface socket, fresh verdict, pose identity): all a consumer without a mixer can
 *  check. The browser adds its runtime half in seatGate; parity between them is pinned by test. */
export function seatGateCore({ sock, verdict, pose = "sitchair" }) {
  if (socketAnchor(sock) !== "surface") return { apply: false, reason: "legacy socket" };
  if (!verdict || verdict.status === "missing") return { apply: false, reason: "no profile" };
  // an update landed before its fresh verdict: the held value stops moving bodies NOW
  if (verdict.status === "pending") return { apply: false, reason: "profile update pending" };
  if (verdict.status === "unsupported") return { apply: false, reason: `unsupported rig: ${verdict.refusal}` };
  if (verdict.status === "stale") return { apply: false, reason: `profile stale (${verdict.which} bytes changed)` };
  if (verdict.status === "proposed") return { apply: false, reason: "profile proposed — not countersigned" };
  if (verdict.pose !== pose) return { apply: false, reason: `profile is for pose ${verdict.pose}, socket wants ${pose}` };
  if (!fin(verdict.contactY)) return { apply: false, reason: "no profile" };
  return { apply: true, contactY: verdict.contactY };
}

/** The renderer's full gate: the contract half plus mixer truths. `currentSlot` is the slot actually playing ("sit"/
 *  "idle" fallbacks never consume a chair profile); `loadedClipSha256` the action's bytes' digest (null until hydrated).
 *  Returns {apply:true, contactY} or {apply:false, reason}, the reason all three consumers declare. */
export function seatGate({ sock, verdict, pose = "sitchair", currentSlot, loadedClipSha256, currentClipSha256 }) {
  const core = seatGateCore({ sock, verdict, pose });
  if (!core.apply) return core;
  if (currentSlot !== pose) return { apply: false, reason: currentSlot ? `pose fallback: ${currentSlot}` : "clip not loaded" };
  if (!loadedClipSha256) return { apply: false, reason: "clip not loaded" };
  if (loadedClipSha256 !== currentClipSha256) return { apply: false, reason: "clip mismatch (loaded bytes differ from served clip)" };
  return core;
}

/** The roster name an avatar path implies: the key /avatars verdicts use. */
export function nameFromAvatarPath(path) {
  const m = /([^/\\]+)\.vrm/i.exec(String(path ?? ""));
  return m ? m[1] : null;
}

// ---- the correction (B2: world-up) -----------------------------------------

/** Place the profile's contact plane on the socket plane, subtracting along global +Y: mounted avatars render upright
 *  (mountTransform is yaw-only), so a tilted normal would displace the root by contactY·sin(tilt). */
export function applySeatCorrection(socketPoint, contactY, occupantScale = 1) {
  if (!fin3(socketPoint) || !fin(contactY) || !fin(occupantScale)) return null;
  return [socketPoint[0], socketPoint[1] - contactY * occupantScale, socketPoint[2]];
}

// ---- the passive instrument's seat claim -----------------------------------

/** Pure math from resolved values: pure arguments can't alias scratch registers (which once clobbered the socket's Y). */
export function seatClaim(socketWorld, parentQuat) {
  if (!fin3(socketWorld)) return null;
  const f = qApply(parentQuat, [0, 0, 1]);
  return { seatY: socketWorld[1], parentYaw: Math.atan2(f[0], f[2]) };
}

// ---- fetch generations (B3/B4: #95, generalized) ---------------------------

/** Whole-request epoch guard for async profile fetches: every bump advances a global epoch recorded per name; a request
 *  stamps its departure epoch and is refused for any name bumped since (even on an empty cache), or if it carries a rev
 *  older than the latest announced event. heldRev is monotonic. */
export function makeGenerationGuard() {
  let epoch = 0;
  const lastBump = new Map();  // name → epoch of its most recent bump
  let heldRev = -1;            // highest revision actually applied
  let floorRev = -1;           // highest revision ANNOUNCED by an event
  return {
    /** stamp for a departing request */
    begin() { return epoch; },
    bump(name, rev) {
      epoch++;
      lastBump.set(name, epoch);
      if (fin(rev)) floorRev = Math.max(floorRev, rev);
    },
    /** true = this name's slice of the response may be applied */
    accept(name, stampedEpoch, rev) {
      if ((lastBump.get(name) ?? 0) > stampedEpoch) return false;
      if (fin(rev)) {
        if (rev < heldRev || rev < floorRev) return false;
        heldRev = Math.max(heldRev, rev);
        return true;
      }
      // a response without a revision is refused once any event has announced one: it might predate it
      return floorRev < 0;
    },
    rev() { return heldRev; },
  };
}

// ---- the verdict cache: ONE implementation for every consumer ---------------

/** Shared by browser and headless agent (one copy, bun-pinned). `fetchRoster`: async
 *  () => ({ rev, entries: [{name, seat}] }), throws on failure. Contract:
 *   1. an update landing while ANY fetch is in flight (even the first) discards that name's slice of the response;
 *   2. an update demotes the held verdict to `pending` at once ("profile update pending");
 *   3. a fresh response under the new generation restores service;
 *   4. names are independent. */
export function makeVerdictCache(fetchRoster) {
  const verdicts = new Map();  // name → served verdict (or {status:"pending"})
  const guard = makeGenerationGuard();
  async function refetch() {
    const stamp = guard.begin();
    try {
      const { rev, entries } = await fetchRoster();
      for (const e of entries ?? [])
        if (guard.accept(e.name, stamp, rev)) verdicts.set(e.name, e.seat ?? { status: "missing" });
    } catch { /* held state stays as marked (pending names stay pending); the next event or init retries */ }
  }
  return {
    get(name) { return verdicts.get(name); },
    /** an update event: invalidate FIRST, then refetch — the order is the guarantee */
    note(name, rev) {
      if (name) {
        guard.bump(String(name), rev);
        if (verdicts.has(String(name))) verdicts.set(String(name), { status: "pending" });
      }
      return refetch();
    },
    init() { return refetch(); },
    rev() { return guard.rev(); },
  };
}
