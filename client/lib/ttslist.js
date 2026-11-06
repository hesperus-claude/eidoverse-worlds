// ttslist — THE VOICES YOU HAVE, AS A LIST.
//
// Named ttslist, not voice*: every voice*.js here is the WebRTC voice TRANSPORT;
// this is text-to-speech. The list holds two kinds of voice source (a local .onnx
// model, a remote speech-server endpoint); ttsrow.js is its pair.
//
// A visible list, not a dropdown: the options are ones the user adds and removes,
// so "what do I have?" and "get rid of that one" must be answerable unopened. The
// × lives ON its row, so its target is never ambiguous; the add-verbs sit
// visibly separate at the bottom, never mixed in among the voices (nouns).
import { why } from './debuglog.js';

const ROW = `
.vl { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
/* The voices SCROLL, the add-rows do not (live, 2026-08-09: "should the model list
   get its own little scrolling window pane, just in case people add a lot?").
   max-height rather than a fixed one, so one voice does not sit in an empty box
   — it grows to about four rows and only then scrolls. */
.vl-pane { display: flex; flex-direction: column; gap: 2px; max-height: 88px;
  overflow-y: auto; overscroll-behavior: contain; }
.vl-row { display: flex; align-items: center; gap: 6px; padding: 2px 4px;
  border-radius: 3px; cursor: pointer; }
/* --accent-dk is what the house uses for "this row is active/hovered"
   (index.html: .card.on). #2a2a2a was a neutral grey borrowed from nowhere —
   it read as a different application's hover. */
.vl-row:hover { background: var(--accent-dk); }
.vl-row .vl-x { opacity: 0; margin-left: auto; padding: 0 4px; border: 0;
  background: none; color: inherit; cursor: pointer; font-size: 13px; line-height: 1; }
/* The × appears on hover OR on keyboard focus — hover-only affordances are
   invisible to anyone navigating by keyboard, and this one is destructive, so
   it must be reachable without a mouse. */
.vl-row:hover .vl-x, .vl-row .vl-x:focus { opacity: .75; }
.vl-row .vl-x:hover { opacity: 1; color: var(--err); }
.vl-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vl-note { margin-left: auto; font-size: 11px; font-variant-numeric: tabular-nums; }
.vl-loading { opacity: .85; }
.vl-add { opacity: .6; }
.vl-add:hover { opacity: 1; }
/* 🔴 VOICES ARE NOUNS, ADD-ROWS ARE VERBS — do not sit them at one indent
   (live, 2026-08-09: "can you indent or un-indent the model selections vs the add
   buttons to distinguish them more?"). The voice rows carry a ●/○ marker and the
   add rows do not, so they were ALREADY ragged by a glyph width — this makes
   that deliberate instead of accidental. Voices hang under the marker column;
   the verbs sit flush left, below the list they act on, with a hairline to close
   the group. */
.vl-radio { width: 12px; height: 12px; border-radius: 50%; flex: 0 0 12px;
  border: 1.5px solid currentColor; opacity: .45; box-sizing: border-box;
  transition: opacity .12s, box-shadow .12s; }
.vl-radio.on { opacity: 1; box-shadow: inset 0 0 0 2.5px currentColor; }
.vl-row:hover .vl-radio { opacity: .85; }
/* 🔴 THE GAP UNDER THE HAIRLINE WAS DOUBLE-COUNTED (live, 2026-08-16: "the row
   spacing between the graphic line above and the button below being a bit
   odd"). .vl-verbs-start contributes padding-top:6px AND .vl-add contributed
   margin-top:4px, so the first verb sat 10px below the rule while every other
   row sat 2px apart — one gap built by two rules that did not know about each
   other. The separator owns the space above the group; the row owns none. */
/* 🔴 AND THE BUTTON'S OWN PADDING WAS LOPSIDED. .vl-row gives every row
   2px 4px, but a voice row spends its left edge on the marker glyph
   (12px + 6px gap) while an add-row starts at its own glyph — so identical
   padding read as tight on the left and loose on the right, which is the
   "weirdly spaced within that button" R saw. One declaration, symmetric, and
   the noun/verb distinction is carried by the indent rule below rather than by
   padding doing two jobs.
   Written as ONE rule deliberately: a second .vl-add padding-left would be
   silently overridden by this shorthand — dead CSS that reads as intentional
   forever. */
.vl-add { padding: 3px 6px; }
.vl-row:not(.vl-add) { padding-left: 2px; }
/* 🔴 THE SEPARATOR'S SPACE IS ABOVE IT, NOT INSIDE THE FIRST VERB (live,
   2026-08-16: "can you scootch the + add a speech server button closer to the
   + add a text-to-speech model button? That spacing looks odd").
   padding-top on this row put 6px INSIDE the first button, between its border
   and its own text — so the model row rendered 6px taller than the endpoint
   row below it and the pair read as unevenly spaced, even though the gap
   between them was the container's ordinary 2px. The two verbs are siblings
   and must be the same height; the space belongs entirely to the margin above
   the rule, which is the separator's own business.
   This is the same double-counting as the note above, one level in: a gap
   built by two rules, where only one of them should own it. */
.vl-verbs-start { border-top: 1px solid var(--edge); margin-top: 8px; }
.vl-dim { color: var(--dim); font-style: italic; }
`;
function ensureCss() {
  if (document.getElementById('vl-css')) return;
  const st = document.createElement('style');
  st.id = 'vl-css';
  st.textContent = ROW;
  document.head.appendChild(st);
}

/** Update selection + status on an already-rendered list. Returns false when
 *  the DOM does not match these items (any difference in membership or order),
 *  so the caller rebuilds for real: a wrong in-place update is worse than a
 *  rebuild. */
function syncSelection(host, { items, selected, busy, loading }) {
  const rows = host.querySelectorAll?.('.vl-row[data-id]');
  // SAY WHY IT REFUSED: each guard names itself on the debuglog 'tts-list'
  // topic (readable from /audio and __why('tts-list')).
  const no = (reason) => { why('tts-list', `rebuilt: ${reason}`); return false; };
  // An EMPTY list is a legitimate steady state, not a failure: no data-id rows,
  // only the two add-verbs.
  if (!rows.length && !items.length) {
    // Nothing to select; only the status text can have changed.
    if (loading) {
      const note = host.querySelector('.vl-loading .vl-note');
      if (note) note.textContent = busy || loading.status || 'loading…';
    }
    why('tts-list', 'in place (empty list)');
    return !!host.querySelector('.vl-pane');   // false on first paint
  }
  if (!rows || !rows.length) return no(`no data-id rows, but ${items.length} item(s) expected`);
  const want = items.map((i) => i.id);
  if (rows.length !== want.length) return no(`row count ${rows.length} != items ${want.length}`);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].dataset.id !== want[i]) return no(`row ${i} is ${rows[i].dataset.id}, wanted ${want[i]}`);
  }
  // A loading row appearing or clearing IS structural — it adds/removes a node.
  const hasLoadingRow = !!host.querySelector('.vl-loading');
  if (hasLoadingRow !== !!loading) return no(`loading row ${hasLoadingRow} vs ${!!loading}`);

  for (const row of rows) {
    const on_ = row.dataset.id === selected;
    // The mark is a span styled `.vl-radio.on`, NOT an <input type=radio>.
    const mark = row.querySelector('.vl-radio');
    if (!mark) return no('a row has no .vl-radio');
    mark.classList.toggle('on', on_);
    mark.setAttribute('aria-checked', on_ ? 'true' : 'false');
  }
  why('tts-list', 'in place');
  if (loading) {
    const note = host.querySelector('.vl-loading .vl-note');
    if (note) note.textContent = busy || loading.status || 'loading…';
  }
  return true;
}

/** Build the list.
 *  items:    [{id, name, note}]   — the voices this person has
 *  selected: id | null
 *  on:       {select(id), remove(id), addFile(), addEndpoint()}
 */
export function renderVoiceList(host, { items, selected, on, busy, loading }) {
  ensureCss();
  // ADD, DO NOT OVERWRITE the host's class: ttsrow marks it `.tts-list` so its
  // in-place updater can find it again. A component styling a host it does not
  // own contributes a class.
  host.classList.add('vl');
  // A SELECTION CHANGE MUST NOT REBUILD THE LIST: if the same voices are already
  // rendered, write the selection and loading/busy text and return. Anything
  // structural (a voice added or removed) falls through to a real build.
  if (syncSelection(host, { items, selected, busy, loading })) return;
  host.textContent = '';
  // The scrolling part. Only the voices go in here; the "+ add" rows stay below
  // it, so the thing you click to fix an empty list is never itself scrolled
  // out of view.
  const pane = document.createElement('div');
  pane.className = 'vl-pane';
  host.appendChild(pane);
  // No empty-state row: the "+ add" rows below already say what to do.
  // A voice being imported appears at once WITH A RUNNING CLOCK (the first import
  // can take ~30s, and a counter says how long, which a spinner can't), but only
  // when it has no real row yet; a listed voice shows its status on its own row.
  if (loading && !items.some((it) => it.id === loading.id)) {
    const row = document.createElement('div');
    row.className = 'vl-row vl-loading';
    row.title = 'preparing this voice — the first one also builds the speech engine';
    const mark = document.createElement('span');
    mark.textContent = '◌';
    mark.style.opacity = '.6';
    const name = document.createElement('span');
    name.className = 'vl-name';
    name.textContent = loading.name;
    name.style.opacity = '.7';
    const clock = document.createElement('span');
    clock.className = 'vl-note';
    clock.style.opacity = '.7';
    // ONE COUNTER, NOT TWO: prefer the engine's own progress text (it already
    // carries elapsed seconds and knows its phase); our clock only fills the gap
    // before the first progress event.
    const t0 = loading.since || Date.now();
    const tick = () => {
      if (!clock.isConnected) return clearInterval(timer);
      const s = Math.round((Date.now() - t0) / 1000);
      clock.textContent = loading.status
        ? (/\d+s/.test(loading.status) ? loading.status : `${loading.status} — ${s}s`)
        : `starting — ${s}s`;
    };
    const timer = setInterval(tick, 1000);
    tick();
    row.append(mark, name, clock);
    host.appendChild(row);
  }
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'vl-row';
    // Identity ON the node, so an in-place update can find its row.
    row.dataset.id = it.id;
    row.tabIndex = 0;
    row.title = it.note || it.name;
    const mark = document.createElement('span');
    // a drawn ring with a filled centre (not a ●/○ glyph, which reads as a list
    // bullet): it reads as a control and needs no colour, which matters in VR.
    mark.className = 'vl-radio' + (it.id === selected ? ' on' : '');
    mark.setAttribute('role', 'radio');
    mark.setAttribute('aria-checked', it.id === selected ? 'true' : 'false');
    const name = document.createElement('span');
    name.className = 'vl-name' + (it.dim ? ' vl-dim' : '');
    name.textContent = it.name;
    const x = document.createElement('button');
    x.className = 'vl-x';
    x.textContent = '×';
    // "the file stays on your computer": otherwise × beside a filename reads as delete
    x.title = `forget ${it.name} — the file stays on your computer`;
    x.setAttribute('aria-label', `forget ${it.name}`);
    // NO CONFIRM, NO UNDO, deliberately: removing forgets an IndexedDB handle
    // (the .onnx on disk is never touched), so the worst case is re-picking a file.
    // stopPropagation, or clicking × also selects the row it is destroying.
    x.onclick = (e) => { e.stopPropagation(); on.remove?.(it.id); };
      // a listed voice that is loading shows its status (and clock) on its own row
      if (loading && loading.id === it.id) {
        row.classList.add('vl-loading');
        const st = document.createElement('span');
        st.className = 'vl-note';
        const t0 = loading.since || Date.now();
        const tickRow = () => {
          if (!st.isConnected) return clearInterval(rowTimer);
          const s = Math.round((Date.now() - t0) / 1000);
          st.textContent = loading.status
            ? (/\d+s/.test(loading.status) ? loading.status : `${loading.status} — ${s}s`)
            : `starting — ${s}s`;
        };
        const rowTimer = setInterval(tickRow, 1000);
        tickRow();
        row.append(mark, name, st, x);
      } else {
        row.append(mark, name, x);
      }
    row.onclick = () => on.select?.(it.id);
    row.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); on.select?.(it.id); }
      // Delete/Backspace on a focused row is the list convention everywhere
      // else; without it the × is mouse-only in practice.
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); on.remove?.(it.id); }
    };
    pane.appendChild(row);
  }
  // THE VERBS, visibly below the nouns. When the list is empty these are the
  // whole UI, which is the correct empty state: the only thing you can do is
  // add one, so that is the only thing showing.
  const add = document.createElement('div');
  add.className = 'vl-row vl-add vl-verbs-start';
  add.tabIndex = 0;
  // SAY WHAT THE CONTROL WANTS: "text-to-speech model" can only be a .onnx (a
  // "voice file" could be a .wav); the endpoint row deliberately does NOT share
  // the noun, since a running service is not a file.
  // STATUS LIVES IN EXACTLY ONE PLACE, the header note: a verb row stays the verb.
  add.textContent = '+ add a text-to-speech model…';
  add.title = 'a Piper .onnx model and its matching .onnx.json, from this computer';
  if (busy) { add.style.opacity = '.3'; add.style.pointerEvents = 'none'; }
  else {
    add.onclick = () => on.addFile?.();
    add.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); on.addFile?.(); } };
  }
  host.appendChild(add);
  const ep = document.createElement('div');
  ep.className = 'vl-row vl-add';
  ep.tabIndex = 0;
  ep.textContent = '+ add a speech server…';
  ep.title = 'the address of a text-to-speech server you are already running (ws:// or http://)';
  ep.onclick = () => on.addEndpoint?.();
  ep.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); on.addEndpoint?.(); } };
  host.appendChild(ep);
  return host;
}