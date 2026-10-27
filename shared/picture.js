// picture — what a `picture` component MEANS, shared verbatim by the browser host (client/lib/pictures.js) and the mcpl agent.
//   picture {src, width?, alt?, lit?}   (a quad of its own, facing +Z on the thing's origin)
//   comp {id, type: "picture", data: null}          # take it down
// SOURCES. A library path under `eidoverse/assets/` or `store/images/` (uploaded via `POST /upload?as=image`: content-addressed,
// sniffed by bytes), or an https link, which shared/mediasrc.js gates per viewer (an untrusted host only for a viewer who opted in).
// ALT. No `alt` reads as "a picture (<file>)"; the author's ≤200-char line (longer is refused) is what look() carries. Nothing about pixels is ever claimed.

import { mediaTier } from './mediasrc.js';
import { graphemes, quoted } from './text.js';

export const PICTURE_DIR = 'eidoverse/assets/';
export const PICTURE_STORE = 'store/images/';
export const PICTURE_DIRS = Object.freeze([PICTURE_DIR, PICTURE_STORE]);
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
export const PICTURE_ALT_MAX = 200;
export const PICTURE_LOOK_MAX = PICTURE_ALT_MAX;   // the old name
export const PICTURE_MAX_WIDTH = 20;
export const PICTURE_DEFAULTS = Object.freeze({ lit: 'scene', width: 1 });
/** The alt field's tooltip, in plain words. */
export const ALT_HINT = 'Alternative text: describes this for people who can\'t see it, and for agents';
export const PICTURE_LIT = Object.freeze({ scene: 'lit by the scene', self: 'self-lit (a screen)' });
const KNOWN_KEYS = new Set(['src', 'width', 'alt', 'lit']);
// alt was once named look: a picture stored under it is read (never written so: alt wins)
const altOf = (data) => data.alt ?? data.look;

/** Is `src` an allowed library picture source? Under PICTURE_DIRS, an image extension; no scheme, leading slash, dot
 *  segments or percent-encoding: the rule is over the path the FETCH canonicalizes to (`%2e%2e` is `..`), so the parsed
 *  pathname must come back byte-identical. */
export function allowedPictureSrc(src) {
  if (typeof src !== 'string' || !src) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/') || src.includes('\\')) return false;
  if (/[%?#\s\u0000-\u001f\u007f]/.test(src)) return false;
  if (src.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  if (!PICTURE_DIRS.some((d) => src.startsWith(d)) || !IMAGE_EXT.test(src)) return false;
  try {
    // any difference (a collapsed segment, a decoded byte) means the string and the fetch disagree; the fetch is what matters
    if (new URL(`/library/${src}`, 'http://library.invalid').pathname !== `/library/${src}`) return false;
  } catch { return false; }
  return true;
}

/** `ok:false` carries WHY, `ok:true` the normalized picture (a quad `width` m wide) plus notes for anything coerced.
 *  src may be an https link (shared/mediasrc.js decides). */
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
    if (graphemes(alt) > PICTURE_ALT_MAX) return { ok: false, why: `alt is ${graphemes(alt).toLocaleString('en')} characters; it must be ≤ ${PICTURE_ALT_MAX}` };   // the door's bound and words (checks.js maxLen)
    if (alt) picture.alt = alt;
  }
  if (!picture.alt) notes.push('no alt text — anyone who can\'t see it (or reads the world as text) gets only the file name; say what it shows');
  if (data.lit != null) {
    if (Object.hasOwn(PICTURE_LIT, data.lit)) picture.lit = data.lit;
    else notes.push(`lit ${JSON.stringify(data.lit)} is unknown (${Object.keys(PICTURE_LIT).join('/')}) — using scene`);
  }
  return { ok: true, picture, tier, notes };
}

/** The one line look() carries, the same everywhere: what the author said it shows (quoted, as data); never a claim about pixels. */
export function describePicture(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'a picture (malformed declaration)';
  const file = typeof data.src === 'string' ? (/^https:/i.test(data.src) ? (() => { try { return new URL(data.src).hostname; } catch { return 'a link'; } })() : data.src.split('/').pop()) : null;
  const alt = typeof altOf(data) === 'string' && altOf(data).trim() ? altOf(data) : null;
  const where = '';   // a picture is a quad of its own
  const ok = mediaTier(data.src, 'image').tier !== 'bad';
  const bits = [];
  if (!ok) bits.push('not shown: invalid declaration');
  if (data.lit === 'self') bits.push('self-lit');
  const tail = bits.length ? ` (${bits.join('; ')})` : '';
  return alt ? `a picture${where}: ${quoted(alt, PICTURE_ALT_MAX)}${tail}` : `a picture${where} (${file ?? 'no file'})${tail}`;
}
