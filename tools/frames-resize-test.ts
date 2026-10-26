// frames: the resize drag's finish path, headless (`bun tools/frames-resize-test.ts`).
// A drag released outside the browser never gets `pointerup`; teardown on that alone leaves `_resizing` true and the
// listeners installed, silently killing every later resize. So: does it still work AFTER a drag that ended the wrong way?

import { fileURLToPath } from "node:url";
import { plugin } from "bun";
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
plugin({
  name: "frames-stubs",
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here("./chat-core-stub.mjs") }));
  },
});

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

// happy-dom has no pointer capture: modelled on ELEMENTS only, never `document`, tracking who holds what so the
// acquirer can be checked as the releaser
const _captured = new Set<number>();
(Element.prototype as any).setPointerCapture = function (id: number) { _captured.add(id); (this as any).__cap = id; };
(Element.prototype as any).releasePointerCapture = function (id: number) { _captured.delete(id); (this as any).__cap = undefined; };
(Element.prototype as any).hasPointerCapture = function (id: number) { return (this as any).__cap === id; };

const { makeFrame } = await import("../client/lib/windows.js");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

const f = makeFrame("t", { title: "t", x: 100, y: 100, w: 300, h: 200, minW: 100, minH: 80 });
f.show();

// happy-dom's DOMRect is all zero and the zone math uses getBoundingClientRect: report the frame's real state
(f.el as any).getBoundingClientRect = () => ({
  left: f.state.x, top: f.state.y, width: f.state.w, height: f.state.h,
  right: f.state.x + f.state.w, bottom: f.state.y + f.state.h, x: f.state.x, y: f.state.y,
  toJSON() { return this; },
});
// nothing interactive is under the pointer in these synthetic drags
(document as any).elementFromPoint = () => null;

// CHROME: state.h is the BODY's height; the frame is taller by the title bar and .fr-body padding (without an
// offsetHeight chrome reads 0 and the south clamp's budget looks exact)
const CHROME = 30;
Object.defineProperty(f.el, "offsetHeight", { get: () => f.state.h + CHROME, configurable: true });

const pd = (x: number, y: number) => new PointerEvent("pointerdown",
  { clientX: x, clientY: y, button: 0, bubbles: true, pointerId: 1 });
const pm = (x: number, y: number) => new PointerEvent("pointermove",
  { clientX: x, clientY: y, bubbles: true, pointerId: 1 });

const edgeX = () => f.state.x + f.state.w - 1;  // just inside the east band
const edgeY = () => f.state.y + 40;

function dragEast(by: number, endWith: "up" | "nothing" | "cancel" | "blur") {
  const w0 = f.state.w;
  document.dispatchEvent(pd(edgeX(), edgeY()));
  document.dispatchEvent(pm(edgeX() + by, edgeY()));
  if (endWith === "up") document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  if (endWith === "cancel") document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }));
  if (endWith === "blur") window.dispatchEvent(new Event("blur"));
  return f.state.w - w0;
}

// --- baseline: a normal drag resizes
check("a normal drag resizes the frame", dragEast(60, "up") !== 0,
  `w now ${f.state.w}`);

// --- the regression: a drag that ends without pointerup must not wedge state
const abandoned = dragEast(40, "nothing");  // pointer left the window, no up
check("an abandoned drag still moved the edge", abandoned !== 0, String(abandoned));
// nothing cleaned it up yet — now the recovery paths
window.dispatchEvent(new Event("blur"));
const after = dragEast(50, "up");
check("a NEW drag works after one ended without pointerup", after !== 0,
  `delta ${after} — if 0, _resizing is wedged`);

// --- pointercancel is a full citizen
dragEast(30, "cancel");
const afterCancel = dragEast(30, "up");
check("a new drag works after pointercancel", afterCancel !== 0, String(afterCancel));

// --- blur alone finishes
dragEast(30, "blur");
const afterBlur = dragEast(30, "up");
check("a new drag works after window blur", afterBlur !== 0, String(afterBlur));

// --- the finish is idempotent: several endings at once must not throw
let threw = false;
try {
  document.dispatchEvent(pd(edgeX(), edgeY()));
  document.dispatchEvent(pm(edgeX() + 20, edgeY()));
  document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }));
  window.dispatchEvent(new Event("blur"));
} catch { threw = true; }
check("overlapping finish paths do not throw", !threw);
check("...and the frame still resizes afterward", dragEast(25, "up") !== 0);

// --- capture is released by the element that took it (releasing on `document` is a no-op; a blur would leave it live)
_captured.clear();
document.dispatchEvent(pd(edgeX(), edgeY()));
document.dispatchEvent(pm(edgeX() + 20, edgeY()));
check("a drag acquires pointer capture", _captured.size === 1, `${_captured.size} held`);
window.dispatchEvent(new Event("blur"));
check("...and blur releases it on the acquiring element", _captured.size === 0,
  `${_captured.size} still held — capture leaked`);
check("...leaving documentElement holding nothing",
  !(document.documentElement as any).hasPointerCapture(1));

_captured.clear();
dragEast(20, "cancel");
check("pointercancel also releases the capture", _captured.size === 0, `${_captured.size} held`);

// --- corners are a real target: 8px in is inside the 15px corner square but outside the 4px edge bands, so a diagonal
// proves the corner rule, not a lucky band overlap
function dragFrom(px: number, py: number, dx: number, dy: number) {
  const w0 = f.state.w, h0 = f.state.h;
  document.dispatchEvent(pd(px, py));
  document.dispatchEvent(pm(px + dx, py + dy));
  document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  return { dw: f.state.w - w0, dh: f.state.h - h0 };
}
const L = () => f.state.x, T = () => f.state.y,
      Rt = () => f.state.x + f.state.w, B = () => f.state.y + f.state.h;
{
  const se = dragFrom(Rt() - 8, B() - 8, 30, 30);
  check("SE corner (8px inside) resizes BOTH dimensions", se.dw > 0 && se.dh > 0, JSON.stringify(se));
  const ne = dragFrom(Rt() - 8, T() + 8, 25, -25);
  check("NE corner grows width and height together", ne.dw > 0 && ne.dh > 0, JSON.stringify(ne));
  const sw = dragFrom(L() + 8, B() - 8, -25, 25);
  check("SW corner grows width and height together", sw.dw > 0 && sw.dh > 0, JSON.stringify(sw));
  const nw = dragFrom(L() + 8, T() + 8, -20, -20);
  check("NW corner grows width and height together", nw.dw > 0 && nw.dh > 0, JSON.stringify(nw));
}
// ...and every plain edge still resizes exactly ONE dimension (midpoints are far from any corner square)
{
  const e_ = dragFrom(Rt() - 1, T() + f.state.h / 2, 20, 0);
  check("E edge still resizes width only", e_.dw > 0 && e_.dh === 0, JSON.stringify(e_));
  const w_ = dragFrom(L() + 1, T() + f.state.h / 2, -20, 0);
  check("W edge still resizes width only", w_.dw > 0 && w_.dh === 0, JSON.stringify(w_));
  const s_ = dragFrom(L() + f.state.w / 2, B() - 1, 0, 20);
  check("S edge still resizes height only", s_.dh > 0 && s_.dw === 0, JSON.stringify(s_));
  const n_ = dragFrom(L() + f.state.w / 2, T() + 1, 0, -20);
  check("N edge still resizes height only", n_.dh > 0 && n_.dw === 0, JSON.stringify(n_));
}

// --- minimums still hold (the clamp survived the refactor)
const tiny = dragEast(-9999, "up");
check("width clamps at minW", f.state.w >= 100, `w=${f.state.w} (delta ${tiny})`);

// --- the south clamp budgets in BODY space, subtracts a VIEWPORT margin ---
{ // the frame renders `chrome` px taller than state.h, so the south clamp subtracts chrome or a max resize ends past the
  // bottom edge (unreachable under overflow:hidden); finish() never calls fit() to repair it
  f.state.x = 100; f.state.y = 100; f.state.w = 300; f.state.h = 200;
  const sx = f.state.x + 40, sy = () => f.state.y + f.state.h - 1;   // inside the south band
  document.dispatchEvent(pd(sx, sy()));
  document.dispatchEvent(pm(sx, innerHeight + 500));                 // drag far past the bottom
  document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  const bottom = f.state.y + (f.el as any).offsetHeight;
  check("a south resize to the limit leaves the RENDERED frame inside the viewport",
    bottom <= innerHeight - 4,
    `rendered bottom=${bottom} viewport=${innerHeight} state.h=${f.state.h} chrome=${CHROME}`);
}

// the frame publishes its own floor: index.html's `.frame { min-width: 170px }` won for any smaller JS minW, flooring the RENDER
{ const narrow = makeFrame("floor", { title: "floor", x: 10, y: 10, w: 48, h: 32, minW: 48, minH: 32 });
  narrow.show();
  check("a frame publishes its OWN minW to the DOM, not the sheet's blanket 170",
    (narrow.el as HTMLElement).style.minWidth === "48px", `minWidth=${(narrow.el as HTMLElement).style.minWidth}`);
  const wide = makeFrame("floor2", { title: "floor2", x: 10, y: 10, w: 400, h: 200, minW: 320 });
  wide.show();
  check("...and a frame with a LARGER floor keeps it", (wide.el as HTMLElement).style.minWidth === "320px",
    `minWidth=${(wide.el as HTMLElement).style.minWidth}`); }

// --- a glyph button over the edge band keeps its press: the topmost element is the glyph's SVG <path>, not an
// HTMLElement, and the walk up to its <button> must still start. Inside a frame too, within 6px of its edge.
for (const where of ["over the band, outside the frame", "inside the frame, at its edge"]) {
  const b = document.createElement("button");
  b.innerHTML = '<svg viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg>';
  (where.startsWith("inside") ? f.el : document.body).appendChild(b);
  const path = b.querySelector("path")!;
  (document as any).elementFromPoint = () => path;
  const w0 = f.state.w;
  const ev = pd(edgeX(), edgeY());
  document.dispatchEvent(ev);
  document.dispatchEvent(pm(edgeX() + 40, edgeY()));
  document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  check(`a glyph button ${where} keeps its press: no resize, default not prevented`, f.state.w === w0 && !ev.defaultPrevented, `w ${w0} → ${f.state.w}, prevented=${ev.defaultPrevented}`);
  b.remove();
}
(document as any).elementFromPoint = () => null;

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
