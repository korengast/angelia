/** One in-flight job per key; later jobs wait in FIFO order. */
export class KeyedQueue {
  private chains = new Map<string, Promise<void>>();
  private depth = new Map<string, number>();

  enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    this.depth.set(key, (this.depth.get(key) ?? 0) + 1);
    const run = prev.catch(() => {}).then(job);
    const settled = run.then(() => {}, () => {}).finally(() => {
      const d = (this.depth.get(key) ?? 1) - 1;
      if (d <= 0) { this.depth.delete(key); if (this.chains.get(key) === settled) this.chains.delete(key); }
      else this.depth.set(key, d);
    });
    this.chains.set(key, settled);
    return run;
  }

  queued(key: string): number {
    return this.depth.get(key) ?? 0;
  }
}
