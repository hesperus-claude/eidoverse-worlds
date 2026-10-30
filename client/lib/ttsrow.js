// ttsrow — the text-to-speech section, as a LIST of voices you have.
//
// A <select> is for choosing among options someone else fixed; voices are ones
// the user adds and removes, so the list is visible and each verb lives on its
// row (ttslist.js).
//
// BYOV: a model file from your disk, or a speech server you run. Both transmit;
// nothing here is local-only.
import { renderVoiceList } from './ttslist.js';
import { why } from './debuglog.js';
import { ttsAvailable, ttsVoiceName, isTtsEnabled, setTtsEnabled, setTtsSource } from './tts.js';
import { setEndpointVoice } from './browservoice.js';
import { report, bus } from './base.js';
import { micOn } from './micstate.js';
// The id of whatever is currently installed, so the list can show a filled dot
// against it. Null when nothing is loaded — which is a real state, not an error.
let _selected = null;
/** Transient "you need a voice first" prompt, shown only after the user tries
 *  to tick the box with nothing loaded, and cleared the moment they act on it. */
let _needVoice = false, _needVoiceTimer = 0;
/** Ticking TTS never touches the mic. MIC BEATS TTS is a PRIORITY, not a
 *  toggle: both settings stand and a live mic wins while it is on; TTS armed
 *  with the mic live speaks the moment the mic goes off. */
let _busy = null;          // a phase string while loading, else null
/** A voice being imported RIGHT NOW: shown in the list as a loading row with a
 *  running timer, so a slow prepare (~27s on first use) reads as work. */
let _loadingId = null, _loadingName = null, _loadingSince = 0;
// The tick's own await window: onchange awaits collectVoices() BEFORE pick()
// sets _loadingId, and a repaint in that gap read "not loading, not enabled"
// and blanked the freshly-clicked box. Set at the tick, cleared when the load
// path owns the state (or on any early exit).
let _tickPending = false;
/** THE USER'S LAST WORD ON "should this speak?", written ONLY by the checkbox
 *  change handler. Not the box's checked state: that is a DERIVED display every
 *  sync recomputes (isTtsEnabled()||loading), so it cannot carry an untick made
 *  mid-load. A plain boolean that no repaint recomputes. */
let _wantSpeech = false;
/** ONE LOAD AT A TIME: a compile takes 30s+, and a second click would start a
 *  second compile racing the first. A click during a load is a no-op. */
let _inFlight = null;
// A pick that is missing its other half — kept so it can be resumed rather than
// discarded. See addFile().
let _pending = null;
/** Everything we know how to speak with: remembered files + this session's
 *  endpoints. Kept here rather than in the list so the list stays a renderer. */
async function collectVoices() {
  const out = [];
  try {
    const { listVoices, voiceReadable, canRemember } = await import('./voicestore.js');
    if (canRemember()) {
      for (const v of await listVoices()) {
        const state = await voiceReadable(v);
        if (state === 'denied' || state === 'gone') continue;
        out.push({
          id: v.id,
          name: v.name,
          dim: state !== 'granted',
          note: state === 'granted'
            ? `${v.name} — a model on this computer`
            : `${v.name} — remembered, but this browser must ask before reading it again`,
        });
      }
    }
  } catch (e) { console.warn('[voice] could not list remembered voices:', e); }
  for (const ep of endpoints()) {
    out.push({ id: `ep:${ep}`, name: ep, note: `speech server at ${ep}` });
  }
  // The half-finished pick, if there is one — first, because it is the thing
  // asking for attention.
  if (_pending) {
    out.unshift({
      id: '__pending',
      // AN INSTRUCTION, NOT A DIAGNOSIS: "select the .onnx.json" names the next action.
      name: `select the ${_pending.want} for ${_pending.have}`,
      dim: true,
      note: `you picked ${_pending.have}; a Piper voice also needs its ${_pending.want}. Click to choose it.`,
    });
  }
  return out;
}
// Endpoints live in localStorage as a list, not a single value: "the one
// endpoint" was a field you had to retype every time you wanted the other one.
const EP_KEY = 'eido.ttsEndpoints';
const endpoints = () => {
  try { return JSON.parse(localStorage.getItem(EP_KEY) || '[]'); } catch { return []; }
};
const saveEndpoints = (list) => {
  try { localStorage.setItem(EP_KEY, JSON.stringify(list.slice(0, 12))); } catch { /* private mode */ }
};
/** Build (and rebuild) the section. `host` is the row container; `onPaint` lets
 *  the panel repaint sibling rows whose state we just changed. */
export function ttsSection(host, onPaint = () => {}) {
  const repaint = () => { build(); onPaint(); };
    /** EVERY LOAD GOES THROUGH HERE (the checkbox path too), so the busy guard
     *  and the loading row live here: one entry point, one guard, one row. */
    async function pick(id) {
      if (id === '__pending') return resumePending();
      if (id === _selected && ttsAvailable()) return true;   // already live — the ask IS satisfied
      if (_inFlight) {
        // A click during a compile is a no-op. Return false, not undefined: the
        // tick handler undoes its enable on `ok === false`.
        console.log(`[voice] already loading ${_inFlight}; ignoring ${id}`);
        return false;
      }
      _inFlight = id;
      // The loading row + clock, for EVERY path into a load.
      _loadingId = id;
      // SHOW THE VOICE'S NAME, NOT ITS ID: stored voices are keyed by content
      // digest (voicestore.js), so ask the list for the human name. The stripped
      // id is the fallback for a voice mid-import, not yet listed.
      _loadingName = id.replace(/^file:/, '').replace(/^ep:/, '');
      void collectVoices().then((vs) => {
        const hit = vs.find((v) => v.id === id);
        if (hit?.name && _loadingId === id) { _loadingName = hit.name; build(); }
      }).catch(() => { /* keep the fallback */ });
      _loadingSince = Date.now();
      build();
      try {
        return await pickInner(id);
      } finally {
        _inFlight = null; _loadingId = null; _busy = null;
        repaint();
      }
    }
    async function pickInner(id) {
    // Captured BEFORE anything below clears it: "was the user already asking to
    // speak, and only missing a voice?" TTS already being on counts too — then
    // this is a SWITCH between voices and must stay on, not silently mute.
    const wantedSpeech = _needVoice || isTtsEnabled();
    try {
      if (id.startsWith('ep:')) {
        await setEndpointVoice(id.slice(3));
      } else {
        const { listVoices, openVoice } = await import('./voicestore.js');
        const entry = (await listVoices()).find((v) => v.id === id);
        if (!entry) throw new Error('that voice is no longer remembered');
        // allowPrompt: this runs from a click, which is the only context in
        // which requestPermission() may ask.
        const files = await openVoice(entry, { allowPrompt: true });
        const { loadFromFiles } = await import('./voiceengines.js');
        await import('./engines.js');
        await loadFromFiles(files, (p) => {
        _busy = p.text || p.phase || 'loading…';
        if (!liveStatus(_busy)) build();
      });
      }
      _selected = id;
    // Remember it so ticking the box later picks what they used last.
    try { localStorage.setItem('eido.tts.lastVoice', id); } catch { /* private mode */ }
    _needVoice = false;   // they acted on the prompt; it has served its purpose
      // CHOOSING IS NOT ENABLING: the tick decides WHETHER, the list decides
      // WHICH. Selecting enables only when the user was already asking to speak
      // and lacked a voice (the _needVoice prompt).
      if (wantedSpeech) setTtsEnabled(true);
    } catch (e) {
      report('tts voice', e);
      _busy = String(e?.message || e).slice(0, 80);
      build();
      setTimeout(() => { _busy = null; repaint(); }, 2500);
      // FALSE, loudly: this catch absorbs every load failure, so failure is a
      // return value the callers that must untick can see.
      return false;
    }
    _busy = null;
    repaint();
    return true;
  }
  async function remove(id) {
    if (id === '__pending') { _pending = null; repaint(); return; }
    if (id.startsWith('ep:')) {
      saveEndpoints(endpoints().filter((e) => e !== id.slice(3)));
    } else {
      const { forgetVoice } = await import('./voicestore.js');
      await forgetVoice(id);
    }
    // Removing what is currently speaking also stops it — leaving a live voice
    // whose entry is gone would be state the UI cannot show.
    if (id === _selected) { setTtsSource(null); setTtsEnabled(false); _selected = null; }
    repaint();
  }
  /** Finish an import once both halves are in hand. Shared by addFile() and
   *  resumePending() so a resumed import behaves exactly like a first try. */
  async function finishImport(handles, files) {
    const { loadFromFiles } = await import('./voiceengines.js');
    await import('./engines.js');
    const shown = (files.find((f) => /\.onnx$/i.test(f.name)) || files[0])?.name || 'voice';
    const name = shown.replace(/\.onnx$/i, '');
      // _busy MUST BE CLEARED ON EVERY EXIT (try/finally): the add button greys
      // itself while busy (ttslist.js), so a throw would leave it grey forever.
      _busy = `loading ${name}…`;
      // Show the model in the list IMMEDIATELY, loading, so a slow prepare (the
      // ~27s first-use phonemizer build) reads as work, not as nothing happening.
      _loadingId = `file:${name}`; _loadingName = name; _loadingSince = Date.now();
      build();
      try {
        await loadFromFiles(files, (p) => {
        _busy = p.text || p.phase || `loading ${name}…`;
        // UPDATE TEXT, DO NOT REBUILD every row once a second: write into the
        // existing nodes; fall back to a rebuild only if they are not there yet.
        if (!liveStatus(_busy)) build();
      });
        // identity is the BYTES: a name-keyed id would let a same-named different
        // model become the same voice; the digest id travels with the memory.
        const onnxF = files.find((f) => /\.onnx$/i.test(f.name));
        const cfgF = files.find((f) => /\.onnx\.json$/i.test(f.name)) || files.find((f) => /\.json$/i.test(f.name));
        const identity = (onnxF && cfgF)
          ? await (await import('./voicestore.js')).voiceIdentity(onnxF, cfgF)
          : null;
        const id = identity?.id ?? `file:${name}`;   // digest when we have bytes; picker edge cases keep working
        try {
          const { rememberVoice, canRemember } = await import('./voicestore.js');
          if (canRemember()) await rememberVoice(id, name, handles, identity);
        } catch (e) { console.warn('[voice] not remembered:', e); }
        _pending = null;
        _selected = id;
        setTtsEnabled(true);
      } catch (e) {
        report('tts voice', e);
        _busy = String(e?.message || e).slice(0, 80);
        build();
        setTimeout(() => { _busy = null; _loadingId = null; repaint(); }, 3000);
        return;
      } finally {
        _loadingId = null;
      }
      _busy = null;
    repaint();
  }
  /** Ask again for the missing half of a partial pick. */
  async function resumePending() {
    if (!_pending || !window.showOpenFilePicker) return;
    const { have, want } = _pending;
    try {
      const more = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: `Matching ${want} for ${have}`,
                  accept: want === '.onnx' ? { 'application/octet-stream': ['.onnx'] }
                                           : { 'application/json': ['.json'] } }],
      });
      if (!more?.length) return;                       // dismissed again: row stays
      const handles = [..._pending.handles, ...more];
      const files = [..._pending.files, ...await Promise.all(more.map((h) => h.getFile()))];
      const { matchEngine } = await import('./voiceengines.js');
      await import('./engines.js');
      if (!matchEngine(files)) {
        // Still not a pair — keep the row rather than dropping back to nothing.
        _pending = { ..._pending, handles, files };
        _busy = `that was not a ${want} — try again`;
        build();
        return;
      }
      await finishImport(handles, files);
    } catch (e) {
      if (e?.name === 'AbortError') return;            // dismissed: row stays, silently
      report('resume voice import', e);
    }
  }
  /** Look for the other half of a piper pair in the folder the user points at.
   *
   *  Piper names them `X.onnx` and `X.onnx.json`, so the sibling of `a.onnx` is
   *  `a.onnx.json` and the sibling of `a.onnx.json` is `a.onnx` — NOT a naive
   *  "strip the extension", which would turn `a.onnx.json` into `a.onnx` only
   *  by luck and `a.json` into `a` wrongly.
   *
   *  Returns {handle, file} or null. Never throws at the caller: a declined
   *  directory prompt is an ordinary outcome, not an error.
   */
  async function pairFromDirectory(have, want) {
    if (!window.showDirectoryPicker) return null;
    const base = /\.onnx$/i.test(have) ? have : have.replace(/\.json$/i, '');
    const target = want === '.onnx.json' ? `${base}.json` : base;
    // Say what granting the folder BUYS, not just what it wants. This is the
    // second ask in a row; "pick the folder" with no reason reads as the app
    // being fussy rather than as a shortcut being offered.
    _busy = `optional: pick the folder holding ${have} and I'll find ${target} myself`;
    build();
    let dir;
    try {
      dir = await window.showDirectoryPicker({ mode: 'read', id: 'piper-voices' });
    } catch { return null; }          // declined, or unsupported: fall back to asking
    // getFileHandle throws NotFoundError when the name is absent — which is the
    // ordinary "they picked the wrong folder" case, not a failure worth
    // reporting. Confirm the ORIGINAL is here too, so we cannot pair a model
    // with a config belonging to a different copy of the same filename.
    try {
      const mate = await dir.getFileHandle(target);
      await dir.getFileHandle(have);   // throws if this is not that folder
      return { handle: mate, file: await mate.getFile() };
    } catch { return null; }
  }

  async function addFile() {
    try {
      const { loadFromFiles, matchEngine } = await import('./voiceengines.js');
      await import('./engines.js');
      if (!window.showOpenFilePicker) {
        _busy = 'this browser cannot pick files here — use a speech server';
        build(); setTimeout(() => { _busy = null; repaint(); }, 3000);
        return;
      }
      let handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: 'Piper voice (.onnx + .onnx.json)',
                  accept: { 'application/octet-stream': ['.onnx'], 'application/json': ['.json'] } }],
      });
      let files = await Promise.all(handles.map((h) => h.getFile()));
      // A lone .onnx is the common near-miss. Ask for the rest, NAMING what is
      // missing — an unlabelled second dialog reads as a bug.
      if (!matchEngine(files) || files.length === 1) {
        const have = files[0]?.name || 'a file';
        const want = /\.onnx$/i.test(have) ? '.onnx.json' : '.onnx';

        // ASK FOR THE FILE FIRST, NAMING IT. A file handle is sibling-blind by
        // design (no .getParent()), so the folder is the only lawful route to the
        // file next door; that shortcut is offered only if this pick is declined.
        _busy = `${have} selected — now pick the matching ${want}`;
        build();
        let more = await window.showOpenFilePicker({
          multiple: true,
          types: [{ description: `Matching ${want} for ${have}`,
                    accept: want === '.onnx' ? { 'application/octet-stream': ['.onnx'] }
                                             : { 'application/json': ['.json'] } }],
        }).catch(() => null);

        // Declined the file pick? THEN offer the folder (it saves this step next
        // time). Declining both lands on the half-finished row below.
        if (!more?.length) {
          const paired = await pairFromDirectory(have, want).catch(() => null);
          if (paired) {
            handles = [...handles, paired.handle];
            files = [...files, paired.file];
            _busy = `found ${paired.file.name} beside it`;
            build();
            await finishImport(handles, files);
            return;
          }
        }
        if (more?.length) {
          handles = [...handles, ...more];
          files = [...files, ...await Promise.all(more.map((h) => h.getFile()))];
        } else {
          // A HALF-FINISHED IMPORT BECOMES A ROW, not an expiring message: the
          // partial pick is kept and listed; click it to be asked for the rest.
          _pending = { handles, files, have, want };
          _busy = null;
          repaint();
          return;
        }
      }
      await finishImport(handles, files);
    } catch (e) {
      // An aborted picker is a choice, not an error.
      if (e?.name === 'AbortError') { _busy = null; build(); return; }
      report('add voice file', e);
      _busy = String(e?.message || e).slice(0, 80);
      build(); setTimeout(() => { _busy = null; repaint(); }, 3000);
    }
  }
  function addEndpoint() {
    const addr = prompt('Address of a speech server you are running:\n(ws://… or http://…)', 'ws://127.0.0.1:8927');
    if (!addr) return;
    const list = endpoints();
    if (!list.includes(addr)) { list.unshift(addr); saveEndpoints(list); }
    pick(`ep:${addr}`);
  }
    /** Write the current status into nodes that already exist, returning false if
     *  they are not built yet so the caller can fall back to a full build. */
    function liveStatus(text) {
      // Only the loading ROW carries progress now; the header note is about
      // which voice is live, and echoing progress there was the double message.
      const row = host.querySelector('.vl-loading .vl-note');
      if (!row) return false;
      row.textContent = text || '';
      return true;
    }

    /** THE TICK CHANGES TWO THINGS, SO WRITE TWO THINGS (the label's opacity and
     *  the note's text) instead of rebuilding the section. Returns false if the
     *  nodes are not there yet, so callers keep their build() fallback. */
    function syncHead() {
      const label = host.querySelector('.row.wide .nm');
      const note = host.querySelector('.row.wide .note');
      const box = host.querySelector('.row.wide input[type=checkbox]');
      if (!label || !note || !box) return false;
      const live = ttsAvailable() && isTtsEnabled();
      label.style.opacity = headDimmed() ? '.45' : '1';
      // A LOADING VOICE IS A TICKED BOX, FADED: the intent registers on the click
      // (pick() only enables at the END), and the fade says "working on it".
      const loadingNow = (!!_loadingId || _tickPending) && (_wantSpeech || !_tickPending);
      box.checked = isTtsEnabled() || loadingNow;
      box.style.opacity = loadingNow && !isTtsEnabled() ? '.45' : '';
      note.textContent = headNote();
      return true;
    }
  /** THE PANEL MUST NOT TEAR DOWN ON A STATE CHANGE, whoever calls: if the
   *  section is already built, build() UPDATES the existing nodes and returns,
   *  so nothing loses focus, scroll or an in-flight interaction. A full
   *  construction happens once, and after any deliberate teardown. syncHead()
   *  and liveStatus() stay as the cheaper hot path. */
  /** Update every node build() renders, without destroying any of them. It MUST
   *  COVER EVERYTHING build() PAINTS (label dimming, checkbox, status note, voice
   *  list), or a state change silently stops reaching the screen. Returns false
   *  if the expected nodes are missing, so the caller falls back to a real build. */

/** MIC LIVE MEANS TTS IS UNAVAILABLE, AND THE PANEL SAYS SO. A live mic wins
 *  outright (one publishing source) and tts.js discards typed says meanwhile.
 *  Nothing is turned OFF: isTtsEnabled() stays true, so mic-off drops straight
 *  back to speaking. Only the DISPLAY yields. The one source of this status line. */
function micIsPublishing() {
  // one answer to "is my mic on": the SFU's own read (window.__sfuMicOn, voicesfubridge.js), else micstate's
  try {
    if (typeof window.__sfuMicOn === 'function') return !!window.__sfuMicOn();
  } catch { /* no window */ }
  return micOn();
}

function headNote() {
  if (_busy) return _busy;
  if (_loadingId) return `loading ${_loadingName || 'voice'}…`;
  if (micIsPublishing()) return 'not available while your mic is on';
  if (_needVoice) return 'add a voice with one of the options below';
  const live = ttsAvailable() && isTtsEnabled();
  return live ? ttsVoiceName() : ttsAvailable() ? 'ready' : '';
}

/** Dimmed when TTS cannot actually speak — either off, or outranked by a live
 *  mic. The label and the list both read this, so "greyed out" is one answer. */
function headDimmed() {
  return !(ttsAvailable() && isTtsEnabled()) || micIsPublishing();
}

  function syncInPlace() {
    const label = host.querySelector('.nm');
    const box = host.querySelector('input[type=checkbox]');
    const note = host.querySelector('.note');
    const listHost = host.querySelector('.tts-list');
    // NAME THE MISSING NODE: a guard that can decline for several reasons says which.
    if (!label || !box || !note || !listHost) {
      const missing = [!label && '.nm', !box && 'checkbox', !note && '.note',
                       !listHost && '.tts-list'].filter(Boolean).join(', ');
      why('tts-section', `sync refused: missing ${missing}`);
      return false;
    }

    const live = ttsAvailable() && isTtsEnabled();
    label.style.opacity = headDimmed() ? '.45' : '1';
    // Never fight the user's own click: if the box already shows what state
    // says, leave the node alone. wantChecked must match syncHead()'s rule
    // (ticked-but-faded while loading), or the two writers disagree mid-load.
    const wantChecked = isTtsEnabled() || ((!!_loadingId || _tickPending) && (_wantSpeech || !_tickPending));
    if (box.checked !== wantChecked) box.checked = wantChecked;
    box.style.opacity = wantChecked && !isTtsEnabled() ? '.45' : '';
    note.textContent = headNote();

    // The list owns its own in-place update (ttslist.js renders per-element),
    // so re-rendering it here is not a teardown of the rows.
    collectVoices().then((items) => {
      if (!_selected && items.length) {
        const last = (() => { try { return localStorage.getItem('eido.tts.lastVoice'); } catch { return null; } })();
        const real = items.filter((i) => i.id !== '__pending');
        if (real.length) _selected = (last && real.some((i) => i.id === last)) ? last : real[0].id;
      }
      renderVoiceList(listHost, {
        items, selected: _selected, busy: _busy,
        loading: _loadingId ? { id: _loadingId, name: _loadingName, since: _loadingSince, status: _busy } : null,
        on: {
          select: (id) => {
            if (id === '__pending') return pick(id);
            if (isTtsEnabled()) return pick(id);
            _selected = id;
            try { localStorage.setItem('eido.tts.lastVoice', id); } catch { /* private mode */ }
            build();
          },
          remove, addFile, addEndpoint,
        },
      });
    });
    return true;
  }

  function build() {
    // REPORT WHICH LAYER REBUILT: this section path and syncSelection() for the
    // list inside it are two nested in-place paths; each says what it did.
    if (host.firstChild) {
      if (syncInPlace()) { why('tts-section', 'in place'); return; }
      why('tts-section', 'REBUILT (syncInPlace refused)');
    } else {
      why('tts-section', 'first paint');
    }
    host.textContent = '';
    const head = document.createElement('div');
    head.className = 'row wide';
    const live = ttsAvailable() && isTtsEnabled();
    // Same two columns as every other row: label, then control. The status note
    // rides in the control column beside the tick rather than starting a third
    // ragged column of its own.
    head.innerHTML =
      // "text-to-speech MODEL": distinct from the "text-to-speech volume" slider.
      `<label class="nm" style="opacity:${headDimmed() ? '.45' : '1'}">text-to-speech model</label>` +
      `<span class="ctl">` +
      `<input type="checkbox" ${isTtsEnabled() || ((_loadingId || _tickPending) && (_wantSpeech || !_tickPending)) ? 'checked' : ''} `
        + `${(_loadingId || _tickPending) && (_wantSpeech || !_tickPending) && !isTtsEnabled() ? 'style="opacity:.45" ' : ''}` +
        // NOT `disabled` when there is no voice: a disabled checkbox fires no change
        // event, and the handler must run to untick it and name what is missing.
      `title="speak with the voice marked below">` +
      `<span class="note">` +
      // THE NOTE SAYS ONE THING: what is loading, or what is loaded (the rows
      // below are what to do next); empty when there is nothing to report.
      // _loadingId is set on EVERY path into a load, so the note never says
      // "ready" before the engine's first phase text arrives.
      `${headNote()}</span>` +
      `</span>`;
    head.querySelector('input').onchange = async (e) => {
      // Untick: nothing structural changes — no row appears or vanishes — so
      // write the two affected nodes instead of rebuilding the section.
      _wantSpeech = e.target.checked;
      if (!e.target.checked) {
        // An untick outranks a tick still in flight, and a re-tick outranks the
        // untick: the LAST click wins. The load's completion consults _wantSpeech.
        _needVoice = false; setTtsEnabled(false);
        if (!syncHead()) repaint(); else onPaint();
        return;
      }
      // A tick while a tick-initiated load is already running: the box stays
      // checked, and the running load's completion will honour it. Calling
      // pick() again would only hit the busy path and untick a box the user
      // just ticked.
      if (_tickPending) return;
      // TICKING THE BOX MEANS "SPEAK", so make that true if it can be. Three cases:
      //   no voices  → refuse, and SAY why (transient, clears when they add one)
      //   one voice  → use it; asking which of one is busywork
      //   several    → last used, else the first
      // Tick with a voice already loaded: same two nodes, same reasoning.
      if (ttsAvailable()) {
        _needVoice = false; setTtsEnabled(true);
        if (!syncHead()) repaint(); else onPaint();
        return;
      }
      _tickPending = true;
      const items = await collectVoices();
      if (!_wantSpeech) { _tickPending = false; return; }      // unticked while listing
      if (!items.length) {
        _tickPending = false;
        e.target.checked = false;          // the tick did not take; do not lie about it
        _needVoice = true;
        // Clear itself after 5s: it answers ONE click. clearTimeout first so
        // repeated clicks restart the window instead of stacking timers.
        clearTimeout(_needVoiceTimer);
        _needVoiceTimer = setTimeout(() => { _needVoice = false; build(); }, 5000);
        // build() only, NOT repaint(): this changes nothing outside this row, and
        // repaint() calls the panel's paint(), which rebuilds every row.
        build();
        return;
      }
      _needVoice = false;
      // THE VISIBLE SELECTION WINS: the tick loads the voice the radio shows.
      // Order: selected now → last used → the first row.
      const last = (() => { try { return localStorage.getItem('eido.tts.lastVoice'); } catch { return null; } })();
      const marked = _selected && items.some((i) => i.id === _selected) ? _selected : null;
      const pickId = marked ?? ((last && items.some((i) => i.id === last)) ? last : items[0].id);
        // If loading fails the box must not stay ticked over a voice that never arrived.
        try {
          const ok = await pick(pickId);      // loads and sets the source
          // pick reports failure (and its busy-ignore path) as `false`, not a
          // throw; its catch owns the error UI. Only the tick needs undoing here.
          if (ok === false) { e.target.checked = false; return; }
          // _wantSpeech at load-completion is the user's LAST action —
          // unticked mid-load means no enable; unticked-then-re-ticked means
          // enable. Deliberately NOT the checkbox: the box is re-derived by
          // every sync during the load window and cannot carry the no.
          if (!_wantSpeech) return;
          // ENABLE HERE, NOT IN pickInner: this path clears _needVoice before
          // calling it, so pickInner's own wantedSpeech is false. The tick decides
          // WHETHER, so the tick's handler owns the enable once its load succeeds.
          setTtsEnabled(true);
        } catch (err) {
          e.target.checked = false;
          _needVoice = true;
        // Clear itself after 5s: it answers ONE click. clearTimeout first so
        // repeated clicks restart the window instead of stacking timers.
        clearTimeout(_needVoiceTimer);
        _needVoiceTimer = setTimeout(() => { _needVoice = false; build(); }, 5000);
          console.warn('[voice] could not load the saved voice:', err);
        } finally {
          // EVERY exit: success, refusal, throw (or the box stays faded forever).
          _tickPending = false;
        }
        repaint();
    };
    host.appendChild(head);
    const listHost = document.createElement('div');
    listHost.className = 'tts-list';   // findable by syncInPlace
    // Indent to the CONTROL column so the voices hang under the checkbox that
    // switches them on rather than floating mid-panel.
    //
    // DERIVED, NOT HARDCODED: the grid owns the gutter; read it from the grid.
    const col = getComputedStyle(host.closest('.row.wide')?.parentElement ?? host)
      .getPropertyValue('--row-label-col') || '8.5rem';
    listHost.style.cssText = `margin:2px 0 8px calc(${col} + 10px)`;
    host.appendChild(listHost);
    collectVoices().then((items) => {
      // SOMETHING IS ALWAYS MARKED, in the order the tick uses (last used, else the
      // first row), so the dot PREDICTS what ticking will do. Display only: no
      // load, no permission prompt, nothing enabled.
      if (!_selected && items.length) {
        const last = (() => { try { return localStorage.getItem('eido.tts.lastVoice'); } catch { return null; } })();
        const real = items.filter((i) => i.id !== '__pending');
        if (real.length) _selected = (last && real.some((i) => i.id === last)) ? last : real[0].id;
      }
      renderVoiceList(listHost, {
        items, selected: _selected, busy: _busy,
        // The in-flight import, shown as a loading row with a running clock.
        loading: _loadingId ? { id: _loadingId, name: _loadingName, since: _loadingSince, status: _busy } : null,
        // MARKING IS NOT LOADING: while TTS is off the radio only marks (a load
        // pulls a ~63MB graph); the tick loads the marked voice. With TTS on it is
        // a live switch between voices and loads immediately.
        on: {
          select: (id) => {
            if (id === '__pending') return pick(id);   // resuming IS the ask
            if (isTtsEnabled()) return pick(id);       // live switch: load now
            _selected = id;
            try { localStorage.setItem('eido.tts.lastVoice', id); } catch { /* private mode */ }
            build();
          },
          remove, addFile, addEndpoint,
        },
      });
    });
  }
  build();
  // REPAINT WHEN THE MIC CHANGES, or the greying is one toggle stale. audio:mic
  // is emitted by both the panel's checkbox and the HUD glyph (mictoggle), so
  // one subscription covers every way the mic goes on or off. build() updates
  // in place, so this is cheap.
  bus.on('audio:mic', () => build());
  return host;
}