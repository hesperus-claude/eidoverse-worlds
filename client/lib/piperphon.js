// piperphon — build the phonemizer ONCE, not once per word. @mintplex-labs/piper-tts-web's predict() rebuilds the
// espeak-ng emscripten module on every call (~30 s per utterance) and keeps the factory private, so we make that
// call ourselves and keep the (re-entrant) module.

// 🔴 THE BUILD RUNS IN A WORKER, AND THAT IS WHAT MAKES IT FAST (2026-08-09).
// Measured: 57ms in Bun vs 27,551ms on the browser main thread, SAME BYTES — so
// the 17 MB data package was never the problem. piper-o91UDS6e.js loads via
// `xhr.open(url, false)` (synchronous XHR), guarded by ENVIRONMENT_IS_WORKER:
// legal and fast in a worker, deprecated and glacial on the main thread.
// See phon.worker.js. Everything below keeps its old signature; only the place
// the work happens changed.
let _worker = null, _seq = 0;
const _pending = new Map();
let _ready = false;

function worker() {
  if (_worker) return _worker;
  _worker = new Worker(new URL('./phon.worker.js', import.meta.url), { type: 'module' });
  _worker.onmessage = (e) => {
    const { id, ok, ids, error } = e.data || {};
    const p = _pending.get(id);
    if (!p) return;                      // a reply to a call that already gave up
    _pending.delete(id);
    ok ? p.resolve(ids) : p.reject(new Error(error || 'phonemizer failed'));
  };
  // A worker that dies takes every in-flight call with it — fail them loudly
  // rather than leaving promises that never settle (silent hang > visible error
  // is exactly backwards for a voice path).
  _worker.onerror = (e) => {
    const err = new Error(`phonemizer worker died: ${e.message || 'unknown'}`);
    for (const p of _pending.values()) p.reject(err);
    _pending.clear(); _worker = null; _ready = false;
  };
  return _worker;
}

/** The chunk URL must be resolved HERE, not in the worker: import.meta.url
 *  differs inside a worker, and a path that resolves on the main thread would
 *  silently 404 there. */
function wasmBundle(wasmPaths) {
  return {
    js: new URL('../node_modules/@mintplex-labs/piper-tts-web/dist/piper-o91UDS6e.js',
                import.meta.url).href,
    wasm: new URL(wasmPaths.piperWasm, location.href).href,
    data: new URL(wasmPaths.piperData, location.href).href,
  };
}

function ask(op, payload, timeoutMs = 120_000) {
  const id = ++_seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending.delete(id);
      reject(new Error(`phonemizer ${op} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    _pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject:  (e) => { clearTimeout(timer); reject(e); },
    });
    worker().postMessage({ id, op, ...payload });
  });
}


/** Text → phoneme ids. Same signature as before; the work now happens in the
 *  worker, where the library's synchronous loader is legal and fast. */
export async function phonemize(text, voice, wasmPaths) {
  const ids = await ask('phonemize', { text, voice, wasmPaths: wasmBundle(wasmPaths) });
  _ready = true;
  return ids;
}

/** Build the module now, inside the load the user is already watching, not in front of their first utterance:
 *  the build is the expensive part and needs nothing but the wasm paths. */
export async function warmPhonemizer(wasmPaths, onProgress = () => {}) {
  if (_ready) return true;
  const t0 = performance.now();
  const tick = setInterval(() => {
    onProgress({ phase: 'phonemizer',
      text: `building pronunciation — ${Math.round((performance.now() - t0) / 1000)}s` });
  }, 1000);
  try {
    await ask('warm', { wasmPaths: wasmBundle(wasmPaths) });
    _ready = true;
    console.log(`[voice] phonemizer ready in ${Math.round(performance.now() - t0)}ms (worker)`);
    return true;
  } catch (e) {
    console.warn('[voice] phonemizer warm-up failed:', e);
    return false;
  } finally { clearInterval(tick); }
}

export const phonReady = () => _ready;
