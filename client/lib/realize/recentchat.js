// Replaying the room you just walked into: puts the join snapshot's `state.st.recentChat`
// on screen. Kept apart from social.js (which imports the engine via world.js) so the
// renderer-free client can reach it too; social.js calls it. Current servers send it
// empty (speech is arrival-only); the loop stays for older servers.
import { state, onWorldChange } from '../state.js';
import { logChat } from '../chat.js';

/** Put the pre-existing room context on screen. Safe to call more than once only if the
 *  chat log dedupes by seq - which it does; every entry here carries its real sequence
 *  identity rather than being re-stamped as new. */
export function replayRecentChat() {
  for (const m of state.st?.recentChat ?? []) {
    logChat(m.actor, m.text, '', { seq: m.seq, ts: m.ts });
  }
}

/** Subscribe the replay to hydration. MUST be installed before the socket is adopted:
 *  the snapshot can be in the early socket's buffer already, and a consumer registered
 *  after the drain is a consumer that never sees it. */
export function initRecentChat() {
  onWorldChange((ev) => { if (ev.type === 'hydrated') replayRecentChat(); });
}
