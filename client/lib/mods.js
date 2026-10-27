// mods — LOCAL, TRUSTED client modules in IndexedDB: full EW access (they can act as you), like a browser extension.
// Trust model: docs/MODDING-UI.md. A world never offers client mods; world scripts run server-side (docs/SCRIPTS.md).
// Five consecutive tick throws pause a mod; disabling can't unload a module (globals persist until reload).

import { bus, CONFIG, report } from './base.js';
import { makeSection, toast, flashHint } from './ui.js';
import { bodyEngine, setBodyEngine, currentBodyEngine, listBodyEngines } from './bodysim.js';
import { makeFrame } from './windows.js';
import { logChat } from './chat.js';
import { escapeHtml as esc } from './markup.js';

// ---------------------------------------------------------------- storage

const DB = 'ew-mods';
let db = null;
function idb() {
  if (db) return Promise.resolve(db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('scripts', { keyPath: 'name' });
    r.onsuccess = () => { db = r.result; res(db); };
    r.onerror = () => rej(r.error);
  });
}
const tx = async (mode, fn) => {
  const d = await idb();
  return new Promise((res, rej) => {
    const t = d.transaction('scripts', mode);
    const out = fn(t.objectStore('scripts'));
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
  });
};
const listScripts = () => tx('readonly', (s) => s.getAll()).then((r) => r ?? []);
const putScript = (rec) => tx('readwrite', (s) => s.put(rec));
const delScript = (name) => tx('readwrite', (s) => s.delete(name));

// ---------------------------------------------------------------- runtime

// name -> { ticks: [], disposers: [], sections: [], frames: [], errors, dead }
const running = new Map();

function makeCtx(name) {
  const inst = { ticks: [], disposers: [], sections: [], frames: [], errors: 0, dead: false };
  running.set(name, inst);
  return {
    name,
    world: CONFIG.world,
    EW: globalThis.EW,
    ui: {
      /** A tab in the world panel — removed on disable. */
      section: (title, onOpen) => { const s = makeSection(title, onOpen); inst.sections.push(s); return s; },
      /** A free-floating draggable frame — removed on disable. */
      frame: (id, opts) => { const f = makeFrame(`mod-${name}-${id}`, opts); inst.frames.push(f); return f; },
      toast, flashHint, logChat,
    },
    onTick: (fn) => inst.ticks.push(fn),
    onDispose: (fn) => inst.disposers.push(fn),
  };
}

async function runSource(name, source) {
  stopMod(name);                       // re-run = fresh registrations
  const ctx = makeCtx(name);
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    const mod = await import(/* @vite-ignore */ url);
    if (typeof mod.default === 'function') await mod.default(ctx);
    flashHint(`mod "${name}" running`);
  } catch (e) {
    report(`mod ${name}`, e);
    toast(`mod "${name}" failed to start: ${e.message}`, 'err', 9000);
    stopMod(name);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function stopMod(name) {
  const inst = running.get(name);
  if (!inst) return;
  running.delete(name);
  for (const fn of inst.disposers) { try { fn(); } catch (e) { report(`mod ${name} dispose`, e); } }
  for (const s of inst.sections) s.remove?.();   // the tab, its pane and its lantern action
  for (const f of inst.frames) { try { f.hide?.(); f.el?.remove(); } catch { /* gone */ } }
}

export function tickMods(dt, now) {
  for (const [name, inst] of running) {
    if (inst.dead) continue;
    for (const fn of inst.ticks) {
      try { fn(dt, now); inst.errors = 0; }
      catch (e) {
        report(`mod ${name} tick`, e);
        if (++inst.errors >= 5) {
          inst.dead = true;
          toast(`mod "${name}" paused after repeated errors — re-enable it in 🧩 mods`, 'err', 9000);
          break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------- the panel

let paint = null;

const TEMPLATE = `// an eidoverse mod — full client access, trusted like a browser extension.
// export default gets { name, world, EW, ui, onTick, onDispose }.
// EW: entities, remotes, myState, me(), THREE, scene, sendRequest (door requests), physics (grab/put/throw/punt), bus…
export default ({ EW, ui, onTick }) => {
  ui.flashHint('hello from a mod');
  let t = 0;
  onTick((dt) => {
    t += dt;
    // your per-frame work here — e.g. drive your own bones…
  });
};
`;

/** put and run need transient user activation, so code that merely holds EW can't plant a mod that outlives it.
 *  Defence in depth only: the walls are tools/protocol/modhole-check.ts and the page's CSP. */
const byHand = (what) => {
  if (globalThis.navigator?.userActivation && !navigator.userActivation.isActive) throw new Error(`EW.mods.${what} needs a click or key press from you (installing or running a mod is your decision)`);
};
export const modsApi = {
  list: listScripts,
  put: (rec) => { byHand('put'); return putScript(rec); },
  run: (name, source) => { byHand('run'); return runSource(name, source); },
  stop: stopMod,
  running: () => [...running.keys()],
};

export function initMods() {
  makeSection('🧩 mods', async (body) => {
    let editing = null;      // name being edited, '' = new
    const render = async () => {
      const mine = await listScripts();
      const rows = mine.map((s) => {
        const on = running.has(s.name);
        return `<div class="mod-row stacked">
          <div class="mod-txt"><span class="mod-nm">${esc(s.name)}</span><span class="mod-note">${on ? 'running' : 'stopped'}${s.auto ? ' · runs on arrival' : ''}</span></div>
          <div class="mod-btns">
            <button data-run="${esc(s.name)}">${on ? 'stop' : 'run'}</button>
            <button data-auto="${esc(s.name)}" title="run it every time you arrive">${s.auto ? 'autorun ✓' : 'autorun'}</button>
            <button data-edit="${esc(s.name)}">edit</button>
            <button data-del="${esc(s.name)}" title="delete this mod" aria-label="delete">✕</button></div>
        </div>`;
      }).join('');
      body.innerHTML = `
        <div class="sec-cap">built in</div>
        <div class="mod-row">
          <div class="mod-txt"><span class="mod-nm">body engine</span><span class="mod-note">how your falls simulate — verlet: particles · ammo: Bullet, the janus rig. Click to cycle.</span></div>
          <button data-bodyeng="1">${bodyEngine()}</button></div>
        <div class="sec-cap">your mods</div>
        <div class="mod-note warn">local mods run with full access, as you — load only code you trust</div>
        ${rows || '<div class="mod-note">no local mods yet</div>'}
        <button data-new="1">+ new mod</button>
        ${editing != null ? `<div class="sec-cap">${editing ? `editing ${esc(editing)}` : 'new mod'}</div>
          <input id="mod-name" placeholder="mod name" value="${esc(editing)}" ${editing ? 'disabled' : ''}>
          <textarea id="mod-src" rows="14" spellcheck="false"></textarea>
          <div class="btn-row"><button data-save="1">save</button><button data-cancel="1">cancel</button></div>` : ''}`;
      if (editing != null) {
        const rec = editing ? mine.find((s) => s.name === editing) : null;
        body.querySelector('#mod-src').value = rec?.source ?? TEMPLATE;
      }
      body.onclick = async (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const d = b.dataset;
        // built-in toggles answer BEFORE any await: a listScripts() rejection here would silently kill every button
        if (d.bodyeng) {
          const names = listBodyEngines();
          setBodyEngine(names[(names.indexOf(currentBodyEngine()) + 1) % names.length]);
          flashHint(`body engine: ${bodyEngine()} — takes effect on your next fall`);
          return render();
        }
        let mine2 = [];
        try { mine2 = await listScripts(); }
        catch (err) { report('mods: listScripts', err); }
        if (d.new) { editing = ''; return render(); }
        if (d.cancel) { editing = null; return render(); }
        if (d.save) {
          const name = (body.querySelector('#mod-name').value || '').trim().replace(/[^\w-]/g, '').slice(0, 32);
          const source = body.querySelector('#mod-src').value;
          if (!name) return toast('a mod needs a name', 'warn');
          await putScript({ name, source, auto: mine2.find((s) => s.name === name)?.auto ?? false });
          editing = null;
          return render();
        }
        if (d.edit != null) { editing = d.edit; return render(); }
        if (d.del != null) { stopMod(d.del); await delScript(d.del); return render(); }
        if (d.auto != null) {
          const rec = mine2.find((s) => s.name === d.auto);
          if (rec) await putScript({ ...rec, auto: !rec.auto });
          return render();
        }
        if (d.run != null) {
          if (running.has(d.run)) stopMod(d.run);
          else { const rec = mine2.find((s) => s.name === d.run); if (rec) await runSource(d.run, rec.source); }
          return render();
        }
      };
    };
    paint = render;
    await render();
  }, { id: 'mods' });

  // autoruns: local mods marked auto
  bus.on('hydrated', async () => {
    for (const s of await listScripts()) if (s.auto && !running.has(s.name)) runSource(s.name, s.source);
  });
}
