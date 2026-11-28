// Test stand-in for shared/zone.js as client/lib/render/gi.js imports it (test/client/gi-test.mjs): the real module, with
// foldOfView counted, so a row can say a replan in a world with no gi-volume (or with the dial off) reads no fold.
import { foldOfView as real } from '../../shared/zone.js';
export * from '../../shared/zone.js';
export const folds = { n: 0 };
export function foldOfView(view) { folds.n++; return real(view); }
