// breath — the period, and nothing else.
//
// 3.4 seconds is the house's breath: the wing idle beats on it, the stamina
// tick counts in it, and the falling-leaf oscillation swings on it
// (shared/flight.js). It lives apart from flight.js so a reader that needs
// only the period doesn't import the flight core.
//
// PURE, per shared/README.md: no imports, no clock, no DOM.

/** Seconds. The period. */
export const BREATH = 3.4;

/** Hz. The same number, as a rate -- what a flap or a sway wants. */
export const BREATH_HZ = 1 / BREATH;
