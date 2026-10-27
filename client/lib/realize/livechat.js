// causes — live `say` entries: a chat line + speech event, not world state, so no view diff carries them. net.js
// emits each on the bus ('live-entry', {seq, ts, actor, verb: 'say', args: {text, to?, spoken?, utt?, t0?}}).
// main.js wires this off the bus: net importing it would add a lap to the net → chat → net cycle.

import { bus } from '../base.js';
import { logChat } from '../chat.js';

// performance receipts (#57): voiceCapable = actors with a live voice leg (actor → gen); pendingSpeech = says held
// for a `performed` receipt (seq → fallback timer)
const voiceCapable = new Map();
const pendingSpeech = new Map();
const PERFORMANCE_TIMEOUT_MS = 2500;
// the voice leg, or the SFU relay's (client/lib/voicesfubridge.js)
const isVoiceLeg = (s) => s === 'voice' || s === 'voice-relay';
bus.on('surfaces', (people) => {
  voiceCapable.clear();
  for (const p of people ?? [])
    for (const sf of p.surfaces ?? [])
      if (isVoiceLeg(sf.surface)) voiceCapable.set(p.id, sf.gen);
});
bus.on('surface-transition', ({ actor, surface, gen, retired }) => {
  if (!isVoiceLeg(surface)) return;
  // gen null = died unreplaced: retire only the CURRENT gen, as a successor's transition may already have landed
  if (gen == null) {
    if (retired == null || voiceCapable.get(actor) === retired) voiceCapable.delete(actor);
  } else {
    voiceCapable.set(actor, gen);
  }
});
bus.on('performed', ({ actor, seq, gen }) => {
  // only the right author with gen >= the hold's cancels it: a successor may perform an older gen's say; a retired
  // leg's late receipt is refused
  const held = pendingSpeech.get(seq);
  if (held && held.actor === actor && gen >= held.gen) {
    clearTimeout(held.timer);
    pendingSpeech.delete(seq);
    // still performs VISUALLY; performed: true keeps TTS out (tts.js). Spoken display metadata owns its own captions.
    if (!held.spoken) bus.emit('speech', { ...held.say, performed: true });
  }
});

export function handleLiveCause(entry) {
  const { verb, args = {}, actor } = entry;
  switch (verb) {
    case 'say': {
      logChat(actor, args.text, '', {
        seq: entry.seq, ts: entry.ts,
        // display metadata for a voice already performed as captions; the server sanitizes, this guards old/foreign ones
        ...(args.spoken === true && Number.isSafeInteger(args.utt)
          ? { spoken: true, utt: args.utt, t0: args.t0 } : {}),
      });
      // receipts decide performance, never the author-controlled `spoken` flag: a voice-leg author's say is HELD; a
      // valid receipt skips local TTS, none falls back to it
      const say = { actor, text: args.text };
      if (voiceCapable.has(actor)) {
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
