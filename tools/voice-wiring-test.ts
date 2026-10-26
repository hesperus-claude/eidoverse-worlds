// voice-wiring — the check that a bundler will not do for you.
//
//   bun tools/voice-wiring-test.ts
//
// Why this exists: a client module can emit an event nobody listens to, or
// call a function nobody imported, and the bundle still builds clean — the
// failure only appears in a browser, at runtime, to a user. That is exactly
// how a `caption` emit shipped with no consumer, and how this PR's own
// main.js briefly called updateVoiceMouths() while its imports were missing.
// Server smoke cannot see any of it; it is all client wiring.
//
// So: every emit has a listener, every consent gate is actually consulted,
// and the entry point imports what it calls. Source-level, no browser.

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// consent and fail-closed routing are enforced SERVER-side now, pinned in tools/sfu-test.ts
const main = read("client/main.js");
const mouths = read("client/lib/voicemouths.js");   // 6c: the mouth/glyph driver moved out of main.js
// the transport-neutral mic surface (gate, analyser, mute, device release, micOn()) lives in micstate.js
const voice = read("client/lib/micstate.js");
const consent = read("client/lib/voiceconsent.js");
const mictoggle = read("client/lib/mictoggle.js");
const net = read("client/lib/net.js");
const server = read("server/server.ts");

// --- entry point imports everything it calls; the same check follows the mouth driver into lib/voicemouths.js
for (const [label, src] of [["main.js", main], ["voicemouths.js", mouths]] as const) {
  for (const fn of ["updateVoiceMouths", "micOn", "isMuted", "micAnalyserLevel"]  /* initVoice + peerLevels were mesh-only (cutover 2026-08-16) */) {
    const called = new RegExp(`\\b${fn}\\s*\\(`).test(src);
    // 🔴 a destructured dynamic import is a binding too: `const { toggleMic, micOn } = await import(...)` binds both
    const bound = new RegExp(`\\b${fn}\\b[^\\n]*from|function ${fn}|import[^\\n]*\\b${fn}\\b`).test(src)
      // destructured dynamic import: `{ …, name, … } = await import(…)`
      || new RegExp(`\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*=\\s*await\\s+import`).test(src);
    check(`${label} binds ${fn} before calling it`, !called || bound);
  }
}