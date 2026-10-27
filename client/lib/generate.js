// conjure — the Orrery panel: prompt → image candidates (you pick; Orrery's "starred" chain pause) → 3D mesh → world.
// GLBs go Orrery → the sequencer's /upload, never through this client; placing is an @world `assets:<path>` set,
// admitted only with the gen permission (shared/protocol/authority/gate.js).
// ?orrery=<http(s) base> (or localStorage ew-orrery-url) overrides the service; a MOCK_APIS Orrery works offline.

import { enc } from '../../shared/protocol/names.js';
import * as OP from '../../shared/protocol/requests.js';
import { sendOps } from './editwrites.js';
import { CONFIG, bus, report } from './base.js';
import { fsvg } from './icons.js';
import { makeSection, toast, flashHint } from './ui.js';
import { net } from './net.js';
import { holdGhost } from './build.js';
import { logChat } from './chat.js';
import { escapeHtml as esc } from './markup.js';

// only an http(s) BASE (origin + plain path segments): it is interpolated into markup and fetches and persists, so a
// sent link must not smuggle markup or a javascript: URL
export const originOf = (v) => {
  try { const u = new URL(String(v ?? '')); if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
    const path = u.pathname.replace(/\/$/, ''); return /^(\/[A-Za-z0-9._-]+)*$/.test(path) ? u.origin + path : u.origin; }   // any other path drops to the origin
  catch { return null; }
};
const asked = originOf(CONFIG.params.get('orrery'));
const ORRERY = asked ?? originOf(localStorage.getItem('ew-orrery-url')) ?? 'https://orrery.animalabs.ai';
if (asked) localStorage.setItem('ew-orrery-url', asked);
const isHttpUrl = (v) => { try { return /^https?:$/.test(new URL(String(v)).protocol); } catch { return false; } };

const api = async (path, opts = {}) => {
  const r = await fetch(`${ORRERY}${path}`, {
    credentials: 'include',
    ...opts,
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) },
  });
  if (r.status === 401) { const e = new Error('not signed in'); e.auth = true; throw e; }
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 180)}`);
  return r.json();
};

// ---------------------------------------------------------------- job store
// your queue, not the world's; persisted so a 10-minute mesh survives a reload

const JOBS_KEY = 'ew-conjure-jobs';
let jobs = [];
try { jobs = JSON.parse(localStorage.getItem(JOBS_KEY) || '[]'); } catch { jobs = []; }
const saveJobs = () => localStorage.setItem(JOBS_KEY, JSON.stringify(jobs.slice(-20)));

// ---------------------------------------------------------------- polling

let bodyEl = null;          // the section body while open
let timer = null;
const active = (j) => !j.dismissed && !['completed', 'failed', 'cancelled'].includes(j.status ?? '');

function schedule() {
  clearTimeout(timer);
  // poll while the panel is open, or while anything is still cooking
  if (bodyEl || jobs.some(active)) timer = setTimeout(poll, 2500);
}

async function poll() {
  for (const j of jobs.filter(active)) {
    try {
      const chain = await api(`/api/chains/${j.chainId}`);
      const prev = j.status;
      j.status = chain.status;
      j.cursor = chain.cursor;
      j.error = chain.error;
      j.anchor = chain.anchor_node_id;
      const tree = await api(`/api/projects/${j.projectId}/tree`);
      j.nodes = tree.nodes.filter((n) => (n.group_id ?? '').startsWith(`${j.chainId}:`));
      if (prev !== j.status) {
        if (j.status === 'waiting_selection') {
          flashHint('✨ image candidates ready — pick one in the conjure panel');
          logChat('*', `conjure: "${j.prompt.slice(0, 40)}" wants your pick of images`);
        }
        if (j.status === 'completed') logChat('*', `conjure: "${j.prompt.slice(0, 40)}" is ready to place`);
        if (j.status === 'failed') logChat('*', `conjure failed: ${j.error ?? 'unknown'}`);
      }
    } catch (e) {
      if (e.auth) { connected = false; break; }
      console.warn('[conjure] poll', e.message);
    }
  }
  saveJobs();
  if (bodyEl) paint(bodyEl);
  schedule();
}

// ---------------------------------------------------------------- rendering

let connected = null;      // null = unknown, false = needs login, object = me


const STAGES = ['images', 'compose', 'mesh'];
function stageOf(j) {
  if (j.status === 'completed') return 'done';
  if (j.status === 'waiting_selection') return 'your pick';
  return STAGES[j.cursor ?? 0] ?? '…';
}

/** running-node progress for the current stage, 0-100 */
function progressOf(j) {
  const running = (j.nodes ?? []).filter((n) => n.status === 'running');
  if (!running.length) return null;
  return Math.round(running.reduce((s, n) => s + (n.progress ?? 0), 0) / running.length);
}

function imageCandidates(j) {
  // thumbnails are private: they need crossorigin="use-credentials" (COEP credentialless strips a plain <img>'s)
  return (j.nodes ?? [])
    .filter((n) => n.op_type === 'image_gen' && n.status === 'completed')
    .map((n) => ({
      node: n,
      // image_gen output is a 'grid' (2x2 turnaround); plain 'image' covers image_edit branches
      img: (n.assets ?? []).find((a) => a.kind === 'grid' || a.kind === 'image'),
    }))
    .filter((c) => c.img);
}

async function paint(body) {
  const genOk = net.myRights?.gen !== false;

  if (connected === null) {
    try { connected = await api('/api/auth/me'); }
    catch (e) { connected = e.auth ? false : null; }
  }

  if (connected === false) {
    body.innerHTML = `
      <p class="sub">conjure new objects from a prompt — images you approve,
        then a 3D mesh, straight into the world. Powered by orrery.</p>
      <button id="cj-connect">connect to orrery</button>`;
    body.querySelector('#cj-connect').onclick = async () => {
      try {
        const cfg = await api('/api/auth/config');
        if (!isHttpUrl(cfg.login_url)) throw new Error('orrery sent a login link that is not http(s)');
        const w = window.open(cfg.login_url, 'orrery-auth', 'width=520,height=680');
        // never depend on the popup's postMessage (under COOP it has no opener): it only speeds up POLLING /api/auth/me
        let done = false;
        // ONE idempotent teardown for every exit, so listeners can't accumulate across retries
        const cleanup = () => {
          if (done) return false;
          done = true;
          removeEventListener('message', onMsg);
          clearInterval(poll);
          try { w?.close(); } catch { /* severed under COOP, or already closed */ }
          return true;
        };
        const finish = () => {
          if (!cleanup()) return;
          connected = null;                       // unknown → paint re-checks auth
          paint(body).catch((e) => report('conjure', e));
        };
        const abandon = (reason) => {
          if (!cleanup()) return;
          connected = false;                      // retryable: the connect button paints again
          console.warn(`[conjure] orrery login ${reason}`);
          paint(body).catch((e) => report('conjure', e));
        };
        const onMsg = (ev) => {
          // the data string is not identity (any window could post it): the origin must match
          if (ev.origin !== new URL(ORRERY).origin) return;
          if (ev.data === 'orrery:signed-in') finish();
        };
        addEventListener('message', onMsg);
        // 90 s at 2 s: a slow sign-in fits, an abandoned popup leaves no timer
        let tries = 0;
        const poll = setInterval(async () => {
          if (done) return;
          if (++tries > 45) { abandon('timed out after 90s — connect again to retry'); return; }
          try { await api('/api/auth/me'); finish(); } catch { /* not yet */ }
        }, 2000);
      } catch (e) { report('orrery login', e); }
    };
    return;
  }

  const rows = jobs.filter((j) => !j.dismissed).slice(-8).reverse().map((j, i) => {
    const idx = jobs.indexOf(j);
    const prog = progressOf(j);
    const stage = stageOf(j);
    let inner = '';
    if (j.status === 'waiting_selection') {
      inner = `<div class="cj-pick">${imageCandidates(j).map((c) => `
        <img crossorigin="use-credentials"
             src="${esc(ORRERY)}/api/assets/${esc(c.img.id)}/file" data-star="${esc(c.node.id)}"
             title="use this one (starts the mesh)">`).join('')
        || '<span class="sub">candidates finished but none readable — open orrery</span>'}</div>`;
    } else if (j.status === 'completed') {
      inner = `<div class="cj-done">
        <button data-place="${idx}">${fsvg('sparkle', 12)} into the world</button>
        <button data-avatar="${idx}" title="rigged results only">as avatar</button>
      </div>`;
    } else if (j.status === 'failed') {
      inner = `<div class="sub">failed: ${esc(j.error ?? 'unknown')}</div>`;
    } else {
      inner = `<div class="cj-bar"><div style="width:${prog ?? 4}%"></div></div>`;
    }
    return `<div class="cj-job">
      <div class="cj-head">
        <span class="cj-prompt" title="${esc(j.prompt)}">${esc(j.prompt.slice(0, 44))}</span>
        <span class="cj-stage">${esc(stage)}${prog != null ? ` ${prog}%` : ''}</span>
        ${active(j) ? `<button class="cj-x" data-cancel="${idx}" title="cancel">✕</button>`
                    : `<button class="cj-x" data-dismiss="${idx}" title="dismiss">✕</button>`}
      </div>${inner}</div>`;
  }).join('');

  body.innerHTML = `
    <div class="cj-new">
      <input id="cj-prompt" type="text" maxlength="400" spellcheck="false"
        placeholder="describe a thing… e.g. a rusted brass lighthouse" ${genOk ? '' : 'disabled'}>
      <button id="cj-go" ${genOk ? '' : 'disabled'}>${fsvg('sparkle', 12)} conjure</button>
    </div>
    ${genOk ? '' : '<p class="sub">bringing new objects into this world needs the <b>gen</b> capability — ask its owner</p>'}
    <div id="cj-jobs">${rows || '<p class="sub">nothing cooking — your conjures queue here with progress, and pause for your pick of the image candidates before any mesh is spent.</p>'}</div>
    <p class="sub" style="margin-top:6px"><a href="${esc(ORRERY)}/" target="_blank" rel="noopener">open orrery ↗</a> for refs, retries, rigging and the full version tree.</p>`;

  const promptEl = body.querySelector('#cj-prompt');
  const go = async () => {
    const prompt = promptEl.value.trim();
    if (!prompt) return;
    promptEl.value = '';
    try {
      const r = await api('/api/quick', {
        method: 'POST',
        body: JSON.stringify({ prompt, n_images: 4, n_meshes: 1, approve_images: true }),
      });
      jobs.push({ chainId: r.chain_id, projectId: r.project_id, prompt, ts: Date.now(), status: 'running' });
      saveJobs();
      toast('conjuring — four image candidates first, then you pick', 'info');
      paint(body).catch(() => {});
      schedule();
    } catch (e) {
      if (e.auth) { connected = false; paint(body).catch(() => {}); }
      else report('conjure', e);
    }
  };
  body.querySelector('#cj-go').onclick = go;
  promptEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

  body.querySelectorAll('[data-star]').forEach((img) => {
    img.onclick = async () => {
      try {
        await api(`/api/nodes/${img.dataset.star}`, { method: 'PATCH', body: JSON.stringify({ starred: true }) });
        toast('starred — meshing begins', 'info');
        poll();
      } catch (e) { report('star', e); }
    };
  });
  body.querySelectorAll('[data-cancel]').forEach((b) => {
    b.onclick = async () => {
      const j = jobs[Number(b.dataset.cancel)];
      try { await api(`/api/chains/${j.chainId}/cancel`, { method: 'POST' }); } catch { /* already done */ }
      j.dismissed = true; saveJobs(); paint(body).catch(() => {});
    };
  });
  body.querySelectorAll('[data-dismiss]').forEach((b) => {
    b.onclick = () => { jobs[Number(b.dataset.dismiss)].dismissed = true; saveJobs(); paint(body).catch(() => {}); };
  });
  const place = (idx, asAvatar) => async () => {
    const j = jobs[idx];
    if (!j.anchor) return toast('no final node — open orrery to inspect', 'warn');
    try {
      toast('orrery is delivering it to the world…', 'info');
      const r = await api(`/api/nodes/${j.anchor}/send-to-eidoverse`, {
        method: 'POST',
        body: JSON.stringify(asAvatar ? { as_avatar: true, name: j.prompt.slice(0, 32) } : {}),
      });
      if (asAvatar) {
        toast(`avatar "${r.name}" is on the roster — pick it in the avatar panel`, 'info', 9000);
      } else {
        const label = j.prompt.slice(0, 40);
        sendOps([OP.set('@world', `assets:${enc(r.path)}`, { name: label, path: r.path })], { what: `add ${label} to this world's assets`, expect: false });
        await holdGhost(r.path, label);
        flashHint('on your cursor — click to set it down');
      }
    } catch (e) { report('place', e); }
  };
  body.querySelectorAll('[data-place]').forEach((b) => { b.onclick = place(Number(b.dataset.place), false); });
  body.querySelectorAll('[data-avatar]').forEach((b) => { b.onclick = place(Number(b.dataset.avatar), true); });
}

// ---------------------------------------------------------------- section

export function initConjure() {
  const style = document.createElement('style');
  style.textContent = `
    .cj-new { display:flex; gap:4px; margin-bottom:6px; }
    .cj-new input { flex:1; min-width:0; }
    .cj-job { border:1px solid var(--line, #333); border-radius:6px; padding:5px 6px; margin:5px 0; }
    .cj-head { display:flex; gap:6px; align-items:center; }
    .cj-prompt { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .cj-stage { color: var(--dim, #8a8f98); font-size: 11px; }
    .cj-x { padding:0 5px; }
    .cj-bar { height:5px; border-radius:3px; background:var(--line,#333); overflow:hidden; margin-top:5px; }
    .cj-bar div { height:100%; background:var(--acc, #7ec8a9); transition:width .6s; }
    .cj-pick { display:grid; grid-template-columns:1fr 1fr; gap:4px; margin-top:5px; }
    .cj-pick img { width:100%; border-radius:4px; cursor:pointer; border:2px solid transparent; }
    .cj-pick img:hover { border-color: var(--acc, #7ec8a9); }
    .cj-done { display:flex; gap:4px; margin-top:5px; }`;
  document.head.appendChild(style);

  makeSection('✨ conjure', async (body) => {
    bodyEl = body;
    await paint(body);
    schedule();
  }, { id: 'conjure' });

  bus.on('your-rights', () => { if (bodyEl) paint(bodyEl).catch(() => {}); });
  schedule();   // resume polling for jobs left cooking before a reload
}
