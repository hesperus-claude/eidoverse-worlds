// Test stand-in for client/lib/loadwork.js: no scheduler; beginWork records the phases a load passes through, so a test
// can see WHERE a load waited (tools/loadgate-boundary-test.mjs).
export const works = [];
export const beginWork = (label) => { const w = { label, phases: [], phase(p) { w.phases.push(p); }, yield: async () => {}, done() {}, end() {} }; works.push(w); return w; };
export const enqueue = (fn) => Promise.resolve(fn?.());
export const idleYield = () => Promise.resolve();
// a stub MISSING an export breaks the suite at import (SyntaxError): add every name avatar.js imports
export const nextFrame = () => Promise.resolve();
export const loadNote = () => {};
