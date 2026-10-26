// shared/protocol/authority/ctx.js — the authority's per-call state, ONE object. request() and withAuthority() set it
// through enter(), which saves and restores it whole, so a nested call never resets the outer call's state; nothing in
// the authority awaits, so calls can't interleave. A leaf on purpose: it imports nothing.
//   cat      the world's model catalogue ({get, list}); authority.js sets the lab's at load, request() the world's
//   through  the request's throughLock flag
//   isAnon   is this identity a guest (the directory's kind "anon")? from w.kindOf
//   knownId  the directory knows this identity (a world without a directory, as in the lab, knows everyone)
//   nameOf   a person's name as they spell it (io.nameOf), for a refusal's words
//   mintW    the world whose ids a mint must avoid (§3d H7)
//   work     the call's work budget {left, until, k}; outside any call (a test reading the index): no budget
//   forking  the server's own fork copy is in progress (forkCopy → request("fork-copy")); set outside enter(), carried through it
//   operator the identity whose recorded operator repair is in progress, else false (operatorRepair → request): only @world's door components
//            (roles:*, access, default-role, role-defs) and lifting a ban or kick pass without the world's own rights;
//            set outside enter(), carried through it
export const CTX = {
  cat: null, through: false, isAnon: () => false, knownId: (_id) => true, nameOf: null, mintW: null,
  work: { left: Infinity, until: Infinity, k: 0 }, forking: false, operator: false,
};
// UP: functions a leaf calls in a layer ABOVE it; a leaf may not import those (authority-layers-check: no cycles), so
// it forwards over UP, which authority.js binds once at load. Not per-call state: enter() never saves UP.
export const UP = {};
