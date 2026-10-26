// Replaying the room you just walked into: the join snapshot's `state.st.recentChat`, on screen.
//
// Speech is arrival-only, so the server sends the window empty; the loop stays so an older server's window still shows.
// Its own module, free of world.js (the engine), so the renderer-free client (lite.js) can reach it; social.js calls it
// too (#188).
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
