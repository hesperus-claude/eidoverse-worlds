// browservoice — bring your own voice: a ws:// or http:// synthesizer you already run; the server serves nothing.
// Not a bundled TTS (~82 MB per visitor), not speechSynthesis (no route to an AudioNode; WICG/speech-api#69).

import { setTtsSource } from './tts.js';
import { report } from './base.js';

/** ws: the same protocol a headless harness uses. */
export async function setEndpointVoice(url, label) {
  const isWs = /^wss?:/.test(url);
  if (isWs) {
    const ws = await new Promise((resolve) => {
      let s; try { s = new WebSocket(url); } catch { return resolve(null); }
      const t = setTimeout(() => resolve(null), 4000);
      s.onopen = () => { clearTimeout(t); resolve(s); };
      s.onerror = () => { clearTimeout(t); resolve(null); };
    });
    if (!ws) return false;
    const pending = new Map();
    let nextId = 1;
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type !== 'synth-result') return;
      const r = pending.get(m.id); if (!r) return;
      pending.delete(m.id);
      if (!m.pcm) return r({ pcm: new Int16Array(0), sampleRate: 22050 });
      const bin = atob(m.pcm), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      r({ pcm: new Int16Array(bytes.buffer), sampleRate: m.sampleRate || 22050 });
    };
    // a synthesizer that goes away must surface as a failed utterance, never a caller hanging forever
    ws.onclose = () => { for (const [, r] of pending) r({ pcm: new Int16Array(0), sampleRate: 22050 }); pending.clear(); };
    setTtsSource((text) => new Promise((resolve) => {
      if (ws.readyState !== 1) return resolve({ pcm: new Int16Array(0), sampleRate: 22050 });
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ type: 'synth', id, text }));
      setTimeout(() => { if (pending.delete(id)) resolve({ pcm: new Int16Array(0), sampleRate: 22050 }); }, 15000);
    }), label || `endpoint: ${url}`);
    return true;
  }

  // HTTP: POST {text} → wav/mp3 bytes; the dumbest contract, so anything from Flask to a cloud TTS fits
  const probe = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'test' }),
  }).catch(() => null);
  if (!probe?.ok) return false;
  // ONE AudioContext per page (#86), never a second; decodeAudioData works on the shared one even suspended
  const { audioContext } = await import('./audioctx.js');
  const ctx = audioContext();
  setTtsSource(async (text) => {
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const buf = await ctx.decodeAudioData(await res.arrayBuffer());
      const f32 = buf.getChannelData(0);
      const pcm = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) pcm[i] = Math.max(-1, Math.min(1, f32[i])) * 32767;
      return { pcm, sampleRate: buf.sampleRate };
    } catch (e) { report('tts endpoint', e); return { pcm: new Int16Array(0), sampleRate: 22050 }; }
  }, label || `endpoint: ${new URL(url).host}`);
  return true;
}

// Not offered yet: a raw .onnx Piper model, which takes phoneme ids and so needs the espeak-ng phonemizer first.
