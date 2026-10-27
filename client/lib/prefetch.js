// prefetch — once arrival settles, streams likely-next assets into the HTTP cache so the next spawn is a disk read.
//   1. Demand wins: a real load (assets.js 'demand') ABORTS the in-flight prefetch and parks the queue until quiet.
//   2. Storage only: bytes are drained and dropped, never parsed.
//   3. Budgeted: a per-session cap plus a quota floor; the browser's LRU is the eviction policy.

import { negotiate } from '../../shared/ktx2.js';
import { bus, CONFIG, report } from './base.js';
import { whenBooted } from './boot.js';
import { whenCalm } from './governor.js';
import { demandState, listLibrary, ktx2Capable, ktx2KeyReady } from './assets.js';

const QUIET_MS = 1500;      // demand-free time required before (re)taking the wire
const SESSION_CAP = 600e6;  // max bytes streamed per session — a long visit warms a lot, a peek doesn't
const QUOTA_FLOOR = 300e6;  // leave at least this much storage quota untouched

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// wired to 'demand' permanently: preemption must not wait for the prefetcher's next turn around its loop
let abortNow = null;
bus.on('demand', () => abortNow?.());

const stats = { queued: 0, fetched: 0, bytes: 0, skipped: 0, preempted: 0, done: false };
globalThis.__ewPrefetch = stats; // console-inspectable, like EW

async function quietWindow() {
  for (;;) {
    const { active, last } = demandState();
    const since = performance.now() - last;
    if (!active && since >= QUIET_MS) return;
    await sleep(active ? 350 : Math.max(100, QUIET_MS - since + 50));
  }
}

/** Resolves to bytes drained; throws {preempted:true} when a demand load took the wire. */
async function pull(url) {
  const ctl = new AbortController();
  let preempted = false;
  abortNow = () => { preempted = true; ctl.abort(); };
  try {
    const r = await fetch(url, { priority: 'low', signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status}`);
    if (!r.body) return 0;
    const reader = r.body.getReader();
    let got = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return got;
      got += value.length;
    }
  } catch (e) {
    if (preempted) { const err = new Error('preempted'); err.preempted = true; throw err; }
    throw e;
  } finally { abortNow = null; }
}

async function quotaTight() {
  try {
    const { usage = 0, quota = 0 } = (await navigator.storage?.estimate?.()) ?? {};
    return quota > 0 && quota - usage < QUOTA_FLOOR;
  } catch { return false; }
}

// ordered by how soon a miss is felt: roster bodies, catalog previews, spawnables (smallest first), sky + weather
async function buildQueue() {
  const q = [];
  const seen = new Set();
  // the same key every demand fetch gets (assets.js), so warmth lands in the same cache entry
  const key = ktx2Capable() ? await ktx2KeyReady : null;
  const push = (path, size = 0) => {
    let url = path.startsWith('/') ? path : `/library/${path}`;
    // warm the SAME cache key demand uses (§20c): .glb/.vrm get ?ktx2=<key>; loose images only where primeFiles negotiates
    const bare = url.split('?')[0];
    if (key && (/\.(glb|vrm)$/.test(bare)
      || (/^\/library\/eidoverse\/assets\/(grass|sky|particle_textures)\//.test(bare) && /\.(png|jpe?g)$/i.test(bare)))) {
      url = negotiate(url, key);
    }
    if (!seen.has(url) && seen.add(url)) q.push({ url, size });
  };
  const roster = await fetch('/avatars').then((r) => r.json()).catch(() => []);
  for (const a of roster) push(a.path);
  const models = (await listLibrary('eidoverse/assets/models')) ?? [];
  for (const f of models) if (/_preview\.jpe?g$/i.test(f.path)) push(f.path, f.size);
  const store = (await listLibrary('store')) ?? [];
  const glbs = [...store, ...models.filter((f) => f.path.endsWith('.glb'))]
    .sort((a, b) => a.size - b.size);
  // /animations paths carry the ?v=<mtime> vrmaBytes requests, and resolve upstream-patched over library
  const clips = await fetch('/animations').then((r) => r.json()).catch(() => []);
  for (const c of clips) push(c.path, c.size);
  for (const f of glbs) push(f.path, f.size);
  for (const dir of ['eidoverse/assets/sky', 'eidoverse/assets/particle_textures'])
    for (const f of (await listLibrary(dir)) ?? []) push(f.path, f.size);
  return q;
}

export async function startPrefetch() {
  if (CONFIG.renderer) return;                        // the snap hub stays lean
  if (CONFIG.params.get('prefetch') === '0') return;  // escape hatch
  if (navigator.connection?.saveData) return;         // respect data saver
  await whenBooted();
  // waits for calm (§16.2.D: the governor's 5 smooth seconds); real loads never wait on prefetch
  await whenCalm();
  await quietWindow(); // let the join's own warm-fetches drain first
  const queue = await buildQueue().catch((e) => { report('prefetch', e); return []; });
  if (!queue.length) return;
  stats.queued = queue.length;
  const listed = queue.reduce((s, f) => s + f.size, 0);
  console.log(`[prefetch] ${queue.length} assets queued (~${(listed / 1e6).toFixed(0)}MB listed)`);
  while (queue.length) {
    if (stats.bytes >= SESSION_CAP) { console.log('[prefetch] session cap reached'); break; }
    if (stats.fetched % 25 === 0 && (await quotaTight())) { console.log('[prefetch] storage quota tight — stopping'); break; }
    await quietWindow();
    try {
      stats.bytes += await pull(queue[0].url);
      stats.fetched++;
      queue.shift();
    } catch (e) {
      if (e.preempted) { stats.preempted++; continue; } // same asset, after the next quiet window
      stats.skipped++; queue.shift();                   // 404 etc — drop it, move on
    }
  }
  stats.done = true;
  console.log(`[prefetch] done: ${stats.fetched} streamed (${(stats.bytes / 1e6).toFixed(1)}MB), `
    + `${stats.preempted} preemption(s), ${stats.skipped} skipped`);
}
