import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The chats whose turn was running when the daemon stopped. An orderly shutdown (SIGTERM, /restart,
 * WhatsApp dead) stops the adapters before the orchestrator (daemon.ts), so nothing can be said to those
 * chats then: the keys are written here first, and the daemon that starts next says one line in each.
 * Only an orderly shutdown writes the file: a crash, a SIGKILL or the exit timer firing before this ran
 * leaves the old silence. The messages are not replayed. WhatsApp delivers what was sent while the link
 * was down when it opens again (offline notifications, which the adapter takes as any message, with
 * repeats dropped by id); Telegram holds the updates nobody fetched for the next getUpdates. The message
 * whose turn was cut had been fetched and confirmed before the stop, as were the ones waiting behind it,
 * so only their senders can send them again.
 */
export const CUT_TURNS = 'cut-turns.json';
export const CUT_LINE = 'Angelia restarted while working on your message. Send it again.';
/** Older than this, the file is from a daemon nobody started again for a day; the chat has moved on. A
 *  reboot or a long update still gets the line, and a day is Telegram's own window for held updates. */
const CUT_TTL_MS = 24 * 3600_000;

export function writeCutTurns(stateDir: string, keys: string[]): void {
  if (!keys.length) return;
  writeFileSync(join(stateDir, CUT_TURNS), JSON.stringify({ keys, at: new Date().toISOString() }));
}

/** The keys the last shutdown wrote, and the file is gone; none when there is no file or it is stale. */
export function takeCutTurns(stateDir: string, now = Date.now()): string[] {
  const path = join(stateDir, CUT_TURNS);
  let note: { keys?: unknown; at?: string };
  try { note = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  try { unlinkSync(path); } catch {}
  if (!Array.isArray(note.keys) || !note.at || now - Date.parse(note.at) > CUT_TTL_MS) return [];
  return note.keys.filter((k): k is string => typeof k === 'string');
}
