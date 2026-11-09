/**
 * Group metadata for a short while. Baileys asks the server for a group's members on every group send
 * unless `cachedGroupMetadata` answers, and a tagged reply asks once more before that: one answer in
 * three parts would be six queries, and WhatsApp answers a burst with rate-overlimit. An entry lives
 * `ttlMs` and is dropped as soon as the group or its members change, so a new member is never left out
 * of the sender keys for long.
 */
export class GroupCache<T> {
  private entries = new Map<string, { at: number; value: T }>();
  constructor(private readonly ttlMs = 60_000, private readonly now: () => number = Date.now) {}

  get(jid: string): T | undefined {
    const e = this.entries.get(jid);
    if (!e) return undefined;
    if (this.now() - e.at >= this.ttlMs) { this.entries.delete(jid); return undefined; }
    return e.value;
  }

  set(jid: string, value: T): void {
    const now = this.now();
    // Expired entries go when a new one comes, so a group read once is not kept for good.
    for (const [k, e] of this.entries) if (now - e.at >= this.ttlMs) this.entries.delete(k);
    this.entries.set(jid, { at: now, value });
  }
  drop(jid: string | undefined | null): void { if (jid) this.entries.delete(jid); }
  clear(): void { this.entries.clear(); }
}
