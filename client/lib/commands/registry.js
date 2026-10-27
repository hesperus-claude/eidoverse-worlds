// The command registry — the WHOLE command surface, the one source of dispatch and autocomplete (§24l R1).
// Imports NOTHING, ever: a dependency closes the chat → commands → net → chat cycle (§14.2). Handlers register from handlers.js.
// `listed: false` = dispatchable, not autocompleted; `aliasAsAction`: typing the alias IS the action (/pull lever1 → use "lever1 pull").

export const COMMANDS = [
  // RETIRED: kept unlisted so a typed name is told why instead of "unknown command"
  { name: 'w', aliases: ['whisper', 'r', 'reply'], listed: false, help: 'whisper was removed — world chat is public', retired: 'whisper was removed — world chat is public' },
  { name: 'emote', listed: false, help: '/emote is /anim now', retired: '/emote is /anim now: /anim <name> plays one of the action bar\'s anims (🎭, or number keys)' },
  { name: 'ghost', aliases: ['unghost'], listed: false, help: 'ghost was removed', retired: 'ghost was removed: there is no hidden presence in a world' },
  { name: 'name', aliases: ['rename'], help: 'what the world calls you (choose it at the authority: renaming mid-visit isn\'t supported yet)' },
  { name: 'me', help: 'describe an action — "/me waves"' },
  { name: 'anim', help: '/anim <name> — play one of the action bar\'s anims once (🎭, or number keys)' },
  { name: 'sit', help: '/sit [thing] [slot] — sit down, on a seat if one is near (or the one you name)' },
  { name: 'push', aliases: ['shove'], help: '/push [name] [power] — shove someone within reach (their client decides); /push <thing> works the thing' },
  { name: 'touch', help: '/touch [name] [point] [left|right] — reach out and rest a hand on someone (nearest person, their shoulder, your right hand by default); the hand tracks them until /letgo' },
  { name: 'letgo', aliases: ['release'], help: 'let go — lower your reaching hand (or just one: /letgo left|right)' },
  { name: 'eyes', help: '/eyes close|open — hold your eyes shut, if your rig has eyelid bones' },
  { name: 'pushable', help: '/pushable on|off — whether anyone’s shove can knock you over (your table’s shove for everyone; off by default; Settings ▸ body has the whole table)' },
  { name: 'kick', help: '/kick <name> [reason] — moderation: remove someone from this world (owner). Objects fly with /punt' },
  { name: 'punt', aliases: ['boot'], help: '/punt [thing|person] [power] — kick a thing at your feet into flight (C); a person\'s name is the ragdoll shove (their client decides)' },
  { name: 'grab', aliases: ['pickup', 'take'], help: '/grab [thing] — pick up the nearest thing you can carry, or the one named (T)' },
  { name: 'put', help: '/put — set down what you hold, straight down from your hand (T)' },
  { name: 'drop', help: '/drop — let go of what you hold: it falls' },
  { name: 'throw', aliases: ['toss'], help: '/throw [speed] — throw what you hold where you look (C)' },
  { name: 'epoch', aliases: ['physics'], help: '/epoch [tickMs] | off — owner: run physics in this world (throws and punts fly; the log records where they rest)' },
  { name: 'who', help: 'list everyone present' },
  { name: 'panels', help: '/panels <0.3–1> — desktop panel opacity, for when glass fails over a bright scene' },
  // registered so it's discoverable: the voice diagnostic for a phone with no console
  { name: 'audio', help: '/audio [stt|say] — why voice or captions are not working; `say` posts it to the room' },
  { name: 'role', help: 'what you may do here (or /role <name>: anyone this world has seen)' },
  { name: 'grant', help: '/grant <name> <role> [for 2h|forever] — owner (or grantRoles, below your rank); /grant * builder|inhabitant sets the newcomer role for everyone signed in' },
  { name: 'revoke', help: '/revoke <name> — take back a role; they hold this world\'s default again (in a world for people listed only, they must leave)' },
  { name: 'access', help: '/access invite-only|watch|public|open — who may come into this world (owner); /access alone shows it. World Settings › Access does this with buttons' },
  { name: 'members', help: 'who can come into this world, and until when' },
  { name: 'ban', help: '/ban <name> [reason] — ban someone from this world, here or not (owner)' },
  { name: 'unban', help: '/unban <name> — lift a ban here (owner)' },
  { name: 'bans', help: 'who is banned or muted here right now (moderators)' },
  // a handler with no row is unreachable: the table is the dispatch
  { name: 'mute', help: '/mute <name> [minutes, default 60] [voice|chat] [reason] — quiet someone ranked below you' },
  { name: 'unmute', help: '/unmute <name> — lift a mute' },
  { name: 'warn', help: '/warn <name> <reason> — a warning they see, kept in the moderation log' },
  { name: 'gban', help: '/gban <name> [reason] — ban from ALL worlds (operator)' },
  { name: 'gunban', help: '/gunban <name> — lift a global ban (operator)' },
  { name: 'gbans', help: 'list global bans (operator)' },
  { name: 'fork', aliases: ['copy'], help: '/fork <new-name> — copy this world as it stands into a new one (its chat stays here) (owner)' },
  { name: 'newworld', aliases: ['found'], help: '/newworld <name> [title] — found a new, empty world that you own (signed in)' },
  { name: 'reset', aliases: ['erase'], help: 'erase this world back to zero, archived not destroyed (owner)' },
  { name: 'goto', help: '/goto <name> — walk to someone' },
  { name: 'clear', help: 'clear your chat log' },
  { name: 'flight', help: 'why flight is (or is not) doing that — rig, capability, phase' },
  { name: 'help', help: 'open the help sheet' },
  // dispatchable but unlisted — reachable, just not autocomplete noise
  { name: 'use', aliases: ['pull', 'ring', 'open'], aliasAsAction: true, listed: false,
    help: '/use <thing> [action] — the universal interact' },
  { name: 'mount', aliases: ['attach'], listed: false, help: '/mount <thing> <onto> [slot]' },
  { name: 'dismount', aliases: ['detach'], listed: false, help: '/dismount <thing>' },
  { name: 'debug', listed: false, help: '/debug [n] — the world\'s flight recorder' },
];

/** The ONE alias truth; built lazily once, the table is a module-load constant. */
const byWord = new Map();
for (const row of COMMANDS) {
  byWord.set(row.name, row);
  for (const a of row.aliases ?? []) byWord.set(a, row);
}
export const resolveCommand = (word) => byWord.get(word) ?? null;

const handlers = new Map();

/** Last registration wins; there is one boot pass, so a collision is a bug. */
export function register(name, fn) { handlers.set(name, fn); }

/** False for an unknown name: the caller picks silence or a complaint. */
export function dispatch(cmd, arg) {
  const fn = handlers.get(cmd);
  if (!fn) return false;
  fn(arg);
  return true;
}
