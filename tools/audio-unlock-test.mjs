// audio-unlock-test: client/lib/audiounlock.js, executed. One gesture of any kind (a touch, not only a click) releases
// EVERY held element, the refusal is said once, and the listeners go away once nothing is held. chat.js is stubbed.
//   bun tools/audio-unlock-test.mjs
import { fileURLToPath } from 'node:url';
import { mock } from 'bun:test';
const said = [];
mock.module(fileURLToPath(new URL('../client/lib/chat.js', import.meta.url)), () => ({ logChat: (_w, text) => said.push(text) }));
const listeners = {};
globalThis.addEventListener = (e, fn) => { (listeners[e] ??= new Set()).add(fn); };
globalThis.removeEventListener = (e, fn) => { listeners[e]?.delete(fn); };
const fire = (e) => [...(listeners[e] ?? [])].forEach((f) => f());
const armedOn = () => ['pointerdown', 'touchend', 'click', 'keydown'].filter((e) => listeners[e]?.size);
const flush = () => new Promise((r) => setTimeout(r, 5));
const { playWhenAllowed } = await import('../client/lib/audiounlock.js');

let ok = 0, bad = 0;
const t = (n, cond, detail = '') => { cond ? ok++ : bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${n}${cond || !detail ? '' : ` — ${detail}`}`); };
let blocked = true;
const played = new Set();
const mkAudio = (n) => ({ play: () => (blocked ? Promise.reject(new Error('NotAllowedError')) : (played.add(n), Promise.resolve())) });

const els = ['a1', 'a2', 'a3'].map(mkAudio);
els.forEach((a) => playWhenAllowed(a));
await flush();
t('blocked: every gesture kind is listened for', armedOn().join() === 'pointerdown,touchend,click,keydown', armedOn().join());
t('blocked: the refusal is said in chat, once', said.length === 1 && /tap anywhere/.test(said[0]), JSON.stringify(said));
fire('click'); await flush();
t('a gesture while still blocked keeps listening (no one-shot)', armedOn().length === 4 && played.size === 0);
blocked = false;
fire('touchend'); await flush();
t('one touch releases EVERY held element', played.size === 3, `${played.size}`);
fire('keydown'); await flush();
t('nothing held: the next gesture removes every listener', armedOn().length === 0, armedOn().join());
blocked = true;
playWhenAllowed(mkAudio('a4')); await flush();
t('re-armable: a later block listens again, without saying it twice', armedOn().length === 4 && said.length === 1);
blocked = false;
fire('pointerdown'); await flush();
t('…and a gesture releases it', played.has('a4'));
console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
