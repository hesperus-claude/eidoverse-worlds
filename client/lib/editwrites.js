// editwrites — edit mode's writes: every edit is the same REQUEST an agent sends, answered by an act or a refusal
// (shared/protocol/refusal.js).
//   send(req, opts)        a `locked` refusal offers "Move anyway" to who may lift it: same request + throughLock (§5); a refusal reverts the preview
//   sendOps(ops, opts)     ops (shared/protocol/requests.js) as ONE request: one edit is one act, so one Ctrl+Z
//   expectOf(ids, comps)   §3a: the values a gesture started from; refused `changed` if anyone wrote those since
//   undo() / redo()        `undo {act}` of MY last act; redo undoes the undo, refused if changed since (never back over later work)
//   del(ids), duplicate(ids), lock(id, on), publish(ids, name), copyBlueprint(hash, at)
import { bus } from './base.js';
import { net, sendRequest, replica, replicaActive, sendDrag } from './net.js';
import { entities } from './world.js';
import * as OP from '../../shared/protocol/requests.js';
import { enc, dec, actorName } from '../../shared/protocol/names.js';
import { refusalText, lockVerb, lockQuestion, lockChoices, lockBody } from '../../shared/protocol/refusal.js';
import { plain, warnPlain, nameOf as thingName } from './plainwords.js';
import { chooseCenter } from './confirmcenter.js';
import { chooseXR, xrActive } from './xrask.js';
import { flashHint, toast, claimStatus } from './ui.js';
import { isOwner } from '../../shared/protocol/roles.js';

export { replicaActive };
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const idIn = (id) => enc(String(id));
export const idOut = (id) => dec(id) ?? id;
/** a person's display name for an actor id (the authority directory's, via names.js; never the log's) */
export const nameOf = (id) => actorName(id);

// ---- my acts: what Ctrl+Z and redo walk (seeded at join from the server's act index, so it survives a reload) ----
const undoStack = [];   // my act seqs, newest last
const redoStack = [];   // my undo acts, newest last
bus.on('my-acts', (m) => { undoStack.splice(0, undoStack.length, ...(Array.isArray(m) ? m : [])); redoStack.length = 0; });
export const stacks = () => ({ undo: [...undoStack], redo: [...redoStack] });

/** A copy, or null. */
export function compsOf(id) { const e = replica.st?.entities?.[idIn(id)]; return e ? clone({ ...e.c }) : null; }
/** expect entries for these things' components, from `base` (id → comps, a gesture's start) or the fold now. */
export function expectOf(ids, comps, base = null) {
  const out = [];
  for (const id of ids) { const c = base?.[id] ?? compsOf(id); if (!c) continue;
    for (const k of comps) out.push(k in c ? { id: idIn(id), component: k, value: clone(c[k]) } : { id: idIn(id), component: k }); }
  return out;
}

/** What a gesture's expect covers. */
export function writesOf(req) {
  const ops = req.verb === 'batch' ? req.args.ops : [req];
  return ops.filter((o) => o.verb === 'set').map((o) => [idOut(o.args.id), o.args.component]);
}

/** May this viewer lift a lock (§5: builders and owners)? The lock question and the Hierarchy's lock icons ask this. */
// the authority decides; this only picks dialog vs refusal
export const mayLift = () => { const r = net.myRights; if (!r) return false;
  return Array.isArray(r.permissions) ? r.permissions.includes('build') : isOwner(r); };   // the build permission, never a role name

/** After a refused or cancelled gesture; tells everyone who watched the drag. */
export function revertPose(id) {
  bus.emit('pose-revert', { id });
  const o = entities.get(id); if (!o) return;
  const q = o.quaternion; const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.x * q.x + q.y * q.y));
  sendDrag(id, [o.position.x, o.position.y, o.position.z], yaw, [q.x, q.y, q.z, q.w]);
}

/** In a person's words (plainwords.js); the agent-form answer goes to the console and rides the event as agentText. */
export function showRefusal(what, r) {
  const text = plain(what, r), agentText = refusalText(what, r);
  console.info('[editwrites] refused:', agentText);
  toast(text, 'warn', 9000);
  bus.emit('edit-refused', { what, refused: r.refused, text, agentText });
  return text;
}
/** The authority's warnings on a write that went through (it overlaps, it floats…). */
export function showWarnings(what, r) {
  const ws = Array.isArray(r?.warnings) ? r.warnings.filter((w) => w && w.kind !== 'unchecked') : [];
  if (!ws.length) return null;
  const text = `Done, but ${ws.slice(0, 3).map(warnPlain).join('; ')}${ws.length > 3 ? ` (and ${ws.length - 3} more)` : ''}`;
  claimStatus('warn', { priority: 3, content: text, ttl: 6000 });   // the status bar, not a toast: it's about what I just did
  bus.emit('edit-warned', { what, warnings: ws, text });
  return text;
}

// Ctrl+Z waits for these, or a quick one after a release undoes the act BEFORE it (not on the stack until its reply)
const inflight = new Set();
const settled = () => Promise.allSettled([...inflight]);
/** One request, waiting for the authority. opts: {what, revert(), record = true}. Returns the final reply. */
export function send(req, opts = {}) {
  const p = sendNow(req, opts); inflight.add(p); p.finally(() => inflight.delete(p));
  return p;
}
const dropAct = (stack, act) => { const i = stack.lastIndexOf(act); if (i >= 0) stack.splice(i, 1); };
const remember = (act) => { undoStack.push(act); if (undoStack.length > 200) undoStack.shift(); redoStack.length = 0; };
async function sendNow(req, { what = req.verb, revert = null, record = true } = {}) {
  bus.emit('edit-sending', { req, what });
  let r = await sendRequest(req.verb, req.args);
  // a lock (§5): ✓ throughLock; ✕ revert; 🔓 delete the lock then send (two acts; never offered to undo/redo)
  let cancelled = false;
  // a lock above your rank (mayLift: false) is not yours to go through or lift: words, no buttons
  for (let round = 0; round < 8 && !r.ok && r.refused?.code === 'locked' && r.refused?.mayLift !== false && req.args?.throughLock !== true && mayLift(); round++) {
    const verb = lockVerb(req);
    // a delete or a replace through a lock is the destructive answer: styled so, and NOT the one Enter gives
    const destructive = verb === 'Delete' || verb === 'Replace';
    const choices = lockChoices(verb).filter((c) => record || c.v !== 'unlock').map((c) => (destructive && c.v === 'through' ? { ...c, danger: true } : c));
    console.info('[editwrites] lock:', refusalText(what, r));
    const choice = await (xrActive() ? chooseXR : chooseCenter)({ title: lockQuestion(verb), body: lockBody(r, req.args?.id, thingName), choices, cancel: 'cancel', ...(destructive ? { focus: 'cancel' } : {}) });   // a DOM card isn't drawn in a headset (xrask.js)
    bus.emit('edit-lock-asked', { what, yes: choice === 'through', choice });
    if (choice === 'through') { r = await sendRequest(req.verb, { ...req.args, throughLock: true }); break; }
    if (choice !== 'unlock') { cancelled = true; break; }
    const k = r.refused.lock;
    const u = await sendRequest('delete', { id: k, component: 'lock' });
    if (!u.ok) { r = u; what = `unlock ${idOut(k)}`; break; }
    if (Number.isInteger(u.act)) remember(u.act);
    bus.emit('edit-done', { what: `unlock ${idOut(k)}`, req: { verb: 'delete', args: { id: k, component: 'lock' } }, reply: u });
    r = await sendRequest(req.verb, req.args);
  }
  if (r.ok) {
    if (record && Number.isInteger(r.act)) remember(r.act);
    bus.emit('edit-done', { what, req, reply: r });
    showWarnings(what, r);
  } else {
    try { revert?.(); } catch (e) { console.warn('[editwrites] revert', e); }
    if (cancelled) { flashHint('cancelled — nothing written'); bus.emit('edit-cancelled', { what, refused: r.refused }); }
    else showRefusal(what, r);
  }
  return r;
}
/** One act, one Ctrl+Z; `expect` is what it sets as seen at `base` (a gesture's start: id → components) or now. */
export async function sendOps(ops, { what, base = null, expect = true, revert = null } = {}) {
  const req = OP.batch(Array.isArray(ops) ? ops : [ops]);
  if (!req) return { ok: true, noop: true };
  if (expect) {
    const pairs = OP.writesOf(req); const ids = [...new Set(pairs.map(([i]) => i))];
    const ex = ids.flatMap((i) => expectOf([idOut(i)], [...new Set(pairs.filter(([j]) => j === i).map(([, k]) => k))], base));
    if (ex.length) req.args = { ...req.args, expect: ex };
  }
  return send(req, { what, revert });
}

// ---- undo / redo: the authority's undo-by-act, of my own acts only ----
// presses queue: two at once read the same top act, and the refused one's pop would drop the act below, never undone
let turn = Promise.resolve();
const inTurn = (fn) => { const r = turn.then(fn, fn); turn = r.catch(() => {}); return r; };
export function undo() { return inTurn(undo1); }
export function redo() { return inTurn(redo1); }
async function undo1() {
  await settled();
  const act = undoStack.at(-1);
  if (act === undefined) { flashHint('nothing of yours to undo here'); return { ok: false, refused: { code: 'nothing' } }; }
  const r = await send({ verb: 'undo', args: { act } }, { what: 'undo', record: false });
  // by value, not the top: an edit sent while this undo was in flight may have pushed its act above this one
  if (r.ok) { dropAct(undoStack, act); redoStack.push(r.act); flashHint(`undid your act ${act}${r.notes?.some((n) => n.skipped) ? ' (some of it had been changed since: kept theirs)' : ''}`); }
  // a permanent refusal drops it so the next Ctrl+Z reaches the act before; a lock or rate limit leaves it
  else if (['nothing', 'conflict', 'physical', 'founding'].includes(r.refused?.code) && undoStack.at(-1) === act) undoStack.pop();
  return r;
}
async function redo1() {
  await settled();
  const act = redoStack.at(-1);
  if (act === undefined) { flashHint('nothing to redo'); return { ok: false, refused: { code: 'nothing' } }; }
  const r = await send({ verb: 'undo', args: { act } }, { what: 'redo', record: false });
  if (r.ok) { dropAct(redoStack, act); undoStack.push(r.act); flashHint('redone'); }
  else if (['nothing', 'conflict'].includes(r.refused?.code) && redoStack.at(-1) === act) redoStack.pop();
  return r;
}

// ---- the whole-thing edits ----
/** Several ids are one `batch` (one undo); a thing whose ancestor is going is left out (children go with it). */
export function del(ids) {
  const st = replica.st; const set = new Set(ids.map(idIn));
  const under = (x) => { let p = st.entities[x]?.c.parent?.to, n = 0; while (p && n++ < 32) { if (set.has(p)) return true; p = st.entities[p]?.c.parent?.to; } return false; };
  const go = [...set].filter((x) => st.entities[x] && !under(x));
  if (!go.length) return Promise.resolve({ ok: true, noop: true });
  const req = go.length === 1 ? { verb: 'delete', args: { id: go[0] } } : { verb: 'batch', args: { ops: go.map((id) => ({ verb: 'delete', args: { id } })) } };
  return send(req, { what: go.length === 1 ? `delete ${idOut(go[0])}` : `delete ${go.length} things` });
}
/** create {from} copies it and what's attached; 0.5 m along x. */
export function duplicate(id, at = undefined) {
  return send({ verb: 'create', args: { from: idIn(id), ...(at ? { at } : {}) } }, { what: `duplicate ${id}` });
}
/** `set lock true` / `delete lock` (§5). */
export function lock(id, on) {
  return send(on ? { verb: 'set', args: { id: idIn(id), component: 'lock', value: true } } : { verb: 'delete', args: { id: idIn(id), component: 'lock' } },
    { what: on ? `lock ${id}` : `unlock ${id}` });
}
/** `publish {from, name}`: one root, or several siblings as a group. */
export function publish(ids, name) {
  const from = ids.length === 1 ? idIn(ids[0]) : ids.map(idIn);
  return send({ verb: 'publish', args: { from, ...(name ? { name } : {}) } }, { what: `save ${ids.length === 1 ? ids[0] : `${ids.length} things`} as a blueprint` });
}
/** create {from: hash, at} */
export function copyBlueprint(hash, at) {
  return send({ verb: 'create', args: { from: hash, ...(at ? { at } : {}) } }, { what: 'place a copy' });
}
/** From the fold: @world blueprints:<hash> → {name, parts}. */
export function blueprints() {
  const c = replica.st?.entities?.['@world']?.c ?? {};
  return Object.keys(c).filter((k) => k.startsWith('blueprints:')).map((k) => ({ hash: `sha256:${k.slice('blueprints:'.length)}`, ...(c[k] && typeof c[k] === 'object' ? c[k] : {}) }));
}
/** This thing or anything it rides, as the authority reads it (a purged value isn't truthy). */
export function lockedBy(id) {
  const st = replica.st; let x = idIn(id), n = 0;
  while (x && n++ < 33) { const v = st?.entities?.[x]?.c.lock; if (v !== undefined && !(v && v.purged === true) && !!v) return idOut(x); x = st?.entities?.[x]?.c.parent?.to; }
  return null;
}

// harness window: the stacks and the module, for the suites (tools/protocol/client-check.ts)
globalThis.__editWrites = () => ({ undo: [...undoStack], redo: [...redoStack], active: replicaActive() });

/** Each selected thing's home becomes where it stands now. */
export function setHomeHere(ids) {
  const ops = ids.map((id) => { const c = compsOf(id); if (!c) return null; const t = c.transform ?? {};
    return OP.set(id, 'home', { pos: (t.pos ?? [0, 0, 0]).slice(), q: (t.q ?? [0, 0, 0, 1]).slice(), ...(c.parent?.to ? { parent: { to: c.parent.to } } : {}) }); }).filter(Boolean);
  return ops.length ? sendOps(ops, { what: ids.length > 1 ? `set ${ids.length} homes here` : `set ${ids[0]}'s home here` }) : Promise.resolve({ ok: true, noop: true });
}
/** The button's reactions gain 'reset'; each target gets a home where it stands. */
export function makeResetButton(button, targets) {
  const c = compsOf(button) ?? {}; const reactions = { ...(c.reactions ?? {}), reset: { kind: 'reset', targets: targets.map(idIn) } };
  return sendOps([OP.set(button, 'reactions', reactions)], { what: `make ${button} a reset button for ${targets.length} thing${targets.length > 1 ? 's' : ''}` });
}
/** Written whole (the grip editor's grabbable), with expect, undoable. */
export function setComp(id, comp, value, what) { return sendOps([OP.set(id, comp, value)], { what }); }
