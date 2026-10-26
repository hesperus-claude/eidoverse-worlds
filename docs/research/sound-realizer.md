# The browser's `sound` realizer: rules and their Web Audio reasons

Code: `client/lib/sounds.js` (rendering), `shared/sound.js` (what the bag means: `normalizeSound`, `gainAt`),
`shared/mediasrc.js` (where bytes may come from).

The graph per sound: `<audio>` → MediaElementSource → gain (authored volume × distance) → HRTF panner (direction
only) → the world bus (the listener's world volume) → a limiter → speakers. A `spatial: false` sound skips the
panner. The panner follows its entity every other frame (`registerSystem('sounds', …, { every: 2 })`) and the
listener follows the camera.

1. **One AudioContext** (`client/lib/audioctx.js`). Chrome caps the contexts a document may hold and a refused one
   is silently mute: a context per sound would go quiet in a room with a handful of radios.
2. **Autoplay.** The browser may refuse `play()` until a gesture; every sound goes through the shared unlock queue
   (`client/lib/audiounlock.js` `playWhenAllowed`), which retries held elements on the first gesture and says so.
3. **The clock is the server's.** With `t0` (the authority's stamp on its own clock) every client seeks to the same
   playhead, `(serverNow − t0) × pitch`, modulo the duration when looping, so a late joiner hears the same bar.
   `serverNow()` is this client's estimate of the server clock (`client/lib/serverclock.js`). A one-shot whose
   playhead is past its end doesn't play. Without `t0`, the top of the track.
4. **Replace.** Same `src`: adjust in place (loop, pitch, playing; re-seek on a new `t0`). New `src`, or a change of
   `spatial`: tear down and rebuild. A sound whose entity isn't in the scene is silenced (gain 0) until the tick
   finds it again; an entity `remove` tears the sound down.
5. **The listener has the last word on loudness.** Every graph ends in one world bus whose gain is the audio panel's
   world volume (`voiceconsent.js` `volumeFor('world')`, live on `audio:volume`). The authored volume stays its own
   node: what you hear is authored × yours.
6. **Silent at radius.** Distance gain is `gainAt` (1 inside `near`, inverse beyond, a `(1−t)²` taper over the last
   5% of the radius to exactly 0; a `spatial: false` sound is 1 up to the taper, no inverse), applied on the sound's own
   gain node in the tick. The panner only places it
   (`rolloffFactor = 0`): Web Audio's `inverse` model clamps at `maxDistance` instead of reaching zero, so a radio
   stayed audible everywhere past its radius.
7. **At most `VOICES` (8) heard at once**, the loudest by what each would be heard at. The rest are paused and find
   the shared playhead again when they come back. A sound silent by distance keeps playing at 0, so walking back in
   has no gap.
8. **A limiter** (DynamicsCompressor: threshold −6 dB, knee 0, ratio 20:1, attack 3 ms, release 250 ms) between the
   world bus and the speakers, so a clipped upload can't exceed full scale.
9. **Where the bytes come from** (`shared/mediasrc.js`, `mediaprefs.js`): a store file always; a trusted host's
   link always; any other link only if this viewer turned on "allow untrusted links". Otherwise no element is made
   and nothing is fetched. Links are fetched with no Referer: an `<audio>` element has no `referrerPolicy` of its
   own, so the page's `<meta name="referrer" content="no-referrer">` keeps it. Every link is tried as a CORS request
   first (`crossOrigin = 'anonymous'`), which names the page's origin in `Origin`, never the world's name. A host
   that sends no CORS headers can't feed Web Audio (it would be silence), so it falls back to a plain element:
   volume from the same distance curve, no HRTF panning, no limiter, said in the console.
10. **Mute for me** (`mediaprefs.js`): a muted thing's sound is gain 0 for this viewer only; nothing is logged.
