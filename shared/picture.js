// picture — what a `picture` component MEANS. Shared verbatim between the browser host (client/lib/pictures.js) and
// the mcpl agent (text-tier perception), so the two can never describe different pictures.
//
//   picture {src, width?, alt?, lit?}   (a quad of its own, facing +Z on the thing's origin)
//   comp {id, type: "picture", data: null}          # take it down
//
// SOURCES. `src` is a library path under `eidoverse/assets/` (what the operator placed) or `store/images/` (uploaded
// through `POST /upload?as=image`: content-addressed, sniffed by bytes), or an https link, which shared/mediasrc.js
// gates per viewer (an untrusted host is fetched only for a viewer who opted in).
//
// ALT. A picture with no `alt` reads as "a picture (<file>)"; the author can say what it shows in ≤200 chars, and that
// line is what look() carries. Nothing about pixels is ever claimed.

import { mediaTier } from './mediasrc.js';
import { graphemes, graphemeList, quoted } from './text.js';

export const PICTURE_DIR = 'eidoverse/assets/';
export const PICTURE_STORE = 'store/images/';
export const PICTURE_DIRS = Object.freeze([PICTURE_DIR, PICTURE_STORE]);
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
export const PICTURE_ALT_MAX = 200;
export const PICTURE_LOOK_MAX = PICTURE_ALT_MAX;   // the old name, for callers not yet renamed
export const PICTURE_MAX_WIDTH = 20;
export const PICTURE_DEFAULTS = Object.freeze({ lit: 'scene', width: 1 });
/** The alt field's tooltip, in plain words (R 10-07). */
export const ALT_HINT = 'Alternative text: describes this for people who can\'t see it, and for agents';
export const PICTURE_LIT = Object.freeze({ scene: 'lit by the scene', self: 'self-lit (a screen)' });
const KNOWN_KEYS = new Set(['src', 'width', 'alt', 'lit']);
// alt was named look before release: a picture stored under the old name is read by it (never written so: alt wins)
const altOf = (data) => data.alt ?? data.look;

/** Is `src` an allowed library picture source? Under PICTURE_DIRS, an image extension, no scheme, leading slash, dot
 *  segments or percent-encoding at all: the rule is over the path the FETCH canonicalizes to (`%2e%2e` is `..`), so the
 *  parsed pathname must come back byte-identical. */
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

/** Validate an authored bag: `ok:false` carries WHY, `ok:true` the normalized picture (a quad `width` m wide) plus
 *  notes for anything coerced. `alt` is the describing line; src may be an https link (shared/mediasrc.js decides). */
export function normalizePicture(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, why: 'picture data must be an object {src, width?, alt?, lit?}' };
  }
  const tier = mediaTier(data.src, 'image');
  if (tier.tier === 'bad') return { ok: false, why: `src: ${tier.why} — ${tier.fix}` };
  const notes = [];
  const unknown = Object.keys(data).filter((k) => !KNOWN_KEYS.has(k) && k !== 'look' && !k.startsWith('_'));
  if (unknown.length) notes.push(`ignored by the evaluator: ${unknown.join(', ')} (accepted: ${[...KNOWN_KEYS].join(', ')})`);
  const picture = { src: data.src, width: PICTURE_DEFAULTS.width, lit: 'scene' };
  if (data.width !== undefined) { const w = Number(data.width); if (Number.isFinite(w) && w > 0) picture.width = Math.min(PICTURE_MAX_WIDTH, w); else notes.push('width is a number of metres above 0 — using 1'); }
  if (altOf(data) != null) {
    const alt = String(altOf(data)).replace(/\s+/g, ' ').trim();
    if (graphemes(alt) > PICTURE_ALT_MAX) { notes.push(`alt clipped to ${PICTURE_ALT_MAX} characters`); picture.alt = graphemeList(alt).slice(0, PICTURE_ALT_MAX).join(''); }
    else if (alt) picture.alt = alt;
  }
  if (!picture.alt) notes.push('no alt text — anyone who can\'t see it (or reads the world as text) gets only the file name; say what it shows');
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
  const alt = typeof altOf(data) === 'string' && altOf(data).trim() ? altOf(data) : null;
  const where = '';   // a picture is a quad of its own (part was cut, shape audit 10-16)
  const ok = mediaTier(data.src, 'image').tier !== 'bad';
  const bits = [];
  if (!ok) bits.push('not shown: invalid declaration');
  if (data.lit === 'self') bits.push('self-lit');
  const tail = bits.length ? ` (${bits.join('; ')})` : '';
  return alt ? `a picture${where}: ${quoted(alt, PICTURE_ALT_MAX)}${tail}` : `a picture${where} (${file ?? 'no file'})${tail}`;
}
