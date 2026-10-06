import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionMapFile, ChatSessions, SessionRow } from '../types.js';

const LABEL_MAX = 60;
const LIST_LIMIT = 10;
/** Rows kept per chat: past this the oldest that are neither active nor in the background go. Every
 *  turn rewrites the whole file, and /resume shows ten. */
const HISTORY_MAX = 200;

export class SessionMap {
  private data: SessionMapFile;

  /** `warn`: told when a damaged file was moved aside, so the daemon can log it. */
  constructor(private readonly path: string, private readonly warn: (line: string) => void = () => {}) {
    this.data = this.read();
  }

  /** A file that cannot be read (half written by a power cut, edited by hand) is moved aside and the
   *  map starts empty: one lost list of sessions, instead of a daemon that never starts again. */
  private read(): SessionMapFile {
    if (!existsSync(this.path)) return { version: 1, chats: {} };
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<SessionMapFile>;
      const chats = raw.chats ?? {};
      if (typeof chats !== 'object' || Array.isArray(chats) || Object.values(chats).some((c) => !c || !Array.isArray((c as ChatSessions).history))) throw new Error('not a session map');
      return { version: 1, chats };
    } catch (e) {
      // Only a file that is not a session map is set aside: a read error (permissions, the disk) is
      // not damage, and moving the file would lose every session for nothing.
      if (!(e instanceof SyntaxError) && (e as Error).message !== 'not a session map') throw e;
      const aside = `${this.path}.damaged-${Date.now()}`;
      renameSync(this.path, aside);
      this.warn(`sessions.json could not be read (${(e as Error).message}); moved to ${aside}, starting with no sessions`);
      return { version: 1, chats: {} };
    }
  }

  /** Written aside, flushed to disk, then renamed into place: neither a crash nor a power cut leaves
   *  half a file under the real name. */
  private write(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(this.data)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }

  private chat(key: string): ChatSessions {
    return (this.data.chats[key] ??= { active: null, history: [] });
  }

  getActive(key: string): SessionRow | undefined {
    const c = this.data.chats[key];
    if (!c?.active) return undefined;
    return c.history.find((r) => r.id === c.active);
  }

  /** Mint a new session id for the key; the old row stays in history. */
  startNew(key: string, label = ''): SessionRow {
    const c = this.chat(key);
    const now = new Date().toISOString();
    const row: SessionRow = { id: randomUUID(), created_at: now, last_used_at: now, turns: 0, started: false, label: cleanLabel(label) };
    c.history.push(row);
    c.active = row.id;
    if (c.history.length > HISTORY_MAX) {
      const keep = new Set([c.active, ...c.history.filter((r) => r.background_since).map((r) => r.id)]);
      // The least recently used go, not the oldest made: /resume brings an old session back to use.
      const drop = new Set(c.history.filter((r) => !keep.has(r.id)).sort((a, b) => a.last_used_at.localeCompare(b.last_used_at)).slice(0, c.history.length - HISTORY_MAX).map((r) => r.id));
      c.history = c.history.filter((r) => !drop.has(r.id));
    }
    this.write();
    return row;
  }

  /** Active row, minting one if the chat has none, or if the profile's CLI changed since the row started
   *  (a Claude session id means nothing to grok, and the other way round). */
  ensureActive(key: string, label = '', backend?: string): SessionRow {
    const row = this.getActive(key);
    if (row && backend && row.started && row.backend && row.backend !== backend) return this.startNew(key, label);
    return row ?? this.startNew(key, label);
  }

  /** Record a completed turn; the first one marks the session as started (so later spawns use --resume). */
  recordTurn(key: string, id: string, label = '', backend?: string): void {
    const row = this.chat(key).history.find((r) => r.id === id);
    if (!row) return;
    if (backend) row.backend = backend;
    row.turns += 1;
    row.started = true;
    row.last_used_at = new Date().toISOString();
    if (!row.label && label) row.label = cleanLabel(label);
    this.write();
  }

  /** Give a row the backend's own id (grok mints its own). Returns the id now on the row. */
  rename(key: string, oldId: string, newId: string): string {
    const c = this.chat(key);
    const row = c.history.find((r) => r.id === oldId);
    if (!row || oldId === newId) return oldId;
    row.id = newId;
    if (c.active === oldId) c.active = newId;
    this.write();
    return newId;
  }

  /** Session-only model / effort override. Undefined clears. */
  setOverride(key: string, o: { model?: string | null; effort?: string | null }): SessionRow | undefined {
    const row = this.getActive(key);
    if (!row) return undefined;
    if (o.model !== undefined) { if (o.model) row.model = o.model; else delete row.model; }
    if (o.effort !== undefined) { if (o.effort) row.effort = o.effort; else delete row.effort; }
    this.write();
    return row;
  }

  list(key: string, limit = LIST_LIMIT): SessionRow[] {
    return [...this.chat(key).history].sort((a, b) => b.last_used_at.localeCompare(a.last_used_at)).slice(0, limit);
  }

  /** selector: 1-based index into list(), or a uuid prefix into the full history. */
  setActive(key: string, selector: string): SessionRow | undefined {
    const c = this.chat(key);
    let row: SessionRow | undefined;
    if (/^\d{1,2}$/.test(selector)) row = this.list(key)[Number(selector) - 1];
    else {
      const hits = c.history.filter((r) => r.id.startsWith(selector));
      row = hits.length === 1 ? hits[0] : undefined;
    }
    if (!row) return undefined;
    c.active = row.id;
    this.write();
    return row;
  }

  /** Make a session that started outside Angelia (a terminal, `/angelia-handoff`) the chat's active one.
   *  An id the chat knows already is switched to, with the new label. */
  adopt(key: string, id: string, label: string, backend: string): SessionRow {
    const c = this.chat(key);
    const now = new Date().toISOString();
    let row = c.history.find((r) => r.id === id);
    if (row) { row.last_used_at = now; if (label) row.label = cleanLabel(label); }
    else c.history.push(row = { id, created_at: now, last_used_at: now, turns: 0, started: true, label: cleanLabel(label), backend });
    c.active = id;
    this.write();
    return row;
  }

  /** Mark or clear a session whose turn runs on in the background. */
  setBackground(key: string, id: string, since: Date | null): void {
    const row = this.data.chats[key]?.history.find((r) => r.id === id);
    if (!row) return;
    if (since) row.background_since = since.toISOString(); else delete row.background_since;
    this.write();
  }

  /** Every session marked as running in the background, with its chat. */
  background(): { key: string; row: SessionRow }[] {
    return Object.entries(this.data.chats).flatMap(([key, c]) => c.history.filter((r) => r.background_since).map((row) => ({ key, row })));
  }

  /** 1-based place of a session in `list()`, what `/resume N` takes; 0 when it is not listed. */
  position(key: string, id: string): number {
    return this.list(key).findIndex((r) => r.id === id) + 1;
  }

  keys(): string[] {
    return Object.keys(this.data.chats);
  }
}

function cleanLabel(s: string): string {
  return s.split(/\s+/).join(' ').trim().slice(0, LABEL_MAX);
}
