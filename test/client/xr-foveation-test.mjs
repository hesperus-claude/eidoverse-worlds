// xr-foveation-test: which fixed-foveation level a session starts at (client/lib/xr/xrfoveation.js, called by xr.js at
// entry). Standalone headsets start at 1 (Basis's split: the periphery is cheap to lose on a mobile GPU); a PC headset
// at 0, where the blur shows. The old inline test in xr.js required the user agent NOT to match
// `Windows|Macintosh|Linux x86`, but Quest Browser's default (desktop-mode) user agent is `X11; Linux x86_64; Quest 3`:
// every Quest in its default mode was classed 'pc' and got 0 (cold read 2026-11-27). A desktop Linux Chrome never
// matched the headset tokens anyway, so that exclusion only ever excluded headsets.
// The user-agent strings below are written from the browsers' published formats [not captured from devices tonight].
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/xr-foveation-test.mjs
// Mutations that must turn a named check red:
//   xrfoveation.js: the old `Windows|Macintosh|Linux x86` exclusion restored (F1, F3)
//   xrfoveation.js: the override ignored (F8); the override not clamped (F9); Android dropped from the tokens (F12)
//   xr.js: the entry call no longer goes through foveationFor (F11)
import fs from 'node:fs';
import { suite } from '../gate/suite.ts';
const T = suite('xr-foveation');
const check = (n, ok, d) => T.check(n, ok, d);
const M = await import('../../client/lib/xr/xrfoveation.js').catch(() => null);
const at = (ua, fov = null) => M?.foveationFor(ua, fov) ?? null;

const UA = {
  quest3Desktop: 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/35.2.0.4.65.637262418 SamsungBrowser/4.0 Chrome/126.0.6478.122 VR Safari/537.36',
  quest3Mobile: 'Mozilla/5.0 (Linux; Android 12; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/35.2.0.4.65.637262418 SamsungBrowser/4.0 Chrome/126.0.6478.122 Mobile VR Safari/537.36',
  picoDesktop: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) PicoBrowser/3.3.38 Chrome/105.0.5195.68 VR Safari/537.36',
  picoMobile: 'Mozilla/5.0 (Linux; Android 10; Pico 4) AppleWebKit/537.36 (KHTML, like Gecko) PicoBrowser/3.3.38 Chrome/105.0.5195.68 Mobile VR Safari/537.36',
  wolvic: 'Mozilla/5.0 (Android 10; Mobile VR; rv:121.0) Gecko/121.0 Firefox/121.0 Wolvic/1.6',
  windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  linuxChrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};
const is = (r, fov, standalone) => r != null && r.fov === fov && r.standalone === standalone && r.override === false;

check('F1 Quest 3, Quest Browser default (desktop-mode) UA: standalone, foveation 1 (was pc, 0)', is(at(UA.quest3Desktop), 1, true), at(UA.quest3Desktop));
check('F2 Quest 3, mobile-mode UA: standalone, 1', is(at(UA.quest3Mobile), 1, true), at(UA.quest3Mobile));
check('F3 Pico Browser, desktop and mobile mode: standalone, 1', is(at(UA.picoDesktop), 1, true) && is(at(UA.picoMobile), 1, true), [at(UA.picoDesktop), at(UA.picoMobile)]);
check('F4 Wolvic: standalone, 1', is(at(UA.wolvic), 1, true), at(UA.wolvic));
check('F5 Windows Chrome (Link, Air Link, SteamVR): pc, 0', is(at(UA.windowsChrome), 0, false), at(UA.windowsChrome));
check('F6 macOS Safari: pc, 0', is(at(UA.macSafari), 0, false), at(UA.macSafari));
check('F7 desktop Linux Chrome: pc, 0', is(at(UA.linuxChrome), 0, false), at(UA.linuxChrome));
{ const r = at(UA.quest3Desktop, '0.5'), p = at(UA.windowsChrome, '0.25');
  check('F8 ?fov= overrides either way (0.5 on a Quest, 0.25 on PC), and says so', r?.fov === 0.5 && r?.override === true && p?.fov === 0.25 && p?.override === true, [r, p]); }
{ const hi = at(UA.windowsChrome, '2'), lo = at(UA.quest3Desktop, '-1'), junk = at(UA.quest3Desktop, 'abc');
  check('F9 ?fov= is clamped to [0, 1] and a non-number reads 0, as before', hi?.fov === 1 && lo?.fov === 0 && junk?.fov === 0, [hi, lo, junk]); }
check('F12 an Android phone browser (Chrome, no headset token) stays standalone, 1, as before', is(at('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'), 1, true));
check('F10 no user agent (an old runtime): pc, 0', is(at(''), 0, false) && is(at(undefined), 0, false), [at(''), at(undefined)]);
{ const src = fs.readFileSync(new URL('../../client/lib/xr/xr.js', import.meta.url), 'utf8');
  const calls = /foveationFor\(\s*navigator\.userAgent\s*,\s*CONFIG\.params\.has\('fov'\)\s*\?\s*CONFIG\.params\.get\('fov'\)\s*:\s*null\s*\)/.test(src);
  const oldInline = /!\/Windows\|Macintosh\|Linux x86\/i\.test\(navigator\.userAgent\)/.test(src);
  const logs = /\[xr\] foveation \$\{/.test(src);
  check('F11 xr.js decides foveation through foveationFor(navigator.userAgent, ?fov), keeps the [xr] foveation log line, no inline test left', calls && !oldInline && logs, { calls, oldInline, logs }); }

T.done();
