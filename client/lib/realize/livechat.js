// causes — the live chat lines (the `say` entries the authority writes): a live say is a spoken moment (chat line +
// speech event) whose RECORD stays in the chat window for the next arrival. It isn't world state, so no view diff
// can carry it: net.js dispatches each live line here over the bus ('live-entry', {seq, ts, actor, verb: 'say',
// args: {text, to?, spoken?, utt?, t0?}}).
//
// Wired by main.js off the bus rather than imported by net: importing chat from a module net imports would add yet
// another lap around the net → chat → net cycle.

import { bus } from '../base.js';
import { logChat } from '../chat.js';

// voiceCapable = actors with a live voice leg (seeded by snapshot, kept
// current by surface-transition); pendingSpeech = says held awaiting a
// `performed` receipt (seq → fallback timer).
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
  // gen null = the leg DIED unreplaced: drop it, or every say from that actor
  // waits out the full timeout. Retire only our CURRENT gen: a successor's
  // transition may already have landed (order across sockets is not
  // guaranteed), and a stale retirement must not strip the live one.
  if (gen == null) {
    if (retired == null || voiceCapable.get(actor) === retired) voiceCapable.delete(actor);
  } else {
    voiceCapable.set(actor, gen);
  }
});
bus.on('performed', ({ actor, seq, gen }) => {
  // A receipt cancels a hold only from the right actor, and `gen >=` the hold's:
  // a SUCCESSOR leg may perform a say held under an older gen after a mid-hold
  // takeover; only an OLDER gen (a retired leg's late frame) is refused.
  const held = pendingSpeech.get(seq);
  if (held && held.actor === actor && gen >= held.gen) {
    clearTimeout(held.timer);
    pendingSpeech.delete(seq);
    // Success still draws the bubble/mouth (they ride bus events); performed:
    // true keeps TTS out (tts.js speakOwnSays). Skipped for a spoken say, whose
    // display/caption continuation is already in charge of the bubble.
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
      // PERFORMANCE is decided by receipts, never by `spoken` (author-controlled
      // display metadata; a claim is not a receipt). An author with a live voice
      // leg is HELD briefly: a `performed` receipt skips local speech, no receipt
      // in the window falls back to local TTS. No voice leg: speak immediately.
      const say = { actor, text: args.text };
      if (voiceCapable.has(actor)) {
        // Bind the hold to {actor, seq, gen}: a wrong actor or a retired leg's
        // receipt must not suppress a fallback that should fire.
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
