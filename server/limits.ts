// eidoverse-worlds sequencer — the wire-limit table (R2, survey §1.1): what a message may carry before it is refused
// or truncated, each cap env-overridable (the idiom of mcpl/denoise.ts). config.ts keeps the boot/cadence knobs;
// docs/WIRE.md describes the shapes.

/** An env number, VALIDATED: unset or "" is the fallback; not a number, or outside `ok`, is the fallback with a warning
 *  (NaN silently disabled a cap; Number("") is 0). Every env number in server/ reads through it. */
export function envNumber(name: string, fallback: number, ok: (n: number) => boolean = (n) => n >= 0): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && ok(n)) return n;
  console.warn(`[config] ${name}=${JSON.stringify(raw)} is not valid — using ${fallback}`);
  return fallback;
}
const env = (k: string, d: number) => envNumber(k, d);

export const LIMITS = {
  // identity + naming
  ID_LEN: env("EW_ID_LEN", 64),                    // ids, targets, world names
  SURFACE_LEN: env("EW_SURFACE_LEN", 16),          // aux-leg surface names
  AUX_LEGS: env("EW_AUX_LEGS", 4),                 // distinct aux surfaces per identity

  // text payloads
  CAPTION_LEN: env("EW_CAPTION_LEN", 500),
  BAN_REASON_LEN: env("EW_BAN_REASON_LEN", 200),

  // binary-ish payloads
  ANIM_TRACKS_BYTES: env("EW_ANIM_TRACKS_BYTES", 64_000),
  BODYDRAG_POSE_BYTES: env("EW_BODYDRAG_POSE_BYTES", 24_000),

  // paging + rings
  PAGE_MAX: env("EW_PAGE_MAX", 300),               // history/debug page ceiling
  PAGE_DEFAULT: env("EW_PAGE_DEFAULT", 50),
  BC_RING: env("EW_BC_RING", 40),                  // crash breadcrumbs kept

  // one websocket message, whole: past it the socket closes (Bun's default was 16 MB; security review 10-06 pass 2,
  // M-A). The door's own cap on one log line is 1 MiB; a request that writes one fits with room for its envelope.
  WS_MESSAGE_BYTES: env("EW_WS_MESSAGE_BYTES", 2 * 1024 * 1024),

  // receipts
  ATTEST_FRESH_MS: env("EW_ATTEST_FRESH_MS", 300_000),
} as const;
