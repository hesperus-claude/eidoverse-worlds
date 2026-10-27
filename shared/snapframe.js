// Optional framing for a world snapshot (GET /snap's query, the `capture` message's `frame`, the agent `screenshot` tool's
// arguments): one normaliser, three readers. An absent field always means today's fixed framing.
//   dist   — third/selfie: metres between camera and body, measured flat (third behind, selfie in front). [0.5, 30]
//   height — third/selfie: camera height above the body's feet. [0, 30]
//   pitch  — first: gaze tilt in degrees, + up, − down. [-85, 85] (the default first-person gaze is about −4.3°)

export const SNAP_DIST = [0.5, 30];
export const SNAP_HEIGHT = [0, 30];
export const SNAP_PITCH = [-85, 85];

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
// only finite numbers and non-blank numeric strings count; non-numbers drop BEFORE conversion (Number(false) is 0: foot height)
const num = (v) => {
  if (typeof v !== 'number' && typeof v !== 'string') return undefined;
  if (typeof v === 'string' && v.trim() === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** @returns {{dist?: number, height?: number, pitch?: number}} only the finite fields given, each clamped to its range. */
export function normalizeSnapFrame(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const d = num(raw.dist), h = num(raw.height), p = num(raw.pitch);
  if (d !== undefined) out.dist = clamp(d, SNAP_DIST);
  if (h !== undefined) out.height = clamp(h, SNAP_HEIGHT);
  if (p !== undefined) out.pitch = clamp(p, SNAP_PITCH);
  return out;
}
