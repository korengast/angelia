import { spawn } from 'node:child_process';
import type { Profile } from '../instance/config/schema.js';
import { childEnv } from './argv.js';
import { CHILD_GROUP, jsonLine, onJsonLines, trackGroup } from './brain.js';
import { endChild } from './grok-history.js';
import type { HistoryItem, HistoryPage } from './history.js';

type Item = { type?: unknown; text?: unknown; content?: unknown; tool?: unknown; server?: unknown };
type Turn = { items?: unknown; startedAt?: unknown; completedAt?: unknown };

/** How long one read may take before it is given up (a page took 65 ms on codex-cli 0.157). */
export const CODEX_HISTORY_TIMEOUT_MS = 20_000;
/** Turns per page at most: a turn is a prompt and its reply, two items or more. */
const MAX_TURNS = 50;

/** The tool a Codex item stands for, by the name a person would know, or undefined for a message,
 *  a tool's output, reasoning or a plan. */
function toolName(i: Item): string | undefined {
  switch (i.type) {
    case 'commandExecution': return 'shell';
    case 'fileChange': return 'apply_patch';
    case 'webSearch': return 'web_search';
    case 'imageView': return 'view_image';
    case 'imageGeneration': return 'image_generation';
    case 'collabAgentToolCall': return 'spawn_agent';
    case 'mcpToolCall': return typeof i.tool === 'string' ? (typeof i.server === 'string' ? `${i.server}.${i.tool}` : i.tool) : 'mcp';
    case 'dynamicToolCall': return typeof i.tool === 'string' ? i.tool : undefined;
    default: return undefined;
  }
}

const iso = (s: unknown) => (typeof s === 'number' && Number.isFinite(s) ? new Date(s * 1000).toISOString() : undefined);

/**
 * Turns as the Codex app-server returns them (`thread/turns/list`, itemsView full; codex-cli 0.157,
 * measured 2026-10-08), oldest first, as history items: per turn the prompt, then one reply with the
 * agent's messages joined by a blank line and the tools it used. Reasoning, plans and tool output
 * are left out.
 */
export function codexItems(turns: Turn[]): HistoryItem[] {
  const out: HistoryItem[] = [];
  for (const t of turns) {
    if (!t || typeof t !== 'object' || !Array.isArray(t.items)) continue;
    const started = iso(t.startedAt), ended = iso(t.completedAt) ?? started;
    const texts: string[] = [];
    const tools: string[] = [];
    for (const i of t.items as Item[]) {
      if (!i || typeof i !== 'object') continue;
      if (i.type === 'userMessage' && Array.isArray(i.content)) {
        const parts = (i.content as Item[]).map((c) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : c?.type === 'image' || c?.type === 'localImage' ? '[image]' : '')).filter(Boolean);
        if (parts.length) out.push({ role: 'user', text: parts.join('\n\n'), ...(started ? { at: started } : {}) });
      } else if (i.type === 'agentMessage') {
        if (typeof i.text === 'string' && i.text.trim()) texts.push(i.text);
      } else {
        const name = toolName(i);
        if (name && !tools.includes(name)) tools.push(name);
      }
    }
    if (texts.length || tools.length) out.push({ role: 'assistant', text: texts.join('\n\n'), ...(tools.length ? { tools } : {}), ...(ended ? { at: ended } : {}) });
  }
  return out;
}

/** Is `cursor` one Codex gave for `threadId`? Codex 0.157 cursors are JSON naming the thread
 *  (`requestedThreadId`); anything else is refused, so a cursor cannot reach a thread the chat never had. */
export function codexCursorFor(cursor: string, threadId: string): boolean {
  if (cursor.length > 2048) return false;
  try { const c = JSON.parse(cursor) as { requestedThreadId?: unknown }; return !!c && typeof c === 'object' && c.requestedThreadId === threadId; } catch { return false; }
}

/**
 * One page of a Codex thread, newest last, read by Codex itself: `codex app-server`, `initialize`,
 * `thread/turns/list` newest first from `before` (Codex's own cursor, opaque here), stop. The thread
 * need not be loaded and no model is called. `limit` counts messages, as for the other CLIs, and is
 * asked as half as many turns. Undefined when Codex does not know the thread or does not answer.
 */
export function codexHistory(profile: Profile, threadId: string, opts: { limit?: number; before?: string; bin?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<HistoryPage | undefined> {
  const turns = Math.min(MAX_TURNS, Math.max(1, Math.ceil((opts.limit ?? 200) / 2)));
  return new Promise((resolve) => {
    const child = spawn(opts.bin ?? 'codex', ['app-server'], { cwd: profile.cwd, env: childEnv(opts.env), stdio: ['pipe', 'pipe', 'ignore'], ...CHILD_GROUP });
    trackGroup(child);
    let done = false;
    const finish = (v: HistoryPage | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      endChild(child);
      resolve(v);
    };
    const timer = setTimeout(() => finish(undefined), opts.timeoutMs ?? CODEX_HISTORY_TIMEOUT_MS);
    child.on('error', () => finish(undefined));
    child.on('exit', () => finish(undefined));
    child.stdin.on('error', () => {});
    const send = (o: unknown) => child.stdin.write(jsonLine(o));
    onJsonLines(child.stdout, (m: Record<string, any>) => {
      // A request of Codex's own (an approval, a login refresh): refused, nothing runs here.
      if (m.id !== undefined && m.method) { send({ id: m.id, error: { code: -32601, message: `unsupported: ${m.method}` } }); return; }
      if (m.id === 1) {
        if (m.error) return finish(undefined);
        send({ method: 'initialized' });
        send({ id: 2, method: 'thread/turns/list', params: { threadId, limit: turns, sortDirection: 'desc', itemsView: 'full', ...(opts.before ? { cursor: opts.before } : {}) } });
      } else if (m.id === 2) {
        const data = m.result?.data;
        if (m.error || !Array.isArray(data)) return finish(undefined);
        const next = typeof m.result.nextCursor === 'string' && m.result.nextCursor ? m.result.nextCursor : undefined;
        const items = codexItems([...data].reverse());
        finish(next ? { items, more: true, cursor: next } : { items, more: false });
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'angelia', title: 'Angelia', version: '0' }, capabilities: { experimentalApi: true } } });
  });
}
