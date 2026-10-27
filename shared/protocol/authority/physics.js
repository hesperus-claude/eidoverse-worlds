// shared/protocol/authority/physics.js — physics (design 20), the engine and the body: settleSim (the rests a request logs),
// restampEngine, buildEpoch, a body's track and hand, what is solid, ground steps and blocked paths, a body's size and law.
// Occupants: occupants.js; body-on-thing: manipulate.js; body verbs: bodyverbs.js.
import { MOVER, bodyBox, bodyScale, floorStep, sweep } from "../../mover.js";
import { COMPONENTS } from "../componentspec.js";
import { livePoses, digestOf, restEta, ENGINES, carried, TICK_MS, engineName, stampOf } from "../simlayer.js";
import { HAND_Y } from "../physconst.js";
import { r3, noNeg0 } from "../round.js";
import { qFromYaw, qMul } from "../../rot.js";
import { UP } from "./ctx.js";
import { Refusal, refuse, said } from "./refuse.js";
import { readback, delOp, holdsCustody, isE, opsQuiet, scratch, setOp } from "./storage.js";
import { aabb, descendants, localFrom, worldT } from "./math.js";
import { groundOf, groundReady, hitsIx, near, spatial, spend, supportBelow, supportUnder } from "./spatial.js";
// layers above this one (a leaf may not import them), through UP (ctx.js)
const actEntry = (...a) => UP.actEntry(...a);
const admit = (...a) => UP.admit(...a);
const boundsOf = (...a) => UP.boundsOf(...a);
const changeEntry = (...a) => UP.changeEntry(...a);
const guess = (...a) => UP.guess(...a);
const outsideWorld = (...a) => UP.outsideWorld(...a);
const returnPlan = (...a) => UP.returnPlan(...a);
const unknownKeys = (...a) => UP.unknownKeys(...a);

// ---------- physics (design 20) ----------
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const gripPoint = (me) => [me.at[0], me.at[1] + HAND_Y, me.at[2]]; // reach is measured from the hand, not the feet
// P5 + L3: a logged rest is the engine's value only (caused by the launch, checked by admit); whatever the authority then
// does about it is a SEPARATE system entry, so a rest and a correction never look alike
const REST_COALESCE_TICKS = 15;   // ~0.5 s at 33 ms: PHYSICS §4.4's settlement window
// a child of a NON-UNIFORMLY scaled parent is sheared unless its local rotation keeps the parent's axes (a crate square on a
// flat tray: fine; a tumbled crate on a fallen domino: sheared)
const uniformScale = (sc) => Math.max(...sc) - Math.min(...sc) <= 0.01 * Math.max(...sc);
const axisAligned = (q) => { const [x, y, z, w] = q; const ax = [[1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)], [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)]];
  return ax.every((v) => v.some((c) => Math.abs(c) > 0.995)); };
const shearFree = (parentScale, localQ) => uniformScale(parentScale) || axisAligned(localQ);
function settleSim(w) {
  const skip = new Set(); w.unsettled = [];
  if (!w.state().entities["@world"]?.c["physics-engine"]) return; // no engine: nothing in flight (an epoch cut logs every rest first, P6)
  if (!holdsCustody(w)) return;   // a server that can't sign for the world can't log a rest: its reads still work, and the rests wait
  let digested = false;
  for (let guard = 0; guard < 64; guard++) {
    // the lowest first: a support rests before what it carries (else its rest moves it and drags a child that settled onto it into a neighbour)
    const sf = w.sim(); let due = sf.rested.filter((x) => !skip.has(`${x.id}@${x.seq}`)).sort((a, b) => a.p[1] - b.p[1]); if (!due.length) return;
    // a launch's rests are logged together: when its last body rests, or its oldest unlogged rest is REST_COALESCE_TICKS old
    // (a cascade rests one crate at a time over seconds). The rest tick is the engine's either way; only the entry's ts is later.
    const ready = (seq) => { const mine = due.filter((x) => x.seq === seq); const flying = Object.entries(sf.launched).some(([id, l]) => l.seq === seq && sf.sim.bodies[id] && !sf.sim.bodies[id].resting);
      return !flying || mine.some((x) => x.lost) || Math.min(...mine.map((x) => x.tick)) <= sf.sim.tick - REST_COALESCE_TICKS; };
    due = due.filter((x) => ready(x.seq)); if (!due.length) return;
    // one change per launch per pass, every body that launch set moving (PHYSICS §1; one change per body cost 1.16 KB and 2.4
    // entries per rested body), and one digest per pass: every rest in a pass is at the same clock. A batch one body spoils
    // falls back to one rest at a time (its refusal names it).
    const batch = due.filter((x) => x.seq === due[0].seq);
    const st = w.state();
    const opsFor = (r) => { const t = worldT(st, r.id); return [...(st.entities[r.id].c.parent ? [delOp(r.id, "parent")] : []), setOp(r.id, "transform", { pos: r.p.slice(), q: r.q ? r.q.slice() : t.q, scale: t.scale })]; };
    let plan = null, group = batch;
    try { plan = admit(w, st, { actor: "sim", cap: { kind: "rest", ids: batch.map((r) => r.id), comps: ["transform", "parent"], launch: batch[0].seq } }, batch.flatMap(opsFor)); }
    catch (e) { if (!(e instanceof Refusal)) throw e;
      if (batch.length === 1) { w.unsettled.push({ id: batch[0].id, launch: batch[0].seq, refused: e.code, reason: e.reason }); skip.add(`${batch[0].id}@${batch[0].seq}`); continue; } // 33 F2
      group = [batch[0]];
      try { plan = admit(w, st, { actor: "sim", cap: { kind: "rest", ids: [batch[0].id], comps: ["transform", "parent"], launch: batch[0].seq } }, opsFor(batch[0])); }
      catch (e2) { if (!(e2 instanceof Refusal)) throw e2; w.unsettled.push({ id: batch[0].id, launch: batch[0].seq, refused: e2.code, reason: e2.reason }); skip.add(`${batch[0].id}@${batch[0].seq}`); continue; } }
    if (!digested) { w.append({ kind: "sim", actor: "sim", cause: group[0].seq, verb: "digest", body: { digest: digestOf(sf.sim) } }); digested = true; }
    const rest = changeEntry(w, plan, group[0].seq);
    for (const r of group) {
      const st2 = w.state(); const B = boundsOf(st2);
      if (B && outsideWorld(B, r.p)) {
        // it landed outside the world: lost. The authority sends it home when it has one, else back to where it was picked up,
        // as its own act.
        const old = st.entities[r.id].c; const hm = old.home;
        const viaHome = hm && Array.isArray(hm.pos) && hm.pos.length === 3 && Array.isArray(hm.q) && hm.q.length === 4 ? returnPlan(w, st2, r.id, { home: hm }) : null;
        if (viaHome?.plan) { changeEntry(w, viaHome.plan, w.append(actEntry(w, "system", "return-lost", { id: r.id, rest, home: true }))); continue; }
        const back = [setOp(r.id, "transform", old.transform), ...(old.parent ? [setOp(r.id, "parent", old.parent)] : [])];
        const p2 = admit(w, st2, { actor: "system", cap: { kind: "system", ids: [r.id], comps: ["transform", "parent"] } }, back);
        changeEntry(w, p2, w.append(actEntry(w, "system", "return-lost", { id: r.id, rest })));
        continue;
      }
      // it rests ON what its footprint touches (within 3 cm), parented as place does so it moves along; never onto a HELD
      // thing, which still stands in the log where it was picked up
      const fam = new Set([r.id, ...descendants(st2, r.id)]); const bx = aabb(st2, r.id);
      for (const k of Object.keys(w.presence.holds)) if (st2.entities[k]) for (const d of [k, ...descendants(st2, k)]) fam.add(d);
      if (!groundReady(st2)) continue;   // the ground still loading: no rest-attach judged on a guessed height
      const sup = bx ? supportUnder(st2, bx, fam) : supportBelow(st2, r.p[0], r.p[2], r.p[1] + 0.02, fam);
      if (sup.id === "ground" || (bx && sup.y < bx.min[1] - 0.03)) continue;
      // never under a support whose scale isn't uniform (a domino at [1, 2, 0.2]): a child of a rotated, non-uniformly scaled
      // parent is SHEARED by the composition
      const wt = worldT(st2, r.id); const s3 = scratch(st2, [setOp(r.id, "parent", { to: sup.id })]); const lt = localFrom(s3, sup.id, wt);
      if (!shearFree(worldT(st2, sup.id).scale, lt.q)) continue;
      const attach = [setOp(r.id, "parent", { to: sup.id }), setOp(r.id, "transform", lt)];
      const p3 = admit(w, st2, { actor: "system", cap: { kind: "system", ids: [r.id], comps: ["transform", "parent"] } }, attach);
      changeEntry(w, p3, w.append(actEntry(w, "system", "settle", { id: r.id, onto: sup.id, rest })));
    }
  }
}
// After a deploy, a world stamped with a version this server doesn't carry is restamped (system) at the first act or
// heartbeat, if this server carries the engine NAME, the version was stamped (not named by the owner), and nothing is held;
// in-flight launches end where the fold has them. Else it stays foreign (owner: force). Checked once per world and spec.
// What only the world's engine computes is refused when this server doesn't carry it: named, never quietly replaced.
export function refuseForeign(spec, what) {
  refuse("foreign-engine", `this world runs ${spec.engine}, which this server doesn't carry: ${what}, and only that engine computes it`,
    `put it down or leave it be; an owner can set one this server carries: set {id: '@world', component: 'physics-engine', value: {engine: '${engineName(spec.engine)}'}}`);
}
const restampTried = new WeakMap();
function restampEngine(w) {
  const st = w.state(); const spec = st.entities["@world"]?.c["physics-engine"]; const today = spec && typeof spec.engine === "string" ? stampOf(engineName(spec.engine)) : null;
  if (!today || carried(spec)) return;   // a name this server doesn't carry is never restamped: there's nothing to cut to
  const key = JSON.stringify(spec); if (restampTried.get(w) === key) return;
  if (w.custody?.()?.sign && w.custody().sequencer() !== w.entries[0]?.body?.sequencer) return;   // a server that can't sign for the world doesn't write to it
  if (Object.keys(w.presence?.holds ?? {}).length) return;   // held right now: try again at the next act
  restampTried.set(w, key);
  // named by the owner? the cause act carries the request as sent (L4); a merge of tickMs alone names none, a fork-copy is
  // inherited, and system acts never name
  const word = (v) => { if (!v || typeof v !== "object") return undefined; if (Array.isArray(v)) { for (const x of v) { const r = word(x); if (r !== undefined) return r; } return undefined; }
    if (v.component === "physics-engine" && typeof v.value?.engine === "string") return v.value.engine;
    for (const x of Object.values(v)) { const r = word(x); if (r !== undefined) return r; } return undefined; };
  // READBACK: a purged cause act (readback null) is an UNKNOWN chooser, and unknown means the owner may have chosen it: never
  // restamped (engine-scars 4/6c). → "named" (the owner's word), "stamped" (an authority's), or "skip" (look further back)
  const chose = (e) => { const c = E[e.cause]; if (!(isE(c) && c.kind === "act") || c.actor === "system" || c.verb === "fork-copy") return "stamped";
    const b = readback(w, e.cause); if (b === null) return "named";
    const t = word(b.request); return t === undefined ? "skip" : t.includes("@") ? "named" : "stamped"; };
  // walking back from the newest physics-engine change, the first whose act typed an engine decides: a version typed is the
  // owner's, the engine alone is stamped (never compare VALUES: a stamp equal to an earlier named version would read as the
  // owner's). A delete ends it: the epoch before is another world's physics.
  const E = w.entries; let from = -1;
  for (let s = E.length - 1; s >= 0; s--) { const e = E[s]; if (!(isE(e) && e.kind === "change")) continue;
    const o = opsQuiet(e).filter((x) => x.id === "@world" && x.comp === "physics-engine").at(-1); if (!o) continue;
    if (from < 0) from = s;
    if (o.verb !== "set") break;
    const c = chose(e); if (c === "named") return; if (c === "stamped") break; }
  if (from < 0) return;
  // this server can't compute the old version's flights, so each is ended where the fold has it and named in the act. A lift
  // on the record doesn't hold the cut back; only a hold in presence does.
  const out = new Map();   // id → the launch seq it flies under, or "held"
  let unknownFlights = 0;
  for (let s = from + 1; s < E.length; s++) { const e = E[s]; if (!isE(e)) continue;
    if (e.kind === "sim") { const b = readback(w, s); if (b === null && ["launch", "lift", "catch"].includes(e.verb)) { if (e.verb === "launch") unknownFlights++; continue; }   // READBACK: a purged flight names no body: unknown, so counted as ended by the cut
      if (b?.id) { if (e.verb === "launch") out.set(b.id, s); else if (e.verb === "lift" || e.verb === "catch") out.set(b.id, "held"); } continue; }
    if (e.kind !== "change") continue;
    const c = E[e.cause]; const rest = isE(c) && c.kind === "sim" && c.verb === "launch";
    for (const o of opsQuiet(e)) { const f = out.get(o.id); if (f === undefined) continue;
      if (rest ? f === e.cause : (f === "held" && (o.verb === "create" || ["transform", "parent"].includes(o.comp) || (o.comp === "disabled" && o.verb === "set" && o.value === true)))) out.delete(o.id);
      else if (o.verb === "delete" && o.comp === undefined) out.delete(o.id); } }
  const ended = [...out].filter(([, f]) => f !== "held").map(([id]) => id).sort();
  const next = { engine: today, ...(spec.tickMs !== undefined ? { tickMs: spec.tickMs } : {}) };   // declared fields only: an older value's build goes
  let plan; try { plan = admit(w, st, { actor: "system", cap: { kind: "system", ids: ["@world"], comps: ["physics-engine"] } }, [setOp("@world", "physics-engine", next)]); }
  catch (x) { if (!(x instanceof Refusal)) throw x; return; }
  changeEntry(w, plan, w.append(actEntry(w, "system", "restamp-engine", { id: "@world", component: "physics-engine", from: spec.engine, to: next.engine,
    ...(ended.length ? { ended } : {}), ...(unknownFlights ? { endedUnknown: unknownFlights } : {}),
    why: ended.length || unknownFlights ? `engine ${spec.engine} → ${next.engine}: restamped by the server; ${ended.length + unknownFlights} flight(s) it can't compute ended by the cut, where the log has them`
      : `engine ${spec.engine} → ${next.engine}: restamped by the server; bodies at rest` })));
}
// P6: an engine change is a real cut. At rest the cut is free (the log already holds every result); in flight it waits.
function buildEpoch(ctx, v, a) {
  const sf = ctx.w.sim(); const live = [...new Set([...Object.keys(livePoses(sf)), ...sf.rested.map((r) => r.id)])]; // at rest but not on the record counts (33 F2): P6's "free" needs every result logged
  if (live.length && !a.force) refuse("busy", `${live.length} thing(s) are still in flight or not yet on the record (${live.join(", ")}); all at rest in about ${r3((restEta(sf) ?? 0) / 1000)} s`, "try again then, or force: true to freeze them where they are now (they'll be logged there)");
  // a rigid engine's origin only means something with its own q. The pose is the engine's WORLD pose, so a logged parent goes,
  // as settleSim's opsFor drops it: kept, its offset would be applied again
  const ops = live.flatMap((id) => { const b = sf.sim.bodies[id]; return [...(sf.st.entities[id]?.c.parent ? [delOp(id, "parent")] : []), setOp(id, "transform", { ...worldT(sf.st, id), pos: b.p.slice(), ...(b.q ? { q: b.q.slice() } : {}) })]; });
  for (const id of live) ctx.refs.add(id);
  if (live.length) ctx.notes.push({ frozen: live, why: "forced cut: stopped mid-air and logged where they were" });
  if (v === null) return [...ops, delOp("@world", "physics-engine")];
  if (!v || typeof v.engine !== "string") refuse("shape", "sim needs {engine, tickMs?}", `engines this server carries: ${Object.keys(ENGINES).join(", ")}`);
  unknownKeys("@world.physics-engine", v, Object.keys(COMPONENTS["physics-engine"].fields), "physics-engine"); // the authority builds the value from these keys: a typo would vanish silently
  // a version named is the owner's word; with none, the authority stamps the one it carries (#260)
  const versioned = v.engine.includes("@"), stamp = stampOf(engineName(v.engine));
  const spec = { engine: versioned ? v.engine : stamp, tickMs: Number.isInteger(v.tickMs) ? v.tickMs : COMPONENTS["physics-engine"].defaults.tickMs };   // the registry's default
  if (!stamp) refuse("unknown-engine", `this server carries no engine named '${engineName(v.engine)}'`, `it carries: ${Object.keys(ENGINES).join(", ")}`, { didYouMean: guess(v.engine, Object.keys(ENGINES)) });
  // the engine never starts an epoch outside its tick range, so a throw would be logged and then fly nowhere, forever
  if (v.tickMs !== undefined && !(Number.isInteger(v.tickMs) && v.tickMs >= TICK_MS.min && v.tickMs <= TICK_MS.max))
    refuse("bounds", `tickMs is ${JSON.stringify(v.tickMs)}; the engine steps at a whole number of ms from ${TICK_MS.min} to ${TICK_MS.max}`, `leave it out for ${COMPONENTS["physics-engine"].defaults.tickMs} (30 steps a second), or e.g. tickMs: 16`);
  if (!versioned) ctx.notes.push({ component: "physics-engine", field: "engine", kept: spec.engine, why: "stamped: no version named, so the authority names the one it carries (a version is what its conformance digests say it computes)" });
  if (!carried(spec)) ctx.notes.push({ component: "physics-engine", why: `${spec.engine} isn't carried here (this server carries ${stamp}): nothing will be thrown in this world until a server that carries it runs it, or an owner sets one this server carries` });
  // what is in a hand as the engine starts stays out of its world. Holds are presence, which no reader replays, so the epoch
  // write logs one lift per such thing (commit appends them after the change) and every reader folds the same engine world
  // from the log alone. Older logs without these stay as they are.
  else ctx.lifts = Object.keys(ctx.w.presence.holds ?? {}).filter((id) => ctx.st.entities[id] && !sf.lifted.has(id)).sort();
  ctx.refs.add("@world");
  return [...ops, setOp("@world", "physics-engine", spec)];
}
function body(w, actor) {
  const b = w.presence.bodies[actor];
  if (!b) refuse("not-here", "your body isn't in the world yet", "move {to: [x, y, z]} puts it somewhere (bodies are presence: never logged)");
  return b;
}
// a carried thing turns with its holder's body: the hold keeps the holder's facing as taken and lets go turned by as far as
// the body has turned since (yaw only). Facing is the relayed pose's root yaw; unknown means as taken.
function facingOf(w, actor) { for (const p of w.present?.() ?? []) if (p && p.id === actor && Number.isFinite(p.yaw)) return p.yaw; return null; }
/** As it was taken, turned about up by how far its holder has turned since. */
function heldQ(w, h) { const y = facingOf(w, h.by); const q = h.pose?.q;
  if (!Number.isFinite(h.facing) || y === null || !Array.isArray(q)) return q;
  return qMul(qFromYaw(y - h.facing), q).map((n) => noNeg0(Math.round(n * 1e6) / 1e6)); }
function gripOf(w, actor, id) {
  const h = w.presence.holds[id];
  // gone first: a delete releases the hold itself, so a put of a deleted thing says it's gone, not 'not-holding'
  if (!w.state().entities[id]) { if (h) { delete w.presence.holds[id]; w.savePresence(); } refuse("gone", h?.by === actor || !h ? `${id} isn't here any more (it was deleted)` : `${id} was deleted`, "your hand is empty now"); }
  if (!h || h.by !== actor) refuse("not-holding", `you aren't holding ${id}${h ? ` (${said(h.by)} is)` : ""}`, `grab {id: '${id}'} first`);
  return h;
}
// L6: the authority's own plausibility TRACK of each body (presence, unlogged): where it last ACCEPTED it, never a claim.
// Walking spends a token bucket and can't enter a solid; a teleport is an act (refused while holding, inside a solid, or
// off @world.spawn for visitors). Numbers and box are shared/mover.js's, so a step the mover takes is one this accepts.
function solidAt(w, st, p, except = new Set(), cands = null, box = bodyBox(p)) {
  const held = w.presence.holds; const ix = cands && spatial(st);
  if (cands) spend(1 + (cands.length >> 3));   // a sub-step filters the step's candidates by box first
  for (const id of cands ?? near(st, box.min, box.max)) { if (id === "@world" || Object.hasOwn(held, id) || except.has(id) || openNow(st, id)) continue;
    if (cands) { const q = ix.rec.get(id).q; if (q.min[0] > box.max[0] || q.max[0] < box.min[0] || q.min[1] > box.max[1] || q.max[1] < box.min[1] || q.min[2] > box.max[2] || q.max[2] < box.min[2]) continue; }
    if (hitsIx(st, box, id, 0.01)) return id; }
  return null;
}
// an open openable (a whole door, not a cabinet's part) is out of the way: every browser's collider follows the drawn leaf
// (client/lib/openable.js reindexes it at rest)
const openNow = (st, id) => { const o = st.entities[id]?.c.openable; return !!o && typeof o === "object" && o.open === true && !o.part; };
// THE GROUND under a body: each point of a step judged by shared/mover.js floorStep on terrain and steppable tops, as a chain
// of sub-strides at least MOVER.track.sweep apart (millimetre steps would walk up any steep-but-continuous wall). A flat
// world (no terrain) is y 0 and dry.
function bodyAt(st, p) {   // where a body claimed at p stands: {y (feet), ground}
  const g = supportBelow(st, p[0], p[2], p[1]).y; return { y: Math.max(p[1], g), ground: g };
}
// the body's own size, from the height and scale it sends (absent: 1.7 m at scale 1), bounded as the walker bounds them
// (scale 0.5-2, mover.js bodyScale; height 0.5-4 m), so a claim buys only what honest bodies may do
const BODY_H = Object.freeze({ min: 0.5, max: 4 });
function sizeOf(a, prev) {
  const out = { ...(prev ?? {}) };
  for (const k of ["height", "scale"]) if (a[k] !== undefined && !(typeof a[k] === "number" && Number.isFinite(a[k]) && a[k] > 0))
    refuse("shape", `move's ${k} is a positive number (${k === "height" ? "your body's standing height in metres, 0.5-4" : "your body's size, 0.5-2"})`, "send the number your walker uses, or leave it out");
  if (a.height !== undefined) out.height = Math.min(BODY_H.max, Math.max(BODY_H.min, a.height));
  if (a.scale !== undefined) { const sc = bodyScale(a.scale); if (sc === 1) delete out.scale; else out.scale = sc; }
  return Object.keys(out).length ? out : undefined;
}
// the walker's own arguments for this body: floorStep's {height, scale}, bodyBox's scale
const lawOf = (size) => ({ height: size?.height, scale: bodyScale(size?.scale) });
function groundSteps(st, from, pts, size) {
  const G = groundOf(st); if (!G.terrain) return null;
  const { height, scale: s } = lawOf(size), lv = G.level, reachW = lv != null ? lv + MOVER.swim.climb * s : -Infinity;
  const step = (o) => floorStep({ ...o, height, scale: s });
  const b0 = bodyAt(st, from); const r0 = step({ y: b0.y, ground0: b0.ground, level0: lv, f: b0.ground, level1: lv });
  let cur = { y: b0.y, ground: b0.ground }, lastSwim = r0.stance?.swimming ? cur : null;
  const out = [{ p: from, box: bodyBox([from[0], Math.max(from[1], r0.swim ? from[1] : b0.y), from[2]], s, r0.swim ? lv : null) }];
  let judged = from, swimNow = r0.swim;
  for (let k = 0; k < pts.length; k++) { const p = pts[k];
    if (k < pts.length - 1 && Math.hypot(p[0] - judged[0], p[2] - judged[2]) < MOVER.track.sweep - 1e-9) {   // within this sub-stride: as judged
      out.push({ p, box: bodyBox([p[0], Math.max(p[1], cur.y), p[2]], s, swimNow ? lv : null) }); continue; }
    judged = p;
    const reach = Math.max(cur.y + MOVER.body.step * s, lastSwim ? reachW : -Infinity);
    const f = supportBelow(st, p[0], p[2], reach).y;
    let r = step({ y: cur.y, ground0: cur.ground, level0: lv, f, level1: lv });
    if (r.blocked && lastSwim) { const r2 = step({ y: lastSwim.y, ground0: lastSwim.ground, level0: lv, f, level1: lv }); if (!r2.blocked) r = r2; }
    if (r.blocked) return { blocked: { at: p, top: r.blocked.top, from: cur.y, swim: !!lastSwim && r.swim }, out };
    // the box: the swimmer's while the water's rule holds; else the body's own at its claim (an upstairs the law can't see)
    // or the floor the law put it on, whichever is higher (a body hauled out onto a dock sends the bed's height)
    out.push({ p, box: bodyBox([p[0], Math.max(p[1], r.y), p[2]], s, r.swim ? lv : null) });
    cur = { y: r.y, ground: f }; swimNow = r.swim; if (r.stance?.swimming) lastSwim = cur;
  }
  return { blocked: null, out };
}
function pathBlocked(w, st, from, to, size) {
  const pts = sweep(from, to); const law = groundSteps(st, from, pts, size), s = lawOf(size).scale;
  if (law?.blocked) { const L = law.blocked;
    return { ground: true, reason: L.swim ? `the bank at [${L.at.map(r3).join(", ")}] stands ${r3(L.top - groundOf(st).level)} m above the water: higher than a swimmer can haul out (${r3(MOVER.swim.climb * s)} m)`
      : `the ground at [${L.at.map(r3).join(", ")}] rises ${r3(L.top - L.from)} m from where you stand: a ledge higher than a step (${r3(MOVER.body.step * s)} m)` }; }
  const boxes = law ? law.out.map((x) => x.box) : [bodyBox(from, s), ...pts.map((p) => bodyBox(p, s))];
  const already = new Set(); const b0 = boxes[0]; // a body already inside something may walk out of it
  for (const id of near(st, b0.min, b0.max)) if (hitsIx(st, b0, id, 0.01)) already.add(id);
  const lo = [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.min[i]))), hi = [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b.max[i])));
  const swept = near(st, lo, hi);
  for (let k = 0; k < pts.length; k++) { const hit = solidAt(w, st, pts[k], already, swept, boxes[k + 1]); if (hit) return hit; }
  return null;
}
// a body arriving at p (a teleport): the swimmer's box when the water's rule holds there
function arrivalBox(st, p, size) {
  const { height, scale } = lawOf(size), G = groundOf(st); if (!G.terrain || G.level == null) return bodyBox(p, scale);
  const b = bodyAt(st, p); const r = floorStep({ y: b.y, ground0: b.ground, level0: G.level, f: b.ground, level1: G.level, height, scale });
  return bodyBox(p, scale, r.swim ? G.level : null);
}
export { arrivalBox, body, buildEpoch, dist, facingOf, gripPoint, gripOf, heldQ, lawOf, pathBlocked, restampEngine, settleSim, shearFree, sizeOf, solidAt };
