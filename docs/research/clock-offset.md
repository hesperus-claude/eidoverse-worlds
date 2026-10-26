# The one-way server clock offset

`shared/clockoffset.js` `foldOffset`, used by the browser and lite page (`client/lib/serverclock.js`) and the agent
(`mcpl/agent.ts`).

**Decision: keep the maximum sample, with a slow leak.** A sample is a message's `t` (the server's clock when it sent
it) less the local time the message was handled. That is the true offset less the message's delay, never more, so the
largest sample is the best estimate and a late one (a busy page, a slow link) can't pull it down. The estimate may come
down by `LEAK_MS_PER_S` (2 ms) for each second since the previous sample, and by at most `LEAK_MAX_MS` (100 ms) at once,
so slow drift is followed while a run of late samples moves it by almost nothing.

- **Between samples it holds,** so a quiet world doesn't wander. The cap stops one late sample after a long quiet spell
  (a tab coming back from the background) from pulling the estimate down by its whole delay; the cost is that drift
  built up over the spell is followed by at most 100 ms at the first sample, then at 2 ms/s.
- **2 ms/s is a reading, not a measurement:** twice the 1 ms/s two clocks drift apart when each slews at ntpd's 500 ppm
  limit.
- **A step back** of the server's clock (rare under NTP, or a reconnect to a server whose clock is behind) is followed
  at the same rate while samples come at least every 50 s: about 8 minutes for a 1 s step, an hour for 7 s. In the
  browser this one-way estimate is only the fallback: a round trip (`serverclock.js` `noteRoundTrip`, minimum filter)
  wins once there is one, and a step retires the older round trips that disagree with a new one.
- **Quiet worlds.** The server sends a world `frame`s only while some pose changed that tick, so a world with nobody
  streaming a body gets none and the estimate holds until a frame or the next join's clock message brings a sample.

**Rejected:** blending every sample (an exponential average), the rule before this one. It reads the server's clock
about one mean delay early and moves with every late sample. The blend is still computed as `stream`
(`STREAM_BLEND`), but nothing at runtime reads it today.
