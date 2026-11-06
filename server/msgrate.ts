// server/msgrate.ts — every message a connection sends spends from a token bucket (the shape of nginx's limit_req burst).
//
// Messages are counted when HANDLED, so a stall on the authority's thread lands a client's ordinary traffic in a clump; the
// burst (two seconds' worth by default) absorbs a backlog the server caused, and a sustained flood still empties it.
//
// Over the limit, a REQUEST is still answered (refused 'rate') rather than dropped, because its client waits for a reply by
// id; at most `rate` such answers a second, past which even a request is dropped, so a flood can't buy a stream of replies.

export type MsgBucket = { tokens: number; at: number; refusedWin: number; refused: number };

export const newBucket = (burst: number): MsgBucket => ({ tokens: burst, at: -1, refusedWin: 0, refused: 0 });

/** One message arriving at `now` (ms): "run" it, "refuse" it with a reply (requests only), or "drop" it. */
export function admitMessage(b: MsgBucket, now: number, rate: number, burst = 2 * rate): "run" | "refuse" | "drop" {
  if (b.at >= 0) b.tokens = Math.min(burst, b.tokens + Math.max(0, now - b.at) * rate / 1000);
  b.at = now;
  if (b.tokens >= 1) { b.tokens -= 1; return "run"; }
  if (now - b.refusedWin > 1000) { b.refusedWin = now; b.refused = 0; }
  return ++b.refused <= rate ? "refuse" : "drop";
}
