/** A message held outside the chain while it waits for something else (tmux mode: for a safe moment
 *  to go into the running turn). It counts as waiting, and `drop` takes it back as it takes back a
 *  queued job. */
export interface Held {
  /** `drop` took it back (a /stop, a /new, a restart that carries it to the next daemon): it must not run. */
  readonly dropped: boolean;
  /** It left the hold: went into the turn, or into the queue. Once only; later calls do nothing. */
  release(): void;
}

/** One in-flight job per key; later jobs wait in FIFO order. */
export class KeyedQueue {
  private chains = new Map<string, Promise<void>>();
  private depth = new Map<string, number>();
  /** Jobs not started yet, per key: what `drop` can still take back. */
  private waiting = new Map<string, number>();
  /** Bumped by `drop`: a job that reaches the front with an older number is skipped. */
  private gen = new Map<string, number>();
  /** What the caller said each waiting job is (enqueue's `tag`), until it starts or is dropped. */
  private tags = new Map<string, { mine: number; tag: unknown }[]>();
  /** Messages held outside the chain, per key, in the order they were held (hold), with their tags. */
  private held = new Map<string, Set<{ dropped: boolean; tag: unknown }>>();

  /** Runs `job` after the key's earlier jobs. Resolves undefined, without running it, when `drop`
   *  took it back while it waited. */
  enqueue<T>(key: string, job: () => Promise<T>, tag?: unknown): Promise<T | undefined> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const mine = this.gen.get(key) ?? 0;
    const entry = tag === undefined ? undefined : { mine, tag };
    if (entry) { const list = this.tags.get(key) ?? []; list.push(entry); this.tags.set(key, list); }
    const untag = () => {
      const list = this.tags.get(key);
      if (!entry || !list) return;
      const at = list.indexOf(entry);
      if (at >= 0) list.splice(at, 1);
      if (!list.length) this.tags.delete(key);
    };
    this.bump(this.depth, key, 1);
    this.bump(this.waiting, key, 1);
    let skipped = false;
    const run = prev.catch(() => {}).then(() => {
      // Dropped: no longer counted as waiting, nor in the depth (drop took it off both at once).
      untag();
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

  /** The tags of the jobs that wait for `key` now (not started, not dropped), in their order. */
  waitingTags(key: string): unknown[] {
    const now = this.gen.get(key) ?? 0;
    return (this.tags.get(key) ?? []).filter((e) => e.mine === now).map((e) => e.tag);
  }

  /** Hold one message for `key` outside the chain: counted in `queued`, taken back by `drop`. `tag`:
   *  what it is, as enqueue's (heldTags). */
  hold(key: string, tag?: unknown): Held {
    const t = { dropped: false, tag };
    let set = this.held.get(key);
    if (!set) this.held.set(key, set = new Set());
    set.add(t);
    return {
      get dropped() { return t.dropped; },
      release: () => {
        const s = this.held.get(key);
        if (s?.delete(t) && !s.size) this.held.delete(key);
      },
    };
  }

  /** Messages held for `key` now (hold). */
  holding(key: string): number {
    return this.held.get(key)?.size ?? 0;
  }

  /** The tags of the messages held for `key` now, in the order they were held (those with one). */
  heldTags(key: string): unknown[] {
    return [...(this.held.get(key) ?? [])].map((t) => t.tag).filter((t) => t !== undefined);
  }

  /** Running and waiting jobs for `key`, held messages included. */
  queued(key: string): number {
    return (this.depth.get(key) ?? 0) + this.holding(key);
  }

  /** Take back every job still waiting for `key`, and every message held for it (the running one is
   *  the caller's to stop). Returns how many: they resolve undefined when their turn comes, without
   *  running, and a held one reads `dropped`. */
  drop(key: string): number {
    const n = this.waiting.get(key) ?? 0;
    const held = this.held.get(key);
    // Off the depth now, not when each reaches the front: a message sent right after /stop must not
    // find the chat still full of jobs that will never run.
    if (n) { this.gen.set(key, (this.gen.get(key) ?? 0) + 1); this.waiting.delete(key); this.bump(this.depth, key, -n); }
    if (held) { for (const t of held) t.dropped = true; this.held.delete(key); }
    return n + (held?.size ?? 0);
  }

  private bump(m: Map<string, number>, key: string, by: number): void {
    const v = (m.get(key) ?? 0) + by;
    if (v > 0) m.set(key, v); else m.delete(key);
  }
}
