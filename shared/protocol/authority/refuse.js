// shared/protocol/authority/refuse.js — how the authority says no. A leaf below every other seam (spatial's budget,
// storage's version check and the rest refuse through here); none of them may reach the gate.
import { dec } from "../names.js";
import { CTX } from "./ctx.js";
class Refusal extends Error { constructor(code, reason, fix, extra = {}) { super(reason); Object.assign(this, { code, reason, fix, ...extra }); } }
const refuse = (code, reason, fix, extra) => { throw new Refusal(code, reason, fix, extra); };
// a person's name as they spell it (io.nameOf, outside the log §3.1), for a refusal's words; the identity itself rides as `by`
const said = (id) => CTX.nameOf?.(String(id)) ?? dec(String(id)) ?? String(id);
export { Refusal, refuse, said };
