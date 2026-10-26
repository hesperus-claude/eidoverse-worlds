# Name escaping: one mapping, and where it isn't injective

`shared/protocol/names.js` is the one mapping from an engine name (an actor, an entity id, a role key, a component name) to
the §2.3 grammar. The old-world translator and the live authority both use it. If the two ever spelled one person
differently, nobody in a translated world would match their own role.

## The decision

A name the grammar already accepts, and that doesn't start with an escape prefix, is kept as it is. Anything else is
escaped: `x--` + the hex of its UTF-8 when that fits in 64 characters, else `h--` + the first 61 hex of its sha256 (which
can't be read back: `dec` returns null). Component names (`encName`) use the same two escapes, which start with a letter as
a component name must. An id already in the hashed form is kept, because it is what readers hold and send back.

## Why it is injective, and the two exceptions

A kept name never starts with `x--`, and starts with `h--` only in the hashed form; an escaped name always starts with one
or the other. `x--` names are distinct hex, and `h--` names collide only if sha256 does. The two exceptions:

1. A literal name already in the hashed form is kept, so it encodes to the same key as the long name whose sha256 it
   prefixes (`HASHED`).
2. A lone surrogate (half of a UTF-16 pair with no other half) is written in UTF-8 as U+FFFD's bytes, so names that differ
   only in which lone surrogate they hold escape alike; `dec` returns U+FFFD for it.

Neither is reachable on import. The translator maps an old log's names with `encRaw` / `encNameRaw`, which escape a name in
the hashed form like any other (an old log's names were never ids). And a log holding a lone surrogate anywhere doesn't
import at all: the translated log would carry it in an act's request, which the strict reader refuses (not I-JSON), so
nothing is written.

## Rejected: a letter prefix for component names

An earlier mapping escaped a name valid as an identity but not as a component (one that starts with a digit, `0abc`) by
prefixing `n`, giving `n0abc`, which is also what a genuine component called `n0abc` keeps: two old names, one name. Here a
component name the grammar refuses always takes the `x--` form, so `0abc` → `x--30616263` and `n0abc` stays `n0abc`.
