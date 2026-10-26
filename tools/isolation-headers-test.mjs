#!/usr/bin/env bun
// Isolation headers: every response, not just the document, must carry COOP/COEP, or crossOriginIsolated goes false
// and wasm silently loses its threads. Guards against regression by route; boots a real server. Not a benchmark.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const PORT = 8971 + Math.floor(Math.random() * 20);
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// identity, not just a listener: the child echoes this per-run nonce on /version and every probe is bound to it
const NONCE = randomUUID();
const scratch = mkdtempSync(join(tmpdir(), 'iso-'));
const srv = spawn(process.execPath, ['server/server.ts'], {
  env: { ...process.env, PORT: String(PORT), JOIN_TOKEN: 'iso-test',
         WORLDS_DIR: scratch, EIDO_BOOT_NONCE: NONCE },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', () => {});

const childAlive = () => srv.exitCode === null && !srv.killed;
const identity = async () => {
  const v = await (await fetch(`http://127.0.0.1:${PORT}/version`)).json();
  return v.nonce === NONCE;
};
const up = async () => {
  for (let i = 0; i < 60; i++) {
    if (!childAlive()) return false;  // died (EADDRINUSE etc.): never green
    try { if (await identity()) return true; }  // an answer that isn't OURS is not readiness
    catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

try {
  if (!await up()) { console.log(`FAIL server never came up as OURS (child ${childAlive() ? 'alive' : `exited ${srv.exitCode}`})`); process.exit(1); }

  // the document itself
  const doc = await fetch(`http://127.0.0.1:${PORT}/`);
  ok('document sends COOP',
     doc.headers.get('cross-origin-opener-policy') === 'same-origin',
     `got ${doc.headers.get('cross-origin-opener-policy')}`);
  ok('document sends COEP credentialless',
     doc.headers.get('cross-origin-embedder-policy') === 'credentialless',
     `got ${doc.headers.get('cross-origin-embedder-policy')}`);

  // the one that matters: a module script without COEP breaks isolation for the whole context; real 200s (the static
  // tree is rooted AT client/, so the module is '/main.js')
  for (const path of ['/main.js', '/lib/core.js', '/nonexistent-404']) {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
    if (path !== '/nonexistent-404') ok(`${path} is really served (not a 404)`, r.status === 200, `status ${r.status}`);
    ok(`${path} (${r.status}) carries both headers`,
       r.headers.get('cross-origin-opener-policy') === 'same-origin'
       && r.headers.get('cross-origin-embedder-policy') === 'credentialless',
       `COOP=${r.headers.get('cross-origin-opener-policy')} COEP=${r.headers.get('cross-origin-embedder-policy')}`);
  }

  // credentialless, NOT require-corp (which blocks any non-opted-in cross-origin subresource, a different product
  // decision): the exact value is pinned so a "stricter is safer" edit has to argue
  ok('COEP is credentialless, not require-corp',
     doc.headers.get('cross-origin-embedder-policy') !== 'require-corp');

  // the websocket upgrade must be untouched: a 101 never reaches fetch(), so the observable is that the socket still opens
  const wsOk = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const t = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 4000);
    ws.onopen = () => { clearTimeout(t); ws.close(); resolve(true); };
    ws.onerror = () => { clearTimeout(t); resolve(false); };
  });
  ok('websocket upgrade still succeeds under isolate()', wsOk);

  // bind the whole run to the child once more (alive, our nonce): a mid-run crash + stale listener would pass every header check
  ok('child is still alive after the vectors', childAlive(), `exitCode=${srv.exitCode}`);
  ok('responder is still OUR child (nonce echo)', await identity().catch(() => false));
} finally {
  // TERM first (let it close sockets), escalate to KILL, then remove scratch
  srv.kill('SIGTERM');
  await new Promise((r) => { const t = setTimeout(() => { try { srv.kill('SIGKILL'); } catch {} r(); }, 3000); srv.once('exit', () => { clearTimeout(t); r(); }); });
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
