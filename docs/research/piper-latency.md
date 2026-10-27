# Piper in the browser: backend, threads and the two scale knobs

Code: `client/lib/engine-piper.js` (the Piper voice-engine plugin), `client/lib/tts.js` `ttsBench()`.

## Where the latency is

Piper is a VITS model. Natively it ran about 4× faster than in WASM on the same machine, and the gap is the
HiFi-GAN vocoder: stacked transposed convolutions, the shape WASM does worst. Ruled out as fixes:

- **INT8 quantization**: about 4.6× *slower* in WASM here.
- **Kokoro**: the large teacher model a Piper voice was distilled from, at seconds per sentence; not an alternative.
- **WebGPU as the default**: see below.

The open direction is a re-distill to a vocoder that WASM runs well (an MB-iSTFT style decoder).

## Decision: WASM by default; WebGPU only when asked

`localStorage.eidoTtsBackend = 'webgpu'` (with `navigator.gpu` present) tries ORT's WebGPU execution provider. Any
other value, or none, runs WASM. Why opt-in rather than auto:

1. ORT's WebGPU EP doesn't run every op a VITS graph uses, and the failure lands at **inference**, not at session
   creation: a voice loads fine and then throws. The observed failure was "Failed to run JSEP kernel" on a
   `GatherND` node. `GatherND` *is* in ORT's WebGPU op table, so that was a kernel that exists and failed, not a
   missing one; the error text doesn't distinguish the two.
2. `RandomNormalLike` is absent from that table, and VITS samples noise, so the graph partitions between GPU and CPU
   in the hot path: a plausible cause of both a failure and a slowdown.
3. For short utterances WASM SIMD + threads often beats WebGPU anyway (per-call GPU setup dominates; ORT's docs and
   piper-plus both say so), and short utterances are the common case.
4. An experiment that can cost someone a working voice is a flag, not a default.

Because of (1), the fallback covers both steps: `load()` builds the session on WASM when the WebGPU `create()` throws,
and `speak()` catches a WebGPU failure in `run()` and rebuilds the session on WASM.
With WebGPU on, ORT's verbose logging is enabled so the next attempt shows which ops ran where.

## Session options

- **Sequential execution** (ORT's default). Parallel mode measured about 21% slower: a VITS graph is mostly one
  dependency chain, so parallel subgraphs buy nothing and pay thread coordination, which WASM makes dearer.
- **`graphOptimizationLevel: 'all'`**: about 28% faster than `'basic'`.
- **Threads**: `numThreads = min(cores, 8)` only when the page is cross-origin isolated and `SharedArrayBuffer`
  exists; otherwise 1. The isolation headers are the server's (`docs/research/cross-origin-isolation.md`).

## Terminal punctuation

A bare short word ("hello") is out of distribution for a model trained on sentences, and comes out mangled; a
sentence terminator puts it back in distribution at no cost. `speak()` appends `.` when the text has no final
punctuation (the documented workaround, rhasspy/piper#252).

## noise_w and length_scale

The same text does not produce the same audio. `noise_w` is the stochastic duration predictor's noise: identical
phoneme ids at the default 0.8 varied output length by about 6% across runs, about 1% at 0.4, and not at all at 0.
It buys natural rhythm and costs consistency, and an unlucky draw is audibly worse. The voice's `.onnx.json` may
override it; the code default is 0.8.

Inference cost tracks **output duration** almost exactly (real-time factor stays roughly constant), so a voice that
speaks slowly is also slow to synthesize. `length_scale` sets pace and cost together. It is a voice decision (pace,
character), set in the voice's `.onnx.json`, not a perf knob to change behind someone's back;
`localStorage.eidoTtsLengthScale` overrides it for A/B listening.
