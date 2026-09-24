import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** A file from a chat is downloaded up to this size, on both platforms (Telegram's Bot API serves no more). */
export const MAX_INBOUND = 20 * 1024 * 1024;
/** One profile's .inbox stays under this; the oldest files go first. An open group cannot fill the disk. */
export const INBOX_LIMIT = { bytes: 500 * 1024 * 1024, files: 300 };
/** Files one sender may have downloaded per hour, per platform. Past it, the agent is told a file came. */
export const FILES_PER_SENDER_HOUR = 30;

class TooBig extends Error {}

/**
 * Stream a file from a chat into `<profile>/.inbox/` under a fresh name, capped at `max`: the declared
 * size is the sender's word. The name is Angelia's (time first, so the folder lists in order), and the
 * file is created with `wx`, so it never replaces or follows anything already there. Returns the path,
 * or undefined when the stream passed `max`; nothing is left behind either way.
 */
export async function saveInbound(profileDir: string, ext: string, source: AsyncIterable<Uint8Array>, max = MAX_INBOUND, limit = INBOX_LIMIT): Promise<string | undefined> {
  const dir = join(profileDir, '.inbox');
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${Date.now()}-${randomBytes(4).toString('hex')}${/^\.[A-Za-z0-9]{1,5}$/.test(ext) ? ext : ''}`);
  let n = 0;
  async function* capped() {
    for await (const c of source) { n += c.length; if (n > max) throw new TooBig(); yield c; }
  }
  try { await pipeline(Readable.from(capped()), createWriteStream(dest, { flags: 'wx', mode: 0o600 })); }
  catch (e) { rmSync(dest, { force: true }); if (e instanceof TooBig) return undefined; throw e; }
  pruneInbox(dir, limit, dest);
  return dest;
}

/** Drop the oldest files until the folder is within `limit`. `keep` (the file just written) always stays. */
export function pruneInbox(dir: string, limit = INBOX_LIMIT, keep?: string): string[] {
  const files = readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    try { const st = statSync(path); return st.isFile() ? [{ path, size: st.size, at: st.mtimeMs }] : []; } catch { return []; }
  }).sort((a, b) => b.at - a.at || (a.path === keep ? -1 : b.path === keep ? 1 : 0));
  const gone: string[] = [];
  let bytes = 0, count = 0;
  for (const f of files) {
    bytes += f.size; count++;
    if (f.path !== keep && (bytes > limit.bytes || count > limit.files)) { rmSync(f.path, { force: true }); gone.push(f.path); }
  }
  return gone;
}

/** How many files each sender has had downloaded in the last hour. */
export class SenderQuota {
  private seen = new Map<string, number[]>();
  constructor(private readonly perHour = FILES_PER_SENDER_HOUR, private readonly now = () => Date.now()) {}

  /** True, and counted, when `sender` may have one more file now. */
  take(sender: string): boolean {
    const cutoff = this.now() - 3600_000;
    for (const [k, v] of this.seen) { const kept = v.filter((t) => t > cutoff); if (kept.length) this.seen.set(k, kept); else this.seen.delete(k); }
    const list = this.seen.get(sender) ?? [];
    if (list.length >= this.perHour) return false;
    list.push(this.now());
    this.seen.set(sender, list);
    return true;
  }
}

/**
 * Work that must stay in order within a chat and must not hold any other chat: a file download before
 * the message that carries it is handed on. Each chat's jobs run one after another; chats run side by side.
 */
export class ChatChains {
  private tails = new Map<string, Promise<void>>();

  run(chat: string, job: () => Promise<void>): Promise<void> {
    const next = (this.tails.get(chat) ?? Promise.resolve()).then(job);
    const tail = next.catch(() => {});
    this.tails.set(chat, tail);
    void tail.then(() => { if (this.tails.get(chat) === tail) this.tails.delete(chat); });
    return next;
  }

  /** Resolves when every chat's jobs so far are done. */
  async idle(): Promise<void> {
    while (this.tails.size) await Promise.all([...this.tails.values()]);
  }
}
