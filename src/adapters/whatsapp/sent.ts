import type { proto, WAMessage } from 'baileys';

const MAX_SENT = 500;
const SENT_TTL_MS = 60 * 60_000;

/**
 * What this daemon sent in the last hour, by message id, so a device that could not decrypt one
 * gets the real message again on its retry receipt. Keyed by id only: the receipt names the chat
 * the way the recipient sees it (phone or `@lid`), which can differ from the jid we sent to, and
 * ids are random. Bounded by count and age, pruned on write, no timer. In memory only, never on disk.
 */
export class SentMessages {
  static readonly MAX = MAX_SENT;
  static readonly TTL_MS = SENT_TTL_MS;
  private byId = new Map<string, { message: proto.IMessage; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number { return this.byId.size; }

  /** Takes what `sock.sendMessage` returned. A result without an id or a message is ignored. */
  remember(sent: WAMessage | undefined): void {
    const id = sent?.key?.id;
    if (!id || !sent.message) return;
    const now = this.now();
    this.byId.delete(id); // a repeat goes to the back, as the newest
    this.byId.set(id, { message: sent.message, at: now });
    for (const [k, v] of this.byId) {
      if (now - v.at < SENT_TTL_MS && this.byId.size <= MAX_SENT) break;
      this.byId.delete(k);
    }
  }

  /** The message we sent under this id, or undefined. Never a blank stand-in: Baileys would resend it. */
  get(id: string | null | undefined): proto.IMessage | undefined {
    if (!id) return undefined;
    const e = this.byId.get(id);
    if (!e) return undefined;
    if (this.now() - e.at >= SENT_TTL_MS) { this.byId.delete(id); return undefined; }
    return e.message;
  }
}
