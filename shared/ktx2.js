// ktx2 — the texture negotiation KEY: defined here, PUBLISHED by the running sequencer (/version ktx2Key), used only by a
// client that got it from there, never from a file. ?ktx2=<key> gets the GPU-native variant or the original (routes.ts).
// The key is a GENERATION: rotating it is the only escape from a cache poisoned under `immutable`; no key = no negotiation.
// Variants are served revalidating (routes.ts VARIANT_CC), so a rebuild needs no new generation.
export const KTX2_KEY = '4';
export const KTX2_QUERY = `ktx2=${KTX2_KEY}`;

/** The CURRENT key only: a retired key is an unflagged fetch (that client keeps what it cached; a new one never asks with it). */
export function wantsKtx2(params) {
  return params.get('ktx2') === KTX2_KEY;
}

/** null when none was published (older sequencer, not JSON): the client must not negotiate. Never a default. */
export function keyFromVersion(json) {
  const k = json && typeof json === 'object' ? json.ktx2Key : undefined;
  return typeof k === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(k) ? k : null;
}

/** The URL may already carry a query (avatar ?v=<mtime>); for a browser the key is the one /version handed it.
 *  No key → the URL untouched. */
export function negotiate(url, key) {
  if (!key) return url;
  return url + (url.includes('?') ? '&' : '?') + `ktx2=${key}`;
}

/** null for an older sequencer: never a default, since an unknown tier falls through to the original, served immutable
 *  under the flagged URL. */
export function lodFromVersion(json) {
  const l = json && typeof json === 'object' ? json.lodRecipe : undefined;
  return typeof l === 'string' && l.length > 0 && l.length <= 64 ? l : null;
}

/** The RECIPE published, never a bare boolean (`lod=1` under two recipes would be one immutable URL for two byte-streams).
 *  No recipe → the URL untouched. Only meaningful with ktx2 negotiation. */
export function withLod(url, recipe) {
  if (!recipe) return url;
  return url + (url.includes('?') ? '&' : '?') + `lod=${encodeURIComponent(recipe)}`;
}

/** The sequencer's own spelling (tests, tools). A BROWSER must not call this: reading the key off disk is the collision. */
export function withKtx2(url) {
  return negotiate(url, KTX2_KEY);
}
