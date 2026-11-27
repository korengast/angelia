import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanText } from '../src/core/types.js';

// A tmux brain whose pane is a stub: no tmux server, no CLI. The screen reads idle, a paste shows in
// the box at once, and Enter takes it. What the session "does" is what a test writes: transcript rows,
// and the Stop hook's marker. The caller sets ANGELIA_STATE_DIR before it imports the brain.

const here = dirname(fileURLToPath(import.meta.url));
const idle = readFileSync(join(here, 'fixtures', 'pane-idle.txt'), 'utf8');
const HOOK = fileURLToPath(new URL('../scripts/tui-stop-hook.mjs', import.meta.url));
/** What the input box shows for a paste of `text`, as claude 2.1.332 draws it (measured 2026-11-27): a
 *  chip once it has 3 line breaks or more than 800 characters, with the breaks counted; else the text,
 *  its next lines indented. */
export function drawnPaste(text: string, n = 1): string {
  const breaks = text.split('\n').length - 1;
  if (breaks >= 3 || text.length > 800) return `[Pasted text #${n}${breaks ? ` +${breaks} lines` : ''}]`;
  return text.split('\n').join('\n  ');
}
/** The idle screen with `inner` in its box. */
export const idleWith = (inner: string): string => idle.replace(/❯\s+Try "refactor <filepath>"/, `❯ ${inner}`);
/** The prompt with text left in the box (a paste a restart cut before its Enter): C-u clears it. */
const draft = idle.replace(/❯\s+Try "refactor <filepath>"/, '❯ half of an old message');
/** The same with a second line: one C-u clears the cursor's line only (the last), so two are needed. */
const draft2 = idle.replace(/❯\s+Try "refactor <filepath>"/, '❯ half of an old message\n  and its second line');
// A turn at work with its empty input box, measured on claude 2.1.332; the same with a paste in the box;
// a permission dialog of the same version (it replaces the box).
const busyBox = readFileSync(join(here, 'fixtures', 'pane-busy-box-332.txt'), 'utf8');
const dialog = readFileSync(join(here, 'fixtures', 'pane-permission-332.txt'), 'utf8');
const halfTyped = readFileSync(join(here, 'fixtures', 'pane-busy-halftyped-332.txt'), 'utf8');
/** The resume dialog with the cursor on "Start a new conversation" and no Esc in its foot; and the box
 *  with a prompt called back by Up (claude 2.1.332, measured: `─── History 2/2 ───`). */
const resume = readFileSync(join(here, 'fixtures', 'pane-resume.txt'), 'utf8').replace('❯ 1. Resume', '  1. Resume').replace('  2. Start a new', '❯ 2. Start a new').replace('Esc to resume', 'Esc to cancel');
const history = readFileSync(join(here, 'fixtures', 'pane-history-332.txt'), 'utf8');

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
  /** A named teammate spawned (the Agent tool with `name`): its call, and the result as claude 2.1.332
   *  writes it (measured live, tests/live-tui-teammate.mts; the prompt and paths left out). */
  teammate: (id: string, name: string) => [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { description: `The ${name} task`, name, prompt: 'p', run_in_background: true } }] } },
    { type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: [{ type: 'text', text: 'Spawned successfully.' }] }] },
      toolUseResult: { status: 'teammate_spawned', agentId: `a${name}-1`, teammate_id: `${name}@session-1d6a42ef`, agent_id: `a${name}-1`, name, color: 'blue', tmux_pane_id: 'in-process', team_name: 'session-1d6a42ef' } },
  ],
  /** A teammate's message to the lead starts a turn: a user row with no origin, `rowSource: recorded`
   *  (claude 2.1.332, measured live). `idle`: the note a teammate sends when it stops. */
  teammateMessage: (name: string, body: string, at = Date.now()) => ({
    type: 'user', timestamp: new Date(at).toISOString(), rowSource: 'recorded', promptId: 'p-1', turnPosition: { promptIndex: 1, turnIndex: 2 },
    message: { role: 'user', content: `Another Claude session sent a message:\n<teammate-message teammate_id="${name}" color="blue" summary="Report to the lead">\n${body}\n</teammate-message>\n\nThis came from another Claude session — not typed by your user.` },
  }),
  teammateIdle: (name: string, at = Date.now()) => ({
    type: 'user', timestamp: new Date(at).toISOString(), rowSource: 'recorded', promptId: 'p-1', turnPosition: { promptIndex: 1, turnIndex: 3 },
    message: { role: 'user', content: `Another Claude session sent a message:\n<teammate-message teammate_id="${name}" color="blue">\n{"type":"idle_notification","from":"${name}","timestamp":"${new Date(at).toISOString()}","idleReason":"available"}\n</teammate-message>` },
  }),
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
  mark(m: { text: string; origin?: string; origin_why?: string; prompt_at?: number; prompt_key?: string; prompts?: number; origin_ids?: string[]; origin_teammates?: string[]; origin_idle?: boolean; at?: number; transcript_path?: string }): void;
  /** What Angelia last typed into the pane, as it typed it. */
  typed: string;
  /** That, as the user row Claude Code writes for it. */
  prompt(at?: number): object;
  /** Whether the marker file is still there (nobody took it). */
  marked(): boolean;
  /** What the screen shows from now on: `idle` (the default), `busy` (a turn at work, its box empty),
   *  `dialog` (a permission dialog), `half` (a turn at work, someone's text in the box). A paste into
   *  `busy` shows in the box; its Enter queues it (Claude Code's own queue) and the box is empty again.
   *  `resume`: the resume dialog, which closes by itself right before an Up, so the Up calls an old
   *  prompt back into the box (`history`); Ctrl-K Ctrl-U clears it. */
  show(screen: 'idle' | 'busy' | 'dialog' | 'half' | 'draft' | 'draft2' | 'resume' | 'history'): void;
  /** Messages Enter queued into a running turn, as typed. */
  queued: string[];
  /** Whether Angelia's absorb lock was there at each Enter that queued a message into a turn. */
  lockedAtEnter: boolean[];
  /** The pane dies: the screen is empty, and tmux has no such session. */
  die(): void;
  /** Each tmux new-session the brain ran on this stub, as its arguments: it brings the pane back, idle. */
  launches: string[][];
  /** From now on a new-session fails, and the pane stays dead. */
  failLaunch(): void;
  /** From now on Claude Code takes a message typed into a turn at its Enter, but the screen shows it only `ms` later. */
  slowTake(ms: number): void;
  /** From now on an Enter on a message typed into a turn empties the box but Claude Code does not queue it (a relaunch, the owner cleared the box). */
  loseTake(): void;
  /** From now on the transcript row that says Claude Code queued a message comes `ms` after its Enter. */
  slowRow(ms: number): void;
  /** Every paste-buffer, as loaded (a turn's message or one typed into a turn). */
  buffers: string[];
}

/** Replace the pane of `brain` (a TuiBrain) with the stub; `cwd` holds its transcript. Ready at once. */
export function stubPane(brain: unknown, cwd: string, keep = false): PaneStub {
  const b = brain as any;
  let shown = idle;
  const hooks: ((n: number) => void)[] = [];
  const pastes: ((n: number) => void)[] = [];
  mkdirSync(b.dir, { recursive: true });
  b.transcript = join(cwd, `${b.session.id}.jsonl`);
  // `keep`: the session's transcript as an earlier daemon left it (a restart adopts the pane).
  if (!keep || !existsSync(b.transcript)) writeFileSync(b.transcript, jsonl([ROW.prompt('an earlier message', Date.now() - 60_000), ROW.text('An earlier answer.')]));
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
    rows: (...rows) => {
      appendFileSync(b.transcript, jsonl(rows));
      // A tool call passed Angelia's PreToolUse hook just before its row: the hook's mark of when it ended.
      if (rows.some((r: any) => Array.isArray(r?.message?.content) && r.message.content.some((c: any) => c?.type === 'tool_use'))) {
        mkdirSync(join(b.dir, 'pretool'), { recursive: true });
        writeFileSync(join(b.dir, 'pretool', 'last.json'), JSON.stringify({ at: Date.now() }));
      }
    },
    mark: (m) => writeFileSync(join(b.dir, 'turn.json'), JSON.stringify({ at: Date.now(), transcript_path: b.transcript, ...m })),
    marked: () => { try { readFileSync(join(b.dir, 'turn.json')); return true; } catch { return false; } },
    typed: '',
    prompt: (at) => ROW.prompt(stub.typed, at),
    show: (screen) => { shown = { idle, busy: busyBox, dialog, half: halfTyped, draft, draft2, resume, history }[screen]; },
    queued: [],
    buffers: [],
    lockedAtEnter: [],
    die: () => { dead = true; shown = ''; },
    launches: [],
    failLaunch: () => { launchFails = true; },
    slowTake: (ms) => { takeMs = ms; },
    loseTake: () => { lost = true; },
    slowRow: (ms) => { rowMs = ms; },
  };
  // The screens with the last paste in the box, idle and busy: drawn for the text loaded.
  let landed = idleWith(drawnPaste('x')), busyLanded = busyBox.replace(/^❯\s*$/m, `❯ ${drawnPaste('x')}`);
  let buffer = '', dead = false, takeMs = 0, taking = false, lost = false, rowMs = 0, launchFails = false;
  const paste = b.paste.bind(b);
  b.paste = (text: string, ...rest: unknown[]) => { stub.typed = cleanText(text); return paste(text, ...rest); };
  b.on('log', (l: string) => stub.logs.push(l));
  b.start = () => { b.ready = Promise.resolve(null); b.up = true; };
  b.capture = async () => shown;
  b.sessionAlive = async () => !dead;
  b.tm = async (a: string[]) => {
    if (a[0] === 'load-buffer') {
      buffer = readFileSync(a[a.length - 1], 'utf8'); stub.buffers.push(buffer);
      landed = idleWith(drawnPaste(buffer)); busyLanded = busyBox.replace(/^❯\s*$/m, `❯ ${drawnPaste(buffer)}`);
    }
    else if (a[0] === 'paste-buffer' && shown === busyBox) shown = busyLanded;
    else if (a[0] === 'send-keys' && a.includes('C-u') && (shown === draft || shown === history)) shown = idle;
    else if (a[0] === 'send-keys' && a.includes('Up') && shown === resume) shown = history;
    else if (a[0] === 'send-keys' && a.includes('C-u') && shown === draft2) shown = draft;
    else if (a[0] === 'paste-buffer' && shown === draft) shown = idleWith(`half of an old message${drawnPaste(buffer)}`);
    else if (a[0] === 'paste-buffer') { for (const fn of pastes) fn(stub.enters + 1); shown = landed; }
    else if (a[0] === 'send-keys' && a.includes('Enter') && shown === busyLanded) {
      stub.lockedAtEnter.push(existsSync(join(b.dir, 'absorb.lock')));
      if (lost) { shown = busyBox; return { code: 0, out: '', err: '' }; }
      // Claude Code writes that it queued the message at once (measured on 2.1.332), whatever the screen shows.
      if (!taking) { const row = jsonl([{ type: 'queue-operation', operation: 'enqueue', timestamp: new Date().toISOString(), content: buffer }]); if (rowMs) setTimeout(() => appendFileSync(b.transcript, row), rowMs); else appendFileSync(b.transcript, row); }
      // Claude Code took it; with slowTake the screen shows that only later (an Enter meanwhile does nothing).
      if (takeMs) { if (!taking) { taking = true; const m = buffer; setTimeout(() => { taking = false; shown = busyBox; stub.queued.push(m); }, takeMs); } }
      else { shown = busyBox; stub.queued.push(buffer); }
    }
    else if (a[0] === 'has-session' && dead) return { code: 1, out: '', err: 'no session' };
    else if (a[0] === 'new-session') {
      stub.launches.push(a);
      if (launchFails) return { code: 1, out: '', err: 'stub: no launch' };
      dead = false; shown = idle;
    }
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
export const FAST = { quietMs: 300, quietTextMs: 700, quietOpenMs: 900, idlePollMs: 40, callSettleMs: 100, pretoolSettleMs: 100, confirmMs: 1500 };

/**
 * One Telegram DM routed to a tmux profile whose panes are stubs, through the real orchestrator. `sent`:
 * what the chat got, in order. Each brain the orchestrator makes gets a new stub pane on the same session folder.
 * `onEnter` / `onPaste` count across panes, from 1. `defaults`: the table's (a short idle time).
 */
export async function stubChat(waits: Partial<typeof FAST> = {}, defaults: Record<string, unknown> = {}, profile: Record<string, unknown> = {}, place: { cwd?: string; stateDir?: string } = {}) {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { Orchestrator } = await import('../src/core/orchestrator.js');
  const { Config } = await import('../src/instance/config/schema.js');
  const cwd = place.cwd ?? realpathSync(mkdtempSync(join(tmpdir(), 'angelia-unasked-cwd-')));
  const cfg = Config.parse({ profiles: { a: { cwd, tui: true, ...profile } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }], defaults: { max_out_per_min: 1000, ...defaults } });
  const sent: string[] = [], log: string[] = [];
  const stateDir = place.stateDir ?? mkdtempSync(join(tmpdir(), 'angelia-unasked-orch-'));
  // A stand-in for claude that fails as /bin/false does, but prints a Claude Code version for the launch
  // check (a relaunch runs it): /bin/false itself prints a version on some systems (uutils coreutils
  // 0.10.0 on GitHub's Ubuntu runner), and that reads as a claude older than the minimum.
  const bin = join(stateDir, 'claude-stand-in');
  writeFileSync(bin, '#!/bin/sh\necho "2.1.332 (Claude Code)"\nexit 1\n', { mode: 0o755 });
  const o = new Orchestrator(cfg, { telegram: { send: async (_c: string, text: string) => { sent.push(text); } } },
    { stateDir, bins: { 'claude-code': bin }, log: (l) => log.push(l) });
  const panes: PaneStub[] = [], brains: any[] = [];
  const enters: ((n: number, p: PaneStub) => void)[] = [], pastes: ((n: number, p: PaneStub) => void)[] = [];
  let entered = 0;
  const oo = o as any;
  const make = oo.makeBrain.bind(oo);
  oo.makeBrain = (...a: unknown[]) => {
    const b = make(...a);
    Object.assign(b.opts, { ...FAST, ...waits });
    const p = stubPane(b, cwd, !!place.cwd);
    p.onPaste(() => { for (const fn of pastes) fn(entered + 1, p); });
    p.onEnter(() => { entered++; for (const fn of enters) fn(entered, p); });
    panes.push(p); brains.push(b);
    return b;
  };
  const key = 'telegram:1';
  return {
    o, sent, log, key, cwd, stateDir,
    pane: () => panes[panes.length - 1],
    brain: () => brains[brains.length - 1],
    onEnter: (fn: (n: number, p: PaneStub) => void) => { enters.push(fn); },
    onPaste: (fn: (n: number, p: PaneStub) => void) => { pastes.push(fn); },
    say: (text: string) => o.handle({ platform: 'telegram', chat: '1', sender: 'u1', senderName: 'Owner', text, isGroup: false, mentioned: false, media: [] }),
    /** The brain's and the orchestrator's log lines about answers nobody asked for. */
    lines: () => log.filter((l) => /late answer|self-started answer|ended between turns/.test(l)),
  };
}
