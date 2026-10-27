// physconst — the reach and hand numbers the authority admits by and a client predicts by: one binding for both.
export const REACH = 1.5;      // m from the hand: arm plus a step (grab, put, drop, throw)
export const BODY_MASS = 70;   // kg: every body's presumptive mass, until bodies are simulated whole
export const HAND_Y = 1.1;     // where a held thing sits above the feet; reach is measured from there
export const MAX_HELD = 2;     // things in two hands at once
export const KICK = Object.freeze({ reach: 1.6, below: -0.5, above: 2.0, lift: 0.9 });   // a punt, from the body's origin
// a contact push (shared/shove.js): only from a body against the thing (feet within `reach` of its box), not beneath or
// `above` the head; lift ≤ `lift` × ground speed, at most what BODY_MASS at `run` m/s passes elastically, never above `maxV`.
// `mu`: the slide's friction (shared/sim.js FRICTION).
export const SHOVE = Object.freeze({ reach: 0.9, beneath: 0.1, above: 2.0, maxV: 3, lift: 0.3, run: 4.0, mu: 0.6 });
// a shove or drag at another body is gated three times ("honesty, not security"): the authority within BODY_REACH, a client's
// offer within SHOVE_REACH, the server's presence forward within BODY_RANGE; each named here so none is a stray literal.
export const BODY_REACH = REACH + 0.5;
export const SHOVE_REACH = 2.5;
export const BODY_RANGE = Object.freeze({ shove: 3, displace: 3, pose: 10 });
export const USE_REACH = 2.5;  // m, feet to a thing the use prompt offers
