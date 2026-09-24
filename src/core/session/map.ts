import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionMapFile, ChatSessions, SessionRow } from '../types.js';

const LABEL_MAX = 60;
const LIST_LIMIT = 10;

export class SessionMap {
  private data: SessionMapFile;

  constructor(private readonly path: string) {
    this.data = this.read();
  }

  private read(): SessionMapFile {
    if (!existsSync(this.path)) return { version: 1, chats: {} };
    const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<SessionMapFile>;
    return { version: 1, chats: raw.chats ?? {} };
  }

  private write(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
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

  keys(): string[] {
    return Object.keys(this.data.chats);
  }
}

function cleanLabel(s: string): string {
  return s.split(/\s+/).join(' ').trim().slice(0, LABEL_MAX);
}
