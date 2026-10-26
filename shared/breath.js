// breath — the house's period, and nothing else: the wing idle beats on it, the stamina tick counts in it and the
// falling-leaf oscillation swings on it (shared/flight.js re-exports it). It lives apart from flight so client/lib/avatar.js
// can read the number without importing the flight core (tools/flight-test.ts's isolation gate says who may).
//
// PURE, per shared/README.md: no imports, no clock, no DOM.

/** Seconds. The period. See spec T8. */
export const BREATH = 3.4;

/** Hz. The same number, as a rate -- what a flap or a sway wants. */
export const BREATH_HZ = 1 / BREATH;
