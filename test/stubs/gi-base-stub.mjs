// Test stand-in for client/lib/base.js in test/client/gi-test.mjs: core-stub's exports with a REAL bus, since gi.js is
// told through it that loads finished ('lanes-idle', loadwork.js checkIdle) and a suite has to be able to say so.
export * from './core-stub.mjs';
const handlers = new Map();
export const emitted = [];
export const bus = {
  on(t, f) { (handlers.get(t) ?? handlers.set(t, []).get(t)).push(f); return () => { const l = handlers.get(t); const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); }; },
  emit(t, p) { emitted.push([t, p]); for (const f of [...(handlers.get(t) ?? [])]) f(p); },
};
