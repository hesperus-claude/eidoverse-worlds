/**
 * Keeps an agent's typing dots up while its host says a turn runs (MCPL `channels/typing`). The host sends `start`
 * every 7 s; the world's dots last 4 s (client/lib/avatar.js setTyping), so the relay re-signals every `reassertMs`
 * until `stop`, or until no `start` for `overdueMs`. Signals through the latest `start`'s body, so the dots don't follow travel.
 */

export interface TypingBody {
  typing(): void;
}

/** Under the client's 4 s window, so the dots don't flicker. */
export const TYPING_REASSERT_MS = 2_500;
/** Over the host's 7 s refresh, so one late refresh doesn't drop the dots. */
export const TYPING_OVERDUE_MS = 10_000;

export class TypingRelay {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastStart = 0;
  private body: TypingBody | null = null;

  constructor(
    private readonly reassertMs = TYPING_REASSERT_MS,
    private readonly overdueMs = TYPING_OVERDUE_MS,
    // monotonic: a wall-clock step back would hold off the overdue stop
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** `start`, or `channels/typing` with no `op`. */
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

  get active(): boolean {
    return this.timer !== null;
  }
}
