# Note to Mica: how the 27-row table became Antra's 17 (all commits verified in 6970079e9)

Antra's table now holds only the deliberate differences from main. Each other row from the 27-row table you reviewed (published f0cdd568e) was restored to main's behaviour with a red-on-parent row, or found to match main already; one (13) is a looser limit, flagged below. Old row number, then where it went:

| old # | what | now |
|---|---|---|
| 4 | Consent as two switches + lists | Same behaviour as main: main's *pushable* (default on) and *posable* (default off) are v4's *Allow being moved* / *Allow being posed and touched*, with the same defaults. Main's "intimate" was only a label and was never enforced. The migration only ever narrows (a4ed40a35, gates-check M4/M7–M9). |
| 9 | Translated seat with no `pos` | Restored: sits at main's 0.5 (34c1753c2) |
| 11 | `catch_up`'s description | Fixed: it describes arrival-only speech and the `readChat` grant (5d9d50707, d04f1a13e) |
| 13 | `name_place` 8 KB guard | Not identical, said plainly: main capped any component's data at 8,192 characters of JSON; v4's general value cap is 64 KiB (refusal `too-big`). Looser, not absent. If you'd rather Antra rule on it, it becomes her row 18. |
| 14 | Timed `world_access` grants | Restored: `for: "2h"` accepted and stored as `until` (52ea73571, a64c286df) |
| 15 (marker half) | The ◈ agent marker | Restored as on main: before an agent's name in the chat log only (1573a5a2a, P8). The nudge-key half is Antra's row 10. |
| 16 | Sky sun / fill | Restored: both stored and drawn again (aa15b1d4b, S3-SF) |
| 17 | Caption deed with no end | Same behaviour: main's deed never expired by time either; it ended with the screen's generation, as v4's `captioners` does |
| 19 | `impulse` reaction | Restored, Godot-style: `impulse {strength?, angular?}` on dynamic things (f6fa17788, SW1/SW1b) |
| 21 | `/worlds` agents list | Restored: `N humans, M agents` (e1f21cc9a) |
| 24 | The world's edge | Same result: upgrades write a stage box matching main's clamps for old worlds with neither bounds nor terrain (3eb5c51c1) |
| 27 | Main's slow water | Restored as main had it: swim only, through `physics-area {kind:"speed", modes:["swim"]}` (e3ac88fb4, A6/A7) |

The 16 rows that stayed are renumbered 1–17 in Antra's table (old row 20 split into phones and VR):

| old # | Antra's # |
|---|---|
| 1, 2, 3 | 1, 2, 3 |
| 5 rate limits | 4 |
| 7 swim float | 5 |
| 6 step height | 6 (0.8 m kept for now; the server's stride check refused real stairs at 0.55) |
| 8 motes | 7 |
| 10 `_emotes.json` | 8 |
| 12 `/upload?as=script` | 9 |
| 15 nudge-key half | 10 |
| 18 `use` | 11 |
| 20 phones / VR | 12 / 13 |
| 22 native Unreal | 14 (see the eidoverse-unreal PR for the GPU receipt) |
| 23 glowing-model lights | 15 |
| 25 throw key | 16 |
| 26 ownerless | 17 |
