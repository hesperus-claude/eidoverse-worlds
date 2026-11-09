// flightplan — a filed flight plan as a behaviors-sandbox script: an experiment for the PLAN layer of
// docs/history/FLIGHT-MCP-INTERFACE.md (its appendix says why this cannot ship as-is).
// A plan is a list of legs; one verb is emitted per tick until a live verb cancels it or the list runs out.
//   knobs: { legs: [ {verb, args}, ... ], tick: 5 }

const LEGS = Array.isArray(world.knobs.legs) ? world.knobs.legs : [];
const TICK = Math.max(5, Number(world.knobs.tick) || 5);

function leg() { return Number(world.kv.get('leg') ?? 0); }
function setLeg(n) { world.kv.set('leg', n); }
function cancelled() { return world.kv.get('cancelled') === true; }

// A live verb outranks the plan; the pilot saying "cancel" stands in for one here.
world.on('say', (e) => {
  if (e.by === world.knobs.pilot && /^\s*cancel\b/i.test(e.text)) {
    world.kv.set('cancelled', true);
    world.log('plan cancelled by a live verb from', e.by);
  }
});

world.every(TICK, () => {
  if (cancelled()) return;
  const i = leg();
  if (i >= LEGS.length) {
    if (world.kv.get('done') !== true) {
      world.kv.set('done', true);
      world.log('plan complete —', LEGS.length, 'legs');
    }
    return;
  }
  const l = LEGS[i] || {};
  world.log(`leg ${i + 1}/${LEGS.length}:`, l.verb, JSON.stringify(l.args ?? {}));
  try {
    world.emit(l.verb, l.args ?? {});
    setLeg(i + 1);
  } catch (err) {
    // a refused emit throws: say so and halt rather than retry every tick
    world.log('leg refused:', String(err && err.message || err), '— plan halted');
    world.kv.set('cancelled', true);
  }
});
