/** Piper as a voice-engine plugin: every piper specific (the two-file shape, OPFS seeding, PATH_MAP) lives here.
 *  WASM latency is the HiFi-GAN vocoder's; INT8 is slower here and WebGPU is opt-in (docs/research/piper-latency.md). */
import { registerEngine } from './voiceengines.js';
import { setTtsSource } from './tts.js';
import { decodeWavToPcm } from './wavpcm.js';

let engine = null;
let _phonCost = 0;
const runtime = async () => (engine ??= await import('@mintplex-labs/piper-tts-web'));

registerEngine({
  id: 'piper',
  label: 'Piper',
  accept: ['.onnx', '.json'],

  // OPFS is not optional: local files reach the runtime only through its cache
  supported: () => typeof WebAssembly === 'object' && !!navigator.storage?.getDirectory,

  // a score: a lone .onnx may be another engine's (1), a .onnx + .onnx.json pair is Piper (3); the highest wins
  match: (files) => {
    const onnx = files.find((f) => f.name.toLowerCase().endsWith('.onnx'));
    if (!onnx) return 0;
    const want = `${onnx.name.toLowerCase()}.json`;
    const paired = files.some((f) => f.name.toLowerCase() === want);
    if (paired) return 3;
    // any .json beside it: probably the config under another name
    return files.some((f) => f.name.toLowerCase().endsWith('.json')) ? 2 : 1;
  },

  async load(files, onProgress = () => {}) {
    const onnx = files.find((f) => f.name.toLowerCase().endsWith('.onnx'));
    const cfg = files.find((f) => f.name.toLowerCase().endsWith('.json'));
    if (!onnx) throw new Error('Piper needs the .onnx model file');
    // the config's phoneme map, sample rate and espeak language aren't recoverable from the model
    if (!cfg) throw new Error(`Piper also needs ${onnx.name}.json — it holds the phoneme map and sample rate`);

    // phases, not percentages: the long silent wait is InferenceSession.create(), and a fake percentage would lie
    onProgress({ phase: 'runtime', text: 'loading runtime…' });
    const e = await runtime();
    // the cache key carries BOTH digests (#91): two voices sharing a filename, or one model with two configs, never share bytes
    const hex = (buf, n) => Array.from(new Uint8Array(buf).slice(0, n))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    const [modelBuf, cfgBuf] = await Promise.all([
      crypto.subtle.digest('SHA-256', await onnx.arrayBuffer()),
      crypto.subtle.digest('SHA-256', await cfg.arrayBuffer()),
    ]);
    const base = `${onnx.name.replace(/\.onnx$/i, '')}-${hex(modelBuf, 6)}-${hex(cfgBuf, 4)}`;
    // the panel shows the filename; `base` (with digests) stays the cache key
    const humanName = onnx.name.replace(/\.onnx$/i, '');

    // no seam for local bytes, but getBlob() reads OPFS first, by basename: seeded there, it never hits the network
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('piper', { create: true });
    const totalMb = Math.round(onnx.size / 1e6);
    for (const [name, file] of [[`${base}.onnx`, onnx], [`${base}.onnx.json`, cfg]]) {
      const h = await dir.getFileHandle(name, { create: true });
      const w = await h.createWritable();
      const big = file.size > 4e6;
      if (big) {
        const CHUNK = 4 << 20;
        for (let off = 0; off < file.size; off += CHUNK) {
          const slice = file.slice(off, Math.min(off + CHUNK, file.size));
          await w.write(await slice.arrayBuffer());
          onProgress({
            phase: 'copy', pct: Math.round(((off + CHUNK) / file.size) * 100),
            text: `copying ${totalMb} MB — ${Math.min(100, Math.round(((off + CHUNK) / file.size) * 100))}%`,
          });
        }
      } else {
        await w.write(await file.arrayBuffer());
      }
      await w.close();
    }
    if (e.PATH_MAP && !e.PATH_MAP[base]) e.PATH_MAP[base] = `${base}.onnx`;

    let sr = null;
    try { sr = JSON.parse(await cfg.text())?.audio?.sample_rate ?? null; } catch { /* label only */ }

    // TtsSession is a singleton that ignores voiceId after its first construction: drop it, or a second voice speaks as the first
    if (e.TtsSession._instance) e.TtsSession._instance = null;

    // our own ORT session, bypassing predict() (hardcoded CDNs; rebuilds the phonemizer every call)
    const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
    // the importmap maps only "onnxruntime-web": the webgpu bundle goes by PATH, falling back to the mapped default
    const ort = await (async () => {
      if (hasGpu) {
        try {
          const url = new URL('../node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs',
                              import.meta.url).href;
          return await import(/* @vite-ignore */ url);
        } catch (e) {
          console.warn('[voice] webgpu bundle unavailable, using the default build:', e?.message || e);
        }
      }
      return import('onnxruntime-web');
    })();
    const cfgJson = JSON.parse(await cfg.text());
    const espeakVoice = cfgJson?.espeak?.voice || 'en-us';
    const inf = cfgJson?.inference || {};
    const wasmPaths = {
      piperData: new URL('../vendor/piper/piper_phonemize.data', import.meta.url).href,
      piperWasm: new URL('../vendor/piper/piper_phonemize.wasm', import.meta.url).href,
    };
      // report what we got: without cross-origin isolation ORT silently runs single-threaded while numThreads reads high
      const cores = navigator.hardwareConcurrency || 4;
      const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
      const sab = typeof SharedArrayBuffer !== 'undefined';
      ort.env.wasm.numThreads = isolated && sab ? Math.min(cores, 8) : 1;
      ort.env.wasm.simd = true;
      ort.env.wasm.wasmPaths = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url).href;
      console.log(`[voice] ORT: ${cores} cores · crossOriginIsolated=${isolated} · `
        + `SharedArrayBuffer=${sab} · numThreads=${ort.env.wasm.numThreads}`
        + (isolated && sab ? '' : '  ⚠️ SINGLE-THREADED — isolation headers missing'));

      const buf = await onnx.arrayBuffer();
      // create() is silent for 30+ s: count seconds UP, never a fake fraction; the finally below must clear it
      const compileT0 = performance.now();
      const ticker = setInterval(() => {
        const s = Math.round((performance.now() - compileT0) / 1000);
        onProgress({ phase: 'compile', elapsed: s, text: `compiling voice model — ${s}s` });
      }, 1000);
      onProgress({ phase: 'compile', elapsed: 0, text: 'compiling voice model…' });
      // speak() closes over these. Sequential: parallel measured ~21% slower; 'all' measured ~28% faster than 'basic'
      const opts = { graphOptimizationLevel: 'all' };
      let ortSession = null, usedEP = 'wasm';
      try {
      // localStorage.eidoTtsBackend = 'webgpu' tries the GPU, anything else is WASM: measure with ttsBench(), don't assume it wins
      const pref = (() => { try { return localStorage.getItem('eidoTtsBackend'); } catch { return null; } })();
      // opt-in: some VITS kernels fail at inference, not load, and WASM often wins on short speech; verbose logs the ops — see docs/research/piper-latency.md
      if (hasGpu && pref === 'webgpu') {
        ort.env.debug = true;
        ort.env.logLevel = 'verbose';
        try {
          const t = performance.now();
          ortSession = await ort.InferenceSession.create(buf, { ...opts, executionProviders: ['webgpu'] });
          usedEP = 'webgpu';
          console.log(`[voice] ORT session on WEBGPU in ${Math.round(performance.now() - t)}ms`);
        } catch (e) {
          console.warn('[voice] webgpu unavailable, falling back to wasm:', e?.message || e);
        }
      }
      if (!ortSession) {
        const t = performance.now();
        ortSession = await ort.InferenceSession.create(buf, { ...opts, executionProviders: ['wasm'] });
        console.log(`[voice] ORT session on WASM in ${Math.round(performance.now() - t)}ms`);
      }
      console.log(`[voice] inference backend: ${usedEP}`);
      } finally { clearInterval(ticker); }

    const { phonemize, phonReady, warmPhonemizer } = await import('./piperphon.js');
    // BUILD THE PHONEMIZER NOW (~27 s): inside the load being watched, not in front of the first utterance
    await warmPhonemizer(wasmPaths, onProgress);

    const speak = async (text) => {
      const t0 = performance.now();
      const warm = phonReady();
      // short utterances need terminal punctuation (rhasspy/piper#252): a bare "hello" is out of distribution for VITS
      const spoken = /[.!?…,;:]\s*$/.test(text.trim()) ? text : `${text.trim()}.`;
      const ids = await phonemize(spoken, espeakVoice, wasmPaths);
      const t1 = performance.now();
      const feeds = {
        input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
        input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)])),
        scales: new ort.Tensor('float32', Float32Array.from([
          // noise_w: duration noise (0.8 varies length ~6% on identical ids). length_scale sets pace AND cost.
          // localStorage.eidoTtsLengthScale overrides the voice's length_scale for A/B — see docs/research/piper-latency.md
          inf.noise_scale ?? 0.667,
          (() => { try { const v = parseFloat(localStorage.getItem('eidoTtsLengthScale')); return Number.isFinite(v) ? v : (inf.length_scale ?? 1.0); } catch { return inf.length_scale ?? 1.0; } })(),
          inf.noise_w ?? 0.8,
        ])),
      };
        // the fallback covers run(), not just create(): an op can fail at inference after a clean create
        let res;
        try {
          res = await ortSession.run(feeds);
        } catch (e) {
          if (usedEP !== 'webgpu') throw e;
          console.warn('[voice] webgpu kernel failed, rebuilding on wasm:', e?.message || e);
          ortSession = await ort.InferenceSession.create(buf, { ...opts, executionProviders: ['wasm'] });
          usedEP = 'wasm';
          res = await ortSession.run(feeds);
        }
      const t2 = performance.now();
      const raw = res[ortSession.outputNames[0]].data;      // Float32Array, -1..1
      const pcmData = new Int16Array(raw.length);
      for (let k = 0; k < raw.length; k++) {
        pcmData[k] = Math.max(-32768, Math.min(32767, Math.round(raw[k] * 32767)));
      }
      const rate = sr || 22050;
      const secs = pcmData.length / rate;
      console.log(`[voice] phonemize ${Math.round(t1 - t0)}ms${warm ? '' : ' (first, builds the module)'}`
        + ` · infer ${Math.round(t2 - t1)}ms · ${secs.toFixed(2)}s audio`
        + ` · RTF ${((t2 - t0) / 1000 / Math.max(secs, 1e-6)).toFixed(3)}` + ` · ${usedEP}`);
      return { pcm: pcmData, sampleRate: rate };
    };
    const label = `Piper: ${humanName}${sr ? ` (${sr} Hz)` : ''}`;
    setTtsSource(speak, label);
    // the exact identity (two same-named voices) travels as id
    return { speak, label, id: base };
  },
});
