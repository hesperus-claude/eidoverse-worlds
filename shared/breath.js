// breath — the period, and nothing else.
//
// 3.4 seconds is the house's breath: the wing idle beats on it, the stamina
// tick counts in it, and the falling-leaf oscillation swings on it (spec §5,
// §2, T8). It lives apart from shared/flight.js so a reader that needs the
// period doesn't import the flight core past its isolation gate.
//
// PURE, per shared/README.md: no imports, no clock, no DOM.

/** Seconds. The period. See spec T8. */
export const BREATH = 3.4;

/** Hz. The same number, as a rate -- what a flap or a sway wants. */
export const BREATH_HZ = 1 / BREATH;
