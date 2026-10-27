# Voice sources: the TTS seam and the mic's DSP

Code: `client/lib/tts.js` (`setTtsSource`), `client/lib/voicesource.js` (what feeds the sender),
`client/lib/voicesfu.js` (`sfuPublish`), `client/lib/voiceengines.js`, `client/lib/engine-piper.js`,
`client/lib/browservoice.js`, `client/lib/piperbridge.js`.

## One seam for humans and agents

A human picking a synthesized voice and an agent registering one are the same call, `setTtsSource(fn, name)`, with
`fn: (text) => Promise<{pcm: Int16Array, sampleRate}>`. If they were two calls they would drift, and "how is that
one speaking?" would stop having one answer. Every UI is a wrapper over it: the audio panel's voice list loads an
engine plugin from a model file (`voiceengines.js`; Piper is `engine-piper.js`) or a synthesizer endpoint you run
(`browservoice.js`, ws or HTTP), and an agent harness uses `piperbridge.js` over a socket. `setTtsSource(null)`
reverts to the microphone.

## Why the browser's own speechSynthesis can't be a source

It is a platform limit, not something to work around. The Web Speech API offers no route from `speak()` to an
AudioNode, MediaStream or Blob; on Linux synthesis doesn't even happen in the browser (speech-dispatcher over a
socket), so there is nothing to capture. The spec request to allow SpeechSynthesis → MediaStreamTrack
(WICG/speech-api#69) is open and unimplemented. Routing `speak()` through a MediaStreamDestination and
MediaRecorder records silence, since nothing is ever connected to the destination.

So a source must return samples. The candidates, all the same `(text) => {pcm, sampleRate}` shape:

- a local synthesizer over the socket protocol `piperbridge.js` speaks;
- an in-browser WASM TTS (Piper via onnxruntime-web, which is what `engine-piper.js` is; kokoro-js; sherpa-onnx);
- a cloud or self-hosted HTTP TTS returning wav/mp3, decoded with `decodeAudioData`.

Rejected: bundling a voice for every visitor (tens of MB each, e.g. kokoro-js at about 82 MB cached). Voices are
brought by the person (a file or an endpoint); the server serves none.

## Mic processing: the browser's, not ours

The mic is plain `getUserMedia` with `echoCancellation` and `noiseSuppression` on (`voicesource.js`); Chrome's
`autoGainControl` defaults on. The browser hands us AGC, NS and AEC for free.

Compared with Basis (as read in its tree):

- **AGC**: hand-built and serious (`BasisMicrophoneAgc.cs`): a speech-level normalizer with a minimum-statistics
  noise-floor tracker, asymmetric attack/release, and gain held across pauses so the next utterance starts at
  level. Its test names (`BasisMicrophoneAgcTests.cs`) are the best checklist for judging ours if we ever build one.
- **NS**: not hand-built: a native RNNoise binding, off by default.
- **AEC**: none in their tree; they rely on the OS or headphones.

So declining a hand-built DSP chain costs us nothing Basis has on AEC, and the browser's AGC/NS is the baseline to
beat. The real declined cost is Basis's jitter buffer, which the browser's WebRTC stack also supplies.
