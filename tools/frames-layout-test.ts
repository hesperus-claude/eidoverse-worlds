// frames: windows.js layout invariants, headless against the REAL module (`bun tools/frames-layout-test.ts`).
// A frame never leaves the viewport (-8 margins, drag AND resize); the hit-tester tells edges from corners and
// reaches 6px outside (resizeZoneAt is ui.js's arrange-exit guard); edge-resting frames ride a window resize;
// z-indexes stay in [10..25] under the dock; a LAYOUT_VERSION bump purges stale ew-frame-* saves ONCE; Esc
// closes/restores only when nothing else owns it. The purge runs at module scope, so localStorage is seeded BEFORE the import.

import { fileURLToPath } from "node:url";
import { plugin } from "bun";
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
plugin({
  name: "frames-layout-stubs",
  setup(b) {
    b.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here("./chat-core-stub.mjs") }));
  },
});

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ width: 1000, height: 700 });

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

// ---- seed a STALE layout from the REAL previous LAYOUT_VERSION, plus one non-frame key that must survive.
// saved?.hidden beats the viewport rule by design, so a DEFAULT_LAYOUT change that matters on small viewports must bump the version
localStorage.setItem("ew-frame-layout-ver", "2026-09-07-rightdock");
localStorage.setItem("ew-frame-world", JSON.stringify({ x: 1, y: 1, w: 50, h: 50, hidden: false }));
localStorage.setItem("ew-frame-zzz", JSON.stringify({ x: 2, y: 2, w: 60, h: 60, hidden: true }));
localStorage.setItem("ew-ui-locked", "0");

(Element.prototype as any).setPointerCapture = function () {};
(Element.prototype as any).releasePointerCapture = function () {};
(Element.prototype as any).hasPointerCapture = function () { return false; };
(document as any).elementFromPoint = () => null;

const { makeFrame, resizeZoneAt, setLocked, isLocked, panelsToggle, escapeIsClaimed, claimEscape, allFrames, chromeCost } =
  await import("../client/lib/windows.js");

// happy-dom measures nothing: report each frame's real state so the zone math and drag clamp can see it
function measurable(f: any, chromeH = 30) {
  (f.el as any).getBoundingClientRect = () => ({
    left: f.state.x, top: f.state.y, width: f.state.w, height: f.state.h + chromeH,
    right: f.state.x + f.state.w, bottom: f.state.y + f.state.h + chromeH, x: f.state.x, y: f.state.y,
    toJSON() { return this; },
  });
  Object.defineProperty(f.el, "offsetHeight", { get: () => f.state.h + chromeH, configurable: true });
  return f;
}
const outerH = (f: any) => f.el.offsetHeight;

console.log("FRAMES — LAYOUT_VERSION purge");
check("stale ew-frame-* saves are gone after the import",
  localStorage.getItem("ew-frame-world") === null && localStorage.getItem("ew-frame-zzz") === null,
  `world=${localStorage.getItem("ew-frame-world")} zzz=${localStorage.getItem("ew-frame-zzz")}`);
const stamped = localStorage.getItem("ew-frame-layout-ver");
// assert the seeded REAL previous literal is gone (a made-up stale value can never be produced)
check("the current version is stamped, replacing the seeded previous one",
  !!stamped && stamped !== "2026-09-07-rightdock", String(stamped));
check("a non-frame key (ew-ui-locked) survives the purge", localStorage.getItem("ew-ui-locked") === "0");
{
  const world = makeFrame("world", { title: "world", x: -10, y: 52, w: 232, h: 300 });
    // the bar docks at the TOP by default (helper notifications show at the bottom): y:10, not y:-10 (a bottom anchor)
    { const tbar = makeFrame("actions", { title: "actions", x: "center", y: -10, w: 352, h: 32 });
      check("the action bar's DEFAULT is the TOP edge, not the bottom",
        tbar.state.y < 100, `y=${tbar.state.y} vh=${innerHeight}`); }
  check("a frame with a purged save takes the DEFAULT, not the stale x:1",
    world.state.x !== 1 && world.state.x + world.state.w <= innerWidth - 8, JSON.stringify(world.state));
}

console.log("FRAMES — viewport clamp (the -8 margins)");
const f = measurable(makeFrame("t", { title: "t", x: 100, y: 100, w: 300, h: 200, minW: 100, minH: 80 }));
f.show();
const pe = (type: string, x: number, y: number) =>
  new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, pointerId: 1 });
function dragHeadTo(x: number, y: number) {
  const gx = f.state.x + 50, gy = f.state.y + 10;
  f.head.dispatchEvent(pe("pointerdown", gx, gy));
  f.head.dispatchEvent(pe("pointermove", x + 50, y + 10));
  f.head.dispatchEvent(pe("pointerup", x + 50, y + 10));
}
dragHeadTo(5000, 5000);
check("a drag far off the bottom-right stops 8px inside the viewport",
  f.state.x + f.state.w === innerWidth - 8 && f.state.y + outerH(f) === innerHeight - 8, JSON.stringify(f.state));
dragHeadTo(-5000, -5000);
check("a drag far off the top-left stops at (8, 8)", f.state.x === 8 && f.state.y === 8, JSON.stringify(f.state));
dragHeadTo(300, 200);
check("an in-bounds drag lands where it was dropped", f.state.x === 300 && f.state.y === 200, JSON.stringify(f.state));
{
  // resize growth is clamped too: an east drag of 9999 stops at innerWidth - x - 8
  const rightEdge = f.state.x + f.state.w - 1, midY = f.state.y + 60;
  document.dispatchEvent(pe("pointerdown", rightEdge, midY));
  document.dispatchEvent(pe("pointermove", rightEdge + 9999, midY));
  document.dispatchEvent(pe("pointerup", rightEdge + 9999, midY));
  check("an east resize cannot push the edge past innerWidth - 8",
    f.state.x + f.state.w === innerWidth - 8, JSON.stringify(f.state));
  const s = JSON.parse(localStorage.getItem("ew-frame-t") ?? "null");
  check("the clamped geometry is what gets persisted", s && s.x + s.w === innerWidth - 8, JSON.stringify(s));
}

console.log("FRAMES — every edge and corner: a resize moves only its own sides, keeps the floor, never leaves the margins");
{
  // the margins are 8 px except the south resize's 4 (windows.js: chrome-aware, "a drag clamps at 8"): stated per row on purpose
  const g = measurable(makeFrame("zones", { title: "zones", x: 300, y: 200, w: 300, h: 200, minW: 100, minH: 80 }));
  g.show();
  const ZONES: Record<string, [number, number]> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1] };
  const sides = () => ({ l: g.state.x, t: g.state.y, r: g.state.x + g.state.w, b: g.state.y + outerH(g) });
  for (const [z, [dx, dy]] of Object.entries(ZONES)) for (const [how, by] of [["by 20", 20], ["far out", 9999], ["far in", -9999]] as const) {
    Object.assign(g._state, { x: 300, y: 200, w: 300, h: 200 }); g._paint();   // .state is a copy
    const s0 = sides();
    // a corner is 8 px in (inside its 15 px square, outside the 4 px bands); an edge is 1 px in at its midpoint
    const px = dx > 0 ? s0.r - (dy ? 8 : 1) : dx < 0 ? s0.l + (dy ? 8 : 1) : (s0.l + s0.r) / 2;
    const py = dy > 0 ? s0.b - (dx ? 8 : 1) : dy < 0 ? s0.t + (dx ? 8 : 1) : (s0.t + s0.b) / 2;
    document.dispatchEvent(pe("pointerdown", px, py));
    document.dispatchEvent(pe("pointermove", px + dx * by, py + dy * by));
    document.dispatchEvent(pe("pointerup", px + dx * by, py + dy * by));
    const s1 = sides(), moved = { l: s1.l !== s0.l, t: s1.t !== s0.t, r: s1.r !== s0.r, b: s1.b !== s0.b };
    const own = { l: dx < 0, t: dy < 0, r: dx > 0, b: dy > 0 };
    const planted = (Object.keys(own) as (keyof typeof own)[]).every((k) => own[k] || !moved[k]);
    const ownMoved = (Object.keys(own) as (keyof typeof own)[]).every((k) => !own[k] || moved[k]);
    const inside = s1.l >= 8 && s1.t >= 8 && s1.r <= innerWidth - 8 && s1.b <= innerHeight - (dy > 0 ? 4 : 8);
    const floor = g.state.w >= 100 && g.state.h >= 80;
    check(`${z} ${how}: only its own sides move, inside the margins, above the floor`, planted && ownMoved && inside && floor,
      JSON.stringify({ s0, s1, w: g.state.w, h: g.state.h }));
  }
  g.hide();
}

console.log("FRAMES — edge / corner zones");
dragHeadTo(100, 100);
const L = f.state.x, T = f.state.y, R = f.state.x + f.state.w, B = f.state.y + outerH(f);
check("resizeZoneAt: a point 3px OUTSIDE the east edge is in the grab band", resizeZoneAt(R + 3, T + 60));
check("resizeZoneAt: 7px outside is past the 6px reach", !resizeZoneAt(R + 7, T + 60));
check("resizeZoneAt: 3px outside the north edge", resizeZoneAt(L + 150, T - 3));
check("resizeZoneAt: the frame's interior is content, not a zone", !resizeZoneAt(L + 150, T + 100));
check("resizeZoneAt: 8px inside the SE corner is the corner square", resizeZoneAt(R - 8, B - 8));
const cursorAt = (x: number, y: number) => { document.dispatchEvent(pe("pointermove", x, y)); return document.body.style.cursor; };
check("hover on the east band shows ew-resize", cursorAt(R - 1, T + 100) === "ew-resize", cursorAt(R - 1, T + 100));
check("hover on the south band shows ns-resize", cursorAt(L + 150, B - 1) === "ns-resize", cursorAt(L + 150, B - 1));
check("hover 8px inside the SE corner shows nwse-resize (corner beats edge)", cursorAt(R - 8, B - 8) === "nwse-resize", cursorAt(R - 8, B - 8));
check("hover 8px inside the NE corner shows nesw-resize", cursorAt(R - 8, T + 8) === "nesw-resize", cursorAt(R - 8, T + 8));
check("hover in the interior shows no resize cursor", cursorAt(L + 150, T + 100) === "", cursorAt(L + 150, T + 100));
f.hide();
check("a hidden frame has no zones", !resizeZoneAt(R + 3, T + 60));
f.show();
setLocked(true);
check("a locked layout has no zones", isLocked() && !resizeZoneAt(R + 3, T + 60));
setLocked(false);
check("...and they return when unlocked", resizeZoneAt(R + 3, T + 60));

console.log("FRAMES — sticky edges");
const rt = measurable(makeFrame("rt", { title: "rt", x: -8, y: 8, w: 200, h: 100 }));
rt.show();
const mid = measurable(makeFrame("mid", { title: "mid", x: 300, y: 300, w: 200, h: 100 }));
mid.show();
check("a right-anchored frame is painted st-r + st-t", rt.el.classList.contains("st-r") && rt.el.classList.contains("st-t"));
check("a mid-air frame holds no sticky edge", !["st-l", "st-r", "st-t", "st-b"].some((c) => mid.el.classList.contains(c)));
{
  const rx0 = rt.state.x, mx0 = mid.state.x;
  (window as any).innerWidth = 1300;
  window.dispatchEvent(new Event("resize"));
  check("on a window resize the sticky frame rides the right edge (+300)", rt.state.x === rx0 + 300, `${rx0} -> ${rt.state.x}`);
  check("...and its gap to the edge is still 8", innerWidth - (rt.state.x + rt.state.w) === 8);
  check("the mid-air frame does not move", mid.state.x === mx0, `${mx0} -> ${mid.state.x}`);
  (window as any).innerWidth = 1000;
  window.dispatchEvent(new Event("resize"));
  check("shrinking back pulls it back inside (never stranded off-screen)",
    rt.state.x + rt.state.w <= innerWidth - 8, JSON.stringify(rt.state));
}

console.log("FRAMES — a narrow viewport (the header's 'can never leave the viewport', at phone width)");
{
  // DEFAULT_LAYOUT bakes wide widths (chat w:545), so fit() clamps width too, or a phone frame runs off the right edge
  // (html,body are overflow:hidden)
  const wide = measurable(makeFrame("narrowme", { title: "narrowme", x: 10, y: 10, w: 545, h: 200 }));
  wide.show();
  const vw0 = innerWidth;
  (window as any).innerWidth = 390;
  window.dispatchEvent(new Event("resize"));
  check("a frame WIDER than the viewport is narrowed to fit, not just pinned",
    wide.state.x + wide.state.w <= innerWidth - 8, JSON.stringify(wide.state));
  check("...and it keeps its 8px left margin (not pushed to a negative x)",
    wide.state.x >= 8, JSON.stringify(wide.state));
  // minW must yield: a 170px floor can't fit a 160px viewport
  const tiny = measurable(makeFrame("tinyvp", { title: "tinyvp", x: 10, y: 10, w: 300, h: 100, minW: 170 }));
  tiny.show();
  (window as any).innerWidth = 160;
  window.dispatchEvent(new Event("resize"));
  check("minW yields when the viewport is narrower than minW",
    tiny.state.x + tiny.state.w <= innerWidth - 8, JSON.stringify(tiny.state));
  (window as any).innerWidth = vw0;
  window.dispatchEvent(new Event("resize"));

  // a PERSISTED oversized layout is clamped too: a wide-screen save must not come back full width on a narrow one
  (window as any).innerWidth = 390;
  localStorage.setItem("ew-frame-savedwide", JSON.stringify({ x: 8, y: 10, w: 545, h: 200, hidden: false }));
  const restored = measurable(makeFrame("savedwide", { title: "savedwide", x: 10, y: 10, w: 300, h: 200 }));
  // assert BEFORE show(): show() runs the second fit() call site, which would clamp this whatever creation did
  check("a SAVED layout wider than the viewport is clamped AT CREATION, not restored oversized",
    restored.state.x + restored.state.w <= innerWidth - 8, JSON.stringify(restored.state));
  restored.show();
  check("...and it is still inside the viewport after being shown",
    restored.state.x + restored.state.w <= innerWidth - 8, JSON.stringify(restored.state));
  (window as any).innerWidth = vw0;
  window.dispatchEvent(new Event("resize"));
}

console.log("FRAMES — a viewport too small for the default arrangement opens only chat");
{
  // a FIRST load too small for the default arrangement opens only chat (the palette mounts in world's stack, so no rect test sees it)
  const vw0 = innerWidth, vh0 = innerHeight;
  for (const id of ["awee", "aweb"]) localStorage.removeItem(`ew-frame-${id}`);
  (window as any).innerWidth = 390; (window as any).innerHeight = 844;
  const small = measurable(makeFrame("awee", { title: "awee", w: 407, h: 363, hidden: false }));
  check("a hidden:false default comes up HIDDEN when the viewport cannot hold the arrangement",
    small.state.hidden === true, JSON.stringify(small.state));

  // a DELIBERATE arrangement always wins: not a viewport override
  localStorage.setItem("ew-frame-aweb", JSON.stringify({ x: 8, y: 8, w: 200, h: 100, hidden: false }));
  const saved = measurable(makeFrame("aweb", { title: "aweb", w: 407, h: 363, hidden: false }));
  check("...but a SAVED hidden:false stays visible: the user's own layout is never overridden",
    saved.state.hidden === false, JSON.stringify(saved.state));

  // on the real id: without the `id !== 'chat'` exemption a phone opens NOTHING
  localStorage.removeItem("ew-frame-chat");
  const chat = measurable(makeFrame("chat", { title: "chat" }));
  check("...and CHAT is exempt: the one pane that carries the composer still opens",
    chat.state.hidden === false, JSON.stringify(chat.state));

  // an ordinary laptop is NOT auto-minimized: world (top-right) and chat (bottom-left) never share a column
  (window as any).innerWidth = 1280; (window as any).innerHeight = 720;
  for (const id of ["awld", "awlc"]) localStorage.removeItem(`ew-frame-${id}`);
  const laptopWorld = measurable(makeFrame("awld", { title: "awld", w: 407, h: 363, hidden: false }));
  check("1280x720 is a viewport the arrangement FITS: a hidden:false default opens",
    laptopWorld.state.hidden === false, JSON.stringify(laptopWorld.state));

  // phone LANDSCAPE still minimizes: 390px can't hold a 363px panel plus the bar (width alone would have opened it)
  (window as any).innerWidth = 844; (window as any).innerHeight = 390;
  localStorage.removeItem("ew-frame-awll");
  const landscape = measurable(makeFrame("awll", { title: "awll", w: 407, h: 363, hidden: false }));
  check("844x390 (phone landscape) still minimizes — height, not width, is what fails there",
    landscape.state.hidden === true, JSON.stringify(landscape.state));

  (window as any).innerWidth = vw0; (window as any).innerHeight = vh0;
  window.dispatchEvent(new Event("resize"));
}

console.log("FRAMES — reset UNPLACES: the viewport rule reads `placed`, not `moved`");
{
  // resetLayout clears `placed` as well as `moved`, or a once-dragged frame stays exempt from viewport management forever
  localStorage.removeItem("ew-frame-world");
  const f = measurable(makeFrame("world", { title: "world" }));
  check("a fresh frame is not placed", f._placed === false, `placed=${f._placed}`);
  f._markMoved();
  check("a drag places it", f._placed === true && f.state.placed === true,
    `placed=${f._placed} state.placed=${f.state.placed}`);
  f.resetLayout();
  check("reset clears the latch, not just `moved`", f._placed === false,
    `placed=${f._placed}`);
  // not persistence: resetLayout() never calls save(), so the in-memory state must clear too, or a later save() resurrects the latch
  check("...and clears it in the state object, so a later save() cannot resurrect it",
    f.state.placed === false, `state.placed=${f.state.placed}`);
}

console.log("FRAMES — reset obeys the viewport rule");
{
  // reset on a phone removes the save first: nothing to protect, so the viewport rule and fit() apply
  const vw0 = innerWidth, vh0 = innerHeight;
  (window as any).innerWidth = 390; (window as any).innerHeight = 844;
  for (const id of ["chat", "world"]) localStorage.removeItem(`ew-frame-${id}`);
  const c = measurable(makeFrame("chat", { title: "chat" }));
  const w2 = measurable(makeFrame("world", { title: "world" }));
  c.resetLayout(); w2.resetLayout();
  check("reset keeps a non-chat frame hidden where the arrangement cannot fit",
    w2.state.hidden === true, JSON.stringify(w2.state));
  check("reset keeps chat open — the pane that carries the composer",
    c.state.hidden === false, JSON.stringify(c.state));
  check("reset clamps to the viewport: every reset frame is reachable",
    c.state.x + c.state.w <= innerWidth - 8, `chat right=${c.state.x + c.state.w} limit=${innerWidth - 8}`);
  (window as any).innerWidth = vw0; (window as any).innerHeight = vh0;
  window.dispatchEvent(new Event("resize"));
}

console.log("FRAMES — a hand-placed frame is never re-anchored");
{
  // a dragged x:'center' bar stays put: the `!saved` guard read a construction-time closure, so _fit() after snapTo re-centred it
  const vw0 = innerWidth, vh0 = innerHeight;
  (window as any).innerWidth = 1000; (window as any).innerHeight = 700;
  localStorage.removeItem("ew-frame-awcx");
  const bar = measurable(makeFrame("awcx", { title: "awcx", x: "center", y: -10, w: 352, h: 32 }));
  bar.show();
  const centred = bar.state.x;
  check("an x:'center' frame opens centred", centred > 100, JSON.stringify(bar.state));

  // a REAL drag to a MIDDLE x: the left clamp pins a left-dragged frame to 8 either way
  const target = 120;
  (bar.head as HTMLElement).dispatchEvent(new PointerEvent("pointerdown", { clientX: centred + 10, clientY: bar.state.y + 5, bubbles: true }));
  (bar.head as HTMLElement).dispatchEvent(new PointerEvent("pointermove", { clientX: target + 10, clientY: bar.state.y + 5, bubbles: true }));
  (bar.head as HTMLElement).dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  const placed = bar.state.x;
  check("...and a drag lands it at the pointer, away from centre",
    placed > 20 && placed < centred - 40, `${placed} (centred ${centred})`);

  bar._fit();
  // compare with the centre fit() WOULD compute now (fit() widens the bar first)
  const wouldCentre = Math.round((innerWidth - bar.state.w) / 2);
  // binds only the RESIZE-finish latch: its capture-phase pointerup runs finish() (and markMoved) before the drag's
  // up(), so the drag-end markMoved() is bound by nothing here
  check("...and fit() does NOT re-centre it — the hand beats the anchor (binds the RESIZE latch, windows.js:181)",
    bar.state.x === placed && bar.state.x !== wouldCentre,
    `placed ${placed} -> ${bar.state.x}; anchor would give ${wouldCentre}`);

  // (4) reset puts the frame back UNDER the anchors (`moved = false`): the Y anchor is gated by `moved`, the clamp is not
    // a FRESH bottom-anchored frame: `bar`'s closure now has opts.y undefined, so its anchor branch never runs
    { localStorage.removeItem("ew-frame-ybar");
      // the DIRECTION, not an exact y: the clamp may pull a placed frame UP on screen, nothing may push it back DOWN
      const ybar = measurable(makeFrame("ybar", { title: "ybar", x: "center", y: -10, w: 352, h: 32 }));
      ybar.show();
      const yBefore = ybar.state.y;
      (ybar.head as HTMLElement).dispatchEvent(new PointerEvent("pointerdown", { clientX: ybar.state.x + 10, clientY: yBefore + 5, bubbles: true }));
      (ybar.head as HTMLElement).dispatchEvent(new PointerEvent("pointermove", { clientX: ybar.state.x + 10, clientY: 240, bubbles: true }));
      (ybar.head as HTMLElement).dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      const placedY = ybar.state.y;
      check("a bottom-anchored frame can be dragged UP off its edge", placedY < yBefore - 100, `y ${yBefore} -> ${placedY}`);
      ybar._fit();
      // not asserted: the y:-10 anchor and the clamp land ~2px apart; binding it needs offsetHeight = state.h + chrome
      check("a hand-placed frame is still on screen after a fit", ybar.state.y >= 8, `y=${ybar.state.y}`);
      // the CLAMP is NOT gated: shrink the viewport under it and it must come inside
      const vhKeep = innerHeight;
      (window as any).innerHeight = 240; ybar._fit();
      check("...but the CLAMP still runs — a hand-placed frame is never left off-screen",
        ybar.state.y + ybar.el.offsetHeight <= 240, `y=${ybar.state.y} h=${ybar.el.offsetHeight} vh=240`);
      (window as any).innerHeight = vhKeep; }

  bar.resetLayout();
  bar._fit();
  const centreNow = Math.round((innerWidth - bar.state.w) / 2);
  check("...and resetLayout un-latches it, so the anchor governs again",
    bar.state.x === centreNow && bar.state.x !== placed,
    `x=${bar.state.x} centre=${centreNow} (was placed at ${placed})`);

  // the RELOAD half (`moved = !!saved`): a frame built from a previous session's save already counts as hand-placed
  localStorage.setItem("ew-frame-awcy", JSON.stringify({ x: 18, y: 600, w: 352, h: 32, hidden: false }));
  const reloaded = measurable(makeFrame("awcy", { title: "awcy", x: "center", y: -10, w: 352, h: 32 }));
  reloaded.show();
  reloaded._fit();
  check("a frame restored from a previous session is hand-placed from the start",
    reloaded.state.x === 18, JSON.stringify(reloaded.state));

  (window as any).innerWidth = vw0; (window as any).innerHeight = vh0;
  window.dispatchEvent(new Event("resize"));
}

console.log("FRAMES — z band");
const zs = () => allFrames().map((x: any) => +x.el.style.zIndex);
for (let i = 0; i < 20; i++) measurable(makeFrame(`z${i}`, { title: `z${i}`, x: 20 + i, y: 20 + i, w: 120, h: 60 })).show();
for (const x of allFrames()) x.raise();
check("every frame's z-index sits inside [10..25] (below the dock at 27)", zs().every((z) => z >= 10 && z <= 25), JSON.stringify(zs()));
{
  const last = allFrames()[allFrames().length - 1];
  last.raise();
  const top = Math.max(...zs());
  check("the last raised frame is on top", +last.el.style.zIndex === top && top <= 25, `${last.el.style.zIndex} vs max ${top}`);
  f.raise();
  check("raising another puts IT on top and still inside the band", +f.el.style.zIndex === Math.max(...zs()) && +f.el.style.zIndex <= 25, f.el.style.zIndex);
}

console.log("FRAMES — Tab hides / restores; Esc never touches the set");
for (const x of allFrames()) x.hide();
f.show(); mid.show();
// Tab is the panel toggle; Esc is the browser's way out of full screen and closes only transient things (pops, dialogs, edit mode)
const press = (k: string, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const esc = (target?: EventTarget) => press("Escape", target);
const tab = (target?: EventTarget) => press("Tab", target);
const open = () => allFrames().filter((x: any) => x.visible).map((x: any) => x.id);
check("setup: two frames open", open().join() === "t,mid", open().join());
const { bus: stubBus } = await import("./chat-core-stub.mjs");
const quiet: string[] = [];
stubBus.on("esc-quiet", (d: string) => quiet.push(d));
esc();
check("Esc with panels open leaves them open (it never hides the set)", open().length === 2, open().join());
check("…and announces nothing on the bus", quiet.length === 0, quiet.join());
esc();
check("…a second Esc doesn't either", open().length === 2 && quiet.length === 0, `${open().join()} | ${quiet.join()}`);
tab();
check("Tab closes every open frame", open().length === 0, open().join());
check("…and says so on the bus (ui.js flashes 'panels hidden · Tab to bring back')", quiet.join() === "closed", quiet.join());
esc();
check("Esc while the set is hidden brings nothing back", open().length === 0 && quiet.join() === "closed", `${open().join()} | ${quiet.join()}`);
tab();
check("Tab again restores exactly that set", open().sort().join() === "mid,t", open().join());
check("…and says that too (the hint stops)", quiet.join() === "closed,restored", quiet.join());
{
  const input = document.createElement("input");
  document.body.appendChild(input);
  input.focus();
  check("escapeIsClaimed() = 'field' while an input is focused", escapeIsClaimed() === "field", String(escapeIsClaimed()));
  tab(input);
  check("Tab with an input focused leaves the frames alone", open().length === 2, open().join());
  check("…and announces nothing", quiet.join() === "closed,restored", quiet.join());
  input.blur(); input.remove();
  check("...and is unclaimed once it blurs", escapeIsClaimed() === null, String(escapeIsClaimed()));
}
{
  const pop = document.createElement("div"); pop.className = "dd-pop";
  document.body.appendChild(pop);
  check("an open dropdown pop claims the key", escapeIsClaimed() === "pop");
  tab();
  check("Tab with a pop open leaves the frames alone", open().length === 2, open().join());
  pop.remove();
}
{
  // a status chip's popover (statuschips.js #stpop) claims the key only while shown; its own handler folds it on Esc
  const sp = document.createElement("div"); sp.id = "stpop"; sp.hidden = true;
  document.body.appendChild(sp);
  check("a HIDDEN status-chip popover does not claim the key", escapeIsClaimed() === null, String(escapeIsClaimed()));
  sp.hidden = false;
  check("a shown status-chip popover claims the key (the panels stay)", escapeIsClaimed() === "pop", String(escapeIsClaimed()));
  tab();
  check("…Tab with it open leaves the frames alone", open().length === 2, open().join());
  sp.remove();
}
{
  let claim: string | null = null;
  claimEscape(() => claim);
  claim = "edit";
  check("a claimEscape() registrant claims the key", escapeIsClaimed() === "edit");
  tab();
  check("Tab while claimed leaves the frames alone", open().length === 2, open().join());
  claim = null;
  tab();
  check("releasing the claim hands Tab back to the frames", open().length === 0, open().join());
  check("panelsToggle() reports what it did", panelsToggle() === "restored" && panelsToggle() === "closed" && panelsToggle() === "restored");
}
{
  // NO PANELS OPEN (only the dock visible): Tab still goes quiet (ui.js relays 'closed'); the next Tab brings it back
  for (const x of allFrames()) x.hide();
  quiet.length = 0;
  tab();
  check("no panels open: Tab still goes quiet (says 'closed' on the bus, opens nothing)", quiet.join() === "closed" && open().length === 0, `${quiet.join()} | ${open().join()}`);
  tab();
  check("…and the next Tab says 'restored' (the pill comes back), still opening nothing", quiet.join() === "closed,restored" && open().length === 0, `${quiet.join()} | ${open().join()}`);
  // quiet with nothing hidden, then a panel opened by hand: Tab hides it, the next Tab brings back THAT
  tab(); f.show(); tab();
  check("quiet, then a panel opened by hand: Tab hides it (still quiet)", open().length === 0 && quiet.join() === "closed,restored,closed,closed", quiet.join());
  tab();
  check("…and the next Tab brings that panel back, and the pill", open().join() === "t" && quiet.at(-1) === "restored", `${open().join()} | ${quiet.join()}`);
  f.hide();
}
{
  // Tab hides t; a panel opened while quiet, then Tab, adds to the hidden set instead of replacing it
  for (const x of allFrames()) x.hide();
  if (panelsToggle() === "closed" && open().length === 0) panelsToggle();   // leave any standing quiet
  const g = makeFrame("t-second", { title: "second", x: 400, y: 100, w: 200, h: 150 });
  g.hide(); f.show();
  tab();                       // t hidden, remembered
  g.show(); tab();             // second opened while quiet, hidden again
  tab();                       // back
  check("a panel opened while quiet joins the hidden set: the next Tab brings both back", open().includes("t") && open().includes("t-second"), open().join());
  f.hide(); g.hide();
}

console.log("CHROME COST — the declared anchor");
{
  // geometric, so bound here (boot-check's hit-test passes a floored-but-reachable panel): one assertion per arithmetic bug
  const mk = (cls: string, ds: Record<string, string>) => {
    const d = document.createElement("div");
    if (cls.startsWith(".")) d.className = cls.slice(1); else d.id = cls.slice(1);
    Object.assign(d.dataset, ds); document.body.append(d); return d;
  };
  mk(".capnotice", { anchor: "right" });
  mk("#dock", { edge: "top" });

  // (1) an off-screen obstacle is CLAMPED (`Math.max(0, ...)`), not credited with negative gap
  const onScreen = (chromeCost as any)(".capnotice", { left: 950, right: 1270, width: 320 }, 1280).right;
  const offScreen = (chromeCost as any)(".capnotice", { left: 930, right: 1270, width: 340 }, 1024).right;
  check("a right-anchored obstacle on screen costs width + gap",
    onScreen === 330, String(onScreen));
  check("an obstacle overflowing the right edge costs its width, never width minus overflow",
    offScreen === 340, `${offScreen} — unclamped arithmetic gives 94`);

  // (2) a TOP-DOCKED rail charges positionally: at [10..304] in an 844 viewport it really is left; {0,0} put a tile under it
  const rail = (chromeCost as any)("#dock", { left: 10, right: 304, width: 294 }, 844);
  check("a top-docked rail charges the side it actually occupies, not zero",
    rail.left === 304 && rail.right === 0, JSON.stringify(rail));
}

console.log("AUTO-HIDDEN — survives a reload");
{
  // a field save() WRITES must be READ at construction: dropping autoHidden on reload strands the frame hidden forever
  localStorage.setItem("ew-frame-autotest", JSON.stringify({
    x: 100, y: 100, w: 200, h: 150, hidden: true, autoHidden: true,
  }));
  const f: any = makeFrame("autotest", { title: "autotest", x: 100, y: 100, w: 200, h: 150, hidden: true });
  check("autoHidden is read back from a saved layout, not just written to it",
    f._state.autoHidden === true, JSON.stringify(f._state));

  // `placed` too: without a key in the state literal the next save() erases it and a placed frame is auto-managed again
  localStorage.setItem("ew-frame-placedtest", JSON.stringify({
    x: 100, y: 100, w: 200, h: 150, hidden: false, placed: true,
  }));
  const pf: any = makeFrame("placedtest", { title: "placedtest", x: 100, y: 100, w: 200, h: 150 });
  check("placed is read back from a saved layout, not just written to it",
    pf._placed === true, `_placed=${pf._placed}`);
  check("...and it SURVIVES the next save() — the state object carries it",
    (() => { pf._save(); const ls = JSON.parse(localStorage.getItem("ew-frame-placedtest") || "{}");
             return ls.placed === true; })(),
    `storage after save: ${localStorage.getItem("ew-frame-placedtest")}`);

  // a frame the owner closed must NOT carry the flag, or the viewport rule reopens it (hide() clears it)
  localStorage.setItem("ew-frame-autotest2", JSON.stringify({
    x: 100, y: 100, w: 200, h: 150, hidden: true,
  }));
  const g: any = makeFrame("autotest2", { title: "autotest2", x: 100, y: 100, w: 200, h: 150, hidden: true });
  check("a saved hide with no autoHidden flag stays user-hidden",
    g._state.autoHidden === false, JSON.stringify(g._state));
}

console.log("FRAMES — a shrink is not a decision: grow the window back and every panel is where it was");
{
  // a viewport clamp must not write the frame's rect: on resize every panel returns to its layout rect, or where the person put it
  (window as any).innerWidth = 1000; (window as any).innerHeight = 700;
  window.dispatchEvent(new Event("resize"));
  const bl = measurable(makeFrame("rt-bl", { title: "bl", x: 10, y: -10, w: 300, h: 200 })); bl.show();
  const tr = measurable(makeFrame("rt-tr", { title: "tr", x: -8, y: 8, w: 250, h: 300 })); tr.show();
  // a returning user's frame: saved by show/hide, never dragged
  localStorage.setItem("ew-frame-rt-saved", JSON.stringify({ x: 400, y: 250, w: 220, h: 180, hidden: false }));
  const sv = measurable(makeFrame("rt-saved", { title: "saved", x: 40, y: 40, w: 220, h: 180 })); sv.show();
  const pl: any = measurable(makeFrame("rt-placed", { title: "placed", x: 40, y: 40, w: 200, h: 160 })); pl.show();
  Object.assign(pl._state, { x: 520, y: 330 }); pl._markMoved(); pl._save();
  const rect = (f: any) => [f.state.x, f.state.y, f.state.w, f.state.h].join(",");
  const cases: [string, any][] = [["bottom-left default", bl], ["top-right default", tr], ["saved, never placed", sv], ["placed by hand", pl]];
  const before = cases.map(([, f]) => rect(f));

  (window as any).innerHeight = 260;  // the bottom panel's top meets the top edge
  window.dispatchEvent(new Event("resize"));
  check("the shrink really squeezes (else this binds nothing)",
    cases.some(([, f], i) => rect(f) !== before[i]), cases.map(([, f]) => rect(f)).join(" | "));
  sv.hide(); sv.show();  // an ordinary toggle while small
  (window as any).innerHeight = 700;
  window.dispatchEvent(new Event("resize"));
  cases.forEach(([name, f], i) =>
    check(`height shrink → grow: ${name} returns to its rect`, rect(f) === before[i], `${before[i]} -> ${rect(f)}`));

  (window as any).innerWidth = 420;  // and across: side-by-side panels collide
  window.dispatchEvent(new Event("resize"));
  (window as any).innerWidth = 1000;
  window.dispatchEvent(new Event("resize"));
  cases.forEach(([name, f], i) =>
    check(`width shrink → grow: ${name} returns to its rect`, rect(f) === before[i], `${before[i]} -> ${rect(f)}`));

  // the squeeze must not reach storage: a toggle while small must not persist the squashed rect
  (window as any).innerHeight = 260; window.dispatchEvent(new Event("resize"));
  sv.hide(); sv.show();
  const stored = JSON.parse(localStorage.getItem("ew-frame-rt-saved") || "{}");
  check("a toggle while squeezed persists the layout rect, not the squeezed one",
    [stored.x, stored.y, stored.w, stored.h].join(",") === before[2], JSON.stringify(stored));
  (window as any).innerHeight = 700; window.dispatchEvent(new Event("resize"));

  // a self-sizer owns its frame's size (actionbar.js snapTo writes _state.w/h, then _fit): a window resize must keep it
  const sizer: any = measurable(makeFrame("rt-sizer", { title: "sizer", x: 40, y: 400, w: 352, h: 32 })); sizer.show();
  sizer._state.w = 124; sizer._state.h = 108; sizer._fit();
  (window as any).innerWidth = 1001; window.dispatchEvent(new Event("resize"));
  // height is the binding axis: an UNPLACED frame's width is re-derived from its declared w by fit() on purpose
  check("a self-sizer's height survives the next window resize",
    sizer.state.h === 108, rect(sizer));
  (window as any).innerWidth = 1000; window.dispatchEvent(new Event("resize"));

  // reset un-places: a resize must not drag the frame back to where the owner HAD put it
  pl.resetLayout();
  const resetAt = rect(pl);
  (window as any).innerWidth = 1001; window.dispatchEvent(new Event("resize"));
  (window as any).innerWidth = 1000; window.dispatchEvent(new Event("resize"));
  check("after a reset, a window resize keeps the frame at its default, not its old drag spot",
    rect(pl) === resetAt, `${resetAt} -> ${rect(pl)}`);

  // a display:none frame measures 0 tall, blinding edge-docking and fit(); this fixture measures hidden as 0 (the
  // shared measurable() doesn't). Esc → resize → Esc.
  const hid: any = makeFrame("rt-hidden", { title: "hid", x: 40, y: 40, w: 200, h: 150 });
  (hid.el as any).getBoundingClientRect = () => ({ left: hid.state.x, top: hid.state.y, width: hid.state.w,
    height: hid.state.h + 30, right: hid.state.x + hid.state.w, bottom: hid.state.y + hid.state.h + 30 });
  Object.defineProperty(hid.el, "offsetHeight", { get: () => hid.el.style.display === "none" ? 0 : hid.state.h + 30, configurable: true });
  hid.show();
  Object.assign(hid._state, { x: 1000 - 8 - 200, y: 700 - 8 - 180 }); hid._markMoved(); hid._save();  // docked bottom-right
  hid.hide();
  (window as any).innerHeight = 900; window.dispatchEvent(new Event("resize"));
  hid.show();
  check("a docked frame hidden through a grow rides its edge when shown", hid.state.y + 180 === 900 - 8, rect(hid));
  hid.hide();
  (window as any).innerHeight = 500; window.dispatchEvent(new Event("resize"));
  hid.show();
  check("...and one hidden through a shrink comes back inside the viewport", hid.state.y + 180 <= 500 - 8, rect(hid));
  (window as any).innerHeight = 700; window.dispatchEvent(new Event("resize"));

  // LOADED INTO A DIFFERENT WINDOW: the save records its viewport, so a docked frame comes up docked, not mid-air
  (window as any).innerWidth = 1400; window.dispatchEvent(new Event("resize"));
  localStorage.setItem("ew-frame-rt-load", JSON.stringify({ x: 792, y: 100, w: 200, h: 150, hidden: false, placed: true, vw: 1000, vh: 700 }));
  const ld: any = measurable(makeFrame("rt-load", { title: "ld", x: 40, y: 40, w: 200, h: 150 }));
  check("a right-docked save loaded 400px wider comes up docked", ld.state.x === 1192, rect(ld));
  window.dispatchEvent(new Event("resize"));
  check("...and the first resize does not move it", ld.state.x === 1192, rect(ld));
  (window as any).innerWidth = 1000; window.dispatchEvent(new Event("resize"));

  // a nudge while squeezed is a MOVE, not a resize: a drag chose a position, not the height the small window imposed
  const ng: any = measurable(makeFrame("rt-nudge", { title: "ng", x: 300, y: 100, w: 220, h: 500 })); ng.show();
  (window as any).innerHeight = 300; window.dispatchEvent(new Event("resize"));
  const gx = ng.state.x + 50, gy = ng.state.y + 10;
  ng.head.dispatchEvent(pe("pointerdown", gx, gy));
  ng.head.dispatchEvent(pe("pointermove", gx + 20, gy));
  ng.head.dispatchEvent(pe("pointerup", gx + 20, gy));
  (window as any).innerHeight = 700; window.dispatchEvent(new Event("resize"));
  check("a drag while squeezed keeps its new x but not the squeezed height", ng.state.x === 320 && ng.state.h === 500, rect(ng));
}

console.log("FRAMES — an edge resize while squeezed, then grow");
{
  // a resize stamps the CURRENT viewport into the rest rect, so an old-viewport position must not pair with it.
  // Through the real edge hit-tester, every other frame closed.
  for (const x of allFrames()) x.hide();
  const vp = (w: number, h: number) => { (window as any).innerWidth = w; (window as any).innerHeight = h; window.dispatchEvent(new Event("resize")); };
  const rect = (f: any) => [f.state.x, f.state.y, f.state.w, f.state.h].join(",");
  const drag = (x0: number, y0: number, x1: number, y1: number) => {
    document.dispatchEvent(pe("pointerdown", x0, y0));
    document.dispatchEvent(pe("pointermove", x1, y1));
    document.dispatchEvent(pe("pointerup", x1, y1));
  };

  vp(1900, 1000);
  const e: any = measurable(makeFrame("sq-e", { title: "e", x: 900, y: 100, w: 400, h: 200 })); e.show();
  vp(600, 1000); e.show();  // the viewport rule may have auto-hidden it
  check("setup: the shrink clamps it to x=192", e.state.x === 192, rect(e));
  const right = e.state.x + e.state.w - 1, midY = e.state.y + 100;
  drag(right, midY, right - 100, midY);
  check("setup: the e-edge drag narrows it to 300 where it stands", rect(e) === "192,100,300,200", rect(e));
  vp(601, 1000);
  check("e-edge: a 1px window resize leaves it where the person resized it", rect(e) === "192,100,300,200", rect(e));
  vp(1900, 1000);
  check("e-edge: growing back does not dock it right", rect(e) === "192,100,300,200", rect(e));
  e.hide();

  vp(1900, 1000);
  const s: any = measurable(makeFrame("sq-s", { title: "s", x: 100, y: 500, w: 300, h: 200 })); s.show();
  vp(1900, 400); s.show();
  check("setup: the shrink clamps it to y=162", s.state.y === 162, rect(s));
  const bottom = s.state.y + outerH(s) - 1, midX = s.state.x + 150;
  drag(midX, bottom, midX, bottom - 50);
  check("setup: the s-edge drag shortens it to 150 where it stands", rect(s) === "100,162,300,150", rect(s));
  vp(1900, 401);
  check("s-edge: a 1px window resize leaves it where the person resized it", rect(s) === "100,162,300,150", rect(s));
  vp(1900, 1000);
  check("s-edge: growing back does not dock it to the bottom", rect(s) === "100,162,300,150", rect(s));
  s.hide();

  // the axis a resize never touched comes back from the rest rect when the window grows, not from the clamp
  vp(1900, 1000);
  const ey: any = measurable(makeFrame("sq-ey", { title: "ey", x: 100, y: 500, w: 400, h: 200 })); ey.show();
  vp(1900, 400); ey.show();
  check("setup: the height squeeze clamps it to y=162", ey.state.y === 162, rect(ey));
  drag(ey.state.x + ey.state.w - 1, ey.state.y + 50, ey.state.x + ey.state.w - 101, ey.state.y + 50);
  check("setup: the e-edge drag narrows it to 300", rect(ey) === "100,162,300,200", rect(ey));
  vp(1900, 1000);
  check("e-edge under a HEIGHT squeeze: growing back restores its y, not bottom-docked",
    rect(ey) === "100,500,300,200", rect(ey));
  ey.hide();

  vp(1900, 1000);
  const sx: any = measurable(makeFrame("sq-sx", { title: "sx", x: 900, y: 100, w: 400, h: 200 })); sx.show();
  vp(600, 1000); sx.show();
  check("setup: the width squeeze clamps it to x=192", sx.state.x === 192, rect(sx));
  drag(sx.state.x + 200, sx.state.y + outerH(sx) - 1, sx.state.x + 200, sx.state.y + outerH(sx) - 51);
  check("setup: the s-edge drag shortens it to 150", rect(sx) === "192,100,400,150", rect(sx));
  vp(1900, 1000);
  check("s-edge under a WIDTH squeeze: growing back restores its x, not right-docked",
    rect(sx) === "900,100,400,150", rect(sx));
  sx.hide();
  vp(1000, 700);
}

console.log("FRAMES — a stored value that is not a usable number falls back, field by field");
{
  // vw:0 is not a zero-wide authoring viewport (every frame read as docked right and bottom)
  localStorage.setItem("ew-frame-bad-vw", JSON.stringify({ x: 100, y: 100, w: 300, h: 200, hidden: false, placed: true, vw: 0, vh: 0 }));
  const z: any = measurable(makeFrame("bad-vw", { title: "z", x: 40, y: 40, w: 220, h: 150 }));
  check("a save with vw:0 / vh:0 comes up where it was saved", [z.state.x, z.state.y, z.state.w, z.state.h].join(",") === "100,100,300,200",
    JSON.stringify(z.state));
  z.hide();
  localStorage.setItem("ew-frame-bad-xy", JSON.stringify({ x: "abc", y: null, w: -5, h: 120, hidden: false, placed: true, vw: "x", vh: 700 }));
  const g: any = measurable(makeFrame("bad-xy", { title: "g", x: 40, y: 50, w: 220, h: 150 }));
  check("garbage x/y/w fall back to the declared layout; a good h is kept",
    [g.state.x, g.state.y, g.state.w, g.state.h].join(",") === "40,50,220,120", JSON.stringify(g.state));
  g.hide();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
