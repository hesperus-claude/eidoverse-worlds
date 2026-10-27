// piperbridge — points this body's mouth at a local Piper service: a TTS source (tts.js setTtsSource) for an agent on a
// machine running the voicebox synthesizer. Opt-in via ?tts=<port> (default 8927), so an ordinary human client never
// opens this socket.
//
// The voicebox process only turns text into samples. It is not a participant: a second socket joining under the
// agent's own name put two sockets on one identity and the server took the body over, again and again.

import { setTtsSource, setTtsEnabled } from './tts.js';
import { report } from './base.js';

let ws = null, nextId = 1;
const pending = new Map();

function connect(port) {
  return new Promise((resolve) => {
    try { ws = new WebSocket(`ws://127.0.0.1:${port}`); }
    catch (e) { report('piper connect', e); return resolve(false); }
    const done = setTimeout(() => resolve(false), 4000);
    ws.onopen = () => {
      clearTimeout(done);
      ws.send(JSON.stringify({ type: 'hello', name: 'voicesource', world: '' }));
      resolve(true);
    };
    ws.onerror = () => { clearTimeout(done); resolve(false); };
    ws.onclose = () => {
      // settle everything in flight with silence rather than leaving callers hanging
      for (const [, r] of pending) r({ pcm: new Int16Array(0), sampleRate: 22050 });
      pending.clear();
      ws = null;
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type !== 'synth-result') return;
      const r = pending.get(m.id);
      if (!r) return;
      pending.delete(m.id);
      if (!m.pcm) return r({ pcm: new Int16Array(0), sampleRate: 22050 });
      const bin = atob(m.pcm);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      r({ pcm: new Int16Array(bytes.buffer), sampleRate: m.sampleRate || 22050 });
    };
  });
}

/** Register Piper as this body's voice. Returns false (harmlessly) when no
 *  synthesizer is listening — an agent without a voice is mute, not broken. */
export async function initPiperVoice({ port = 8927, name = 'piper: clockwork' } = {}) {
  if (!(await connect(port))) return false;
  setTtsSource((text) => new Promise((resolve) => {
    if (!ws || ws.readyState !== 1) return resolve({ pcm: new Int16Array(0), sampleRate: 22050 });
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ type: 'synth', id, text }));
    // Never hang the speech path on a wedged synthesizer.
    setTimeout(() => {
      if (pending.delete(id)) resolve({ pcm: new Int16Array(0), sampleRate: 22050 });
    }, 15000);
  }), name);
  setTtsEnabled(true);   // an agent that registered a voice means to use it
  return true;
}
