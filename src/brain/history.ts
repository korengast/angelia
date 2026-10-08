import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findTranscripts, projectFolder, projectsDir } from './transcripts.js';

/** One message a person would see in the conversation. */
export interface HistoryItem {
  role: 'user' | 'assistant';
  /** Plain text of the message: its text blocks joined with a blank line. */
  text: string;
  /** ISO timestamp of the (first) line the message came from. */
  at?: string;
  /** Names of the tools the assistant used in this message, each once, in order of first use. */
  tools?: string[];
}

export interface HistoryPage {
  items: HistoryItem[];
  /** Older visible messages exist before the first item. */
  more: boolean;
  /** With `more`: pass it as `before` to read the page of older messages. Opaque to a client. */
  cursor?: string;
}

const DEFAULT_LIMIT = 200;
/** A transcript larger than this is read from its end only: the read blocks the daemon, and a file
 *  past V8's string limit could not be read at all. The page then says older messages exist. */
export const HISTORY_MAX_BYTES = 32 * 1024 * 1024;

/** The file up to byte `end` (all of it when absent), or its last `max` bytes of that from a line
 *  start; `base` is where the buffer starts in the file, `cut` says the start was left out. */
function readTail(path: string, max: number, end?: number): { buf: Buffer; base: number; cut: boolean } {
  const size = Math.min(statSync(path).size, end ?? Infinity);
  if (size <= max) {
    const buf = end === undefined ? readFileSync(path) : readRange(path, 0, size);
    return { buf, base: 0, cut: false };
  }
  // One byte more than kept: when it is a newline, the kept part starts on a whole line.
  const buf = readRange(path, size - max - 1, max + 1);
  const skip = buf.indexOf(10) + 1;
  return { buf: buf.subarray(skip), base: size - max - 1 + skip, cut: true };
}

function readRange(path: string, from: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, length, from); } finally { closeSync(fd); }
  return buf;
}

type Block = { type?: unknown; text?: unknown; name?: unknown };
type Line = {
  type?: unknown;
  timestamp?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  isCompactSummary?: unknown;
  isVisibleInTranscriptOnly?: unknown;
  message?: { id?: unknown; content?: unknown };
};

const WRAPPERS = new Set(['system-reminder', 'local-command-caveat', 'local-command-stdout', 'local-command-stderr', 'task-notification', 'cross-session-message']);

/** A whole message that is nothing but wrappers Claude Code adds around the conversation, never typed
 *  by anyone. A scan, not a regex: the regex this replaces backtracked exponentially on a run of
 *  wrapper blocks with text after them (1 KB took 8 s, a little more took hours, on the daemon's
 *  thread, at every history read of that session). */
export function wrapperOnly(text: string): boolean {
  let rest = text.trimStart();
  if (!rest) return false;
  while (rest) {
    const open = /^<([a-z-]+)>/.exec(rest);
    if (!open || !WRAPPERS.has(open[1])) return false;
    const close = `</${open[1]}>`;
    const end = rest.indexOf(close, open[0].length);
    if (end === -1) return false;
    rest = rest.slice(end + close.length).trimStart();
  }
  return true;
}
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/** The text a user line shows, or undefined when the line is not a prompt anyone typed. */
function userText(content: unknown): string | undefined {
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    let images = 0;
    for (const b of content as Block[]) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      else if (b.type === 'image') images++;
      // tool_result blocks are the tools talking back, not the person.
    }
    if (!parts.length && !images) return undefined;
    text = parts.join('\n\n');
    if (!text.trim() && images) return '[image]';
  } else {
    return undefined;
  }
  if (wrapperOnly(text)) return undefined;
  // A slash command is written as <command-name>/x</command-name><command-message>…<command-args>…
  const cmd = COMMAND_NAME.exec(text);
  if (cmd && text.trimStart().startsWith('<command-')) {
    const args = COMMAND_ARGS.exec(text)?.[1]?.trim();
    return args ? `${cmd[1].trim()} ${args}` : cmd[1].trim();
  }
  text = text.replace(SYSTEM_REMINDER, '').trim();
  return text || undefined;
}

/**
 * Read a Claude Code transcript and return its last `limit` visible messages (default 200),
 * oldest first. `more` says older ones exist. A missing or unreadable file is an empty page;
 * a line that is not JSON is skipped.
 *
 * Visible means what the conversation shows a person: prompts and replies. Tool results, meta
 * lines, subagent (sidechain) lines, compaction summaries and Claude Code's own wrappers are
 * left out. Claude Code writes one assistant message as several lines (one per content block)
 * sharing a message id; those become one item.
 */
export function claudeHistory(path: string, opts: { limit?: number; maxBytes?: number; before?: string } = {}): HistoryPage {
  const limit = Math.max(0, Math.floor(opts.limit ?? DEFAULT_LIMIT));
  const before = opts.before !== undefined && /^\d{1,15}$/.test(opts.before) ? Number(opts.before) : undefined;
  let buf: Buffer, base: number, cut: boolean;
  try { ({ buf, base, cut } = readTail(path, opts.maxBytes ?? HISTORY_MAX_BYTES, before)); } catch { return { items: [], more: false }; }

  const items: HistoryItem[] = [];
  /** Where each item's first line starts in the file: the cursor for the page before it. */
  const offsets = new Map<HistoryItem, number>();
  const byId = new Map<string, { item: HistoryItem; texts: string[]; tools: Set<string> }>();

  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(10, start);
    if (end === -1) end = buf.length;
    const lineAt = base + start;
    const s = buf.toString('utf8', start, end);
    start = end + 1;
    // Cheap guard before parsing: most lines are bookkeeping of other types.
    if (!s.includes('"user"') && !s.includes('"assistant"')) continue;
    let o: Line;
    try { o = JSON.parse(s) as Line; } catch { continue; }
    if (!o || typeof o !== 'object' || o.isSidechain === true) continue;
    const at = typeof o.timestamp === 'string' ? o.timestamp : undefined;
    const msg = o.message;
    if (!msg || typeof msg !== 'object') continue;

    if (o.type === 'user') {
      if (o.isMeta === true || o.isCompactSummary === true || o.isVisibleInTranscriptOnly === true) continue;
      const text = userText(msg.content);
      if (text === undefined) continue;
      const item: HistoryItem = at ? { role: 'user', text, at } : { role: 'user', text };
      offsets.set(item, lineAt);
      items.push(item);
    } else if (o.type === 'assistant') {
      const content = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content;
      if (!Array.isArray(content)) continue;
      const id = typeof msg.id === 'string' ? msg.id : undefined;
      let entry = id ? byId.get(id) : undefined;
      if (!entry) {
        const item: HistoryItem = at ? { role: 'assistant', text: '', at } : { role: 'assistant', text: '' };
        entry = { item, texts: [], tools: new Set() };
        if (id) byId.set(id, entry);
        offsets.set(item, lineAt);
        items.push(item);
      }
      for (const b of content as Block[]) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) entry.texts.push(b.text);
        else if (b.type === 'tool_use' && typeof b.name === 'string') entry.tools.add(b.name);
        // thinking, redacted_thinking and anything newer: not shown.
      }
      entry.item.text = entry.texts.join('\n\n');
      if (entry.tools.size) entry.item.tools = [...entry.tools];
    }
  }

  // An assistant message made only of thinking has nothing to show.
  const visible = items.filter((i) => i.role === 'user' || i.text !== '' || i.tools?.length);
  const from = Math.max(0, visible.length - limit);
  const page = visible.slice(from);
  const more = from > 0 || cut;
  const first = page[0] ? offsets.get(page[0]) : undefined;
  return more && first !== undefined && first > 0 ? { items: page, more, cursor: String(first) } : { items: page, more };
}

/**
 * The transcript of `sessionId`: under the cwd's own project folder first (where `claude --resume`
 * looks first), else the largest copy anywhere under `root`. Undefined when there is none.
 */
export function claudeTranscriptFor(cwd: string, sessionId: string, root: string = projectsDir()): string | undefined {
  const here = join(root, projectFolder(cwd), `${sessionId}.jsonl`);
  try { const st = statSync(here); if (st.isFile() && st.size > 0) return here; } catch { /* not here */ }
  return findTranscripts(sessionId, root)[0];
}

type PiEntry = { type?: unknown; id?: unknown; parentId?: unknown; timestamp?: unknown; message?: { role?: unknown; content?: unknown } };
const PI_CURSOR = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Read a pi session file (format v3, docs/session-format.md in pi's package) and return its last
 * `limit` visible messages, oldest first, like claudeHistory. A pi session is a tree: entries link
 * by `parentId`, and the conversation is the path from the last entry back to the root, so branches
 * left with `/tree` are not shown. Compaction does not hide older messages (a person saw them).
 *
 * Visible: user messages and assistant messages with text or tool calls. System prompts, tool
 * results, extension messages and summaries are left out. The cursor is the id of the first entry
 * of the page; a file over `maxBytes` is read from its end, and its older part is not reachable.
 */
export function piHistory(path: string, opts: { limit?: number; maxBytes?: number; before?: string } = {}): HistoryPage {
  const limit = Math.max(0, Math.floor(opts.limit ?? DEFAULT_LIMIT));
  const before = opts.before !== undefined && PI_CURSOR.test(opts.before) ? opts.before : undefined;
  let buf: Buffer, cut: boolean;
  try { ({ buf, cut } = readTail(path, opts.maxBytes ?? HISTORY_MAX_BYTES)); } catch { return { items: [], more: false }; }

  const byId = new Map<string, PiEntry>();
  let leaf: string | undefined;
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(10, start);
    if (end === -1) end = buf.length;
    const s = buf.toString('utf8', start, end);
    start = end + 1;
    let o: PiEntry;
    try { o = JSON.parse(s) as PiEntry; } catch { continue; }
    if (!o || typeof o !== 'object' || o.type === 'session' || typeof o.id !== 'string') continue;
    byId.set(o.id, o);
    leaf = o.id;
  }

  // Walk from the leaf to the root. A parent missing from the read part means older entries exist.
  const path_: PiEntry[] = [];
  const seen = new Set<string>();
  let missing = false;
  for (let id: unknown = leaf; typeof id === 'string' && !seen.has(id); ) {
    seen.add(id);
    const e = byId.get(id);
    if (!e) { missing = true; break; }
    path_.push(e);
    id = e.parentId;
  }
  path_.reverse();

  const items: { id: string; item: HistoryItem }[] = [];
  for (const e of path_) {
    if (e.type !== 'message' || !e.message || typeof e.message !== 'object') continue;
    const at = typeof e.timestamp === 'string' ? e.timestamp : undefined;
    const { role, content } = e.message;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Block[]) : [];
    const texts: string[] = [];
    const tools: string[] = [];
    let images = 0;
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) texts.push(b.text);
      else if (b.type === 'image') images++;
      else if (b.type === 'toolCall' && typeof b.name === 'string' && !tools.includes(b.name)) tools.push(b.name);
    }
    let item: HistoryItem;
    if (role === 'user') {
      const text = texts.join('\n\n') || (images ? '[image]' : '');
      if (!text) continue;
      item = { role: 'user', text };
    } else if (role === 'assistant') {
      if (!texts.length && !tools.length) continue;
      item = { role: 'assistant', text: texts.join('\n\n') };
      if (tools.length) item.tools = tools;
    } else {
      continue;
    }
    if (at) item.at = at;
    items.push({ id: e.id as string, item });
  }

  let to = items.length;
  if (before !== undefined) {
    const i = items.findIndex((x) => x.id === before);
    to = i === -1 ? 0 : i;
  }
  const from = Math.max(0, to - limit);
  const page = items.slice(from, to);
  const more = from > 0 || ((cut || missing) && page.length > 0);
  return more && page[0] && from > 0 ? { items: page.map((x) => x.item), more, cursor: page[0].id } : { items: page.map((x) => x.item), more };
}
