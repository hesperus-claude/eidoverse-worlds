// sound — what a `sound` component MEANS, shared verbatim by the browser host (client/lib/sounds.js) and the mcpl agent.
//   comp {id, type: "sound", data: {src, playing?, loop?, volume?, pitch?, near?, radius?, spatial?, t0?, alt?}}
//   comp {id, type: "sound", data: null}          # silence it
// An audio file playing FROM an entity: positional, louder the closer you stand.
// SOURCES: a library path under `eidoverse/assets/` or `store/audio/` (sniffed by bytes), or an https link gated per
// viewer by shared/mediasrc.js.
// THE CLOCK. `t0` is the authority's clock (epoch ms) when playback (re)started, stamped by the authority, so every
// listener and late joiner hears the same place: playhead = (serverNow - t0) mod duration when looping.
// ALT. A text-tier resident cannot hear: `alt` says what is playing (≤200 chars); nothing about the waveform is claimed.

import { mediaTier } from './mediasrc.js';
import { graphemes, quoted } from './text.js';

export const SOUND_DIR = 'eidoverse/assets/';
export const SOUND_STORE = 'store/audio/';
export const SOUND_DIRS = Object.freeze([SOUND_DIR, SOUND_STORE]);
const AUDIO_EXT = /\.(mp3|ogg|opus|wav|webm|m4a)$/i;
export const SOUND_ALT_MAX = 200;
export const SOUND_LOOK_MAX = SOUND_ALT_MAX;   // the old name
export const SOUND_MAX_RADIUS = 100;
// a placed sound plays (no start-paused); distance is what keeps it from covering the world
export const SOUND_DEFAULTS = Object.freeze({ playing: true, loop: true, volume: 0.8, pitch: 1, near: 1.5, radius: 12, spatial: true });
const KNOWN_KEYS = new Set(['src', 'playing', 'loop', 'volume', 'pitch', 'near', 'radius', 'spatial', 't0', 'alt']);

/** Same rule as pictures (shared/picture.js): under one of SOUND_DIRS, an audio extension; no scheme, leading slash,
 *  dot segments or percent-encoding; the parsed pathname byte-identical to the declared one. */
export function allowedSoundSrc(src) {
  if (typeof src !== 'string' || !src) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/') || src.includes('\\')) return false;
  if (/[%?#\s\u0000-\u001f\u007f]/.test(src)) return false;
  if (src.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  if (!SOUND_DIRS.some((d) => src.startsWith(d)) || !AUDIO_EXT.test(src)) return false;
  try {
    if (new URL(`/library/${src}`, 'http://library.invalid').pathname !== `/library/${src}`) return false;
  } catch { return false; }
  return true;
}

const num = (v, lo, hi, dflt) => {
  const n = Number(v);
  return v == null || !Number.isFinite(n) ? dflt : Math.min(hi, Math.max(lo, n));
};

// THE FALLOFF: BasisVR's voice curve (BasisVoiceAcoustics.cs, developer @ eac8e38): inverse-distance held at 1 inside near,
// times (1 − t)² over the last 5% of the range, so exactly 0 AT radius. Never Web Audio's `inverse`: it CLAMPS at maxDistance
// (a 12 m radio was heard at −21 dB across the whole world). The panner keeps only direction (rolloff 0); the gain is applied
// in client/lib/sounds.js's tick, so it is silent where the editor's sphere says.
export const TAPER_START = 0.95;
/** d metres: 1 inside near, inverse beyond, 0 at radius and past it. */
export function gainAt(d, near = SOUND_DEFAULTS.near, radius = SOUND_DEFAULTS.radius) {
  if (!(d >= 0)) return 0;
  if (d >= radius) return 0;
  const inv = near / Math.max(d, near);
  const t0 = TAPER_START * radius;
  if (d <= t0) return inv;
  const t = (d - t0) / (radius - t0);
  return inv * (1 - t) * (1 - t);
}

/** `ok:false` carries WHY; `ok:true` the normalized sound plus notes for anything coerced. src may be an https link:
 *  `tier` says who may fetch it (shared/mediasrc.js). */
export function normalizeSound(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, why: 'sound data must be an object {src, playing?, loop?, volume?, pitch?, near?, radius?, spatial?, t0?, alt?}' };
  }
  const tier = mediaTier(data.src, 'audio');
  if (tier.tier === 'bad') return { ok: false, why: `src: ${tier.why} — ${tier.fix}` };
  const notes = [];
  const unknown = Object.keys(data).filter((k) => !KNOWN_KEYS.has(k) && !k.startsWith('_'));
  if (unknown.length) notes.push(`ignored by the evaluator: ${unknown.join(', ')} (accepted: ${[...KNOWN_KEYS].join(', ')})`);
  const radius = num(data.radius, 1, SOUND_MAX_RADIUS, SOUND_DEFAULTS.radius);
  const sound = {
    src: data.src,
    playing: data.playing !== false,
    loop: data.loop !== false,
    volume: num(data.volume, 0, 1, SOUND_DEFAULTS.volume),
    pitch: num(data.pitch, 0.5, 2, SOUND_DEFAULTS.pitch),
    near: Math.min(radius, num(data.near, 0.01, SOUND_MAX_RADIUS, SOUND_DEFAULTS.near)),
    radius,
    spatial: data.spatial !== false,
  };
  if (data.t0 != null) {
    const t0 = Number(data.t0);
    if (Number.isFinite(t0) && t0 > 0) sound.t0 = t0;
    else notes.push('t0 is not an epoch-ms number — ignored; listeners will not agree on the playhead');
  } else if (sound.playing) notes.push('no t0 — the authority stamps one when it starts; without it each client starts from the top');
  if (data.alt != null) {
    const alt = String(data.alt).replace(/\s+/g, ' ').trim();
    if (graphemes(alt) > SOUND_ALT_MAX) return { ok: false, why: `alt is ${graphemes(alt).toLocaleString('en')} characters; it must be ≤ ${SOUND_ALT_MAX}` };   // the door's bound and words (checks.js maxLen)
    if (alt) sound.alt = alt;
  }
  if (!sound.alt) notes.push('no alt text — anyone who can\'t hear it (or reads the world as text) gets only the file name; say what is playing');
  return { ok: true, sound, tier, notes };
}

/** The one line look() carries, the same everywhere: what the author said is playing (quoted, as data), whether it is, how far
 *  it carries; never a claim about the audio. `now` (ms) lets a one-shot say how long ago it started. */
export function describeSound(data, now = null) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'a sound (malformed declaration)';
  const file = typeof data.src === 'string' ? (/^https:/i.test(data.src) ? (() => { try { return new URL(data.src).hostname; } catch { return 'a link'; } })() : data.src.split('/').pop()) : null;
  const alt = typeof data.alt === 'string' && data.alt.trim() ? data.alt : null;
  const ok = mediaTier(data.src, 'audio').tier !== 'bad';
  const radius = num(data.radius, 1, SOUND_MAX_RADIUS, SOUND_DEFAULTS.radius);
  let state;
  if (data.playing === false) state = 'paused';
  else if (data.loop === false) state = Number.isFinite(data.t0) && Number.isFinite(now) ? `last played ${Math.max(0, Math.round((now - data.t0) / 1000))} s ago (one-shot)` : 'a one-shot';
  else state = `playing (loops; heard within ${+radius.toFixed(1)} m)`;
  const tail = ok ? '' : ' (not heard: invalid declaration)';
  return alt ? `a sound, ${state}: ${quoted(alt, SOUND_ALT_MAX)}${tail}` : `a sound, ${state} (${file ?? 'no file'})${tail}`;
}
