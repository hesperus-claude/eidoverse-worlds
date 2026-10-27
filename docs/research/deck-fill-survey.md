# Deck fill: when a model's top surface is believed as a floor

`mcpl/agent.ts` `DECK_FILL = 0.45`. When a model's triangles aren't available or the mesh fit (`registerMeshSupport`) fails, a
room-scale model's flat top surfaces (`topSurfaces` from `/geom`, area ≥ 1 m², at most six) are registered as box supports. A surface counts only when its fill (its area
over its bounding rectangle's) is at least `DECK_FILL`.

**Decision.** 0.45, from a survey of the shipped library, not from taste. Sparse surfaces and real decks separate
cleanly and the gap between them is empty:

- everything sparse is at or below 0.36 (rubble piles, palm canopies, excavator and rig superstructure);
- every real deck is at or above 0.53 (perimeter walls, hulls, watchtower and rig decks, gates).

0.45 sits in the middle of that empty band, so library drift in either direction has to travel before it changes an
answer. This is the one number to move if the split needs revisiting; re-survey first.

**Cost, on purpose.** A real but open deck (a catwalk, a grating) is abstained on, and a body falls to terrain
instead. **Rejected:** inventing geometry for open decks; a body resting in a palm canopy is the bug #17 ended.
