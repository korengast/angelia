import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Profile } from '../instance/config/schema.js';
import { cleanText, type BrainEvent, type SelfPermission, type SelfWork, type UnaskedAnswer } from '../core/types.js';
import { isLimitText, NOT_RUN, TMUX_STALLED } from '../core/deliver/text.js';
import { apiErrorReason, apiErrorText, isApiErrorRow } from './api-error.js';
import { childEnv, CLAUDE_ENV, claudeTuiArgv, MIN_CLAUDE_VERSION, remoteControlName, STRIP_ENV, tuiSettings, versionAtLeast } from './argv.js';
import { blockedShort, deniedConnectorCount, PermissionBook, type Brain, type BrainOptions, type BrainSession, type PermissionAnswer, type TurnFlags } from './brain.js';
import { addDirAccepted, addDirDialog, boxHoldsOnly, boxText, exact, importsAccepted, importsDialogOpen, loadBuffer, paneAboveFoot, paneBusy, paneHasBox, paneIdle, paneMidTurn, pasteLanded, permissionDialog, resumeDialog, submitPasted, tmux, TMUX_SOCKET, trustAccepted, trustDialogOpen } from './tmux.js';
import { HOOK_GIVE_UP_MS, paneVerdict, PermissionRelay, REJECTED, RELAY_BEAT_MS, relayedPermission, ScreenDialogs, type RelayedRequest, type RequestOrigin } from './tui-permissions.js';
import { LOST_SESSION_LINE, placeTranscript, transcriptPath } from './transcripts.js';
import { mcpLaunch, readRecord } from '../capabilities/compile.js';
import { readPlainText } from '../core/paths.js';
import { askedBy } from '../core/screen-asks.js';
import { tuiBlockedConnectors } from './connectors-check.js';

export { transcriptPath } from './transcripts.js';
export { buildIn, paneActivity, paneBuild, paneEndReason, reapPanes, sweepPanes, type IdlePane } from './tui-panes.js';

const HOOK = fileURLToPath(new URL('../../scripts/tui-stop-hook.mjs', import.meta.url));
const PERMISSION_HOOK = fileURLToPath(new URL('../../scripts/tui-permission-hook.mjs', import.meta.url));
/** Claude's limit for the permission hook, in seconds: past the hook's own give-up, which is past the
 *  daemon's ten-minute deny. */
const PERMISSION_HOOK_TIMEOUT_S = 900;
export const PRETOOL_HOOK = fileURLToPath(new URL('../../scripts/tui-pretool-hook.mjs', import.meta.url));
/** Past the PreToolUse hook's own longest wait (15 s). */
const PRETOOL_HOOK_TIMEOUT_S = 30;
const POLL_MS = 700;
/** What a message gets that Claude Code took late into the turn before (turn). */
export const TAKEN_LATE_LINE = 'Claude Code took this message late, during the turn before it, so it was not sent a second time.';
/** tmux calls in a row that timed out (TMUX_TIMEOUT_MS each) before a loop that waits on the screen
 *  gives up: one is a loaded machine, three (a minute and a half) is a server that does not answer. */
const TMUX_STALLS = 3;
/** The connector checks this daemon ran or runs (checkConnectors), by profile folder and MCP keys:
 *  once per daemon start per profile and deny list, not once per pane. */
const connectorChecks = new Set<string>();
/** How long claude's add-dir dialog must stand before keys reach it (it drops them for ~1 s, 2.1.326). */
const ADD_DIR_SETTLE_MS = 1500;
/** How many tries one launch, reattach or waiting message has at the resume dialog: one answer, tried again
 *  only while the dialog still stands (a new dialog may drop a key). */
const RESUME_PRESSES = 3;
const START_TIMEOUT_MS = 90_000;
/** How long a message waits for the pane's prompt. Past it the message goes back to the chat as not
 *  delivered, and a pane that works or waits for a person is kept (notTyped). */
const PROMPT_TIMEOUT_MS = 10 * 60_000;
/** How long a paste may take to show in the input box before it counts as not shown. */
const LAND_MS = 2400;
/** How many times one message is pasted when it never showed in the box (nothing was submitted). */
const PASTE_TRIES = 3;

/** How a paste went. `keep`: the pane is alive and was left as it was, so it must not be ended for
 *  this: it may hold background agents, a dialog for a person, or a turn of its own. `why`: for the chat. */
type Pasted = { ok: true } | { ok: false; why: string; keep: boolean };

/** The tries at one stand of the resume dialog (resumeStep). */
interface ResumeTries { at: number; pressedAt: number; presses: number; logged: Set<string> }
const noTries = (): ResumeTries => ({ at: 0, pressedAt: 0, presses: 0, logged: new Set() });

/** The reason of a turn whose message was not typed into a live pane that is kept: the chat is told to
 *  send it again (core/deliver/text.ts, notDeliveredLine), and the pane is not ended. */
export const NOT_TYPED = 'not delivered';
/** A turn has no end time: a long build or a run of subagents may take hours, and `/stop` ends a
 *  stuck one. Each full hour the chat gets one line saying so, so a silent turn is not taken for a
 *  crash. */
const TURN_NOTICE_MS = 60 * 60_000;
/** Said when a message reaches a session that is busy with something else, mostly a turn typed in the Claude app. */
export const BUSY_PANE_LINE = 'The session is busy with another turn (in the Claude app or its pane); your message waits for it.';
/** A pane and transcript unchanged this long: the hourly line says the turn may be stuck. A working
 *  CLI redraws its spinner and timer every second, so only a screen that waits on nothing is this still. */
const STILL_MS = 30 * 60_000;
/** How long a pane must sit at an idle prompt, with nothing new in the transcript and no answer
 *  from the Stop hook, before the turn counts as over anyway. A slash command such as `/compact`
 *  is handled by the CLI itself and ends without a Stop event, so without this the turn would
 *  simply hang. */
export const QUIET_MS = 12_000;
/** The same wait when the turn's last transcript row is the assistant's text. That is the answer of
 *  a turn whose Stop hook failed, or text that a tool call still follows: the call's row is written
 *  when its input is whole, which can take longer than QUIET_MS for a large file, and the rows do not
 *  say which (stop_reason on a row is not measured). The Stop hook lands within a second of a real
 *  end, so only a failed hook waits this long. Counted from the last transcript row of any kind.
 *  BrainOptions.quietTextMs shortens it (tests). */
const QUIET_TEXT_MS = 90_000;
/** The same wait when the transcript shows the turn open (a tool runs, the model owes an answer): the
 *  net under row shapes turnRows does not know, and under a turn that ended with no Stop hook and no
 *  closing row. Counted from the last transcript row of any kind and from the last change of the
 *  screen above the input box's foot: a working CLI redraws its spinner clock there every second, so
 *  a turn at work is never ended by this, and a teammate's clock under the box does not hold a dead
 *  one open. The orchestrator's stall clock does not run for a tmux turn, so this is the only bound. */
const QUIET_OPEN_MS = 3 * 60_000;
/** After a chat answer, a dialog that still asks the same thing this long is taken as asking again. */
const REASK_MS = 2500;
/** How long a request answered in the pane may go without a result in the transcript before it counts
 *  as allowed: Claude writes a refusal at once, so a call still waiting on its result is running. */
const DECIDE_MS = 3000;
/** The most of a turn's transcript read to find how a request answered in the pane went. */
const TRANSCRIPT_SLICE_MAX = 8 * 1024 * 1024;

/** How often the Stop marker is looked for between turns, while the session is held: one check that
 *  a file exists. Short: the next Stop overwrites the file, so a late answer followed at once by a
 *  task's end would be lost to a slow reader. BrainOptions.idlePollMs shortens it (tests). */
const IDLE_POLL_MS = 1000;
/** How often the reader between turns writes its heartbeat for the permission hook: well inside
 *  RELAY_STALE_MS (30 s), and not a disk write every tick for each pane the daemon holds. */
const IDLE_BEAT_MS = 5000;
/** What an agent answers when it has nothing for the chat (jobs.ts reads the same word). */
const SILENT = '[SILENT]';
/** A tool call must have run this long, with no permission request, before a message is typed into the
 *  turn: the hook and Claude Code's own dialog come within a moment of the call (measured 2.1.332). */
const CALL_SETTLE_MS = 3000;
/** Tools whose work can ask for a permission at any moment while they run: a subagent's own calls. */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
/** Tools that ask the person by themselves while they run, with no PermissionRequest (a question, a
 *  plan to approve); every `mcp__` tool too, which may open a form (elicitation). */
const ASKS_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
/** How long after a PreToolUse hook ended no Enter is pressed: its PermissionRequest comes about 0.1 s
 *  after it (measured on 2.1.332), more on a loaded machine. */
const PRETOOL_SETTLE_MS = 1500;
/** How long the lock may stand before its Enter: past it the hook may read the lock as left over (8 s). */
const LOCK_FRESH_MS = 3000;
/** How long the reader of the turn Claude Code runs for untaken messages waits for its prompt row. */
const FOLLOW_START_MS = 30_000;

/** A process of this user with this pid runs (a hook's mark of one that died holds nothing). */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
/** How long a turn Claude Code runs for untaken messages waits for its reader (followAbsorbed). */
const FOLLOW_WAIT_MS = 5000;
/** A chat message typed into a running turn (absorb): its key and text, when, the turn it went into
 *  (that turn's turnSentAt), and whether the transcript shows the turn took it. `offset`: the
 *  transcript's size at its Enter, when known: where the rows that may give it to the model begin (ranSince). */
export interface Absorbed { key: string; text: string; at: number; turn: number; seen: boolean; offset?: number }
/** What a turn typed, for its reader (watch): the key its marker is held to, the path that typed it
 *  (`turn`, `follow`, '' when none), and the typed text in promptForm ('' for a follow). */
interface Typed { key: string; by: string; form: string }
/** A message pressed into a running turn whose take the transcript never confirmed (TuiBrain.unsure).
 *  `turn`: the turnSentAt of the turn it was pressed into, as an Absorbed entry's. */
interface Unsure { key: string; text: string; transcript: string; offset: number; at: number; turn: number; answered: boolean }
/** How long an empty box after the Enter waits for the transcript's word that Claude Code queued the
 *  message (queuedSince): the row is written at the key (measured on 2.1.332), the screen may say so first. */
const CONFIRM_MS = 8000;
/** The one log line of a box emptied after the Enter with no such row in CONFIRM_MS. */
export const UNCONFIRMED_LINE = 'tmux: the box emptied after the Enter, but the transcript did not show the message queued; it waits for a turn of its own';

/** The one log line of messages typed into the last turn that it did not take and that no turn ran: no
 *  row from their Enter on gives them to the model (Claude Code put them back in the box, or dropped
 *  them). They are typed again as a turn of their own (the orchestrator, NOT_RUN), never lost unsaid. */
export const NOT_RUN_LINE = 'tmux: a message typed into the last turn was not taken and no turn ran it; it is typed again as a turn of its own';
/** The text of a typed prompt row's content: a string, or its text blocks joined (skipToPrompt, queuedSince). */
function promptText(c: unknown): string {
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: { type?: unknown; text?: unknown }) => (b?.type === 'text' ? String(b.text ?? '') : '')).join('\n') : '';
}

/** intoTurnBlocked: no turn of the chat's is read any more, so the message will not go into one. */
const NOT_READ = 'no turn of the chat is read';
/** How long a message waits for a safe moment in the running turn: the whole turn, polled. How long a
 *  message typed into the box may take to go after Enter. */
const TAKEN_POLLS = 10;
/** How many Ctrl-K, Ctrl-U pairs clearBox presses at most: each deletes a line's text or a line break,
 *  so a box of up to about this many lines (a paste of more is one chip). */
const CLEAR_ROUNDS = 40;
/** How long after a turn's Enter its prompt row may be written for keptOnMiss to take the turn as its own. */
const KEPT_WINDOW_MS = 30_000;
/** The shortest typed message (promptForm) keptOnMiss takes: a shorter one is part of many prompts. */
const KEPT_MIN_CHARS = 24;

/** The Stop hook's file (scripts/tui-stop-hook.mjs). `origin`, `origin_why`, `prompt_at`, `prompt_key`,
 *  `prompts`, `origin_ids`, `origin_teammates`, `origin_idle`: what started the turn, as the hook read it from the transcript
 *  (scripts/turn-origin.mjs). */
interface Marker {
  text?: unknown; at?: number; transcript_path?: string; origin?: unknown; origin_why?: unknown; prompt_at?: unknown;
  prompt_key?: unknown; prompt_len?: unknown; prompts?: unknown; origin_ids?: unknown; origin_teammates?: unknown; origin_idle?: unknown;
}

/** The key of a typed prompt, as scripts/turn-origin.mjs (promptKey) computes it from the transcript:
 *  the paste tags left out, NFC, every run of white space one space, trimmed, SHA-256, 32 hex digits. */
export function promptKey(text: string): string {
  return createHash('sha256').update(promptForm(text)).digest('hex').slice(0, 32);
}
/** A prompt as promptKey hashes it: the paste tags left out, NFC, every run of white space one space,
 *  trimmed. Its length is the `prompt_len` the hook writes (turn-origin.mjs). */
export function promptForm(text: string): string {
  return text.replace(PASTED_TAG, ' ').normalize('NFC').replace(/\s+/g, ' ').trim();
}
/** The tags Claude Code wraps a pasted text of several lines in, in the transcript (turn-origin.mjs). */
const PASTED_TAG = /<\/?pasted_content id="[0-9a-f]{4}">/g;

/** An answer as the chat got it and as the hook read it, made comparable: line ends, white space at
 *  a line's end, runs of blank lines, Unicode form. */
export function sameAnswer(a: string, b: string): boolean {
  const norm = (s: string) => s.normalize('NFC').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const x = norm(a), y = norm(b);
  return !!y && (x === y || x.endsWith(`\n\n${y}`));
}

/** The start of the line a turn writes when it drops a marker whose typed prompt is not the one it
 *  typed (daemon/health.ts counts it, brain/canary.ts fails on it). */
export const KEY_MISS_LINE = 'tmux: marker dropped, prompt key miss:';
/** The start of the line a turn writes when its marker's key is not the one it typed, but the prompt
 *  Claude Code ran starts or ends with the typed message (keptOnMiss): the answer is delivered. Counted and
 *  failed on as KEY_MISS_LINE is: the prompt was not what was typed. */
export const KEY_KEPT_LINE = 'tmux: prompt key miss, answer kept:';

/** Background tasks remembered as started in a turn of Angelia's: a task's end is delivered by these. */
const OURS_MAX = 500;
/** Turn starts kept (turnStarts): more than spawns wait between two markers. */
const TURN_STARTS_MAX = 50;
/** The keys of every prompt typed into the turn a request came from, as the hook read them; none when
 *  it holds more than the hook lists (then not each one can be known for the chat's). */
function promptKeysOf(o: RequestOrigin): string[] {
  if (o.promptKeys) return o.prompts === o.promptKeys.length ? o.promptKeys : [];
  return o.promptKey && o.prompts === 1 ? [o.promptKey] : [];
}

/** A teammate's name, without the team of a full id (`name@team`). */
const bareName = (id: string): string => id.split('@')[0];

/** Add to a set of the chat's own work as the newest one, and keep it within OURS_MAX. */
function addOurs(set: Set<string>, v: string): void {
  set.delete(v);
  set.add(v);
  if (set.size > OURS_MAX) set.delete(set.values().next().value!);
}

/** Calls kept while their result is awaited, so a turn of a thousand shell commands does not grow the map. */
const CALLS_MAX = 500;

/** How long a named teammate counts as open with no end of it read: it may never send one. */
export const TEAMMATE_MAX_MS = 12 * 60 * 60_000;

/** The name of a spawned teammate, from its call's result (claude 2.1.332, measured: `name`, and
 *  `teammate_id` as `<name>@<team>`), as its messages to the lead name it (`teammate_id="<name>"`).
 *  Only a plain word. */
export function teammateName(res: { name?: unknown; teammate_id?: unknown }): string | undefined {
  const raw = typeof res.name === 'string' && res.name ? res.name : typeof res.teammate_id === 'string' ? res.teammate_id.split('@')[0] : '';
  return /^[A-Za-z0-9_.-]{1,64}$/.test(raw) ? raw : undefined;
}

/**
 * What a slice of transcript rows says of background work, as Claude Code writes it. `starts`: the
 * tool_use ids of the tasks it starts, a shell command sent to the background (a `Bash` call whose
 * result row carries `backgroundTaskId`) and a subagent launched to run on its own (`status:
 * async_launched`, or `teammate_spawned` for a named one, with the name it goes by: `teammate`).
 * `ends`: the ids a queued `<task-notification>` names (a `queue-operation` row, `enqueue`), the end
 * of each, which the Stop hook reports as `origin_ids`. `calls`: the kind of each call whose result
 * has not come yet, kept by the caller across slices (a call and its result may be read apart).
 */
export function backgroundRows(chunk: string, calls: Map<string, 'bash' | 'agent'> = new Map()): { starts: { id: string; teammate?: string; team?: string }[]; ends: string[] } {
  const rows: unknown[] = [];
  for (const l of chunk.split('\n')) {
    try { rows.push(JSON.parse(l)); } catch { /* a part line */ }
  }
  return backgroundOfRows(rows, calls);
}

/** backgroundRows for rows already parsed. */
export function backgroundOfRows(rows: unknown[], calls: Map<string, 'bash' | 'agent'> = new Map()): { starts: { id: string; teammate?: string; team?: string }[]; ends: string[] } {
  const starts: { id: string; teammate?: string; team?: string }[] = [], ends: string[] = [];
  type Block = { type?: unknown; id?: unknown; name?: unknown; tool_use_id?: unknown; text?: unknown };
  for (const row of rows) {
    const r = row as { type?: unknown; operation?: unknown; content?: unknown; message?: { content?: unknown }; toolUseResult?: unknown } | null;
    if (r?.type === 'queue-operation' && r.operation === 'enqueue') {
      const c = r.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? (c as Block[]).map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n') : '';
      for (const n of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
        const id = /<tool-use-id>([\s\S]*?)<\/tool-use-id>/.exec(n[1])?.[1]?.trim();
        if (id) ends.push(id);
      }
      continue;
    }
    if (!Array.isArray(r?.message?.content)) continue;
    const content = r.message.content as Block[];
    if (r.type === 'assistant') {
      for (const b of content) {
        if (b?.type !== 'tool_use' || typeof b.id !== 'string') continue;
        if (b.name === 'Bash') calls.set(b.id, 'bash');
        else if (b.name === 'Agent' || b.name === 'Task') calls.set(b.id, 'agent');
        else continue;
        if (calls.size > CALLS_MAX) calls.delete(calls.keys().next().value!);
      }
      continue;
    }
    if (r.type !== 'user') continue;
    const results = content.filter((b) => b?.type === 'tool_result' && typeof b.tool_use_id === 'string');
    // The result object belongs to the row's one call; a row of several is not guessed at.
    if (results.length !== 1) continue;
    const id = String(results[0].tool_use_id), kind = calls.get(id);
    calls.delete(id);
    const res = r.toolUseResult as { backgroundTaskId?: unknown; status?: unknown; name?: unknown; teammate_id?: unknown } | undefined;
    if (!res || typeof res !== 'object') continue;
    // A background id counts for a shell call only (a call not seen is taken for one, as Claude Code
    // gives that id to shell commands alone).
    if (res.backgroundTaskId && (kind ?? 'bash') === 'bash') starts.push({ id });
    else if (res.status === 'async_launched') starts.push({ id });
    else if (res.status === 'teammate_spawned') {
      const teammate = teammateName(res), team = teammateTeam(res);
      starts.push(teammate ? { id, teammate, ...(team ? { team } : {}) } : { id });
    }
  }
  return { starts, ends };
}

/** How much of a transcript's end is read for open tasks: a long conversation's file is tens of MB,
 *  and the read holds the daemon. A task started before it is seen only by an end of another such task
 *  in it (openTasksInTranscript). */
export const OPEN_TASKS_BYTES = 8 * 1024 * 1024;

/** The last \`max\` bytes of a file, from the first whole line in them. */
function tailOf(path: string, size: number, max: number): string {
  if (size <= max) return readFileSync(path, 'utf8');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, size - max);
    const text = buf.subarray(0, n).toString('utf8');
    return text.slice(text.indexOf('\n') + 1);
  } finally { closeSync(fd); }
}

/** What a transcript read last said: by path, with the size and time it had then. */
const openTasksRead = new Map<string, { size: number; mtime: number; open: Map<string, number> }>();

/**
 * The background shells, subagents and teammates a session's transcript leaves open: started (by
 * backgroundRows), no end read, and started less than TEAMMATE_MAX_MS ago by the row's own time.
 * Null when the file cannot be read: nobody can tell, so a caller keeps the pane. It is how the pane
 * reap knows a pane's work after a restart, when no brain of this daemon tracked it (Orchestrator.
 * mayEndPane). A file that did not change since the last read is not read again.
 *
 * In a file read only at its end, an end with no start says the session had tasks from before the part
 * read, and others of them may still run: it counts as one open, by its row's time.
 */
export function openTasksInTranscript(path: string, now = Date.now()): number | null {
  let st;
  try { st = statSync(path); } catch { return null; }
  let seen = openTasksRead.get(path);
  if (!seen || seen.size !== st.size || seen.mtime !== st.mtimeMs) {
    let text: string;
    try { text = tailOf(path, st.size, OPEN_TASKS_BYTES); } catch { return null; }
    const calls = new Map<string, 'bash' | 'agent'>(), open = new Map<string, number>();
    const cut = st.size > OPEN_TASKS_BYTES, started = new Set<string>(), orphans = new Map<string, number>();
    for (const line of text.split('\n')) {
      if (!line.includes('tool_result') && !line.includes('tool_use') && !line.includes('task-notification')) continue;
      const { starts, ends } = backgroundRows(line, calls);
      // A row with no time of its own counts as started now: kept, rather than guessed old.
      const at = Date.parse(/"timestamp"\s*:\s*"([^"]+)"/.exec(line)?.[1] ?? '');
      for (const t of starts) { started.add(t.id); open.set(t.id, Number.isNaN(at) ? now : at); }
      for (const id of ends) {
        open.delete(id);
        if (cut && !started.has(id)) orphans.set(id, Number.isNaN(at) ? now : at);
      }
    }
    // Under a key of their own, so a second row naming the same end does not take it away.
    for (const [id, at] of orphans) open.set(`before:${id}`, at);
    openTasksRead.set(path, seen = { size: st.size, mtime: st.mtimeMs, open });
    if (openTasksRead.size > 200) openTasksRead.delete(openTasksRead.keys().next().value!);
  }
  return [...seen.open.values()].filter((at) => now - at < TEAMMATE_MAX_MS).length;
}

/** The team of a spawned teammate (`teammate_id` as `<name>@<team>`), when its result says it. */
export function teammateTeam(res: { teammate_id?: unknown }): string | undefined {
  const team = typeof res.teammate_id === 'string' ? res.teammate_id.slice(res.teammate_id.indexOf('@') + 1 || res.teammate_id.length) : '';
  return team ? team.slice(0, 128) : undefined;
}

/** The tool_use ids of the background tasks a slice of transcript rows starts (backgroundRows). */
export function backgroundStarts(chunk: string, calls: Map<string, 'bash' | 'agent'> = new Map()): string[] {
  return backgroundRows(chunk, calls).starts.map((s) => s.id);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Settings files Claude Code merges with ours that carry a Stop hook of their own. */
export function otherStopHooks(cwd: string, home = homedir()): string[] {
  const files = [join(home, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')];
  return files.filter((f) => {
    try { const h = JSON.parse(readPlainText(f))?.hooks?.Stop; return Array.isArray(h) && h.length > 0; } catch { return false; }
  });
}

/** The settings files Claude Code merges with ours, in a pane started in `cwd`. */
function mergedSettingsFiles(cwd: string, home: string): string[] {
  return [join(home, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json'),
    '/Library/Application Support/ClaudeCode/managed-settings.json', '/etc/claude-code/managed-settings.json'];
}

const readJson = (f: string): Record<string, unknown> | null => {
  try { const v: unknown = JSON.parse(readPlainText(f)); return v && typeof v === 'object' ? v as Record<string, unknown> : null; } catch { return null; }
};
const hasHook = (hooks: unknown, event: string): boolean => {
  const h = hooks && typeof hooks === 'object' ? (hooks as Record<string, unknown>)[event] : undefined;
  return Array.isArray(h) && h.length > 0;
};

/**
 * Where a PreToolUse hook other than Angelia's would run in a pane started in `cwd`: the settings files
 * Claude Code merges with ours, and the hooks files of the plugins they enable (as installed_plugins.json
 * places them). Such a hook runs next to Angelia's and can still be at work after Angelia's has ended,
 * so the lock that keeps a dialog from opening under a typed-in Enter no longer holds (tui.ts, absorb).
 * A plugin that registers its hooks from code (`modules`) cannot be read here and is not named.
 */
export function otherPreToolUseHooks(cwd: string, home = homedir()): string[] {
  const out: string[] = [];
  const enabled = new Set<string>();
  for (const f of mergedSettingsFiles(cwd, home)) {
    const s = readJson(f);
    if (!s) continue;
    if (hasHook(s.hooks, 'PreToolUse')) out.push(f);
    const plugins = s.enabledPlugins;
    if (plugins && typeof plugins === 'object') for (const [name, on] of Object.entries(plugins)) { if (on === true) enabled.add(name); else enabled.delete(name); }
  }
  const installed = readJson(join(home, '.claude', 'plugins', 'installed_plugins.json'));
  const table = (installed?.plugins ?? installed ?? {}) as Record<string, unknown>;
  for (const name of enabled) {
    const rows = Array.isArray(table[name]) ? table[name] as { installPath?: unknown }[] : [];
    for (const r of rows) {
      if (typeof r?.installPath !== 'string') continue;
      const file = join(r.installPath, 'hooks', 'hooks.json');
      if (hasHook(readJson(file)?.hooks, 'PreToolUse')) out.push(`plugin ${name} (${file})`);
    }
  }
  return out;
}

/** One warning per tui profile whose Stop hook would run beside Angelia's. */
export function tuiHookWarnings(profiles: Record<string, Profile>, home = homedir()): string[] {
  return Object.entries(profiles).filter(([, p]) => p.tui && p.backend === 'claude-code').flatMap(([name, p]) => {
    const f = otherStopHooks(p.cwd, home);
    return f.length ? [`profiles.${name}: tui: true, and ${f.join(', ')} has a Stop hook of its own; it runs after every Angelia turn too, since --settings merges hooks instead of replacing them`] : [];
  });
}

/** `tmux -V` as printed ("tmux 3.6a"), or null when tmux is not installed. */
export function tmuxVersion(): string | null {
  try { return execFileSync('tmux', ['-V'], { encoding: 'utf8', timeout: 5000 }).trim(); } catch { return null; }
}

/**
 * tmux sanitises a pasted buffer only from 3.7 on ("Pass paste buffer through vis(3)", CHANGES 3.6b
 * to 3.7). Before that, an escape sequence inside a message could end the paste early and type the
 * rest into the CLI. Angelia strips control characters from every message (cleanText), so this is a
 * warning and not a refusal; the upgrade closes whatever tmux itself might still let through.
 */
export function tmuxWarnings(profiles: Record<string, Profile>, version: string | null = tmuxVersion(), platform: NodeJS.Platform = process.platform): string[] {
  const tui = Object.entries(profiles).filter(([, p]) => p.tui && p.backend === 'claude-code').map(([n]) => n);
  if (!tui.length) return [];
  if (version === null) return [`tui: true in ${tui.join(', ')}, and tmux is not installed: those chats cannot start. brew install tmux`];
  const m = /(\d+)\.(\d+)/.exec(version);
  if (!m || Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 7)) return [];
  return [`tui: true in ${tui.join(', ')}, and ${version} is older than 3.7, which is the first to clean pasted text. Angelia strips control characters from messages, but upgrade: ${platform === 'darwin' ? 'brew upgrade tmux' : 'upgrade tmux to 3.7+'}, then tmux -L angelia kill-server when the chats are quiet (every pane resumes on its next message)`];
}

/** The start of the reason a pane gives when it died before its first prompt. */
export const START_EXIT = 'the agent exited while starting';

/** What a pane was launched with, minus the one pair that differs between a first launch and a
 *  resume of the same session. A pane from before fingerprints existed has none, so it counts as stale.
 *  The Stop hook's script path counts too: Claude reads its settings once, at launch, so a pane
 *  started before the package moved would keep calling a script that is no longer there. */
export function launchFingerprint(argv: string[], hook = HOOK, extra: string[] = []): string {
  const a = [...argv];
  const i = a.findIndex((x) => x === '--resume' || x === '--session-id');
  if (i !== -1) a.splice(i, 2);
  return createHash('sha256').update([...a, `hook=${hook}`, ...extra].join('\0')).digest('hex');
}

/** Take names out of the global environment of Angelia's tmux server, when one is running. A server
 *  keeps the environment of whatever started it for as long as it lives, and hands it to every new
 *  pane: one started by a daemon that still held the bot token would give it to every agent after
 *  an upgrade. Returns the names that were there, never their values. */
export async function scrubTmuxServer(names: string[], env?: NodeJS.ProcessEnv): Promise<string[]> {
  const r = await tmux(['show-environment', '-g'], { env });
  if (r.code !== 0) return []; // no server running: nothing to clean
  const present = new Set(r.out.split('\n').map((l) => l.split('=')[0]));
  const found = [...new Set(names)].filter((n) => present.has(n)).sort();
  for (const n of found) await tmux(['set-environment', '-g', '-u', n], { env });
  return found;
}

/** Settings files Claude Code reads for this folder, the managed one included. */
export function claudeSettingsFiles(cwd: string, home = homedir()): string[] {
  return [join(home, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json'),
    '/Library/Application Support/ClaudeCode/managed-settings.json'];
}

/**
 * What print mode learns from the CLI's first line (the billing source, the version) and refuses on,
 * checked before a pane is started, since a pane prints no such line. An apiKeyHelper in any settings
 * file the session reads switches it to per-token billing; the variables are unset already. A key
 * stored by /login is not visible from outside and is not checked. Returns the refusal, or null.
 */
export async function tuiLaunchProblem(bin: string, cwd: string, env: NodeJS.ProcessEnv, home = homedir()): Promise<string | null> {
  for (const f of claudeSettingsFiles(cwd, home)) {
    let s: { apiKeyHelper?: unknown } | undefined;
    try { s = JSON.parse(readPlainText(f)); } catch { continue; }
    if (s?.apiKeyHelper) return `billing: ${f} sets apiKeyHelper, so this session would bill an API key instead of the subscription`;
  }
  const out = await new Promise<string>((done) => execFile(bin, ['--version'], { env, timeout: 15_000 }, (_e, stdout) => done(String(stdout ?? ''))));
  const v = /(\d+\.\d+\.\d+)/.exec(out)?.[1];
  if (v && !versionAtLeast(v, MIN_CLAUDE_VERSION)) return `version: claude ${v} < ${MIN_CLAUDE_VERSION}`;
  return null;
}

/** A value for a POSIX shell, in single quotes. */
const shq = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;

/** Settings handed to the session: the Stop hook that reports the turn's answer, and the
 *  PermissionRequest hook that carries each request to the chat (tui-permissions.ts). `--settings` is
 *  merged with the user's and the project's settings, not a replacement for them (claude-code#11392):
 *  a Stop hook of their own also runs on every Angelia turn. `otherStopHooks` names those files. */
export function hookSettings(hook = HOOK, permission = PERMISSION_HOOK, pretool: string | null = null): unknown {
  return {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: `node ${JSON.stringify(hook)}`, timeout: 150 }] }],
      PermissionRequest: [{ hooks: [{ type: 'command', command: `node ${JSON.stringify(permission)}`, timeout: PERMISSION_HOOK_TIMEOUT_S }] }],
      // The lock that keeps a permission dialog from opening under the Enter of a chat message typed into
      // a running turn (scripts/tui-pretool-hook.mjs). Only where that is on (`midturn`): it runs before
      // every tool call.
      ...(pretool ? { PreToolUse: [{ hooks: [{ type: 'command', command: `node ${JSON.stringify(pretool)}`, timeout: PRETOOL_HOOK_TIMEOUT_S }] }] } : {}),
    },
  };
}

/** For a dialog on the pane that did not come through the hook (tui-permissions.ts, ScreenDialogs).
 *  `socket`: the tmux server the pane is on, when not Angelia's own. */
export function screenOnlyLine(pane: string, socket = TMUX_SOCKET, dialog?: { tool: string; from?: string }): string {
  if (dialog) return `A permission waits: ${askedBy(dialog)}. It did not come through Angelia, so only the screen says what it asks and it cannot be answered from here. Answer it in the Claude app, or in the pane (tmux -L ${socket} attach -t '=${pane}'); /stop ends the turn.`;
  return `A permission dialog is open that did not come through Angelia, so only the screen says what it asks and it cannot be answered from here. Answer it in the Claude app, or in the pane (tmux -L ${socket} attach -t '=${pane}'); /stop ends the turn.`;
}

/**
 * One Claude Code session living in a tmux pane, the way a person runs it. Angelia types the turn
 * into the pane, a Stop hook writes the answer to a file, and this class turns the transcript into
 * the same progress / permission / result events every other backend emits.
 *
 * What it buys over print mode: the session appears in the Claude app (Remote Control only ever
 * worked for an interactive session), it survives a daemon restart because the pane is on Angelia's
 * own tmux server, MCP servers and background tasks live between turns, and slash commands behave
 * exactly as they do in a terminal. What it costs: the pane is read with `capture-pane`, so the
 * markers below are strings on a screen, not a protocol.
 */
export class TuiBrain extends EventEmitter implements Brain {
  private permissions: PermissionBook;
  /** Requests between the chat's turns, from a turn the agent started by itself (betweenTurns): a book
   *  of their own, which the end of a chat turn does not clear. */
  private selfBook: PermissionBook;
  /** Those requests by id, and those answered in the pane or the app whose outcome the transcript has
   *  yet to show (decide). */
  private selfAsked = new Map<string, { tool: string; input: unknown }>();
  private selfDeciding = new Map<string, { tool: string; input: unknown; since: number }>();
  /** Counts the Stop markers taken between turns: the requests of one turn the agent started by itself
   *  share a number (the orchestrator caps auto-approvals per turn). */
  private selfTurn = 0;
  /** The heartbeat on file is the reader between turns' (`idle`), not a turn's; and when it was written. */
  private idleBeat = false;
  private idleBeatAt = 0;
  private relay: PermissionRelay;
  /** When a relayed request last came, was answered or went: a dialog on the pane just then is its own. */
  private relayedAt = 0;
  /** The heartbeat of the turn read from the chat now, and the reader (`gen`) it belongs to. */
  private beating?: { timer: NodeJS.Timeout; gen: number };
  private ready?: Promise<string | null>;
  private up = false;
  private transcript: string;
  /** The transcript this brain reads now: the pane reap reads a parked pane's open tasks there. */
  get transcriptFile(): string { return this.transcript; }
  private at = 0;
  /** Where this turn's rows begin in the transcript, for reading how a request answered in the pane went. */
  private from = 0;
  /** Where the turn stands by the rows read from `from` on (turnRows): the second sign, next to the
   *  screen, of whether the turn is over. */
  private rows: TurnRows = 'none';
  /** One line for the chat before the next turn's answer, when the launch had to say something (a lost conversation). */
  private notice: string | null = null;
  lastUsedAt = Date.now();
  version = '';
  backendSessionId?: string;
  /** tmux session name and Remote Control name: the same readable string in both places. */
  readonly name: string;
  /** When the turn now running was typed in; unset between turns. Markers older than it are not its answer. */
  turnSentAt?: number;
  /** Bumped whenever the reader of the pane changes (a release, the background, a follow): a watch
   *  loop that sees it move stops reading, so two loops never read one pane. */
  private gen = 0;
  /** Tool-use ids of the background tasks started in Angelia's turns (read while a turn of its own
   *  ran, or in a turn tied to the chat's work: settleSpawns). A task the owner started from the app is
   *  not among them. */
  private ours = new Set<string>();
  /** The calls that may start a background task, until their result row is read (backgroundRows). */
  private calls = new Map<string, 'bash' | 'agent'>();
  /** The named teammates spawned in this session and still open (no end of theirs read, and spawned
   *  less than TEAMMATE_MAX_MS ago), by name: the tool_use id of the call that spawned it, and when. */
  private openTeammates = new Map<string, { id: string; at: number }>();
  /** The background tasks open here, of any kind (a shell command, a subagent, a teammate; started by
   *  anyone), by tool_use id, and when: no end read, and not past TEAMMATE_MAX_MS. What keeps the
   *  pane from the reaps. */
  private openTasks = new Map<string, number>();
  /** The names of the teammates spawned in Angelia's turns (the Agent tool with a `name`): a turn their
   *  message starts is the chat's, as a task's end is. */
  private oursTeammates = new Set<string>();
  /** Of those, the ones whose last start was read in a turn another profile asked for (TurnFlags.peer),
   *  or in a turn tied to such work: a request of a turn they start is never approved by the levels. */
  private peerIds = new Set<string>();
  private peerTeammates = new Set<string>();
  /** The team each spawned teammate's name was last spawned in, when its spawn said it (isOurs). */
  private teams = new Map<string, string>();
  /** The names whose teammate's end was read: dropped once its report is judged, or at the second Enter
   *  after its end (endedAtEnter). */
  private endedTeammates = new Set<string>();
  /** The ended names an Enter found: a teammate's last report can still be queued in Claude Code at that
   *  Enter (it runs during or after that turn), so they go only at the next Enter, when that turn and
   *  any turn Claude Code ran after it were read (review-045). */
  private endedAtEnter = new Set<string>();
  /** The turn typed here now is a peer's (TurnFlags.peer). */
  private turnPeer = false;
  /** Tasks and teammates started while no turn of Angelia's was read, since the last Stop marker taken
   *  between turns: when takeIdle finds that turn was the chat's (tied to its work, a late answer, a
   *  message typed into a turn), they are the chat's too; else they are not (settleSpawns). */
  private pendingSpawns: { id: string; at: number; teammate?: string; team?: string }[] = [];
  /** Where in the transcript the row being read starts: what a spawn read in it is stamped with. */
  private rowAt = 0;
  /** The rows read that began a turn of the session's (a prompt, a task's end, a teammate's message
   *  after a closed turn): their offset and time, the last TURN_STARTS_MAX. takeIdle settles only the
   *  spawns of the marker's own turn (turnSpan): an owner's turn before it, cut by Esc or typed in the
   *  desk app, or one after it, keeps its spawns out of the chat's. */
  private turnStarts: { at: number; time: number }[] = [];
  /** turnRows of the rows read so far, for turnStarts. */
  private startState: TurnRows = 'none';
  /** The session's tool calls still owed a result, for noteStart. */
  private startOwed = new Set<string>();
  /** Rows read now are of a turn Angelia typed here: set at its Enter (submit), cleared when that turn
   *  ends or its reader changes. Not turnSentAt: adopt() sets that with the transcript read from its
   *  start, and a released pane keeps it. */
  private recording = false;
  /** The last turn typed here that ended with no Stop marker (the quiet path), until its marker comes
   *  or another turn begins: when it was typed, when it was closed, and what the chat got as its answer. */
  private quietEnd?: { sentAt: number; endedAt: number; said: string; key: string; taken: string[]; peer: boolean };
  /** The key (promptKey) of what this turn typed, from its Enter until the turn ends. */
  private typedKey = '';
  /** Which path set typedKey (`turn`: a message typed; `follow`: the untaken messages of the last turn,
   *  which Claude Code runs as a turn of its own), and what was typed in promptForm ('' when it is not
   *  one text here). For the key miss line and its net (keptOnMiss). */
  private typedBy = '';
  private typedForm = '';
  /** The same key, for holding a request to the turn it was typed for (ofThisTurn): unlike typedKey it
   *  is kept when that turn is read again (follow: /resume, or a restart, which carries it: turnKey). */
  private tieKey = '';
  /** Every key of an adopted turn that Claude Code ran for several messages (restoreTurnKey). */
  private restoredKeys: string[] = [];
  /** Messages an Enter was pressed for in a running turn that was not seen to take them, by message
   *  (the orchestrator's id for it, else its key): its key and text, the transcript and its size at that
   *  Enter, the time of it, the turn it was pressed into, and whether a turn Claude Code ran for it was answered already (followerOf).
   *  Looked at once more before each is typed as a turn of its own. From its Enter on, it is the chat's
   *  own (typedByUs, followerOf): Claude Code may take it late and run it by itself. */
  private unsure = new Map<string, Unsure>();
  /** The reader between turns (startIdle): it looks for a Stop marker no turn of Angelia's waits for. */
  private idle?: NodeJS.Timeout;
  /** Since when this object reads the session: its first turn. A marker from before is of a time when
   *  nobody held the session, and is not delivered late. */
  private heldSince?: number;
  /** Chat messages typed into a running turn (absorb): the key of each (promptKey), when it was typed,
   *  the turn it went into (its turnSentAt), and whether the transcript shows that turn took it (a
   *  `queued_command` row). One the turn did not take, Claude Code runs as the next turn by itself
   *  (measured on 2.1.332): that turn is the chat's, and its answer is delivered (takeIdle). */
  private absorbed: Absorbed[] = [];
  /** The session's own tool calls still without a result, as the transcript shows them: the tool and
   *  when its call was read. A message goes into the turn only while one runs (intoTurnBlocked). */
  private openCalls = new Map<string, { name: string; at: number }>();
  /** One message goes into a running turn at a time, in the order they came. */
  private absorbing: Promise<unknown> = Promise.resolve();
  /** The last capture's tmux call timed out (TmuxResult.timedOut): an empty screen that is no answer. */
  private captureTimedOut = false;
  /** The daemon stops (stopAbsorbing): no message is typed into the turn from now on. */
  private closing = false;
  /** A message typed into the turn is between its Enter and the end of its absorb (taken or not). */
  private pressed = false;
  /** How the messages typed into the last turn went (absorbOutcome), until read. */
  private outcome?: { taken: number; untaken: number };
  /** Messages the last turn did not take, which Claude Code runs as the next turn: since when, and
   *  their keys, until followAbsorbed reads that turn (closeAbsorbed). */
  private following?: { since: number; keys: string[]; claimed: boolean; scanFrom: number; msgs: Absorbed[] };
  /** While followAbsorbed reads: the keys of the prompts that turn may hold. */
  private followKeys: string[] = [];

  /** Why chat messages are not typed into this session's turns although the profile's `midturn` is on:
   *  another PreToolUse hook runs in it (otherPreToolUseHooks). For /status. Unset otherwise. */
  midturnOff?: string;

  /** Chat messages that come while a turn runs may go into it: the profile's `midturn` (unset is on),
   *  unless the caller says this session cannot take them, and unless another PreToolUse hook runs in
   *  the session. */
  private get midturn(): boolean { return (this.opts.midturn ?? this.profile.midturn !== false) && !this.midturnOff; }

  /** Read once per launch or reattach: another PreToolUse hook in the merged settings turns midturn off
   *  for this pane, said once in the log. */
  private checkOtherHooks(): void {
    if (!(this.opts.midturn ?? this.profile.midturn !== false)) { this.midturnOff = undefined; return; }
    const others = otherPreToolUseHooks(this.profile.cwd, this.opts.settingsHome);
    const was = this.midturnOff;
    this.midturnOff = others.length ? `messages wait for the turn to end: another PreToolUse hook runs in this session (${others.join(', ')}), so the lock that keeps a permission dialog from opening under a typed-in message does not hold` : undefined;
    if (this.midturnOff && this.midturnOff !== was) this.emit('log', `tmux: midturn off for pane ${this.name}: ${others.length} other PreToolUse hook(s): ${others.join(', ')}`);
  }

  constructor(
    readonly profile: Profile,
    readonly session: BrainSession,
    private readonly opts: BrainOptions = {},
  ) {
    super();
    this.name = remoteControlName(profile, session);
    this.transcript = transcriptPath(profile.cwd, session.id);
    this.relay = new PermissionRelay(join(this.dir, 'permissions'));
    this.permissions = new PermissionBook(opts.permissionTimeoutMs ?? 10 * 60_000, (id) => { if (this.answerPermission(id, false)) this.emit('permission-timeout', id); });
    this.selfBook = new PermissionBook(opts.permissionTimeoutMs ?? 10 * 60_000, (id) => { if (this.answerPermission(id, false)) this.emit('permission-timeout', id); });
  }

  get alive(): boolean { return this.up; }
  get pendingPermissionCount(): number { return this.permissions.size + this.selfBook.size; }
  hasPendingPermission(id: string): boolean { return this.permissions.has(id) || this.selfBook.has(id); }

  private get stateDir(): string { return this.opts.stateDir ?? process.env.ANGELIA_STATE_DIR ?? join(homedir(), '.angelia'); }
  private get dir(): string { return join(this.stateDir, 'tui', this.name); }
  private get settingsPath(): string { return join(this.dir, 'settings.json'); }
  private get markerPath(): string { return join(this.dir, 'turn.json'); }
  private get launchPath(): string { return join(this.dir, 'launch.sha256'); }
  private get envPath(): string { return join(this.dir, 'env'); }

  /** The tmux server this pane is on: Angelia's own, unless the caller named another (the canary). */
  private get socket(): string { return this.opts.tmuxSocket ?? TMUX_SOCKET; }

  /** Every tmux call runs with the server's environment, never the agent's: the first call starts the
   *  server, and every profile's panes inherit what it started with. */
  private tm(args: string[], o: { scope?: boolean } = {}) {
    return tmux(args, { env: this.opts.hostEnv ?? childEnv(process.env), socket: this.socket, ...o });
  }

  /** The launch, plus what decides the agent's environment and permissions: a change in any of them
   *  relaunches an idle pane. Claude reads the compiled settings once, at launch, so a new deny from
   *  `angelia compile` reaches a pane only through a relaunch. */
  private fingerprint(resume: boolean): string {
    const rec = readRecord(this.profile.cwd);
    // The sandbox flag only when set, so records from before it existed keep their fingerprint.
    // The MCP keys of the settings file too (connectors, tuiSettings), only when there are any, as the sandbox flag.
    const mcp = (this.opts.mcp ?? mcpLaunch(this.profile.cwd)).settings;
    const compiled = rec ? JSON.stringify([rec.deny, rec.additionalDirectories, rec.mcpServers, rec.mcpStrict, ...(rec.sandbox ? ['sandbox'] : []), ...(Object.keys(mcp).length ? [mcp] : [])]) : 'none';
    return launchFingerprint(this.argv(resume), HOOK, [`granted=${(this.opts.granted ?? []).join(',')}`, `withheld=${(this.opts.withheld ?? []).join(',')}`, `compiled=${compiled}`, `env=${Object.entries(CLAUDE_ENV).map(([k, v]) => `${k}=${v}`).join(',')}`, `permission-hook=${PERMISSION_HOOK}`]);
  }

  start(): void { this.ready = this.ensure().then((r) => { if (r === null) void this.checkConnectors(); return r; }); }

  /**
   * connectors: all: the pane's version of the print-mode count (ClaudeBrain.checkBlocked), from two
   * `claude mcp list` runs, no model call (connectors-check.ts). Once per daemon start per profile and
   * deny list while all is well; a run that could not tell, or fell short, runs again at the next pane
   * start. The checks of all panes run one profile at a time. A start that blocks fewer connectors
   * than the launch drops says so in the log and as `connectors-short`, with the names it blocked.
   */
  async checkConnectors(): Promise<void> {
    const settings = (this.opts.mcp ?? mcpLaunch(this.profile.cwd)).settings;
    const denied = deniedConnectorCount(settings);
    const key = `${this.profile.cwd}\0${JSON.stringify(settings)}`;
    if (!denied || connectorChecks.has(key)) return;
    connectorChecks.add(key);
    const blocked = await tuiBlockedConnectors(this.opts.bin ?? 'claude', this.profile.cwd, { ...childEnv(this.opts.env), ...CLAUDE_ENV }, settings, this.stateDir, this.opts.mcpListTimeoutMs);
    if (!blocked) { connectorChecks.delete(key); this.emit('log', `connectors: all: pane ${this.name}: claude mcp list did not tell which connectors are blocked (it failed, or named none); checked again at the next pane start`); return; }
    const short = blockedShort(denied, blocked);
    if (!short) return;
    // Counted again at the next pane start: the owner's notice may not have gone out (the orchestrator
    // says it once per profile and names, after it was sent).
    connectorChecks.delete(key);
    this.emit('log', `warning: ${short}`);
    this.emit('connectors-short', short, blocked);
  }

  /** The start's outcome, for a caller that wants it apart from the first turn (canary.ts): null once
   *  the pane is at a prompt, else the line that says why it is not. */
  whenReady(): Promise<string | null> { return this.ready ?? Promise.resolve('brain not started'); }

  /** Attach to the pane if it is already there (a restarted daemon finds its agents alive),
   *  otherwise start one. Resolves to an error line, or null when the session is usable.
   *
   *  A pane that survives a restart keeps the argv it was born with, so a new self prompt, model or
   *  add_dirs would never reach it. Each launch records a fingerprint of its argv; on reattach a
   *  different one means the pane is stale, and an idle stale pane is relaunched with --resume, which
   *  keeps the conversation. A busy one is left alone: cutting a turn is worse than one more stale turn. */
  private async ensure(): Promise<string | null> {
    let resume = this.session.started;
    this.checkOtherHooks();
    if (await this.sessionAlive()) {
      // A daemon restart during a start, or an idle pane that asks: nothing else would answer it.
      const tries = noTries();
      while ((await this.resumeStep(await this.capture(40), tries)) === 'wait') await sleep(250);
      if (this.launchedWith() === this.fingerprint(true)) return null;
      if (!paneIdle(await this.capture(40))) return null;
      await this.tm(['kill-session', '-t', exact(this.name)]);
      this.up = false;
      resume = true;
    }
    const env = childEnv(this.opts.env);
    const refused = await tuiLaunchProblem(this.opts.bin ?? 'claude', this.profile.cwd, env);
    if (refused) return refused;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.settingsPath, JSON.stringify(tuiSettings(this.profile, hookSettings(HOOK, PERMISSION_HOOK, this.midturn ? PRETOOL_HOOK : null), this.opts.mcp), null, 2));
    this.relay.reset();
    // A new pane: no PreToolUse hook of an earlier one runs, and its marks and its last end are not this one's.
    rmSync(join(this.dir, 'pretool'), { recursive: true, force: true });
    const pinned: string[] = [];
    for (const k of ['PATH', 'HOME', 'LANG', 'SHELL', 'ANGELIA_SESSION_KEY']) {
      if (env[k]) pinned.push('-e', `${k}=${env[k]}`);
    }
    pinned.push('-e', `ANGELIA_TUI_MARKER=${this.markerPath}`);
    for (const [k, v] of Object.entries(CLAUDE_ENV)) pinned.push('-e', `${k}=${v}`);
    // The tmux server is long-lived and carries whatever environment started it, so the billing
    // variables and every secret this profile was not given are unset for the child itself, rather
    // than merely left out of ours.
    const unset = [...STRIP_ENV, ...(this.opts.withheld ?? [])].flatMap((k) => ['-u', k]);
    // The secrets it was given go through a file only this user can read, which the pane deletes
    // once it has read it: `-e` would leave them in the session's environment for any process of
    // this user to list with `tmux show-environment`.
    rmSync(this.envPath, { force: true });
    const granted = (this.opts.granted ?? []).filter((k) => env[k] !== undefined);
    const wrap: string[] = [];
    if (granted.length) {
      writeFileSync(this.envPath, granted.map((k) => `export ${k}=${shq(env[k]!)}`).join('\n') + '\n', { mode: 0o600 });
      wrap.push('/bin/sh', '-c', '. "$0"; rm -f "$0"; exec "$@"', this.envPath);
    }
    if (resume && this.opts.projectsDir) {
      const placed = placeTranscript(this.profile.cwd, this.session.id, this.opts.projectsDir);
      if (placed.status === 'copied') this.emit('log', `transcript ${this.session.id.slice(0, 8)} copied from ${placed.from} for ${this.profile.cwd}`);
      if (placed.status === 'missing') {
        // The conversation is gone from every project folder: `--resume` would end the launch with
        // "No conversation found", every turn, until someone typed /new. Start fresh under the same id
        // instead, and say so in the chat once.
        this.emit('log', `transcript ${this.session.id.slice(0, 8)} not found under ${this.opts.projectsDir}; starting fresh in ${this.profile.cwd}`);
        this.notice = LOST_SESSION_LINE;
        resume = false;
      }
    }
    const argv = this.argv(resume);
    // remain-on-exit off in the same call: the server reads the user's ~/.tmux.conf, and a dead pane
    // left on screen would pass for a live session, so a turn would wait on it for ever.
    const r = await this.tm(['new-session', '-d', '-s', this.name, '-c', this.profile.cwd, '-x', '220', '-y', '50', ...pinned, ...wrap, 'env', ...unset, ...argv, ';', 'set-option', '-w', '-t', exact(this.name), 'remain-on-exit', 'off'], { scope: true });
    if (r.code !== 0) { rmSync(this.envPath, { force: true }); return `tmux could not start the session: ${r.err.trim() || 'new-session failed'}`; }
    writeFileSync(this.launchPath, this.fingerprint(resume));
    this.up = true;
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? START_TIMEOUT_MS);
    let asked: { dir: string; at: number; answered: number } | undefined;
    const answered = new Set<string>();
    let unlisted: string | undefined;
    const cold = noTries();
    while (Date.now() < deadline) {
      // The pane is gone with its output, so say what was run and where: that is the one way to see why.
      if (!(await this.sessionAlive())) { this.up = false; return `${START_EXIT} (${argv[0]} in ${this.profile.cwd}; run it there by hand to see why)`; }
      const pane = await this.capture(40);
      // Dialogs before the prompt: each counts only as the last dialog on screen with no input box
      // below it, so a resumed conversation that quotes one is the prompt. Idle first would let a
      // stale frame in the history (between two rules) pass for a box while a dialog is open.
      if (trustDialogOpen(pane)) { await this.acceptDialog(trustDialogOpen, trustAccepted); continue; }
      if (importsDialogOpen(pane)) { await this.acceptDialog(importsDialogOpen, importsAccepted); continue; }
      // Only a --resume launch asks it here. Past the last try it stands, and the start fails with its screen kept.
      const cool = resume ? await this.resumeStep(pane, cold) : 'none';
      if (cool !== 'none') { await sleep(250); continue; }
      const dir = addDirDialog(pane);
      if (dir !== null) {
        // claude 2.1.326 drops keys for about a second after it draws this dialog (measured: Down and
        // Enter at once leave it on "No"), and a profile with two new folders gets one dialog each.
        // So wait until a folder's dialog has stood ADD_DIR_SETTLE_MS, and give an answer time to land
        // before the same folder is answered again.
        if (asked?.dir !== dir) asked = { dir, at: Date.now(), answered: 0 };
        // Yes only for a folder the owner listed in add_dirs: that line was the answer. Anything else
        // stays unanswered, and once it has stood as long (one frame drawn mid-redraw is no answer)
        // the start fails with the folder named.
        if (!addDirListed(dir, this.profile.add_dirs, homedir(), this.profile.cwd)) {
          if (Date.now() - asked.at < ADD_DIR_SETTLE_MS) { await sleep(250); continue; }
          this.emit('log', `pane ${this.name} asks to add ${dir}, which is not in add_dirs`);
          unlisted = dir;
          break;
        }
        if (Date.now() - asked.at < ADD_DIR_SETTLE_MS || Date.now() - asked.answered < ADD_DIR_SETTLE_MS * 2) { await sleep(250); continue; }
        // Bound to this folder: when its dialog closes and the next folder's opens, that one waits for
        // its own listed check and settle time, and gets no Down or Enter meant for this one.
        // The same folder can be answered more than once (an Enter dropped while the dialog was new).
        if (await this.acceptDialog((p) => addDirDialog(p) === dir, addDirAccepted) && !answered.has(dir)) {
          answered.add(dir);
          this.emit('log', `pane ${this.name} answered add-dir ${dir}`);
        }
        asked.answered = Date.now();
        continue;
      }
      if (paneIdle(pane)) return null;
      await sleep(500);
    }
    // The pane is about to be killed with its screen, so keep what it showed: that is the one way
    // to learn which dialog or error held it, without a terminal open at the right second.
    // Kept in the pane's private folder, not the log: on a resume the screen can show the conversation.
    const screen = join(this.dir, 'screen.txt');
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(screen, `${new Date().toISOString()}\n${await this.capture(40)}\n`, { mode: 0o600 });
      this.emit('log', `pane ${this.name} never reached a prompt; its screen is in ${screen}`);
    } catch { this.emit('log', `pane ${this.name} never reached a prompt`); }
    // Named, so the owner sees which folder to list (or why claude asks about it) without the log.
    if (unlisted !== undefined) return `the session did not start: claude asks to add the folder ${unlisted}, which is not in this profile's add_dirs`;
    return `the session never reached a prompt (look with: tmux -L ${this.socket} attach -t '=${this.name}')`;
  }

  private argv(resume: boolean): string[] {
    return claudeTuiArgv(this.profile, { ...this.session, started: resume }, this.opts.bin ?? 'claude', this.settingsPath, this.name, this.opts.system, this.opts.mcp);
  }

  private launchedWith(): string | undefined {
    try { return readFileSync(this.launchPath, 'utf8').trim(); } catch { return undefined; }
  }

  /** The first run in a directory asks whether the folder is trusted, with "No, exit" preselected,
   *  and then whether its CLAUDE.md may import files outside it, with "No" preselected again.
   *  routing.yaml already names this directory as the profile's home and the permission mode it
   *  runs under, and the imports are the owner's own shared doctrine, so the answer was given when
   *  that line was written; press it instead of hanging. `accepted` says the cursor is on the yes
   *  row; it is checked before Enter, so a redraw can never turn this into "No". `open` says the
   *  same dialog is still the one on screen; once it is not, no key is sent, since a key meant for
   *  this dialog would answer the next one. */
  private async acceptDialog(open: (pane: string) => boolean, accepted: (pane: string) => boolean): Promise<boolean> {
    for (let i = 0; i < 8; i++) {
      const pane = await this.capture(40);
      if (!open(pane)) return false;
      if (accepted(pane)) { await this.tm(['send-keys', '-t', exact(this.name), 'Enter']); return true; }
      await this.tm(['send-keys', '-t', exact(this.name), 'Down']);
      await sleep(300);
    }
    return false;
  }

  /** One look at the resume dialog, if `pane` shows it open on a session not at work. It stands a settle
   *  time before a key, a key gets time to land, and there are RESUME_PRESSES tries. 'none': no dialog.
   *  'spent': it stands after the last try. 'wait': look again. */
  private async resumeStep(pane: string, t: ResumeTries): Promise<'none' | 'wait' | 'spent'> {
    if (!resumeDialog(pane) || paneBusy(pane)) return 'none';
    t.at ||= Date.now();
    if (Date.now() - t.at < ADD_DIR_SETTLE_MS || Date.now() - t.pressedAt < ADD_DIR_SETTLE_MS * 2) return 'wait';
    if (t.presses >= RESUME_PRESSES) return 'spent';
    t.presses++;
    const how = await this.answerResume();
    t.pressedAt = Date.now();
    if (how && !t.logged.has(how)) {
      t.logged.add(how);
      this.emit('log', how === 'refused'
        ? `pane ${this.name} shows the resume dialog, and the cursor did not reach "Resume": no Enter pressed`
        : `pane ${this.name} answered the resume dialog with ${how}: resume`);
    }
    return 'wait';
  }

  /** Chooses "Resume", never the new conversation: Esc where the dialog says Esc resumes or dismisses, else
   *  Enter with the cursor on "Resume", after one Up when it is not. Null: the dialog closed before a key. */
  private async answerResume(): Promise<'Esc' | 'Enter' | 'refused' | null> {
    let d = resumeDialog(await this.capture(40));
    if (!d) return null;
    if (d.esc) { await this.tm(['send-keys', '-t', exact(this.name), 'Escape']); return 'Esc'; }
    if (!d.onResume) {
      await this.tm(['send-keys', '-t', exact(this.name), 'Up']);
      await sleep(300);
      d = resumeDialog(await this.capture(40));
      if (!d) return null;
      if (!d.onResume) return 'refused';
    }
    await this.tm(['send-keys', '-t', exact(this.name), 'Enter']);
    return 'Enter';
  }

  private async sessionAlive(): Promise<boolean> {
    const r = await this.tm(['has-session', '-t', exact(this.name)]);
    this.up = r.code === 0;
    return this.up;
  }

  private async capture(lines = 30): Promise<string> {
    const r = await this.tm(['capture-pane', '-p', '-t', exact(this.name), '-S', `-${lines}`]);
    // A call killed at its time limit says nothing of the pane: the next poll reads it again.
    this.captureTimedOut = r.timedOut === true;
    return r.code === 0 ? r.out : '';
  }

  /** Type one message into the pane: wait for a prompt, paste (newlines stay inside one message),
   *  check it landed, then Enter. Never press Enter on an unverified box. `submit` runs right before
   *  Enter, once the pane is idle and the text has landed: whatever the turn measures from (the
   *  transcript size, the Stop marker, the time) starts there, not before a wait in which someone
   *  else's turn in the Claude app could finish. `gen`: the reader this paste is for; a handoff
   *  during the wait takes the pane, and then nothing is typed into it. */
  private async paste(raw: string, submit: () => void = () => {}, gen = this.gen): Promise<Pasted> {
    // The last gate before text becomes keys: whoever called, no control character reaches the pane.
    const text = cleanText(raw);
    const deadline = Date.now() + (this.opts.promptTimeoutMs ?? PROMPT_TIMEOUT_MS);
    // Whether the screen changed while the message waited: a CLI at work redraws its spinner clock,
    // background agents their rows. A screen that never moved for the whole wait is a hung CLI.
    let moved = false;
    const tries = noTries();
    for (let attempt = 1; ; attempt++) {
      let pane = await this.capture(30);
      while (!paneIdle(pane)) {
        if (!(await this.sessionAlive())) return { ok: false, why: 'exit', keep: false };
        if (gen !== this.gen) return { ok: false, why: 'released', keep: true };
        if (Date.now() > deadline) return this.notTyped(pane, moved);
        // An idle session may ask whether to resume: nobody else answers, and the message would wait it out.
        await this.resumeStep(pane, tries);
        await sleep(POLL_MS);
        const now = await this.capture(30);
        if (now !== pane) moved = true;
        pane = now;
      }
      // Text already in the box would go with ours: a message half cleared by an earlier failure, a
      // paste a restart cut before its Enter, something typed in the app and not sent, a prompt called
      // back from the history. Cleared from any cursor (clearBox), and what it was is said; what the
      // clear could not reach keeps the paste from its Enter (boxHoldsOnly, below).
      const box = await this.clearBox();
      if (box.held) this.emit('log', `tmux: the input box held text before a paste; ${box.left ? `${box.left === box.held ? 'it did not change' : 'not all of it went'}, the paste goes in only if the box then holds it alone` : 'cleared'}: ${box.held.length} chars pane=${this.name}`);
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      if ((await loadBuffer(this.name, text, this.dir, (a) => this.tm(a))).code !== 0) {
        this.emit('log', `tmux: the message could not be loaded into a paste buffer pane=${this.name}`);
        return { ok: false, why: 'tmux could not load the message into the session', keep: true };
      }
      await this.tm(['paste-buffer', '-p', '-d', '-b', this.name, '-t', exact(this.name)]);
      const landBy = Date.now() + (this.opts.landMs ?? LAND_MS);
      let why = 'the pasted message never showed in the box';
      // Nothing was submitted, so the paste may be tried again from the wait for the prompt.
      let again = true;
      while (Date.now() < landBy) {
        await sleep(300);
        const now = await this.capture(20);
        if (!pasteLanded(now, text)) continue;
        // Enter sends all of the box: with anything else in it (text the clear did not reach, a second
        // chip) the prompt is not the message, and its turn would be keyed as none Angelia typed. Looked
        // at again until the landing time is up (a redraw half done), then cleared and pasted again.
        if (!boxHoldsOnly(now, text)) { why = 'the input box held other text with the pasted message'; continue; }
        // A turn started in the app between the idle check and now: Claude would queue our text
        // after it, and its answer would look like ours. Clear the box and say no.
        if (gen !== this.gen || paneBusy(now)) { why = 'the pane became busy before Enter'; break; }
        submit();
        if (await submitPasted(text, () => this.capture(20), () => this.tm(['send-keys', '-t', exact(this.name), 'Enter']))) return { ok: true };
        // Enter was pressed: Claude may yet take it, and a second paste would send it twice.
        why = 'the pasted message was not taken after three Enters';
        again = false;
        break;
      }
      this.emit('log', `tmux: ${why} (attempt ${attempt}) pane=${this.name}`);
      await this.clearBox(); // clear whatever landed, submit nothing
      if (gen !== this.gen) return { ok: false, why: 'released', keep: true };
      if (!again || attempt >= PASTE_TRIES || Date.now() > deadline) {
        return { ok: false, why: again ? 'Claude Code did not show the pasted message' : 'Claude Code did not take the message', keep: true };
      }
      moved = true; // it drew a prompt since the wait began
    }
  }

  /** The message waited the whole bound for a prompt that never came. Kept (the chat is told to send
   *  it again, the pane goes on) unless the pane looks hung: its screen never moved, no dialog waits
   *  for a person, and no turn of this chat ever started background work in it. Only then may it be
   *  ended, as a dead one would. Never a key into what holds it: a dialog is answered by a person.
   *  Only a real permission dialog counts as one. Any other screen with no input box that is not at
   *  work (a stuck login, a menu, an error) is ended and started fresh, as before 0.4.1: kept, it
   *  would hold the chat for good (review fix L5). */
  private notTyped(pane: string, moved: boolean): Pasted {
    const dialog = permissionDialog(pane) !== null;
    // Which background tasks are still open is not tracked here: any the chat's turns started counts.
    const tasks = this.ours.size;
    const mins = Math.round((this.opts.promptTimeoutMs ?? PROMPT_TIMEOUT_MS) / 60_000);
    const wait = mins >= 1 ? `${mins} minute${mins === 1 ? '' : 's'}` : 'a while';
    this.keepScreen('not-typed.txt', `no prompt for ${wait}`);
    if (!dialog && !paneBusy(pane) && !paneHasBox(pane)) {
      this.emit('log', `tmux: no prompt for ${wait}, no input box and no permission dialog (a login, a menu or an error screen): the pane is ended to start fresh pane=${this.name}`);
      return { ok: false, why: 'stuck', keep: false };
    }
    if (!moved && !dialog && !tasks) {
      this.emit('log', `tmux: no prompt for ${wait} and the screen never moved, no dialog, no background work: the pane looks hung pane=${this.name}`);
      return { ok: false, why: 'hung', keep: false };
    }
    this.emit('log', `tmux: no prompt for ${wait}; the message goes back to the chat and the pane is kept (screen ${moved ? 'moving' : 'still'}, ${dialog ? 'a dialog open' : 'no dialog'}, ${tasks} background task(s) started by this chat) pane=${this.name}`);
    return {
      ok: false, keep: true,
      why: dialog ? 'a dialog is open in the session and waits for an answer in the Claude app or its pane'
        : `the session stayed busy for ${wait} with work of its own (a background task's report, or a turn typed in the Claude app)`,
    };
  }

  /** Keep the screen of a pane whose turn ended or was held on what the screen showed, next to its
   *  settings: the one way to see what it showed, without a terminal open at the right second. One
   *  file per reason, overwritten. In the pane's private folder, not the log: it can show the conversation. */
  private keepScreen(file: string, why: string): void {
    void (async () => {
      try {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        writeFileSync(join(this.dir, file), `${new Date().toISOString()} ${why}\n${await this.capture(40)}\n`, { mode: 0o600 });
      } catch { /* the log line stands on its own */ }
    })();
  }

  async *turn(text: string, o: TurnFlags = {}): AsyncGenerator<BrainEvent> {
    this.lastUsedAt = Date.now();
    const problem = await (this.ready ?? Promise.resolve('brain not started'));
    if (problem) { yield { kind: 'result', text: '', isError: true, reason: problem }; return; }
    if (this.notice) { yield { kind: 'notice', text: this.notice }; this.notice = null; }
    // Typed into the turn before and not seen taken then: Claude Code may have taken it since.
    const id = o.msg ?? promptKey(cleanText(text)), u = this.unsure.get(id);
    this.unsure.delete(id);
    if (u && u.transcript === this.transcript && this.queuedSince(u.offset, u.key)) {
      this.emit('log', `tmux: a message typed into the last turn was taken late; it is not typed again${u.answered ? ' (its answer went to the chat already)' : ''} pane=${this.name}`);
      // A turn Claude Code still runs for it by itself is the chat's (followerOf), from its Enter on.
      if (!u.answered) this.absorbed.push({ key: u.key, text: u.text, at: u.at, turn: 0, seen: false, offset: u.offset });
      yield { kind: 'result', text: TAKEN_LATE_LINE, isError: false };
      return;
    }
    // The session may be busy with a turn typed in the Claude app: the message waits for it, and the
    // chat is told why nothing happens yet. Not when it is busy with a message of the chat's own that
    // was typed into the last turn and runs as a turn of its own now.
    // An empty capture is a pane that is gone, which paste() reports; a dialog is not a turn.
    if (!this.absorbed.some((a) => !a.seen) && paneBusy(await this.capture(30))) yield { kind: 'notice', text: BUSY_PANE_LINE };
    let sentAt = Date.now();
    // The key of what this turn typed, made at its Enter: its reader holds the marker to it (watch).
    let mine: Typed = { key: '', by: 'turn', form: '' };
    const gen = this.gen;
    const left: { over?: UnaskedAnswer } = {};
    const submit = () => {
      // What was written since the last look (a teammate's end, the owner's spawn in the app), before
      // the reader moves to the file's end.
      if (this.heldSince !== undefined) this.readTranscript();
      // A Stop marker still here is of a turn that ended before this one: read as between turns, so a
      // late answer or a task's result is told before this turn's answer, never just deleted.
      left.over = this.takeIdle() ?? undefined;
      this.dropEnded([...this.endedAtEnter].filter((n) => this.endedTeammates.has(n)));
      this.endedAtEnter = new Set(this.endedTeammates);
      // Started between turns in a turn whose marker never came: nothing shows it was the chat's.
      this.settleSpawns(false);
      this.at = this.from = fileSize(this.transcript); // only rows written from here on are this turn's
      this.rows = this.startState = 'none';
      this.startOwed.clear();
      this.restoredKeys = [];
      this.openCalls.clear();
      // Messages typed into an earlier turn whose answer never came: none is waited for any more, so a
      // later turn with the same words is never taken for theirs.
      this.absorbed = [];
      this.following = undefined;
      rmSync(this.markerPath, { force: true });
      sentAt = Date.now();
      // From here on a marker is this turn's (takeMarker): the reader between turns keeps off it.
      this.turnSentAt = sentAt;
      // A turn typed in the desk app is the owner's own: what it starts is not the chat's (TurnFlags).
      this.recording = !o.app;
      this.turnPeer = o.peer === true;
      this.heldSince ??= sentAt;
      this.quietEnd = undefined;
      this.typedKey = this.tieKey = promptKey(cleanText(text));
      this.typedBy = 'turn';
      this.typedForm = promptForm(cleanText(text));
      mine = { key: this.typedKey, by: this.typedBy, form: this.typedForm };
    };
    const typed = await this.paste(text, submit, gen);
    if (left.over) yield { kind: 'unasked', ...left.over };
    if (!typed.ok) {
      // Typed or not, no turn of ours runs: a marker that comes now is not this message's answer.
      if (this.turnSentAt === sentAt) this.turnSentAt = undefined;
      this.recording = false;
      if (!this.up || typed.why === 'exit') { yield { kind: 'result', text: '', isError: true, reason: 'exit' }; return; }
      if (typed.why === 'released') { yield { kind: 'result', text: '', isError: true, reason: 'released', keep: true }; return; }
      // A pane that is alive goes on with what it does: its background agents live in it. Only a hung
      // one (notTyped) is given back to be ended.
      if (typed.keep) { yield { kind: 'result', text: '', isError: true, reason: `${NOT_TYPED}: ${typed.why}`, keep: true }; return; }
      yield { kind: 'result', text: '', isError: true, reason: 'the message could not be typed into the session (no prompt, or Claude Code did not take it)' };
      return;
    }
    yield* this.watch(sentAt, false, gen, text.trimStart().startsWith('/'), mine);
  }

  /**
   * Type a chat message into the turn that runs now, as a person types into a busy Claude Code: it
   * queues the message and gives it to the model at the next tool boundary of the same turn (a
   * `queued_command` row), or runs it as the next turn when none comes (measured on claude 2.1.332).
   * True once Claude Code took it: the running turn's one answer goes to the chat, and a turn Claude
   * Code runs for it is read for the chat as well (absorbOutcome, followAbsorbed). False when no turn of
   * the chat's is read now, or the turn ended before a safe moment came: nothing was submitted, and the
   * caller queues the message as a turn of its own, as before.
   *
   * Enter into a dialog would answer it with its first choice, "Yes", and Claude Code draws the
   * permission dialog while the PermissionRequest hook still runs. So the Enter is made under a lock:
   * Angelia's PreToolUse hook (scripts/tui-pretool-hook.mjs) holds every tool call, the session's own
   * and a subagent's, while `absorb.lock` is there, and a PermissionRequest only ever follows its
   * call's PreToolUse (measured on 2.1.332). Under the lock: no PreToolUse in flight, none ended in the
   * last PRETOOL_SETTLE_MS, no request at the hook or in the chat, the transcript read to its end, and
   * the screen shows the busy turn with our text alone in the box and no dialog; then Enter, and the
   * lock goes once Claude Code took the message. Before the paste, besides: a tool call of the
   * session's own has run CALL_SETTLE_MS, and no call that asks the person by itself (a question, a
   * plan to approve, an MCP tool's form) or a subagent runs. Messages go in one at a time, in order.
   */
  /** No message is typed into the running turn from now on; settles once none sits between its Enter
   *  and its end (the orchestrator bounds the wait), so a restart never carries a message the turn
   *  took as one still waiting (it would run twice). */
  async stopAbsorbing(): Promise<void> {
    this.closing = true;
    while (this.pressed) await sleep(100);
  }

  absorb(raw: string, msg?: string): Promise<boolean> {
    const run = this.absorbing.then(async () => { try { return await this.absorbNow(raw, msg); } finally { this.pressed = false; } });
    this.absorbing = run.catch(() => false);
    return run;
  }

  /** How the messages typed into the turn that ended last went: how many it took (answered by its
   *  answer) and how many it did not (Claude Code runs those as the next turn: followAbsorbed reads it).
   *  Once per turn; undefined when none was typed into it. */
  absorbOutcome(): { taken: number; untaken: number } | undefined {
    const o = this.outcome;
    this.outcome = undefined;
    return o;
  }

  /** Why a message may not be typed into the running turn now, or null when it may. */
  private intoTurnBlocked(gen: number, sentAt: number): string | null {
    if (gen !== this.gen || this.turnSentAt !== sentAt || !this.recording || !this.up) return NOT_READ;
    // Typed, and its reader not started yet (Enter is being checked): wait for it.
    if (!this.beating) return 'the turn is starting';
    if (this.permissions.size || this.relay.waiting() || Date.now() - this.relayedAt < REASK_MS) return 'a permission request is open';
    // Rows written since the reader's last poll may hold a call it has not seen yet.
    if (fileSize(this.transcript) !== this.at) return 'the transcript has rows not read yet';
    let running = false;
    for (const c of this.openCalls.values()) {
      if (SUBAGENT_TOOLS.has(c.name)) return 'a subagent runs';
      if (ASKS_TOOLS.has(c.name) || c.name.startsWith('mcp__')) return 'a call that may ask the person runs';
      if (Date.now() - c.at < (this.opts.callSettleMs ?? CALL_SETTLE_MS)) return 'a tool call has just started';
      running = true;
    }
    return running ? null : 'no tool call runs';
  }

  /** Why the PreToolUse lock says no now, or null: a PreToolUse hook still at work, a permission being
   *  asked (Angelia's PermissionRequest hook marks itself first thing), a PreToolUse that ended a moment
   *  ago (its PermissionRequest may come), or none since the turn began (a pane started before the hook).
   *  A mark of a hook whose process is gone holds nothing (it was killed). */
  private pretoolBusy(sentAt: number): string | null {
    const dir = join(this.dir, 'pretool');
    let names: string[];
    try { names = readdirSync(dir); } catch { return 'the session has no PreToolUse lock'; }
    for (const n of names) {
      const m = /^(\d+)\.(in|perm)$/.exec(n);
      if (!m) continue;
      if (!processAlive(Number(m[1]))) { rmSync(join(dir, n), { force: true }); continue; }
      return m[2] === 'in' ? 'a tool call is being checked' : 'a permission is being asked';
    }
    let last = 0;
    try { last = Number(JSON.parse(readFileSync(join(dir, 'last.json'), 'utf8')).at) || 0; } catch { /* none yet */ }
    // The running call's own PreToolUse ended after the turn began: a pane with the hook always has one.
    if (last < sentAt) return 'the session has no PreToolUse lock';
    if (Date.now() - last < (this.opts.pretoolSettleMs ?? PRETOOL_SETTLE_MS)) return 'a tool call was just checked';
    return null;
  }

  private async absorbNow(raw: string, msg?: string): Promise<boolean> {
    const text = cleanText(raw), id = msg ?? promptKey(text);
    const sentAt = this.turnSentAt;
    const gen = this.gen;
    if (sentAt === undefined || !text || !this.midturn) return false;
    // The turn's reader (watch) reads the transcript every poll and keeps openCalls; a read here would
    // take its rows (progress lines, an error row) from it.
    const blocked = () => this.intoTurnBlocked(gen, sentAt);
    // Wait for a safe moment as long as the turn runs.
    for (;;) {
      if (this.closing) return false;
      const why = blocked() ?? this.pretoolBusy(sentAt);
      if (why === NOT_READ) return false;
      if (!why && paneMidTurn(await this.capture(30))) break;
      await sleep(POLL_MS);
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if ((await loadBuffer(`${this.name}-turn`, text, this.dir, (a) => this.tm(a))).code !== 0) return false;
    // Checked once more: the screen may have changed while the buffer was loaded.
    if (blocked() || !paneMidTurn(await this.capture(30))) { this.emit('log', `tmux: a message for the running turn was not typed: the moment passed pane=${this.name}`); return false; }
    await this.tm(['paste-buffer', '-p', '-d', '-b', `${this.name}-turn`, '-t', exact(this.name)]);
    const landBy = Date.now() + (this.opts.landMs ?? LAND_MS);
    const lock = join(this.dir, 'absorb.lock');
    let presses = 0, landed = false, enterAt = 0;
    // The box can also be empty for another reason (a pane relaunched, the owner cleared it): only the
    // transcript says Claude Code queued it.
    const queued = (): boolean => this.queuedSince(enterAt, promptKey(text));
    // The box is empty after an Enter: wait for the transcript's word, up to CONFIRM_MS, once.
    let confirmed: boolean | undefined;
    const confirm = async (): Promise<boolean> => {
      if (confirmed !== undefined) return confirmed;
      const until = Date.now() + (this.opts.confirmMs ?? CONFIRM_MS);
      while (!queued() && Date.now() < until) await sleep(300);
      confirmed = queued();
      if (!confirmed) this.emit('log', `${UNCONFIRMED_LINE} pane=${this.name}`);
      return confirmed;
    };
    const took = (): true => {
      this.unsure.delete(id);
      this.absorbed.push({ key: promptKey(text), text, at: Date.now(), turn: sentAt, seen: false, offset: enterAt });
      this.emit('log', `tmux: a chat message went into the running turn (${text.length} chars) pane=${this.name}`);
      return true;
    };
    let stalls = 0;
    for (;;) {
      await sleep(300);
      const pane = await this.capture(30);
      if (!pane && this.captureTimedOut) {
        if (++stalls < TMUX_STALLS) continue;
        // Pressed already: only the transcript can say whether Claude Code took it (else it would go twice).
        if (presses > 0 && await confirm()) return took();
        this.emit('log', `tmux: a message for the running turn was not typed: ${stalls} captures in a row timed out; it waits for the turn to end pane=${this.name}`);
        return false;
      }
      stalls = 0;
      if (!pane) return false;
      if (!pasteLanded(pane, text)) {
        // An Enter was pressed, and now the box is on screen without the text: taken, late (a redraw a
        // second or more after the key). Never pressed again: it would go twice.
        if (presses > 0 && paneHasBox(pane) && !permissionDialog(pane)) { if (await confirm()) return took(); break; }
        // Not drawn yet, or hidden behind a dialog that opened since.
        if ((!landed && Date.now() > landBy) || blocked() === NOT_READ) break;
        continue;
      }
      landed = true;
      if (blocked() === NOT_READ || paneIdle(pane)) break;
      if (blocked()) continue;
      // The lock first, then every check: a tool call checked from here on waits in its PreToolUse hook,
      // so no dialog can open under the key.
      let lockedAt: number;
      try { writeFileSync(lock, String(Date.now()), { mode: 0o600 }); lockedAt = Date.now(); } catch { break; }
      let taken = false, emptied = false;
      try {
        if (blocked() || this.pretoolBusy(sentAt) || !paneMidTurn(await this.capture(30), text)) continue;
        // The checks took long (a loaded machine): the hook may already read the lock as left over
        // (LOCK_STALE_MS), so it holds nothing now. Start again.
        if (Date.now() - lockedAt > (this.opts.lockFreshMs ?? LOCK_FRESH_MS)) continue;
        // Let go of (release() removes the lock, a restart takes the pane), or the daemon stops before a
        // first Enter: no key.
        if (gen !== this.gen || (this.closing && !presses)) break;
        if (!presses) enterAt = fileSize(this.transcript);
        // Set before the key: stopAbsorbing, which waits on it, may run while send-keys does.
        this.pressed = true;
        await this.tm(['send-keys', '-t', exact(this.name), 'Enter']);
        presses++;
        if (!this.unsure.has(id)) this.unsure.set(id, { key: promptKey(text), text, transcript: this.transcript, offset: enterAt, at: Date.now(), turn: sentAt, answered: false });
        if (this.unsure.size > 20) this.unsure.delete(this.unsure.keys().next().value!);
        for (let p = 0; p < TAKEN_POLLS && !emptied; p++) {
          await sleep(300);
          const now = await this.capture(30);
          if (!now && this.captureTimedOut) continue;
          if (!now) return false;
          // Gone from the box, and the box is there: Claude Code took it (it shows above, as queued), if
          // the transcript says so too (confirm). The lock stands meanwhile.
          emptied = paneHasBox(now) && !pasteLanded(now, text);
        }
        if (emptied) taken = await confirm();
      } finally {
        rmSync(lock, { force: true });
      }
      if (taken) return took();
      // An empty box is not pressed again: an Enter there sends nothing, or a second copy.
      if (emptied || presses >= 3) break;
    }
    // Not seen taken: the text goes from the box, and the message waits for a turn of its own. But an
    // Enter was pressed and the box is now on screen without the text: Claude Code took it late.
    if (await this.leaveBox(text) && presses > 0 && await confirm()) return took();
    this.emit('log', `tmux: a message for the running turn was not taken; it waits for the turn to end pane=${this.name}`);
    return false;
  }

  /** Empty the input box, one Ctrl-K and one Ctrl-U at a time, checking the screen after each pair; a
   *  pair that changes nothing (a hint, a redraw not yet come) is not repeated for ever. Ctrl-U alone
   *  deletes only from the cursor back to its line's start: with the cursor at the start of what the box
   *  held (a prompt called back from the history, a line someone moved back in) it deleted nothing, the
   *  paste went in before that text, and Claude Code sent both as one prompt, keyed as no prompt Angelia
   *  typed (measured on 2.1.332: the key misses of 0.4.4). Ctrl-K deletes from the cursor to the line's
   *  end, and each of the two deletes the line break at its side when the cursor is right at it (read
   *  from the 2.1.332 program text), so pairs empty a box of any lines from any cursor. Returns what the
   *  box held and what is still in it ('' and '' for a box that was empty). */
  private async clearBox(): Promise<{ held: string; left: string }> {
    const first = boxText(await this.capture(20));
    let last = first;
    for (let i = 0; last && i < CLEAR_ROUNDS; i++) {
      await this.tm(['send-keys', '-t', exact(this.name), 'C-k', 'C-u']);
      await sleep(400);
      const now = boxText(await this.capture(20));
      if (now === last) { await sleep(1200); const again = boxText(await this.capture(20)); if (again === last) break; last = again; continue; }
      last = now;
    }
    return { held: first, left: last };
  }

  /** The transcript from `offset` on shows Claude Code took a message keyed `key`: it queued one (its
   *  queue-operation enqueue row, measured on 2.1.332), gave it to the turn (its queued_command row), or
   *  runs it as a turn (its prompt row). Read without moving the turn's reader. */
  private queuedSince(offset: number, key: string): boolean {
    for (const line of readSlice(this.transcript, offset).split('\n')) {
      if (!line.includes('queue-operation') && !line.includes('queued_command') && !line.includes('"user"')) continue;
      let row: { type?: unknown; operation?: unknown; content?: unknown; attachment?: { type?: unknown; prompt?: unknown }; message?: { content?: unknown } } | null;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || typeof row !== 'object') continue;
      // The enqueue row holds the message itself (measured on 2.1.332): another one queued then is not ours.
      if (row.type === 'queue-operation' && row.operation === 'enqueue' && typeof row.content === 'string' && promptKey(row.content) === key) return true;
      if (row.type === 'attachment' && row.attachment?.type === 'queued_command' && typeof row.attachment.prompt === 'string' && promptKey(row.attachment.prompt) === key) return true;
      if (row.type === 'user' && promptKey(promptText(row.message?.content)) === key) return true;
    }
    return false;
  }

  /** The transcript from `offset` on has a row that gives `text` to the model: a queued_command row or a
   *  typed prompt that holds it (alone, or joined with others), in promptForm. Claude Code's own
   *  queue-operation rows (it queued it, it took it back) give nothing. Read without moving the reader. */
  private ranSince(offset: number, text: string): boolean {
    const want = promptForm(text);
    if (!want) return true;
    for (const line of readSlice(this.transcript, offset).split('\n')) {
      if (!line.includes('queued_command') && !line.includes('"user"')) continue;
      let row: { type?: unknown; isSidechain?: unknown; attachment?: { type?: unknown; prompt?: unknown }; message?: { content?: unknown } } | null;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || typeof row !== 'object' || row.isSidechain === true) continue;
      const got = row.type === 'attachment' && row.attachment?.type === 'queued_command' && typeof row.attachment.prompt === 'string' ? row.attachment.prompt
        : row.type === 'user' ? promptText(row.message?.content) : '';
      if (got && promptForm(got).includes(want)) return true;
    }
    return false;
  }

  /** Clear our text from the input box once the box is on screen with it and no dialog is open, so a
   *  key never reaches a dialog. Text someone else typed is left alone. True when the box is on screen
   *  without our text (nothing to clear). */
  private async leaveBox(text: string): Promise<boolean> {
    for (let i = 0; i < 100; i++) {
      const pane = await this.capture(30);
      if (!pane) return false;
      if (paneHasBox(pane) && !permissionDialog(pane)) {
        if (!pasteLanded(pane, text)) return true;
        await this.clearBox();
        return false;
      }
      await sleep(POLL_MS);
    }
    this.emit('log', `tmux: a message for the running turn is left in the box behind a dialog pane=${this.name}`);
    return false;
  }

  /** The turn that ended has messages it did not take: Claude Code runs them as the next turn by
   *  itself. Until followAbsorbed reads that turn, the reader between turns keeps off it (turnSentAt).
   *  If nobody claims it (claimFollow, at the turn's result) in FOLLOW_WAIT_MS, the reader between
   *  turns takes its marker (takeIdle) and the answer goes out as an unasked one. */
  private closeAbsorbed(sentAt: number, scanFrom = this.at): void {
    const mine = this.absorbed.filter((a) => a.turn === sentAt);
    const untaken = mine.filter((a) => !a.seen);
    this.outcome = mine.length ? { taken: mine.length - untaken.length, untaken: untaken.length } : undefined;
    // Only this turn's untaken ones are waited for: older ones are never answered now.
    this.absorbed = untaken;
    if (!untaken.length) return;
    // Claude Code joins them into one prompt, one blank line between (measured by the review, 2.1.332).
    const f = { since: Date.now(), keys: [...untaken.map((a) => a.key), ...(untaken.length > 1 ? [promptKey(untaken.map((a) => a.text).join('\n\n'))] : [])], claimed: false, scanFrom, msgs: untaken.map((a) => ({ ...a })) };
    this.following = f;
    this.turnSentAt = f.since;
    setTimeout(() => { if (this.following === f && !f.claimed) this.releaseFollow(); }, this.opts.followWaitMs ?? FOLLOW_WAIT_MS).unref();
  }

  /** The turn's result is in, and its reader will read the turn Claude Code runs next (followAbsorbed),
   *  however long the delivery of this answer takes. */
  claimFollow(): void {
    if (this.following) this.following.claimed = true;
  }

  /** That turn will not be read after all: the reader between turns may take its marker, and its answer
   *  goes out as an unasked one (takeIdle). */
  releaseFollow(): void {
    const f = this.following;
    if (!f) return;
    this.following = undefined;
    if (this.turnSentAt === f.since) this.turnSentAt = undefined;
  }

  /**
   * Read the turn Claude Code runs by itself for the messages the last turn did not take, as a turn of
   * the chat's: the permission relay, progress lines and the answer, as `follow` reads one. It starts
   * at that turn's own prompt row: rows of the turn before it written after its marker (its last text,
   * flushed late) are never read as this turn's. Its marker is this turn's when its typed prompts are
   * those messages. A turn that does not start (the pane idle, or no such row in FOLLOW_START_MS) ends
   * with no answer, said nowhere.
   */
  async *followAbsorbed(): AsyncGenerator<BrainEvent> {
    const f = this.following;
    this.following = undefined;
    if (!f || !this.up) { yield { kind: 'result', text: '', isError: true, reason: this.up ? 'nothing to follow' : 'exit' }; return; }
    const gen = this.gen;
    this.absorbed = this.absorbed.filter((a) => !f.keys.includes(a.key));
    this.turnSentAt = f.since;
    this.recording = true;
    // The chat's own messages: none goes into a peer's turn (Orchestrator.intoTurnAllowed).
    this.turnPeer = false;
    this.followKeys = f.keys;
    this.restoredKeys = [];
    this.typedKey = this.tieKey = f.keys[0];
    this.typedBy = 'follow';
    this.typedForm = '';
    this.quietEnd = undefined;
    this.lastUsedAt = Date.now();
    try {
      // The hook relays from now on: the turn may ask for a permission the moment it starts.
      this.startBeat(gen);
      const until = Date.now() + (this.opts.followStartMs ?? FOLLOW_START_MS);
      let idleSince = 0;
      for (;;) {
        if (gen !== this.gen) { this.recording = false; yield { kind: 'result', text: '', isError: true, reason: 'released' }; return; }
        if (this.skipToPrompt(f.keys, f.scanFrom)) break;
        // Its marker is there already, keyed as one of these messages: the turn ran (its prompt row
        // read past, or written in a form not known here); the reader takes the marker at once.
        const m = this.readMarker();
        if (m?.at && m.at >= f.since && typeof m.prompt_key === 'string' && f.keys.includes(m.prompt_key)) break;
        const pane = await this.capture(30);
        if (!pane && !(await this.sessionAlive())) { this.turnSentAt = undefined; this.recording = false; this.stopBeat(); yield { kind: 'result', text: '', isError: true, reason: 'exit' }; return; }
        idleSince = paneIdle(pane) ? idleSince || Date.now() : 0;
        const quiet = !!idleSince && Date.now() - idleSince > (this.opts.quietMs ?? QUIET_MS);
        if (quiet || Date.now() > until) {
          this.turnSentAt = undefined; this.recording = false; this.stopBeat(); this.startIdle();
          // Taken after all, in a row not read as theirs: nothing to say. But with no row from their
          // Enter on that gives them to the model (Claude Code put them back in the box, where the next
          // paste clears them, or dropped them), they are typed again as a turn of their own (NOT_RUN):
          // never lost unsaid. Only from an idle pane: a busy one may hold them in Claude Code's queue
          // still, and typed again they would run twice.
          if (quiet && f.msgs.length && f.msgs.every((a) => a.offset !== undefined && !this.ranSince(a.offset, a.text))) {
            this.emit('log', `${NOT_RUN_LINE} (${f.msgs.length} message(s)) pane=${this.name}`);
            yield { kind: 'result', text: '', isError: true, reason: NOT_RUN };
            return;
          }
          this.emit('log', `tmux: no turn ran for the messages the last turn did not take pane=${this.name}`);
          yield { kind: 'result', text: '', isError: true, reason: 'nothing to follow' };
          return;
        }
        await sleep(POLL_MS);
      }
      this.openCalls.clear();
      this.from = this.at;
      this.rows = 'open';
      yield* this.watch(f.since, false, gen, false, { key: f.keys[0], by: 'follow', form: '' });
    } finally { this.followKeys = []; }
  }

  /**
   * The net under a key miss: the marker's turn is this one's after all, and its answer is delivered,
   * when all of these hold. The message was typed by turn() (its words are known) and has at least
   * KEPT_MIN_CHARS in promptForm, the turn is not a peer's (an answer to another prompt would go to
   * the peer), the hook says the turn was started by one typed prompt, written (`prompt_at`) after this
   * turn's Enter (within KEPT_WINDOW_MS), and the transcript, from this turn's Enter on, has that
   * prompt (the row whose key is the marker's), and it starts or ends with the whole message typed, in
   * promptForm: leftover text went before or after the paste. A prompt typed in the app before
   * Angelia's Enter (the gap the miss check is for) is written before it and is not read here, and
   * text typed into the box with ours does not get past the check before Enter (boxHoldsOnly). Never
   * for a turn Claude Code ran for several untaken messages (follow): its keys are the check there.
   */
  private keptOnMiss(m: Marker, sentAt: number, typed: Typed): boolean {
    if (typed.by !== 'turn' || this.turnPeer || typed.form.length < KEPT_MIN_CHARS || typeof m.prompt_key !== 'string') return false;
    // Written at the Enter (measured on 2.1.332); submitPasted may press it three times.
    if (typeof m.prompt_at !== 'number' || m.prompt_at < sentAt || m.prompt_at > sentAt + KEPT_WINDOW_MS) return false;
    for (const line of readSlice(this.transcript, this.from).split('\n')) {
      if (!line.includes('"user"')) continue;
      let row: { type?: unknown; isSidechain?: unknown; isMeta?: unknown; message?: { content?: unknown } } | null;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || row.type !== 'user' || row.isSidechain === true || row.isMeta === true) continue;
      const text = promptText(row.message?.content);
      if (text && promptKey(text) === m.prompt_key) {
        const form = promptForm(text);
        return form.startsWith(typed.form) || form.endsWith(typed.form);
      }
    }
    return false;
  }

  /** Read whole rows from `from` (where the last turn's reader began its last read: the prompt row
   *  may have come before its marker was read) up to the prompt row of the turn Claude Code runs for
   *  untaken messages (a typed prompt keyed as one of `keys`), and stand just after it. True once found.
   *  Rows the reader had not read before are the turn before's, and only the background book reads them;
   *  the ones it had read, it read already. */
  private skipToPrompt(keys: string[], from = this.at): boolean {
    let fd: number;
    const seen = this.at;
    const at = Math.min(from, this.at);
    try { fd = openSync(this.transcript, 'r'); } catch { return false; }
    try {
      const size = fstatSync(fd).size;
      if (size <= at) return false;
      const buf = Buffer.allocUnsafe(size - at);
      readSync(fd, buf, 0, buf.length, at);
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(10, start);
        if (nl < 0) break;
        const line = buf.subarray(start, nl).toString('utf8');
        this.rowAt = at + start;
        start = nl + 1;
        if (at + start > seen) this.noteBackground(line);
        if (!line.includes('"user"')) continue;
        let row: { type?: unknown; isSidechain?: unknown; isMeta?: unknown; message?: { content?: unknown } } | null;
        try { row = JSON.parse(line); } catch { continue; }
        if (!row || row.type !== 'user' || row.isSidechain === true || row.isMeta === true) continue;
        const text = promptText(row.message?.content);
        if (text && keys.includes(promptKey(text))) { this.at = at + start; return true; }
      }
      this.at = Math.max(seen, at + start);
      return false;
    } catch { return false; } finally { closeSync(fd); }
  }

  /**
   * Keep the running turn going with nobody reading it: a handoff moved the chat to another session
   * while this one worked. Yields a permission event for each new dialog (nothing answers it from
   * here: it waits, as it would in a forgotten terminal, until someone answers it in the Claude app,
   * in tmux, or after `/resume`), and a result once the turn is over. No time limit.
   */
  backgroundTurn(): AsyncGenerator<BrainEvent> {
    const gen = ++this.gen;
    this.recording = false; // nobody reads it for the chat: what it starts from here is not the chat's
    this.permissions.clear();
    this.stopBeat();
    this.stopIdle();
    this.up = false;
    return this.watch(this.turnSentAt ?? Date.now(), true, gen);
  }

  /** Read the running turn again, in the foreground: `/resume` of a session sent to the background.
   *  The pane is this brain's again from the call on (alive, reader switched); what the result yields
   *  is what `turn` would have. */
  follow(): AsyncGenerator<BrainEvent> {
    const gen = ++this.gen;
    // The rows read now may reach back to the transcript's start (an adopted pane): none of their
    // tasks is taken for the chat's.
    this.recording = false;
    // And no typed key to hold the turn's marker to: what this object typed last may be of another turn.
    this.typedKey = '';
    this.stopIdle();
    this.up = true;
    this.ready = Promise.resolve(null);
    this.lastUsedAt = Date.now();
    this.turnSentAt ??= Date.now();
    this.heldSince ??= this.turnSentAt;
    // The rows written while nobody read are not shown again (the events are dropped), but they say
    // where the turn stands (a tool that runs still, an answer owed), so the quiet pane cannot end it
    // early from here either. Read as every poll reads, so the turn's rows start on a whole line.
    this.readTranscript();
    this.from = this.at;
    // The hook relays from now on, before the reader's first poll: after a restart a hook that waits for
    // a fresh heartbeat must not wait on the chat's platform opening.
    this.startBeat(gen);
    return this.watch(this.turnSentAt ?? Date.now(), false, gen);
  }

  /** Take over a pane that runs already, without starting one: a restarted daemon finds a turn it had
   *  sent to the background. False when nothing runs under this name any more. */
  async adopt(turnSentAt: number): Promise<boolean> {
    this.turnSentAt = turnSentAt;
    if ((await this.tm(['has-session', '-t', exact(this.name)])).code !== 0) return false;
    this.ready = Promise.resolve(null);
    // No launch here: the check a launch makes for another PreToolUse hook is made now.
    this.checkOtherHooks();
    return true;
  }

  /** The chat messages typed into the turn that runs now, for the daemon after a restart (the
   *  orchestrator's cutTurns), taken before release forgets them. */
  midturnState(): Absorbed[] {
    return this.absorbed.map((a) => ({ ...a }));
  }

  /** After adopt, before the turn's reader starts: the messages the last daemon typed into this turn.
   *  The reader reads the turn's rows again and sees which it took (queued_command). Only well-formed
   *  entries of this turn are kept. */
  restoreMidturn(list: unknown[]): void {
    const ok = (a: unknown): a is Absorbed => !!a && typeof a === 'object' && typeof (a as Absorbed).key === 'string' && typeof (a as Absorbed).text === 'string'
      && typeof (a as Absorbed).at === 'number' && typeof (a as Absorbed).turn === 'number';
    this.absorbed = list.filter(ok).filter((a) => a.turn === this.turnSentAt).map((a) => ({ key: a.key, text: a.text, at: a.at, turn: a.turn, seen: false }));
  }

  /** The polling half of a turn. `background`: no permission book and no relay (nobody in the chat
   *  answers), and no hourly line. Ends early, as a failed result, once another reader takes the pane
   *  (`gen` moved). `command`: the turn is a slash command typed as is, which the CLI may answer
   *  itself, so an end with no answer is expected. */
  /** `typed`: what this turn typed, made where it was typed (turn() at its Enter, followAbsorbed for the
   *  messages it follows): the marker is held to it, never to the brain's latest key, which another path
   *  may set while this reader runs. Without it (follow, backgroundTurn), the latest key as it stands now. */
  private async *watch(sentAt: number, background: boolean, gen: number, command = false, typed: Typed = { key: this.typedKey, by: this.typedBy, form: this.typedForm }): AsyncGenerator<BrainEvent> {
    let pending: string | null = null;
    // Relayed requests by id, and those answered in the pane or the app whose outcome the transcript
    // has yet to show.
    const asked = new Map<string, { tool: string; input: unknown }>();
    const deciding = new Map<string, { tool: string; input: unknown; since: number }>();
    const dialogs = new DialogWatch();
    const screen = new ScreenDialogs();
    let quietSince = 0, held = false, grewAt = 0, failed = false;
    // A failed API call written as the turn's last words (api-error.ts): no answer, whatever the hook says.
    let apiFailed: string | null = null;
    // The screen above the box's foot, and when it last changed.
    let lastAbove = '', aboveAt = 0;
    const quietMs = this.opts.quietMs ?? QUIET_MS, quietTextMs = this.opts.quietTextMs ?? QUIET_TEXT_MS, quietOpenMs = this.opts.quietOpenMs ?? QUIET_OPEN_MS;
    let hours = 0, lastPane = '', movedAt = Date.now();
    /** tmux calls in a row that timed out (TMUX_STALLS). */
    let stalls = 0;
    // A dialog still open when the turn ends can no longer be answered from the chat: its timer goes too.
    // A turn read for the chat leaves the session held: from here the reader between turns looks at it.
    // A turn not read for the chat (typed in the desk app, a follow, the background): what it started is not the chat's.
    const over = (): void => { if (!this.recording) this.settleSpawns(false); this.turnSentAt = undefined; this.recording = false; this.lastUsedAt = Date.now(); this.permissions.clear(); if (!background) { this.stopBeat(); this.startIdle(); } };
    // How the turn ended, for the log: which path, how long it ran and how long its answer is, never the words.
    const ended = (how: string, answer: string): void => { this.emit('log', `tmux: turn ended by ${how} after ${Math.round((Date.now() - sentAt) / 1000)} s, answer ${answer.length} chars pane=${this.name}`); };
    if (!background) this.startBeat(gen);
    try {
      for (;;) {
        await sleep(POLL_MS);
        if (gen !== this.gen) { this.recording = false; yield { kind: 'result', text: '', isError: true, reason: 'released' }; return; }
        const h = Math.floor((Date.now() - sentAt) / TURN_NOTICE_MS);
        if (!background && h > hours) {
          hours = h;
          const still = Math.floor((Date.now() - movedAt) / 60_000);
          // A notice, not a progress line: the answer is never taken for a repeat of it.
          yield { kind: 'notice', text: still >= STILL_MS / 60_000
            ? `Nothing has moved in this turn for ${still} minutes; it may be stuck. /stop ends it.`
            : `Still working on this turn after ${h === 1 ? 'an hour' : `${h} hours`}. /stop ends it.` };
        }
        const readTo = this.at;
        const rows = this.readTranscript();
        if (this.at !== readTo) grewAt = Date.now(); // a row of any kind, bookkeeping too
        if (rows.length) { quietSince = 0; movedAt = Date.now(); }
        // This turn's reader: whether the CLI's error row is the last word it read (turnRows).
        if (this.at !== readTo) failed = this.rows === 'error';
        for (const ev of rows) {
          if (ev.kind === 'api-error') { if (pending) yield { kind: 'progress', text: pending }; pending = null; apiFailed = ev.text; continue; }
          apiFailed = null; // the turn went on after it
          if (ev.kind === 'text') { if (pending) yield { kind: 'progress', text: pending }; pending = ev.text; }
          else if (pending) { yield { kind: 'progress', text: pending }; pending = null; }
        }
        // Let go of while a progress line was taken (a restart stops the reader before the adapters):
        // the Stop marker stays where it is, for whoever reads the pane next.
        if (gen !== this.gen) { this.recording = false; yield { kind: 'result', text: '', isError: true, reason: 'released' }; return; }
        // A turn Claude Code started by itself ended while this one waited to be taken (a task's end
        // was queued first): that marker is no answer to this turn. Told as between turns, and this
        // turn waits on for its own.
        if (!background) {
          const m = this.readMarker();
          if (m?.at && m.at >= sentAt && m.origin === 'notification') {
            // Its last text was read here as this turn's: it is that turn's answer, never a progress line of this one.
            pending = null;
            const a = this.takeIdle(true, failed);
            if (a) yield { kind: 'unasked', ...a };
            // That error row was the other turn's: it says nothing of this turn's own answer.
            failed = false; apiFailed = null;
            continue;
          }
          // A turn whose one typed prompt is not what this turn typed: someone pressed Enter in the
          // app in the gap before Angelia's Enter. Its answer is theirs; this turn waits for its own.
          // Not for a slash command, whose row is not the text typed.
          // But a message of the chat's typed into the last turn, which Claude Code ran as a turn of its
          // own before this one: its answer is the chat's (takeIdle), and this turn waits on.
          // A message typed into this very turn counts too when the marker's prompt is not what this turn
          // typed: Claude Code runs it only after this turn is over (this turn's own marker came and went
          // unread), so its answer is the chat's, never a key miss to drop.
          const follower = m?.at && m.at >= sentAt ? this.followerOf(m) : null;
          if (follower && (follower.every((a) => a.turn !== sentAt) || (typeof m!.prompt_key === 'string' && !!typed.key && m!.prompt_key !== typed.key && !this.followKeys.includes(m!.prompt_key)))) {
            pending = null;
            const a = this.takeIdle(true, failed);
            if (a) yield { kind: 'unasked', ...a };
            failed = false; apiFailed = null;
            continue;
          }
          if (m?.at && m.at >= sentAt && !command && m.origin === 'prompt' && m.prompts === 1 && typeof m.prompt_key === 'string' && typed.key && m.prompt_key !== typed.key && !this.followKeys.includes(m.prompt_key)) {
            const text = String(m.text ?? '').trim();
            // Both keys' heads and lengths, and which path typed: what differs, never the words.
            const keys = `typed=${typed.key.slice(0, 8)}/${typed.form ? typed.form.length : '?'} hook=${m.prompt_key.slice(0, 8)}/${typeof m.prompt_len === 'number' ? m.prompt_len : '?'} by=${typed.by || '?'}`;
            if (this.keptOnMiss(m, sentAt, typed)) {
              // The prompt Claude Code ran starts or ends with the message typed, after this turn's Enter: the
              // turn is this message's, with something more in its prompt. Its answer goes to the chat.
              this.emit('log', `${KEY_KEPT_LINE} prompts=1 chars=${text.length} ${keys}: the turn's one typed prompt starts or ends with the typed message, so its answer is delivered pane=${this.name}`);
            } else {
              rmSync(this.markerPath, { force: true });
              pending = null;
              // One fixed line: `angelia health` counts it, and the canary fails on it (a new Claude Code
              // that stores a typed prompt another way would drop every answer here).
              this.emit('log', `${KEY_MISS_LINE} prompts=1 chars=${text.length} ${keys} pane=${this.name}`);
              continue;
            }
          }
        }
        // Requests answered in the pane are told before the marker is taken, and the reader may be let go
        // of while they are (a restart): then the marker stays for whoever reads the pane next.
        if (deciding.size) yield* this.decide(deciding, (this.readMarker()?.at ?? 0) >= sentAt);
        if (gen !== this.gen) { this.recording = false; yield { kind: 'result', text: '', isError: true, reason: 'released' }; return; }
        const done = this.takeMarker(sentAt);
        if (done !== null) {
          over();
          // Those this turn took are answered by this answer; those it did not take run as the next turn.
          // Rows written between the last read and the marker (a queued_command row of a message the turn
          // did take) are read first; their events are this turn's, already over.
          // The next turn's prompt row may be among the rows read in this poll or just now: its reader
          // looks for it from where this poll began to read (readTo).
          if (!background) { this.readTranscript(); this.closeAbsorbed(sentAt, readTo); }
          // The hook hands on the last assistant text, the error row's too: only another answer is one.
          if (apiFailed !== null && (!done.trim() || done.trim() === apiFailed)) { ended('the Stop marker, as an API error', ''); yield { kind: 'result', text: apiFailed, isError: true, reason: apiErrorReason(apiFailed) }; }
          else { ended('the Stop marker', done); yield { kind: 'result', text: done, isError: false }; }
          return;
        }
        // After the progress lines, so the chat reads what the agent said before what it asks to run.
        if (!background) {
          for (const r of this.relay.take()) {
            this.relayedAt = Date.now();
            // Not this turn's: of a turn that ran before it (a task's end or another session's message
            // Claude Code queued first), or written under the last idle beat. It goes as one between
            // turns does, never the levels' way as this turn's.
            if (!this.ofThisTurn(r.origin, sentAt, command)) { this.selfRequest(r, true); continue; }
            // Its timeout fits the hook's own time left: a request offered again after a restart is
            // denied before its hook steps aside, never answered into nothing.
            this.permissions.add(r.id, r.at ? Math.max(5000, HOOK_GIVE_UP_MS - (Date.now() - r.at) - 30_000) : undefined);
            asked.set(r.id, { tool: r.tool, input: r.input });
            yield relayedPermission(r);
          }
          // Answered in the app or in the terminal: Claude ended the hook. The transcript says how.
          for (const id of this.relay.gone()) {
            this.relayedAt = Date.now();
            this.permissions.take(id);
            this.selfBook.take(id);
            // One asked between turns, still open as this turn began, is told the same way.
            const a = asked.get(id) ?? this.selfAsked.get(id);
            this.selfAsked.delete(id);
            if (a) { asked.delete(id); deciding.set(id, { ...a, since: Date.now() }); }
          }
        }
        const pane = await this.capture(30);
        // Let go of during the capture: the quiet path or an exit below would end the next reader's turn.
        if (gen !== this.gen) { this.recording = false; yield { kind: 'result', text: '', isError: true, reason: 'released' }; return; }
        if (pane !== lastPane) {
          lastPane = pane; movedAt = Date.now();
          const above = paneAboveFoot(pane);
          if (above !== lastAbove) { lastAbove = above; aboveAt = Date.now(); }
        }
        const open = permissionDialog(pane);
        if (background) {
          // Told to the chat once, and answered in the app or the pane: nobody answers from the chat.
          const seen = dialogs.see(open, () => true);
          if (seen.announce && open) yield { kind: 'permission', id: seen.announce, tool: open.tool, preview: open.preview };
        } else if (screen.see(open ? `${open.tool}\n${open.preview}` : null, this.permissions.size > 0 || this.selfBook.size > 0 || Date.now() - this.relayedAt < REASK_MS)) {
          yield { kind: 'notice', text: screenOnlyLine(this.name, this.socket, open ?? undefined) };
        }
        // A tmux that did not answer in time is not a pane that is gone: the next poll looks again, up
        // to TMUX_STALLS calls in a row. Then the reader gives up with a clear line; the pane is kept,
        // and the turn's Stop marker, if it comes, is its answer, late (takeIdle).
        const stalled = !pane && this.captureTimedOut;
        const gone = !pane && !stalled ? await this.tm(['has-session', '-t', exact(this.name)]) : undefined;
        if (stalled || gone?.timedOut) {
          const what = stalled ? 'a capture' : 'has-session';
          if (++stalls < TMUX_STALLS) { this.emit('log', `tmux: ${what} timed out (${stalls} in a row); the reader polls again pane=${this.name}`); continue; }
          this.emit('log', `tmux: ${stalls} tmux calls in a row timed out; the turn's reader gives up and the pane is kept pane=${this.name}`);
          over();
          ended('tmux not answering', '');
          if (!background) this.quietEnd = { sentAt, endedAt: Date.now(), said: '', key: typed.key, taken: this.absorbed.filter((a) => a.seen && a.turn === sentAt).map((a) => a.key), peer: this.turnPeer };
          yield { kind: 'result', text: '', isError: true, reason: TMUX_STALLED, keep: true };
          return;
        }
        stalls = 0;
        if (gone && gone.code !== 0) {
          if (gen !== this.gen) { this.recording = false; yield { kind: 'result', text: '', isError: true, reason: 'released' }; return; }
          if (!background) this.up = false;
          over();
          yield { kind: 'result', text: '', isError: true, reason: 'exit' };
          return;
        }
        // A relayed request waits on the hook, and the pane may look idle while it does.
        if (paneIdle(pane) && !dialogs.open && !open && !this.permissions.size) {
          if (!quietSince) quietSince = Date.now();
          else if (Date.now() - quietSince <= quietMs) { /* not quiet long enough yet */ }
          else if (this.rows === 'open' && Date.now() - Math.max(quietSince, grewAt, aboveAt) <= quietOpenMs) {
            // The screen reads idle, and the transcript says the turn is open: a tool runs, or the
            // model owes its answer. The screen is a drawing that changes between versions: a foot it
            // had not seen before read as idle and cut working turns (2.1.329). So the screen alone
            // never ends an open turn: the Stop marker does, or rows that close it, or QUIET_OPEN_MS
            // with no new row and nothing moving above the box's foot.
            if (!held) {
              held = true;
              this.emit('log', `tmux: the pane reads idle ${Math.round((Date.now() - sentAt) / 1000)} s into the turn, but its transcript shows the turn open; waiting for the Stop marker (screen kept in idle-open.txt) pane=${this.name}`);
              this.keepScreen('idle-open.txt', 'the pane read idle while the transcript showed the turn open');
            }
          } else if (this.rows === 'said' && Date.now() - Math.max(quietSince, grewAt) <= quietTextMs) {
            // Text is the last row: a tool call may still follow it (QUIET_TEXT_MS).
          } else {
            // No Stop event is coming: either the CLI answered the message itself, or the hook failed
            // and the transcript holds the answer.
            over();
            const stood = { none: 'has no turn', command: 'has a slash command only', said: 'ends with text', error: 'ends with an error row of the CLI',
              open: `open, no new row and nothing moving above the input box for ${Math.round((Date.now() - Math.max(quietSince, grewAt, aboveAt)) / 1000)} s` }[this.rows];
            const how = `the quiet pane (no Stop marker; transcript ${stood})`;
            if (apiFailed !== null) {
              if (!background) this.closeAbsorbed(sentAt, readTo);
              ended(`${how}, as an API error`, '');
              yield { kind: 'result', text: apiFailed, isError: true, reason: apiErrorReason(apiFailed) };
              return;
            }
            const answer = pending ?? '';
            ended(how, answer);
            // The Stop marker may still come (a failed read of the screen, a slow hook): then it is this
            // turn's answer, late (takeIdle).
            if (!background) this.quietEnd = { sentAt, endedAt: Date.now(), said: answer, key: typed.key, taken: this.absorbed.filter((a) => a.seen && a.turn === sentAt).map((a) => a.key), peer: this.turnPeer };
            if (!background) this.closeAbsorbed(sentAt, readTo);
            // No answer at all, and not to a slash command: the chat may be told the agent gave none, so
            // keep the screen that read as idle.
            if (!answer && (!command || this.rows === 'open')) this.keepScreen('quiet-empty.txt', `the turn ended by ${how} with no answer`);
            yield { kind: 'result', text: answer, isError: false };
            return;
          }
        } else quietSince = 0;
      }
    } finally {
      // However the reader ends (an answer, an exit, let go of, or abandoned by its caller), its
      // heartbeat ends with it, unless a newer reader has taken the pane since.
      if (!background && this.beating?.gen === gen) this.stopBeat();
    }
  }

  /** Report each request answered in Claude's own dialog once the transcript shows how it went. A
   *  refusal is written at once; a call still without a result after DECIDE_MS was allowed and runs.
   *  A call the transcript does not show is not guessed at. `last`: the turn ends, decide now. */
  private *decide(deciding: Map<string, { tool: string; input: unknown; since: number }>, last: boolean): Generator<BrainEvent> {
    const chunk = readSlice(this.transcript, this.from);
    for (const [id, d] of deciding) {
      const v = paneVerdict(chunk, d.tool, d.input);
      const late = last || Date.now() - d.since > DECIDE_MS;
      if (typeof v === 'boolean' || (v === 'running' && late)) yield { kind: 'permission-answered', id, allow: v !== false };
      else if (!late) continue;
      else this.emit('log', `permission ${id.slice(0, 8)} answered in the pane; the transcript does not show how`);
      deciding.delete(id);
    }
  }

  /** New transcript rows since the last read, as the two things a progress line cares about.
   *  Only whole lines are consumed, so a row still being written is read on the next pass and a
   *  multi-byte character never gets split across two reads. */
  private readTranscript(): TranscriptEvent[] {
    let fd: number;
    try { fd = openSync(this.transcript, 'r'); } catch { return []; }
    try {
      const size = fstatSync(fd).size;
      if (size <= this.at) return [];
      const buf = Buffer.allocUnsafe(size - this.at);
      readSync(fd, buf, 0, buf.length, this.at);
      const cut = buf.lastIndexOf(10);
      if (cut < 0) return [];
      const from = this.at;
      this.at += cut + 1;
      const rows = buf.subarray(0, cut).toString('utf8');
      // Row by row, so each spawn is stamped with where its row starts, and each turn's start is known.
      for (let start = 0; start <= cut;) {
        const nl = buf.indexOf(10, start);
        const end = nl < 0 || nl > cut ? cut : nl;
        const line = buf.subarray(start, end).toString('utf8');
        this.rowAt = from + start;
        this.noteStart(line, this.rowAt);
        this.noteBackground(line);
        start = end + 1;
      }
      this.rows = turnRows(rows, this.rows);
      this.noteRows(rows);
      return transcriptEvents(rows);
    } catch {
      return [];
    } finally {
      closeSync(fd);
    }
  }

  /** What absorb needs from new rows: the session's tool calls still without a result, and each
   *  message typed into the turn that the transcript shows taken (its `queued_command` row, measured on
   *  claude 2.1.332: an attachment row with the prompt and `origin.kind: human`). */
  private noteRows(chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (!line.includes('tool_use') && !line.includes('tool_result') && !line.includes('queued_command')) continue;
      let row: { type?: unknown; isSidechain?: unknown; attachment?: { type?: unknown; prompt?: unknown }; message?: { content?: unknown } } | null;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || typeof row !== 'object' || row.isSidechain === true) continue;
      if (row.type === 'attachment' && row.attachment?.type === 'queued_command') {
        const p = row.attachment.prompt;
        const key = promptKey(typeof p === 'string' ? p : Array.isArray(p) ? p.map((b: { text?: unknown }) => String(b?.text ?? '')).join('\n') : '');
        const a = this.absorbed.find((x) => !x.seen && x.key === key);
        if (a) a.seen = true;
        continue;
      }
      const content = row.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content as { type?: unknown; id?: unknown; name?: unknown; tool_use_id?: unknown }[]) {
        if (row.type === 'assistant' && b?.type === 'tool_use' && typeof b.id === 'string') this.openCalls.set(b.id, { name: String(b.name ?? ''), at: Date.now() });
        else if (row.type === 'user' && b?.type === 'tool_result') this.openCalls.delete(String(b.tool_use_id ?? ''));
      }
    }
    // A turn of a thousand calls whose results were never read does not grow this without end.
    while (this.openCalls.size > 200) this.openCalls.delete(this.openCalls.keys().next().value!);
  }

  /** The messages typed into an earlier turn that this marker's turn ran for, or null when it is not
   *  such a turn: typed prompts only, as many as are still waited for at most, the last of them keyed
   *  as one of them. Claude Code joins several into one turn (measured on 2.1.332). */
  private followerOf(m: Marker): Absorbed[] | null {
    if (m.origin !== 'prompt' || typeof m.prompt_key !== 'string' || typeof m.prompts !== 'number' || m.prompts < 1 || typeof m.at !== 'number') return null;
    // A message pressed into a turn and not seen taken counts from its Enter: Claude Code may have taken
    // it late and run it by itself, before the chat's turn for it looked (turn()).
    const open = [...this.absorbed.filter((a) => !a.seen && m.at! >= a.at), ...this.unsureOpen().filter((a) => m.at! >= a.at)].sort((a, b) => a.at - b.at);
    // All of them as one prompt, one blank line between.
    if (open.length > 1 && m.prompts === 1 && m.prompt_key === promptKey(open.map((a) => a.text).join('\n\n'))) return open;
    let end = -1;
    for (let i = open.length - 1; i >= 0 && end < 0; i--) if (open[i].key === m.prompt_key) end = i;
    if (end < 0 || m.prompts > end + 1) return null;
    return open.slice(end + 1 - m.prompts, end + 1);
  }

  /** The Stop hook's file as it stands, or null: none, or one not whole or not the hook's. */
  private readMarker(): Marker | null {
    if (!existsSync(this.markerPath)) return null;
    try {
      const row: unknown = JSON.parse(readFileSync(this.markerPath, 'utf8'));
      return row && typeof row === 'object' && typeof (row as Marker).at === 'number' ? row as Marker : null;
    } catch { return null; }
  }

  /** The Stop hook's file, but only when it belongs to this turn: a session the user drives from
   *  the Claude app writes markers too, and one of those must never be sent as an answer. Between
   *  turns the same file is read by takeIdle, which holds to that rule by what started the turn. */
  private takeMarker(sentAt: number): string | null {
    const row = this.readMarker();
    if (!row?.at || row.at < sentAt) return null;
    rmSync(this.markerPath, { force: true });
    if (row.transcript_path && row.transcript_path !== this.transcript) {
      const was = this.transcript;
      this.transcript = row.transcript_path;
      const id = sessionOf(row.transcript_path);
      if (id && id !== this.session.id) this.backendSessionId = id; // the CLI forked the session
      // Another conversation: the names of the old one's teammates tie nothing in it, and an Enter's
      // offset in the old file says nothing of the new one.
      if (id !== sessionOf(was)) { this.forgetTeammates(); this.unsure.clear(); }
    }
    return String(row.text ?? '');
  }

  /**
   * A Stop marker that came with no turn of Angelia's open: taken (the file goes), and returned when it
   * is an answer the chat should get.
   *
   * Late: the last turn typed here was closed without its marker (the quiet path), and this one is that
   * turn's. The hook says when the turn's last typed row was written (`prompt_at`): Angelia's own
   * message is typed between that turn's Enter and its close, a turn someone typed in the Claude app
   * afterwards is not. The key of the turn's one typed prompt must be the key of what Angelia typed
   * (`prompt_key`). Delivered unless the chat already has these words as that turn's answer.
   *
   * Self-started: the hook says Claude Code queued what started the turn (`origin: notification`),
   * and each task whose end it names (`origin_ids`) was started while a turn of Angelia's was read
   * (`ours`), and each teammate whose message it names (`origin_teammates`) was spawned in one
   * (`oursTeammates`); such a marker counts as use of the session (lastUsedAt), sent or not. A turn a person typed (`prompt`), one the hook could not place (`unknown`, or a marker
   * of an older hook with no origin), or one that names no task of Angelia's turns, is never
   * delivered: the owner is working in the app. `inTurn`: found while a turn of Angelia's waits for
   * its own marker (that turn's reader reads the rows, and nothing is late).
   *
   * Never the CLI's own error row or usage limit, an empty answer, or `[SILENT]`. Each marker not
   * delivered is one log line with the reason, never the words.
   */
  private takeIdle(inTurn = false, turnFailed = false): UnaskedAnswer | null {
    const m = this.readMarker();
    if (!m?.at) return null;
    rmSync(this.markerPath, { force: true });
    if (!inTurn) this.selfTurn++;
    // What the turn started between turns is the chat's when the turn is (`ours` below), whatever it
    // then says; else it is not.
    let ours = false, peer = false;
    try { return this.judgeIdle({ ...m, at: m.at }, inTurn, turnFailed, (p = false) => { ours = true; peer = p; }); }
    finally {
      this.settleSpawns(ours, this.turnSpan(m.at), peer);
      // The report of a teammate that has ended is judged: its name ties nothing from here on.
      const named = Array.isArray(m.origin_teammates) ? m.origin_teammates.map((n) => bareName(String(n))) : [];
      this.dropEnded(named.filter((n) => this.endedTeammates.has(n)));
    }
  }

  /** Where the turn a marker written at `at` ends began in the transcript, and where the next one began
   *  (Infinity: none read yet): the last turn start read whose row was written by then. None read: an
   *  empty span. */
  private turnSpan(at: number): { from: number; to: number } {
    let i = this.turnStarts.length - 1;
    while (i >= 0 && this.turnStarts[i].time > at) i--;
    if (i < 0) return { from: Infinity, to: Infinity };
    return { from: this.turnStarts[i].at, to: this.turnStarts[i + 1]?.at ?? Infinity };
  }

  /** One row read: when it begins a turn, its offset and time go to turnStarts. A turn begins after a
   *  closed one (turnRows), and also with a row that starts one (a task's end, a teammate's message, a
   *  typed prompt) while the last reads open with no tool result owed: a turn cut with no interrupt row. */
  private noteStart(line: string, at: number): void {
    const before = this.startState;
    if (!line.includes('"user"') && !line.includes('"assistant"')) return;
    this.startState = turnRows(line, before);
    let row: { type?: unknown; timestamp?: unknown; isSidechain?: unknown; isMeta?: unknown; rowSource?: unknown; origin?: { kind?: unknown }; message?: { content?: unknown } } | null;
    try { row = JSON.parse(line); } catch { return; }
    if (!row || row.isSidechain === true) return;
    const c = row.message?.content;
    const blocks = (Array.isArray(c) ? c : []) as { type?: unknown; text?: unknown; id?: unknown; tool_use_id?: unknown }[];
    for (const b of blocks) {
      if (row.type === 'assistant' && b?.type === 'tool_use') this.startOwed.add(String(b.id));
      else if (row.type === 'user' && b?.type === 'tool_result') this.startOwed.delete(String(b.tool_use_id));
    }
    if (row.type !== 'user') return;
    const text = typeof c === 'string' ? c : blocks.map((b) => String(b?.text ?? '')).join('\n');
    const kind = row.origin?.kind;
    const starter = row.isMeta !== true && (kind === 'human' || kind === 'task-notification'
      || (row.origin === undefined && row.rowSource === 'recorded' && /^\s*Another Claude session sent a message:\s*<teammate-message\b/.test(text)));
    const cut = before === 'open' && !this.startOwed.size && starter;
    if (!cut) {
      if (before !== 'none' && before !== 'said' && before !== 'error') return;
      if (this.startState !== 'open' && this.startState !== 'command') return;
    }
    // A Stop hook that sent the answer back (the language check) goes on with the same turn.
    if (text.trimStart().startsWith('Stop hook feedback:')) return;
    this.startOwed.clear();
    const time = Date.parse(String(row.timestamp ?? ''));
    this.turnStarts.push({ at, time: Number.isNaN(time) ? 0 : time });
    if (this.turnStarts.length > TURN_STARTS_MAX) this.turnStarts.shift();
  }

  /** takeIdle's verdict on a marker it took. `ours`: called once the turn proves to be the chat's;
   *  `peer`: tied to a peer's work (a peer's turn closed on the quiet path, a peer's task or teammate). */
  private judgeIdle(m: Marker & { at: number }, inTurn: boolean, turnFailed: boolean, ours: (peer?: boolean) => void): UnaskedAnswer | null {
    const text = String(m.text ?? '').trim();
    const no = (why: string): null => { this.emit('log', `tmux: a turn ended between turns and its answer is not delivered: ${why}; ${text.length} chars pane=${this.name}`); return null; };
    if (m.transcript_path && m.transcript_path !== this.transcript) {
      if (sessionOf(m.transcript_path) !== sessionOf(this.transcript)) return no('it is of another session (started in the Claude app)');
      this.transcript = m.transcript_path; // the same file under another spelling of its folder
    }
    // The rows since the last look: whether the CLI's error row is the last word. Not inside a turn:
    // its own reader reads them, for the chat, and says what it found (`turnFailed`).
    if (!inTurn) this.readTranscript();
    const failedRow = inTurn ? turnFailed : this.rows === 'error';
    // A message of the chat's typed into a running turn that the turn did not take: Claude Code ran it
    // as the next turn, by itself (measured on 2.1.332). Its one typed prompt is that message.
    // Several such messages run as one turn (their prompts joined): the hook counts each, and keys the last.
    const follower = this.followerOf(m);
    if (follower) {
      {
        ours();
        this.absorbed = this.absorbed.filter((a) => !follower.includes(a));
        // An unsure one answered here is not answered again when its own turn finds it taken late.
        for (const u of this.unsure.values()) if (follower.some((a) => a.turn === u.turn && a.key === u.key && a.at === u.at)) u.answered = true;
        // It runs only after the turn it was typed into: a turn closed on the quiet path is over too.
        if (!inTurn && this.quietEnd && m.at! >= this.quietEnd.sentAt) this.quietEnd = undefined;
        this.lastUsedAt = Date.now();
        if (failedRow) return no('a message typed into the last turn, and an API error of the CLI');
        if (!text) return no('a message typed into the last turn, with no text');
        if (text === SILENT) return no('a message typed into the last turn, and [SILENT]');
        if (isLimitText(text)) return no('a message typed into the last turn, and a usage limit of the CLI');
        return { answer: 'midturn', text };
      }
    }
    const late = inTurn ? undefined : this.quietEnd;
    if (late && m.at >= late.sentAt) {
      // Whatever this marker is, the turn closed on the quiet path is over: a Stop only comes after it.
      this.quietEnd = undefined;
      const typedAt = typeof m.prompt_at === 'number' ? m.prompt_at : undefined;
      // And its one typed prompt is what Angelia typed (the hook's key of it): a turn someone typed in
      // the app inside that window, or into that turn, is theirs.
      // The chat's messages typed into that turn count as Angelia's: then the hook counts them too,
      // and the last typed prompt it keys is one of them.
      const own = (m.prompt_key === late.key && m.prompts === 1)
        || (late.taken.length > 0 && m.prompts === 1 + late.taken.length && typeof m.prompt_key === 'string' && late.taken.includes(m.prompt_key));
      if (m.origin !== 'notification' && typedAt !== undefined && typedAt >= late.sentAt - 1000 && typedAt <= late.endedAt && !own) {
        return no('late, but the prompt the hook read is not the one Angelia typed');
      }
      if (m.origin !== 'notification' && typedAt !== undefined && typedAt >= late.sentAt - 1000 && typedAt <= late.endedAt) {
        // Its prompts are Angelia's (`own` above): the turn is the chat's.
        ours(late.peer);
        // A usage limit comes as the CLI's error row too: named as what it is.
        if (isLimitText(text)) return no('late, and a usage limit of the CLI');
        if (failedRow) return no('late, and an API error of the CLI, not an answer');
        if (!text) return no('late, with no text');
        if (text === SILENT) return no('late, and [SILENT]');
        // The same words, or the lines before them too, which went out as progress lines.
        if (sameAnswer(text, late.said)) return no('late, and the chat has it as the turn\'s answer');
        return { answer: 'late', text };
      }
    }
    if (m.origin !== 'notification') {
      const why = typeof m.origin_why === 'string' ? m.origin_why.replace(/[^\w <>(),-]/g, '').slice(0, 120) : '';
      return no(m.origin === 'prompt' ? `a person typed it in the Claude app or the pane${why ? ` (${why})` : ''}` : `what started it is not known${why ? ` (${why})` : ''}`);
    }
    if (this.heldSince === undefined || m.at < this.heldSince) return no('it ended before this session was read');
    // Only the end of work a turn of Angelia's started: the owner's own background work, a prompt the
    // session scheduled, a message from a teammate the owner spawned stay in the app.
    // A teammate's message (`origin_teammates`, the names) is tied the same way: the teammate was
    // spawned in a turn of this chat's.
    const ids = Array.isArray(m.origin_ids) ? m.origin_ids.filter((x): x is string => typeof x === 'string') : [];
    const mates = Array.isArray(m.origin_teammates) ? m.origin_teammates.filter((x): x is string => typeof x === 'string') : [];
    if (!ids.length && !mates.length) return no('nothing ties it to work a turn of this chat started');
    if (!ids.every((id) => this.ours.has(id))) return no('the work it reports was not started by a turn of this chat');
    if (!mates.every((n) => this.isOurs(n))) return no('the teammate that sent it was not started by a turn of this chat');
    // The turn is the chat's: a teammate it spawns, a task it starts, is the chat's work as well (a
    // peer's, when it is tied to a peer's).
    ours(ids.some((id) => this.peerIds.has(id)) || mates.some((n) => this.peerTeammates.has(bareName(n))));
    // A session woken by the end of the chat's own work is in use, whatever it then says (nothing,
    // [SILENT], an error): its idle time starts again, so long background work stays read while it is
    // active. Only tied ends count: the owner's own work in the app does not hold the pane.
    this.lastUsedAt = Date.now();
    if (isLimitText(text)) return no('a usage limit of the CLI');
    if (failedRow) return no('an API error of the CLI, not an answer');
    if (!text) return no('no text');
    if (text === SILENT) return no(m.origin_idle === true ? 'a teammate\'s idle note, and [SILENT]' : '[SILENT]');
    return { answer: 'self', text, ...(ids.length ? {} : { by: 'teammate' as const }), ...(m.origin_idle === true ? { idle: true } : {}) };
  }

  /** The tasks and teammates started since the last marker taken between turns become the chat's
   *  (`ours`: that marker's turn was the chat's) or stay out. A spawn read in a turn tied to the chat's
   *  work counts as one of the chat's turns (measured on 2.1.332: the lead, woken by a teammate's
   *  report, spawns the next). `turn`: only the spawns read in that marker's own turn (turnSpan) are
   *  the chat's; those before it go, those after it wait for their own turn's marker. */
  private settleSpawns(ours: boolean, turn?: { from: number; to: number }, peer = false): void {
    if (ours) {
      for (const s of this.pendingSpawns) {
        if (turn && (s.at < turn.from || s.at >= turn.to)) continue;
        this.own(s.id, s.teammate, peer, s.team);
      }
    }
    this.pendingSpawns = turn && turn.to !== Infinity ? this.pendingSpawns.filter((s) => s.at >= turn.to) : [];
  }

  /** A task (`id`) or teammate (`teammate`) is the chat's work from now on; `peer`: a peer's turn started
   *  it, or a turn tied to a peer's work, and the levels never approve what it starts. */
  private own(id: string | undefined, teammate: string | undefined, peer: boolean, team?: string): void {
    if (id) { addOurs(this.ours, id); if (peer) addOurs(this.peerIds, id); else this.peerIds.delete(id); }
    if (!teammate) return;
    addOurs(this.oursTeammates, teammate);
    if (team) this.teams.set(teammate, team); else this.teams.delete(teammate);
    // A peer's mark stays while that teammate may be alive, whoever spawns the name next (dropEnded).
    if (peer) addOurs(this.peerTeammates, teammate);
  }

  /** A teammate's message names one of the chat's: by name, and by team when both it and the spawn say
   *  one. A name kept open past TEAMMATE_MAX_MS is dropped. */
  private isOurs(id: string): boolean {
    const name = bareName(id), team = id.slice(name.length + 1);
    if (this.openTeammates.has(name) && !this.teammateOpen(name)) { this.openTeammates.delete(name); this.dropEnded([name]); }
    if (!this.oursTeammates.has(name)) return false;
    const spawned = this.teams.get(name);
    return !team || !spawned || team === spawned;
  }

  /** The teammates of these names are over: no message under such a name is the chat's any more. */
  private dropEnded(names: Iterable<string>): void {
    for (const n of names) {
      this.endedTeammates.delete(n);
      this.endedAtEnter.delete(n);
      this.oursTeammates.delete(n);
      this.peerTeammates.delete(n);
      this.teams.delete(n);
    }
  }

  /** What ties the turn a request between turns comes from to the chat (SelfWork), by what the hook
   *  read of it. Only a positive tie counts: the end of a task or a teammate's message, each the chat's
   *  (`ours`, `oursTeammates`; a teammate only while the book has it open), or the chat's own typed
   *  message (typedByUs). A turn the hook could not
   *  place (`unknown`: a "No" with words in Claude's dialog once read so, rows the hook does not know),
   *  a scheduled prompt, a request with no origin (an older hook) is tied to nothing: it
   *  may be one the owner typed in the Claude app. */
  private workOf(o: RequestOrigin | undefined): SelfWork {
    if (o?.origin === 'prompt') {
      // Every prompt typed into that turn is one of the chat's own: one a person typed among them is theirs too.
      const keys = promptKeysOf(o);
      if (!keys.length || !keys.every((k) => this.typedByUs(k))) return 'none';
      // A row nobody typed joined it (another session's message, a scheduled prompt, others' work).
      if (!this.joinedOurs(o)) return 'none';
      const q = this.quietEnd;
      const tied = !!q && keys.some((k) => q.key === k || q.taken.includes(k));
      // Tied only by the turn closed on the quiet path, whose marker may never come: the same words typed
      // in the app later are the owner's. Held to that turn's time and count, as its late answer is (judgeIdle).
      if (q && keys.some((k) => !this.absorbed.some((a) => a.key === k))) {
        const at = o.promptAt;
        if (at === undefined || at < q.sentAt - 1000 || at > q.endedAt || (o.prompts ?? keys.length) > 1 + q.taken.length) return 'none';
      }
      return tied && q.peer ? 'peer' : 'chat';
    }
    if (o?.origin !== 'notification') return 'none';
    const ids = o.ids ?? [], mates = o.teammates ?? [];
    if (!ids.length && !mates.length) return 'none';
    // A teammate counts only while the book has it open: spawned in the chat's turn and not ended. Its
    // name alone, once it ended, is a word anyone can write.
    if (!ids.every((id) => this.ours.has(id)) || !mates.every((n) => this.isOurs(n) && this.teammateOpen(bareName(n)))) return 'none';
    return ids.some((id) => this.peerIds.has(id)) || mates.some((n) => this.peerTeammates.has(bareName(n))) ? 'peer' : 'chat';
  }

  /** Read the Stop marker between turns, from the end of this session's first turn here until the
   *  pane is let go of, stopped or handed off (`gen`). While a turn of Angelia's runs it keeps off:
   *  from the turn's Enter on, a marker is that turn's answer. Each tick it also beats for the
   *  permission hook (`idle`) and takes what the hook relayed (betweenTurns). */
  private startIdle(): void {
    if (this.idle || !this.up) return;
    const gen = this.gen;
    const tick = (): void => {
      if (gen !== this.gen || !this.up) { this.stopIdle(); return; }
      if (this.turnSentAt !== undefined || this.beating) return;
      if (!this.idleBeat || Date.now() - this.idleBeatAt >= IDLE_BEAT_MS) this.beatIdle();
      try { this.betweenTurns(); } catch (e) { this.emit('log', `tmux: a permission between turns failed: ${(e as Error).message} pane=${this.name}`); }
      try {
        const a = this.takeIdle();
        if (a) this.emit('unasked', a);
      } catch (e) { this.emit('log', `tmux: reading between turns failed: ${(e as Error).message} pane=${this.name}`); }
    };
    this.idle = setInterval(tick, this.opts.idlePollMs ?? IDLE_POLL_MS);
    this.idle.unref();
    // The hook relays from the end of the turn on, not from the first tick.
    if (this.turnSentAt === undefined && !this.beating) this.beatIdle();
  }

  /** The reader between turns' heartbeat (`idle`): the hook relays, and says what started the turn. */
  private beatIdle(): void {
    this.idleBeatAt = Date.now();
    this.relay.beat(this.idleBeatAt, true);
    this.idleBeat = true;
  }

  /** The reader between turns stops: its heartbeat goes, and a hook waiting on it steps aside. */
  private stopIdle(): void {
    if (this.idle) clearInterval(this.idle);
    this.idle = undefined;
    if (this.idleBeat) { this.relay.quiet(); this.idleBeat = false; }
  }

  /**
   * A permission request between the chat's turns, while the daemon holds the pane. The hook says what
   * started the turn that asks (RequestOrigin). A turn a person typed in the Claude app or the pane is
   * theirs, as it always was: the hook steps aside (`pass`) and Claude asks in its own dialog. Any other
   * goes to the orchestrator as `self-permission`, with what ties it to the chat (workOf): the end of
   * the chat's own task or teammate's message, or the chat's own messages that Claude Code runs as a
   * turn of their own (a late or untaken one), is the chat's (`chat`, or `peer` for a peer's work),
   * and the profile's levels decide it as in a chat turn. Anything else (a scheduled prompt, another
   * session's message, a turn the hook could not place, a request of an older hook with no origin) is
   * `none`: the chat asks the owner. Requests answered in the
   * pane or the app meanwhile are told as `self-permission-answered`.
   */
  private betweenTurns(): void {
    const taken = this.relay.take();
    // The rows since the last look first: a teammate's end written meanwhile closes it (teammateOpen),
    // so its name no longer ties the turn that asks.
    if (taken.length) this.readTranscript();
    for (const r of taken) {
      this.relayedAt = Date.now();
      this.selfRequest(r);
    }
    for (const id of this.relay.gone()) {
      this.relayedAt = Date.now();
      this.selfBook.take(id);
      const a = this.selfAsked.get(id);
      if (a) { this.selfAsked.delete(id); this.selfDeciding.set(id, { ...a, since: Date.now() }); }
    }
    if (this.selfDeciding.size) for (const e of this.decide(this.selfDeciding, false)) this.emit('self-permission-answered', e);
  }

  /**
   * One request of a turn the chat did not type now (betweenTurns), or one a chat turn's reader took
   * that is not of that turn (`inTurn`: ofThisTurn said no). A turn a person typed, with none of the
   * chat's own prompts in it, is theirs: the hook steps aside. Any other goes to the orchestrator as
   * `self-permission`, tied by workOf; in a chat turn a turn that holds a prompt of the chat's but is
   * not that turn (another opened it, a person typed into it, a row nobody typed joined it that is not
   * the chat's own work) is tied to nothing.
   */
  private selfRequest(r: RelayedRequest, inTurn = false): void {
    const o = r.origin;
    const own = inTurn ? this.ownKeys() : new Set<string>();
    const keys = o?.origin === 'prompt' ? (o.promptKeys?.length ? o.promptKeys : o.promptKey ? [o.promptKey] : []) : [];
    const where = inTurn ? 'a permission while a chat turn is read, not of that turn' : 'a permission between turns';
    // A chat turn with no key to hold it to (adopted from a daemon that carried none): asked, never passed.
    const noKey = inTurn && !own.size;
    if (o?.origin === 'prompt' && !noKey && !keys.some((k) => own.has(k) || this.typedByUs(k))) {
      this.relay.pass(r.id);
      this.emit('log', `tmux: ${where}, in a turn a person typed (${o.why ?? 'a typed prompt'}): not relayed, Claude asks in its own dialog pane=${this.name}`);
      return;
    }
    this.selfBook.add(r.id, r.at ? Math.max(5000, HOOK_GIVE_UP_MS - (Date.now() - r.at) - 30_000) : undefined);
    this.selfAsked.set(r.id, { tool: r.tool, input: r.input });
    const work = inTurn && o?.origin === 'prompt' ? 'none' : this.workOf(o);
    const what = work === 'none' ? `a turn nothing ties to the chat's work (${o ? o.why ?? 'what started it is not known' : 'no origin: an older hook'})`
      : `a turn the agent started by itself (${o?.why ?? 'what started it is not known'}), tied to ${work === 'peer' ? 'a peer\'s work' : 'the chat\'s work'}`;
    this.emit('log', `tmux: ${where}, in ${what} pane=${this.name}`);
    this.emit('self-permission', { ...relayedPermission(r), turn: this.selfTurn, work } satisfies SelfPermission);
  }

  /** The keys of the prompts the chat's turn read now may hold: what it typed, the messages typed into
   *  it, and those of the last turn that Claude Code runs as this one (followAbsorbed). */
  private ownKeys(): Set<string> {
    const sentAt = this.turnSentAt;
    return new Set([this.tieKey, ...this.followKeys, ...this.restoredKeys, ...this.absorbed.filter((a) => a.turn === sentAt).map((a) => a.key)].filter(Boolean));
  }

  /**
   * A request the chat turn's reader took is of that turn: the hook read a turn a typed prompt opened,
   * every prompt typed into it is the chat's own (ownKeys), and every row nobody typed that joined it
   * is the end of the chat's own task or a message of its own open teammate (workOf: `chat`). A slash
   * command's row is not the text typed: its turn's one prompt, written from its Enter on, is its own,
   * and its key is the turn's tie from then on (tieKey), for a message typed into the turn later and
   * for a restart. Anything else is not, whatever the reader is waiting on: a turn Claude Code ran
   * before it (a task's end, another session's message, queued first; this turn's message may have
   * joined it), a turn another session's message, a scheduled prompt or anyone else's work joined, a
   * person's turn, a request written under the last idle beat, or one with no origin or no `joins` (an
   * older hook).
   */
  private ofThisTurn(o: RequestOrigin | undefined, sentAt: number, command: boolean): boolean {
    if (o?.origin !== 'prompt' || o.openedBy !== 'prompt') return false;
    const keys = promptKeysOf(o);
    if (!keys.length) return false;
    if (!this.joinedOurs(o)) return false;
    if (command && keys.length === 1 && o.promptAt !== undefined && o.promptAt >= sentAt) { this.tieKey = keys[0]; return true; }
    const own = this.ownKeys();
    return keys.every((k) => own.has(k));
  }

  /** Each row nobody typed that joined a typed turn is known (the hook listed all of them: `joins`) and
   *  is the chat's own work (workOf: `chat`): the end of its task, a message of its open teammate. A
   *  scheduled prompt, another session's message, a row of a kind not known, a peer's or anyone else's
   *  work is not; nor is a turn of an older hook, which does not say what joined it. */
  private joinedOurs(o: RequestOrigin): boolean {
    const joined = o.joined ?? [];
    if (o.joins === undefined || o.joins !== joined.length) return false;
    return joined.every((j) => j.kind === 'notification' && this.workOf({ origin: 'notification', ids: j.ids, teammates: j.teammates }) === 'chat');
  }

  /** The key of the turn read now, for the daemon after a restart (the orchestrator's cutTurns). */
  turnKey(): string | undefined { return this.tieKey || undefined; }

  /** After adopt, before the turn's reader starts: the key of what the last daemon typed for this turn. */
  restoreTurnKey(key: unknown, keys?: unknown): void {
    const good = (k: unknown): k is string => typeof k === 'string' && /^[0-9a-f]{32}$/.test(k);
    if (good(key)) this.tieKey = key;
    this.restoredKeys = Array.isArray(keys) ? keys.filter(good).slice(0, 50) : [];
  }

  /** Every key of the turn read now when Claude Code ran it for several messages (followAbsorbed). */
  turnKeys(): string[] | undefined {
    const keys = this.followKeys.length > 1 ? this.followKeys : this.restoredKeys;
    return keys.length ? keys : undefined;
  }

  /** The background tasks and teammates still open here, their ends read first when no turn is: the
   *  pane is not reaped. */
  openTaskCount(): number {
    if (this.up && this.turnSentAt === undefined && this.openTasks.size) this.readTranscript();
    for (const [id, at] of this.openTasks) if (Date.now() - at >= TEAMMATE_MAX_MS) this.openTasks.delete(id);
    return this.openTasks.size;
  }

  /** A typed prompt's key is one of the chat's own: the turn closed on the quiet path, or a message
   *  typed into a turn that Claude Code runs as one of its own. */
  private typedByUs(key: string): boolean {
    return this.quietEnd?.key === key || !!this.quietEnd?.taken.includes(key) || this.absorbed.some((a) => a.key === key) || this.unsureOpen().some((a) => a.key === key);
  }

  /** The unsure messages (unsure) not answered yet, of the transcript read now, as Absorbed entries of
   *  the turn their Enter went into: that turn's own marker, keyed the same (the chat sent the same words
   *  twice), is never taken as their follower (watch). An entry of another transcript can be in neither:
   *  its Enter's offset is not this file's. */
  private unsureOpen(): Absorbed[] {
    return [...this.unsure.values()].filter((u) => !u.answered && u.transcript === this.transcript).map((u) => ({ key: u.key, text: u.text, at: u.at, turn: u.turn, seen: false }));
  }

  /** Nothing is asked between turns any more: the pane is let go of or stopped. */
  private forgetSelfAsks(): void {
    this.selfBook.clear();
    this.selfAsked.clear();
    this.selfDeciding.clear();
  }

  /** A chat answer goes to the hook waiting on that request, and to no other; no key is pressed. False
   *  when that hook has stepped aside already: Claude then asks in its own dialog. */
  answerPermission(id: string, allow: boolean, how: PermissionAnswer = {}): boolean {
    const full = this.permissions.take(id) ?? this.selfBook.take(id);
    if (!full) return false;
    this.selfAsked.delete(full);
    this.relayedAt = Date.now();
    return this.relay.answer(full, allow, how.message);
  }

  /** The hook relays while this beats: written now, then every RELAY_BEAT_MS, whatever the reader is
   *  waiting on. One reader beats at a time. */
  private startBeat(gen: number): void {
    if (this.beating) clearInterval(this.beating.timer);
    this.relay.beat();
    this.idleBeat = false;
    const timer = setInterval(() => this.relay.beat(), RELAY_BEAT_MS);
    timer.unref();
    this.beating = { timer, gen };
  }

  /** The turn's reader stops beating. With the reader between turns on, its heartbeat takes over at
   *  once (`idle`); else nobody reads the chat now, and a waiting hook steps aside at once. `keep`: while
   *  a turn is read, the heartbeat is left as it is, for the daemon after a restart (release). */
  private stopBeat(keep = false): void {
    const beating = !!this.beating;
    if (this.beating) clearInterval(this.beating.timer);
    this.beating = undefined;
    if (keep && beating) return;
    if (this.idle && this.up && this.turnSentAt === undefined) this.beatIdle();
    else { this.relay.quiet(); this.idleBeat = false; }
  }

  /**
   * Let the pane go on living. This is the whole reason for running in tmux: the server is
   * Angelia's own, so a restart or a 30-minute idle reap costs nothing and `ensure()` reattaches
   * by name on the next message, with MCP servers and background tasks still warm.
   *
   * It was declared on the interface, called by the orchestrator, and never implemented here -
   * so every reap and every restart ran `stop()` instead and killed the pane, silently, because
   * the next message respawned and resumed by id.
   */
  async release(o: { restart?: boolean } = {}): Promise<void> {
    // An Enter for a message typed into the turn may have been under way: its lock holds no tool call now.
    rmSync(join(this.dir, 'absorb.lock'), { force: true });
    this.gen++; // a turn being read stops being read; the pane goes on with it
    this.recording = false;
    this.permissions.clear();
    this.forgetSelfAsks();
    // A shutdown for a restart leaves the last heartbeat to grow old: a hook waits for the next daemon,
    // which adopts the turn, instead of stepping aside into a dialog nobody can answer from the chat.
    this.stopBeat(o.restart);
    // Nobody reads it between turns either: what the session says by itself from here on stays in it.
    this.stopIdle();
    this.quietEnd = this.heldSince = undefined;
    this.absorbed = [];
    // An Enter of this object's is no word on what a next reader of the pane types.
    this.unsure.clear();
    // The next turn reads from the file's end: a teammate the owner spawns in the app meanwhile under
    // a name of the chat's is never seen, so no name stays the chat's (its report stays in the app).
    // Nobody reads the pane for its teammates' ends any more either.
    this.forgetTeammates();
    this.up = false;
  }

  /** One transcript row read: the background work it starts or ends. Started while a turn of
   *  Angelia's was read: its end may wake the agent, and that answer is the chat's (a peer's turn,
   *  TurnFlags.peer, marks it a peer's work too). Started between turns: the chat's only when the turn
   *  it was started in proves to be (settleSpawns). A named teammate is open until its end is read; one
   *  the owner spawned from the app under a name of the chat's is theirs from then on. */
  private noteBackground(line: string): void {
    if (!line.includes('tool_result') && !line.includes('tool_use') && !line.includes('task-notification')) return;
    const { starts, ends } = backgroundRows(line, this.calls);
    for (const s of starts) {
      this.openTasks.set(s.id, Date.now());
      if (this.openTasks.size > OURS_MAX) this.openTasks.delete(this.openTasks.keys().next().value!);
      if (s.teammate) {
        // The one of that name before it is over: its marks go with it.
        if (this.endedTeammates.has(s.teammate)) this.dropEnded([s.teammate]);
        const before = this.openTeammates.get(s.teammate);
        if (before && before.id !== s.id) this.openTasks.delete(before.id);
        this.openTeammates.delete(s.teammate);
        this.openTeammates.set(s.teammate, { id: s.id, at: Date.now() });
        if (this.openTeammates.size > OURS_MAX) this.openTeammates.delete(this.openTeammates.keys().next().value!);
      }
      if (this.recording) { this.own(s.id, s.teammate, this.turnPeer, s.team); continue; }
      if (s.teammate) { this.oursTeammates.delete(s.teammate); this.peerTeammates.delete(s.teammate); }
      this.pendingSpawns.push({ id: s.id, at: this.rowAt, ...(s.teammate ? { teammate: s.teammate } : {}), ...(s.team ? { team: s.team } : {}) });
      if (this.pendingSpawns.length > OURS_MAX) this.pendingSpawns.shift();
    }
    for (const id of ends) {
      this.openTasks.delete(id);
      for (const [name, t] of this.openTeammates) if (t.id === id) { this.openTeammates.delete(name); this.endedTeammates.add(name); }
    }
  }

  /** A named teammate of that name is open here: spawned, no end of it read, and not past TEAMMATE_MAX_MS. */
  private teammateOpen(name: string): boolean {
    const t = this.openTeammates.get(name);
    return !!t && Date.now() - t.at < TEAMMATE_MAX_MS;
  }

  /** No teammate name ties a turn to the chat any more, and nothing waits to be settled. Task ids stay
   *  (`ours`): each is one call's, so no one else's work can take one on. */
  private forgetTeammates(): void {
    this.openTasks.clear();
    this.openTeammates.clear();
    this.oursTeammates.clear();
    this.peerTeammates.clear();
    this.teams.clear();
    this.endedTeammates.clear();
    this.endedAtEnter.clear();
    this.startOwed.clear();
    this.pendingSpawns = [];
    this.turnStarts = [];
    this.startState = 'none';
  }

  async stop(): Promise<void> {
    this.gen++;
    this.permissions.clear();
    this.forgetSelfAsks();
    this.stopBeat();
    this.stopIdle();
    this.quietEnd = this.heldSince = undefined;
    this.absorbed = [];
    this.unsure.clear();
    this.forgetTeammates();
    await this.tm(['kill-session', '-t', exact(this.name)]);
    this.up = false;
    this.emit('exit', { code: 0, signal: null });
  }

  kill(): void { void this.stop(); }
}

/**
 * Which permission dialog on the pane is new, one poll at a time, for a turn read in the background:
 * the chat hears of each once. A dialog that was answered can be followed by the next one before any
 * poll sees the pane without a dialog: that one is announced when it asks something else, or when the
 * same question is still up once the answer had time to land.
 */
export class DialogWatch {
  private id: string | null = null;
  private asked = '';
  private answeredAt = 0;

  get open(): boolean { return this.id !== null; }

  see(dialog: { tool: string; preview: string } | null, pending: (id: string) => boolean, now = Date.now()): { announce?: string; gone?: string } {
    if (this.id && !pending(this.id)) this.answeredAt ||= now;
    if (!dialog) {
      const gone = this.id ?? undefined;
      this.id = null; this.answeredAt = 0;
      return gone ? { gone } : {};
    }
    const asked = `${dialog.tool}\n${dialog.preview}`;
    if (this.id && !(this.answeredAt && (asked !== this.asked || now - this.answeredAt > REASK_MS))) return {};
    this.id = randomUUID().slice(0, 8); this.asked = asked; this.answeredAt = 0;
    return { announce: this.id };
  }
}

/** True when `dir`, as Claude Code's add-dir dialog shows it, is one of the profile's add_dirs
 *  (a leading ~ is the home folder; a trailing slash does not count). A relative entry is resolved
 *  against `base`, the profile's cwd, where claude runs and resolves it too. */
export function addDirListed(dir: string, addDirs: string[], home = homedir(), base = process.cwd()): boolean {
  if (!dir) return false;
  // Claude shows the folder as it resolved it (/tmp is /private/tmp on macOS), so the real path counts too.
  const forms = (d: string) => {
    const p = resolve(base, d.replace(/^~(?=$|\/)/, home)).replace(/(.)\/+$/, '$1');
    try { return [p, realpathSync(p)]; } catch { return [p]; }
  };
  const want = forms(dir);
  return addDirs.some((d) => forms(d).some((f) => want.includes(f)));
}

/** Where a turn stands by its transcript rows. `none`: nothing of a turn was written (the CLI answered
 *  the message itself), or the turn was cut short (Esc, a "No" in Claude Code's own dialog).
 *  `command`: a slash command's row and nothing after it; the CLI may answer it itself, so it counts
 *  as `none` until a prompt for the model follows. `open`: the last row is a prompt, a tool call,
 *  thinking or a tool result, so a tool runs or the model owes an answer. `said`: the last row is the
 *  assistant's text, which ends a finished turn, or comes before a tool call not written yet.
 *  `error`: the last row is the CLI's own row for a failed API call or a usage limit
 *  (`isApiErrorMessage`, or an `error` on the row), after which nothing follows; its text is the
 *  turn's answer, as it was before. */
export type TurnRows = 'none' | 'command' | 'open' | 'said' | 'error';

/** A user row that is the CLI's record of a slash command, not a prompt for the model. */
const COMMAND_ROW = /^<command-(name|message|args)>/;
/** What the CLI wrote around a command it ran itself: its output, and the caveat before it. */
const LOCAL_ROW = /^<local-command-[a-z]+>/;
/** What Claude Code writes as a user row when a turn is cut short with Esc (with or without "for
 *  tool use"); no Stop hook runs after it. Not measured on 2.1.329: the text is Claude Code's own. */
const INTERRUPTED = '[Request interrupted by user';
/** A tool result that says the person refused the call in Claude Code's own dialog (paneVerdict in
 *  tui-permissions.ts reads the same two shapes). The turn stops there, with no Stop hook. */
function refused(row: { toolUseResult?: unknown }, b: { is_error?: unknown; content?: unknown }): boolean {
  return row.toolUseResult === REJECTED || (b.is_error === true && (typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')).startsWith("The user doesn't want to proceed"));
}

/**
 * Where the turn stands after the rows in `chunk`, starting from `state`. The last row that counts
 * decides. Rows that count are the session's own user and assistant message rows, as the other
 * readers here take them (history.ts, the Stop hook's finalText): not a subagent's (isSidechain), not
 * the bookkeeping Claude Code writes between them (system and queue-operation rows, snapshots). A row
 * may hold one content block or several; they are read in order, so text followed by a tool call
 * reads `open`. A meta row counts only right after a slash command's row: it is then the prompt the
 * command made for the model (a skill's text), and the model works from there.
 */
export function turnRows(chunk: string, state: TurnRows = 'none'): TurnRows {
  for (const line of chunk.split('\n')) {
    if (!line.includes('"user"') && !line.includes('"assistant"')) continue; // most rows are bookkeeping
    let row: { type?: unknown; isSidechain?: unknown; isMeta?: unknown; isCompactSummary?: unknown; isVisibleInTranscriptOnly?: unknown; isApiErrorMessage?: unknown; error?: unknown; toolUseResult?: unknown; message?: { content?: unknown } } | null;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || row.isSidechain === true) continue;
    const content = row.message?.content;
    const blocks = (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []) as { type?: unknown; text?: unknown; is_error?: unknown; content?: unknown }[];
    if (row.type === 'assistant') {
      if (isApiErrorRow(row)) { state = 'error'; continue; }
      for (const b of blocks) {
        if (b?.type === 'text') { if (String(b.text ?? '').trim()) state = 'said'; }
        // A tool call, or thinking: the model is at work.
        else if (b?.type === 'tool_use' || b?.type === 'thinking' || b?.type === 'redacted_thinking') state = 'open';
      }
    } else if (row.type === 'user') {
      if (row.isCompactSummary === true || row.isVisibleInTranscriptOnly === true) continue;
      const text = blocks.map((b) => (b?.type === 'text' ? String(b.text ?? '') : '')).join('\n').trim();
      if (row.isMeta === true) { if (state === 'command' && !LOCAL_ROW.test(text)) state = 'open'; continue; }
      const results = blocks.filter((b) => b?.type === 'tool_result');
      if (text.startsWith(INTERRUPTED) || results.some((b) => refused(row, b))) state = 'none';
      else if (results.length) state = 'open';
      else if (LOCAL_ROW.test(text)) { if (state === 'command') state = 'none'; }
      else if (COMMAND_ROW.test(text)) { if (state === 'none') state = 'command'; }
      // A prompt: typed, or one Claude Code wrote for the model (a hook's feedback, an image).
      else if (text || blocks.length) state = 'open';
    }
  }
  return state;
}

/** `api-error`: Claude Code's own row for a failed API call (api-error.ts), never the agent's words. */
export type TranscriptEvent = { kind: 'text'; text: string } | { kind: 'tool' } | { kind: 'api-error'; text: string };

/** Assistant text and tool calls, in order, from a slice of a Claude Code transcript. */
export function transcriptEvents(chunk: string): TranscriptEvent[] {
  const out: TranscriptEvent[] = [];
  for (const line of chunk.split('\n')) {
    let row: { type?: string; message?: { content?: unknown } };
    try { row = JSON.parse(line); } catch { continue; }
    const content = row?.message?.content;
    const failed = apiErrorText(row);
    if (failed !== null) { out.push({ kind: 'api-error', text: failed }); continue; }
    if (row?.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const b of content as { type?: string; text?: string }[]) {
      if (b?.type === 'text' && String(b.text ?? '').trim()) out.push({ kind: 'text', text: String(b.text).trim() });
      else if (b?.type === 'tool_use') out.push({ kind: 'tool' });
    }
  }
  return out;
}

/** The transcript from `from` on, at most the last TRANSCRIPT_SLICE_MAX bytes of it. */
function readSlice(path: string, from: number): string {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return ''; }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(from, size - TRANSCRIPT_SLICE_MAX);
    if (size <= start) return '';
    const buf = Buffer.allocUnsafe(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

/** The session a transcript file is of: its name without the extension. */
function sessionOf(path: string): string | undefined {
  return path.split('/').pop()?.replace(/\.jsonl$/, '');
}

function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}
