// tts — the mouth: the registered synthesizer, the MediaStreamTrackGenerator, the wall-clock pacer, the queue,
// the sidetone, the own-say bridge and the benches. Registers into voicesource.js as a synth provider
// (setSynthProvider), handing over a finished track. Synthesis is always local: it scales with clients, not the room.

import { report, bus } from './base.js';
import { setSynthProvider, notifySynthTrackChanged } from './voicesource.js';
import { volumeFor } from './voiceconsent.js';
import { audioContext } from './audioctx.js';

// The registered TTS source; null = ordinary microphone. fn: (text) => Promise<{pcm: Int16Array, sampleRate}>,
// a function pointer so nothing here knows what produces the samples.
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
// setTtsSource is the one seam for humans and agents. Built-in speechSynthesis can't feed it (no route to an
// AudioNode; WICG/speech-api#69); a source must return {pcm, sampleRate}. Until one is bundled the toggle stays disabled.

/** The audio panel's toggle. Humans leave this off and use a mic; an agent
 *  turns it on once its source is registered. */
export function setTtsEnabled(on) {
  const was = ttsEnabled;
  ttsEnabled = !!on && !!ttsFn;
  // Either order, one mechanism: TTS-on with the mic live only arms it (mic beats TTS; the mic-off path hands over
  // via rebindSenders); with the mic off the takeover is here, via replaceTrack. No WebAudio mixing: it stalls headless.
  if (ttsEnabled !== was && typeof window !== 'undefined') {
    import('./micstate.js').then((v) => {
      // ask the live transport: micstate's own read is null forever on an SFU client, and would fail open
      const micLive = (typeof window !== 'undefined' && typeof window.__sfuMicOn === 'function')
        ? !!window.__sfuMicOn() : v.micOn?.();
      if (ttsEnabled && canSynthesize() && !micLive) {
        startPacer(); notifySynthTrackChanged(ensureGenerator());
      } else if (!ttsEnabled) {
        // disable stills the producer; senders keep the (now silent) generator unless a live mic reclaimed them
        stopPacer();
      }
    }).catch(() => {});
  }
  return ttsEnabled;
}

// ── the generator ───────────────────────────────────────────────────────────
// MediaStreamTrackGenerator fed timestamped PCM at wall-clock pace: a realtime AudioContext in a headless browser
// runs its clock at ~1% and stalls. Chromium-only; without it an agent stays silent rather than throwing.
const CHUNK_MS = 20;

export const canSynthesize = () => typeof MediaStreamTrackGenerator !== 'undefined';

// A dead generator is replaced by a new track object; notifySynthTrackChanged hands it to the senders
// (replaceTrack, no renegotiation), or they transmit silence forever.
/** Test seam: fire the installed hook without having to kill a real generator
 *  (MediaStreamTrackGenerator does not exist under happy-dom). */

// exported for the mic-off handover; nothing else should mint generators
export function ensureGenerator() {
  if (genTrack && genTrack.readyState === 'live') return genTrack;
  const replacing = !!genTrack;
  // an ended generator is rebuilt and replaceTrack()ed onto the sender: no device, prompt or renegotiation
  genTrack = new MediaStreamTrackGenerator({ kind: 'audio' });
  writer = genTrack.writable.getWriter();
  if (replacing) {
    console.warn('[voice] generator was dead — rebuilt; re-binding senders');
    notifySynthTrackChanged(genTrack);   // voicesfubridge.js re-binds every sender
  }
  return genTrack;
}

// Serialize per speaker, synthesis included: concurrent `await ttsFn` overlapped and reordered one speaker's lines.
// Keyed by speaker on purpose: different people may talk at once (media-sfu.ts follows the same rule).
const _speakChains = new Map();   // speaker -> Promise
function chain(speaker, job) {
  const key = speaker || 'self';
  const prev = _speakChains.get(key) ?? Promise.resolve();
  // never let a rejection poison the chain
  const next = prev.then(job, job);
  const tail = next.catch(() => {});
  _speakChains.set(key, tail);
  // drop a settled tail so a long-lived room keeps no promise per departed speaker
  tail.then(() => { if (_speakChains.get(key) === tail) _speakChains.delete(key); });
  return next;
}

/** Speak text through the registered synthesizer. Silent no-op when TTS is off
 *  or unavailable — callers should not have to branch.
 *  `speaker` scopes the serialization; omit it for your own voice. */
export function speak(text, speaker) {
  return chain(speaker, () => speakChunked(text));
}

// Chunk utterances (tts-chunk.js, the sidecar's splitter): synthesis runs at about real time on the main thread, so a
// long paragraph froze the page. fastFirst() cuts a short opener for time-to-first-word. Still blocking per chunk; a
// Worker is the real fix.
async function speakChunked(text) {
  const { ttsChunks } = await import('./tts-chunk.js');
  const chunks = ttsChunks(text);
  if (!chunks.length) return false;          // emoji-only: in the log, not the air
  if (chunks.length === 1) return speakOne(chunks[0]);
  // one epoch for the whole utterance: a stopPacer() mid-utterance (mic takeover) must drop the remaining chunks too,
  // or they queue into a stopped pacer and play when it restarts
  const epoch0 = ttsEpoch;
  let any = false;
  for (const c of chunks) {
    if (ttsEpoch !== epoch0) { console.warn('[voice] utterance cancelled between chunks — dropping the rest'); return any; }
    // sequential by design (synthesizing ahead reopens the race the speaker chain stops); the yield lets the page paint
    const ok = await speakOne(c);
    any = any || ok;
    await new Promise((r) => setTimeout(r, 0));
  }
  return any;
}

async function speakOne(text) {
  const epoch = ttsEpoch;
  // every refusal says why: silent `return false`s made "nothing came out" undiagnosable
  if (!isTtsEnabled()) { console.warn(`[voice] speak refused: tts off (enabled=${ttsEnabled} fn=${!!ttsFn})`); return false; }
  // no sink is not a reason to refuse: sidetone can still play it locally; only transmission needs the lane
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
    // measure the samples (clipping, DC offset) before blaming the pacer for distortion
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
  // queue it, don't push it: the pacer below must never starve the track
  if (epoch !== ttsEpoch) {
    console.warn('[voice] synthesis finished after a disable — result dropped (stale, not current)');
    return false;
  }
  enqueue(out.pcm, out.sampleRate);
  return true;
}

// ── the pacer: A MOUTH IS ALWAYS OPEN ──────────────────────────────────────
// Every 10 ms write the frames wall time owes, speech or silence: a starved MediaStreamTrackGenerator sends nothing,
// not quiet. Resample to 48 kHz here with a real filter: 22050→48000 isn't an integer ratio, and a cheap converter
// aliases short utterances.
const OUT_RATE = 48000;
// the pacer speaks one rate, OUT_RATE
const FRAME = Math.round(OUT_RATE / 50);   // 20ms at the OUTPUT rate
let queue = [];            // pending {pcm, sampleRate}
// Disable epoch: a synthesis in flight when TTS is disabled is dropped on completion instead of re-enqueued.
let ttsEpoch = 0;
let qOff = 0;              // read offset into queue[0]
let playhead = 0;          // samples emitted since the pacer started
let t0 = 0;
let pacer = null;

/** Sidetone: play your own synthesized PCM locally (speak() only feeds the sender, so you'd never hear yourself).
 *  Off for renderers and spectators. */
// The sidetone plays through the PAGE's one AudioContext (audioctx.js), not a
// private one. A second context here is exactly the disease #86 exists to cure:
// it counts against Chrome's ~six-context cap and its output cannot compose with
// the shared gain graph (distance, category sliders, ambient bed).
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

// the shared sidetone gain: rebuilt when the context identity changes (see monitor())
let _monGain = null, _monGainCtx = null;
function monitorGain(ctx) {
  if (_monGainCtx !== ctx) {
    _monGain = ctx.createGain();
    _monGain.connect(ctx.destination);
    _monGainCtx = ctx;
  }
  return _monGain;
}
// the drag must land on audio already queued; guarded because the node may not exist yet
bus.on('audio:volume', ({ cat }) => {
  if (cat === 'tts' && _monGain) _monGain.gain.value = 0.8 * volumeFor('tts');
});

// sidetone playhead in AudioContext time: chunks schedule after each other, not at "now" (no chord)
let monitorHead = 0;
/** Every scheduled sidetone chunk, so a cancel can stop them (else you hear the cancelled tail under the next). */
const _monSources = new Set();


function monitor(pcm, sampleRate) {
  if (!monitorOn || !pcm?.length) return;
  try {
    const monitorCtx = audioContext();
    // a context created before a user gesture starts suspended
    if (monitorCtx.state === 'suspended') void monitorCtx.resume();
    const buf = monitorCtx.createBuffer(1, pcm.length, sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = monitorCtx.createBufferSource();
    // The gain must be shared (reaches already-scheduled chunks) AND context-tracked (rebuilt when audioContext()
    // returns a new context, or it's silent). Level re-applied per chunk and on the volume event.
    const g = monitorGain(monitorCtx);
    g.gain.value = 0.8 * volumeFor('tts');
    // Self-TTS volume scales the sidetone only, never the outbound track: listeners own what they hear (voices,
    // distance, consent). 0.8 is the baseline the slider rides.
    src.buffer = buf;
    src.connect(g);   // g is already wired to this context's destination
    // schedule, don't fire: a bare start() plays now, so chunked sidetone stacked; chunk N+1 starts when N ends
    const now = monitorCtx.currentTime;
    // behind the clock → now; ahead → after what is still playing
    const at = Math.max(now, monitorHead);
    // retained so stopPacer can reach scheduled audio; onended keeps the set bounded
    _monSources.add(src);
    src.onended = () => _monSources.delete(src);
    src.start(at);
    monitorHead = at + buf.duration;
  } catch (e) { console.warn('[voice] sidetone failed (still transmitting):', e?.message || e); }
}

/** Resample to OUT_RATE with WebAudio's own resampler (OfflineAudioContext), so WebRTC never uses a cheap one.
 *  Async: callers queue the result, not the raw pcm. */
async function toOutRate(pcm, inRate) {
  // switchable (localStorage.eidoTtsResample = 'off' hands WebRTC the native rate): unverified whether this improves
  // anything or double-resamples; the bad short utterances were missing punctuation (rhasspy/piper#252)
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
  // same probe as the pcm one, one stage later: matching stats exonerate the resampler
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
  // Not gated on a sender: canSynthesize() is browser support and genTrack is built by startPacer(), so gating would
  // block the first utterance. The pacer's `if (!writer)` makes a senderless queue harmless.
  if (!canSynthesize()) return;
  // Resample before queueing (one rate in the frame math); epoch-guarded at the push too, since the resample is async
  // and a disable can land in between.
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
    // a closed writer is not a null writer: the source swap closes the old track's writable, so rebuild instead
    if (genTrack?.readyState !== 'live') { ensureGenerator(); return; }
    const owed = Math.floor(((performance.now() - t0) / 1000) * OUT_RATE) - playhead;
    for (let n = 0; n + FRAME <= owed; n += FRAME) {
      const data = new Float32Array(FRAME);
      fillSpeech(data);
      try {
        // a stream closed between the liveness check and write() rejects async: swallow; next tick rebuilds
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
  // drop the sidetone playhead, or the next utterance schedules behind cancelled audio
  monitorHead = 0;
  // and stop sidetone audio already scheduled
  for (const s of _monSources) { try { s.stop(); } catch { /* already ended */ } }
  _monSources.clear();
}

/** Probe seam: is the mouth open, and how much is waiting to be said? */
export const mouthInfo = () => ({ pacing: !!pacer, queued: queue.length, playhead });

// ── speak your own says ─────────────────────────────────────────────────────
// livechat.js emits 'speech' for every say not already performed (voice capability + `performed` receipts, #57; never
// the author-controlled spoken flag). A body with a synthesizer voices its own through the ordinary sender, so
// distance, the category slider and consent apply as for a mic.
export function speakOwnSays(bus, myId) {
  bus.on('speech', async ({ actor, text, performed }) => {
    const mine = actor === myId();
    if (!mine) return;                       // someone else's say: not ours to voice
    // performed = a receipt-confirmed display re-emit (#57): the voice leg already made the sound
    if (performed) return;
    if (!isTtsEnabled()) { console.warn(`[voice] own say NOT spoken — tts disabled`); return; }
    // #91 B3: a typed say while the mic is live is discarded, visibly (mic beats TTS; queuing would play old text when
    // the mic drops). Ask the SFU's own read: micstate's is false for a live SFU mic.
    const micLive = (typeof window !== 'undefined' && typeof window.__sfuMicOn === 'function')
      ? !!window.__sfuMicOn() : (await import('./micstate.js')).micOn?.();
    if (micLive) { console.warn(`[voice] own say NOT synthesized — mic is live, mic beats TTS: "${String(text).slice(0, 40)}"`); return; }
    console.log(`[voice] own say → speaking: "${String(text).slice(0, 60)}"`);
    // keyed by speaker so consecutive says queue instead of overlapping
    void speak(text, actor);
  });
}

/** The generator track's identity, so a probe can check it's the object the sender sends: speak() can succeed while
 *  feeding an orphan generator and the room hears nothing. */
export const genTrackInfo = () => (genTrack
  ? { id: genTrack.id, kind: genTrack.kind, readyState: genTrack.readyState, enabled: genTrack.enabled }
  : null);



/** Benchmark the current voice: N runs of the same text; reports P50 and best (a mean hides the slow first call).
 *  Switch backend with localStorage.eidoTtsBackend = 'wasm', reload, re-run. */
export async function ttsTTFS(text = 'hello there, this is a test', runs = 3) {
  // TTFS = phonemize + infer + everything until audio exists; sidetone makes an agent its own instrument
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

export async function ttsBench(text = 'hello', runs = 5) {
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


/** Speak the same text N times to hear the spread: VITS samples noise every call, so one utterance is one draw. */
export async function ttsSpread(text = 'hello there', runs = 5) {
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
// voicesource.js owns the question; this module is one answer. available() = engine registered and TTS on;
// stop() stills the pacer but leaves enablement standing (mic beats TTS is a priority, not a toggle).
setSynthProvider({
  label: () => ttsName || 'TTS',
  available: () => isTtsEnabled() && canSynthesize(),
  start: () => { const t = ensureGenerator(); startPacer(); return t; },
  stop: () => stopPacer(),
});
