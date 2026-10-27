// SINGLE-TRANSPORT micstate (#132: the mesh, client/lib/voice.js, is gone). Pins:
//   1. NO transport hook → toggleMic is an honest hint + the current answer, never a throw, never a false "on" (a
//      permanently unreachable mic must stay impossible);
//   2. SFU hook installed → toggleMic calls it, emits audio:mic, returns its state; micOn() stays THE one answer, fed
//      by setMicLive;
//   3. MESH RESIDUE: micstate must not import voice.js at all (a reintroduced delegation would resurrect a dead path).
import { fileURLToPath } from "node:url";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
import { readFileSync } from "node:fs";
GlobalRegistrator.register({ url: "http://localhost/?world=t&name=p" });

mock.module(fileURLToPath(new URL("../client/lib/core.js", import.meta.url)), () => ({
  report: () => {}, bus: { on() {}, emit(ev, v) { emitted.push([ev, v]); } },
}));
mock.module(fileURLToPath(new URL("../client/lib/net.js", import.meta.url)), () => ({ sendTyping: () => {} }));
// the hint is ui.js's (lazy-imported by micstate): capture it rather than pull the UI in
const hints = [];
mock.module(fileURLToPath(new URL("../client/lib/ui.js", import.meta.url)), () => ({ flashHint: (msg) => hints.push(msg) }));
mock.module(fileURLToPath(new URL("../client/lib/audioctx.js", import.meta.url)), () => ({
  audioContext: () => null,
}));

const emitted = [];
const m = await import("../client/lib/micstate.js");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${n}${ok ? "" : "  " + extra}`);
  ok ? pass++ : fail++;
};

// ── 3 first, statically: no mesh residue in the module source ───────────────
const src = readFileSync(new URL("../client/lib/micstate.js", import.meta.url), "utf8");
check("micstate has NO import of the deleted mesh (voice.js) — code or dynamic",
  !/import\s*\(\s*['"]\.\/voice\.js['"]\s*\)/.test(src) && !/from\s+['"]\.\/voice\.js['"]/.test(src));

// ── 1: no hook installed — honest hint, honest answer ───────────────────────
check("precondition: no transport hook installed", typeof window.__sfuMic !== "function");
check("micOn() starts false", m.micOn() === false);
const none = await m.toggleMic();
check("toggleMic without a transport returns the (false) current state, no throw", none === false);
check("…and did not claim the mic went live", m.micOn() === false);

// ── 2: the SFU hook is THE transport ────────────────────────────────────────
let sfuCalls = 0, sfuOn = false;
window.__sfuMic = async () => { sfuCalls++; sfuOn = !sfuOn; m.setMicLive(sfuOn); return sfuOn; };
const s1 = await m.toggleMic();
check("with __sfuMic installed, toggleMic calls it", sfuCalls === 1);
check("…returns its resulting state", s1 === true);
check("…emits audio:mic with that state", emitted.some(([ev, v]) => ev === "audio:mic" && v === true));
const s2 = await m.toggleMic();
check("OFF→ back through the same hook", sfuCalls === 2 && s2 === false);
const s3 = await m.toggleMic();
check("ON→OFF→ON discriminator completes through the single transport", s3 === true);

// ── 4: a world with NO voice relay, hook installed: the server's refusal (net.js __voiceRelayAbsent) wins over the
// __sfuMic hook, or the click parks intent on a pc that never exists and the toggle stays grey and silent
await m.toggleMic();  // back to OFF
const callsBefore = sfuCalls; hints.length = 0;
window.__voiceRelayAbsent = true;
const absent = await m.toggleMic();
await new Promise((r) => setTimeout(r, 20));  // the lazy ui.js import settles
check("no relay: toggleMic does not hand the press to a transport that cannot exist", sfuCalls === callsBefore, `calls ${sfuCalls - callsBefore}`);
check("no relay: …returns the honest current state (off)", absent === false);
check("no relay: …and SAYS so — the no-voice-relay hint, not silence", hints.some((h) => /no voice relay/.test(h)), JSON.stringify(hints));
delete window.__voiceRelayAbsent;

// ── 5: the no-relay guard is for turning the mic ON: a mic live when the flag lands (relay refused after it went live)
// must still switch OFF through the hook, or the guard pins it on
m.gateFor({ synthetic: true }); m.setMicLive(true); sfuOn = true;
check("precondition: the mic is live", m.micOn() === true);
window.__voiceRelayAbsent = true;
const callsLive = sfuCalls;
const off = await m.toggleMic();
check("no relay, mic live: the press goes to the hook and turns it off", sfuCalls === callsLive + 1 && off === false && m.micOn() === false, `calls ${sfuCalls - callsLive}, returned ${off}, micOn ${m.micOn()}`);
delete window.__voiceRelayAbsent;

console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
