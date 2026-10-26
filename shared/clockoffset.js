// The server-to-local clock offset, one rule for browser and lite page (client/lib/serverclock.js) and agent. A sample
// (server t less local receipt) never exceeds the true offset, so keep the max; it leaks down LEAK_MS_PER_S (≤ LEAK_MAX_MS
// a sample) to follow drift or a step back (docs/research/clock-offset.md).
export const LEAK_MS_PER_S = 2, LEAK_MAX_MS = 100;

// the stream offset blends every sample at STREAM_BLEND (the rule before the max); nothing at runtime reads it today
export const STREAM_BLEND = 0.08;

/** `prev`: the last result or null; `sample`: the message's t less the local time handled; `at`: that time, monotonic ms.
 *  → { offset, at, stream }. */
export function foldOffset(prev, sample, at) {
  // a non-finite sample (a t of 1e999 parses as Infinity) would stick in the max and the blend for the page's life
  if (!Number.isFinite(sample) || !Number.isFinite(at)) return prev;
  if (!prev) return { offset: sample, at, stream: sample };
  const leak = Math.min(LEAK_MAX_MS, LEAK_MS_PER_S * Math.max(0, at - prev.at) / 1000);
  return {
    offset: Math.max(prev.offset - leak, sample),
    at: Math.max(prev.at, at),
    stream: prev.stream * (1 - STREAM_BLEND) + sample * STREAM_BLEND,
  };
}
