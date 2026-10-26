/** voiceengines — a slot for speech engines; this module knows no engine names. An engine calls registerEngine(),
 *  declares the files it recognises, and returns (text) => { pcm: Int16Array, sampleRate }, what setTtsSource()
 *  takes. Adding an engine is one registerEngine() call in its own file. */

const engines = [];

/**
 * @param {object} spec
 * @param {string} spec.id      stable slug, e.g. 'piper'
 * @param {string} spec.label   human name for the UI
 * @param {string[]} spec.accept  file extensions it can consume ('.onnx', '.bin')
 * @param {(files: File[]) => number} spec.match
 *        Confidence this engine owns the picked files: 0 = not mine, higher wins (a score: several engines take
 *        .onnx, and the one that also recognises the config should win).
 * @param {(files: File[]) => Promise<{speak: Function, label: string}>} spec.load
 *        Returns the speak fn. Throwing here is fine; the caller reports it.
 * @param {() => boolean} [spec.supported]  environment gate (WebGPU, OPFS, …)
 */
export function registerEngine(spec) {
  for (const k of ['id', 'label', 'accept', 'match', 'load']) {
    if (!spec?.[k]) throw new Error(`voice engine needs .${k}`);
  }
  const i = engines.findIndex((e) => e.id === spec.id);
  if (i >= 0) engines[i] = spec; else engines.push(spec);   // re-register = replace
}

/** Every extension any registered engine accepts — the file dialog's filter,
 *  derived rather than hardcoded. This is why adding an engine does not mean
 *  editing an accept string somewhere else. */
export function acceptedExtensions() {
  return [...new Set(engines.flatMap((e) => (e.supported?.() === false ? [] : e.accept)))];
}

export function availableEngines() {
  return engines.filter((e) => e.supported?.() !== false).map(({ id, label, accept }) => ({ id, label, accept }));
}

/** Pick the engine that best recognises these files. Returns null if none does,
 *  which the caller must render as "we do not know this format" — never as a
 *  silent failure, and never by guessing at the highest-scoring zero. */
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

/** The whole public flow: picked files in, a speak fn out. It sniffs rather than asks which engine. */

export async function loadFromFiles(files, onProgress = () => {}) {
  const e = matchEngine(files);
  if (!e) {
    const names = files.map((f) => f.name).join(', ');
    const known = availableEngines().map((x) => `${x.label} (${x.accept.join(' + ')})`).join('; ');
    throw new Error(`no engine recognises ${names}. Known formats: ${known || 'none registered'}`);
  }
  return { engine: e, ...(await e.load(files, onProgress)) };
}
