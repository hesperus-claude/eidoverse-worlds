// ttsrow — the audio panel's TTS section: a tick plus your voices (a model file or a speech server you run).
// Both transmit; nothing here is local-only.
import { renderVoiceList } from './ttslist.js';
import { why } from './debuglog.js';
import { ttsAvailable, ttsVoiceName, isTtsEnabled, setTtsEnabled, setTtsSource } from './tts.js';
import { setEndpointVoice } from './browservoice.js';
import { report, bus } from './base.js';
import { micOn } from './micstate.js';
// null when nothing is loaded: a real state, not an error
let _selected = null;
/** "you need a voice first": shown only after a tick with nothing loaded */
let _needVoice = false, _needVoiceTimer = 0;
// ticking TTS never touches the mic: under a live mic it only arms
let _busy = null;          // a phase string while loading
/** shown with a running timer, so a ~27s first prepare reads as work */
let _loadingId = null, _loadingName = null, _loadingSince = 0;
// bridges the gap before pick() sets _loadingId, where a repaint would blank the freshly-ticked box
let _tickPending = false;
/** written ONLY by the checkbox handler: the box itself is derived, so it can't hold a mid-load "no" */
let _wantSpeech = false;
/** a second 30s+ compile would race the first */
let _inFlight = null;
// a pick missing its other half, kept so it can be resumed
let _pending = null;
/** here, not in ttslist.js, so the list stays a renderer */
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
  // first: it is the thing asking for attention
  if (_pending) {
    out.unshift({
      id: '__pending',
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
/** `onPaint` lets the panel repaint sibling rows whose state we just changed */
export function ttsSection(host, onPaint = () => {}) {
  const repaint = () => { build(); onPaint(); };
    /** every load comes through here, so the guard and the loading row live here */
    async function pick(id) {
      if (id === '__pending') return resumePending();
      if (id === _selected && ttsAvailable()) return true;
      if (_inFlight) {
        // false, not undefined: the tick handler undoes its enable on ok === false
        console.log(`[voice] already loading ${_inFlight}; ignoring ${id}`);
        return false;
      }
      _inFlight = id;
      _loadingId = id;
      // stored ids are content digests, so ask the list for the name; the stripped id is the mid-import fallback
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
    // captured BEFORE it is cleared; TTS already on means a voice SWITCH, which must not silently mute
    const wantedSpeech = _needVoice || isTtsEnabled();
    try {
      if (id.startsWith('ep:')) {
        await setEndpointVoice(id.slice(3));
      } else {
        const { listVoices, openVoice } = await import('./voicestore.js');
        const entry = (await listVoices()).find((v) => v.id === id);
        if (!entry) throw new Error('that voice is no longer remembered');
        // a click is the only context in which requestPermission() may ask
        const files = await openVoice(entry, { allowPrompt: true });
        const { loadFromFiles } = await import('./voiceengines.js');
        await import('./engines.js');
        await loadFromFiles(files, (p) => {
        _busy = p.text || p.phase || 'loading…';
        if (!liveStatus(_busy)) build();
      });
      }
      _selected = id;
    try { localStorage.setItem('eido.tts.lastVoice', id); } catch { /* private mode */ }
    _needVoice = false;
      // choosing is not enabling: the tick decides whether, the list decides which
      if (wantedSpeech) setTtsEnabled(true);
    } catch (e) {
      report('tts voice', e);
      _busy = String(e?.message || e).slice(0, 80);
      build();
      setTimeout(() => { _busy = null; repaint(); }, 2500);
      // this catch absorbs every load error, so callers that must untick need the false
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
    // a live voice whose entry is gone would be state the UI cannot show
    if (id === _selected) { setTtsSource(null); setTtsEnabled(false); _selected = null; }
    repaint();
  }
  /** shared by addFile() and resumePending() so they can't diverge */
  async function finishImport(handles, files) {
    const { loadFromFiles } = await import('./voiceengines.js');
    await import('./engines.js');
    const shown = (files.find((f) => /\.onnx$/i.test(f.name)) || files[0])?.name || 'voice';
    const name = shown.replace(/\.onnx$/i, '');
      // _busy must clear on every exit: the add button greys while busy
      _busy = `loading ${name}…`;
      _loadingId = `file:${name}`; _loadingName = name; _loadingSince = Date.now();
      build();
      try {
        await loadFromFiles(files, (p) => {
        _busy = p.text || p.phase || `loading ${name}…`;
        // build() would remake every row once a second
        if (!liveStatus(_busy)) build();
      });
        const onnxF = files.find((f) => /\.onnx$/i.test(f.name));
        const cfgF = files.find((f) => /\.onnx\.json$/i.test(f.name)) || files.find((f) => /\.json$/i.test(f.name));
        const identity = (onnxF && cfgF)
          ? await (await import('./voicestore.js')).voiceIdentity(onnxF, cfgF)
          : null;
        const id = identity?.id ?? `file:${name}`;
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
      if (!more?.length) return;
      const handles = [..._pending.handles, ...more];
      const files = [..._pending.files, ...await Promise.all(more.map((h) => h.getFile()))];
      const { matchEngine } = await import('./voiceengines.js');
      await import('./engines.js');
      if (!matchEngine(files)) {
        _pending = { ..._pending, handles, files };
        _busy = `that was not a ${want} — try again`;
        build();
        return;
      }
      await finishImport(handles, files);
    } catch (e) {
      if (e?.name === 'AbortError') return;
      report('resume voice import', e);
    }
  }
  /** a declined directory prompt is an ordinary null, never a throw */
  async function pairFromDirectory(have, want) {
    if (!window.showDirectoryPicker) return null;
    const base = /\.onnx$/i.test(have) ? have : have.replace(/\.json$/i, '');
    const target = want === '.onnx.json' ? `${base}.json` : base;
    // it's the second ask in a row: say what granting the folder buys
    _busy = `optional: pick the folder holding ${have} and I'll find ${target} myself`;
    build();
    let dir;
    try {
      dir = await window.showDirectoryPicker({ mode: 'read', id: 'piper-voices' });
    } catch { return null; }
    // confirm the original is here too, so a model can't pair with another copy's config
    try {
      const mate = await dir.getFileHandle(target);
      await dir.getFileHandle(have);
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
      // a lone .onnx is the common near-miss; NAME what's missing, or a second dialog reads as a bug
      if (!matchEngine(files) || files.length === 1) {
        const have = files[0]?.name || 'a file';
        const want = /\.onnx$/i.test(have) ? '.onnx.json' : '.onnx';

        // a FileSystemFileHandle can't reach its siblings: a folder grant is the only lawful way next door
        _busy = `${have} selected — now pick the matching ${want}`;
        build();
        let more = await window.showOpenFilePicker({
          multiple: true,
          types: [{ description: `Matching ${want} for ${have}`,
                    accept: want === '.onnx' ? { 'application/octet-stream': ['.onnx'] }
                                             : { 'application/json': ['.json'] } }],
        }).catch(() => null);

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
          // a resumable row, not an expiring message
          _pending = { handles, files, have, want };
          _busy = null;
          repaint();
          return;
        }
      }
      await finishImport(handles, files);
    } catch (e) {
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
    /** a rebuild every second resets mid-interaction */
    function liveStatus(text) {
      // only the loading ROW carries progress; the header note says which voice is live
      const row = host.querySelector('.vl-loading .vl-note');
      if (!row) return false;
      row.textContent = text || '';
      return true;
    }

    /** never build() here: it tears the section down; false if the nodes aren't there yet */
    function syncHead() {
      const label = host.querySelector('.row.wide .nm');
      const note = host.querySelector('.row.wide .note');
      const box = host.querySelector('.row.wide input[type=checkbox]');
      if (!label || !note || !box) return false;
      const live = ttsAvailable() && isTtsEnabled();
      label.style.opacity = headDimmed() ? '.45' : '1';
      // ticked and faded while loading: pick() enables only at the end
      const loadingNow = (!!_loadingId || _tickPending) && (_wantSpeech || !_tickPending);
      box.checked = isTtsEnabled() || loadingNow;
      box.style.opacity = loadingNow && !isTtsEnabled() ? '.45' : '';
      note.textContent = headNote();
      return true;
    }
/** A live mic wins over TTS (#91). Display only: isTtsEnabled() stays true under it, so mic-off resumes speaking. */
function micIsPublishing() {
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

/** the label and the list both read this, so "greyed out" is one answer */
function headDimmed() {
  return !(ttsAvailable() && isTtsEnabled()) || micIsPublishing();
}

  /** must update every node build() paints: a missed one goes stale silently */
  function syncInPlace() {
    const label = host.querySelector('.nm');
    const box = host.querySelector('input[type=checkbox]');
    const note = host.querySelector('.note');
    const listHost = host.querySelector('.tts-list');
    if (!label || !box || !note || !listHost) {
      const missing = [!label && '.nm', !box && 'checkbox', !note && '.note',
                       !listHost && '.tts-list'].filter(Boolean).join(', ');
      why('tts-section', `sync refused: missing ${missing}`);
      return false;
    }

    const live = ttsAvailable() && isTtsEnabled();
    label.style.opacity = headDimmed() ? '.45' : '1';
    // never fight the user's own click; must agree with syncHead()
    const wantChecked = isTtsEnabled() || ((!!_loadingId || _tickPending) && (_wantSpeech || !_tickPending));
    if (box.checked !== wantChecked) box.checked = wantChecked;
    box.style.opacity = wantChecked && !isTtsEnabled() ? '.45' : '';
    note.textContent = headNote();

    // ttslist.js updates in place, so this is no teardown
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

  /** in place once built, so focus and scroll survive */
  function build() {
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
    // the note rides in the control column, never a third ragged column
    head.innerHTML =
      `<label class="nm" style="opacity:${headDimmed() ? '.45' : '1'}">text-to-speech model</label>` +
      `<span class="ctl">` +
      `<input type="checkbox" ${isTtsEnabled() || ((_loadingId || _tickPending) && (_wantSpeech || !_tickPending)) ? 'checked' : ''} `
        + `${(_loadingId || _tickPending) && (_wantSpeech || !_tickPending) && !isTtsEnabled() ? 'style="opacity:.45" ' : ''}` +
        // never `disabled`: a disabled checkbox fires no change event, so the missing-voice hint could never run
      `title="speak with the voice marked below">` +
      `<span class="note">` +
      `${headNote()}</span>` +
      `</span>`;
    head.querySelector('input').onchange = async (e) => {
      _wantSpeech = e.target.checked;
      if (!e.target.checked) {
        // the last click wins: the load's completion reads _wantSpeech
        _needVoice = false; setTtsEnabled(false);
        if (!syncHead()) repaint(); else onPaint();
        return;
      }
      // a tick-initiated load's completion honours this tick (pick() would untick it)
      if (_tickPending) return;
      if (ttsAvailable()) {
        _needVoice = false; setTtsEnabled(true);
        if (!syncHead()) repaint(); else onPaint();
        return;
      }
      _tickPending = true;
      const items = await collectVoices();
      if (!_wantSpeech) { _tickPending = false; return; }
      if (!items.length) {
        _tickPending = false;
        e.target.checked = false;          // the tick did not take; do not lie about it
        _needVoice = true;
        clearTimeout(_needVoiceTimer);
        _needVoiceTimer = setTimeout(() => { _needVoice = false; build(); }, 5000);
        build();
        return;
      }
      _needVoice = false;
      const last = (() => { try { return localStorage.getItem('eido.tts.lastVoice'); } catch { return null; } })();
      const marked = _selected && items.some((i) => i.id === _selected) ? _selected : null;
      const pickId = marked ?? ((last && items.some((i) => i.id === last)) ? last : items[0].id);
        // a failed load must not leave the box ticked over a voice that never arrived
        try {
          const ok = await pick(pickId);
          if (ok === false) { e.target.checked = false; return; }
          if (!_wantSpeech) return;
          // here, not in pickInner: this path cleared _needVoice, so pickInner never would
          setTtsEnabled(true);
        } catch (err) {
          e.target.checked = false;
          _needVoice = true;
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
    const col = getComputedStyle(host.closest('.row.wide')?.parentElement ?? host)
      .getPropertyValue('--row-label-col') || '8.5rem';
    listHost.style.cssText = `margin:2px 0 8px calc(${col} + 10px)`;
    host.appendChild(listHost);
    collectVoices().then((items) => {
      // marked in the tick's order, so the dot predicts the tick; display only, no load
      if (!_selected && items.length) {
        const last = (() => { try { return localStorage.getItem('eido.tts.lastVoice'); } catch { return null; } })();
        const real = items.filter((i) => i.id !== '__pending');
        if (real.length) _selected = (last && real.some((i) => i.id === last)) ? last : real[0].id;
      }
      renderVoiceList(listHost, {
        items, selected: _selected, busy: _busy,
        loading: _loadingId ? { id: _loadingId, name: _loadingName, since: _loadingSince, status: _busy } : null,
        // marking is not loading: while TTS is off the radio only marks; while on, it's a live switch
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
  }
  build();
  // the greying reflects mic state this row doesn't own
  bus.on('audio:mic', () => build());
  return host;
}