// bun test/client/governor-refresh-test.ts — the frame governor's thresholds follow the display, not two absolute numbers
// (critique 2026-11-25 finding C.3). Before: shed below 26 fps, restore above 52, on any display: a 90 Hz headset at 55 fps
// (dropping a frame in every three) read as smooth and got quality back on top of the drops; a 30 Hz panel could never
// reach 52, so it never restored and the cruise stepped its pixels down for good. After: one target rate (the session's
// frameRate in a headset, else its measured cadence; on a flat display min(measured refresh, 60)), and the thresholds are
// fractions of it chosen so a 60 Hz display decides EXACTLY as before (G1 is that display's decisions, recorded from the
// tree before this change).
// The REAL governor.js runs over test/stubs/lod-client-stub.mjs (as governor-xr-test does): its levers below 'lod' answer
// "nothing to shed", so the ladder that moves is lod → pixels → detail. Each pulse is read back through the governor's
// own streak counters (exactly one of slowFor / goodFor / midFor grows: the regime it decided) and its history.
import { plugin } from 'bun';
import { stubResolve } from '../harness/stub.ts';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { suite } from '../gate/suite.ts';
const STUB = fileURLToPath(new URL('../stubs/lod-client-stub.mjs', import.meta.url));
plugin({ name: 'governor-refresh-stub', setup(b) {
  for (const f of ['^(\\.\\.?/)+(render/)?lightrig\\.js$', '^\\.\\.?/realize/emitters\\.js$', '^\\.\\.?/terrain\\.js$', '^(\\.\\.?/)+(render/)?frameloop\\.js$', '^(\\.\\.?/)+(player/)?remotes\\.js$', '^(\\.\\.?/)+(ui/)?ui\\.js$',
    '^(\\.\\.?/)+(ui/)?statuschips\\.js$', '^\\.\\./core\\.js$', '^\\.\\./assets\\.js$', '^\\.\\./colliders\\.js$', '^(\\.\\.?/)+(render/)?lightgizmo\\.js$', '^\\.\\./world\\.js$',
    '^(\\.\\.?/)+(render/)?materials\\.js$'])
    stubResolve(b, new RegExp(f), () => ({ path: STUB }));
  // the real frameloop.js (P5) imports breadcrumbs.js, whose only import is net.js: a leaf stands in for it
  stubResolve(b, /^\.\.\/net\.js$/, (a) => (/[\\/]debug[\\/]breadcrumbs\.js$/.test(a.importer) ? { path: fileURLToPath(new URL('../stubs/net-leaf-stub.mjs', import.meta.url)) } : undefined));
} });
const mem = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, String(v)), removeItem: (k: string) => mem.delete(k) };
const T = suite('governor-refresh');
const check = (n: string, ok: unknown, d?: unknown) => T.check(n, ok, d);

const stub: any = await import(STUB);
stub.renderer.setPixelRatio = () => {};
let session: any = null;   // the XRSession the governor may read frameRate from
stub.renderer.xr = { isPresenting: false, getSession: () => session };
const G: any = await import('../../client/lib/render/governor.js');
const FB: any = await import('../../client/lib/render/framebudget.js');
// the refresh estimator (new in this change): absent on the old tree, so its rows fail there instead of the suite dying
const R: any = await import('../../client/lib/render/refresh.js').catch(() => null);
const dbg = () => G.governorDebug();
const strip = (h: string) => h.replace(/ @\d+s$/, '');
const hist = () => (dbg().history as string[]).map(strip);
const tick = (fps: number) => { G.governPerformance(fps); G.applyPendingPixelRatio(); };
/** the regime ONE pulse decided, read from the counter that grew (callers precede it with a pulse of another regime) */
const regimeOf = (fps: number) => {
  const a = dbg(); tick(fps); const b = dbg();
  if (b.slowFor > a.slowFor) return 'slow';
  if (b.goodFor > a.goodFor) return 'smooth';
  if (b.midFor > a.midFor) return 'mid';
  return `? ${JSON.stringify({ a: [a.slowFor, a.goodFor, a.midFor], b: [b.slowFor, b.goodFor, b.midFor] })}`;
};
/** each fps decided from a neutral start: a pulse of a different regime first, so its counter starts at 0 */
const decide = (fpsList: number[], reset: (fps: number) => number) => fpsList.map((f) => { tick(reset(f)); return [f, regimeOf(f)]; });
/** frame intervals as the loop sees them: a steady panel at `hz`, ±3% jitter, deterministic */
const cadence = (hz: number, n: number, presenting = false) => {
  for (let i = 0; i < n; i++) R?.noteFrameInterval((1000 / hz) * (1 + 0.03 * Math.sin(i * 1.7)), presenting);
};

// ---- G1 (control): a 60 Hz display decides exactly as the old governor did -------------------------------------
// One scripted minute-and-a-half of fps through the threshold edges and every streak (shed, restore, cruise, calm), from
// a fresh governor with no cadence measured yet ("no estimate behaves as 60"). The expected trace was recorded from the
// tree before this change (GOV_TRACE_OUT=<file> writes this run's trace, for re-recording on purpose only).
const SCRIPT: [number, number][] = [[53, 6], [25, 4], [27, 9], [51, 3], [52, 6], [53, 7], [26, 3], [25, 3], [12, 10], [40, 20],
  [60, 30], [25, 2], [53, 1], [25, 3], [0, 2], [53, 12]];
const trace: (string | number)[][] = [];
for (const [fps, n] of SCRIPT) for (let i = 0; i < n; i++) { tick(fps); const d = dbg(); trace.push([fps, d.slowFor, d.goodFor, d.midFor, d.pixelRatio]); }
const got = { trace, history: hist() };
if (process.env.GOV_TRACE_OUT) fs.writeFileSync(process.env.GOV_TRACE_OUT, JSON.stringify(got));
const GOLDEN = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./governor-refresh-golden.json', import.meta.url)), 'utf8'));
const firstDiff = got.trace.findIndex((r, i) => JSON.stringify(r) !== JSON.stringify(GOLDEN.trace[i]));
check('G1 60 Hz, no estimate yet: every pulse and every lever move is the old governor\'s', JSON.stringify(got) === JSON.stringify(GOLDEN),
  { firstDiff, got: got.trace[firstDiff], want: GOLDEN.trace[firstDiff], histGot: got.history.length, histWant: GOLDEN.history.length });

// ---- G2 (control): a MEASURED 60 Hz panel, the edges one pulse at a time -------------------------------------------
cadence(60, 600);
const at60 = decide([25, 26, 27, 51, 52, 53], (f) => (f < 40 ? 53 : 25));
check('G2 60 Hz measured: 25 slow, 26/27/51/52 mid, 53 smooth (the old 26 and 52)', JSON.stringify(at60) ===
  JSON.stringify([[25, 'slow'], [26, 'mid'], [27, 'mid'], [51, 'mid'], [52, 'mid'], [53, 'smooth']]), at60);
check('G3 the debug surface names the target and both thresholds (60 / below 26 / above 52)',
  dbg().target === 60 && dbg().slowBelow === 26 && dbg().smoothAbove === 52, { target: dbg().target, slowBelow: dbg().slowBelow, smoothAbove: dbg().smoothAbove });
{ tick(53); const s53 = FB.budgetStats().share; tick(51); const s51 = FB.budgetStats().share; tick(25); const s25 = FB.budgetStats().share;
  check('G4 60 Hz: the background share is the old 0.36 / 0.3 / 0.2 at 53 / 51 / 25', s53 === 0.36 && s51 === 0.3 && s25 === 0.2, { s53, s51, s25 }); }

// ---- F1 (control): a fast desktop is held to 60, not to its panel --------------------------------------------------
cadence(144, 600);
const at144 = decide([100, 61, 53], () => 25);
check('F1 144 Hz desktop: 100 fps is smooth (the flat target is min(refresh, 60): a fast panel never sheds at 100)',
  JSON.stringify(at144) === JSON.stringify([[100, 'smooth'], [61, 'smooth'], [53, 'smooth']]) && dbg().target === 60, { at144, target: dbg().target });

// ---- X: a headset holds its own refresh ---------------------------------------------------------------------------
// setup: something is shed (lod first, on the desktop), so a restore has a subject
for (let i = 0; i < 12 && !hist().includes('− lod'); i++) tick(12);
check('(setup) the desktop shed lod before the headset rows', hist().includes('− lod'), hist().slice(-3));
stub.renderer.xr.isPresenting = true; session = { frameRate: 90 };
{ const h0 = hist().length; for (let i = 0; i < 4; i++) tick(55);
  const moves = hist().slice(h0);
  check('X1 90 Hz session at 55 fps: no restore (it is dropping a frame in three)', !moves.some((h) => h.startsWith('+')), moves);
  check('X2 …and it sheds (slow is below 0.9 of the refresh, for the same 3 s)', moves.some((h) => h.startsWith('−')), moves); }
{ const share = FB.budgetStats().share;
  check('X3 90 Hz at 55: the background share is the slow 0.2, not the smooth regime\'s headset cap 0.25', share === 0.2, share); }
const x90 = decide([90, 88, 87, 81, 80], (f) => (f > 85 ? 55 : 90));
check('X4 90 Hz: 90/88 smooth (above 0.97), 87/81 between, 80 slow (below 81)', JSON.stringify(x90) ===
  JSON.stringify([[90, 'smooth'], [88, 'smooth'], [87, 'mid'], [81, 'mid'], [80, 'slow']]), x90);
{ const h0 = hist().length; for (let i = 0; i < 12; i++) tick(90);
  check('X5 90 Hz held: quality comes back (a restore while presenting)', hist().slice(h0).some((h) => h.startsWith('+')), hist().slice(h0)); }
session = { frameRate: 72 };
const x72 = decide([72, 70, 69, 64, 60], (f) => (f > 67 ? 50 : 72));
check('X6 72 Hz session: 72/70 smooth, 69 between, 64 slow, 60 slow (old: 60 was smooth)', JSON.stringify(x72) ===
  JSON.stringify([[72, 'smooth'], [70, 'smooth'], [69, 'mid'], [64, 'slow'], [60, 'slow']]), x72);
// a runtime that does not report frameRate: the cadence measured IN the session, never the desktop's
session = {};
{ const t = dbg().target;
  check('X7 no frameRate, no in-session cadence yet: the headset default 72, not the desktop\'s 144', t === 72, t); }
cadence(90, 300, true);
const xm = decide([88, 80], (f) => (f > 85 ? 60 : 90));
check('X8 no frameRate, 90 Hz cadence measured in the session: target 90; 80 fps is slow', dbg().target === 90 && JSON.stringify(xm) === JSON.stringify([[88, 'smooth'], [80, 'slow']]), { target: dbg().target, xm });
stub.renderer.xr.isPresenting = false; session = null;
cadence(144, 30);   // back on the desktop
check('X9 after exit the desktop target is 60 again', dbg().target === 60, dbg().target);
// a NEW session starts its own measurement: last session's 90 must not carry into a 72 Hz headset
stub.renderer.xr.isPresenting = true; session = {};
cadence(72, 2, true);
check('X10 a new session forgets the last one\'s cadence (72 default until it measures)', dbg().target === 72, dbg().target);
stub.renderer.xr.isPresenting = false; session = null;

// ---- F2: a 30 Hz panel ---------------------------------------------------------------------------------------------
R?.resetRefresh();   // a fresh page on a different display (the estimate only ratchets up within a page)
cadence(30, 300);
check('F2 30 Hz panel measured: target 30, thresholds 13 / 26', dbg().target === 30 && dbg().slowBelow === 13 && dbg().smoothAbove === 26, { target: dbg().target, slowBelow: dbg().slowBelow, smoothAbove: dbg().smoothAbove });
for (let i = 0; i < 40 && dbg().pixelRatio >= 1; i++) tick(10);
check('(setup) a slow 30 Hz panel sheds pixels', dbg().pixelRatio < 1, dbg().pixelRatio);
{ const pr = dbg().pixelRatio; const h0 = hist().length;
  for (let i = 0; i < 30; i++) tick(29);
  check('F3 30 Hz panel at 29 fps restores (old: never — 29 sat in the dead band and the cruise stepped pixels DOWN)',
    dbg().pixelRatio > pr && hist().slice(h0).some((h) => h.startsWith('+')) && !hist().slice(h0).some((h) => /cruise/.test(h)), { pr, now: dbg().pixelRatio, moves: hist().slice(h0) }); }
{ tick(29); const s = FB.budgetStats().share;
  check('F4 30 Hz at 29: the background share is the smooth 0.36 (old: 0.3)', s === 0.36, s); }

// ---- E: the estimator on its own (fresh instances) -----------------------------------------------------------------
const mk = () => R?.makeRefreshEstimator();
const feed = (e: any, ms: number[]) => { for (const m of ms) e?.note(m); };
const rep = (ms: number[], n: number) => Array.from({ length: n }, (_, i) => ms[i % ms.length]);
{ const e = mk(); check('E1 nothing measured: no estimate (the governor behaves as 60)', e != null && e.hz() == null, e?.hz()); }
{ const e = mk(); feed(e, rep([1000 / 60], 200)); check('E2 a steady 60 Hz cadence reads 60', e?.hz() === 60, e?.hz()); }
{ const e = mk(); feed(e, rep([10, 23.3], 200)); check('E3 timestamp jitter around 16.7 ms (10/23.3 alternating) still reads 60, not 100', e?.hz() === 60, e?.hz()); }
{ const e = mk(); feed(e, rep([1000 / 30], 60)); check('E4 a slow cadence is not trusted at once: 30 Hz for 2 s gives no estimate yet', e != null && e.hz() == null, e?.hz());
  feed(e, rep([1000 / 30], 200)); check('E5 …sustained, it is: a 30 Hz panel reads 30', e?.hz() === 30, e?.hz()); }
{ const e = mk(); feed(e, rep([33.3, 50, 33.3, 33.3, 50, 66.7, 33.3, 50], 600));
  check('E6 a GPU-bound 60 Hz machine (33/50/67 ms frames, ~25 fps) is NOT read as a slow panel', e != null && e.hz() == null, e?.hz()); }
{ const e = mk(); feed(e, rep([1000 / 60], 200)); feed(e, rep([1000 / 30], 600));
  check('E7 the fastest sustained cadence holds: 60 Hz then a long 30 fps stretch stays 60', e?.hz() === 60, e?.hz()); }
{ const e = mk(); feed(e, rep([...Array(18).fill(1000 / 30), 62, 4.7], 900));
  check('E8 catch-up pairs (a 62 ms frame, then a 4.7 ms one) do not raise a 30 Hz panel', e?.hz() === 30, e?.hz()); }
{ const e = mk(); feed(e, [0, -5, NaN, 5000, ...rep([1000 / 144], 100)]);
  check('E9 resumes and nonsense intervals are ignored; 144 Hz reads 144', e?.hz() === 144, e?.hz()); }
{ const e = mk(); feed(e, rep([250], 300)); feed(e, rep([1], 300));
  check('E10 a throttled 4 Hz tab (250 ms frames) and 1 ms bursts are not cadence: no estimate', e != null && e.hz() == null, e?.hz()); }

// ---- P: pins added after the mutants (each row names the mutant it kills) ------------------------------------------
// M4: a headset's measured cadence below 72 is not believed (half-rate reprojection would read as a 45 Hz "display")
stub.renderer.xr.isPresenting = true; session = {};
cadence(45, 300, true);
check('P1 no frameRate, a steady 45 Hz cadence in the session: target stays 72, so 45 fps is slow', dbg().target === 72 && regimeOf(45) === 'slow', { target: dbg().target });
stub.renderer.xr.isPresenting = false;
// M15: headset frames never feed the flat estimate (F2 left a 30 Hz panel measured; a 72 Hz session must not raise it)
stub.renderer.xr.isPresenting = true; cadence(72, 300, true); stub.renderer.xr.isPresenting = false; cadence(30, 2);
check('P2 a 30 Hz panel stays 30 after a 72 Hz headset session', dbg().target === 30, dbg().target);
// M18: before the first fps window (0) the share is the slow one, as before
cadence(60, 300);   // ratchets the flat estimate to 60 again
tick(53); tick(0);
check('P3 fps 0 (no window measured yet): the background share is 0.2, as before', FB.budgetStats().share === 0.2, FB.budgetStats().share);
// M19: loading grace's history line follows the regime too: 20 fps is slow at 60 Hz, mid at 30 Hz
{ FB.reportPending('governor-refresh-test', 1);
  const h0 = hist().length; tick(20); tick(53);
  const at60 = hist().slice(h0).some((h) => /grace held/.test(h));
  FB.reportPending('governor-refresh-test', 0); tick(53);
  R?.resetRefresh(); cadence(30, 300);
  FB.reportPending('governor-refresh-test', 1);
  const h1 = hist().length; tick(20); tick(29);
  const at30 = hist().slice(h1).some((h) => /grace held/.test(h));
  FB.reportPending('governor-refresh-test', 0);
  check('P4 loading grace logs a held slow second at 60 Hz (20 fps) but not at 30 Hz, where 20 fps is not slow', at60 && !at30, { at60, at30 }); }
// M20: the REAL frame loop feeds the estimator (frameloop.js is stubbed for the governor above; imported here by its
// absolute path, which the stub's specifier patterns do not match, so this is the module the client runs)
{ R?.resetRefresh();
  let cb: any = null; (globalThis as any).requestAnimationFrame = (f: any) => { cb = f; return 1; };
  (globalThis as any).location ??= { search: '' };   // breadcrumbs.js reads ?bc at load
  const FL: any = await import(fileURLToPath(new URL('../../client/lib/render/frameloop.js', import.meta.url)));
  FL.startFrame();
  const t0 = performance.now();
  for (let i = 1; i <= 300 && cb; i++) { const f = cb; cb = null; f(t0 + (i * 1000) / 30); }
  check('P5 the real frame loop feeds the estimator: 300 frames at 30 Hz read as a 30 Hz panel', R?.refreshEstimate(false) === 30, R?.refreshEstimate(false)); }

T.done();
