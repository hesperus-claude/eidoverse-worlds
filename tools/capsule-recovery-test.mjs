// capsule-recovery-test: the capsule is a FLOOR, not a verdict (#196). Proves fail → capsule → SAME body recovery,
// including same-path reannouncement and authority takeover, through the REAL client/lib/remotes.js (renderer-side
// imports stubbed). Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/capsule-recovery-test.mjs
// Each mutation of the PRODUCT turns a named check red:
//   remotes.js: never set `r.capsuleFor` on the fallback    → nothing knows a debt is owed
//   remotes.js: `retryBody` body removed (early return)     → the debt is never paid
//   remotes.js: same-path reannounce stops calling retryBody → the reannounce path stays terminal
//   remotes.js: takeover drops `fresh.capsuleFor`            → takeover makes the substitution permanent
//   remotes.js: drop the POST-load `remotes.get(id) !== r`   → a mid-flight body lands on a superseded record
// Two mutants SURVIVE, declared:
//   • dropping the PRE-load guard: EQUIV here (the post-load guard catches every supersede during the backoff); it
//     guards a supersede between timer fire and the first await
//   • RETRY_MAX 3 → 9999: the backoff (400/1600/5000 ms) limits attempts in a sane window, not the cap; the cap's
//     observable (counter stops, further announces arm nothing) is bound instead
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
import { tryUntil, pause } from './protocol/wait.ts';
const here = (f) => fileURLToPath(new URL(f, import.meta.url));

// one control object shared with the avatar stub (recovery-avatar-stub.mjs): .failing (a real-body load rejects), .attempts
const probe = (globalThis.__avatarProbe ||= { failing: true, attempts: 0, made: [], bodies: [] });
probe.reset = () => { probe.failing = true; probe.attempts = 0; probe.made = []; probe.bodies = []; };

plugin({
  name: 'recovery-stubs',
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    b.onResolve({ filter: /^\.\/avatar\.js$/ }, () => ({ path: here('./recovery-avatar-stub.mjs') }));
    b.onResolve({ filter: /^\.\/world\.js$/ }, () => ({ path: here('./recovery-empty-stub.mjs') }));
    b.onResolve({ filter: /^\.\/seats\.js$/ }, () => ({ path: here('./recovery-empty-stub.mjs') }));
    b.onResolve({ filter: /^\.\/occupants\.js$/ }, () => ({ path: here('./recovery-empty-stub.mjs') }));
    b.onResolve({ filter: /^\.\/reachnet\.js$/ }, () => ({ path: here('./recovery-empty-stub.mjs') }));
    b.onResolve({ filter: /^\.\/poseclips\.js$/ }, () => ({ path: here('./recovery-empty-stub.mjs') }));
    b.onResolve({ filter: /wingpresence\.js$/ }, () => ({ path: here('./recovery-empty-stub.mjs') }));
    b.onResolve({ filter: /^\.\/xrbody\.js$/ }, () => ({ path: here('./recovery-empty-stub.mjs') }));
    b.onResolve({ filter: /presencewire\.js$/ }, () => ({ path: here('./recovery-empty-stub.mjs') }));
    b.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
  },
});

const R = await import('../client/lib/remotes.js');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const PATH = 'eidoverse/assets/vrms/somebody.vrm';

// ---------------------------------------------------------------- the floor
probe.reset();
let r = await R.ensureRemote('alice', PATH);
check('a failed body load leaves a capsule on screen', !!r.avatar?.isCapsule);
check('the record records the debt it still owes (capsuleFor)', r.capsuleFor === PATH);
check('the record does NOT claim the intended body is worn',
  r.avatar?.isCapsule === true && r.capsuleFor === PATH);

// ---------------------------------------------------------------- the door back out
// the network comes back: a same-path reannounce is evidence the peer is live
probe.failing = false;
const before = probe.attempts;
const same = await R.ensureRemote('alice', PATH);
check('a same-path reannounce returns the SAME record (no rebuild)', same === r);
// the retry is SCHEDULED, not run (a flapping peer can't drive a load per announce): synchronously the record is armed
check('…and arms a retry rather than returning the capsule forever',
  r.retrying === true, `retrying=${r.retrying}`);
await tryUntil('the armed retry puts alice in her real body', () => probe.attempts > before && r.avatar && !r.avatar.isCapsule && !r.capsuleFor, { ms: 3500 });
check('the armed retry actually asked for the real body',
  probe.attempts > before, `${probe.attempts - before} attempts`);
check('the real body replaces the capsule once the network recovers',
  r.avatar && !r.avatar.isCapsule, `avatar isCapsule=${r.avatar?.isCapsule}`);
check('the debt is cleared once paid', !r.capsuleFor);

// ---------------------------------------------------------------- takeover pays the debt too
probe.reset();  // failing again
const t0 = await R.ensureRemote('bob', PATH);
check('bob falls back to the capsule', !!t0.avatar?.isCapsule && t0.capsuleFor === PATH);
probe.failing = false;
const t1 = await R.ensureRemote('bob', PATH, { authority: true });
check('an authority takeover produces a FRESH record (identity guard, #97 B2)', t1 !== t0);
check('the takeover carries the debt forward rather than making it permanent',
  t1.capsuleFor === PATH || !t1.avatar?.isCapsule);
await tryUntil('the successor ends up in the real body', () => t1.avatar && !t1.avatar.isCapsule, { ms: 3500 });
check('the successor ends up in the real body', t1.avatar && !t1.avatar.isCapsule);

// ---------------------------------------------------------------- bounded, not a hot loop
probe.reset();  // failing, and stays failing
const c = await R.ensureRemote('carol', PATH);
check('carol falls back', !!c.avatar?.isCapsule);
const a0 = probe.attempts;
for (let i = 0; i < 8; i++) { await R.ensureRemote('carol', PATH); }
await pause('retries are counted over a fixed window', 900);
const spent = probe.attempts - a0;
check('a dead asset costs a bounded number of retries, not one per announce',
  spent > 0 && spent <= 4, `${spent} attempts for 8 announces`);
check('carol keeps the capsule while the asset stays down', !!c.avatar?.isCapsule);

// the cap with a SHORT backoff: at the shipped delays the third timer never fires in a test window
R.__setRetryBackoffForTest([5, 10, 15]);
probe.reset();
const cap = await R.ensureRemote('cap', PATH);
check('the capped peer falls back', !!cap.avatar?.isCapsule);
const capStart = probe.attempts;
for (let i = 0; i < 10; i++) { await R.ensureRemote('cap', PATH); await pause('announces 40 ms apart, past the short backoff', 40); }
await pause('the last short backoff has had its time to fire', 120);
const capSpent = probe.attempts - capStart;
check('a dead asset stops at exactly RETRY_MAX fetches, however often it is announced',
  capSpent === 3, `${capSpent} fetches across 10 announces (cap is 3)`);
check('the counter rests at the cap', cap.retries === 3, `retries=${cap.retries}`);
check('the capped peer keeps the capsule and still knows what it owes',
  !!cap.avatar?.isCapsule && cap.capsuleFor === PATH);
R.__setRetryBackoffForTest([400, 1600, 5000]);  // restore the shipped values for later scenarios

// ---------------------------------------------------------------- the bound must survive TAKEOVER
// a dead asset on a flapping peer: the attempt count must transplant into the takeover's fresh record, or every
// reconnect re-arms the shortest backoff and the cap is never reached
probe.reset();  // failing, and stays failing
let fl = await R.ensureRemote('frank', PATH);
check('frank falls back', !!fl.avatar?.isCapsule);
const flStart = probe.attempts;
for (let i = 0; i < 6; i++) {                // six reconnects, each an authority takeover
  fl = await R.ensureRemote('frank', PATH, { authority: true });
  await pause('past the SHORTEST backoff, so a reset cap would refetch', 500);
}
await pause('the last takeover\'s backoff has had its time to fire', 600);
const flSpent = probe.attempts - flStart;
check('a dead asset on a flapping peer stays bounded across takeovers',
  flSpent <= 4, `${flSpent} fetches across 6 takeovers — the cap resets on reconnect`);
check('the attempt count transplants with the debt',
  (fl.retries ?? 0) >= 3, `retries=${fl.retries}`);

// ---------------------------------------------------------------- generation safety
// a retry in flight must not land on a record that has since been replaced
probe.reset();
const d0 = await R.ensureRemote('dave', PATH);
check('dave falls back', !!d0.avatar?.isCapsule);
probe.failing = false;
await R.ensureRemote('dave', PATH);                 // schedules a retry on d0
const d1 = await R.ensureRemote('dave', 'other/body.vrm');   // different path → rebuild, d0 superseded
check('a body switch supersedes the pending record', d1 !== d0);
const d0Body = d0.avatar;                       // the capsule the superseded record holds
await pause('the stale retry has had its time to fire (it must not land)', 700);
check('the map still holds the successor', R.remotes.get('dave') === d1);
// a missing identity guard's damage lands on the SUPERSEDED RECORD: a live avatar nobody owns or disposes (the ghost
// #95 prevents); assert where the write would land
check('a stale retry never adopts a body into the superseded record (identity guard held)',
  d0.avatar === d0Body, 'the superseded record adopted a late body — undisposable ghost');
check('…and the successor keeps its own body',
  d1.avatar && d1.avatar !== d0.avatar);

// ---------------------------------------------------------------- superseded MID-LOAD
// the guard AFTER the await is reachable only when the supersede lands while the body is in flight: hold the load open
probe.reset();
const e0 = await R.ensureRemote('erin', PATH);
check('erin falls back', !!e0.avatar?.isCapsule);
const e0Body = e0.avatar;
probe.failing = false;
probe.loadMs = 900;                        // the retry's load will be slow BEFORE it starts
await R.ensureRemote('erin', PATH);        // arms the retry (fires after the 400ms backoff)
await pause('timer fired ~400ms; the slow load is now in flight', 600);
const e1 = await R.ensureRemote('erin', 'other/body.vrm');   // supersede DURING that load
check('a mid-load switch supersedes the record', e1 !== e0);
await pause('let the stale load finish and be rejected', 1600);
check('a mid-flight body is not adopted by the superseded record',
  e0.avatar === e0Body, 'the superseded record adopted a mid-flight body');
// an orphaned body must also be disposed (#95); the stale body is the one the retry loaded, not `.at(-1)`
const staleBody = probe.bodies.find((b) => b !== e1.avatar);
check('the retry did load a body for the superseded record', !!staleBody);
check('…and that body is DISPOSED rather than left in the scene',
  staleBody?.disposed === true, `stale body disposed=${staleBody?.disposed}`);
check('…while the successor keeps its own body undisposed',
  e1.avatar?.disposed === false);
check('the successor is unharmed by the stale completion',
  R.remotes.get('erin') === e1);
probe.loadMs = 0;

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
