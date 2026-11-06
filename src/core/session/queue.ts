/** One in-flight job per key; later jobs wait in FIFO order. */
export class KeyedQueue {
  private chains = new Map<string, Promise<void>>();
  private depth = new Map<string, number>();
  /** Jobs not started yet, per key: what `drop` can still take back. */
  private waiting = new Map<string, number>();
  /** Bumped by `drop`: a job that reaches the front with an older number is skipped. */
  private gen = new Map<string, number>();

  /** Runs `job` after the key's earlier jobs. Resolves undefined, without running it, when `drop`
   *  took it back while it waited. */
  enqueue<T>(key: string, job: () => Promise<T>): Promise<T | undefined> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const mine = this.gen.get(key) ?? 0;
    this.bump(this.depth, key, 1);
    this.bump(this.waiting, key, 1);
    let skipped = false;
    const run = prev.catch(() => {}).then(() => {
      // Dropped: no longer counted as waiting, nor in the depth (drop took it off both at once).
      if ((this.gen.get(key) ?? 0) !== mine) { skipped = true; return undefined; }
      this.bump(this.waiting, key, -1);
      return job();
    });
    const settled = run.then(() => {}, () => {}).finally(() => {
      if (!skipped) this.bump(this.depth, key, -1);
      if (!this.depth.has(key) && this.chains.get(key) === settled) this.chains.delete(key);
    });
    this.chains.set(key, settled);
    return run;
  }

  /** Running and waiting jobs for `key`. */
  queued(key: string): number {
    return this.depth.get(key) ?? 0;
  }

  /** Take back every job still waiting for `key` (the running one is the caller's to stop). Returns
   *  how many: they resolve undefined when their turn comes, without running. */
  drop(key: string): number {
    const n = this.waiting.get(key) ?? 0;
    // Off the depth now, not when each reaches the front: a message sent right after /stop must not
    // find the chat still full of jobs that will never run.
    if (n) { this.gen.set(key, (this.gen.get(key) ?? 0) + 1); this.waiting.delete(key); this.bump(this.depth, key, -n); }
    return n;
  }

  private bump(m: Map<string, number>, key: string, by: number): void {
    const v = (m.get(key) ?? 0) + by;
    if (v > 0) m.set(key, v); else m.delete(key);
  }
}
