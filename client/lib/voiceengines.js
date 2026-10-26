/** voiceengines — speech-engine registry that knows no engine names; each engine's load() yields
 *  (text) => { pcm: Int16Array, sampleRate }, what setTtsSource() takes. */

const engines = [];

/**
 * @param {object} spec
 * @param {string} spec.id      stable slug, e.g. 'piper'
 * @param {string} spec.label   human name for the UI
 * @param {string[]} spec.accept  file extensions it can consume ('.onnx', '.bin')
 * @param {(files: File[]) => number} spec.match
 *        0 = not mine, higher wins: several engines take .onnx; the one that also knows the config should win
 * @param {(files: File[]) => Promise<{speak: Function, label: string}>} spec.load
 *        throwing is fine; the caller reports it
 * @param {() => boolean} [spec.supported]  environment gate (WebGPU, OPFS, …)
 */
export function registerEngine(spec) {
  for (const k of ['id', 'label', 'accept', 'match', 'load']) {
    if (!spec?.[k]) throw new Error(`voice engine needs .${k}`);
  }
  const i = engines.findIndex((e) => e.id === spec.id);
  if (i >= 0) engines[i] = spec; else engines.push(spec);   // re-register = replace
}

/** the file dialog's filter, derived so a new engine needs no accept-string edit elsewhere */
export function acceptedExtensions() {
  return [...new Set(engines.flatMap((e) => (e.supported?.() === false ? [] : e.accept)))];
}

export function availableEngines() {
  return engines.filter((e) => e.supported?.() !== false).map(({ id, label, accept }) => ({ id, label, accept }));
}

/** null when none recognises the files: the caller must say "unknown format", never fail silently or guess */
export function matchEngine(files) {
  let best = null, bestScore = 0;
  for (const e of engines) {
    if (e.supported?.() === false) continue;
    let s = 0;
    try { s = e.match(files) || 0; } catch { s = 0; }
    if (s > bestScore) { best = e; bestScore = s; }
  }
  return best;
}

/** picked files in, a speak fn out; sniffs rather than asks which engine */
export async function loadFromFiles(files, onProgress = () => {}) {
  const e = matchEngine(files);
  if (!e) {
    const names = files.map((f) => f.name).join(', ');
    const known = availableEngines().map((x) => `${x.label} (${x.accept.join(' + ')})`).join('; ');
    throw new Error(`no engine recognises ${names}. Known formats: ${known || 'none registered'}`);
  }
  return { engine: e, ...(await e.load(files, onProgress)) };
}
