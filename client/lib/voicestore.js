// voicestore — remembers a picked voice as its FileSystemFileHandle in IndexedDB (a path can't be reopened).
// A handle isn't a grant: on restore queryPermission(); on 'prompt' show it greyed with a re-pick (needs a gesture).

const DB = 'eido.voices';
const STORE = 'handles';

function idb() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB, 1); } catch (e) { return reject(e); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let out;
      try { out = fn(store); } catch (e) { return reject(e); }
      // Resolve on complete, not request success: a readwrite transaction can still abort after it.
      t.oncomplete = () => resolve(out?.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('idb aborted'));
    });
  } finally { db.close(); }
}

/** Identity from the bytes, not the name (#91). Reproduces a session's inputs, not its waveforms (VITS noise is unseeded). */
export async function voiceIdentity(onnxFile, cfgFile) {
  const sha = async (f) => Array.from(new Uint8Array(
    await crypto.subtle.digest('SHA-256', await f.arrayBuffer())))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const [modelSha256, configSha256] = await Promise.all([sha(onnxFile), sha(cfgFile)]);
  let sampleRate = null, params = null;
  try {
    const cfg = JSON.parse(await cfgFile.text());
    sampleRate = cfg?.audio?.sample_rate ?? null;
    params = cfg?.inference ?? null;   // noise_scale / length_scale / noise_w
  } catch { /* config unreadable: identity still stands on the digests */ }
  return {
    // joint: same model with a different config (phonemes, language, params) is a DIFFERENT voice
    id: `sha256:${modelSha256.slice(0, 16)}+${configSha256.slice(0, 16)}`,
    modelSha256, configSha256, sampleRate, params,
    engine: 'piper-tts-web', engineVersion: PIPER_WEB_VERSION,
    modelBytes: onnxFile.size, configBytes: cfgFile.size,
  };
}
// must match the pin in client/package.json: identity names the runtime that performed
export const PIPER_WEB_VERSION = '1.0.4';

/** Everything remembered, newest first: [{id, name, handles, identity}]. */
export async function listVoices() {
  const rows = await tx('readonly', (s) => s.getAll());
  return (rows || []).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

/** `handles` are FileSystemFileHandles: a File is a byte snapshot and is NOT persistable */
export async function rememberVoice(id, name, handles, identity = null) {
  if (!id || !handles?.length) return false;
  try {
    await tx('readwrite', (s) => s.put({ id, name, handles, identity, savedAt: Date.now() }, id));
    return true;
  } catch (e) {
    // private/locked-down profiles refuse IndexedDB; never throw mid-load over it
    console.warn('[voice] could not remember voice:', e);
    return false;
  }
}

export async function forgetVoice(id) {
  try { await tx('readwrite', (s) => s.delete(id)); return true; }
  catch (e) { console.warn('[voice] could not forget voice:', e); return false; }
}

/** Readable now without prompting? 'prompt' needs a gesture; 'denied'/'gone' should be offered for removal. */
export async function voiceReadable(entry) {
  const hs = entry?.handles || [];
  if (!hs.length) return 'gone';
  for (const h of hs) {
    if (typeof h?.queryPermission !== 'function') return 'gone';
    let st;
    try { st = await h.queryPermission({ mode: 'read' }); }
    catch { return 'gone'; }            // handle outlived its origin/file
    if (st === 'denied') return 'denied';
    if (st !== 'granted') return 'prompt';
  }
  return 'granted';
}

/** MUST run in a user gesture after 'prompt': requestPermission() throws otherwise, and that throw is the
 *  browser enforcing consent, never a bug to catch and ignore. */
export async function openVoice(entry, { allowPrompt = false } = {}) {
  const out = [];
  for (const h of entry.handles || []) {
    let st = await h.queryPermission({ mode: 'read' });
    if (st !== 'granted') {
      if (!allowPrompt) throw new Error('permission needed — click to allow');
      st = await h.requestPermission({ mode: 'read' });
      if (st !== 'granted') throw new Error('permission refused');
    }
    out.push(await h.getFile());
  }
  return out;
}

/** Firefox/Safari pick via <input type=file>, unpersistable: the UI must not promise memory it can't deliver */
export const canRemember = () =>
  typeof indexedDB !== 'undefined' && typeof window !== 'undefined'
  && typeof window.showOpenFilePicker === 'function';
