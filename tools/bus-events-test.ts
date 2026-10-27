// bus-events-test: the dock's move, the lantern's open/close and a gesture's key hint ride the module bus (base.js), so a
// mod or probe listening there hears them; no window CustomEvent carries them (one-binding-test's row holds the class).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/bus-events-test.ts
const { bus } = await import("../client/lib/base.js");
const kh = await import("../client/lib/keyhints.js");
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const heard: any[] = [];
bus.on("keyhint", (h: any) => heard.push(h == null ? null : String(h)));
check("the setup: scrub has a during line", !!kh.KEYHINTS.scrub.during);
kh.engage("scrub"); kh.release();
check("engage puts the gesture's keys on the bus, release clears them", heard.length === 2 && /Shift/.test(heard[0] ?? "") && heard[1] === null, JSON.stringify(heard));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
