// tts — the mouth: synthesizer, track generator, wall-clock pacer, sidetone, own-say bridge and benches; a synth
// provider for voicesource.js. Synthesis is always local: it scales with clients, not the room.

import { report, bus } from './base.js';
import { setSynthProvider, notifySynthTrackChanged } from './voicesource.js';
import { volumeFor } from './voiceconsent.js';
import { audioContext } from './audioctx.js';

// null = ordinary microphone; (text) => Promise<{pcm: Int16Array, sampleRate}>, so nothing here knows the engine
let ttsFn = null;
let ttsName = '';
let ttsEnabled = false;  // OFF by default: speaking is opt-in, like a mic

let genTrack = null;
let writer = null;

export const ttsAvailable = () => !!ttsFn;
export const ttsVoiceName = () => ttsName;
export const isTtsEnabled = () => ttsEnabled && !!ttsFn;

/** the one seam for humans and agents: an agent harness, a loaded engine, an endpoint voice; null reverts to the microphone */
export function setTtsSource(fn, name = 'TTS') {
  ttsFn = fn || null;
  ttsName = fn ? name : '';
  if (!fn) ttsEnabled = false;
}

// built-in speechSynthesis can't feed the seam (no route to an AudioNode; WICG/speech-api#69) — see docs/research/voice-sources.md

/** the audio panel's toggle; an agent turns it on once its source is registered */
export function setTtsEnabled(on) {
  const was = ttsEnabled;
  ttsEnabled = !!on && !!ttsFn;
  // with the mic live this only arms (mic beats TTS); with it off the takeover is here. No WebAudio mixing: stalls headless
  if (ttsEnabled !== was && typeof window !== 'undefined') {
    import('./micstate.js').then((v) => {
      // micstate's own read is false on an SFU client, and would fail open
      const micLive = (typeof window !== 'undefined' && typeof window.__sfuMicOn === 'function')
        ? !!window.__sfuMicOn() : v.micOn?.();
      if (ttsEnabled && canSynthesize() && !micLive) {
        startPacer(); notifySynthTrackChanged(ensureGenerator());
      } else if (!ttsEnabled) {
        stopPacer();
      }
    }).catch(() => {});
  }
  return ttsEnabled;
}

// ── the generator ───────────────────────────────────────────────────────────
// wall-clock pace, because a headless realtime AudioContext runs at ~1% and stalls; Chromium-only, silent elsewhere
const CHUNK_MS = 20;

export const canSynthesize = () => typeof MediaStreamTrackGenerator !== 'undefined';

// exported for the mic-off handover; nothing else should mint generators
export function ensureGenerator() {
  if (genTrack && genTrack.readyState === 'live') return genTrack;
  const replacing = !!genTrack;
  // a rebuilt track must reach the senders, or they transmit silence forever
  genTrack = new MediaStreamTrackGenerator({ kind: 'audio' });
  writer = genTrack.writable.getWriter();
  if (replacing) {
    console.warn('[voice] generator was dead — rebuilt; re-binding senders');
    notifySynthTrackChanged(genTrack);
  }
  return genTrack;
}

// serialize per speaker, synthesis included, or one speaker's lines reorder; different speakers may overlap
const _speakChains = new Map();
function chain(speaker, job) {
  const key = speaker || 'self';
  const prev = _speakChains.get(key) ?? Promise.resolve();
  const next = prev.then(job, job);
  const tail = next.catch(() => {});
  _speakChains.set(key, tail);
  // so a long-lived room keeps no promise per departed speaker
  tail.then(() => { if (_speakChains.get(key) === tail) _speakChains.delete(key); });
  return next;
}

/** a silent no-op when TTS is off, so callers needn't branch; omit `speaker` for your own voice */
export function speak(text, speaker) {
  return chain(speaker, () => speakChunked(text));
}

// synthesis runs ~real time on the main thread, so a whole paragraph froze the page; still blocks per chunk
async function speakChunked(text) {
  const { ttsChunks } = await import('./tts-chunk.js');
  const chunks = ttsChunks(text);
  if (!chunks.length) return false;
  if (chunks.length === 1) return speakOne(chunks[0]);
  // a mid-utterance stopPacer() must drop the rest too, or they play when the pacer restarts
  const epoch0 = ttsEpoch;
  let any = false;
  for (const c of chunks) {
    if (ttsEpoch !== epoch0) { console.warn('[voice] utterance cancelled between chunks — dropping the rest'); return any; }
    // sequential: synthesizing ahead reopens the race the speaker chain stops; the yield lets the page paint
    const ok = await speakOne(c);
    any = any || ok;
    await new Promise((r) => setTimeout(r, 0));
  }
  return any;
}

async function speakOne(text) {
  const epoch = ttsEpoch;
  // every refusal says why, or "nothing came out" is undiagnosable
  if (!isTtsEnabled()) { console.warn(`[voice] speak refused: tts off (enabled=${ttsEnabled} fn=${!!ttsFn})`); return false; }
  // sidetone can still play it locally
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
  if (epoch !== ttsEpoch) {
    console.warn('[voice] synthesis finished after a disable — result dropped (stale, not current)');
    return false;
  }
  enqueue(out.pcm, out.sampleRate);
  return true;
}

// ── the pacer: A MOUTH IS ALWAYS OPEN ──────────────────────────────────────
// write what wall time owes, speech or silence: a starved generator sends nothing, not quiet
// resample with a real filter: 22050→48000 isn't an integer ratio, and a cheap converter aliases short utterances
const OUT_RATE = 48000;
const FRAME = Math.round(OUT_RATE / 50);   // 20ms at the OUTPUT rate
let queue = [];            // Float32 at OUT_RATE
// a synthesis in flight across a disable is dropped on completion
let ttsEpoch = 0;
let qOff = 0;              // into queue[0]
let playhead = 0;          // samples emitted since the pacer started
let t0 = 0;
let pacer = null;

/** Sidetone: hear your own synthesized voice (speak() only feeds the sender). Off for renderers and spectators. */
// the page's one AudioContext, never a private one (#86): Chrome caps contexts at ~six, and a second can't join the gain graph
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

// rebuilt when the context identity changes
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

// AudioContext seconds: chunks schedule after each other, not at "now" (no chord)
let monitorHead = 0;
/** so a cancel can stop them, else the cancelled tail plays under the next */
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
    // shared, so it reaches scheduled chunks, AND context-tracked, or a new context is silent
    const g = monitorGain(monitorCtx);
    g.gain.value = 0.8 * volumeFor('tts');
    // sidetone only, never the outbound track: listeners own what they hear
    src.buffer = buf;
    src.connect(g);
    // schedule, don't fire: a bare start() stacks chunks
    const now = monitorCtx.currentTime;
    const at = Math.max(now, monitorHead);
    _monSources.add(src);
    src.onended = () => _monSources.delete(src);
    src.start(at);
    monitorHead = at + buf.duration;
  } catch (e) { console.warn('[voice] sidetone failed (still transmitting):', e?.message || e); }
}

/** WebAudio's own resampler, so WebRTC never uses a cheap one */
async function toOutRate(pcm, inRate) {
  // localStorage.eidoTtsResample = 'off': unverified whether resampling helps or double-resamples (rhasspy/piper#252)
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
  if (!Ctx) {
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
  // matching stats with the pcm probe exonerate the resampler
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
  monitor(pcm, sampleRate);
  // never gate on a sender: genTrack is built by startPacer(), so it would block the first utterance
  if (!canSynthesize()) return;
  // epoch-guarded at the push too: a disable can land during the async resample
  const epoch = ttsEpoch;
  void toOutRate(pcm, sampleRate)
    .then((f) => { if (epoch === ttsEpoch) queue.push(f); })
    .catch((e) => report('resample', e));
}

function fillSpeech(out) {
  let i = 0;
  while (i < out.length) {
    const head = queue[0];
    if (!head) break;
    const src = head;
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
    // a closed writer is not a null writer: the source swap closes the old writable
    if (genTrack?.readyState !== 'live') { ensureGenerator(); return; }
    const owed = Math.floor(((performance.now() - t0) / 1000) * OUT_RATE) - playhead;
    for (let n = 0; n + FRAME <= owed; n += FRAME) {
      const data = new Float32Array(FRAME);
      fillSpeech(data);
      try {
        // closed between the check and write(): swallow; next tick rebuilds
        void writer.write(new AudioData({
          format: 'f32', sampleRate: OUT_RATE, numberOfFrames: FRAME,
          numberOfChannels: 1, timestamp: Math.round((playhead / OUT_RATE) * 1e6), data,
        })).catch(() => {});
      } catch (e) { report('tts write', e); }
      playhead += FRAME;
    }
  }, 10);
}

/** The track stays live. */
export function stopPacer() {
  if (pacer) { clearInterval(pacer); pacer = null; }
  queue = []; qOff = 0;
  ttsEpoch++;
  // or the next utterance schedules behind cancelled audio
  monitorHead = 0;
  for (const s of _monSources) { try { s.stop(); } catch { /* already ended */ } }
  _monSources.clear();
}

/** probe seam */
export const mouthInfo = () => ({ pacing: !!pacer, queued: queue.length, playhead });

// ── speak your own says ─────────────────────────────────────────────────────
// realize/livechat.js emits 'speech' (#57; never trusting the author-controlled spoken flag); voiced through the
// ordinary sender, so distance, sliders and consent apply as for a mic
export function speakOwnSays(bus, myId) {
  bus.on('speech', async ({ actor, text, performed }) => {
    const mine = actor === myId();
    if (!mine) return;
    // a receipt-confirmed re-emit (#57): the voice leg already made the sound
    if (performed) return;
    if (!isTtsEnabled()) { console.warn(`[voice] own say NOT spoken — tts disabled`); return; }
    // discarded visibly under a live mic (#91): queuing would play old text when it drops; micstate reads false under SFU
    const micLive = (typeof window !== 'undefined' && typeof window.__sfuMicOn === 'function')
      ? !!window.__sfuMicOn() : (await import('./micstate.js')).micOn?.();
    if (micLive) { console.warn(`[voice] own say NOT synthesized — mic is live, mic beats TTS: "${String(text).slice(0, 40)}"`); return; }
    console.log(`[voice] own say → speaking: "${String(text).slice(0, 60)}"`);
    void speak(text, actor);
  });
}

/** speak() can succeed into an orphan generator while the room hears nothing */
export const genTrackInfo = () => (genTrack
  ? { id: genTrack.id, kind: genTrack.kind, readyState: genTrack.readyState, enabled: genTrack.enabled }
  : null);



/** P50 and best, since a mean hides the slow first call; localStorage.eidoTtsBackend = 'webgpu' tries the GPU backend (engine-piper.js) */
export async function ttsTTFS(text = 'hello there, this is a test', runs = 3) {
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


/** VITS samples noise every call, so one utterance is one draw */
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
// stop() leaves enablement standing: mic beats TTS is a priority, not a toggle
setSynthProvider({
  label: () => ttsName || 'TTS',
  available: () => isTtsEnabled() && canSynthesize(),
  start: () => { const t = ensureGenerator(); startPacer(); return t; },
  stop: () => stopPacer(),
});
