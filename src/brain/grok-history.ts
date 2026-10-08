import { spawn } from 'node:child_process';
import type { Profile } from '../instance/config/schema.js';
import { grokArgv, childEnv } from './argv.js';
import { CHILD_GROUP, jsonLine, onJsonLines, signalGroup, trackGroup } from './brain.js';

/** End a reader's CLI: EOF, SIGTERM to its group, SIGKILL a little later if it is still there. */
export function endChild(child: { pid?: number; stdin: { end(): void }; exitCode: number | null; signalCode: NodeJS.Signals | null; kill(signal: NodeJS.Signals): boolean }): void {
  child.stdin.end();
  signalGroup(child, 'SIGTERM');
  setTimeout(() => { if (child.exitCode === null && child.signalCode === null) signalGroup(child, 'SIGKILL'); }, 3000).unref();
}
import type { HistoryItem, HistoryPage } from './history.js';

type Update = { sessionUpdate?: unknown; content?: { type?: unknown; text?: unknown }; kind?: unknown; _meta?: { promptIndex?: unknown; 'x.ai/tool'?: { name?: unknown } } };

/** How long one replay may take before it is given up (a load of a long session took about 3 s). */
export const GROK_REPLAY_TIMEOUT_MS = 30_000;

/** Text kept of one replay at most: past it the oldest messages are dropped (a long session's tool
 *  output is never kept, only what a person reads). */
export const GROK_REPLAY_MAX_CHARS = 8_000_000;

/**
 * The visible messages of a grok session, built from the `session/update` notifications ACP replays
 * on `session/load` (grok 1.0.40, measured 2026-10-08), one at a time, so a replay is never held
 * whole. Replay has no timestamps. A run of user chunks is one prompt (two prompts in a row stay two:
 * each carries its own promptIndex); everything the agent says until the next prompt is one reply,
 * its text pieces joined with a blank line where a tool call or a thought came between them, plus
 * the tools' names. Thoughts, tool output and command lists are left out.
 */
export class GrokItems {
  private list: { item: HistoryItem; texts: string[] }[] = [];
  private open = false;
  private prompt: unknown;
  private chars = 0;
  /** Older messages were dropped to stay under the limit. */
  cut = false;

  constructor(private readonly maxChars = GROK_REPLAY_MAX_CHARS) {}

  private start(role: 'user' | 'assistant', prompt?: unknown) {
    const cur = this.list.at(-1);
    if (cur?.item.role === role && (role === 'assistant' || prompt === undefined || prompt === this.prompt)) return cur;
    const c = { item: { role, text: '' } as HistoryItem, texts: [] as string[] };
    this.list.push(c);
    this.open = false;
    this.prompt = prompt;
    return c;
  }

  add(u: Update): void {
    if (!u || typeof u !== 'object') return;
    const text = u.content?.type === 'text' && typeof u.content.text === 'string' ? u.content.text : undefined;
    if (u.sessionUpdate === 'user_message_chunk' || u.sessionUpdate === 'agent_message_chunk') {
      if (text === undefined) return;
      const c = u.sessionUpdate === 'user_message_chunk' ? this.start('user', u._meta?.promptIndex) : this.start('assistant');
      // Chunks of one message are glued; a piece after a tool call starts a new paragraph.
      if (this.open) c.texts[c.texts.length - 1] += text; else { c.texts.push(text); this.open = true; }
      this.chars += text.length;
      while (this.chars > this.maxChars && this.list.length > 1) {
        this.chars -= this.list.shift()!.texts.reduce((n, t) => n + t.length, 0);
        this.cut = true;
      }
    } else if (u.sessionUpdate === 'tool_call') {
      const c = this.start('assistant');
      this.open = false;
      const named = u._meta?.['x.ai/tool']?.name;
      const name = typeof named === 'string' ? named : typeof u.kind === 'string' ? u.kind : undefined;
      if (name && !c.item.tools?.includes(name)) (c.item.tools ??= []).push(name);
    } else if (u.sessionUpdate === 'agent_thought_chunk') {
      // Not shown, but it ends the text piece before it, as a tool call does.
      this.open = false;
    }
  }

  items(): HistoryItem[] {
    return this.list
      .map(({ item, texts }) => ({ ...item, text: texts.map((t) => t.trim()).filter(Boolean).join('\n\n') }))
      .filter((i) => i.text !== '' || i.tools?.length);
  }
}

/** The items of a whole replay (tests, and anything that already holds one). */
export function grokItems(updates: Update[]): HistoryItem[] {
  const b = new GrokItems();
  for (const u of updates) b.add(u);
  return b.items();
}

/** One page of a replayed session: the last `limit` items before index `before` (all of them when
 *  absent). The cursor is the index of the page's first item; replay order never changes, and a
 *  session only grows at its end, so an index stays good. */
export function grokPage(items: HistoryItem[], opts: { limit?: number; before?: string; cut?: boolean } = {}): HistoryPage {
  const limit = Math.max(0, Math.floor(opts.limit ?? 200));
  const to = opts.before !== undefined && /^\d{1,9}$/.test(opts.before) ? Math.min(Number(opts.before), items.length) : items.length;
  const from = Math.max(0, to - limit);
  const page = items.slice(from, to);
  if (from > 0) return { items: page, more: true, cursor: String(from) };
  return { items: page, more: !!opts.cut && page.length > 0 };
}

/**
 * Ask grok for a session's conversation: start `grok agent stdio` as the profile would, `initialize`,
 * `session/load`, keep what it replays, stop it. No model is called. Measured on grok 1.0.40: a load
 * from a second process while the chat's own grok is running leaves that one working. Resolves to
 * undefined when grok does not know the session or does not answer.
 */
export function grokReplay(profile: Profile, sessionId: string, opts: { bin?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxChars?: number } = {}): Promise<{ items: HistoryItem[]; cut: boolean } | undefined> {
  return new Promise((resolve) => {
    const [bin, ...args] = grokArgv(profile, opts.bin ?? 'grok');
    const child = spawn(bin, args, { cwd: profile.cwd, env: childEnv(opts.env), stdio: ['pipe', 'pipe', 'ignore'], ...CHILD_GROUP });
    trackGroup(child);
    const built = new GrokItems(opts.maxChars);
    let done = false;
    const finish = (v: { items: HistoryItem[]; cut: boolean } | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      endChild(child);
      resolve(v);
    };
    const timer = setTimeout(() => finish(undefined), opts.timeoutMs ?? GROK_REPLAY_TIMEOUT_MS);
    child.on('error', () => finish(undefined));
    child.on('exit', () => finish(undefined));
    child.stdin.on('error', () => {});
    const send = (o: unknown) => child.stdin.write(jsonLine(o));
    onJsonLines(child.stdout, (m: Record<string, any>) => {
      if (m.method === 'session/update') { if (m.params?.sessionId === undefined || m.params.sessionId === sessionId) built.add(m.params?.update ?? {}); return; }
      // A request of the agent's own (fs, terminal, permission): refused, nothing runs here.
      if (m.id !== undefined && m.method) { send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `unsupported: ${m.method}` } }); return; }
      if (m.id === 1) {
        if (m.error) return finish(undefined);
        send({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId, cwd: profile.cwd, mcpServers: [] } });
      } else if (m.id === 2) {
        finish(m.error ? undefined : { items: built.items(), cut: built.cut });
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } });
  });
}
