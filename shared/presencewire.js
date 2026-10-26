// Presence (present / away / busy): one field on the pose packet, relayed as sent (server/posecheck.ts passes `presence` as sent
// and normalises the voice and body fields below) and remembered for late joiners. Shared by client and server so both agree on the vocabulary.
export const PRESENCE_STATES = ['present', 'away', 'busy'];

export function presenceWire(state) {
  return PRESENCE_STATES.includes(state) ? { presence: state } : {};
}

export function applyPresenceWire(target, sample) {
  if (!target || !sample || !PRESENCE_STATES.includes(sample.presence)) return false;
  target.presence = sample.presence;
  return true;
}

// voice state: `mic` (microphone live), `hear` (receiving, not hushed). Booleans, optional: absent means the receiver knows
// NOTHING, not "can't hear you".
export function voiceWire(v) {
  const o = {};
  if (typeof v?.mic === 'boolean') o.mic = v.mic;
  if (typeof v?.hear === 'boolean') o.hear = v.hear;
  return o;
}

export function applyVoiceWire(target, sample) {
  if (!target || !sample) return false;
  let did = false;
  if (typeof sample.mic === 'boolean') { target.mic = sample.mic; did = true; }
  if (typeof sample.hear === 'boolean') { target.hear = sample.hear; did = true; }
  return did;
}

// body size: `scale` (body, eyes, stride and collider grow together) and `plateY` (m the nameplate hangs above the crown).
// ABSENCE MEANS DEFAULT (1 and 0); every receiver clamps (scale 0.5–2, plateY −0.3…+0.8 m) and reads non-finite as default.
export const BODY_SCALE_MIN = 0.5, BODY_SCALE_MAX = 2;
export const PLATE_Y_MIN = -0.3, PLATE_Y_MAX = 0.8;
const clampTo = (v, lo, hi, dflt) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
export const clampBodyScale = (v) => clampTo(v, BODY_SCALE_MIN, BODY_SCALE_MAX, 1);
export const clampPlateY = (v) => clampTo(v, PLATE_Y_MIN, PLATE_Y_MAX, 0);

export function bodyWire(b) {
  const o = {};
  const s = Math.round(clampBodyScale(b?.scale) * 100) / 100;      // 1% steps: what the slider offers
  const y = Math.round(clampPlateY(b?.plateY) * 100) / 100;        // 1 cm
  if (s !== 1) o.scale = s;
  if (y !== 0) o.plateY = y;
  return o;
}

/** Always writes both onto target, absence = default. → true when either changed (a receiver can skip the re-apply). */
export function applyBodyWire(target, sample) {
  if (!target || !sample) return false;
  const s = clampBodyScale(sample.scale), y = clampPlateY(sample.plateY);
  const did = target.scale !== s || target.plateY !== y;
  target.scale = s; target.plateY = y;
  return did;
}

// ---- one time base (spec/PHYSICS.md §5.1) ----
// optional `t` (capture time, authority's clock) and `seq` (sender's count); a capture time is used only when sane against its
// frame (not after it, not older than STALE_MS).
export const SAMPLE_STALE_MS = 1000;
export function sampleTime(pose, frameT) {
  const t = pose?.t;
  return typeof t === 'number' && Number.isFinite(t) && typeof frameT === 'number' && t <= frameT && t >= frameT - SAMPLE_STALE_MS ? t : frameT;
}

// ---- the state-sync lane's sample (spec/PHYSICS.md §4.3) ----
// What a live simulation authority streams for a THING (never a body). Reserved: refused until live authority exists.
// Absolute and latest-wins, so it can move to unreliable datagrams; rest is never a sample (it is logged).
//   id     the thing                         by     the identity simulating it (u-…)
//   aseq   authority sequence (touch, rest)  oseq   ownership sequence (grab); oseq beats aseq (Fiedler 2018)
//   t      capture time, authority's clock   p      position, world frame, m      q   orientation, unit quaternion
//   v      linear velocity, m/s, world       w      angular velocity, rad/s, world frame              sleep  at rest
export const STATE_SAMPLE_KEYS = ['id', 'by', 'aseq', 'oseq', 't', 'p', 'q', 'v', 'w', 'sleep'];
const finN = (x) => typeof x === 'number' && Number.isFinite(x);
const vecN = (a, n) => Array.isArray(a) && a.length === n && a.every(finN);
const counter = (x) => Number.isInteger(x) && x >= 0 && x <= 0xffffffff;
/** Why `x` isn't a state sample (a sentence), or null when it is one. */
export function stateSampleError(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return 'a state sample is an object {' + STATE_SAMPLE_KEYS.join(', ') + '}';
  for (const k of Object.keys(x)) if (!STATE_SAMPLE_KEYS.includes(k)) return `a state sample has no '${k}' (it is {${STATE_SAMPLE_KEYS.join(', ')}})`;
  for (const k of STATE_SAMPLE_KEYS) if (x[k] === undefined) return `a state sample needs ${k} (every sample is absolute and self-contained)`;
  if (typeof x.id !== 'string' || !x.id || x.id.length > 64) return 'id is the thing\'s id';
  if (typeof x.by !== 'string' || !/^u-[a-z2-7]{20}$/.test(x.by)) return 'by is the identity simulating it (u- + 20 letters)';
  if (!counter(x.aseq) || !counter(x.oseq)) return 'aseq and oseq are whole numbers ≥ 0 (32-bit, wrapping)';
  if (!finN(x.t)) return 't is the capture time on the authority\'s clock (ms)';
  if (!vecN(x.p, 3) || !vecN(x.v, 3) || !vecN(x.w, 3)) return 'p, v and w are [x, y, z]: m, m/s and rad/s in the world frame';
  if (!vecN(x.q, 4) || Math.abs(Math.hypot(...x.q) - 1) > 1e-3) return 'q is a unit quaternion [x, y, z, w]';
  if (typeof x.sleep !== 'boolean') return 'sleep is true or false';
  return null;
}
