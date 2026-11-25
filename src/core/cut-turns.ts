import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionKey, type Inbound } from './types.js';

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

/**
 * The turns the last shutdown left running in a tmux pane, which runs on through a restart: the next
 * daemon reads each again for its chat (Orchestrator.restoreTurns), so the agent's answer and its
 * permission requests reach the chat as if nothing had happened. Their chats are not in CUT_TURNS.
 * `inbound`: the message the turn answers, so the answer goes where it came from. Mode 600: it holds the
 * message's words. Older than CUT_TTL_MS it is dropped, as the cut list is.
 */
export const ADOPT_TURNS = 'adopt-turns.json';
/** A message that waited behind the adopted turn: it runs after it, as it would have. */
export interface AdoptWaiting { inbound: Inbound; bare: boolean }
/** `joined`: the chat messages typed into the turn, with the id of each one's `turn` event; `absorbed`:
 *  the brain's own record of them (TuiBrain.midturnState). The next daemon types nothing more into an
 *  adopted turn (its reader is a follow, which takes no messages): what the chat sends meanwhile runs as
 *  turns of their own, after it. */
export interface AdoptTurn { key: string; session: string; since: number; inbound: Inbound; waiting?: AdoptWaiting[]; joined?: { i: Inbound; turn: string }[]; absorbed?: unknown[] }

export function writeAdoptTurns(stateDir: string, turns: AdoptTurn[]): void {
  const path = join(stateDir, ADOPT_TURNS);
  if (!turns.length) { try { unlinkSync(path); } catch { /* none */ } return; }
  // Written aside and renamed into place: the next daemon never reads half a file.
  writeFileSync(`${path}.tmp`, JSON.stringify({ turns, at: new Date().toISOString() }), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

const isInbound = (v: unknown): v is Inbound => !!v && typeof v === 'object' && typeof (v as Inbound).chat === 'string' && typeof (v as Inbound).platform === 'string';

/** The turns the last shutdown wrote, and the file is gone (a broken one too); none when there is no
 *  file or it is stale. */
export function takeAdoptTurns(stateDir: string, now = Date.now()): AdoptTurn[] {
  const path = join(stateDir, ADOPT_TURNS);
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return []; }
  try { unlinkSync(path); } catch {}
  let note: { turns?: unknown; at?: string };
  try { note = JSON.parse(raw); } catch { return []; }
  if (!note || !Array.isArray(note.turns) || !note.at || now - Date.parse(note.at) > CUT_TTL_MS) return [];
  return note.turns.filter((t): t is AdoptTurn => !!t && typeof t.key === 'string' && typeof t.session === 'string'
    && typeof t.since === 'number' && isInbound(t.inbound))
    .map((t) => ({
      ...t,
      waiting: Array.isArray(t.waiting) ? t.waiting.filter((w): w is AdoptWaiting => !!w && isInbound(w.inbound)).map((w) => ({ inbound: w.inbound, bare: w.bare === true })) : [],
      // Each one the turn's own chat's, under the id of its `turn` event: the file is data, never trusted blind.
      joined: Array.isArray(t.joined) ? t.joined.filter((j) => !!j && isInbound(j.i) && typeof j.turn === 'string' && sessionKey(j.i) === t.key).map((j) => ({ i: { ...j.i, turnId: j.turn }, turn: j.turn })) : [],
      absorbed: Array.isArray(t.absorbed) ? t.absorbed : [],
    }));
}
