import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanText } from '../src/core/types.js';

// A tmux brain whose pane is a stub: no tmux server, no CLI. The screen reads idle, a paste shows in
// the box at once, and Enter takes it. What the session "does" is what a test writes: transcript rows,
// and the Stop hook's marker. The caller sets ANGELIA_STATE_DIR before it imports the brain.

const here = dirname(fileURLToPath(import.meta.url));
const idle = readFileSync(join(here, 'fixtures', 'pane-idle.txt'), 'utf8');
const HOOK = fileURLToPath(new URL('../scripts/tui-stop-hook.mjs', import.meta.url));
const landed = idle.replace(/❯\s+Try "refactor <filepath>"/, '❯ [Pasted text #1 +2 lines]');

/** Rows shaped as the readers in src/brain take them from a session's transcript. Content made up. */
export const ROW = {
  /** A typed message, as Claude Code 2.1.329 marks it (`origin.kind: human`, measured live). */
  prompt: (text: string, at = Date.now()) => ({ type: 'user', timestamp: new Date(at).toISOString(), origin: { kind: 'human' }, message: { role: 'user', content: text } }),
  /** The end of a background task, queued by Claude Code and written as a user row (measured live). */
  notification: (id = 'toolu_1', at = Date.now()) => ({
    type: 'user', timestamp: new Date(at).toISOString(), origin: { kind: 'task-notification' },
    message: { role: 'user', content: `<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n<summary>Background command completed</summary>\n</task-notification>` },
  }),
  text: (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
  call: (id: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 600' } }] } }),
  /** A shell command sent to the background: its call, and the result that says so (background.ts). */
  background: (id: string) => [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'make', run_in_background: true } }] } },
    { type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'started', is_error: false }] }, toolUseResult: { backgroundTaskId: `b-${id}` } },
  ],
  /** A prompt typed while a turn ran, as Claude Code 2.1.330 writes it (read from its program text). */
  queuedPrompt: (text: string, kind = 'human', at = Date.now()) => ({ type: 'attachment', timestamp: new Date(at).toISOString(), attachment: { type: 'queued_command', prompt: text, origin: { kind } } }),
  result: (id: string) => ({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'ok', is_error: false }] }, toolUseResult: { stdout: 'ok' } }),
  /** Written after a turn's last row (measured live). */
  over: () => ({ type: 'system', subtype: 'turn_duration', durationMs: 5 }),
  /** A prompt the session scheduled for itself fires (measured live): this row, then the prompt as a meta row. */
  scheduled: (text: string, at = Date.now()) => [
    { type: 'system', subtype: 'scheduled_task_fire', timestamp: new Date(at).toISOString() },
    { type: 'user', isMeta: true, timestamp: new Date(at).toISOString(), message: { role: 'user', content: text } },
  ],
  apiError: (text: string) => ({ type: 'assistant', isApiErrorMessage: true, message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] } }),
};
export const jsonl = (rows: object[]): string => rows.map((r) => `${JSON.stringify(r)}\n`).join('');

export interface PaneStub {
  /** Times Enter took a pasted message. */
  enters: number;
  logs: string[];
  transcript: string;
  marker: string;
  /** Called at each Enter with its number, from 1. */
  onEnter(fn: (n: number) => void): void;
  /** Called when a message is pasted, before it shows in the box and before its Enter, with its number. */
  onPaste(fn: (n: number) => void): void;
  /** When each Enter was pressed. */
  enteredAt: number[];
  /** Run the real Stop hook on the transcript as it stands: it writes the marker, origin and all. */
  stop(lastMessage: string): void;
  rows(...rows: object[]): void;
  /** The Stop hook's file, as the hook writes it: `at` is now unless given. */
  mark(m: { text: string; origin?: string; origin_why?: string; prompt_at?: number; prompt_key?: string; prompts?: number; origin_ids?: string[]; at?: number; transcript_path?: string }): void;
  /** What Angelia last typed into the pane, as it typed it. */
  typed: string;
  /** That, as the user row Claude Code writes for it. */
  prompt(at?: number): object;
  /** Whether the marker file is still there (nobody took it). */
  marked(): boolean;
}

/** Replace the pane of `brain` (a TuiBrain) with the stub; `cwd` holds its transcript. Ready at once. */
export function stubPane(brain: unknown, cwd: string): PaneStub {
  const b = brain as any;
  let shown = idle;
  const hooks: ((n: number) => void)[] = [];
  const pastes: ((n: number) => void)[] = [];
  mkdirSync(b.dir, { recursive: true });
  b.transcript = join(cwd, `${b.session.id}.jsonl`);
  writeFileSync(b.transcript, jsonl([ROW.prompt('an earlier message', Date.now() - 60_000), ROW.text('An earlier answer.')]));
  const stub: PaneStub = {
    enters: 0,
    logs: [],
    transcript: b.transcript,
    marker: join(b.dir, 'turn.json'),
    onEnter: (fn) => { hooks.push(fn); },
    onPaste: (fn) => { pastes.push(fn); },
    enteredAt: [],
    stop: (lastMessage) => {
      execFileSync(process.execPath, [HOOK, '--guard'], {
        input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: b.transcript, session_id: b.session.id, last_assistant_message: lastMessage }),
        env: { ...process.env, ANGELIA_TUI_MARKER: join(b.dir, 'turn.json') },
      });
    },
    rows: (...rows) => appendFileSync(b.transcript, jsonl(rows)),
    mark: (m) => writeFileSync(join(b.dir, 'turn.json'), JSON.stringify({ at: Date.now(), transcript_path: b.transcript, ...m })),
    marked: () => { try { readFileSync(join(b.dir, 'turn.json')); return true; } catch { return false; } },
    typed: '',
    prompt: (at) => ROW.prompt(stub.typed, at),
  };
  const paste = b.paste.bind(b);
  b.paste = (text: string, ...rest: unknown[]) => { stub.typed = cleanText(text); return paste(text, ...rest); };
  b.on('log', (l: string) => stub.logs.push(l));
  b.start = () => { b.ready = Promise.resolve(null); b.up = true; };
  b.capture = async () => shown;
  b.sessionAlive = async () => true;
  b.tm = async (a: string[]) => {
    if (a[0] === 'paste-buffer') { for (const fn of pastes) fn(stub.enters + 1); shown = landed; }
    else if (a[0] === 'send-keys' && a.includes('Enter') && shown === landed) { shown = idle; stub.enters++; stub.enteredAt.push(Date.now()); for (const fn of hooks) fn(stub.enters); }
    return { code: 0, out: '', err: '' };
  };
  return stub;
}

export const until = async (ok: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
};
export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The waits of the quiet path and of the reader between turns, short: 12 s, 90 s, 3 min and 1 s in the daemon. */
export const FAST = { quietMs: 300, quietTextMs: 700, quietOpenMs: 900, idlePollMs: 40 };

/**
 * One Telegram DM routed to a tmux profile whose panes are stubs, through the real orchestrator. `sent`:
 * what the chat got, in order. Each brain the pool makes gets a new stub pane on the same session folder.
 * `onEnter` / `onPaste` count across panes, from 1. `defaults`: the table's (a short idle time).
 */
export async function stubChat(waits: Partial<typeof FAST> = {}, defaults: Record<string, unknown> = {}) {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { Orchestrator } = await import('../src/core/orchestrator.js');
  const { Config } = await import('../src/instance/config/schema.js');
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'angelia-unasked-cwd-')));
  const cfg = Config.parse({ profiles: { a: { cwd, tui: true } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }], defaults: { max_out_per_min: 1000, ...defaults } });
  const sent: string[] = [], log: string[] = [];
  const o = new Orchestrator(cfg, { telegram: { send: async (_c: string, text: string) => { sent.push(text); } } },
    { stateDir: mkdtempSync(join(tmpdir(), 'angelia-unasked-orch-')), bins: { 'claude-code': '/bin/false' }, log: (l) => log.push(l) });
  const panes: PaneStub[] = [], brains: any[] = [];
  const enters: ((n: number, p: PaneStub) => void)[] = [], pastes: ((n: number, p: PaneStub) => void)[] = [];
  let entered = 0;
  const oo = o as any;
  const make = oo.makeBrain.bind(oo);
  oo.makeBrain = (...a: unknown[]) => {
    const b = make(...a);
    Object.assign(b.opts, { ...FAST, ...waits });
    const p = stubPane(b, cwd);
    p.onPaste(() => { for (const fn of pastes) fn(entered + 1, p); });
    p.onEnter(() => { entered++; for (const fn of enters) fn(entered, p); });
    panes.push(p); brains.push(b);
    return b;
  };
  const key = 'telegram:1';
  return {
    o, sent, log, key, cwd,
    pane: () => panes[panes.length - 1],
    brain: () => brains[brains.length - 1],
    onEnter: (fn: (n: number, p: PaneStub) => void) => { enters.push(fn); },
    onPaste: (fn: (n: number, p: PaneStub) => void) => { pastes.push(fn); },
    say: (text: string) => o.handle({ platform: 'telegram', chat: '1', sender: 'u1', senderName: 'Owner', text, isGroup: false, mentioned: false, media: [] }),
    /** The brain's and the orchestrator's log lines about answers nobody asked for. */
    lines: () => log.filter((l) => /late answer|self-started answer|ended between turns/.test(l)),
  };
}
