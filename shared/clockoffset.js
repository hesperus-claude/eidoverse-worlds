// The server-to-local clock offset, kept from samples: the one rule for a browser (client/lib/remotes.js), a lite page
// (client/lib/participants_lite.js) and an agent (mcpl/agent.ts).
// A sample (server t less local receipt) never exceeds the true offset, so keep the max; it may leak down LEAK_MS_PER_S,
// at most LEAK_MAX_MS per sample, to follow drift (or a server clock step back) without trusting late samples. Between
// samples it holds.
export const LEAK_MS_PER_S = 2, LEAK_MAX_MS = 100;

// the stream offset blends every sample at STREAM_BLEND (about one mean delay early): remote-body interpolation reads it
// (remotes.js streamNow); every other reader wants the true time and reads the offset
export const STREAM_BLEND = 0.08;

/** Fold one sample into the estimate. `prev` is the previous result, or null
 *  before the first sample; `sample` is the message's t less the local time
 *  it was handled; `at` is that local time, in ms on a monotonic clock.
 *  Returns the new estimate, { offset, at, stream }. */
export function foldOffset(prev, sample, at) {
  // a non-finite sample or time (a t of 1e999 parses as Infinity) would
  // stick in the max and the blend for the page's life: it isn't a sample
  if (!Number.isFinite(sample) || !Number.isFinite(at)) return prev;
  if (!prev) return { offset: sample, at, stream: sample };
  const leak = Math.min(LEAK_MAX_MS, LEAK_MS_PER_S * Math.max(0, at - prev.at) / 1000);
  return {
    offset: Math.max(prev.offset - leak, sample),
    at: Math.max(prev.at, at),
    stream: prev.stream * (1 - STREAM_BLEND) + sample * STREAM_BLEND,
  };
}
