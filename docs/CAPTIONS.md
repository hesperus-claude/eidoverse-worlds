# Screen captions: the `caption` request and the `captions` component

The rules a screen's captions follow, for everyone who writes or reads them: the authority
(`shared/protocol/authority/verbs.js`, `gate.js`), the door (`server/requestwire.ts`), the caption bot
(`tools/captionbot`), the agent's text-tier perception and any overlay. They all read one module,
`shared/captions.js`, so no two of them can describe a different screen. Where this page and that module
disagree, the module is right.

Not to be confused with the presence message `caption` in `docs/WIRE.md` (live speech pacing for a voice,
`{text, utt?}`), which never reaches the log.

## The request

```
caption {id, session, n, t0, t1, text, speaker?, title?}   # one line, once
caption {id, session, end: true}                            # the screen goes quiet
```

It folds into the screen's `captions` component:

```
captions = {session, n, gen, title?, line: {t0, t1, text, speaker?}}
```

- **One line per write.** Each write holds its own line, once, as a WebVTT cue is stored once. The log is the
  transcript: a reader that wants the last lines reads the screen's last `captions` changes
  (`captionsDetail(data, lines, earlier)`). An older stored value may carry `window` (an array of lines) and
  `mediaTime`; readers still accept both (`normalizeCaptions`).
- `end` deletes the component (`foldCaption` returns null). It clears current perception, not history.
- The title carries from line to line within a session; a new session starts fresh.

## Who may write

- Rights live on the **screen**, not on a role: the identities in its `captioners {ids}` component, or anyone who
  may edit the screen (`gate.js`; `roles.js` `CAPTION_ON_SCREENS`). Whoever may edit the screen sets `captioners`.
- A caption request writes only that screen's `captions`.
- A hand `set` of `captions` is refused (`caption-only`) unless the actor is an owner, who may set the value whole;
  an editor of the screen may delete it.

## Which captioner holds the screen: the live leg

- Every accepted join is issued a leg generation, `World.legGen()` = `openSeq × 1e6 + count`, where `openSeq` is
  past every seq the world had when it was opened. It rises within an opening and across restarts, and is never
  reused. A same-account join is a takeover that retires the older connection.
- The door stamps that generation onto every caption request (`args.gen = c.legGen`); a client cannot supply it.
- The bag remembers the `gen` that wrote it. A caption from a **lower** generation is refused as a superseded leg;
  an equal or higher one is accepted. Entries without a `gen` read as generation 0.
- So supersession is the authority's own fact, never a clock the captioner claims: a restart under a clock
  rollback still takes over (its leg is newer), a stale predecessor can't win with a "later" timestamp, and two
  captioners on one screen resolve to whichever joined last. The owner's recovery is `end`, or deleting the
  component.

## Session and `n`: dedupe before history

- `session` is the captioner's media-clock label, minted once at attach: `<ISO UTC attach time>-<2–16 letters or
  digits>` (`SESSION_RX`, `mintSession`), at most 64 characters. It says which attach a `00:30` belongs to, and
  sessions sort by attach time.
- Within a session `n` is a positive integer that rises line by line. The bag folds the high-water mark, and a
  caption at or below it is refused (`caption` refusal code) **before** it is appended. A resend after a lost
  receipt is therefore safe, and a reader never meets the same line twice under one clock: the refusal is the
  receipt.
- A caption under a different session (from a leg that isn't superseded) starts fresh.
- `end` must name the current session; an `end` for another session is refused, as is `end` on a screen with no
  captions.

## Times

`t0` and `t1` are **media time** in seconds, `0 ≤ t0 ≤ t1`, rounded to hundredths: the stream's own clock as far
as the captioner can know it. The caption bot today counts seconds since it attached to the stream. The meaning
of the field doesn't change when the source clock improves, only its accuracy.

## Bounds

In **characters** (`String.length`, UTF-16 code units), not bytes:

| field | max |
|---|---|
| `text` | 240 (`CAPTION_TEXT_MAX`) |
| `title` | 120 (`CAPTIONS_TITLE_MAX`) |
| `speaker` | 48 (`CAPTIONS_SPEAKER_MAX`) |
| `session` | 64 (`CAPTION_SESSION_MAX`) |
| `id` | 64 |

Whitespace runs collapse to one space and text is trimmed before the bound applies; `text`, `title`, `speaker` and `id`
are cut to their bound, a `session` over 64 is refused, and an empty text is refused.
`CAPTIONS_MAX_LINES` (20) clips an older value's `window` on read and is the default for `captionsDetail`; the bag
itself holds one line. Every stored value is also under the authority's 64 KiB of UTF-8 (`gate.js`).

## Retention

Captions are durable world testimony, like `say`. The caption bot keeps nothing the world doesn't already hold
(its spool is a delivery record: `docs/research/captionbot-delivery.md`).
