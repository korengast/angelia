import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The chats whose turn was running, or waiting, when the daemon stopped. A shutdown (SIGTERM, /restart,
 * WhatsApp dead) stops the adapters before the orchestrator (daemon.ts), so nothing can be said to those
 * chats then: the keys are written here, and the daemon that starts next says one line in each. The
 * messages are not replayed: WhatsApp delivers what came while the link was down at the reconnect
 * (`append` batches, adapter.ts) and Telegram keeps unconfirmed updates for the next getUpdates, but the
 * message whose turn was cut had been taken already, so only its sender can send it again.
 */
export const CUT_TURNS = 'cut-turns.json';
export const CUT_LINE = 'Angelia restarted while working on your message. Send it again.';
/** Older than this, the file is from a daemon that never came back in time; the chat has moved on. */
const CUT_TTL_MS = 10 * 60_000;

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
