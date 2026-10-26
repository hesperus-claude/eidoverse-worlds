# The quality governor: one two-way ladder

Code: `client/lib/governor.js` (`LEVERS`, `governPerformance`, `whenCalm`). Design: TEL0S_NOTES.md §12.6.

## Decision

One session-scoped controller, called once a second with the measured fps:

- **Every lever moves both ways.** What a slow minute takes, a smooth minute gives back.
- **The levers' state never persists.** Machine pressure is not a preference. (The resident's own dials, render scale,
  particle tier, avatar detail and "keep full detail", are preferences and are persisted; the governor works under them.)
- **The governor never touches the cloud tier.** Cloud quality is the resident's ⚙ choice; the levers are cheaper,
  reversible and measured.

## The ladder (shed order; restore unwinds back to front)

| lever | what it does |
|---|---|
| casters | distant objects stop casting shadows; the caster budget halves toward 2 (castShadow is in no pipeline key, so this is free) |
| lights | the light-slot cap drops by one (an idle slot is uniform zeros) |
| emitters | per-emitter instance counts thin, auto → med → low (only while the particle tier is `auto`) |
| cosmetics | cosmetic per-frame hooks (cloud drift, grass wind, billboards) run at half rate |
| grass | the meadow thins (instanced count, no rebuild), its own dial under the resident's cap |
| lod | far placed objects fetch their reduced tier sooner (#156; swaps ride the residency sweep) |
| pixels | render scale, −0.25 steps to 0.7 |
| detail | LOD bias 2 (far bodies at half rate) and the sun's shadow map down to 1024 |

Back-to-front restore means pixels, shed late, return first, and content comes back last. A lever with nothing to
relieve (no casters, nothing lit, no emitters) declines, so it doesn't burn the window or toast a lie.

## Pacing

- A shed needs 3 consecutive seconds under 26 fps and resets the streak: one lever per window, so a hitch can't cascade
  the whole ladder.
- A restore needs 5 consecutive seconds over 52 fps.
- The 26–52 gap is the hysteresis that stops shed/restore chattering; seconds in it count toward neither ladder.
- **Cruise (§22j).** Pixel-bound machines live in that dead band, where the ladder never engages. A sustained cruise there
  (8 s) steps pixels alone down, to a floor of 70% of the resident's base; only with render scale `auto`, not in XR,
  `?cruise=off` to disable.

## Loading grace (§16.2.D)

While loading work is in flight (`framebudget` lanes pending, or model promote tails pending), fps during the storm is
not a performance regime, and lever moves make it worse: each pixels notch is a render-target realloc, each detail flip
a shadow-map realloc. Both directions freeze and every streak resets, so a storm never carries partial counts into calm.
`whenCalm()` resolves once 5 consecutive seconds over 52 fps pass with no loading work: the same 1 Hz read the restore
ladder uses, not a second meter. Deferred extras (thumbnail contribution, roster prefetch) wait on it.

## Rejected (the previous governor)

Five one-way ratchets plus two recovering levers: shed grass never grew back, a doused light stayed doused, the shadow
map never re-sharpened, and the cloud lever persisted its degradation to localStorage and answered "slow right now"
with a full sky rebuild, the most expensive thing the client does. One bad three-second window (a tab restore, a burst
of arrivals) could degrade a world for good.
