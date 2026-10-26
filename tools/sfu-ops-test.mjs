// the operational gaps #104's acceptance table names, pinned
import { readFileSync } from 'fs';
const S = (p) => readFileSync(new URL(`../server/${p}`, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`ok   ${n}`)) : (fail++, console.log(`FAIL ${n}`)); };

// A1: the seven refusals must RUN on the live path
const srv = S('server.ts');
check('admitSfuLeg is called from server.ts (not just its own test)', /admitSfuLeg\(/.test(srv));
check('a missing credential is refused', /no credential presented/.test(srv));
check('a refused leg is revoked, not left half-open', /revokeSfuLeg\(c\.world\.name, c\.id\)/.test(srv));

// the client must PRESENT the claim, or the gate has nothing to check
const cli = readFileSync(new URL('../client/lib/voicesfu.js', import.meta.url), 'utf8');
// 🔴 assert the SHAPE that must reach the server: a string grep can't tell a bound identifier from a free one
check('client returns its credential on sfu-answer',
  /cred: cred && \{/.test(cli) && /nonce: cred\.nonce/.test(cli));
check('the credential the client sends carries all six claims',
  ['world:', 'id:', 'primaryGen:', 'mediaGen:', 'incarnation:', 'nonce:']
    .every((f) => new RegExp(f.replace(':', ':\\s*cred\\.')).test(cli)));

// A2: benign werift-owned errnos are contained at the OWNERSHIP seam (UdpTransport.init); process handlers only report
// fatals. The behaviour is tools/sfu-test.ts's owned/unowned vectors
const guard = S('sfuguard.ts');
check('guard contains benign errnos at the werift ownership seam (UdpTransport.init patch)',
  /UdpTransport/.test(guard) && /benign/i.test(guard));
check('…while process-scope handlers stay fatal (exit path present, not removed)',
  /process\.exit/.test(guard));
check('guard is installed explicitly, not from a constructor', !/installSfuTransportGuard\(\)/.test(S('sfu.ts')));
check('server installs the guard at boot', /installSfuTransportGuard\(/.test(srv));
const sup = S('sfusupervisor.ts');
check('voice can be marked degraded without killing the process', /markVoiceDegraded/.test(sup));
check('voice-service is broadcast with the incarnation', /voice-service/.test(srv) && /incarnation/.test(sup));

// FEC: asked for explicitly, not inherited from a browser default
check('offer requests Opus in-band FEC', /useinbandfec=1/.test(S('sfuadapter.ts')));
check('FEC is applied to the offer that is SENT', /withOpusFec\(pc\.localDescription/.test(S('sfuadapter.ts')));

// media-path recovery: a leg that dies while the world socket is healthy re-establishes itself, capped, reset on success
const bridge = readFileSync(new URL('../client/lib/voicesfubridge.js', import.meta.url), 'utf8');
const vsfu = readFileSync(new URL('../client/lib/voicesfu.js', import.meta.url), 'utf8');
check('ICE failure emits a recovery request, not just a log line', /sfu-media-dead/.test(vsfu));
check('the stall path asks for recovery too', /reason: 'ice-stalled'/.test(vsfu));
check('the bridge answers with a fresh credential ask', /bus\.on\('sfu-media-dead'/.test(bridge) && /sendRelayCredRequest\(\);\s+\/\/ fresh credential/.test(bridge));
check('recovery is capped (no infinite doomed re-joins)', /recoveryAttempts >= 3/.test(bridge));
check('the budget resets when media actually connects', /bus\.on\('sfu-media-live'/.test(bridge) && /recoveryAttempts = 0/.test(bridge));
// speaker teardown: a departed visitor's <audio>+analyser must not outlive them
check('a dead leg (gen null) drops its playback', /sfuDropSpeaker\(actor\)/.test(bridge));
check('dropSpeaker releases element, analyser and map entry',
  /s\.audio\.srcObject = null/.test(vsfu) && /speakers\.delete\(id\)/.test(vsfu.split('sfuDropSpeaker')[1] ?? ''));

// negative controls: each matcher must be able to fail
check('control: a server without the gate is detected', !/admitSfuLeg\(/.test('case "sfu-answer": { void accept(); }'));
check('control: a guard that exits is detected', /process\.exit/.test('function die(){ process.exit(1); }'));

// A3: three INDEPENDENT states, each with a reachable verb
check('listener receive consent has a verb', /case "voice-consent"/.test(srv));
check('moderator mute has a verb (A3 third state)', /case "voice-moderate"/.test(srv));
check('moderator mute is rights-gated, not a preference', /ROLE_RANK\[rights\.role\] < 2/.test(srv));
check('moderator mute reaches the enforcement', /setSfuModeratorMute\(c\.world\.name/.test(srv));
check('moderation is world-visible', /voice-moderated/.test(srv));

// Amendment 5: no rung inherits the name of the next
check('performed names its rung', /rung: "authorized-claim"/.test(srv));
check('performed carries the incarnation that scopes it', /performed[\s\S]{0,200}currentIncarnation\(\)/.test(srv));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
