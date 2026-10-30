// ktx2 — the texture negotiation KEY: defined here, PUBLISHED by the running
// sequencer, and only ever used by a client that got it from that sequencer.
//
// A KTX2-capable client asks for a library or store asset with ?ktx2=<key>
// and the sequencer answers with the GPU-native variant when one exists, the
// original otherwise (routes.ts, the §20 negotiation). The key is a
// GENERATION, not a boolean: rotating it is the only way to walk away from a
// poisoned cache — an answer served `max-age=31536000, immutable` under an
// old key never revalidates, not in a browser, not in nginx (it keys on the
// full query string), no matter what the origin says afterwards. A fresh key
// is a fresh cache entry everywhere at once; the old one simply stops being
// asked for.
//
// WHO READS IT: the sequencer imports this file; a browser never does. It uses only the key the RUNNING process
// handed it on /version (`ktx2Key`), and no key means no negotiation. Why, and the retired generations:
// docs/research/ktx2-key-generations.md.
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

/** The LOD recipe the running sequencer published on /version, or null when
 *  it published none: a client must not ask for a tier the server never heard
 *  of (an unknown param falls through to the original, served immutable under
 *  the flagged URL). Same rule as keyFromVersion: never a default. */
export function lodFromVersion(json) {
  const l = json && typeof json === 'object' ? json.lodRecipe : undefined;
  return typeof l === 'string' && l.length > 0 && l.length <= 64 ? l : null;
}

/** Append the LOD tier request — the RECIPE the running sequencer published,
 *  never a bare boolean (`lod=1` under two recipes would be one immutable URL
 *  for two byte-streams). No recipe → the URL untouched. Only meaningful
 *  alongside the ktx2 negotiation (a LOD variant carries KTX2 textures). */
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
