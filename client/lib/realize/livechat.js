// causes — the live chat lines (the `say` entries the authority writes): a live say is a spoken moment (chat line +
// speech event) whose RECORD stays in the chat window for the next arrival. It isn't world state, so no view diff
// can carry it: net.js dispatches each live line here over the bus ('live-entry', {seq, ts, actor, verb: 'say',
// args: {text, to?, spoken?, utt?, t0?}}).
//
// Wired by main.js off the bus rather than imported by net: importing chat from a module net imports would add yet
// another lap around the net → chat → net cycle.

import { bus } from '../base.js';
import { logChat } from '../chat.js';

// #57: performance receipts. voiceCapable = actors with a live voice leg
// (seeded by snapshot, kept current by surface-transition); pendingSpeech =
// says held awaiting a `performed` receipt (seq → fallback timer).
const voiceCapable = new Map();
const pendingSpeech = new Map();
const PERFORMANCE_TIMEOUT_MS = 2500;
// a leg that performs an actor's says aloud: the voice leg, or the SFU relay's (server.ts, voicesfubridge.js)
const isVoiceLeg = (s) => s === 'voice' || s === 'voice-relay';
bus.on('surfaces', (people) => {
  voiceCapable.clear();
  for (const p of people ?? [])
    for (const sf of p.surfaces ?? [])
      if (isVoiceLeg(sf.surface)) voiceCapable.set(p.id, sf.gen);
});
bus.on('surface-transition', ({ actor, surface, gen, retired }) => {
  if (!isVoiceLeg(surface)) return;
  // gen null = the leg died unreplaced: retire only our CURRENT idea of it, since a successor's transition may already
  // have landed (order across sockets isn't guaranteed)
  if (gen == null) {
    if (retired == null || voiceCapable.get(actor) === retired) voiceCapable.delete(actor);
  } else {
    voiceCapable.set(actor, gen);
  }
});
bus.on('performed', ({ actor, seq, gen }) => {
  // a receipt cancels a hold only from the right author with gen >= the hold's: a successor leg may perform a say held
  // under an older gen; only an older receipt (a retired leg's late frame) is refused
  const held = pendingSpeech.get(seq);
  if (held && held.actor === actor && gen >= held.gen) {
    clearTimeout(held.timer);
    pendingSpeech.delete(seq);
    // success still performs VISUALLY (bubbles/mouth ride bus events); performed: true keeps TTS out (tts.js
    // speakOwnSays). Skipped when the say carried spoken display metadata, which owns caption continuation.
    if (!held.spoken) bus.emit('speech', { ...held.say, performed: true });
  }
});

export function handleLiveCause(entry) {
  const { verb, args = {}, actor } = entry;
  switch (verb) {
    case 'say': {
      logChat(actor, args.text, '', {
        seq: entry.seq, ts: entry.ts,
        // spoken-say protocol only: display metadata for a voice that
        // already performed as captions (server sanitizes; this is the
        // client's own guard for old/foreign servers)
        ...(args.spoken === true && Number.isSafeInteger(args.utt)
          ? { spoken: true, utt: args.utt, t0: args.t0 } : {}),
      });
      // performance is decided by receipts, never the author-controlled `spoken` flag: an author with a live voice leg
      // HOLDs local speech briefly; a valid attest skips it, no receipt falls back to local TTS. No leg: speak now.
      const say = { actor, text: args.text };
      if (voiceCapable.has(actor)) {
        // bind the hold to {actor, seq, gen}: a wrong actor or a retired leg's receipt must not cancel it
        const gen = voiceCapable.get(actor);
        const timer = setTimeout(() => {
          pendingSpeech.delete(entry.seq);
          bus.emit('speech', say);
        }, PERFORMANCE_TIMEOUT_MS);
        pendingSpeech.set(entry.seq, { timer, actor, gen, say, spoken: args.spoken === true });
      } else {
        bus.emit('speech', say);
      }
      return;
    }
    default:
      console.debug('unhandled live entry', verb, args);
  }
}

export function initCauses() {
  bus.on('live-entry', handleLiveCause);
}
