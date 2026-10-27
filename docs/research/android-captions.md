# Speech-to-text on phones: measured, unreliable, kept

Code: `client/lib/stt.js`; the `/audio stt` and `/audio say` reports are in `client/lib/chat.js` (`sttReport`).

## The pipeline, and why it is a `say`

Speech is transcribed in the browser and spoken into the world as an ordinary `say` prefixed `🎙 `. Transcripts
land in the log agents already read, and their wake triggers (mention, approach, whisper) never learn voice
exists. The prefix survives the say fold and doubles as captions for people with sound off. A better engine
(local whisper) can replace the recognizer without touching that pipe.

## Privacy: there is no on-device setting

`webkitSpeechRecognition` is cloud-based (Google's recognizer) on every platform, desktop and mobile. Chrome on
Android exposes the newer on-device API surface but ships no models, so `available({processLocally: true})`
resolves "unavailable"; Samsung Internet exposes only the legacy constructor, which has always been cloud. No
configuration keeps the audio on the device.

## Phones: works about half the time

One measured session (a Samsung phone, Chrome, saying "hello" repeatedly) tallied `speech×6 result:final×3
nomatch×4 err:aborted×1`: about half the utterances the recognizer heard came back empty. Confounder: the
phone's mobile data was dropping, and every utterance is a round trip to the cloud, so an unknown share of those
`nomatch`es may be network. It was measured once, on one device.

**Decision: don't disable STT on mobile.** Disabling it (proposed twice, in two forms) would have blocked a
working feature. Read live numbers before theorising: `/audio stt` in world chat prints the build, language, whether STT is on, event
tally and last event; `/audio say` posts that line into the world (no copy and paste on a phone). `nomatch` = heard,
recognised nothing; `speech` = classified as speech. `speech×N` with `result:final×0` is the broken case; any tally
with finals in it is unreliable but working.

## Android ignores `continuous`

Recognition stops after a few seconds of silence regardless of the flag
(https://issues.chromium.org/issues/40324711; upstream has debated faking it vs throwing not-supported). The
documented workaround, used here, is restarting in `onend`, only while STT is wanted and the mic is live. On
Android each restart plays the OS connect/disconnect earcon, heard as a chime every several seconds: the
workaround being audible, not a notification.
