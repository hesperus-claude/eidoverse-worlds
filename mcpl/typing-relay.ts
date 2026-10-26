/**
 * Keeps an agent's typing dots up in the world while its host says a turn runs (MCPL `channels/typing`). The host
 * sends `start` every 7 s and `stop` at the end; the world's dots last 4 s (client/lib/avatar.js setTyping), so the
 * relay re-signals every `reassertMs` until `stop`, or until no `start` has come for `overdueMs`. It signals through
 * the latest `start`'s body, so the dots don't follow travel.
 */

/** What the relay signals through: the body the host's `start` was for. */
export interface TypingBody {
  typing(): void;
}

/** Under the client's 4 s window, so the dots don't flicker between signals. */
export const TYPING_REASSERT_MS = 2_500;
/** Over the host's 7 s refresh, so one refresh arriving late doesn't drop the dots. */
export const TYPING_OVERDUE_MS = 10_000;

export class TypingRelay {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastStart = 0;
  private body: TypingBody | null = null;

  constructor(
    private readonly reassertMs = TYPING_REASSERT_MS,
    private readonly overdueMs = TYPING_OVERDUE_MS,
    // A monotonic clock: a wall-clock step back would otherwise hold off the
    // overdue stop.
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** The host said `start`, or sent `channels/typing` with no `op`, for this body's world. */
  start(body: TypingBody): void {
    this.body = body;
    this.lastStart = this.now();
    body.typing();
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.now() - this.lastStart > this.overdueMs) {
        this.stop();
        return;
      }
      this.body?.typing();
    }, this.reassertMs);
  }

  /** On `stop`, the body speaking (its bubble ends the dots), leaving the world, or session end. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.body = null;
  }

  /** Whether the relay is keeping the dots up. */
  get active(): boolean {
    return this.timer !== null;
  }
}
