// xr-entry-policy-test: what a failed immersive-session request means (#197). Drives the REAL client/lib/xr_entry_policy.js
// (no imports, so nothing to stub), plus wiring checks that xr.js consults it and the retry is generation-guarded and
// cancellable.
//
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/xr-entry-policy-test.mjs
//
// Each of these mutations must turn a named check red:
//   policy: `isRetry ? give-up : retry-once` → always retry-once   (infinite retry)
//   policy: busy detection drops the message test                  (any InvalidStateError retries)
//   policy: absent detection dropped                               (no headset reads as unknown)
//   policy: the gpu branch moved AFTER the absent branch           (a WebGPU refusal marks a present headset absent)
//   xr.js: re-deriving absent/reload inline instead of reading verdict (the ranking drifts from the policy)
//   retryIsCurrent: `===` → `!==`, or ignoring null                (a stale timer enters VR)
//   xr.js: stop calling decideEntryFailure                         (the wiring check)
//   xr.js: leaveVR stops cancelling a pending retry                (delayed entry after a leave)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decideEntryFailure, retryIsCurrent, BUSY_RETRY_MS } from '../client/lib/xr_entry_policy.js';

const dir = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

const busy = () => Object.assign(new Error('Failed to execute requestSession: There is already an active, immersive XRSession.'), { name: 'InvalidStateError' });
const noDevice = () => Object.assign(new Error('no XR device found'), { name: 'NotFoundError' });
const notSupported = () => Object.assign(new Error('immersive-vr not supported'), { name: 'NotSupportedError' });
const weird = () => Object.assign(new Error('something else entirely'), { name: 'DataError' });

console.log('busy session — exactly one automatic retry:');
{
  const first = decideEntryFailure(busy(), { isRetry: false });
  check('a busy session retries once, automatically', first.action === 'retry-once' && first.retry === true);
  check('…after a short wait, not immediately', first.delayMs === 1500, `delayMs=${first.delayMs}`);
  check('…and says so', /retrying/i.test(first.toast ?? ''));

  // a second failure must not look like the first (a flag reset inside the retry timer scheduled again forever)
  const second = decideEntryFailure(busy(), { isRetry: true });
  check('a SECOND busy failure gives up rather than retrying again',
    second.action === 'give-up' && second.retry === false, `action=${second.action} retry=${second.retry}`);
  check('…and tells the user what to do about it',
    /another tab|click the visor/i.test(second.toast ?? ''), second.toast ?? 'no toast');
  check('giving up does not mark the headset absent (it is held, not missing)', second.markAbsent === false);
}

// an InvalidStateError that is NOT the busy one (a detached document, a backend's own reasons): retrying it is guessing,
// forever is the bug twice over: the name alone must not be the test
{
  const otherInvalid = Object.assign(new Error('The renderer is in an invalid state'), { name: 'InvalidStateError' });
  const v = decideEntryFailure(otherInvalid, { isRetry: false });
  check('an InvalidStateError that is not "already an active" is NOT retried',
    v.action !== 'retry-once' && v.retry === false, `action=${v.action}`);
}

console.log('\nthe other outcomes:');
{
  const a = decideEntryFailure(noDevice(), { isRetry: false });
  check('no device: absent, no retry', a.action === 'absent' && a.retry === false && a.markAbsent === true);
  const b = decideEntryFailure(notSupported(), { isRetry: false });
  check('not supported: absent, no retry', b.action === 'absent' && b.retry === false);
  // EACH ARM OF isAbsent ON ITS OWN (#197): a generic-name error with a descriptive message drives the message arm alone
  const genericRuntime = Object.assign(new Error('no XR runtime available'), { name: 'Error' });
  check('an absent-shaped MESSAGE is absent even under a generic error name',
    decideEntryFailure(genericRuntime, { isRetry: false }).action === 'absent');
  // BOTH names, each with a message the regex does NOT match, so dropping either name arm goes red
  for (const name of ['NotSupportedError', 'NotFoundError']) {
    const bare = Object.assign(new Error('nope'), { name });
    check(`an absent NAME is absent even when the message says nothing (${name})`,
      decideEntryFailure(bare, { isRetry: false }).action === 'absent');
  }
  // isBusy must test the SPECIFIC message, not merely 'already', or an unrelated InvalidStateError enters the retry path
  const alreadyOther = Object.assign(new Error('the renderer is already reserved for something else'), { name: 'InvalidStateError' });
  check('an InvalidStateError that says "already" but not "already an active" is NOT busy',
    decideEntryFailure(alreadyOther, { isRetry: false }).action === 'surface',
    decideEntryFailure(alreadyOther, { isRetry: false }).action);

  const c = decideEntryFailure(weird(), { isRetry: false });
  check('an unknown error is surfaced, never retried', c.action === 'surface' && c.retry === false);
  check('…and carries no invented toast', c.toast === null);

  const g = decideEntryFailure(weird(), { isRetry: false, gpu: true });
  check('on a WebGPU backend a refusal reloads onto WebGL', g.action === 'reload-webgl' && g.retry === false);
  check('…and does NOT mark the headset absent (the browser refused, not the device)', g.markAbsent === false);
  const gBusy = decideEntryFailure(busy(), { isRetry: false, gpu: true });
  check('a BUSY session on WebGPU still retries — busy outranks the backend',
    gBusy.action === 'retry-once', `action=${gBusy.action}`);
  // THE GPU/ABSENT INTERSECTION (#197): an ungrantable REQUIRED 'webgpu' is rejected with NotSupportedError, which isAbsent
  // matches; absent-first would mark a PRESENT headset absent
  for (const [label, err] of [['NotFoundError', noDevice()], ['NotSupportedError', notSupported()]]) {
    const ga = decideEntryFailure(err, { isRetry: false, gpu: true });
    check(`a WebGPU refusal reloads even when the error is absent-shaped (${label})`,
      ga.action === 'reload-webgl', `action=${ga.action}`);
    check(`…and does NOT mark a present headset absent (${label})`, ga.markAbsent === false);
  }
}

console.log('\nthe pending retry belongs to the intent that armed it:');
{
  check('a retry armed by this intent is current', retryIsCurrent(4, 4) === true);
  check('a retry armed by an OLDER intent is stale (a later click supersedes it)',
    retryIsCurrent(3, 4) === false);
  check('no pending retry is never current', retryIsCurrent(null, 4) === false);
  check('…not even against a null intent', retryIsCurrent(null, null) === false);
}

console.log('\nthe wiring (an extracted policy nobody calls is the regression extraction invites):');
{
  const eff = readFileSync(new URL('../client/lib/xr_entry_effects.js', import.meta.url), 'utf8');
const xr = readFileSync(join(dir, '../client/lib/xr.js'), 'utf8');
  check('xr.js imports the policy',
    /import \{ decideEntryFailure \} from '\.\/xr_entry_policy\.js'/.test(xr));
  check('xr.js CONSULTS it on a failed request', /decide: decideEntryFailure/.test(xr));   // passed INTO the tested seam, which calls it
  check('the retry is armed from the policy verdict, not a re-derived literal',
  /deps\.setTimer\(/.test(eff) && /verdict\.delayMs/.test(eff));   // the EFFECT OWNER holds this now
  check('the pending retry is generation-checked before it fires',
  /if \(pendingFor !== intent\)/.test(eff));   // …and xr-entry-effects-test EXECUTES it
  // assert the ORDER, not the spacing: a character-budgeted regex fails on an intervening comment, a false red
  const leave = xr.slice(xr.indexOf('export function leaveVR'));
  const cancelAt = leave.indexOf('cancelBusyRetry(');
  const noSessionAt = leave.indexOf('if (!session)');
  check('leaveVR cancels a pending retry BEFORE the no-session return',
    cancelAt > 0 && noSessionAt > 0 && cancelAt < noSessionAt,
    `cancel@${cancelAt} vs !session@${noSessionAt} — a leave during the retry window would let VR enter afterwards`);
  check('a new entry intent cancels the previous intent’s pending retry',
    /if \(retryOf === null\) cancelBusyRetry\(/.test(xr));
  check('the old self-resetting flag is gone', !/_retried/.test(xr));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
