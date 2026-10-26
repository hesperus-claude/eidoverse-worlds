// What "a headset was seen here" means, as pure functions; core.js owns the storage read. No imports on purpose.
// The value is HISTORY, not presence (#197): nothing clears it on unplug and `isSessionSupported` stays optimistic after a
// headset is switched off. It lets the next boot pick WebGL so the visor ENTERS instead of RELOADING, and it expires.
export const HEADSET_SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days

/** Null if never. The legacy marker '1' reads as 0, "seen, TIME UNKNOWN": never treat it as a timestamp. */
export function headsetSeenAt(raw) {
  if (raw === '1') return 0;
  const t = Number(raw);
  return Number.isFinite(t) && t > 0 ? t : null;
}

/** The legacy '1' is stamped with now on first observation, starting the same TTL clock. Returns the value to
 *  persist, or null; the caller owns storage. */
export function migrateHeadsetSeen(now, raw) {
  return raw === '1' ? String(now) : null;
}

/** An unmigrated '1' reads as unknown, the safe answer (the visor still works; it reloads once instead of entering). */
export function headsetSeenRecently(now, raw) {
  const at = headsetSeenAt(raw);
  if (at === null || at === 0) return false;
  return now - at < HEADSET_SEEN_TTL_MS;
}
