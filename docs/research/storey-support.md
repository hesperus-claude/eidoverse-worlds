# Which floor the feet stand on in a griddled building

`mcpl/agent.ts` `storeyUnder(x, z, yHint)`. Griddled structures are not headless colliders (their walls are routed by
`walkStructures`), so this is how the feet, a walk's support and its routes know an upper floor is there (ew#140).

**The rules.** A level counts at (x, z) when all hold:

- it rests above its building's base (`base > 0`): a level on or below the base (a ground floor at the base, a
  basement) is the terrain's, and a body there walks on the terrain in and out of the building, as the router's
  terrain walk expects. A ground floor declared above the base is a raised floor like any other;
- its floor is more than `NAV_STEP` (0.8 m, a body's step) above the terrain under the point. A floor within a step of
  the terrain (a low porch) is the terrain's: a body steps on and off it as it walks, and a floor route can't step down
  off its edge, so standing on it would trap a body that walked onto it. This is decided under the point, so a deck
  over rising ground is the terrain's where the ground comes within a step of it; a floor walk on the deck still
  crosses that part at the deck's height (`walkProbeGround`);
- the feet (`yHint`) are no more than `ROUTE_STEP_METRES` (0.5 m) below the floor and less than the storey's height
  (the grid's `wallH`) above it, so feet on something placed on the floor (a table, a bed) still count;
- there is a tile under the point, and on a cell a diagonal cuts, a floor on the half the point falls in (the other
  half is a hole: `floorAtLocal`).

Where two storeys' ranges overlap, the highest floor wins: feet stepping up onto it are on it. `yHint` only picks
which real floor qualifies and never becomes the height, so a body far above a house is not on its top storey. Each
building is placed where it is now (`eff`), as `walkStructures` places it, and one that can't be read costs only
itself.
