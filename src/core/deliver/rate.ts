/**
 * Outbound ceiling (per minute, per platform) plus a randomised gap between chunks of one reply.
 *
 * Two kinds of send share it. `acquire` is for what a chat is waiting for: an answer, a permission
 * prompt, a command's reply. `acquireLow` is for progress lines: it takes a slot only when nothing
 * urgent is waiting and one more slot would still be left, so forty progress lines never hold the
 * answer: there is always room for it.
 */
export class RateLimiter {
  private stamps: number[] = [];
  private urgent = 0;
  constructor(
    private readonly perMinute: number,
    private readonly gapMs: [number, number] = [1500, 4000],
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly random: () => number = Math.random,
  ) {}

  /** Wait until a send is allowed; `first` skips the inter-chunk gap. */
  async acquire(first: boolean): Promise<void> {
    this.urgent++;
    try {
      if (!first) await this.sleep(this.gapMs[0] + (this.gapMs[1] - this.gapMs[0]) * this.random());
      while (!this.take()) await this.sleep(this.freeIn());
    } finally {
      this.urgent--;
    }
  }

  /** Wait for a slot nothing urgent wants. Gives up, returning false, once `cancelled()` says so. */
  async acquireLow(cancelled: () => boolean = () => false): Promise<boolean> {
    while (!cancelled()) {
      if (!this.urgent && this.take(1)) return true;
      // Short naps: a cancel (the turn ended) or an urgent send finishing should not wait a minute.
      await this.sleep(Math.min(this.freeIn(1) || 250, 1000));
    }
    return false;
  }

  /** Take a slot if `reserve` more would still be free after it. */
  private take(reserve = 0): boolean {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < 60_000);
    if (this.stamps.length + reserve >= this.perMinute) return false;
    this.stamps.push(t);
    return true;
  }

  /** Milliseconds until a stamp leaves the window and `reserve` + 1 slots are free; 0 when they are. */
  private freeIn(reserve = 0): number {
    const t = this.now();
    const live = this.stamps.filter((s) => t - s < 60_000);
    const over = live.length + reserve + 1 - this.perMinute;
    return over <= 0 ? 0 : live[Math.min(over, live.length) - 1] + 60_000 - t + 1;
  }
}

/**
 * The progress lines of one turn. Each line is queued and the call returns at once, so the turn
 * keeps reading the agent while the lines wait for the rate limit. Lines that pile up while waiting
 * go out together as one message. When the turn ends, `close` stops the sending and hands back what
 * was never sent, so the caller can put it in front of the answer instead of after it.
 */
export class ProgressOutbox {
  private pending: string[] = [];
  private running?: Promise<void>;
  private closed = false;
  /** The last line that reached the chat, so an answer that repeats it is not sent twice. */
  lastSent = '';

  constructor(private readonly rate: RateLimiter, private readonly send: (text: string) => Promise<void>, private readonly onError: (e: unknown) => void = () => {}) {}

  push(text: string): void {
    if (this.closed) return;
    this.pending.push(text);
    this.running ??= this.run().finally(() => { this.running = undefined; });
  }

  private async run(): Promise<void> {
    while (this.pending.length && !this.closed) {
      if (!(await this.rate.acquireLow(() => this.closed))) return;
      const batch = this.pending.splice(0);
      try { await this.send(batch.join('\n\n')); this.lastSent = batch[batch.length - 1]; }
      catch (e) { this.onError(e); }
    }
  }

  /** Stop, wait for a send in flight, and return the lines that never went out. */
  async close(): Promise<string[]> {
    this.closed = true;
    await this.running;
    return this.pending.splice(0);
  }
}
