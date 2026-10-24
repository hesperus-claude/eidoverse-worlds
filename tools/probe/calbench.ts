import fs from "fs"; import os from "os"; import path from "path";
const d = fs.mkdtempSync(path.join(process.env.PROTOCOL_SCRATCH || os.tmpdir(), "cal-")); const f = path.join(d, "cal.jsonl");
const line = Buffer.from(JSON.stringify({ seq: 1, kind: "act", body: { verb: "create", args: { id: "x", model: "crate" } } }) + "\n");
const one = () => { const t0 = performance.now(); for (let i = 0; i < 20; i++) { const fd = fs.openSync(f, "a"); try { fs.writeSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } return performance.now() - t0; };
const xs = Array.from({ length: 9 }, one).sort((a, b) => a - b); console.log(process.platform, xs.map((x) => +x.toFixed(2)).join(" "), "median", xs[4].toFixed(2));
fs.rmSync(d, { recursive: true, force: true });
