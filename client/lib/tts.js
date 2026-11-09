// tts — THE MOUTH. Everything that makes samples: the registered synthesizer
// function, the MediaStreamTrackGenerator, the wall-clock pacer, the queue,
// the sidetone monitor, the own-say bridge, and the benches.
//
// The SEAM lives in voicesource.js; this module registers into it as a synth
// PROVIDER (setSynthProvider), handing over a finished MediaStreamTrack.
// voice.js and the mesh never import from here.
//
// LOCAL, always: synthesis on the client costs the server nothing and scales
// with clients rather than with the room. Design notes: docs/research/tts-mouth.md.

import { report, bus } from './base.js';
import { setSynthProvider, notifySynthTrackChanged } from './voicesource.js';
import { volumeFor } from './voiceconsent.js';
import { audioContext } from './audioctx.js';

// The registered TTS source. null = ordinary microphone.
//   fn: (text: string) => Promise<{pcm: Int16Array, sampleRate: number}>
// A *function pointer*, deliberately: an agent points at its own synthesizer
// and nothing here needs to know what produces the samples.
let ttsFn = null;
let ttsName = '';        // shown in the audio panel so it is never ambiguous
let ttsEnabled = false;  // OFF by default — speaking is opt-in, like a mic

let genTrack = null;     // the live MediaStreamTrackGenerator, if any
let writer = null;

export const ttsAvailable = () => !!ttsFn;
export const ttsVoiceName = () => ttsName;
export const isTtsEnabled = () => ttsEnabled && !!ttsFn;

/** Point this body's mouth at a synthesizer. Called by an agent harness, never
 *  by the UI. Passing null reverts to the microphone. */
export function setTtsSource(fn, name = 'TTS') {
  ttsFn = fn || null;
  ttsName = fn ? name : '';
  if (!fn) ttsEnabled = false;
}

// ── the human path to the SAME seam ─────────────────────────────────────────
// A human picking a voice and an agent registering one are the same call
// (setTtsSource); a UI is only ever a wrapper over it. The browser's built-in
// speechSynthesis CANNOT be a source (no route from speak() to samples); any
// synthesizer that returns {pcm, sampleRate} can (docs/research/tts-mouth.md).
// Until one is bundled the UI row stays disabled: "system default (microphone)".

/** The audio panel's toggle. Humans leave this off and use a mic; an agent
 *  turns it on once its source is registered. */
export function setTtsEnabled(on) {
  const was = ttsEnabled;
  ttsEnabled = !!on && !!ttsFn;
  // EITHER ORDER MUST WORK, ONE MECHANISM ONLY. Enabling TTS with the mic
  // already live arms it and touches nothing (MIC BEATS TTS; voice.js mic-off
  // does the takeover via rebindSenders). Enabling with the mic off does the
  // takeover HERE the same way: the generator goes on the sender via
  // replaceTrack. No WebAudio mixing path: its destination produces nothing
  // where the AudioContext clock stalls (every headless body).
  if (ttsEnabled !== was && typeof window !== 'undefined') {
    import('./micstate.js').then((v) => {
      // ASK THE LIVE TRANSPORT: v.micOn() reads voice.js's micStream, which is
      // null forever on an SFU client, so it would fail open here.
      const micLive = (typeof window !== 'undefined' && typeof window.__sfuMicOn === 'function')
        ? !!window.__sfuMicOn() : v.micOn?.();
      if (ttsEnabled && canSynthesize() && !micLive) {
        startPacer(); notifySynthTrackChanged(ensureGenerator());
      } else if (!ttsEnabled) {
        // Disable stills the producer; the senders keep the (now silent)
        // generator track unless a live mic already reclaimed them — the
        // same standing-lane rule the mic release uses.
        stopPacer();
      }
    }).catch(() => {});
  }
  return ttsEnabled;
}

// ── the generator ───────────────────────────────────────────────────────────
// MediaStreamTrackGenerator fed timestamped PCM at WALL-CLOCK pace: a realtime
// AudioContext in a headless browser runs its clock at ~1% and stalls.
// Chromium-only; elsewhere an agent falls back to the microphone path (silent)
// rather than throwing.
const CHUNK_MS = 20;

const canSynthesize = () => typeof MediaStreamTrackGenerator !== 'undefined';

// Fired when a DEAD generator is replaced by a live one: every sender still
// holding the old track would transmit silence forever. voice.js listens and
// replaceTrack()s it onto the existing senders (no renegotiation).
/** Test seam: fire the installed hook without having to kill a real generator
 *  (MediaStreamTrackGenerator does not exist under happy-dom). */

// Exported so the mic-off handover can wire the synth in (voice.js). Internal
// to the module otherwise — nothing else should be minting generators.
export function ensureGenerator() {
  if (genTrack && genTrack.readyState === 'live') return genTrack;
  const replacing = !!genTrack;
  // An ENDED generator is not a dead end: make a new one and hand it back; the
  // caller replaceTrack()s it (no device, no prompt, no renegotiation).
  genTrack = new MediaStreamTrackGenerator({ kind: 'audio' });
  writer = genTrack.writable.getWriter();
  if (replacing) {
    console.warn('[voice] generator was dead — rebuilt; re-binding senders');
    notifySynthTrackChanged(genTrack);   // voice.js re-binds every sender
  }
  return genTrack;
}

// ONE SPEAKER TALKS ONE AT A TIME. speak() awaits synthesis BEFORE enqueue(),
// so two says would synthesize concurrently and could overlap or reorder.
// Chained per speaker: two people talking at once is correct in a shared room;
// one person's consecutive utterances must not interleave.
const _speakChains = new Map();   // speaker -> Promise
function chain(speaker, job) {
  const key = speaker || 'self';
  const prev = _speakChains.get(key) ?? Promise.resolve();
  // Never let a rejection poison the chain: a failed utterance must not stop
  // the next one from being spoken.
  const next = prev.then(job, job);
  const tail = next.catch(() => {});
  _speakChains.set(key, tail);
  // Drop the entry once this is still the tail and it has settled, so a
  // long-lived room does not keep one promise per departed speaker.
  tail.then(() => { if (_speakChains.get(key) === tail) _speakChains.delete(key); });
  return next;
}

/** Speak text through the registered synthesizer. Silent no-op when TTS is off
 *  or unavailable — callers should not have to branch.
 *  `speaker` scopes the serialization; omit it for your own voice. */
export function speak(text, speaker) {
  return chain(speaker, () => speakChunked(text));
}

// LENGTH IS LATENCY: piper's RTF is ~1.1, so one long ort.run() freezes the
// main thread for as long as the audio lasts. tts_chunk.js splits like the
// sidecar, with an aggressive opening clause (time-to-first-word = synth of
// chunk 1). Chunks still run on the main thread; a Worker is the real cure.
async function speakChunked(text) {
  const { ttsChunks } = await import('./tts_chunk.js');
  const chunks = ttsChunks(text);
  if (!chunks.length) return false;          // emoji-only: in the log, not the air
  if (chunks.length === 1) return speakOne(chunks[0]);
  // ONE EPOCH FOR THE WHOLE UTTERANCE: a stopPacer() mid-utterance (mic
  // takeover) must kill every later chunk too, not only the one in flight.
  const epoch0 = ttsEpoch;
  let any = false;
  for (const c of chunks) {
    if (ttsEpoch !== epoch0) { console.warn('[voice] utterance cancelled between chunks — dropping the rest'); return any; }
    // Sequential BY DESIGN: the queue plays in order, and synthesizing ahead
    // would put us right back into the race the speaker chain exists to stop.
    // Yielding between chunks lets the page paint — the whole point.
    const ok = await speakOne(c);
    any = any || ok;
    await new Promise((r) => setTimeout(r, 0));
  }
  return any;
}

async function speakOne(text) {
  const epoch = ttsEpoch;
  // EVERY REFUSAL SAYS WHY, so "nothing came out" is distinguishable (TTS off,
  // no sender, empty synthesis).
  if (!isTtsEnabled()) { console.warn(`[voice] speak refused: tts off (enabled=${ttsEnabled} fn=${!!ttsFn})`); return false; }
  // NO SINK IS NOT NO REASON TO SPEAK: sidetone still plays locally; only
  // TRANSMISSION needs the lane. Say which of the two happened.
  if (!canSynthesize() && !sidetone()) {
    console.warn('[voice] speak refused: no generator sink and sidetone off');
    return false;
  }
  console.log(`[voice] synthesizing ${text.length} chars…`);
  let out;
  try {
    out = await ttsFn(text);
  } catch (e) { report('tts synthesize', e); return false; }
  if (!out?.pcm?.length) { console.warn('[voice] synthesizer returned no pcm'); return false; }
    // IS THE PCM ITSELF CLEAN? Clipping and DC offset both sound like
    // distortion; measure them before blaming the pacer.
    {
      const pcm = out.pcm;
      let peak = 0, sum = 0, clipped = 0;
      for (let i = 0; i < pcm.length; i++) {
        const v = pcm[i]; const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        if (a >= 32767) clipped++;
        sum += v;
      }
      const dc = sum / pcm.length;
      console.log(`[voice] pcm: ${pcm.length} samples @${out.sampleRate}Hz `
        + `peak ${(peak / 32768).toFixed(3)} (${(20 * Math.log10(peak / 32768 || 1e-9)).toFixed(1)} dBFS) `
        + `dc ${(dc / 32768).toFixed(4)} clipped ${clipped}`
        + (clipped > pcm.length * 0.001 ? '  ⚠️ CLIPPING' : '')
        + (Math.abs(dc / 32768) > 0.01 ? '  ⚠️ DC OFFSET' : ''));
    }
  // QUEUE IT — DO NOT PUSH IT. The frames are handed to a wall-clock pacer that
  // is already running; see the pacer below for why the track must never starve.
  if (epoch !== ttsEpoch) {
    console.warn('[voice] synthesis finished after a disable — result dropped (stale, not current)');
    return false;
  }
  enqueue(out.pcm, out.sampleRate);
  return true;
}

// ── the pacer: A MOUTH IS ALWAYS OPEN ──────────────────────────────────────
// A 10ms pacer writes exactly as many frames as wall time OWES: speech when
// there is speech, SILENCE when not, like a microphone. A starved generator is
// a track with nothing to encode, and the room hears nothing.
//
// Output is resampled to 48k ourselves, once, with a real filter (resampleTo):
// piper emits 22050 Hz and a cheap converter aliases (docs/research/tts-mouth.md).
const OUT_RATE = 48000;
const FRAME = Math.round(OUT_RATE / 50);   // 20ms at the OUTPUT rate
let queue = [];            // pending {pcm, sampleRate}
// Disable epoch: a synthesis in flight when TTS is disabled completes after
// stopPacer cleared the queue; speak() captures the epoch first and drops its
// result if a disable happened in between.
let ttsEpoch = 0;
let qOff = 0;              // read offset into queue[0]
let playhead = 0;          // samples emitted since the pacer started
let t0 = 0;
let pacer = null;

/** SIDETONE — hearing your own synthesized voice. speak() feeds the SENDER, so
 *  without this you are the one person who cannot hear you. Fed from our own
 *  PCM before pacing (exact, no round trip). Off for renderers/spectators. */
// Through the PAGE's one AudioContext (audioctx.js), never a private one: it
// counts against Chrome's ~six-context cap and can't join the shared gain graph.
let monitorOn = (() => {
  try { return localStorage.getItem('eido.ttsSidetone') !== 'off'; } catch { return true; }
})();
export const sidetone = (on) => {
  if (on !== undefined) {
    monitorOn = !!on;
    try { localStorage.setItem('eido.ttsSidetone', on ? 'on' : 'off'); } catch { /* private mode */ }
  }
  return monitorOn;
};

// The shared sidetone gain (see its use site).
let _monGain = null, _monGainCtx = null;
function monitorGain(ctx) {
  if (_monGainCtx !== ctx) {
    _monGain = ctx.createGain();
    _monGain.connect(ctx.destination);
    _monGainCtx = ctx;
  }
  return _monGain;
}
// The drag must land on audio ALREADY queued (v1's failure). Guarded: the bus
// exists at module load, the node may not.
bus.on('audio:volume', ({ cat }) => {
  if (cat === 'tts' && _monGain) _monGain.gain.value = 0.8 * volumeFor('tts');
});

// Where the sidetone has played up to, in AudioContext time. Chunks schedule
// against this rather than against "now", so a burst of fast synthesis lands as
// consecutive speech instead of a chord.
let monitorHead = 0;
/** Every sidetone chunk currently scheduled, so a cancel (stopPacer) can STOP
 *  them and you don't keep hearing a cancelled tail. */
const _monSources = new Set();


function monitor(pcm, sampleRate) {
  if (!monitorOn || !pcm?.length) return;
  try {
    const monitorCtx = audioContext();
    // A context created before a user gesture starts suspended; a resume() that
    // never lands must not throw away the sample.
    if (monitorCtx.state === 'suspended') void monitorCtx.resume();
    const buf = monitorCtx.createBuffer(1, pcm.length, sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = monitorCtx.createBufferSource();
    // ONE shared gain node per AudioContext, needing both properties: shared
    // (a drag reaches audio already scheduled ahead) and context-tracked
    // (rebuilt when the context identity changes, never orphaned on a dead one).
    // Level is re-applied per chunk AND on the volume bus event.
    const g = monitorGain(monitorCtx);
    g.gain.value = 0.8 * volumeFor('tts');
    // Self-TTS volume scales the SIDETONE only, never the outbound track: a
    // listener owns what they hear ('voices', distance, consent), a speaker
    // owns what they monitor. 0.8 is the baseline the slider rides.
    src.buffer = buf;
    src.connect(g);   // g is already wired to this context's destination
    // SCHEDULE, DO NOT FIRE: chunks synthesize faster than they play, so a
    // bare src.start() stacks them. The sidetone keeps its own playhead: chunk
    // N+1 starts when chunk N ends.
    const now = monitorCtx.currentTime;
    // Behind the clock (a gap in speaking, or the very first chunk) → start
    // now. Ahead of it → queue after what is still playing.
    const at = Math.max(now, monitorHead);
    // Retained so cancellation can reach audio that is already scheduled —
    // see stopPacer. onended keeps the set from growing past what is queued.
    _monSources.add(src);
    src.onended = () => _monSources.delete(src);
    src.start(at);
    monitorHead = at + buf.duration;
  } catch (e) { console.warn('[voice] sidetone failed (still transmitting):', e?.message || e); }
}

/** Resample to OUT_RATE with WebAudio's own (good) resampler, so WebRTC never
 *  uses a cheap one (OfflineAudioContext renders with the filter the monitor
 *  path gets). Async: callers queue the RESULT. */
async function toOutRate(pcm, inRate) {
  // SWITCHABLE: never verified to beat the browser's own resample (the symptom
  // it targeted was missing terminal punctuation, rhasspy/piper#252).
  //   localStorage.eidoTtsResample = 'off'   → hand WebRTC the native rate
  // A/B it by ear; the probe below prints what each path produces.
  try {
    if (localStorage.getItem('eidoTtsResample') === 'off') {
      const f = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
      return f;
    }
  } catch { /* private mode */ }
  if (inRate === OUT_RATE) {
    const f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
    return f;
  }
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctx) {                                  // no offline context: send as-is
    const f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
    return f;
  }
  const outLen = Math.ceil((pcm.length * OUT_RATE) / inRate);
  const ctx = new Ctx(1, outLen, OUT_RATE);
  const buf = ctx.createBuffer(1, pcm.length, inRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  const outCh = rendered.getChannelData(0);
  // Same measurement the pcm probe makes, one stage later. Clean in + dirty out
  // here would be conclusive; matching stats mean the resampler is exonerated
  // and the fault is further down (pacer, generator, or Opus).
  {
    let peak = 0, sum = 0;
    for (let i = 0; i < outCh.length; i++) { const a = Math.abs(outCh[i]); if (a > peak) peak = a; sum += a * a; }
    console.log(`[voice] resampled ${pcm.length}@${inRate} → ${outCh.length}@${OUT_RATE} `
      + `peak ${peak.toFixed(3)} rms ${Math.sqrt(sum / (outCh.length || 1)).toFixed(4)}`
      + (peak > 0.999 ? '  ⚠️ CLIPPING INTRODUCED' : ''));
  }
  return outCh;
}


function enqueue(pcm, sampleRate) {
  monitor(pcm, sampleRate);          // hear yourself, then send
  // Deliberately NOT gated on having a sender: canSynthesize() tests SUPPORT,
  // and genTrack is created inside startPacer(), so gating would block the
  // first utterance. The pacer's `if (!writer) return` makes a senderless
  // queue harmless.
  if (!canSynthesize()) return;
  // Resample BEFORE queueing so the pacer only handles OUT_RATE floats. The
  // push is EPOCH-GUARDED too: the resample is async and a disable can land
  // in between.
  const epoch = ttsEpoch;
  void toOutRate(pcm, sampleRate)
    .then((f) => { if (epoch === ttsEpoch) queue.push(f); })
    .catch((e) => report('resample', e));
}

function fillSpeech(out) {
  let i = 0;
  while (i < out.length) {
    const head = queue[0];
    if (!head) break;                       // nothing queued → leave silence
    const src = head;                       // already Float32 at OUT_RATE
    const n = Math.min(out.length - i, src.length - qOff);
    for (let k = 0; k < n; k++) out[i + k] = src[qOff + k];
    i += n; qOff += n;
    if (qOff >= src.length) { queue.shift(); qOff = 0; }
  }
}

export function startPacer() {
  if (pacer) return;
  ensureGenerator();
  t0 = performance.now();
  playhead = 0;
  pacer = setInterval(() => {
    if (!writer) return;
    // A CLOSED WRITER IS NOT A NULL WRITER: a source swap stops the old
    // generator and closes its writable, so write() would reject every tick.
    // ensureGenerator() rebuilds it and re-binds every sender.
    if (genTrack?.readyState !== 'live') { ensureGenerator(); return; }
    const owed = Math.floor(((performance.now() - t0) / 1000) * OUT_RATE) - playhead;
    for (let n = 0; n + FRAME <= owed; n += FRAME) {
      const data = new Float32Array(FRAME);
      fillSpeech(data);
      try {
        // a stream closed between the liveness check and write() rejects
        // async: swallow exactly that; the next tick's check owns the rebuild.
        void writer.write(new AudioData({
          format: 'f32', sampleRate: OUT_RATE, numberOfFrames: FRAME,
          numberOfChannels: 1, timestamp: Math.round((playhead / OUT_RATE) * 1e6), data,
        })).catch(() => {});
      } catch (e) { report('tts write', e); }
      playhead += FRAME;
    }
  }, 10);
}

/** Stop pacing (releases the interval). The track stays live. */
export function stopPacer() {
  if (pacer) { clearInterval(pacer); pacer = null; }
  queue = []; qOff = 0;
  ttsEpoch++;              // anything still synthesizing belongs to the old era
  // Drop the sidetone playhead with the queue, or the next utterance
  // schedules itself behind audio that was just cancelled.
  monitorHead = 0;
  // ...and stop the sidetone audio that is ALREADY scheduled — a cancelled
  // utterance must fall silent in your own ears too, not only in the room.
  for (const s of _monSources) { try { s.stop(); } catch { /* already ended */ } }
  _monSources.clear();
}

/** Probe seam: is the mouth open, and how much is waiting to be said? */
export const mouthInfo = () => ({ pacing: !!pacer, queued: queue.length, playhead });

/** What voice.js calls instead of getUserMedia. Returns a MediaStream from
 *  whichever source this body uses. */

// ── speak your own says ─────────────────────────────────────────────────────
// livechat.js emits 'speech' for every say not already performed (voice
// CAPABILITY + `performed` receipts, #57; never the author-controlled spoken
// flag). A body with a synthesizer voices its OWN through the ordinary sender,
// so distance, the category slider and consent apply as to a microphone.
export function speakOwnSays(bus, myId) {
  bus.on('speech', async ({ actor, text, performed }) => {
    const mine = actor === myId();
    if (!mine) return;                       // someone else's say: not ours to voice
    // performed = a receipt-confirmed display re-emit (#57): the voice leg
    // already made the sound; this event exists for bubbles/mouth only
    if (performed) return;
    if (!isTtsEnabled()) { console.warn(`[voice] own say NOT spoken — tts disabled`); return; }
    // Declared policy: a typed say while the mic is live is DISCARDED, visibly
    // (mic beats TTS; queuing would play stale text when the mic drops). Read
    // the LIVE transport: on the SFU, micstate's micOn() misses a live mic.
    const micLive = (typeof window !== 'undefined' && typeof window.__sfuMicOn === 'function')
      ? !!window.__sfuMicOn() : (await import('./micstate.js')).micOn?.();
    if (micLive) { console.warn(`[voice] own say NOT synthesized — mic is live, mic beats TTS: "${String(text).slice(0, 40)}"`); return; }
    console.log(`[voice] own say → speaking: "${String(text).slice(0, 60)}"`);
    // Keyed by the speaker so consecutive says QUEUE instead of overlapping.
    void speak(text, actor);
  });
}

/** Is the track we feed the same object the peer connection is sending? speak()
 *  can succeed into an orphan generator while the room hears nothing; this
 *  exposes the identity for a probe to compare against the sender's track. */
export const genTrackInfo = () => (genTrack
  ? { id: genTrack.id, kind: genTrack.kind, readyState: genTrack.readyState, enabled: genTrack.enabled }
  : null);



/** Benchmark the current voice: N runs of the same text, reporting the spread.
 *
 *      await ttsBench('hello')                     // current backend
 *      localStorage.eidoTtsBackend = 'wasm'        // then reload and re-run
 *
 *  Reports P50 and best rather than a mean: a mean hides the slow first call. */
async function ttsTTFS(text = 'hello there, this is a test', runs = 3) {
  // TIME TO FIRST SOUND (TTFS): what a listener experiences, phonemize + infer
  // + everything until audio exists, measured via self-monitoring. Not `infer`.
  if (!isTtsEnabled() || !ttsFn) { console.warn('[ttfs] no voice loaded'); return null; }
  const out = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = await ttsFn(text);
    const ttfs = performance.now() - t0;
    const secs = (r?.pcm?.length || 0) / (r?.sampleRate || 22050);
    out.push({ ttfs, secs });
  }
  out.sort((a, b) => a.ttfs - b.ttfs);
  const p50 = out[Math.floor(out.length / 2)];
  console.log(`[ttfs] ${JSON.stringify(text)} ×${runs}: `
    + `best ${Math.round(out[0].ttfs)}ms · P50 ${Math.round(p50.ttfs)}ms `
    + `→ ${p50.secs.toFixed(2)}s audio · RTF ${(p50.ttfs / 1000 / Math.max(p50.secs, 1e-6)).toFixed(3)}`);
  return { best: out[0].ttfs, p50: p50.ttfs, secs: p50.secs };
}
if (typeof window !== 'undefined') window.ttsTTFS = ttsTTFS;

async function ttsBench(text = 'hello', runs = 5) {
  if (!isTtsEnabled() || !ttsFn) { console.warn('[bench] no voice loaded'); return null; }
  const ms = [];
  let secs = 0;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    const out = await ttsFn(text);
    ms.push(performance.now() - t);
    secs = (out?.pcm?.length || 0) / (out?.sampleRate || 22050);
  }
  ms.sort((a, b) => a - b);
  const p50 = ms[Math.floor(ms.length / 2)];
  console.log(`[bench] ${JSON.stringify(text)} ×${runs}: `
    + `best ${Math.round(ms[0])}ms · P50 ${Math.round(p50)}ms · worst ${Math.round(ms.at(-1))}ms `
    + `→ ${secs.toFixed(2)}s audio · RTF ${(p50 / 1000 / Math.max(secs, 1e-6)).toFixed(3)}`);
  return { best: ms[0], p50, worst: ms.at(-1), secs };
}
if (typeof window !== 'undefined') window.ttsBench = ttsBench;


/** Speak the same text N times to hear the SPREAD: VITS samples noise on every
 *  call, so one utterance is one draw. */
async function ttsSpread(text = 'hello there', runs = 5) {
  if (!isTtsEnabled() || !ttsFn) { console.warn('[spread] no voice loaded'); return null; }
  const rows = [];
  for (let i = 0; i < runs; i++) {
    const r = await ttsFn(text);
    const pcm = r?.pcm || [];
    let peak = 0, sum = 0;
    for (let k = 0; k < pcm.length; k++) { const a = Math.abs(pcm[k]); if (a > peak) peak = a; sum += a * a; }
    rows.push({ n: pcm.length, peak: peak / 32768, rms: Math.sqrt(sum / (pcm.length || 1)) / 32768 });
  }
  const lens = rows.map((r) => r.n);
  const spread = (Math.max(...lens) - Math.min(...lens)) / Math.max(...lens) * 100;
  console.log(`[spread] ${JSON.stringify(text)} ×${runs}: `
    + `${Math.min(...lens)}-${Math.max(...lens)} samples (${spread.toFixed(1)}% length spread)`);
  rows.forEach((r, i) => console.log(`  run ${i + 1}: ${r.n} samples  peak ${r.peak.toFixed(3)}  rms ${r.rms.toFixed(4)}`));
  return { spread, rows };
}
if (typeof window !== 'undefined') window.ttsSpread = ttsSpread;

// ── the provider registration ────────────────────────────────────────────────
// voicesource.js owns the QUESTION (where does this body's voice come from);
// this module is one ANSWER. available() is enablement AND capability — a
// registered engine with TTS switched on. start() hands the generator track
// over with the pacer running; stop() stills the pacer but leaves enablement
// standing (mic beats TTS is a priority, not a toggle).
setSynthProvider({
  label: () => ttsName || 'TTS',
  available: () => isTtsEnabled() && canSynthesize(),
  start: () => { const t = ensureGenerator(); startPacer(); return t; },
  stop: () => stopPacer(),
});
