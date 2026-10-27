// fp-view-test: the first-person eye/exclusion contract (#75), headless (`bun tools/fp-view-test.ts`).
// client/lib/fp_view.js owns it: live-anchor eye (head bone, bounds fallback; never a standing-humanoid constant),
// socket-yaw gaze, own-body exclusion scoped strictly to the render (restored even on throw), and a legible failure
// for rigs with no anchor.
// Namespace-imports the module, so on a tree without fp_view.js it fails as LINK NOVELTY, not behavioural evidence;
// the behavioural receipt for #75 is tools/fp-snap-probe.ts.

import * as fp from "../client/lib/fp_view.js";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// a camera double that records what the composition did to it
function fakeCamera() {
  return {
    position: { x: NaN, y: NaN, z: NaN, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } },
    look: null as null | [number, number, number],
    lookAt(x: number, y: number, z: number) { this.look = [x, y, z]; },
  };
}

// ---- anchor resolution -----------------------------------------------------

console.log("anchor resolution");
{
  // head bone present: the eye is the LIVE bone position plus the eye lift (a seated head at 1.13 gives a 1.19 eye)
  const a = fp.resolveFirstPersonAnchor({ head: [4, 1.13, -2], name: "occupant" });
  check("head anchor uses the live bone position", a.mode === "head"
    && near(a.eye[0], 4) && near(a.eye[1], 1.13 + fp.FP_EYE_LIFT) && near(a.eye[2], -2));

  // elevated socket: a head at y=10.6 anchors the eye there
  const hi = fp.resolveFirstPersonAnchor({ head: [0, 10.6, 0], name: "watch" });
  check("elevated socket: eye rides the head, not a ground constant", near(hi.eye[1], 10.6 + fp.FP_EYE_LIFT));

  // moving socket: the anchor is a pure function of the live transform; nothing is cached between frames
  const t0 = fp.resolveFirstPersonAnchor({ head: [1, 2, 3], name: "swing" });
  const t1 = fp.resolveFirstPersonAnchor({ head: [1.7, 2.2, 3, ], name: "swing" });
  check("moving socket: eye tracks the live bone frame to frame",
    near(t1.eye[0] - t0.eye[0], 0.7) && near(t1.eye[1] - t0.eye[1], 0.2));

  // no head bone: the bounds fallback puts the eye near the mesh top, so a nonhumanoid body isn't a chest-cam
  const b = fp.resolveFirstPersonAnchor({ bounds: { min: [-1, 0, -1], max: [1, 2, 1] }, name: "orb" });
  check("bounds fallback: eye at FP_BOUNDS_EYE of mesh height, centered",
    b.mode === "bounds" && near(b.eye[0], 0) && near(b.eye[1], 2 * fp.FP_BOUNDS_EYE) && near(b.eye[2], 0));

  // junk anchors are not anchors
  const junkHead = fp.resolveFirstPersonAnchor({ head: [NaN, 1, 2], bounds: { min: [0, 0, 0], max: [1, 1, 1] }, name: "x" });
  check("non-finite head falls through to bounds", junkHead.mode === "bounds");

  // neither anchor: throws, naming the rig and why; an unsupported rig must not render from inside its own mesh
  let err = "";
  try { fp.resolveFirstPersonAnchor({ name: "mystery-rig" }); } catch (e) { err = (e as Error).message; }
  check("no anchor: legible failure naming the rig",
    err.includes("mystery-rig") && err.includes("head bone") && err.includes("unsupported"), err || "did not throw");

  let err2 = "";
  try { fp.resolveFirstPersonAnchor({ bounds: { min: [0, 5, 0], max: [1, 5, 1] }, name: "flat" }); } catch (e) { err2 = (e as Error).message; }
  check("degenerate (zero-height) bounds are not an anchor", err2.includes("flat"), err2 || "did not throw");
}

// ---- frame composition -----------------------------------------------------

console.log("frame composition");
{
  // socket yaw drives the gaze: mounted, root.rotation.y is the seat's yaw (browser and headless agree, acceptance 7)
  const yaw = 2.35;
  const cam = fakeCamera();
  const seq: Array<boolean | string> = [];
  fp.composeFirstPerson({
    camera: cam, yaw, head: [3, 1.4, 5], name: "occupant",
    setOwnVisible: (v: boolean) => seq.push(v),
    render: () => { seq.push("render"); return "frame-bytes"; },
  });
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  check("eye = anchor + FP_FORWARD along the rig's yaw",
    near(cam.position.x, 3 + fx * fp.FP_FORWARD) && near(cam.position.y, 1.4 + fp.FP_EYE_LIFT)
    && near(cam.position.z, 5 + fz * fp.FP_FORWARD));
  const l = cam.look!;
  check("gaze: FP_GAZE_AHEAD along yaw, FP_GAZE_DROP down",
    near(l[0] - cam.position.x, fx * fp.FP_GAZE_AHEAD)
    && near(l[1] - cam.position.y, -fp.FP_GAZE_DROP)
    && near(l[2] - cam.position.z, fz * fp.FP_GAZE_AHEAD));

  // own-body exclusion brackets ONLY the render: hidden before, restored after, the frame shot between
  check("own body hidden strictly around the render",
    JSON.stringify(seq) === JSON.stringify([false, "render", true]), JSON.stringify(seq));
}

{
  // the render's return value passes through untouched
  const cam = fakeCamera();
  const out = fp.composeFirstPerson({
    camera: cam, yaw: 0, head: [0, 1.5, 0], name: "r",
    setOwnVisible: () => {}, render: () => "data:image/png;base64,xyz",
  });
  check("render return value is the composition's return value", out === "data:image/png;base64,xyz");
}

{
  // async rendering would restore visibility before the deferred draw: rejected until a re-entrant async exclusion exists
  const cam = fakeCamera();
  let visible = true;
  let err = "";
  try {
    fp.composeFirstPerson({
      camera: cam, yaw: 0, head: [0, 1.5, 0], name: "async-rig",
      setOwnVisible: (v: boolean) => { visible = v; },
      render: () => Promise.resolve("late-frame"),
    });
  } catch (e) { err = (e as Error).message; }
  check("async render is rejected explicitly and visibility restored",
    visible === true && err.includes("async") && err.includes("async-rig"), err);
}

{
  // a throwing render still restores visibility: a leaked exclusion hides the body from every OTHER viewer of the scene
  const cam = fakeCamera();
  let visible = true;
  let threw = false;
  try {
    fp.composeFirstPerson({
      camera: cam, yaw: 0, head: [0, 1.5, 0], name: "r",
      setOwnVisible: (v: boolean) => { visible = v; },
      render: () => { throw new Error("empty frame readback"); },
    });
  } catch { threw = true; }
  check("render throw propagates AND visibility is restored", threw && visible === true);
}

{
  // an unsupported rig fails before anything is hidden or rendered
  const cam = fakeCamera();
  let touched = false;
  let threw = false;
  try {
    fp.composeFirstPerson({
      camera: cam, yaw: 0, name: "bare",
      setOwnVisible: () => { touched = true; }, render: () => { touched = true; return "x"; },
    });
  } catch { threw = true; }
  check("unsupported rig: throws before hide/render side effects", threw && !touched);
}

// ---- mounted geometry regression (the #75 shape, in numbers) ---------------

console.log("mounted geometry regression");
{
  // an elevated socket (y≈9.6) with head-volume geometry reaching 0.55m: the anchored eye is still inside the volume, so
  // this pins the pairing, anchored eye + own mesh hidden
  const socketY = 9.6, headY = socketY + 1.1, petalR = 0.55;
  const legacyEye = [0 + Math.sin(0) * 0.32, socketY + 1.52, 0 + Math.cos(0) * 0.32];  // the old fixed constants
  const legacyInside = Math.hypot(legacyEye[0] - 0, legacyEye[1] - headY, legacyEye[2] - 0) < petalR;
  check("control: main's fixed-offset eye lands inside the head volume", legacyInside);

  const seq: Array<boolean | string> = [];
  const cam = fakeCamera();
  fp.composeFirstPerson({
    camera: cam, yaw: 0, head: [0, headY, 0], name: "sill",
    setOwnVisible: (v: boolean) => seq.push(v),
    render: () => { seq.push("render"); return "ok"; },
  });
  const anchoredInside = Math.hypot(cam.position.x, cam.position.y - headY, cam.position.z) < petalR;
  check("anchored eye may sit in the head volume — and the volume is hidden for the frame",
    anchoredInside && JSON.stringify(seq) === JSON.stringify([false, "render", true]));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
