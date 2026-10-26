#!/usr/bin/env bun
// The channel capability gates: do denied capabilities refuse the REQUEST, not just the gate function?
// Absence is denial (declaration.ts §5.4); a peer with no declaration at all keeps everything.

import { capabilityMatches, CAP } from '../mcpl/declaration.ts';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// the gate, extracted as net-server implements it (the wiring check at the bottom is the real assertion):
// plain-MCP hosts get no channel verbs, and a 0.5+ host is denied until its first featureSets/update (§5.3)
const capAllowed = (mcplClient, version, grant, cap) => {
  if (!mcplClient) return false;
  if (grant) return grant.some((g) => capabilityMatches(g, cap));
  const major = Number(version?.split('.')[0] ?? 0);
  const minor = Number(version?.split('.')[1] ?? 0);
  return !(major > 0 || minor >= 5);
};
const withGrant = (grant, cap) => capAllowed(true, '0.5', grant, cap);

// ---- the matcher itself (§5.4 path semantics) ------------------------------

ok('exact path grants', withGrant(['channels.publish'], CAP.channelsPublish));
ok('one-segment wildcard grants', withGrant(['channels.*'], CAP.channelsPublish));
ok('ANCESTOR PREFIX DOES NOT GRANT — the fail-closed rule',
   !withGrant(['channels'], CAP.channelsPublish));
ok('a sibling grant does not confer publish',
   !withGrant(['channels.incoming'], CAP.channelsPublish));
ok('a sibling grant does not confer lifecycle',
   !withGrant(['channels.incoming'], CAP.channelsLifecycle));
ok('tools does not confer channels',
   !withGrant(['tools'], CAP.channelsPublish));
ok('bare * does not span two segments',
   !withGrant(['*'], CAP.channelsPublish));
ok('an EMPTY grant list denies (declared, granted nothing)',
   !withGrant([], CAP.channelsPublish));
// the three fences the first extraction missed
ok('plain-MCP host (never declared MCPL) gets NO channel verbs',
   !capAllowed(false, null, null, CAP.channelsPublish));
ok('0.5 host with no policy yet is DENIED (deny-until-policy window)',
   !capAllowed(true, '0.5', null, CAP.channelsPublish));
ok('legacy 0.4 MCPL host with no policy keeps everything',
   capAllowed(true, '0.4', null, CAP.channelsPublish));
ok('0.5 host whose featureSets/update OMITS effectiveCapabilities stays denied (fail-closed, §5.4)',
   !capAllowed(true, '0.5', null, CAP.channelsPublish));  // update-without-grant leaves grant null

// ---- the wiring: is the gate actually CALLED at each verb? ------------------
// a predicate test passes while nothing invokes it: read the source and require a gate in each case block

const src = await Bun.file(new URL('../mcpl/net-server.ts', import.meta.url)).text();

const gatedCase = (caseName, capConst) => {
  const at = src.indexOf(`case method.${caseName}:`);
  if (at < 0) return { ok: false, why: `case ${caseName} not found` };
  // the case body up to the next `case ` at the same level: enough to see whether a gate precedes the work
  const body = src.slice(at, at + 700);
  const gate = body.indexOf(`capAllowed(CAP.${capConst})`);
  if (gate < 0) return { ok: false, why: `no capAllowed(CAP.${capConst}) in the case body` };
  return { ok: true };
};

for (const [caseName, capConst] of [
  ['CHANNELS_PUBLISH', 'channelsPublish'],
  ['CHANNELS_OPEN', 'channelsLifecycle'],
  ['CHANNELS_CLOSE', 'channelsLifecycle'],
]) {
  const r = gatedCase(caseName, capConst);
  ok(`${caseName} is gated on ${capConst}`, r.ok, r.why);
}

// typing is a NOTIFICATION: the gate drops it silently (no refusal), before the relay starts
{
  const at = src.indexOf('private onTyping(');
  const body = at >= 0 ? src.slice(at, at + 1400) : '';
  const gate = body.indexOf('capAllowed(CAP.channelsTyping)');
  const start = body.indexOf('this.typing.start(');
  ok('channels/typing is gated on channelsTyping', gate >= 0);
  ok('the typing gate precedes the relay starting', gate >= 0 && start >= 0 && gate < start);
  ok('nothing acts on a chunk of the generation stream', !src.includes('method.CHANNELS_OUTGOING_CHUNK'));
  // the signal is taken from the connection's notification event only: the serve loop also reads every notification
  // from its queue and must not act on it twice
  ok('the typing signal is handled in one place, the notification listener',
     src.split('method.CHANNELS_TYPING').length === 2 && src.split('this.onTyping(').length === 2 &&
     /this\.conn\.on\("notification"[\s\S]{0,200}method\.CHANNELS_TYPING[\s\S]{0,200}this\.onTyping\(/.test(src));
}

// a host sends channels/typing only under a channels.typing grant and grants only what's advertised, so the
// advertisement and the feature set turn the dots on
{
  const { MCPL_ADVERTISEMENT, FEATURE_SETS } = await import('../mcpl/declaration.ts');
  ok('the door advertises channels.typing', MCPL_ADVERTISEMENT.channels.typing === true);
  ok('eidoverse.typing uses channels.typing', FEATURE_SETS['eidoverse.typing'].uses.includes(CAP.channelsTyping));
  ok('the door does not advertise channels.streaming', MCPL_ADVERTISEMENT.channels.streaming === false);
  ok('no feature set uses channels.streaming',
     Object.values(FEATURE_SETS).every((fs) => !fs.uses.includes('channels.streaming')));
}

// the body's speech ends the dots: each body gets a hook that stops the relay, and travel hands it on (no other test
// drives a travelled body)
{
  const ctorAt = src.indexOf('this.channelId = `world:${this.agent.world}`;');
  const ctor = ctorAt >= 0 ? src.slice(ctorAt, ctorAt + 400) : '';
  ok('the session gives its first body a say hook that stops the relay',
     ctor.includes('this.agent.onSaid = () => this.typing.stop();'));
  const travelAt = src.indexOf('next.onEvent = old.onEvent;');
  const travel = travelAt >= 0 ? src.slice(travelAt, travelAt + 1600) : '';
  const handed = travel.indexOf('next.onSaid = old.onSaid;');
  const taken = travel.indexOf('old.onSaid = null;');
  ok('travel hands the say hook to the next body before taking it from the old one',
     handed >= 0 && taken >= 0 && handed < taken);
}

// tools/list and tools/call were the original offenders: keep them pinned
for (const m of ['tools/list', 'tools/call']) {
  const at = src.indexOf(`case "${m}"`);
  ok(`${m} consults toolsAllowed()`,
     at >= 0 && src.slice(at, at + 600).includes('toolsAllowed()'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
