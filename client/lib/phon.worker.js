/** The phonemizer in a Worker: piper's loader uses synchronous XHR (guarded by ENVIRONMENT_IS_WORKER), legal and
 *  fast only in a Worker; on the main thread the build measured ~480x slower. The 17 MB data isn't the cause.
 *
 *  PROTOCOL (the seam is piperphon.js's phonemize / warmPhonemizer / phonReady):
 *      → { id, op: 'warm',      wasmPaths }         ← { id, ok }
 *      → { id, op: 'phonemize', text, voice, wasmPaths } ← { id, ok, ids }
 *      any failure                                   ← { id, ok: false, error }
 *  Every reply carries the id it answers, so a slow call cannot resolve a fast one's promise.
 */

let _mod = null;
let _building = null;
// Where the CURRENT call's stdout goes: Emscripten captures Module.print once at construction, so the handler is
// permanent and the sink swappable.
let _sink = null, _errSink = null;

async function build(wasmPaths) {
  if (_mod) return _mod;
  if (_building) return _building;
  _building = (async () => {
    const { createPiperPhonemize } = await import(wasmPaths.js);
    _mod = await createPiperPhonemize({
      print: (data) => { _sink?.(data); },
      printErr: (msg) => { _errSink?.(msg); },
      locateFile: (url) =>
        url.endsWith('.wasm') ? wasmPaths.wasm :
        url.endsWith('.data') ? wasmPaths.data : url,
    });
    return _mod;
  })();
  try { return await _building; } finally { _building = null; }
}

function run(mod, text, voice) {
  let ids = null;
  _sink = (data) => { try { ids = JSON.parse(data).phoneme_ids; } catch { /* not our line */ } };
  // stderr is chatter (espeak warnings/info), not failure: collect it; it becomes the diagnostic only if no ids come back.
  const errLines = [];
  _errSink = (msg) => { errLines.push(String(msg)); };
  try {
    mod.callMain(['-l', voice || 'en-us', '--input', JSON.stringify([{ text }]),
                  '--espeak_data', '/espeak-ng-data']);
  } catch (e) {
    // callMain throws its exit code even on success; a real failure is an Error.
    if (typeof e !== 'number' && e?.status === undefined) throw e;
    // exit-code throws are normal; real failures fall through to the ids
    // check below, where collected stderr becomes the message.
  } finally {
    _sink = null; _errSink = null;
  }
  if (!ids && errLines.length) throw new Error('phonemizer produced no ids; stderr: ' + errLines.slice(-5).join(' | '));
  if (!ids) throw new Error('phonemizer produced no ids'
    + (errLines.length ? '; stderr: ' + errLines.slice(-5).join(' | ') : ''));
  return ids;
}

self.onmessage = async (e) => {
  const { id, op, text, voice, wasmPaths } = e.data || {};
  try {
    const mod = await build(wasmPaths);
    if (op === 'warm') { self.postMessage({ id, ok: true }); return; }
    self.postMessage({ id, ok: true, ids: run(mod, text, voice) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
