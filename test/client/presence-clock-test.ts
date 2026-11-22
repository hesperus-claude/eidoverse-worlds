// presence (client/lib/ui/presence.js): the automatic present/away clock. Returning to the tab must count as input:
// a tab hidden past AWAY_S came back "present", then the next 5 s tick read the stale lastInput and flipped it to away.
// Drives the REAL module with a fake clock, a captured interval and a settable document.hidden.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/presence-clock-test.ts
//
// Mutation (must go red): in the visibilitychange listener, set `auto = 'present'` on visible without calling seen().
import { plugin } from 'bun';
import { stubResolve } from '../harness/stub.ts';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { suite } from '../gate/suite.ts';
plugin({
  name: 'presence-stubs',
  setup(b) {
    stubResolve(b, /^\.\.\/base\.js$/, (a) => (a.importer.endsWith('presence.js') ? { path: 'base', namespace: 'presence-stub' } : undefined));
    b.onLoad({ filter: /.*/, namespace: 'presence-stub' }, () => ({ contents: 'export const bus = { emit: (t, v) => globalThis.__pr.push([t, v]) };', loader: 'js' }));
  },
});
GlobalRegistrator.register();
const G = globalThis as any; G.__pr = [];
let T = 0, hidden = false, tick: (() => void) | null = null;
performance.now = () => T;
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
const realSetInterval = G.setInterval;
G.setInterval = (fn: () => void, ms: number) => { if (ms === 5000) { tick = fn; return 0; } return realSetInterval(fn, ms); };
const { presence, setPresence } = await import('../../client/lib/ui/presence.js');
G.setInterval = realSetInterval;

const S = suite('presence-clock');
const show = (h: boolean) => { hidden = h; document.dispatchEvent(new Event('visibilitychange')); };

S.check('starts present', presence() === 'present');
S.check('the 5 s clock was registered', typeof tick === 'function');
T = 179_000; tick!();
S.check('no input for 179 s: still present', presence() === 'present');
T = 181_000; tick!();
S.check('no input past AWAY_S (180 s): away', presence() === 'away');
dispatchEvent(new Event('keydown'));   // the window listener; a non-bubbling event on document never reaches it
S.check('a key press brings it back to present', presence() === 'present');

show(true);
S.check('tab hidden: away', presence() === 'away');
T += 600_000;
show(false);
S.check('tab shown again after 10 min: present', presence() === 'present');
T += 5_000; tick!();
S.check('...and the next clock tick keeps it present (coming back counts as input)', presence() === 'present', presence());

setPresence('busy'); show(true); show(false);
S.check('a chosen busy holds through hide and show', presence() === 'busy');
setPresence('present');
S.check('choosing present hands back to the clock', presence() === 'present');

S.done();
