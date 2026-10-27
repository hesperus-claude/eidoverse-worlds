// consent-switch-test: my body's switch is what the authority decides by, and a failed sync is heard, then retried.
// The client owns the last word (consent.js); the server's table is a projection of the switches, sent on arrival, so
// switch → cell is pinned, and a refused `consent` sync must not leave the server on Normal (deny) while the switch says allow.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/consent-switch-test.ts
// Mutation (must go red): in client/lib/consentsync.js drop the `on('hydrated', …)` line, or the timer retry, or the toast.
import { noWorldUrl } from './no-world.ts';
import { setConsent, decide, SWITCHES } from '../shared/protocol/consent.js';
import { makeConsentSync } from '../client/lib/consentsync.js';
import { WorldAgent } from '../mcpl/agent.ts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };

// consent.js is a browser leaf (localStorage at load): give it one
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
const C = await import('../client/lib/consent.js');

// 1. each switch value, set through the authority's own setConsent, is what decide answers a stranger
for (const v of SWITCHES) {
  check(`setSwitch(${v}) is remembered`, (C.setSwitch(v) || C.mySwitch() === v) && C.mySwitch() === v && C.bodyTable().switch === v);
  const P: any = {}; const r = setConsent(P, 'me', { switch: C.bodyTable().switch }, 1000);
  check(`the authority accepts switch ${v}`, r.ok, JSON.stringify(r));
  const want = { accept: 'allow', ask: 'ask', refuse: 'deny' }[v];
  for (const cls of ['shove', 'pose', 'displace', 'touch']) { const d = decide(P, 'stranger', 'me', cls, 1000); check(`switch ${v}: a stranger's ${cls} is ${want}`, d.mode === want, `decide → ${d.mode}`); }
}
check('setPushable(false) is refuse, (true) is accept — the old /pushable meaning', (C.setPushable(false), C.mySwitch() === 'refuse') && (C.setPushable(true), C.mySwitch() === 'accept'));

// 2. a refused sync is heard (toast) and retried: on the next hydration, and on a timer before that
// the stubs hold no timers: one turn of the event loop settles whatever a handler left in flight
const settle = () => new Promise((r) => setImmediate(r));
const run = async (reply: (n: number) => any, want = 'refuse') => {
  const sent: any[] = [], toasts: any[] = [], handlers: Record<string, Function[]> = {}, timers: Function[] = [];
  const s = makeConsentSync({
    table: () => ({ switch: want }),
    send: async (verb: string, args: any) => { sent.push([verb, args]); const r = reply(sent.length); return r.ok && args.switch === undefined ? { ...r, table: { switch: null } } : r; },
    toast: (m: string, kind: string) => { toasts.push([m, kind]); },
    on: (ev: string, fn: Function) => { (handlers[ev] ??= []).push(fn); },
    later: (fn: Function) => { timers.push(fn); },
  });
  const fire = async (ev: string) => { for (const f of handlers[ev] ?? []) await f(); await settle(); };
  const tick = async () => { const t = timers.splice(0); for (const f of t) await f(); await settle(); };
  return { s, sent, toasts, handlers, timers, fire, tick };
};
// the replay contract on arrival, one table over both implementations (mcpl/agent.ts replaySwitch, consentsync.js sync):
// differs → mine is sent; same → no switch sent; never chosen → none; set while the read is out → the newest stands and is
// the last sent (never the one the replay began with); a burst of changes → the latest. reads: a per-driver count.
type Row = { name: string; held: string | null; mine: string | null; during?: string[]; heldAfter: string | null; sets?: string[]; reads?: { agent?: number; browser?: number } };
const REPLAY: Row[] = [
  { name: 'mine differs from what the authority holds', held: 'accept', mine: 'refuse', heldAfter: 'refuse', sets: ['refuse'], reads: { agent: 1, browser: 1 } },
  { name: 'the same', held: 'refuse', mine: 'refuse', heldAfter: 'refuse', sets: [] },
  { name: 'never chosen: the world default stands', held: null, mine: null, heldAfter: null, sets: [], reads: { agent: 0 } },
  { name: 'a switch set while the read is out', held: 'refuse', mine: 'refuse', during: ['ask'], heldAfter: 'ask' },
  { name: 'a burst of changes', held: 'accept', mine: 'accept', during: ['ask', 'refuse'], heldAfter: 'refuse', reads: { browser: 2 } },
];
// a driver's authority answers the first read after the `during` changes are made (the body's own sets, landed first)
const authority = (r: Row, change: (v: string) => unknown) => {
  const st = { held: r.held, reads: 0, sets: [] as string[], first: true };
  const send = async (args: any) => {
    if (args.switch !== undefined) { st.sets.push(args.switch); st.held = args.switch; return { ok: true }; }
    st.reads++; await settle();
    if (st.first) { st.first = false; for (const v of r.during ?? []) await change(v); }
    return { ok: true, table: { switch: st.held } };
  };
  return { st, send };
};
const drivers: Record<string, (r: Row) => Promise<{ held: string | null; sets: string[]; reads: number; heard: number }>> = {
  agent: async (r) => {
    const ag = new WorldAgent({ url: noWorldUrl(), name: 'replay' }) as any; ag.consentSwitch = r.mine;
    const { st, send } = authority(r, (v) => { ag.consentSwitch = v; return ag.request('consent', { switch: v }); });
    ag.request = async (verb: string, args: any) => (verb === 'consent' ? send(args) : { ok: false });
    await ag.replaySwitch();
    return { ...st, heard: 0 };
  },
  browser: async (r) => {
    let mine = r.mine, heard = 0, s: any = null;   // a toast or a retry timer: a sync that lands says nothing
    const { st, send } = authority(r, (v) => { mine = v; void s.sync(); });   // consent.js syncs on each change
    s = makeConsentSync({ table: () => ({ switch: mine }), send: (_: string, a: any) => send(a), toast: () => { heard++; }, on: () => {}, later: () => { heard++; } });
    await s.sync(); await settle();
    return { ...st, heard };
  },
};
for (const [d, drive] of Object.entries(drivers)) for (const r of REPLAY) {
  const got = await drive(r), latest = r.during?.at(-1) ?? r.mine, reads = r.reads?.[d as 'agent'];
  check(`${d}: ${r.name}`, got.held === r.heldAfter && (r.sets ? JSON.stringify(got.sets) === JSON.stringify(r.sets) : got.sets.at(-1) === latest)
    && (reads === undefined || got.reads === reads) && got.heard === 0, JSON.stringify(got));
}
{ let down = true;
  const t = await run(() => (down ? { ok: false, refused: { code: 'offline', reason: 'the connection dropped before the authority answered' } } : { ok: true }));
  await t.fire('hydrated');
  check('a refused sync is a toast', t.toasts.length === 1 && t.toasts[0][1] === 'warn' && /consent/.test(t.toasts[0][0]) && /connection dropped/.test(t.toasts[0][0]), JSON.stringify(t.toasts));
  check('it schedules a retry', t.timers.length === 1);
  const before = t.sent.length; await t.tick();
  check('the timer tries again', t.sent.length === before + 1, `${t.sent.length - before} sent`);
  check('still failing: toast is not repeated, retry rescheduled', t.toasts.length === 1 && t.timers.length === 1, JSON.stringify(t.toasts));
  const b2 = t.sent.length; down = false; await t.fire('hydrated');
  check('the next arrival resends and lands (the read and the switch)', t.sent.length === b2 + 2 && t.toasts.length === 1, `${t.sent.length - b2} sent`);
  check('landed: the pending timer retry does nothing new', await (async () => { const n = t.sent.length; await t.tick(); return t.sent.length === n; })());
  check('the next failure is heard again', await (async () => { down = true; await t.fire('hydrated'); return t.toasts.length === 2; })()); }
{ const sent: any[] = [];
  const s = makeConsentSync({ table: () => ({ switch: 'accept' }), send: async (v: string, a: any) => { sent.push(a); return { ok: true }; }, toast: () => {}, on: () => {}, later: () => {}, enabled: () => false });
  await s.sync(); check('a bodiless client sends nothing', sent.length === 0); }

// 3. the ask round-trip: a body-inbox message holds the ask; answering sends consent {answer, yes} and the ask is gone;
// an unanswered ask expires locally with no send (the authority already took it as a no).
// Mutation (must go red): in client/lib/consentinbox.js drop the `delete` in answer(), or the expiry in sweep().
{
  const { makeConsentInbox } = await import('../client/lib/consentinbox.js');
  let t = 1000; const sent: any[] = [], changes: any[] = [];
  const box = makeConsentInbox({ now: () => t, onChange: (ev: any) => changes.push(ev) });
  const ask = { id: 'ask-1000-0', from: 'u-wren', kind: 'pose', summary: 'u-wren asks to pose', why: null, expires: 21000 };
  box.take([{ type: 'body-ask', ask }]);
  check('a body-ask lands as a pending ask, keyed by id, with its class derived from the kind', box.asks().length === 1 && box.asks()[0].id === ask.id && box.asks()[0].from === 'u-wren' && box.asks()[0].cls === 'pose' && box.asks()[0].kind === 'pose', JSON.stringify(box.asks()));
  check('askFrom finds it by the asker\'s identity', box.askFrom('u-wren')?.id === ask.id && box.askFrom('u-nobody') === null);
  check('the arrival is heard (added)', changes.length === 1 && changes[0].added?.[0]?.id === ask.id, JSON.stringify(changes));
  check('the same ask twice is held once', (box.take([{ type: 'body-ask', ask }]), box.asks().length === 1));
  const send = async (verb: string, args: any) => { sent.push([verb, args]); return { ok: true, answered: args.answer, yes: args.yes }; };
  const r = await box.answer(ask.id, true, send);
  check('answering yes sends consent {answer: <id>, yes: true}', sent.length === 1 && sent[0][0] === 'consent' && sent[0][1].answer === ask.id && sent[0][1].yes === true, JSON.stringify(sent));
  check('…and the ask is gone', r?.ok === true && box.asks().length === 0 && box.askFrom('u-wren') === null);
  check('answering an ask that isn\'t there sends nothing', (await box.answer('ask-nope', false, send)) === null && sent.length === 1);
  // a second ask, refused
  box.take([{ type: 'body-ask', ask: { ...ask, id: 'ask-1001-0', kind: 'drag' } }]);
  check('a drag ask is the displace class', box.askFrom('u-wren')?.cls === 'displace', JSON.stringify(box.asks()));
  await box.answer('ask-1001-0', false, send);
  check('answering no sends consent {answer, yes: false}', sent.length === 2 && sent[1][1].yes === false && box.asks().length === 0, JSON.stringify(sent));
  // a reach to an intimate point: the authority classes it (bodyconsent.js: chest_front is intimate) and the inbox keeps
  // the class, so Allow and Never are for intimate touch, not ordinary touch
  box.take([{ type: 'body-ask', ask: { ...ask, id: 'ask-1001-1', kind: 'touch', cls: 'intimate', summary: 'u-wren asks to touch (chest_front)' } }]);
  check('a reach the authority classes intimate is held as intimate, not as its kind\'s touch', box.askFrom('u-wren')?.cls === 'intimate', JSON.stringify(box.asks()));
  await box.answer('ask-1001-1', false, send); sent.pop();
  box.take([{ type: 'body-ask', ask: { ...ask, id: 'ask-1001-2', kind: 'touch', cls: 'nonsense' } }]);
  check('…and a class the protocol doesn\'t name falls back to the kind\'s', box.askFrom('u-wren')?.cls === 'touch', JSON.stringify(box.asks()));
  await box.answer('ask-1001-2', false, send); sent.pop();
  // a third ask nobody answers: gone at its expiry, nothing sent
  box.take([{ type: 'body-ask', ask: { ...ask, id: 'ask-1002-0', expires: 21000 } }]);
  t = 20999; box.sweep();
  check('before its expiry it is still there', box.asks().length === 1);
  t = 21000; const gone = box.sweep();
  check('at its expiry it is gone, and nothing was sent', gone.length === 1 && gone[0] === 'ask-1002-0' && box.asks().length === 0 && sent.length === 2, JSON.stringify({ gone, sent: sent.length }));
  check('the expiry is heard (removed)', changes.some((c) => c.removed?.includes('ask-1002-0')), JSON.stringify(changes));
  // replies and acts land in a short ring, in the authority's words
  box.take([{ type: 'body-reply', ask: 'ask-9', ok: false, why: 'u-x said no' }, { type: 'body', from: 'u-wren', kind: 'pose', cls: 'pose', consent: 'asked' }, { type: 'body-revoked', by: 'u-x', class: 'pose' }]);
  check('replies, acts and revocations are kept in the ring (not as asks)', box.ring().length === 3 && box.asks().length === 0, JSON.stringify(box.ring()));
  check('a malformed inbox is ignored', (box.take(null as any), box.take([{ type: 'body-ask' }, 7, { type: 'body-ask', ask: { id: 42 } }]), box.asks().length === 0));
}

// 4. an authority-delivered act ({type: 'body', kind, spec}) is APPLIED as localbody.js applies a puppet message; the
// relay refuses puppets while my switch is `ask` (server/messages.ts bodyRefusal), so this is the only way it lands.
// Mutation: bodyActAsPuppet returns null for every kind.
{
  const { bodyActAsPuppet } = await import('../client/lib/consentinbox.js');
  const q = [0, 0, 0.38, 0.92];
  const pose = bodyActAsPuppet({ type: 'body', from: 'u-wren', kind: 'pose', cls: 'pose', consent: 'asked', spec: { head: q } });
  check('a delivered pose (spec: bones) is a replacing puppet pose', JSON.stringify(pose) === JSON.stringify({ pose: { head: q }, merge: false }), JSON.stringify(pose));
  const merged = bodyActAsPuppet({ type: 'body', kind: 'pose', spec: { pose: { head: q }, merge: true } });
  check('…or {pose, merge} as a puppet sends it', JSON.stringify(merged) === JSON.stringify({ pose: { head: q }, merge: true }), JSON.stringify(merged));
  const anim = { dur: 1, tracks: { head: [{ t: 0, q }] }, replace: false };
  check('a delivered anim with tracks is a puppet anim', JSON.stringify(bodyActAsPuppet({ type: 'body', kind: 'anim', spec: anim })) === JSON.stringify({ anim }));
  // streamed kinds apply nothing from the inbox (they arrive live, consent-gated per sample), nor does an unknown kind:
  // only pose, anim (with tracks) and shove become puppet messages
  check('a delivered drag, occupy or carry, or an unknown kind, applies nothing', ['drag', 'occupy', 'carry', 'teleport'].every((kind) => bodyActAsPuppet({ type: 'body', kind, spec: { tracks: { head: [] }, pose: { head: q } } }) === null));
  check('a delivered shove is a ragdoll, directed by spec.lean when it has one', JSON.stringify(bodyActAsPuppet({ type: 'body', kind: 'shove', spec: { lean: [1, 0, 2] } })) === JSON.stringify({ ragdoll: { lean: [1, 0, 2] } })
    && bodyActAsPuppet({ type: 'body', kind: 'shove' })?.ragdoll === true && bodyActAsPuppet({ type: 'body', kind: 'shove', spec: { lean: [1, 'x', 2] } })?.ragdoll === true);
  check('drag, occupy and carry are live presence, not a one-shot: nothing to apply', ['drag', 'occupy', 'carry'].every((kind) => bodyActAsPuppet({ type: 'body', kind, spec: {} }) === null));
  check('a pose with no bones, an anim with no tracks, or another message type applies nothing',
    bodyActAsPuppet({ type: 'body', kind: 'pose' }) === null && bodyActAsPuppet({ type: 'body', kind: 'pose', spec: [q] }) === null
    && bodyActAsPuppet({ type: 'body', kind: 'anim', spec: { clip: 'wave' } }) === null && bodyActAsPuppet({ type: 'body-reply', kind: 'pose', spec: { head: q } }) === null && bodyActAsPuppet(null) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
