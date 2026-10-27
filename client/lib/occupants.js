// occupants — the browser's seat-profile cache (server verdicts from /avatars, generation-guarded) and gate assembly (#101).
// seatGate adds two local truths: the slot actually playing (a fallback must never let "sit" consume a chair profile)
// and the digest of the loaded clip bytes (assets.js; a filename is not an identity).

import { bus } from './base.js';
import { vrmaShaLoaded } from './assets.js';
import { makeVerdictCache, seatGate, occupantScalar, nameFromAvatarPath, SEAT_CLIP_FILE } from './seatcore.js';

// cache logic: seatcore.makeVerdictCache (shared with the headless agent); this is the browser's transport
const cache = makeVerdictCache(async () => {
  const res = await fetch('/avatars', { cache: 'no-store' });
  if (!res.ok) throw new Error(`roster ${res.status}`);
  const rev = Number(res.headers.get('x-profiles-rev') ?? NaN);
  return { rev, entries: await res.json() };
});
let started = false;

export function initOccupants() {
  if (started) return;
  started = true;
  // note() bumps BEFORE its refetch departs and demotes the verdict to pending at once: the order is the guarantee
  bus.on('avatar-updated', ({ name }) => cache.note(name, NaN));
  bus.on('avatar-profile-updated', ({ name, rev }) => cache.note(name, Number(rev)));
  cache.init();
}

/** `occ` is {path, av}. Returns {applied:true, contactY, scale} or {applied:false, reason}; the reason is shared
 *  verbatim with other readers. */
export function occupyCorrectionFor(occ, sock) {
  if (!occ || !occ.path) return { applied: false, reason: 'no occupant context' };
  if (!occ.av) return { applied: false, reason: 'body loading' };
  const name = nameFromAvatarPath(occ.path);
  if (!name) return { applied: false, reason: 'no occupant context' };
  const verdict = cache.get(name);
  // body scale (bodyscale.js) is on vrm.scene, not the root (the root carries the plate); effective = body × root
  const bs = occ.av.bodyScale?.() ?? 1;
  const sc = occupantScalar([occ.av.root.scale.x * bs, occ.av.root.scale.y * bs, occ.av.root.scale.z * bs]);
  if (!sc.ok) return { applied: false, reason: sc.why };
  const g = seatGate({
    sock, verdict,
    pose: typeof sock?.pose === 'string' ? sock.pose : 'sitchair',   // sock: the seat's station
    currentSlot: occ.av.playingSlot?.() ?? occ.av.currentSlot,   // a seat blend clears currentSlot (I2)
    loadedClipSha256: vrmaShaLoaded(SEAT_CLIP_FILE),
    currentClipSha256: verdict?.clipSha256,
  });
  if (!g.apply) return { applied: false, reason: g.reason };
  return { applied: true, contactY: g.contactY, scale: sc.s };
}

// One console line per state CHANGE per occupant; standing up clears the key so the next sit declares afresh.

const declared = new Map(); // occupantId → last declared "to/slot state reason"
export function declareOccupyState(occupantId, to, slot, state, reason) {
  const key = `${to}/${slot ?? 'seat'} ${state} ${reason ?? ''}`;
  if (declared.get(occupantId) === key) return;
  declared.set(occupantId, key);
  if (state === 'approximate') console.info(`[seat] ${occupantId} on ${to}/${slot ?? 'seat'}: seat approximate — ${reason}`);
  else console.info(`[seat] ${occupantId} on ${to}/${slot ?? 'seat'}: seat ${state}`);
}
export function clearOccupyState(occupantId) { declared.delete(occupantId); }
