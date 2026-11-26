// lightrig.js for gputime-test: the shadow preference, reduced to what gputime calls (reassertShadowPref puts the
// preference's uniform half back on every caster, as applyShadowPref does), and the lamp cache's hold as a depth count.
import { lights } from './gputime-core-stub.mjs';
export const pref = { on: true, calls: 0 };
export const reassertShadowPref = () => { pref.calls++; for (const l of lights) if (l.shadow) l.shadow.autoUpdate = pref.on; };
export const cacheHold = { depth: 0 };
export const holdShadowCache = (on) => { if (on) cacheHold.depth++; else if (cacheHold.depth > 0) cacheHold.depth--; };
