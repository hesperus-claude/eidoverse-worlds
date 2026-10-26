// captions — what the `caption` request MEANS and the bag it folds into, shared by the authority, the caption bot
// (tools/captionbot), the mcpl agent and any overlay, so no two describe a different screen.
//   caption {id, session, n, t0, t1, text, speaker?, title?}   # one line, once
//   caption {id, session, end: true}                            # the screen goes quiet
//   captions = {session, n, gen, title?, line: {t0, t1, text, speaker?}}   # the authority writes it, one line per write
// Who may caption, the live-leg generation, session/n dedupe, media time, bounds, retention: docs/CAPTIONS.md.

import { shown } from './shown.js';

export const CAPTIONS_MAX_LINES = 20;
export const CAPTION_TEXT_MAX = 240;
export const CAPTIONS_TITLE_MAX = 120;
export const CAPTIONS_SPEAKER_MAX = 48;
export const CAPTION_SESSION_MAX = 64;
/** `<ISO attach time>-<nonce>`: ordered by when the bot attached. */
export const SESSION_RX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z-[A-Za-z0-9]{2,16}$/;
const KNOWN_KEYS = new Set(['session', 'n', 'gen', 'title', 'line', 'mediaTime', 'window']);   // mediaTime and window: an older value's

function cleanText(s, max) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The one statement of the rule, for normalizeCaption and for the refusal that names what failed. */
function readLine(c) {
  const t0 = Number(c.t0), t1 = Number(c.t1), text = cleanText(c.text, CAPTION_TEXT_MAX);
  return { t0, t1, text, badTimes: !Number.isFinite(t0) || !Number.isFinite(t1) || t0 < 0 || t1 < t0, badText: !text };
}

/** Attach time first, so sessions sort by attach. */
export function mintSession(now = new Date(), nonce = Math.random().toString(36).slice(2, 8)) {
  return `${now.toISOString()}-${nonce}`;
}

/** Finite non-negative times in order, non-empty text. */
export function normalizeCaption(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const { t0, t1, text, badTimes, badText } = readLine(c);
  if (badTimes || badText) return null;
  const out = { t0: Math.round(t0 * 100) / 100, t1: Math.round(t1 * 100) / 100, text };
  const speaker = cleanText(c.speaker, CAPTIONS_SPEAKER_MAX);
  if (speaker) out.speaker = speaker;
  return out;
}

/** `ok:false` carries WHY (the refusal sent), `ok:true` the normalized args. The authority and the bot's own pre-check are
 *  the same function. */
export function normalizeCaptionArgs(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { ok: false, why: 'caption wants {id, session, n, t0, t1, text, speaker?, title?} or {id, session, end: true}' };
  const id = String(a.id ?? '').slice(0, 64);
  const session = String(a.session ?? '');
  if (!id) return { ok: false, why: 'caption wants an entity id' };
  if (!session || session.length > CAPTION_SESSION_MAX || !SESSION_RX.test(session)) {
    return { ok: false, why: `caption wants a session like "2026-09-16T20:00:00.000Z-k3f9": the UTC time the captioner attached, a hyphen, then 2–16 letters or digits (got ${shown(a.session)}); mint it once when the captioner attaches and send it with every line` };
  }
  if (a.end === true) return { ok: true, args: { id, session, end: true } };
  const n = Number(a.n);
  if (!Number.isInteger(n) || n < 1) return { ok: false, why: `caption wants an integer n of 1 or more (got ${shown(a.n)}): number a session's lines in order, each higher than the last` };
  const line = normalizeCaption(a);
  if (!line) {
    const { badTimes, badText } = readLine(a);
    const wants = [
      ...(badTimes ? [`t0 and t1, the line's start and end in seconds of media time, with 0 ≤ t0 ≤ t1 (got t0 ${shown(a.t0)}, t1 ${shown(a.t1)})`] : []),
      ...(badText ? [`text, the line's words (got ${shown(a.text)})`] : []),
    ];
    return { ok: false, why: `caption wants ${wants.join(', and ')}` };
  }
  const args = { id, session, n, ...line };
  const title = cleanText(a.title, CAPTIONS_TITLE_MAX);
  if (title) args.title = title;
  return { ok: true, args };
}

/** Decided before append so a refusal never becomes history: a superseded leg (lower `gen`), a duplicate or old `n` in the
 *  session, or an `end` for another session. `gen` is stamped by the door; entries without it read as generation 0. */
export function captionRefusal(bag, args) {
  const cur = bag && typeof bag === 'object' ? bag : null;
  if (!cur) return args.end ? `"${args.id}" has no captions to end, so it's already quiet` : null;
  const g = Number(args.gen) || 0, cg = Number(cur.gen) || 0;
  if (g < cg) return `"${args.id}" is captioned by a newer leg (generation ${cg}; yours is ${g}) — a superseded captioner: a connection that joined after yours has captioned this screen since, and the newest one to caption it holds it; rejoin, and your next line takes it back`;
  if (args.end) {
    if (cur.session !== args.session) return `"${args.id}" is captioned under session ${cur.session}, not ${args.session}; to end what it shows, end session ${cur.session}`;
    return null;
  }
  if (args.session === cur.session && args.n <= (Number(cur.n) || 0)) {
    return `caption n=${args.n} is not after the folded high-water n=${cur.n} for session ${cur.session} — duplicate or out of order; this session's next line needs n=${(Number(cur.n) || 0) + 1} or higher`;
  }
  return null;   // the same session continues; a different one starts fresh
}

/** Pure: the new bag, or null when the screen went quiet: the current line only. The title carries within a session. */
export function foldCaption(bag, args) {
  if (args.end) return null;
  const cur = bag && typeof bag === 'object' && bag.session === args.session ? bag : null;
  const line = { t0: args.t0, t1: args.t1, text: args.text, ...(args.speaker ? { speaker: args.speaker } : {}) };
  const title = args.title ?? cur?.title;
  return { session: args.session, n: args.n, gen: Number(args.gen) || 0, ...(title ? { title } : {}), line };
}

/** As a reader (look(), an overlay): `ok:false` carries WHY; `ok:true` the normalized captions plus notes for anything coerced. */
export function normalizeCaptions(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, why: 'captions must be an object {session, n, gen, title?, line: {t0, t1, text, speaker?}}' };
  }
  // today's value holds its current line; an older one its window of lines
  const lines0 = data.line !== undefined ? [data.line] : data.window;
  if (!Array.isArray(lines0)) return { ok: false, why: 'line must be {t0, t1, text, speaker?} (an older value: window, an array of them)' };
  const notes = [];
  const unknown = Object.keys(data).filter((k) => !KNOWN_KEYS.has(k) && !k.startsWith('_'));
  if (unknown.length) notes.push(`ignored: ${unknown.join(', ')} (accepted: ${[...KNOWN_KEYS].join(', ')})`);
  let dropped = 0;
  let window = [];
  for (const c of lines0) {
    const n = normalizeCaption(c);
    if (n) window.push(n); else dropped++;
  }
  if (dropped) notes.push(`${dropped} malformed caption${dropped === 1 ? '' : 's'} dropped`);
  if (window.length > CAPTIONS_MAX_LINES) {
    notes.push(`window clipped to the newest ${CAPTIONS_MAX_LINES} of ${window.length}`);
    window = window.slice(-CAPTIONS_MAX_LINES);
  }
  const captions = { window };
  const session = String(data.session ?? '');
  if (session) captions.session = session.slice(0, CAPTION_SESSION_MAX);
  const n = Number(data.n);
  if (Number.isInteger(n) && n >= 0) captions.n = n;
  const gen = Number(data.gen);
  if (Number.isInteger(gen) && gen >= 0) captions.gen = gen;
  const title = cleanText(data.title, CAPTIONS_TITLE_MAX);
  if (title) captions.title = title;
  const mt = Number(data.mediaTime);
  if (Number.isFinite(mt) && mt >= 0) captions.mediaTime = Math.round(mt * 100) / 100;
  else if (window.length) captions.mediaTime = window[window.length - 1].t1;
  return { ok: true, captions, notes };
}

/** mm:ss or h:mm:ss for a media time in seconds. */
export function clock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(r).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** What is showing, where in it, and the last thing it said. Never a claim about pixels or sound: only what the captioner wrote. */
export function describeCaptions(data) {
  const n = normalizeCaptions(data);
  if (!n.ok) return 'a screen (malformed captions declaration)';
  const { captions } = n;
  const showing = captions.title ? `showing ${captions.title}` : 'showing something uncaptioned by title';
  const last = captions.window[captions.window.length - 1];
  if (!last) return `a screen, ${showing}, nothing captioned yet`;
  const line = last.speaker ? `${last.speaker}: ${last.text}` : last.text;
  return `a screen, ${showing}, ${clock(captions.mediaTime ?? last.t1)}, last line: ${line}`;
}

/** The lines, oldest first, at most `lines`. `earlier` is the screen's earlier captions values (the log's changes), oldest first. */
export function captionsDetail(data, lines = CAPTIONS_MAX_LINES, earlier = []) {
  const n = normalizeCaptions(data);
  if (!n.ok) return [];
  const before = (Array.isArray(earlier) ? earlier : []).flatMap((b) => { const m = normalizeCaptions(b); return m.ok && m.captions.session === n.captions.session ? m.captions.window : []; });
  const w = [...before, ...n.captions.window].slice(-Math.max(0, lines));
  return w.map((c) => `[${clock(c.t0)}–${clock(c.t1)}] ${c.speaker ? `${c.speaker}: ` : ''}${c.text}`);
}
