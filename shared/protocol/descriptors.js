// shared/protocol/descriptors.js — one descriptor per engine component, derived from componentspec.js (the schema), adding
// the EDITOR'S VOCABULARY where it differs from the wire's: axis letters vs unit vectors, one rate in °/s vs degPerSec |
// period | rpm, light.daytime as a check, uniform scale vs [s, s, s], whole-value cards (Grabbable, Sockets, Reactions).
// A descriptor is {key, card, type?, fields: [{k, param, t, path, wire?: {to, from}, ui?}], extra}: key the registry name,
// card the record (RECORDS[card]), type the motion type when the key is shared, k the inspector address, param the record's
// name, t the field type, path the key in the wire value (null = whole), wire the editor↔wire translation.
// `ui` is widget facts only; HARD limits and units come from the registry, never here.
// def: false = no reset; absent = how an UNWRITTEN value draws; sparse = written only off default; clears = spellings a
// write retires; own = the card's own code writes it. Prose lives in editschema.js. A default RECORDS states that the
// registry never writes is decided per field as `absent` (spec/registry-pin.json D8; DECIDED below).

import { COMPONENTS, materialize } from './componentspec.js';

export const AXES = Object.freeze({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], '-x': [-1, 0, 0], '-y': [0, -1, 0], '-z': [0, 0, -1] });
/** A unit-axis vector's letter (x, -z), a letter as itself, anything else null. */
export function axisLetter(a) {
  if (typeof a === 'string') return Object.hasOwn(AXES, a.toLowerCase()) ? a.toLowerCase() : null;
  if (Array.isArray(a) && a.length === 3) for (const [k, v] of Object.entries(AXES)) if (v.every((c, i) => c === a[i])) return k;
  return null;
}
/** A letter's vector; a vector as itself; anything else null. */
export const axisVector = (a) => (typeof a === 'string' ? (Object.hasOwn(AXES, a.toLowerCase()) ? AXES[a.toLowerCase()] : null) : Array.isArray(a) && a.length === 3 ? a : null);
/** degPerSec, else 360 / period (seconds a turn), else an old rpm × 6. */
export const rateOf = (m) => (Number.isFinite(m?.degPerSec) ? m.degPerSec : Number.isFinite(m?.period) && m.period > 0 ? 360 / m.period : Number.isFinite(m?.rpm) ? m.rpm * 6 : undefined);

const AXIS = { to: (v) => axisVector(v) ?? v, from: (v) => axisLetter(v) ?? v };
const RATE = { to: (v) => v, from: (_, m) => rateOf(m) };
const NOON = { to: (b) => (b ? 'full' : 'dim'), from: (d) => d === 'full' };
const UNIFORM = { to: (s) => (typeof s === 'number' ? [s, s, s] : s), from: (v) => (Array.isArray(v) && v[0] === v[1] && v[1] === v[2] ? v[0] : v) };
const AMP = { to: (v) => v, from: (v, m) => v ?? m?.amplitude };   // the first protocol spelled a pendulum's amp `amplitude`

// the widget facts (ui) shared by the cards
const PHASE = { t: 'num', step: 5, deg: true, def: false };
const DEG = { t: 'num', step: 5, deg: true };
const SEC = { t: 'num', step: 0.1, dp: 2, softMin: 0.05 };
const RATE_UI = { t: 'num', step: 5, dp: 1 };

/** Where RECORDS states a default the registry never writes. Each is `absent` prose (what a reader DOES when the key is
 *  absent, not what the authority writes), and none registered: registering one changes every new component on the wire
 *  (a pin regeneration), and no reader needs it. */
const DECIDED = {
  // read from the registry, never restated
  'Pivot.pos': COMPONENTS.pivot.absentMeans.pos,
  'Collider.shape': COMPONENTS.collider.absentMeans.shape,
  'Pendulum.pivot': 'a whole thing swings about its Pivot component, else its origin [0, 0, 0] (before 10-16: [0, 2, 0], written as its pivot by a stored world\'s maintenance command); a part about its own origin',
  'Spin.pivot': 'it turns about its own Pivot component, else its origin [0, 0, 0]',
  'Path.points': 'no points: it stands still (the authority refuses a path with fewer than 2 points; the record\'s [] is the empty reading)',
  'Particles.at': '[0, 0, 0] in its own frame; in an older value, its origin (the registry says the same)',
  'Text.outlineColor': 'the edge takes the colour that contrasts with the text colour: black behind light text, white behind dark (the registry says the same)',
};

// per card: the registry fields it shows and the editor's spellings and widgets. `whole`: one JSON field. `extra`: the
// card's own derived rows. `floor`: the card IS its raw-JSON row. `writeDp`: wire decimals (ui.wdp overrides). `hand`:
// editschema's own. `ui.closed` is derived: an enum row is closed exactly where the registry names the enum.
const MOTION = {
  Pendulum: { type: 'pendulum', show: ['axis', 'amp', 'period', 'damp', 'maxAmp', 'phase', 'pivot'],
    editor: { amp: { wire: AMP, ui: { ...DEG, softMin: 0, softMax: Math.PI, def: false, clears: ['amplitude'] } }, period: { ui: { ...SEC, absent: 3.5 } }, damp: { ui: { t: 'num', step: 0.01, dp: 3, softMin: 0, softMax: 2, absent: 0 } }, phase: { ui: PHASE } } },
  Spin: { type: 'spin', show: ['axis', 'degPerSec', 'pivot', 'phase'], editor: { phase: { ui: PHASE } } },
  Orbit: { type: 'orbit', show: ['radius', 'center', 'degPerSec', 'phase', 'face'],
    editor: { radius: { ui: { t: 'num', step: 0.1, dp: 2 } }, phase: { ui: PHASE }, face: { ui: { t: 'check' } } } },
  Oscillate: { type: 'oscillate', show: ['axis', 'amp', 'period', 'phase'],
    editor: { amp: { wire: AMP, ui: { t: 'num', step: 0.05, dp: 2, softMin: 0, clears: ['amplitude'] } }, period: { ui: SEC }, phase: { ui: PHASE } } },
  Path: { type: 'path', show: ['points', 'speed', 'duration', 'loop', 'face'],
    editor: { speed: { ui: { t: 'num', step: 0.1, dp: 2 } }, duration: { ui: { t: 'num', step: 0.5, dp: 1, softMin: 0.1, def: false } }, loop: { ui: { t: 'enum', def: false } }, face: { ui: { t: 'check' } } } },
};
const MOTION_EDITOR = { axis: { wire: AXIS, ui: { t: 'enum', def: false, own: true } }, degPerSec: { param: 'rate', wire: RATE, ui: { ...RATE_UI, clears: ['rpm', 'period'] } } };
const CARDS = {
  Transform: { key: 'transform', hand: true, show: ['pos', 'q', 'scale'], editor: { scale: { wire: UNIFORM } } },
  Pivot: { key: 'pivot', extra: ['x', 'y', 'z'] },   // pivot.pos is a registered field
  Collider: { key: 'collider', editor: { shape: { ui: { t: 'enum', def: false } } } },
  // a mesh thing: shape from the table; its size's three channels are the card's own rows (extra), one vec3 on the wire
  Mesh: { key: 'mesh', show: ['shape'], extra: ['size.x', 'size.y', 'size.z'], editor: { shape: { ui: { t: 'enum' } } } },
  Light: { key: 'light', show: ['color', 'intensity', 'range', 'decay', 'important', 'daytime'], writeDp: null,
    editor: { color: { ui: { t: 'color' } }, intensity: { ui: { t: 'num', step: 1, dp: 0, softMax: 64 } }, range: { ui: { t: 'num', step: 1, dp: 0, softMin: 1, softMax: 40 } },
      decay: { ui: { t: 'num', step: 0.1, dp: 2 } },
      important: { ui: { t: 'check', sparse: true } }, daytime: { k: 'daytime', param: 'burnsAtNoon', wire: NOON, ui: { t: 'check', sparse: true } } } },
  // a motion's part is its KEY (motion:<part>), never a field of the value: the card's own row
  ...Object.fromEntries(Object.entries(MOTION).map(([card, m]) => [card, { key: 'motion', type: m.type, show: m.show, extra: ['part'], writeDp: 4, editor: { ...MOTION_EDITOR, ...m.editor } }])),
  Sockets: { key: 'sockets', whole: 'slots', hand: true },
  // hand: true: Transform, Sockets, Grabbable and Material (a draft: no descriptor) keep read/write hooks in editschema.js
  // (HAND); Grabbable's registry fields still draw and write through the table
  Grabbable: { key: 'grabbable', whole: 'spec', hand: true, show: ['enabled', 'who', 'steal', 'range', 'priority', 'hold', 'twoHanded', 'throw', 'release', 'returnAfter'], writeDp: 3, extra: ['anim', 'carries', 'fits', 'use', 'prompt'],
    editor: { enabled: { ui: { t: 'check' } }, who: { ui: { t: 'enum' } }, steal: { ui: { t: 'check' } }, range: { ui: { t: 'num', step: 0.1, dp: 2 } },
      priority: { ui: { t: 'num', step: 1, dp: 0, wdp: 0 } }, hold: { ui: { t: 'enum' } }, twoHanded: { ui: { t: 'check' } }, throw: { ui: { t: 'num', step: 0.1, dp: 2 } },
      release: { ui: { t: 'enum' } }, returnAfter: { ui: { t: 'num', step: 5, dp: 0 } } } },
  Openable: { key: 'openable', whole: 'spec', show: ['open', 'locked', 'angle', 'axis', 'slide', 'time', 'part'], writeDp: 6, extra: ['by'],
    editor: { open: { ui: { t: 'check' } }, locked: { ui: { t: 'check' } }, angle: { ui: { t: 'num', step: 15, deg: true } }, axis: { wire: AXIS, ui: { t: 'enum', own: true } },
      time: { ui: { t: 'num', step: 0.1, dp: 2 } } } },
  Parent: { key: 'parent', show: ['to', 'socket'], editor: { socket: { param: 'slot' } } },
  Reactions: { key: 'reactions', whole: 'actions', floor: true },
  Particles: { key: 'particles', show: ['effect', 'part', 'at', 'seed', 'playing', 'scale', 'params'], writeDp: 3, extra: ['param'],
    editor: { effect: { ui: { t: 'enum', def: false } }, playing: { ui: { t: 'check' } }, scale: { ui: { t: 'num', step: 0.1, dp: 2 } }, part: { ui: { t: 'text' } } } },
  Picture: { key: 'picture', show: ['src', 'width', 'alt', 'lit'], writeDp: 3,
    editor: { src: { ui: { t: 'text' } }, width: { ui: { t: 'num', step: 0.1, dp: 2, softMin: 0.05 } }, alt: { ui: { t: 'text' } }, lit: { ui: { t: 'enum', def: false } } } },
  Sound: { key: 'sound', show: ['src', 'playing', 'loop', 'volume', 'pitch', 'near', 'radius', 'spatial', 't0', 'alt'], writeDp: 3, extra: ['rings', 'mute'],
    editor: { src: { ui: { t: 'text' } }, alt: { ui: { t: 'text' } }, loop: { ui: { t: 'check' } }, spatial: { ui: { t: 'check' } },
      volume: { ui: { t: 'num', step: 0.05, dp: 2 } }, pitch: { ui: { t: 'num', step: 0.05, dp: 2 } },
      near: { ui: { t: 'num', step: 0.5, dp: 1, softMin: 0.1 } }, radius: { ui: { t: 'num', step: 1, dp: 0 } } } },
  Story: { key: 'story', editor: { title: { ui: { t: 'text' } }, text: { ui: { t: 'text' } }, marks: { ui: { t: 'text' } } } },
  Text: { key: 'text', show: ['text', 'size', 'width', 'align', 'color', 'outline', 'outlineColor', 'background', 'billboard', 'lit'], writeDp: 3, extra: ['plate'],
    editor: { text: { ui: { t: 'text' } }, size: { ui: { t: 'num', step: 0.01, dp: 2 } }, width: { ui: { t: 'num', step: 0.1, dp: 2 } },
      align: { ui: { t: 'enum' } }, color: { ui: { t: 'color' } }, outline: { ui: { t: 'check' } }, outlineColor: { ui: { t: 'color' } }, background: { ui: { t: 'color', def: false } }, billboard: { ui: { t: 'enum' } }, lit: { ui: { t: 'enum' } } } },
  LookAt: { key: 'look-at', show: ['target', 'mode', 'forward', 'up', 'yaw', 'pitch', 'speed', 'range'], writeDp: 3, extra: ['target@'],
    editor: { target: { ui: { t: 'ref' } }, mode: { ui: { t: 'enum' } }, forward: { ui: { t: 'enum' } }, up: { ui: { t: 'enum' } },
      speed: { ui: { t: 'num', step: 30, dp: 0, deg: true } }, /* stored rad/s, shown in degrees */ range: { ui: { t: 'num', step: 1, dp: 1, softMin: 0.1 } } } },
  Lock: { key: 'lock', whole: 'value', show: [] },   // true: the whole value is the row (no levels)
  Hidden: { key: 'hidden', whole: 'value' },
  Label: { key: 'label', whole: 'text' },
  Description: { key: 'description', whole: 'text' },
  Captions: { key: 'captions', whole: 'feed', show: [], floor: true },
  Stage: { key: 'stage', floor: true },
};

const TYPEOF = { boolean: 'bool', number: 'number', string: 'string' };
function build(card, c) {
  const def = COMPONENTS[c.key]; if (!def) throw new Error(`descriptors: ${card}'s key ${c.key} is not registered`);
  const typed = def.fields ?? c.own ?? {};
  const names = c.show ?? Object.keys(typed);
  const fields = [];
  if (c.whole) fields.push({ k: c.whole, param: c.whole, t: def.type ?? def.map ?? 'object', path: null });
  for (const path of names) {
    // a registry field, or (a name typed by its defaults alone: grabbable) a default it writes
    if (!(path in typed) && !(!def.fields && def.defaults && path in def.defaults)) throw new Error(`descriptors: ${card}.${path} is not a field of ${c.key}`);
    const e = c.editor?.[path] ?? {};
    const decided = DECIDED[`${card}.${path}`];
    for (const k of ['min', 'max', 'unit', 'hint']) if (e.ui && k in e.ui) throw new Error(`descriptors: ${card}.${path} states ${k} here; a field's limits, unit and doc are the registry's (componentspec ${c.key}.ranges / units / docs)`);
    // the registry's limits as the door judges them (gt is the slider's floor: editschema refuses the bound itself), its
    // unit (per motion type where a field's differs: motion.amp) and its one-line doc
    const r = def.ranges?.[path]; const u = def.units?.[path];
    const lim = r && r.maxLen === undefined && r.maxItems === undefined ? { ...(r.min !== undefined ? { min: r.min } : r.gt !== undefined ? { min: r.gt } : {}), ...(r.max !== undefined ? { max: r.max } : {}) } : {};
    const unit = u == null ? undefined : typeof u === 'string' ? (u.includes('|') ? null : u) : (u[c.type] ?? null);
    const doc = def.docs?.[path];
    const ui = e.ui ? { ...e.ui, ...lim, ...(unit && !e.ui.deg ? { unit } : {}), ...(e.ui.t === 'enum' && def.enums?.[path] ? { closed: true } : {}) } : null;
    fields.push({ k: e.k ?? path, param: e.param ?? e.k ?? path, t: typed[path] ?? TYPEOF[typeof def.defaults[path]] ?? 'any', path, ...(e.wire ? { wire: e.wire } : {}), ...(ui ? { ui: Object.freeze(ui) } : {}), ...(decided ? { absent: decided } : {}), ...(doc ? { doc } : {}), ...(lim.min !== undefined || lim.max !== undefined ? { range: Object.freeze(lim) } : {}), ...(unit ? { unit } : {}) });
  }
  return Object.freeze({ key: c.key, card, ...(c.type ? { type: c.type } : {}), fields: Object.freeze(fields.map(Object.freeze)), extra: Object.freeze([...(c.extra ?? [])]), ...(c.floor ? { floor: true } : {}), ...(c.hand ? { hand: true } : {}), ...(c.writeDp !== undefined ? { writeDp: c.writeDp } : {}) });
}
export const DESCRIPTORS = Object.freeze(Object.fromEntries(Object.entries(CARDS).map(([card, c]) => [card, build(card, c)])));
export const descriptorFor = (card) => DESCRIPTORS[card] ?? null;

/** With its defaults written in, as the AUTHORITY writes them: materialize(key, {type}). */
export const materializedOf = (card) => { const d = DESCRIPTORS[card]; return d ? materialize(d.key, d.type ? { type: d.type } : {}).value : null; };
/** The materialized value at its path, through `wire.from`. undefined = the registry writes nothing there (absentMeans). */
export function editorDefault(card, k) {
  const d = DESCRIPTORS[card]; const f = d?.fields.find((x) => x.k === k); if (!f || f.path == null) return undefined;
  const bag = materializedOf(card); const v = bag?.[f.path];
  const out = f.wire ? f.wire.from(v, bag) : v;
  return out === null ? undefined : out;
}
/** An editor value written to the wire: through `wire.to`. */
export function toWire(card, k, v) { const f = DESCRIPTORS[card]?.fields.find((x) => x.k === k); return f?.wire ? f.wire.to(v) : v; }
/** A card's field by its inspector address k. */
export const fieldOf = (card, k) => DESCRIPTORS[card]?.fields.find((x) => x.k === k) ?? null;
/** The address's own k, or (a keyed `<part>|<k>`, an indexed `<k>|<i>`) any segment the card declares as a field or
 *  derived row. null = the card names no such row. */
export function claimOf(card, k) {
  const d = DESCRIPTORS[card]; if (!d) return null;
  for (const seg of String(k).split('|')) { const f = d.fields.find((x) => x.k === seg); if (f) return f; if (d.extra.includes(seg)) return { k: seg, extra: true }; }
  return null;
}
/** Every registry key some descriptor speaks for. */
export const DESCRIBED_KEYS = Object.freeze([...new Set(Object.values(DESCRIPTORS).map((d) => d.key))]);
/** editschema.js HAND must hold a read and a write hook for each. */
export const HAND_CARDS = Object.freeze(Object.values(DESCRIPTORS).filter((d) => d.hand).map((d) => d.card));
/** Not raw JSON on the inspector's floor (the `floor` cards keep theirs there). */
export const CLAIMED_KEYS = Object.freeze([...new Set(Object.values(DESCRIPTORS).filter((d) => !d.floor).map((d) => d.key))]);
