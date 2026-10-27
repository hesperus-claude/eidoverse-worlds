// effective: where a thing actually is, a mounted entity's world transform composed at read time (#82). The fold keeps
// the pre-mount `pos` by design; this walks the mount chain like the browser's scene graph, with the renderer's own
// evaluator (client/lib/motioneval.js), and returns a finite transform or a refusal naming the first bad link,
// never a partial number. Pure: state via the caller's view, time as an argument.

import { evalWholeMotion, qMul, qApply, qAxisAngle, yawOfQuat } from "../client/lib/motioneval.js";
import { seatGateCore, applySeatCorrection } from "../client/lib/seatcore.js";

export type EffectiveView = {
  /** undefined when `id` is not a thing (a body, or unknown). */
  entity(id: string): { pos: number[]; yaw?: number; scale?: number; scale3?: number[]; q?: number[]; comp?: Record<string, any> } | undefined;
  /** thing OR body; undefined when unmounted. A body's seat is a socket entity ({to: <socket id>}); a thing's mount
   *  is its fold parent (offset/q local to it). */
  mount(id: string): { to: string; offset?: number[]; yaw?: number; q?: number[] } | undefined;
  /** #101, as /avatars serves it. Absent reads as "no profile": this module never defaults or rederives a contact. */
  seatVerdict?(id: string): { pose?: string; status: string; contactY?: number; refusal?: string; which?: string } | undefined;
  /** A seated BODY's presence `pose.scale` (clamped; absent = 1): the browser's occupantScalar input
   *  (client/lib/occupants.js: root scale × avatar.bodyScale()). Absent method reads as 1. */
  occupantScale?(id: string): number;
};

export type Effective =
  | { ok: true; pos: [number, number, number]; yaw: number;
      quat: [number, number, number, number]; scale: number;
      /** a uniform scale carries three of `scale` */
      scale3: [number, number, number];
      /** the nearest moving link's, or null when the chain stands still */
      moving: string | null;
      /** seated BODIES only (#101): whether the profile correction is in this composition, or the declared reason not */
      seat?: { state: "profiled" | "approximate"; reason?: string };
      /** a turned mount on an unequally stretched parent (anywhere up the chain) is a shear: `scale3` is its diagonal
       *  (approximate); pos and quat are exact */
      sheared?: true }
  | { ok: false; why: string; link: string };

const fin3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const fin4 = (v: unknown): v is [number, number, number, number] =>
  Array.isArray(v) && v.length === 4 && v.every(Number.isFinite);
const scale3Of = (e: { scale?: number; scale3?: number[] }, s: number): [number, number, number] =>
  fin3(e.scale3) ? [e.scale3[0], e.scale3[1], e.scale3[2]] : [s, s, s];

/** Default local offset: the parent's origin; for a body on a socket, the socket itself (client/lib/world.js
 *  mountTransform reads the socket's own frame; client/lib/realize/models.js execMount [0,0,0]). */
const DEFAULT_OFFSET: [number, number, number] = [0, 0, 0];
/** Added to a part-riding socket's refusal: the why alone left an agent to retry. */
export const PART_UNAVAILABLE = "part geometry unavailable here";
export const partHint = (why: string) => (why.includes(PART_UNAVAILABLE)
  ? "; asking again won't change that (this door can't place a model's parts), but a point near it will: face {x, z} or move {to: [x, z]} at coordinates beside it"
  : "");
const socketOf = (e: { comp?: Record<string, any> } | undefined) => {
  const s = e?.socket; return s && typeof s === "object" && !Array.isArray(s) ? s : undefined; };

export function effectiveWorldTransform(
  id: string, view: EffectiveView, nowMs: number, maxDepth = 8,
): Effective {
  return resolve(id, view, nowMs, maxDepth, new Set());
}

function resolve(id: string, view: EffectiveView, nowMs: number, depth: number, seen: Set<string>): Effective {
  if (seen.has(id)) return { ok: false, why: `mount cycle (${[...seen, id].join(" → ")})`, link: id };
  if (depth <= 0) return { ok: false, why: "mount chain deeper than supported", link: id };
  seen.add(id);

  const e = view.entity(id);
  const m = view.mount(id);

  // a socket on a model part: the browser carries it in the part's node (animated from geometry and part rest
  // transforms this side lacks), so refuse (slice one of #82). Everything on it (an occupant, cargo) inherits the refusal.
  const ownSock = socketOf(e);
  if (ownSock && typeof ownSock.part === "string")
    return { ok: false, why: `socket "${ownSock.name}" rides part "${ownSock.part}" of ${m?.to ?? "its host"} — ${PART_UNAVAILABLE}`, link: m?.to ?? id };

  // ---- mounted: the parent's frame is the truth, recursively -----------------
  // own root motion is inert while mounted, as in client/lib/motion.js tickMotion; it resumes on dismount (pinned by test)
  if (m) {
    if (!m.to || m.to === id) return { ok: false, why: "malformed mount (no parent)", link: id };
    const parent = resolve(m.to, view, nowMs, depth - 1, seen);
    if (!parent.ok) return parent;                     // the FIRST unsupported link names itself


    // local to what it rides (the browser's execMount), else the parent's origin
    const isBody = !e;
    const rawOff = m.offset ?? DEFAULT_OFFSET;
    if (!fin3(rawOff)) return { ok: false, why: "non-finite mount/socket offset", link: id };
    const rawYaw = m.yaw ?? 0;
    if (!Number.isFinite(rawYaw)) return { ok: false, why: "non-finite mount/socket yaw", link: id };
    const rawQ = Array.isArray(m.q) && m.q.length === 4 ? m.q : null;
    if (rawQ && !rawQ.every(Number.isFinite)) return { ok: false, why: "non-finite mount rotation", link: id };
    const ownScale = e?.scale ?? 1;
    if (!Number.isFinite(ownScale)) return { ok: false, why: "non-finite scale", link: id };

    // child world = parent world ∘ (scaled local offset, then local yaw); socket coords are model-frame, so the
    // parent's world scale applies (world.js runs the offset through matrixWorld for the same reason)
    const local: [number, number, number] = [rawOff[0] * parent.scale3[0], rawOff[1] * parent.scale3[1], rawOff[2] * parent.scale3[2]];
    const d = qApply(parent.quat, local);
    let pos: [number, number, number] = [parent.pos[0] + d[0], parent.pos[1] + d[1], parent.pos[2] + d[2]];
    // profile correction (#101), bodies only, along world up (a mounted body renders upright). contactY is at authored size
    // and scales by the occupant's own body size, never the parent's. No mixer here: seatGateCore is the runtime
    // truth; renderer parity is pinned by test.
    let seat: { state: "profiled" | "approximate"; reason?: string } | undefined;
    if (isBody) {
      const station = (view.entity(m.to) as any)?.station;   // what a body does at the socket
      const g = seatGateCore({ sock: station, verdict: view.seatVerdict?.(id), pose: typeof (station?.anim ?? station?.pose) === "string" ? (station.anim ?? station.pose) : "sitchair" });   // anim, else the older pose
      if (g.apply) {
        const rs = view.occupantScale?.(id) ?? 1;
        const c = applySeatCorrection(pos, g.contactY, Number.isFinite(rs) && rs > 0 ? rs : 1);
        if (c) { pos = c as [number, number, number]; seat = { state: "profiled" }; }
        else seat = { state: "approximate", reason: "non-finite correction" };
      } else seat = { state: "approximate", reason: g.reason };
    }
    // the whole relative rotation where the mount carries one (a tilted socket, cargo at an angle), else its heading
    const localQ = rawQ ?? qAxisAngle([0, 1, 0], rawYaw);
    const quat = qMul(parent.quat, localQ) as [number, number, number, number];
    const yaw = yawOfQuat(quat);
    if (!fin3(pos) || !Number.isFinite(yaw)) return { ok: false, why: "composed transform is non-finite", link: id };
    // the parent's stretch in the child's axes, S' = Rᵀ · diag(parent) · R; a shear keeps exact position and turn,
    // takes the diagonal as scale, and says `sheared` rather than refusing
    const ax = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((v) => qApply(localQ, v));
    const sp = (i: number, j: number) => ax[i][0] * ax[j][0] * parent.scale3[0] + ax[i][1] * ax[j][1] * parent.scale3[1] + ax[i][2] * ax[j][2] * parent.scale3[2];
    const big = Math.max(...parent.scale3.map(Math.abs));
    const sheared = !!e && [[0, 1], [0, 2], [1, 2]].some(([i, j]) => Math.abs(sp(i, j)) > 1e-6 * big);
    const own3 = e ? scale3Of(e, ownScale) : [1, 1, 1];
    const scale3: [number, number, number] = [sp(0, 0) * own3[0], sp(1, 1) * own3[1], sp(2, 2) * own3[2]];
    if (!fin3(scale3)) return { ok: false, why: "non-finite scale", link: id };
    return { ok: true, pos, yaw, quat, scale: parent.scale * ownScale, scale3, moving: parent.moving, ...(seat ? { seat } : {}), ...(sheared || parent.sheared ? { sheared: true } : {}) };
  }

  // ---- unmounted: the folded base, plus the thing's own whole-entity motion --
  if (!e) return { ok: false, why: "unknown id (not a thing, and not mounted)", link: id };
  if (!fin3(e.pos)) return { ok: false, why: "non-finite folded position", link: id };
  const yaw0 = e.yaw ?? 0;
  const scale = e.scale ?? 1;
  if (!Number.isFinite(yaw0) || !Number.isFinite(scale)) return { ok: false, why: "non-finite folded transform", link: id };
  const scale3 = scale3Of(e, scale);
  if (!fin3(scale3)) return { ok: false, why: "non-finite folded transform", link: id };

  const motion = e?.motion;
  if (motion && motion.type != null) {
    const pv = (e as any)?.pivot?.pos; const s3 = Array.isArray((e as any).scale3) ? (e as any).scale3 : [scale, scale, scale];
    const r = evalWholeMotion({ pos: e.pos, yaw: yaw0, ...(fin4(e.q) ? { q: e.q } : {}), ...(Array.isArray(pv) && pv.length === 3 ? { pivot: pv.map((v: number, i: number) => v * s3[i]) } : {}) }, motion, nowMs);   // the same hinge the renderer swings about
    if (!r.ok) return { ok: false, why: r.why, link: id };
    // part-carrying motion returns the base unmoved (parts swing, roots stand still): report the chain still
    const rootMoved = typeof motion.part !== "string";
    return { ok: true, pos: r.pos as [number, number, number], yaw: r.yaw,
      quat: r.quat as [number, number, number, number], scale, scale3,
      moving: rootMoved ? String(motion.type) : null };
  }

  // a live pose (a vehicle lease) or the stored q may carry a full orientation: honour either, so occupants and
  // sockets compose with the tilt. Else the heading alone.
  const leased = fin4(e.livePose?.q) ? e.livePose.q as [number, number, number, number] : null;
  const stored = fin4(e.q) ? [e.q[0], e.q[1], e.q[2], e.q[3]] as [number, number, number, number] : null;
  const q0 = leased ?? stored ?? qAxisAngle([0, 1, 0], yaw0) as [number, number, number, number];
  return { ok: true, pos: [e.pos[0], e.pos[1], e.pos[2]], yaw: leased || stored ? yawOfQuat(q0) : yaw0,
    quat: q0, scale, scale3, moving: e.livePose ? "leased" : null };
}
