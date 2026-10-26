// shared/protocol/authority/refuse.js — how the authority says no (refactor C11, 2026-10-12; moved from authority.js's
// "the authority" section unchanged). A leaf below every other seam: the spatial index's work budget, storage's version
// check and the rights views all refuse through here, and none of them may reach the gate.
import { dec } from "../names.js";
import { CTX } from "./ctx.js";
class Refusal extends Error { constructor(code, reason, fix, extra = {}) { super(reason); Object.assign(this, { code, reason, fix, ...extra }); } }
const refuse = (code, reason, fix, extra) => { throw new Refusal(code, reason, fix, extra); };
// a person's name as they spell it (io.nameOf, the directory's, outside the log §2.3), for a refusal's words; an old
// escaped identity reads back decoded. The identity itself rides as `by`.
const said = (id) => CTX.nameOf?.(String(id)) ?? dec(String(id)) ?? String(id);
export { Refusal, refuse, said };
