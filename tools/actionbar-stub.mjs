// actionbar-test substitutes this for every neighbour actionbar.js imports except icons.js (pure): ONE file for
// windows.js / avatar.js / controller.js / mybody.js / xrpanels.js / base.js (their names are disjoint). Every export
// is a recorder the test reads.

// ---- base.js: the bus
const handlers = new Map();
export const busLog = [];
export const bus = {
  on(t, f) { (handlers.get(t) ?? handlers.set(t, []).get(t)).push(f); },
  emit(t, p) { busLog.push(t); for (const f of handlers.get(t) ?? []) f(p); },
};
export const CONFIG = { name: 'tester' };
export function report() {}

// ---- windows.js: a frame that carries the refs actionbar.js rides (_state, _paint, show)
export const frames = [];
export function makeFrame(key, opts = {}) {
  const el = document.createElement('div');
  const body = document.createElement('div');
  el.append(body); document.body.append(el);
  const f = {
    key, opts, el, body, visible: !opts.hidden, paints: 0,
    _state: { w: opts.w, h: opts.h },
    _paint() { this.paints++; },
    _fit() { this.paints++; },          // real frames clamp to the viewport here; the stub just records
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    hooks: [],
    onShow(fn) { this.hooks.push(fn); return this; },
    show() { this.visible = true; for (const h of this.hooks) h(); return this; },   // the real show() runs onShow hooks
    toggle() { this.visible = !this.visible; },
    badge() {},
  };
  frames.push(f);
  return f;
}
export const allFrames = () => frames;
export const getFrame = (k) => frames.find((f) => f.key === k) ?? null;

// ---- avatar.js: the def-hydrated vocabulary, MUTABLE like the real one
export const ANIM_ORDER = ['wave', 'cheer', 'dance', 'point', 'salute', 'clap'];
export const ANIM_ICONS = {};

// ---- controller.js
export const myState = { anim: null, clip: null, posture: null, seat: null };
export const postureCalls = [];
export function setPosture(p) { postureCalls.push(p); }
export function sitHere() { postureCalls.push('sitHere'); }
export function standUp() { postureCalls.push('standUp'); }
export const getPosture = () => null;

// ---- mybody.js
export const played = [];
export const getMe = () => ({ playOnce: (n) => played.push(n) });

// ---- xrpanels.js
export const xrPanels = [];
export function registerXRPanel(p) { xrPanels.push(p); }

// ---- windows.js: chromeCost is re-exported from the real module, not stubbed (roomFor()'s job is its arithmetic). The
// '../client/lib/' specifier is deliberate: actionbar-test's resolver filter (`^\./windows\.js$`) won't rewrite it.
export { chromeCost } from '../client/lib/windows.js';
