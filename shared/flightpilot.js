// flightpilot — a human's held keys → the same input record a verb produces, so a pilot and an agent fly identical physics.
// PURE (shared/README.md): held key codes and a dt in, an input record out. No DOM, no listeners, no clock.

/** Overlapping the walk controls (W/A/S/D + Space) on purpose, so flying reads as a MODE of the same body; Shift/Ctrl for
 *  the axis walking lacks. */
export const DEFAULT_BINDS = {
  pitchDown: ['KeyW', 'ArrowUp'],       // nose down: trade altitude for speed
  pitchUp:   ['KeyS', 'ArrowDown'],     // nose up: trade speed for altitude
  bankLeft:  ['KeyA', 'ArrowLeft'],
  bankRight: ['KeyD', 'ArrowRight'],
  flap:      ['Space'],                 // expensive; see spec §5
  spoil:     ['ShiftLeft', 'ShiftRight'],   // bleed altitude without gaining speed
  // rehearsal only: these EMIT the trusted events an adapter will emit for real, never simulate a cut (down-spec §4)
  rehearseDown:    ['KeyX'],
  rehearseRecover: ['KeyR'],
};

/** Control authority per second at full deflection: config, so an albatross isn't flown like a fighter. */
export const DEFAULT_AUTHORITY = {
  bankRate: 2.6,        // rad/s toward the commanded bank
  maxBank: 1.15,        // ~66deg
  pitchRate: 1.5,       // rad/s
  maxPitch: 0.7,        // ~40deg
  turnPerBank: 1.5,     // rad/s of yaw per radian of bank
  levelReturn: 1.1,     // rad/s back to level -- ONLY with the stick centred
  // no spoilSink here: this reports whether the spoiler is HELD; its sink is physics (cfg.pilot.spoilSink)
};

const held = (keys, list) => list.some((k) => keys.has(k));

/**
 * @param {Set<string>} keys      held key codes
 * @param {{bank?:number, pitch?:number}} state   flight state (read-only here)
 * @param {number} dt             seconds
 * @param {{binds?:object, authority?:object}} [opts]
 * @returns {{bank:number, pitch:number, yawRate:number, flap:boolean,
 *            spoil:boolean, edges:string[]}}
 *   `edges`: one-shot intents the caller must debounce, because a held key is not a repeated event.
 */
export function pilotInput(keys, state, dt, opts = {}) {
  const B = { ...DEFAULT_BINDS, ...(opts.binds || {}) };
  const A = { ...DEFAULT_AUTHORITY, ...(opts.authority || {}) };

  let bank = state.bank ?? 0;
  let pitch = state.pitch ?? 0;

  const l = held(keys, B.bankLeft), r = held(keys, B.bankRight);
  if (l && !r) bank -= A.bankRate * dt;
  else if (r && !l) bank += A.bankRate * dt;
  else {
    // hands OFF, the wings roll level; hands ON, never: an autoleveller under a held turn is a second pilot with an opinion
    const back = Math.min(Math.abs(bank), A.levelReturn * dt);
    bank -= Math.sign(bank) * back;
  }
  bank = clamp(bank, -A.maxBank, A.maxBank);

  const d = held(keys, B.pitchDown), u = held(keys, B.pitchUp);
  if (d && !u) pitch -= A.pitchRate * dt;
  else if (u && !d) pitch += A.pitchRate * dt;
  else {
    const back = Math.min(Math.abs(pitch), A.levelReturn * dt);
    pitch -= Math.sign(pitch) * back;
  }
  pitch = clamp(pitch, -A.maxPitch, A.maxPitch);

  // a banked wing turns; there is no rudder (glide-biased, no yaw stick)
  const yawRate = A.turnPerBank * bank;

  const edges = [];
  if (held(keys, B.rehearseDown)) edges.push('down');
  if (held(keys, B.rehearseRecover)) edges.push('recover');

  return {
    bank, pitch, yawRate,
    flap: held(keys, B.flap),
    spoil: held(keys, B.spoil),
    edges,
  };
}

// airspeedAfter lives in flight.js; re-exported for one import
export { airspeedAfter } from './flight.js';

/** For a HUD. */
export function pilotHelp(binds = DEFAULT_BINDS) {
  return [
    'W/S  nose down / up (trade altitude for speed)',
    'A/D  bank left / right (a banked wing turns)',
    'Shift  spoil -- bleed altitude without gaining speed',
    'Space  flap (expensive: -2/s stamina, you are a glider)',
    'X  rehearse DOWN   R  rehearse RECOVER',
    'C  re-attach the chase camera (drag to look around)',
  ].join('\n');
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
