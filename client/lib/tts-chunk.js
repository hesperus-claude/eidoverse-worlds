/**
 * tts-chunk — the spoken form of an utterance, in synthesis-sized pieces (soft clause split past SOFT_LEN).
 * Markdown and emoji are stripped because piper reads them aloud; the say keeps its glyphs.
 */

const ABBREVS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'ft',
  'vs', 'etc', 'eg', 'e.g', 'ie', 'i.e', 'cf', 'ca', 'approx',
  'no', 'vol', 'fig', 'dept', 'est', 'min', 'max', 'misc',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);
const BOUNDARY = /[.!?…]+["'’”)\]»]*\s/g;
const SOFT = /(?:[,;:—–]["'’”)\]»]*\s)|(?:\s(?=(?:and|but|so|or|yet|because|which|while|though|although)\s))/g;
const MIN_LEN = 20;
const SOFT_LEN = 90;
const SOFT_MIN = 35;

/** Strips what TTS would read aloud; symbol runs become a pause, but digit:digit keeps its colon (6:04). */
export function spokenForm(text) {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/\[([^\]]{1,80})\]\((?:[^)]+)\)/g, '$1')
    .replace(/\bhttps?:\/\/\S+/gi, 'link')
    .replace(/[*_`#]+/g, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[→⇒↔▸▶◦‣·•]+/g, ', ')                            // glyphs espeak names aloud
    .replace(/(?:->|=>|::)+/g, ', ')                           // ASCII arrows / double colon
    .replace(/(?<=[a-zA-Z])[:](?=[a-zA-Z])/g, ', ')            // world:staging → pause, 6:04 untouched
    .replace(/\s[|~]+\s/g, ', ')                               // separator pipes/tildes
    .replace(/\s{2,}/g, ' ')
    .replace(/(?:, )+(?=, )/g, '')                             // collapse comma pileups
    .trim();
}

function isRealBoundary(head) {
  const trimmed = head.replace(/\s+$/, '').replace(/[.!?…"')\]»]+$/, '');
  const last = trimmed.trim() ? trimmed.trim().split(/\s+/).pop() : '';
  if (ABBREVS.has(last.toLowerCase().replace(/\.+$/, ''))) return false;
  if (last.length === 1 && /[A-Z]/.test(last)) return false;   // J. R. R. Tolkien
  return true;
}

function splitLong(sentence) {
  if (sentence.length <= SOFT_LEN) return [sentence];
  const chunks = [];
  let rest = sentence;
  while (rest.length > SOFT_LEN) {
    let best = null;
    SOFT.lastIndex = 0;
    let m;
    while ((m = SOFT.exec(rest))) {
      const end = m.index + m[0].length;
      if (end < SOFT_MIN) continue;
      if (rest.length - end < SOFT_MIN) break;
      best = m;
    }
    if (!best) break;
    const end = best.index + best[0].length;
    chunks.push(shapeContinuation(rest.slice(0, end).trim()));
    rest = rest.slice(end);
  }
  if (rest.trim()) chunks.push(rest.trim());
  return chunks;
}

const FIRST_MAX = 64;   // chars; small enough that synth(first) is fast (60-80 measured fine)
const FIRST_MIN = 20;   // chars; below ~20-25 piper quality drops

/** time-to-first-word is synth(chunk 1): better a slightly abrupt first clause than a silent second */
function fastFirst(chunk) {
  if (chunk.length <= FIRST_MAX) return [chunk];
  let cut = -1;
  SOFT.lastIndex = 0;
  let m;
  while ((m = SOFT.exec(chunk))) {
    const end = m.index + m[0].length;
    if (end < FIRST_MIN) continue;
    if (end > FIRST_MAX) break;
    cut = end;
  }
  if (cut < 0) {
    const sp = chunk.lastIndexOf(' ', FIRST_MAX);
    cut = sp > FIRST_MIN ? sp + 1 : -1;
  }
  if (cut < 0 || chunk.length - cut < FIRST_MIN) return [chunk];
  return [shapeContinuation(chunk.slice(0, cut).trim()), chunk.slice(cut).trim()];
}

/** espeak renders a trailing comma as a continuation rise, not a sentence-final fall */
function shapeContinuation(chunk) {
  return /[,;:—–.!?…]$/.test(chunk) ? chunk : chunk + ',';
}

/** possibly none: an emoji-only utterance is in the log, not the air */
export function ttsChunks(text) {
  const spoken = spokenForm(text);
  if (!spoken) return [];
  const sentences = [];
  let pos = 0;
  BOUNDARY.lastIndex = 0;
  let m;
  while ((m = BOUNDARY.exec(spoken))) {
    const end = m.index + m[0].length;
    if (!isRealBoundary(spoken.slice(pos, end))) continue;
    sentences.push(spoken.slice(pos, end).trim());
    pos = end;
  }
  if (spoken.slice(pos).trim()) sentences.push(spoken.slice(pos).trim());
  // glue fragments forward, then clause-split anything overlong
  const glued = [];
  for (const s of sentences) {
    if (glued.length && glued[glued.length - 1].length < MIN_LEN) glued[glued.length - 1] += ' ' + s;
    else glued.push(s);
  }
  const chunks = glued.flatMap(splitLong);
  if (!chunks.length) return chunks;
  return [...fastFirst(chunks[0]), ...chunks.slice(1)];
}
