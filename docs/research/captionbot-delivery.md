# Captionbot delivery: receipts, order, backpressure, a spool that fails closed

Code: `tools/captionbot/world.ts` (delivery), `tools/captionbot/index.ts` (env and exit status). The rules the
door applies are in `docs/CAPTIONS.md`.

The world client joins embodied as an identity the screen's `captioners {ids}` names, sends one door `caption`
request per final line, and reads the operator's `stage` cue off its own fold of the world
(`shared/protocol/replica.js`), so `speaker` is the operator's word, never the bot's guess.

## Receipts

A line is not done when it is sent; it is done when the door answers ok. Until then it is pending: in memory, in
the spool, and resent after a disconnect or a silent timeout. The door refuses a duplicate `n` before anything is
written (`captionRefusal`), so a resend can never write twice, and that refusal is read as the receipt.

## Order

One line in flight, FIFO, paced (`paceMs`, default 500 ms) under the authority's rate (60 acts per 10 s per actor; a caption
is one act, its change entry counting only toward the byte budget), so a burst of finals queues rather than tripping the limiter. Which captioner holds the screen is
the server's fact, not the bot's: the door stamps the leg generation. A restart's old-session tail drains first,
FIFO, so the session switches once.

## Backpressure

The queue is bounded (`maxPending`, env `MAX_PENDING`, default 600 lines: about five minutes at the default pace).
Past it the oldest queued lines drop, each written to the spool as `overflow` and counted out loud: never a silent
drop, never unbounded memory.

## The spool is a promise, so it fails closed

The spool (JSONL, append-only; rows `queued`, `acked`, `refused`, `overflow`) is the bot's durable record of what
it tried and what the world confirmed. A restart re-queues each line never confirmed, except one whose `overflow`
or `refused` row is on disk.

- A line queues only once its `queued` row is on disk. If that write fails, the line is refused and intake halts:
  new captions are counted and refused, out loud, until the operator fixes the disk and restarts. What is already
  queued still drains.
- `end` is not a line (a perception clear, idempotent at the door), so it goes through with the spool down; an
  unwritten `end` row is counted (`endMissed`), since a restart before confirmation replays the session's lines
  without the clear.
- `acked`, `refused` and `overflow` rows are bookkeeping: a failed write logs and continues. The cost is a restart
  resending a line that already landed (harmless: the door dedupes) or one this run reported dropped.
- `SPOOL_BEST_EFFORT=1` states the weaker promise: an unwritable `queued` row is said once (then every 100th) and
  the line queues anyway, counted in `spoolMissed`; a restart before confirmation loses it.

A run from a file source exits non-zero when the promise wasn't kept for a line or its end (refused, or queued
without its row), or lines overflowed.

Rejected: an unbounded in-memory queue, and a best-effort spool as the default. Captions are durable world
testimony; the bot keeps nothing the world doesn't, and its spool is a delivery record, not a transcript.
