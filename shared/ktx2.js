// ktx2 — the texture negotiation KEY: defined here, PUBLISHED by the running sequencer, and used only by a client that
// got it from that sequencer. A client asks with ?ktx2=<key> and gets the GPU-native variant or the original (routes.ts).
// The key is a GENERATION: rotating it is the only escape from a cache poisoned under `immutable`. Clients read it only
// from the RUNNING process (/version ktx2Key), never a file; no key handed = no negotiation, always right for its URL.
// Variants are served revalidating (routes.ts VARIANT_CC), so a rebuild needs no new generation; history is in git.
export const KTX2_KEY = '4';
export const KTX2_QUERY = `ktx2=${KTX2_KEY}`;

/** Does this request negotiate KTX2 — the CURRENT key only. A retired key is
 *  an unflagged fetch: whatever that client cached under it is what it
 *  already has, and a new client never asks with it. */
export function wantsKtx2(params) {
  return params.get('ktx2') === KTX2_KEY;
}

/** The key the running sequencer published, read off its /version body —
 *  or null when it published none (an older sequencer, or not JSON at all),
 *  which the client must treat as "do not negotiate". Never a default. */
export function keyFromVersion(json) {
  const k = json && typeof json === 'object' ? json.ktx2Key : undefined;
  return typeof k === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(k) ? k : null;
}

/** Append the negotiation to a URL that may already carry a query (avatar
 *  URLs carry ?v=<mtime>) — with the key GIVEN, which for a browser is the
 *  one /version handed it. No key → the URL untouched: an unflagged fetch. */
export function negotiate(url, key) {
  if (!key) return url;
  return url + (url.includes('?') ? '&' : '?') + `ktx2=${key}`;
}

/** The LOD recipe the running sequencer published on /version, or null (an older one): never a default, since an
 *  unknown tier falls through to the original, served immutable under the flagged URL. */
export function lodFromVersion(json) {
  const l = json && typeof json === 'object' ? json.lodRecipe : undefined;
  return typeof l === 'string' && l.length > 0 && l.length <= 64 ? l : null;
}

/** Append the LOD tier request: the RECIPE published, never a bare boolean (`lod=1` under two recipes would be one
 *  immutable URL for two byte-streams). No recipe → the URL untouched. Only meaningful with ktx2 negotiation. */
export function withLod(url, recipe) {
  if (!recipe) return url;
  return url + (url.includes('?') ? '&' : '?') + `lod=${encodeURIComponent(recipe)}`;
}

/** The sequencer's own spelling (tests, tools): negotiate with the key this
 *  file defines. A BROWSER must not call this — it would be reading the key
 *  off disk again, which is the collision. */
export function withKtx2(url) {
  return negotiate(url, KTX2_KEY);
}
