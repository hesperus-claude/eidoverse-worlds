// scenegraph — the world panel's 🌳 scene tree (rows + an inspector) and 📜 scripts view. Only sends requests; the
// authority enforces rights. Attach keeps the world transform; a saved comp edit replaces that type's data WHOLESALE.

import { THREE } from './core.js';
import { CONFIG, bus } from './base.js';
import * as Sel from './edit/selection.js';
import { entities, metaOf, bagOf, avatarMounts } from './world.js';
import { compEntries } from '../../shared/protocol/view.js';
import { editorsFor, commitEdit } from './inspect.js';
import './lights.js';   // its registered light editor
import { requestDebug, replica } from './net.js';
import { sendOps, del, revertPose } from './editwrites.js';
import * as OP from '../../shared/protocol/requests.js';
import { state } from './state.js';
import { offIn } from './realize/models_field.js';
import { makeSection, flashHint, html } from './ui.js';
import { logChat } from './chat.js';
import { myState } from './controller.js';
import { modelWord } from '../../shared/eido.js';
import { called } from './plainwords.js';
import { escapeHtml as esc } from './markup.js';



const _wp = new THREE.Vector3();

// ============================================================ 🌳 scene

let sceneApi = null;
let sceneBody = null;
let arming = null;         // child id waiting for a parent click

function badgesFor(id) {
  const out = [];
  for (const [type, data] of compEntries(bagOf(id))) {
    if (type === 'motion' || type.startsWith('motion:')) {
      out.push(`${type}(${data?.type ?? '…'})`);
    } else if (type === 'reactions') {
      out.push(`${type}(${Object.keys(data ?? {}).join(',')})`);
    } else out.push(type);
  }
  return out;
}

export function treeData() {
  const kids = new Map();
  const roots = [];
  for (const [id, obj] of entities) {
    const p = obj?.userData?.mountedTo;
    if (p && entities.has(p)) {
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(id);
    } else roots.push(id);
  }
  const occupants = new Map();
  for (const [oid, m] of avatarMounts) {
    if (!occupants.has(m.to)) occupants.set(m.to, []);
    occupants.get(m.to).push(oid);   // m.to is the socket
  }
  return { roots, kids, occupants };
}

let editingComp = null;    // comp type whose JSON is open, or true for a new one

function paintScene(force = false) {
  if (!sceneBody) return;
  const selected = sceneSelected();
  // never rebuild an editor under the user: a focused control or open JSON holds repaints; interior changes force
  if (!force) {
    if (editingComp != null) return;
    const ae = document.activeElement;
    if (sceneBody.contains(ae) && /^(INPUT|TEXTAREA)$/.test(ae?.tagName ?? '')) return;
  }
  const { roots, kids, occupants } = treeData();
  const rows = [];
  const row = (id, depth) => {
    const meta = metaOf(id);
    const short = (meta?.model != null ? modelWord(meta.model) : (meta?.kind ?? '?').split('/').pop())   // never the hex
      .split('_').slice(0, 3).join(' ');
    const badges = badgesFor(id);
    const scripts = behaviorRows.filter((b) => b.attach === id).map((b) => `📜${b.id}`);
    rows.push(`<div class="who-row sg-row${id === selected ? ' sel' : ''}" data-id="${esc(id)}" style="cursor:pointer;padding-left:${depth * 14}px">
      <span class="n">${depth ? '└ ' : ''}<b>${esc(id)}</b> <span style="color:var(--dim)">${esc(short)}</span></span>
      <span class="d">${esc([...badges, ...scripts].join(' · '))}</span></div>`);
    for (const r of occupants.get(id) ?? []) {
      rows.push(`<div class="who-row" style="padding-left:${(depth + 1) * 14}px"><span class="n">└ 🧍 ${esc(r)}</span></div>`);
    }
    for (const k of kids.get(id) ?? []) row(k, depth + 1);
  };
  for (const id of roots.sort()) row(id, 0);

  let inspector = '';
  let eds = [];
  if (selected && entities.has(selected)) {
    const obj = entities.get(selected);
    const meta = metaOf(selected);
    const bag = bagOf(selected);
    const pos = obj ? obj.getWorldPosition(_wp) : null;
    const isLight = meta?.kind === 'light' && bag?.light?.kind !== 'spot';   // a spot shines along its -Z: its yaw is its aim

    // LOCAL frame (labelled when mounted), what `place` takes; no yaw/scale on a bulb
    let transform = '';
    if (obj) {
      const n2 = (v) => Number(v.toFixed(2));
      // the authority asks before a locked thing moves
      const locked = !!bag?.lock;
      const cell = (f, v, step) => `<input type="number" data-tf="${f}" value="${v}" step="${step}" style="width:4.5em">`;
      transform = `<div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin:4px 0">
        <span style="color:var(--dim)">${locked ? '🔒 ' : ''}${obj.userData.mountedTo ? 'local ' : ''}pos</span>
        ${cell('x', n2(obj.position.x), 0.1)}${cell('y', n2(obj.position.y), 0.1)}${cell('z', n2(obj.position.z), 0.1)}
        ${isLight ? '' : `<span style="color:var(--dim)">yaw°</span>${cell('yaw', Math.round(obj.rotation.y * 180 / Math.PI), 5)}
        <span style="color:var(--dim)">scale</span>${cell('scale', n2(obj.scale?.x ?? 1), 0.05)}`}
      </div>`;
    }

    // whatever editors evaluator modules registered
    const target = selected;
    eds = editorsFor({ id: selected, obj, meta, bag, esc,
      commit: (component, value) => sendOps([value == null ? OP.unset(target, component) : OP.set(target, component, value)], { what: `${component} on ${target}` }) });

    // any comp type edits as raw JSON, meaning-free like the blind fold; a save replaces WHOLESALE, ✕ removes
    const compRows = compEntries(bag).map(([type, data]) => {
      if (editingComp === type) {
        return `<div style="margin:2px 0"><b>${esc(type)}</b>
          <textarea data-ce="json" spellcheck="false" style="width:100%;height:90px;font-size:11px;font-family:inherit">${esc(JSON.stringify(data, null, 1))}</textarea>
          <div style="display:flex;gap:6px"><button data-ce="apply">apply</button><button data-ce="cancel">cancel</button></div></div>`;
      }
      return `<div style="display:flex;gap:6px;align-items:center">
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b>${esc(type)}</b> <span style="color:var(--dim);font-size:11px">${esc(JSON.stringify(data).slice(0, 60))}</span></span>
        <button data-ce-edit="${esc(type)}" title="edit as JSON">✎</button>
        <button data-ce-del="${esc(type)}" title="remove component">✕</button></div>`;
    });
    const newComp = editingComp === true
      ? `<div style="margin:2px 0"><input data-ce="newtype" placeholder="type (e.g. sockets, recipe…)" style="width:14em">
          <textarea data-ce="json" spellcheck="false" style="width:100%;height:90px;font-size:11px;font-family:inherit">{
}</textarea>
          <div style="display:flex;gap:6px"><button data-ce="apply">apply</button><button data-ce="cancel">cancel</button></div></div>`
      : `<div><button data-ce-add title="attach a component — any type folds, evaluators give known ones behavior">+ component</button></div>`;

    inspector = `<div style="border-top:1px solid var(--edge);margin-top:6px;padding-top:6px">
      <div><b>${esc(selected)}</b> <span style="color:var(--dim)">${esc(meta?.model ?? '')}</span></div>
      <div style="color:var(--dim)">${pos ? `at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})` : 'loading'}${obj?.userData?.mountedTo ? ` · mounted on ${esc(obj.userData.mountedTo)}` : ''}</div>
      ${transform}
      ${eds.map((e) => e.html).join('')}
      ${compRows.join('')}${newComp}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
        <button data-act="find">find</button>
        <button data-act="attach">${arming === selected ? 'click new parent…' : 'attach to…'}</button>
        ${obj?.userData?.mountedTo ? '<button data-act="detach">detach</button>' : ''}
        <button data-act="remove">remove</button>
      </div></div>`;
  }
  sceneBody.innerHTML = `<div class="stack" style="max-height:200px;overflow:auto">${rows.join('') || '<div style="color:var(--dim)">nothing placed yet</div>'}</div>${inspector}`;

  for (const el of sceneBody.querySelectorAll('.sg-row')) {
    el.onclick = () => {
      const id = el.dataset.id;
      if (arming && arming !== id) { doAttach(arming, id); arming = null; return; }
      arming = null;
      editingComp = null;
      if (id === selected) Sel.clear(); else Sel.set([id]);   // 'selection' repaints
    };
  }
  sceneBody.querySelector('[data-act="find"]')?.addEventListener('click', () => {
    const obj = entities.get(selected);
    if (!obj) return;
    const p = obj.getWorldPosition(_wp);
    flashHint(html`<b>${selected}</b> is ${p.distanceTo(myState.pos).toFixed(0)}m away at (${p.x.toFixed(0)}, ${p.z.toFixed(0)})`, 5000);
  });
  sceneBody.querySelector('[data-act="attach"]')?.addEventListener('click', () => {
    arming = arming === selected ? null : selected;
    flashHint(arming ? 'now click the row of its new parent' : 'attach cancelled', 4000);
    paintScene();
  });
  // semantic editors wire their own controls
  for (const e of eds) { try { e.wire(sceneBody); } catch { /* must not break the panel */ } }

  // one `place` per change carrying ONLY that field: the shown yaw/scale are rounded, and resending them flattened a
  // tilt and a per-axis scale
  for (const el of sceneBody.querySelectorAll('[data-tf]')) {
    el.addEventListener('change', () => {
      const f = el.dataset.tf, v = Number(el.value), id = selected;
      if (Number.isNaN(v)) return;
      const cur = state.st.entities?.[id] ?? {};
      const axis = ['x', 'y', 'z'].indexOf(f);
      let patch;
      if (axis >= 0) { const pos = Array.isArray(cur.pos) && cur.pos.length === 3 ? [...cur.pos] : [0, 0, 0]; pos[axis] = v; patch = { pos }; }
      else if (f === 'yaw') patch = { yaw: v * Math.PI / 180 };
      else if (f === 'scale') patch = { scale: v };
      else return;
      sendOps([OP.setTransform(cur, id, patch)], { what: `move ${id}`, revert: () => revertPose(id) });
    });
  }

  for (const b of sceneBody.querySelectorAll('[data-ce-edit]')) {
    b.onclick = () => { editingComp = b.dataset.ceEdit; paintScene(true); };
  }
  for (const b of sceneBody.querySelectorAll('[data-ce-del]')) {
    b.onclick = () => { sendOps([OP.unset(selected, b.dataset.ceDel)], { what: `remove ${b.dataset.ceDel} from ${selected}` }); };
  }
  sceneBody.querySelector('[data-ce-add]')?.addEventListener('click', () => {
    editingComp = true; paintScene(true);
  });
  sceneBody.querySelector('[data-ce="apply"]')?.addEventListener('click', () => {
    const type = editingComp === true
      ? (sceneBody.querySelector('[data-ce="newtype"]')?.value ?? '').trim()
      : editingComp;
    if (!type) { flashHint('component needs a type name', 4000); return; }
    let data;
    try { data = JSON.parse(sceneBody.querySelector('[data-ce="json"]').value); }
    catch (err) { flashHint(`not valid JSON: ${err.message}`, 5000); return; }
    sendOps([data == null ? OP.unset(selected, type) : OP.set(selected, type, data)], { what: `${type} on ${selected}` });
    editingComp = null;
    paintScene(true);
  });
  sceneBody.querySelector('[data-ce="cancel"]')?.addEventListener('click', () => {
    editingComp = null; paintScene(true);
  });

  sceneBody.querySelector('[data-act="detach"]')?.addEventListener('click', () => doDetach(selected));
  sceneBody.querySelector('[data-act="remove"]')?.addEventListener('click', () => {
    del([selected]);
    Sel.clear();
  });
}

export const sceneSelected = () => { const s = Sel.selection(); return s.kind === 'things' ? s.ids[0] ?? null : null; };
// while the edit-mode frames are up they ARE the inspector: a selection must not also yank the World panel open
let editUI = false;
bus.on('edit-mode', (on) => { editUI = !!on; });
/** sceneSelect refuses a null id. */
export function sceneDeselect() {
  if (sceneSelected() == null) return;
  arming = null; editingComp = null;
  Sel.clear();
}
/** World-click → panel: clicking a thing in edit mode and clicking its row are the same act. */
export function sceneSelect(id) {
  if (id == null || (!entities.has(id) && !offIn(state.st.entities, id))) return;   // a switched-off thing is unrealized, still selectable
  arming = null;
  editingComp = null;
  if (!Sel.set([id])) followSelection(Sel.selection());   // already selected: still scroll to it
}
/** The panel follows the selection, whoever set it. */
function followSelection({ ids, kind }) {
  const id = kind === 'things' ? ids[0] ?? null : null;
  if (!sceneApi) return;
  if (id == null || editUI) { if (sceneApi.isOpen) paintScene(true); return; }
  const reveal = () => {
    paintScene(true);
    sceneBody?.querySelector(`.sg-row[data-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  };
  // toggle(true) assigns sceneBody synchronously: paint now (never wait on the network), again when the roster lands
  const t = sceneApi.toggle(true);
  reveal();
  Promise.resolve(t).then(reveal).catch(() => {});
}

/** Attach keeping the CURRENT world transform: glue, don't teleport. /mount and the panel are the same act. */
export function sceneAttach(childId, parentId, slot) {
  if (slot) {   // a declared socket wins
    sendOps([OP.parent(state.st, childId, parentId, { socket: slot })], { what: `seat ${childId} on ${parentId}` });
    return;
  }
  doAttach(childId, parentId);
}
// one path for every attach/detach (commitEdit): keeps the world pose, refuses loop / lock / guard by name, one undo step
function doAttach(childId, parentId) {
  if (childId === parentId) return;
  const r = commitEdit(childId, 'parent.to', parentId);
  if (r.errors?.length) return logChat('*', r.errors.join(' · '));
  logChat('*', `${called(childId)} now rides ${called(parentId)} — it moves when ${called(parentId)} moves`);
}

export function sceneDetach(id) { doDetach(id); }
function doDetach(id) {
  const r = commitEdit(id, 'parent.to', null);
  if (r.errors?.length) logChat('*', r.errors.join(' · '));
}

// ============================================================ 📜 scripts

let scriptsApi = null;
let scriptsBody = null;
let behaviorRows = [];     // also the tree's 📜 badges
let watching = null;       // whose console is open
let pollTimer = null;

async function refreshRoster() {
  const r = await requestDebug({ scripts: true });
  behaviorRows = (r.events ?? []).filter((e) => e.kind === 'script');
}

async function paintScripts() {
  if (!scriptsBody) return;
  const rows = behaviorRows.map((b) => {
    const ok = b.status === 'active' || b.status === 'asleep';
    return `<div class="who-row sg-script" data-id="${esc(b.id)}" style="cursor:pointer;${b.id === watching ? 'background:rgba(255,255,255,.06)' : ''}">
      <span class="n">${ok ? '▶' : '⏸'} <b>${esc(b.id)}</b>${b.attach ? ` <span style="color:var(--dim)">on ${esc(b.attach)}</span>` : ''}</span>
      <span class="d">${b.timers ? `${b.timers}⏲ ` : ''}${ok ? '' : esc(b.status ?? 'paused')}</span></div>`;
  });

  let consoleHtml = '';
  if (watching) {
    const d = await requestDebug({ script: watching, limit: 40 });
    const lines = (d.events ?? []).map((e) =>
      `${new Date(e.ts).toTimeString().slice(0, 8)} ${esc(e.line)}`).join('\n');
    consoleHtml = `<div style="border-top:1px solid var(--edge);margin-top:6px;padding-top:6px">
      <div><b>${esc(watching)}</b> — <span style="color:${/^(active|asleep)/.test(String(d.status ?? '')) ? 'var(--ok, #7c9)' : 'var(--warn, #ea5)'}">${esc(d.status ?? '?')}</span></div>
      <pre style="max-height:150px;overflow:auto;margin:4px 0;font-size:11px;white-space:pre-wrap">${lines || '(console empty — console.log() writes here)'}</pre>
      <div style="display:flex;gap:6px">
        <button data-act="unbind">remove</button>
      </div></div>`;
  }
  scriptsBody.innerHTML = `<div class="stack">${rows.join('') || '<div style="color:var(--dim)">no scripts here — a script is a script:&lt;name&gt; component on a thing (docs/SCRIPTS-replica.md)</div>'}</div>${consoleHtml}
    <div style="color:var(--dim);font-size:11px;margin-top:4px">/debug [n] = flight recorder · agents: world_debug</div>`;

  for (const el of scriptsBody.querySelectorAll('.sg-script')) {
    el.onclick = () => { watching = el.dataset.id === watching ? null : el.dataset.id; paintScripts(); };
  }
  scriptsBody.querySelector('[data-act="unbind"]')?.addEventListener('click', async () => {
    const w = String(watching); const i = w.indexOf('/');
    sendOps(w.startsWith('imported-behavior:') ? [OP.unset('@world', w)] : [OP.unset(w.slice(0, i), `script:${w.slice(i + 1)}`)], { what: `remove ${w}`, expect: false });
    watching = null;
    setTimeout(async () => { await refreshRoster(); paintScripts(); paintScene(); }, 400);
  });
}

// ============================================================ wiring

export function initSceneGraph() {
  sceneApi = makeSection('🌳 scene', async (body) => {
    sceneBody = body;
    await refreshRoster();      // for the 📜 badges
    paintScene();
  }, { id: 'scene' });

  // retired on a replica (research roles §7): scripts live in Moderation › Scripts, old bindings in World Settings
  bus.on('hydrated', () => { if (replica.active && scriptsApi) { scriptsApi.remove(); scriptsApi = null; } });
  scriptsApi = makeSection('📜 scripts', async (body) => {
    scriptsBody = body;
    await refreshRoster();
    await paintScripts();
    clearInterval(pollTimer);
    // poll while open: an author watches their console.log() arrive here
    pollTimer = setInterval(async () => {
      if (!scriptsApi?.isOpen) { clearInterval(pollTimer); pollTimer = null; return; }
      await refreshRoster();
      await paintScripts();
    }, 2500);
  }, { id: 'scripts' });

  // repaint while visible
  let repaintQueued = false;
  const repaint = () => {
    if (repaintQueued || !sceneApi?.isOpen) return;
    repaintQueued = true;
    setTimeout(() => { repaintQueued = false; if (sceneApi?.isOpen) paintScene(); }, 300);
  };
  bus.on('entity', repaint);
  bus.on('comp', repaint);
  bus.on('mount', repaint);
  bus.on('selection', followSelection);
}
