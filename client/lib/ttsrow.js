// ttsrow — the TTS section as a list of your voices, with verbs on each row: options the user adds and
// removes want a list, not a <select>. Bring your own voice: a model file or a speech server you run.
// Both transmit; nothing here is local-only.
import { renderVoiceList } from './ttslist.js';
import { why } from './debuglog.js';
import { ttsAvailable, ttsVoiceName, isTtsEnabled, setTtsEnabled, setTtsSource } from './tts.js';
import { setEndpointVoice } from './browservoice.js';
import { report, bus } from './base.js';
import { micOn } from './micstate.js';
// The id of whatever is currently installed, so the list can show a filled dot
// against it. Null when nothing is loaded — which is a real state, not an error.
let _selected = null;
/** Transient "you need a voice first" prompt: shown only after a tick with nothing loaded, cleared when they act. */
let _needVoice = false, _needVoiceTimer = 0;
/** Ticking TTS never touches the mic: mic beats TTS is a priority, not a toggle; TTS-on with the mic live arms it
 *  for when the mic goes off. */
let _busy = null;          // a phase string while loading, else null
/** A voice being imported RIGHT NOW: shown in the list as a ghost row with a
 *  running timer, so a slow prepare (the phonemizer build is ~27s on first use)
 *  reads as work rather than as nothing happening. */
let _loadingId = null, _loadingName = null, _loadingSince = 0;
// set at the tick: onchange awaits collectVoices() before pick() sets _loadingId, and a repaint in that gap
// blanked the freshly-ticked box; cleared when the load path owns the state (or on any early exit)
let _tickPending = false;
/** The user's last word on "should this speak?", written ONLY by the checkbox handler: the box itself is derived
 *  (syncHead/syncInPlace/build recompute it), so it can't hold a mid-load "no". */
let _wantSpeech = false;
/** One load at a time: a click during a load is a no-op (a second 30s+ compile would race the first). */
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
      // an instruction, not a diagnosis: name the next action
      name: `select the ${_pending.want} for ${_pending.have}`,
      dim: true,
      note: `you picked ${_pending.have}; a Piper voice also needs its ${_pending.want}. Click to choose it.`,
    });
  }
  return out;
}
// a list, not one value, so switching endpoints needs no retyping
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
    /** Every load goes through here (the checkbox path included), so the guard and the loading row live here. */
    async function pick(id) {
      if (id === '__pending') return resumePending();
      if (id === _selected && ttsAvailable()) return true;   // already live — the ask IS satisfied
      if (_inFlight) {
        // false, not undefined: the tick handler undoes its enable on ok === false
        console.log(`[voice] already loading ${_inFlight}; ignoring ${id}`);
        return false;
      }
      _inFlight = id;
      // The loading row + clock, for EVERY path into a load.
      _loadingId = id;
      // show the voice's name, not its id: stored voices are keyed by content digest (voicestore.js), so ask the
      // list; the stripped id is the fallback mid-import, when the file:/ep: prefixes apply
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
      // choosing is not enabling: the tick decides whether, the list decides which. Selecting enables TTS only
      // when the user was already asking to speak and lacked a voice (_needVoice), or is switching voices
      if (wantedSpeech) setTtsEnabled(true);
    } catch (e) {
      report('tts voice', e);
      _busy = String(e?.message || e).slice(0, 80);
      build();
      setTimeout(() => { _busy = null; repaint(); }, 2500);
      // failure is a return value: this catch absorbs every load error, so callers that must untick see it
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
  /** Finish an import once both halves are in hand; shared by addFile() and resumePending() so they can't diverge. */
  async function finishImport(handles, files) {
    const { loadFromFiles } = await import('./voiceengines.js');
    await import('./engines.js');
    const shown = (files.find((f) => /\.onnx$/i.test(f.name)) || files[0])?.name || 'voice';
    const name = shown.replace(/\.onnx$/i, '');
      // _busy must clear on every exit: the add button greys while busy (ttslist.js), hence try/finally
      _busy = `loading ${name}…`;
      // list the model immediately as loading, so a ~27s prepare reads as work, not as nothing
      _loadingId = `file:${name}`; _loadingName = name; _loadingSince = Date.now();
      build();
      try {
        await loadFromFiles(files, (p) => {
        _busy = p.text || p.phase || `loading ${name}…`;
        // update text, don't rebuild: build() would remake every row once a second during the load
        if (!liveStatus(_busy)) build();
      });
        // #91 B5: identity is the bytes (content digest), so a same-named different model is a different voice
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
  /** Find the other half of a piper pair (`X.onnx` ↔ `X.onnx.json`) in the folder the user points at.
   *  Returns {handle, file} or null; a declined directory prompt is an ordinary outcome, never a throw. */
  async function pairFromDirectory(have, want) {
    if (!window.showDirectoryPicker) return null;
    const base = /\.onnx$/i.test(have) ? have : have.replace(/\.json$/i, '');
    const target = want === '.onnx.json' ? `${base}.json` : base;
    // say what granting the folder buys: it's the second ask in a row
    _busy = `optional: pick the folder holding ${have} and I'll find ${target} myself`;
    build();
    let dir;
    try {
      dir = await window.showDirectoryPicker({ mode: 'read', id: 'piper-voices' });
    } catch { return null; }          // declined, or unsupported: fall back to asking
    // NotFoundError is the ordinary wrong-folder case; confirm the original is here too, so a model can't pair
    // with another copy's config
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

        // ask for the matching file first; offer the folder shortcut only if that's declined. A FileSystemFileHandle
        // can't reach its siblings, so a folder grant is the only lawful way to the file next door.
        _busy = `${have} selected — now pick the matching ${want}`;
        build();
        let more = await window.showOpenFilePicker({
          multiple: true,
          types: [{ description: `Matching ${want} for ${have}`,
                    accept: want === '.onnx' ? { 'application/octet-stream': ['.onnx'] }
                                             : { 'application/json': ['.json'] } }],
        }).catch(() => null);

        // declined the file pick: offer the folder (optional; declining both lands on the half-finished row)
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
          // a half-finished import becomes a resumable row, not an expiring message: click it to pick the missing half
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
    /** Write status into existing nodes (false if not built yet): a rebuild every second resets mid-interaction. */
    function liveStatus(text) {
      // Only the loading ROW carries progress now; the header note is about
      // which voice is live, and echoing progress there was the double message.
      const row = host.querySelector('.vl-loading .vl-note');
      if (!row) return false;
      row.textContent = text || '';
      return true;
    }

    /** The tick changes the label's dimming and the note, so write just those; never build() (it tears the section
     *  down). Returns false if the nodes aren't there yet, so callers keep their build() fallback. */
    function syncHead() {
      const label = host.querySelector('.row.wide .nm');
      const note = host.querySelector('.row.wide .note');
      const box = host.querySelector('.row.wide input[type=checkbox]');
      if (!label || !note || !box) return false;
      const live = ttsAvailable() && isTtsEnabled();
      label.style.opacity = headDimmed() ? '.45' : '1';
      // a loading voice is a ticked box, faded: pick() enables only at the end, so isTtsEnabled() alone would
      // snap the box unchecked mid-load
      const loadingNow = (!!_loadingId || _tickPending) && (_wantSpeech || !_tickPending);
      box.checked = isTtsEnabled() || loadingNow;
      box.style.opacity = loadingNow && !isTtsEnabled() ? '.45' : '';
      note.textContent = headNote();
      return true;
    }
/** A live mic wins over TTS (one publishing source, #91), and the row must say so. Display only: isTtsEnabled()
 *  stays true, so mic-off resumes speaking. The one place this status is computed. */
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

  /** Update every node build() paints (dimming, checkbox, status, voice list): a missed one goes stale silently.
   *  Returns false if nodes are missing, so the caller does a real build. */
  function syncInPlace() {
    const label = host.querySelector('.nm');
    const box = host.querySelector('input[type=checkbox]');
    const note = host.querySelector('.note');
    const listHost = host.querySelector('.tts-list');
    // name the missing node: one combined guard can't say which lookup failed
    if (!label || !box || !note || !listHost) {
      const missing = [!label && '.nm', !box && 'checkbox', !note && '.note',
                       !listHost && '.tts-list'].filter(Boolean).join(', ');
      why('tts-section', `sync refused: missing ${missing}`);
      return false;
    }

    const live = ttsAvailable() && isTtsEnabled();
    label.style.opacity = headDimmed() ? '.45' : '1';
    // never fight the user's own click: leave the box alone if it already shows the state. Same checked rule
    // as syncHead(); the two must agree.
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

  /** Updates in place once the section exists (focus and scroll survive); a full build only on first paint or after
   *  a deliberate teardown. */
  function build() {
    // log which path ran, so a teardown names itself
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
      // "model", not "text-to-speech": the audio panel's volume slider already carries that label
      `<label class="nm" style="opacity:${headDimmed() ? '.45' : '1'}">text-to-speech model</label>` +
      `<span class="ctl">` +
      `<input type="checkbox" ${isTtsEnabled() || ((_loadingId || _tickPending) && (_wantSpeech || !_tickPending)) ? 'checked' : ''} `
        + `${(_loadingId || _tickPending) && (_wantSpeech || !_tickPending) && !isTtsEnabled() ? 'style="opacity:.45" ' : ''}` +
        // not `disabled` when there's no voice: a disabled checkbox fires no change event, so the handler that
        // explains the missing voice could never run
      `title="speak with the voice marked below">` +
      `<span class="note">` +
      // the note says one thing: what is loading or loaded (_loadingId covers the gap before the engine's first
      // phase text, which wins once it arrives); empty when there's nothing to report
      `${headNote()}</span>` +
      `</span>`;
    head.querySelector('input').onchange = async (e) => {
      // Untick: nothing structural changes — no row appears or vanishes — so
      // write the two affected nodes instead of rebuilding the section.
      _wantSpeech = e.target.checked;
      if (!e.target.checked) {
        // the last click wins: an untick outranks a tick in flight and a re-tick outranks the untick; the load's
        // completion reads _wantSpeech, not a counter
        _needVoice = false; setTtsEnabled(false);
        if (!syncHead()) repaint(); else onPaint();
        return;
      }
      // a tick-initiated load is already running: its completion honours this tick (pick() would untick it)
      if (_tickPending) return;
      // ticking means "speak": no voices → refuse and say why; one → use it; several → marked, last used, else first
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
        // clears after 5s: it answers one click; clearTimeout so repeat clicks restart the window
        clearTimeout(_needVoiceTimer);
        _needVoiceTimer = setTimeout(() => { _needVoice = false; build(); }, 5000);
        // build() only, not repaint(): nothing outside this row changes
        build();
        return;
      }
      _needVoice = false;
      // the visible selection wins: load what the radio marks, else last used, else the first row
      const last = (() => { try { return localStorage.getItem('eido.tts.lastVoice'); } catch { return null; } })();
      const marked = _selected && items.some((i) => i.id === _selected) ? _selected : null;
      const pickId = marked ?? ((last && items.some((i) => i.id === last)) ? last : items[0].id);
        // If loading fails the box must not stay ticked over a voice that never
        // arrived — that is the same silent failure by a different route.
        try {
          const ok = await pick(pickId);      // loads and sets the source
          // pickInner reports failure as false (its catch owns the error UI); only the tick needs undoing here
          if (ok === false) { e.target.checked = false; return; }
          // _wantSpeech is the user's last action (the box is re-derived during the load and can't carry the no)
          if (!_wantSpeech) return;
          // enable here, not in pickInner: this path cleared _needVoice before calling it, so pickInner never
          // would. The tick decides whether.
          setTtsEnabled(true);
        } catch (err) {
          e.target.checked = false;
          _needVoice = true;
        // clears after 5s: it answers one click; clearTimeout so repeat clicks restart the window
        clearTimeout(_needVoiceTimer);
        _needVoiceTimer = setTimeout(() => { _needVoice = false; build(); }, 5000);
          console.warn('[voice] could not load the saved voice:', err);
        } finally {
          // every exit, or a successful load leaves the box faded
          _tickPending = false;
        }
        repaint();
    };
    host.appendChild(head);
    const listHost = document.createElement('div');
    listHost.className = 'tts-list';   // findable by syncInPlace
    // indent to the control column, derived from the grid's --row-label-col rather than hardcoded
    const col = getComputedStyle(host.closest('.row.wide')?.parentElement ?? host)
      .getPropertyValue('--row-label-col') || '8.5rem';
    listHost.style.cssText = `margin:2px 0 8px calc(${col} + 10px)`;
    host.appendChild(listHost);
    collectVoices().then((items) => {
      // something is always marked, in the tick's order (last used, else first), so the dot predicts the tick.
      // Display only: no load, no prompt.
      if (!_selected && items.length) {
        const last = (() => { try { return localStorage.getItem('eido.tts.lastVoice'); } catch { return null; } })();
        const real = items.filter((i) => i.id !== '__pending');
        if (real.length) _selected = (last && real.some((i) => i.id === last)) ? last : real[0].id;
      }
      renderVoiceList(listHost, {
        items, selected: _selected, busy: _busy,
        // The in-flight import, shown as a ghost row with a running clock.
        loading: _loadingId ? { id: _loadingId, name: _loadingName, since: _loadingSince, status: _busy } : null,
        // marking is not loading: while TTS is off the radio only marks (the tick loads); while on, it's a live switch
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
  // repaint when the mic changes: the greying reflects a state this row doesn't own (audio:mic covers both
  // the panel's checkbox and the HUD glyph)
  bus.on('audio:mic', () => build());
  return host;
}