// join-canary — does the server admit this key? Joins over /ws directly, no client code, and prints what the server says:
//   good key → {"type":"snapshot",...}      bad key → CLOSED code=4003 reason=bad token
// (The browser paints the world name before the server answers, so a browser check can't tell. Trust this one.)
//   node tools/operator/join-canary.mjs <http(s)-url> <key>
import { helloOf } from '../../shared/protocol/hello.js';
const [,, URL, KEY] = process.argv;
const ws = new WebSocket(`${URL.replace(/^http/,'ws')}/ws`);
const out = [];
ws.onopen = () => ws.send(JSON.stringify({ type:'join', hello: helloOf(), world:'staging', id:'probe', token: KEY }));
ws.onmessage = (e) => { const s=String(e.data).slice(0,120); out.push(s); if(out.length>=2) finish(); };
ws.onclose = (e) => { console.log(`  key=${JSON.stringify(KEY)} → CLOSED code=${e.code} reason=${e.reason||'-'}`); process.exit(0); };
const finish = () => { console.log(`  key=${JSON.stringify(KEY)} → ${out[0]}`); process.exit(0); };
setTimeout(finish, 6000);
