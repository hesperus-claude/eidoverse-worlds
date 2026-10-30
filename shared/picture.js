// picture — what a `picture` component MEANS. Shared verbatim between the
// browser host (client/lib/pictures.js) and the mcpl agent (text-tier
// perception), so the two can never describe different pictures.
//
//   picture {src, width?, description?, lit?}   (a quad of its own, facing +Z on the thing's origin)
//   delete {id, component: "picture"}                # take it down
//
// A picture is a standalone image (Godot's Sprite3D, Unity's SpriteRenderer): it owns its quad, `width` metres wide,
// its height from the image's aspect once the image loads. A texture on a NAMED node of a model is the `material`
// component's (shared/material.js: two shapes, no overlap).

// SOURCES. An https link (shared/mediasrc.js decides whose browser may fetch it), or a library-relative store path
// under one of PICTURE_DIRS, both served by the sequencer's /library/ route: `eidoverse/assets/` (what the operator
// placed) and `store/images/` (uploads via `POST /upload?as=image`: content-addressed, sniffed, token-gated).
//
// THE DESCRIPTION. Text-tier residents perceive by reading: the author's ≤200-char `description` is what look()
// carries (else "a picture (<file>)"). Nothing about pixels is ever claimed.

import { mediaTier } from './mediasrc.js';
import { graphemes, quoted } from './text.js';

export const PICTURE_DIR = 'eidoverse/assets/';
export const PICTURE_STORE = 'store/images/';
export const PICTURE_DIRS = Object.freeze([PICTURE_DIR, PICTURE_STORE]);
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
export const PICTURE_DESCRIPTION_MAX = 200;
export const PICTURE_MAX_WIDTH = 20;
export const PICTURE_DEFAULTS = Object.freeze({ lit: 'scene', width: 1 });
/** The description field's tooltip, in plain words. */
export const DESCRIPTION_HINT = 'Describes this in words, for people who can\'t see it and for agents';
export const PICTURE_LIT = Object.freeze({ scene: 'lit by the scene', self: 'self-lit (a screen)' });
const KNOWN_KEYS = new Set(['src', 'width', 'description', 'lit']);

/** Is `src` an allowed picture source? Library-relative, under one of PICTURE_DIRS, image extension, no scheme, no
 *  leading slash, no dot segments, no `%` at all (a URL parser reads `%2e%2e` as `..`). The parsed pathname must come
 *  back byte-identical to the declared one: the rule is over what the FETCH canonicalizes to. */
export function allowedPictureSrc(src) {
  if (typeof src !== 'string' || !src) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/') || src.includes('\\')) return false;
  if (/[%?#\s\u0000-\u001f\u007f]/.test(src)) return false;
  if (src.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  if (!PICTURE_DIRS.some((d) => src.startsWith(d)) || !IMAGE_EXT.test(src)) return false;
  try {
    // What the browser will actually ask the library route for. Any
    // difference — a collapsed segment, a decoded byte — means the string
    // and the fetch disagree, and the fetch is the one that matters.
    if (new URL(`/library/${src}`, 'http://library.invalid').pathname !== `/library/${src}`) return false;
  } catch { return false; }
  return true;
}

/** Validate an authored bag. `ok:false` carries WHY (legible, once per authoring);
 *  `ok:true` carries the normalized picture plus notes for anything coerced.
 *  `description` is the describing line; src may be an https link (shared/mediasrc.js says who may fetch it). */
export function normalizePicture(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, why: 'picture data must be an object {src, width?, description?, lit?}' };
  }
  const tier = mediaTier(data.src, 'image');
  if (tier.tier === 'bad') return { ok: false, why: `src: ${tier.why} — ${tier.fix}` };
  const notes = [];
  const unknown = Object.keys(data).filter((k) => !KNOWN_KEYS.has(k) && !k.startsWith('_'));
  if (unknown.length) notes.push(`ignored by the evaluator: ${unknown.join(', ')} (accepted: ${[...KNOWN_KEYS].join(', ')})`);
  const picture = { src: data.src, width: PICTURE_DEFAULTS.width, lit: 'scene' };
  if (data.width !== undefined) { const w = Number(data.width); if (Number.isFinite(w) && w > 0) picture.width = Math.min(PICTURE_MAX_WIDTH, w); else notes.push('width is a number of metres above 0 — using 1'); }
  if (data.description != null) {
    const d = String(data.description).replace(/\s+/g, ' ').trim();
    if (graphemes(d) > PICTURE_DESCRIPTION_MAX) return { ok: false, why: `description is ${graphemes(d).toLocaleString('en')} characters (at most ${PICTURE_DESCRIPTION_MAX})` };   // the door's bound, in the editor's words (mediasrc.js, editor-range-test)
    if (d) picture.description = d;
  }
  if (!picture.description) notes.push('no description — anyone who can\'t see it (or reads the world as text) gets only the file name; say what it shows');
  if (data.lit != null) {
    if (Object.hasOwn(PICTURE_LIT, data.lit)) picture.lit = data.lit;
    else notes.push(`lit ${JSON.stringify(data.lit)} is unknown (${Object.keys(PICTURE_LIT).join('/')}) — using scene`);
  }
  return { ok: true, picture, tier, notes };
}

/** The one line look() carries for a picture — the same string on the authority, in mcpl and in every client, from the
 *  same bag. Says what the author said it shows (quoted, as data); never claims anything about the pixels. */
export function describePicture(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'a picture (malformed declaration)';
  const file = typeof data.src === 'string' ? (/^https:/i.test(data.src) ? (() => { try { return new URL(data.src).hostname; } catch { return 'a link'; } })() : data.src.split('/').pop()) : null;
  const said = typeof data.description === 'string' && data.description.trim() ? data.description : null;
  const ok = mediaTier(data.src, 'image').tier !== 'bad';
  const bits = [];
  if (!ok) bits.push('not shown: invalid declaration');
  if (data.lit === 'self') bits.push('self-lit');
  const tail = bits.length ? ` (${bits.join('; ')})` : '';
  return said ? `a picture: ${quoted(said, PICTURE_DESCRIPTION_MAX)}${tail}` : `a picture (${file ?? 'no file'})${tail}`;
}
