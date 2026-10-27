# The typing-dots probe: how it judges

`tools/typing-dots-probe.ts` checks an agent's typing dots end to end: a host's `channels/typing` through the MCPL door
and the world to the pill a person sees in the full client. A raw MCPL host stands in for agent-framework (start when
a turn begins and every 7 s, stop when it ends); the full client runs in Chromium in the same world, and a raw socket
beside it logs what the world broadcasts.

**The page is judged by the client's own state, not by pixels.** The agent avatar's `setTyping` (each signal and the
window it set) and `update` (the state each render-loop update left, which is where the pill is decided) are wrapped;
a listener on the client's socket logs each typing frame received, and a `requestAnimationFrame` loop each frame
rendered. Rules: every update draws the pill exactly when the window is open at the update's own `now` and no bubble
shows; each signal opens a window ending 4 s after it; the page receives every typing frame the world sent; and the
client applies each after the one before and before the page renders again.

- **Deadlines count from the page's own receipt.** A loaded page lets socket messages queue while it renders, so a
  deadline from the probe's receipt would fail a working client.
- **No state on agent frames** (the client applies `setTyping(undefined)`), so the live-mic pill, which the client
  keeps up over a bubble, can't arise, and the first rule relies on that. The agent's plate is never hidden on the
  viewer's page, so an update that hid it is a defect.
- **Level-of-detail ticks.** A remote avatar updates only on its LOD ticks (`client/lib/remotes.js`), further apart
  the further and the more loaded; between updates the pill stays as the last one left it. So the probe judges each
  decision and prints how far apart they came, rather than sampling the pill on a clock.

**The raw socket judges the door's contract by the probe's clock**, as a viewer would see it, and only the probe's own
stalls are excused: a heartbeat records every gap past 100 ms, and a stamp is allowed the stall whose late tick ran
within 20 ms of it. The probe can't tell when in a stall a frame arrived, so it allows the whole stall, erring toward
the door by at most that stall; a step between two frames is judged by the shortest gap their stamps allow. A door or
world slowed past a bound's margin fails, and the run prints the machine's load.

**Rejected:** deadlines counted from the probe's receipt (they fail a working client on a loaded machine).
