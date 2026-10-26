#!/usr/bin/env bun
// The two client-side COOP-compatibility contracts the isolation PR depends on: the credentialed thumbnail repair
// and the login poll's cleanup. Every predicate must also detect a corruption of the REAL extracted text, so a
// drifted extraction anchor fails loudly instead of passing vacuously (the door-media-whitelist idiom).
import { readFileSync } from 'fs';
const src = readFileSync(new URL('../client/lib/generate.js', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log(`ok   ${n}`)) : (fail++, console.log(`FAIL ${n}`)); };

// ── contract 1: credentialed thumbnails ─────────────────────────────────────
// under COEP a bare <img> fetches without credentials and 401s: every candidate needs crossorigin="use-credentials"
// (the length filter skips prose mentions of '<img>')
const imgTags = [...src.matchAll(/<img\b[^>]*>/gs)].map((m) => m[0]).filter((t) => t.length > 12);
const candidateImgs = imgTags.filter((t) => /cj-pick|imageCandidates|candidate/i.test(src.slice(Math.max(0, src.indexOf(t) - 300), src.indexOf(t) + t.length)));
ok('at least one candidate <img> exists to protect', candidateImgs.length > 0);
ok('every candidate <img> carries crossorigin="use-credentials"',
   candidateImgs.length > 0 && candidateImgs.every((t) => t.includes('crossorigin="use-credentials"')));
ok('control: the matcher detects a stripped crossorigin attr',
   !candidateImgs.map((t) => t.replace(/\s*crossorigin="use-credentials"/, ''))
     .every((t) => t.includes('crossorigin="use-credentials"')) || candidateImgs.length === 0);

// ── contract 2: the login flow's single idempotent teardown ─────────────────
// under COOP the popup's postMessage never arrives, so the POLL owns completion, and a timeout runs the same
// teardown as success: listener removed, timer cleared, done latched, a retryable state painted
const login = src.slice(src.indexOf('let done = false'), src.indexOf('} catch (e) { report(\'orrery login\''));
ok('login block extracted (anchors present)', login.length > 200);
ok('one shared cleanup latches done + removes the listener + clears the timer',
   /const cleanup = \(\) => \{[^}]*done = true;[\s\S]*?removeEventListener\('message', onMsg\);[\s\S]*?clearInterval\(poll\);/.test(login));
ok('the timeout branch runs the teardown (abandon), not a bare clearInterval',
   /tries > 45\) \{ abandon\(/.test(login) && !/tries > 45\) \{ clearInterval/.test(login));
ok('abandon restores a RETRYABLE state (connected = false)',
   /const abandon[\s\S]*?connected = false/.test(login));
ok('the message path validates ev.origin against the configured Orrery',
   /ev\.origin !== new URL\(ORRERY\)\.origin/.test(login));
ok('control: the timeout-matcher detects the old leaky shape',
   /tries > 45\) \{ clearInterval/.test(login.replace(/tries > 45\) \{ abandon\([^)]*\); return; \}/, 'tries > 45) { clearInterval(poll); return; }')));
ok('control: the origin-matcher detects its removal',
   !/ev\.origin !== new URL\(ORRERY\)\.origin/.test(login.replace(/if \(ev\.origin !== new URL\(ORRERY\)\.origin\) return;\n?/, '')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
