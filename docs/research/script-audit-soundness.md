# Script audit: what a reader can prove without knowing who

`shared/protocol/scriptaudit.js` is a reader's view of behaviour results. It needs only the log, the fold, the source blobs
and the sandbox, never the authority. For every `script:<id>` act it recomputes the sponsor, the cause-chain depth (and the
limit, 8 by default) and the seed, then re-runs the script and compares the writes and says with what the log recorded.
Replay of the world never runs code (L1); this re-run is an optional audit view.

## The problem: the log keeps no who

An act records what its presence reads ASKED and how much came back (`{near: [{r, n}], count, names: k}`), never who: the
ids near a script and display names stay out of the log. So a re-run answers each `near()` with `n` opaque stand-ins and
each `name()` with null. Those reads are inputs the auditor can't replay, and it treats them so:

1. The re-run must ask the SAME reads (radii, counts, how many names). A different shape is flagged `reads`.
2. When the re-run's writes and says equal the logged ones, the act is verified: its result didn't depend on who was there.
3. When they differ and the act read who was near or what someone is called, the act is `skipped` with that reason, never
   flagged and never counted verified. An act with no such reads that differs is still flagged: `rerun` for its writes, `rerun-say` for its says.

Soundness: everything but the identities is still checked (sponsor, depth, seed, source, the read shape), and an
identity-independent result is checked in full. Flagging a who-dependent mismatch would accuse an honest authority of a
forgery the auditor can't tell from a different crowd.

## Arrivals: two stand-ins of different shapes

An activation that names nobody in the log (`enter`, `leave`, and an unlogged `grab` or `release` with no `event.by`)
keeps no identity: the script heard `by` live, the act keeps neither a trigger actor nor `event.by`. The re-run gets a
stand-in (`ARRIVAL_STAND_IN`, minted-shaped: `u-` and 20 letters); a result that matches the log is verified. One that
differs is re-run with a second stand-in of another valid shape (`ARRIVAL_STAND_IN_2`). If the two re-runs disagree, the
result depends on who came: `skipped`. If they agree but still differ from the log, it is flagged `rerun-anon`, never
`rerun`: two inputs can't prove a result is the same for every identity, so it is a mismatch to look at, not proof of a
forgery.

Rejected: stand-ins of the same shape (a script that branches on the shape of an id would pass both and be wrongly
accused), and naming the stand-ins by the kind of body (person or agent): a script may not tell them apart, so the audit
doesn't either.
