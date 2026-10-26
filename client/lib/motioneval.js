// motioneval — whole-entity motion as pure math, shared by motion.js (render) and mcpl/agent.ts (perception) so both
// agree where a thing is (#82). No THREE, DOM, scene or clock: callers pass {base, motion, nowMs}.
// A finite transform or an explicit refusal, never a partial number: a printed coordinate claims to be truth.
// Part-frame motion leaves the root unmoved; it stays in motion.js.
import { motionType } from '../../shared/protocol/names.js';
import { qMul, qRotate as qApply, qAxisAngle as qAxisAngleUnit } from '../../shared/rot.js';

// ---- quaternions: [x, y, z, w] as THREE lays them out; right-handed, Y-up, radians

/** `axis` need not be unit length. */
export const qAxisAngle = (axis, angle) => {
  const [x, y, z] = axis;
  const n = Math.hypot(x, y, z) || 1;
  return qAxisAngleUnit([x / n, y / n, z / n], angle);
};
export { qMul, qApply };

/** House convention: `atan2(x, z)` of the rotated +Z forward. */
export const yawOfQuat = (q) => {
  const [fx, , fz] = qApply(q, [0, 0, 1]);
  return Math.atan2(fx, fz);
};

const yawQuat = (yaw) => qAxisAngle([0, 1, 0], yaw ?? 0);
// the rest orientation: the fold's full q when tilted (PROTOCOL §9 amendment), else its yaw
const baseQuat = (base) => (Array.isArray(base?.q) && base.q.length === 4 ? base.q : yawQuat(base?.yaw));

// ---- the generous reader -------
// Authors improvise dialect (`amplitude`, `axis: "x"`, no t0); parsing is generous, the closed form stays exact.

export const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1],
  '-x': [-1, 0, 0], '-y': [0, -1, 0], '-z': [0, 0, -1] };

export const axisOf = (m, def) => {
  const a = m.axis;
  if (Array.isArray(a) && a.length === 3) return a;
  if (typeof a === 'string' && AXES[a.toLowerCase()]) return AXES[a.toLowerCase()];
  return def;
};

export const ampOf = (m, def = 0) => {
  const v = Number(m.amp ?? m.amplitude ?? def);
  return Number.isFinite(v) ? v : def;
};

/** Seconds since t0; with none, since first evaluated here (a WeakMap: never mutate a bag we don't own). */
const t0Fallback = new WeakMap();
export const since = (m, nowMs) => {
  let t0 = m.t0;
  if (t0 == null) {
    t0 = t0Fallback.get(m);
    if (t0 == null) t0Fallback.set(m, (t0 = nowMs));
  }
  return Math.max(0, (nowMs - t0) / 1000);
};

/** °/s: degPerSec, else 360 / period, else rpm × 6, else `def`. The one reading, so renderer, seats and agent agree. */
export function rateOf(m, def) {
  if (Number.isFinite(m.degPerSec)) return m.degPerSec;
  if (Number.isFinite(m.period) && m.period > 0) return 360 / m.period;
  if (Number.isFinite(m.rpm)) return m.rpm * 6;
  return def;
}

/** ⚠ Mirrors the authority's pendulum push (AGENTS.md rule 2): change both, or the pushed swing and the watched one disagree.
 *  Missing damp = 0 = swings FOREVER (friction is opt-in). */
export function pendulumTheta(m, t) {
  const w0 = (2 * Math.PI) / (m.period ?? 3.5);
  return ampOf(m) * Math.exp(-(m.damp ?? 0) * t) * Math.cos(w0 * t + (m.phase ?? 0));
}

/** `theta` about local `axis` at local `pivot`, composed on the base pose. */
function rotateAtPivot(base, axis, pivot, theta) {
  const q = qAxisAngle(axis ?? [0, 1, 0], theta);
  const qy = baseQuat(base);
  const quat = qMul(qy, q);
  const pv = pivot ?? [0, 0, 0];
  const rp = qApply(q, pv);                                  // pivot after rotation
  const shift = qApply(qy, [pv[0] - rp[0], pv[1] - rp[1], pv[2] - rp[2]]);
  return { pos: [base.pos[0] + shift[0], base.pos[1] + shift[1], base.pos[2] + shift[2]], quat };
}

// arc-length tables per component object: a re-folded comp is a new object, so this invalidates exactly on change
const pathLen = new WeakMap();

export function evalPath(m, t, base) {
  const pts = m.points;
  if (!Array.isArray(pts) || pts.length < 2) return { ok: false, why: "path needs ≥ 2 points" };
  let len = pathLen.get(m);
  if (!len) {
    len = [0];
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay, az] = pts[i - 1]; const [bx, by, bz] = pts[i];
      len.push(len[i - 1] + Math.hypot(bx - ax, by - ay, bz - az));
    }
    pathLen.set(m, len);
  }
  const total = len[len.length - 1] || 1;
  const speed = m.speed ?? (m.duration ? total / m.duration : 1);
  let s = speed * t;
  const loop = m.loop ?? 'loop';
  if (loop === 'loop') s %= total;
  else if (loop === 'pingpong') { s %= 2 * total; if (s > total) s = 2 * total - s; }
  else s = Math.min(s, total);                               // 'once': arrive and stay
  let i = 1;
  while (i < len.length - 1 && len[i] < s) i++;
  const seg = len[i] - len[i - 1] || 1;
  const f = (s - len[i - 1]) / seg;
  const [ax, ay, az] = pts[i - 1]; const [bx, by, bz] = pts[i];
  const pos = [ax + (bx - ax) * f, ay + (by - ay) * f, az + (bz - az) * f];
  if (m.face !== false) {
    const yaw = Math.atan2(bx - ax, bz - az);
    return { ok: true, pos, yaw, quat: yawQuat(yaw), rot: true };
  }
  return { ok: true, pos, yaw: base.yaw ?? 0, quat: baseQuat(base), rot: false };
}

/** nowMs: epoch ms on the sequencer's clock. → {ok:true, pos, yaw, quat, rot} (rot:false = leave the authored
 *  rotation alone) or {ok:false, why}. */
export function evalWholeMotion(base, m, nowMs) {
  if (!m || typeof m.type !== "string") return { ok: false, why: "no motion type" };
  if (typeof m.part === "string") {
    // ONE NAMED NODE: the root is untouched
    return { ok: true, pos: [...base.pos], yaw: base.yaw ?? 0, quat: baseQuat(base), rot: false };
  }
  const t = since(m, nowMs);
  let r;
  switch (motionType(m)) {
    case 'pendulum':
      r = { ok: true, rot: true, yaw: null,
        ...rotateAtPivot(base, axisOf(m, [1, 0, 0]), m.pivot ?? base.pivot ?? [0, 0, 0], pendulumTheta(m, t)) };   // base.pivot: the pivot component (research 52); absent, the origin (never a made-up default: a stored world's first load writes it as its pivot)
      break;
    case 'spin': {
      const rate = rateOf(m, 36);
      r = { ok: true, rot: true, yaw: null,
        ...rotateAtPivot(base, axisOf(m, [0, 1, 0]), m.pivot ?? base.pivot ?? [0, 0, 0],
          (m.phase ?? 0) + (rate * Math.PI / 180) * t) };
      break;
    }
    case 'orbit': {
      const c = m.center ?? base.pos;
      const rad = m.radius ?? 3;
      const a = (m.phase ?? 0) + (rateOf(m, 12) * Math.PI / 180) * t;
      const pos = [c[0] + rad * Math.sin(a), (c[1] ?? base.pos[1]), c[2] + rad * Math.cos(a)];
      r = m.face !== false
        ? { ok: true, pos, yaw: a + Math.PI / 2, quat: yawQuat(a + Math.PI / 2), rot: true }
        : { ok: true, pos, yaw: base.yaw ?? 0, quat: baseQuat(base), rot: false };
      break;
    }
    case 'oscillate': {
      const off = Math.sin((2 * Math.PI / (m.period ?? 4)) * t + (m.phase ?? 0)) * ampOf(m, 0.3);
      const ax = axisOf(m, [0, 1, 0]);
      const n = Math.hypot(...ax) || 1;
      r = { ok: true, rot: false, yaw: base.yaw ?? 0, quat: baseQuat(base),
        pos: [base.pos[0] + (ax[0] / n) * off, base.pos[1] + (ax[1] / n) * off, base.pos[2] + (ax[2] / n) * off] };
      break;
    }
    case 'path':
      r = evalPath(m, t, base);
      break;
    default:
      return { ok: false, why: `motion type "${m.type}" not supported here` };
  }
  if (!r.ok) return r;
  if (r.yaw == null) r.yaw = yawOfQuat(r.quat);
  if (!r.pos.every(Number.isFinite) || !Number.isFinite(r.yaw) || !r.quat.every(Number.isFinite)) {
    return { ok: false, why: `motion "${m.type}" produced a non-finite transform` };
  }
  return r;
}

// ---- openable: a door, a gate, a lid — the pure halves of client/lib/openable.js ----------
export const OPEN_DEFAULTS = Object.freeze({ angle: Math.PI / 2, time: 1 });   // a quarter turn; Roblox TweenInfo's 1 s

/** 0 shut … 1 open, for a tween {from, to, t0, dur} at `now` (ms); smoothstep. */
export function openFraction(tw, now) {
  if (!tw) return 0;
  if (!(tw.dur > 0)) return tw.to;
  const u = Math.min(1, Math.max(0, (now - tw.t0) / tw.dur));
  return tw.from + (tw.to - tw.from) * u * u * (3 - 2 * u);
}

/** base: the rest pose (parent's frame); pivot: own frame, before scale. A turn keeps the pivot fixed (a hinge). */
export function openPose(base, o, f, pivot = [0, 0, 0], scale = [1, 1, 1]) {
  const q0 = Array.isArray(base.q) && base.q.length === 4 ? base.q : yawQuat(base.yaw);
  if (Array.isArray(o.slide)) {
    const d = qApply(q0, o.slide.map((v, i) => (+v || 0) * f * scale[i]));
    return { pos: base.pos.map((v, i) => v + d[i]), q: [...q0] };
  }
  const q = qAxisAngle(axisOf(o, [0, 1, 0]), (Number.isFinite(o.angle) ? o.angle : OPEN_DEFAULTS.angle) * f);
  const pv = pivot.map((v, i) => v * scale[i]); const rp = qApply(q, pv);
  const shift = qApply(q0, [pv[0] - rp[0], pv[1] - rp[1], pv[2] - rp[2]]);
  return { pos: base.pos.map((v, i) => v + shift[i]), q: qMul(q0, q) };
}
