/** Autoplay unlock — one gesture, every pending audio element, both transports.
 *
 * `audio.play()` rejects without a user gesture. A per-element `{once: true}` click listener unlocks
 * only the element whose listener fires; mobile browsers deliver `touchend`/`pointerdown` and may never
 * send a plain `click`; and a caught rejection with no log or UI is indistinguishable from nobody talking.
 * So: one shared queue, unlocked by any plausible gesture, retried for every element at once, and the
 * refusal is said in chat. SpeechRecognition holds its own microphone (stt.js) and never touches playback,
 * so a working mic meter says nothing about the receive side.
 */
import { logChat } from './chat.js';

const pending = new Set();
let armed = false;
let toldThem = false;

/** Play this element, and if the browser refuses, hold it until a gesture. */
export function playWhenAllowed(audio, who = 'someone') {
  const attempt = () => audio.play().then(() => true).catch(() => false);
  attempt().then((ok) => {
    if (ok) { pending.delete(audio); return; }
    pending.add(audio);
    arm();
    if (!toldThem) {
      toldThem = true;
      // The one thing the old code never did: TELL THEM. Without this the only
      // symptom is silence, which is indistinguishable from "nobody is talking".
      logChat('*', 'tap anywhere to enable audio — your browser is holding it until you do');
      console.warn(`[voice] autoplay blocked (${who}) — waiting for a user gesture. `
        + `${pending.size} element(s) held.`);
    }
  });
}

function arm() {
  if (armed) return;
  armed = true;
  // Every gesture a browser might accept. `click` alone was the bug; on a
  // touchscreen `touchend`/`pointerdown` are what actually arrive, and
  // `keydown` covers a desktop user who never mouses.
  const events = ['pointerdown', 'touchend', 'click', 'keydown'];
  const unlock = () => {
    let released = 0;
    for (const a of [...pending]) {
      a.play().then(() => { pending.delete(a); released++; }).catch(() => { /* still blocked */ });
    }
    // Do NOT disarm while anything is still held: a gesture can be consumed
    // before the audio context is ready, and a second tap must still work.
    // Disarming on the first gesture is the {once: true} bug wearing a new hat.
    if (pending.size === 0) {
      for (const e of events) removeEventListener(e, unlock);
      armed = false;
      if (released) console.info(`[voice] audio unlocked — ${released} element(s) now playing`);
    }
  };
  for (const e of events) addEventListener(e, unlock, { passive: true });
}
