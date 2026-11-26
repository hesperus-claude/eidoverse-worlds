// Test stand-in for client/lib/core.js in test/client/gi-test.mjs: core-stub's exports, with TSL's uniform groups told
// apart. core-stub's TSL answers every name with one chainable node, so `renderGroup === objectGroup` there and a row
// asking which group a uniform rides could not fail.
export * from './core-stub.mjs';
import { TSL as BASE } from './core-stub.mjs';
const GROUPS = { renderGroup: { group: 'render' }, objectGroup: { group: 'object' }, frameGroup: { group: 'frame' } };
export const TSL = new Proxy({}, { get: (_t, k) => GROUPS[k] ?? BASE[k] });
