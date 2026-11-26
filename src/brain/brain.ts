import type { McpLaunch } from '../capabilities/compile.js';
import type { EventEmitter } from 'node:events';
import type { Profile } from '../instance/config/schema.js';
import type { BrainEvent } from '../core/types.js';

export type BackendName = Profile['backend'];

/** What a brain may need to know of a turn besides its text. `peer`: another profile asked for it
 *  (sender `profile`): the work it starts is a peer's, which the levels never approve between turns.
 *  `msg`: the orchestrator's id for the chat message, the one absorb() was given for it, so a message
 *  pressed into the last turn is known as that message, not by its words (another with the same words
 *  is another message). */
export interface TurnFlags { app?: boolean; peer?: boolean; msg?: string }

export interface BrainOptions {
  bin?: string;
  permissionTimeoutMs?: number;
  /** tmux mode: how long a pane must read idle before a turn with no Stop marker ends (tui.ts:
   *  QUIET_MS; QUIET_TEXT_MS when the last transcript row is the assistant's text; QUIET_OPEN_MS when
   *  the transcript shows the turn open). Tests shorten them. */
  quietMs?: number;
  quietTextMs?: number;
  quietOpenMs?: number;
  /** tmux mode: how long a message waits for the pane's prompt before it goes back to the chat as not
   *  delivered (tui.ts: PROMPT_TIMEOUT_MS). Tests shorten it. */
  promptTimeoutMs?: number;
  /** tmux mode: how long a paste may take to show in the input box (tui.ts: LAND_MS). Tests shorten it. */
  landMs?: number;
  /** tmux mode: how long a tool call must have run before a chat message is typed into its turn (tui.ts: CALL_SETTLE_MS). Tests shorten it. */
  callSettleMs?: number;
  /** tmux mode: how long after a PreToolUse hook ended no chat message is typed into the turn (tui.ts: PRETOOL_SETTLE_MS). Tests shorten it. */
  pretoolSettleMs?: number;
  /** tmux mode: whether this session may take chat messages into a running turn, and so gets the
   *  PreToolUse hook. Unset reads the profile's `midturn`. */
  midturn?: boolean;
  /** tmux mode: how long the absorb lock may stand before its Enter, and how long the reader of the
   *  turn run for untaken messages waits for its prompt row (tui.ts: LOCK_FRESH_MS, FOLLOW_START_MS). Tests. */
  lockFreshMs?: number;
  followStartMs?: number;
  /** tmux mode: how long an unclaimed follow waits before the reader between turns takes over (tui.ts: FOLLOW_WAIT_MS). Tests. */
  followWaitMs?: number;
  /** tmux mode: how long an empty box after the Enter waits for the transcript's word (tui.ts: CONFIRM_MS). Tests. */
  confirmMs?: number;
  /** tmux mode: the home folder whose ~/.claude settings and plugins are read for other PreToolUse hooks (tests). */
  settingsHome?: string;
  /** tmux mode: how often the Stop marker is looked for between turns (tui.ts: IDLE_POLL_MS). Tests shorten it. */
  idlePollMs?: number;
  /** Print-mode Claude: how long after the spawn the blocked connectors are counted (claude.ts:
   *  BLOCKED_CHECK_MS). Tests shorten it. */
  blockedCheckMs?: number;
  /** tmux-mode Claude: how long one `claude mcp list` of the connector check may take
   *  (connectors-check.ts: MCP_LIST_TIMEOUT_MS). Tests shorten it. */
  mcpListTimeoutMs?: number;
  /** The agent's environment: no secret except the ones its profile was given (core/env.ts). */
  env?: NodeJS.ProcessEnv;
  /** tmux mode: the environment of Angelia's tmux server, which every profile's panes share. No
   *  secret at all. Default: this process's environment without the billing variables. */
  hostEnv?: NodeJS.ProcessEnv;
  /** tmux mode: another tmux server than Angelia's (`tmux -L <name>`), and another folder than the
   *  instance's for the pane's private files. The canary's throwaway pane sets both (canary.ts); the
   *  daemon sets neither. */
  tmuxSocket?: string;
  stateDir?: string;
  /** tmux mode: names in `env` that are secrets this profile was given. They reach the pane through
   *  a mode-600 file that is deleted once read, never through a tmux command line or the session's
   *  environment, where any process of this user could list them. */
  granted?: string[];
  /** tmux mode: secret names the agent must never see, even if the server still has them. */
  withheld?: string[];
  /** The self-awareness prompt, for backends that take one at launch (Claude Code, pi). grok reads it from a file; see self.ts. */
  system?: string;
  /** Claude Code's projects folder (transcripts.ts). When set, a resume first places the session's
   *  transcript under the profile cwd's own folder, and a session whose conversation is gone from
   *  every folder starts fresh under the same id instead of failing every turn. Unset in tests. */
  projectsDir?: string;
  /** The daemon's API socket, which a sandboxed agent (Codex) must be allowed to reach for `angelia send-media` and `angelia turn`. */
  apiSocket?: string;
  /** The profile's name in the table, for text the agent is told (Codex's sandbox note). */
  profileName?: string;
  /** Claude Code: the MCP launch from the profile's guard in the state folder (guardMcpLaunch), which
   *  the agent cannot change. Unset: read from the record in its folder (tests, the canary, a compile
   *  from before connectors). */
  mcp?: McpLaunch;
  /** Deny rules for this session only, on top of the compiled ones, in the backend's own form (agy;
   *  tests). Unset: the compiled ones alone. */
  deny?: string[];
  /** The paths in the state folder this profile reaches (compile.ts stateOpenPaths): Angelia's own
   *  sandboxes (pi's commands, agy) close the rest of the state folder. Unset: no such closing. */
  stateOpen?: string[];
  /** agy: its `--gemini-dir`, instead of the profile's own folder in the state folder (agyGeminiDir).
   *  Tests and the live probe set a scratch one; the daemon sets none. */
  geminiDir?: string;
}

export interface BrainSession {
  id: string;
  started: boolean;
}

/**
 * The only seam between the router and a coding agent: start in a profile cwd, send a turn,
 * receive progress / permission / result, stop. Implementations live next to this file.
 */
/** How a permission request is answered beyond yes or no. `input`: what an allowed tool runs with
 *  (print-mode Claude; the request's own input when absent). `message`: the refusal the agent hears. */
export interface PermissionAnswer { input?: unknown; message?: string }

export interface Brain extends EventEmitter {
  readonly profile: Profile;
  readonly session: BrainSession;
  lastUsedAt: number;
  /** When the CLI last wrote anything on stdout (print mode): a sign of life, whatever the line was.
   *  The stall watchdog reads it; undefined where the brain has no such stream (tmux). */
  lastOutputAt?: number;
  /** Backend version when it reports one; empty otherwise. */
  version: string;
  /** The backend's own id for this conversation once known. Backends that mint their own ids
   *  (grok) differ from `session.id` after the first turn; the orchestrator renames the row. */
  backendSessionId?: string;
  readonly alive: boolean;
  start(): void;
  /** `o.app`: the turn was typed in the desk app, not the chat. A tmux pane then takes none of the
   *  turn's background tasks for the chat's: the answer to their end must not reach the chat. */
  turn(text: string, o?: TurnFlags): AsyncGenerator<BrainEvent>;
  /** `id` may be a prefix of a pending request id (the chat sees the first 8 chars). `how.message`
   *  is what the agent hears with a refusal, where the backend can pass one; the others ignore it. */
  answerPermission(id: string, allow: boolean, how?: PermissionAnswer): boolean;
  readonly pendingPermissionCount: number;
  hasPendingPermission(id: string): boolean;
  stop(graceMs?: number): Promise<void>;
  /** The daemon stops: no message is typed into a running turn from now on, and the promise settles
   *  once none is between its Enter and Claude Code's word that it took it (a tui pane). */
  stopAbsorbing?(): Promise<void>;
  /** Let the session go without ending it. Backends whose session outlives the daemon (a tui pane)
   *  implement this, so an idle reap or a restart costs nothing; the rest are stopped instead.
   *  `restart`: the daemon stops for a restart, and the next one adopts the turn that runs (tui). */
  release?(o?: { restart?: boolean }): Promise<void>;
  /** A handoff while a turn runs: after `release`, keep reading the turn with nobody answering, until it
   *  is over. Only a backend whose session outlives its reader has these (a tui pane). */
  backgroundTurn?(): AsyncGenerator<BrainEvent>;
  /** `/resume` of a session sent to the background: read its running turn in the foreground again.
   *  The brain is alive again from the call on, before the first event is read. */
  follow?(): AsyncGenerator<BrainEvent>;
  /** Type a chat message into the turn that runs now, where the CLI queues it into that turn (a tui
   *  pane). True once the CLI took it; false when nothing was submitted, and the message is queued as a
   *  turn of its own. `msg`: the id turn() gets for the same message (TurnFlags.msg). */
  absorb?(text: string, msg?: string): Promise<boolean>;
  /** After a turn: how many messages typed into it it took, and how many it did not (those run as the
   *  next turn, read with followAbsorbed). Once; undefined when none was typed into it. */
  absorbOutcome?(): { taken: number; untaken: number } | undefined;
  /** The turn the CLI runs by itself for the messages the last turn did not take, read as a chat turn. */
  followAbsorbed?(): AsyncGenerator<BrainEvent>;
  /** The turn's result is in: the turn Claude Code runs for untaken messages will be read
   *  (followAbsorbed), however long the delivery of this answer takes. */
  claimFollow?(): void;
  /** That turn will not be read after all (/stop, the session gone): the reader between turns may take its marker. */
  releaseFollow?(): void;
  /** Why chat messages are not typed into this session's turns although the profile's switch is on. */
  readonly midturnOff?: string;
  /** The chat messages typed into the running turn, for the daemon after a restart; and, after adopt,
   *  those the last daemon typed into it (a tui pane). */
  midturnState?(): unknown[];
  restoreMidturn?(list: unknown[]): void;
  /** tmux mode: the key of what was typed for the turn read now, carried through a restart so that
   *  turn's permission requests are still held to it (TuiBrain.ofThisTurn). */
  turnKey?(): string | undefined;
  turnKeys?(): string[] | undefined;
  restoreTurnKey?(key: unknown, keys?: unknown): void;
  /** tmux mode: the named teammates spawned in this session and still open: its pane is not reaped. */
  openTeammateCount?(): number;
  /** A restarted daemon takes back a session it had sent to the background, or whose turn the restart
   *  cut off from its reader (then `follow` reads it for the chat). False: it is gone. */
  adopt?(turnSentAt: number): Promise<boolean>;
  /** When the running turn was typed in, for a background row that must survive a restart. */
  turnSentAt?: number;
  // A backend that reads its session between turns (a tui pane) also emits `unasked` with an
  // UnaskedAnswer (core/types.ts): a late answer, or the answer of a turn the CLI started by itself.
  // Only from the end of its first turn until it is released, stopped or handed off.
  kill(): void;
}

export class BrainExited extends Error {}

/** Permission-prompt bookkeeping shared by every backend: pending ids, prefix lookup, timeouts. */
export class PermissionBook {
  private pending = new Map<string, NodeJS.Timeout>();

  constructor(private readonly timeoutMs: number, private readonly onTimeout: (id: string) => void) {}

  /** `ms`: a shorter wait for this one request (a tmux hook's own time left, tui.ts). */
  add(id: string, ms = this.timeoutMs): void {
    this.pending.set(id, setTimeout(() => this.onTimeout(id), Math.min(ms, this.timeoutMs)));
  }

  /** Clears and returns the full id for a prefix, or null when it matches none or several. */
  take(prefix: string): string | null {
    const full = this.resolve(prefix);
    if (!full) return null;
    clearTimeout(this.pending.get(full));
    this.pending.delete(full);
    return full;
  }

  has(prefix: string): boolean { return this.resolve(prefix) !== null; }
  get size(): number { return this.pending.size; }

  clear(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  private resolve(prefix: string): string | null {
    const p = prefix.toLowerCase();
    const hits = [...this.pending.keys()].filter((k) => k.toLowerCase().startsWith(p));
    return hits.length === 1 ? hits[0] : null;
  }
}

/** Longest request shown whole in the permission line; a longer one is cut in the middle, with the
 *  count of what was left out, and sent in full just before it. */
const PREVIEW_MAX = 600;
/** Longest full request sent before the permission line. */
const DETAIL_MAX = 3500;

/** Everything a tool is about to do, as text: the command, or the file and what goes into it. */
export function describeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return String(input ?? '');
  const o = input as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  const command = str('command') ?? str('CommandLine');
  if (command !== undefined) return command;
  const file = str('file_path');
  if (file !== undefined) {
    if (str('content') !== undefined) return `${file} ← ${str('content')}`;
    if (str('new_string') !== undefined) return `${file}: "${str('old_string') ?? ''}" → "${str('new_string')}"`;
    return file;
  }
  return JSON.stringify(o);
}

/**
 * The permission line's text, and, when that had to be cut, the whole request to send first. Space
 * is collapsed, so a newline and 300 blanks cannot push the rest of a command out of sight, and a
 * cut says how much it left out: an owner approving from a phone must not see "echo ok" for a
 * command that goes on to pipe something into a shell.
 */
export function permissionPreview(input: unknown): { preview: string; detail?: string } {
  const full = describeInput(input).replace(/\s+/g, ' ').trim();
  if (full.length <= PREVIEW_MAX) return { preview: full };
  const left = full.length - 360 - 160;
  const detail = full.length <= DETAIL_MAX ? full : `${full.slice(0, DETAIL_MAX)} … (${(full.length - DETAIL_MAX).toLocaleString('en-US')} more characters not shown)`;
  return { preview: `${full.slice(0, 360)} … ${left.toLocaleString('en-US')} more characters … ${full.slice(-160)}`, detail: `The full request:\n${detail}` };
}

/** Wait for a child to exit; resolves false on timeout. `exited` is polled once up front. */
export function waitExit(lines: EventEmitter, exited: () => boolean, ms: number): Promise<boolean> {
  if (exited()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => { lines.off('exit', done); resolve(false); }, ms);
    const done = () => { clearTimeout(t); resolve(true); };
    lines.once('exit', done);
  });
}

/** How every backend starts its CLI: in a process group of its own (detached), so a forced stop
 *  reaches what the CLI started too (signalGroup). stdin stays a pipe: the CLI still ends on EOF when
 *  the daemon goes away. */
export const CHILD_GROUP = { detached: true } as const;

type Child = { pid?: number; stdin: { end(): void }; kill(signal: NodeJS.Signals): boolean };

/**
 * Signal a CLI and everything it started: a long shell command, an MCP server, pi's sandbox-exec.
 * The CLI leads its own group (CHILD_GROUP), and only it got the signal before, so those kept running
 * after the chat was told "Stopped". Falls back to the CLI alone when there is no group to signal.
 */
export function signalGroup(child: { pid?: number; kill(signal: NodeJS.Signals): boolean }, sig: NodeJS.Signals): void {
  if (child.pid) { try { process.kill(-child.pid, sig); return; } catch { /* no such group */ } }
  try { child.kill(sig); } catch { /* gone */ }
}

/**
 * Stop a backend's child: close stdin (every CLI here ends on EOF, and ends its own tools), then
 * SIGTERM, then SIGKILL, to the whole group. A CLI that ends on EOF is left to clean up after itself:
 * what it chose to leave running, it did on purpose. A forced stop (/stop mid-turn, the stall
 * watchdog) ends the whole group, a server the agent started in the background included; one that
 * needed SIGKILL may have left tools that ignore SIGTERM, so its group gets a last SIGKILL.
 */
export async function stopChild(child: Child, lines: EventEmitter, exited: () => boolean, graceMs: number): Promise<void> {
  child.stdin.end();
  if (await waitExit(lines, exited, graceMs)) return;
  signalGroup(child, 'SIGTERM');
  if (await waitExit(lines, exited, graceMs)) return;
  signalGroup(child, 'SIGKILL');
  await waitExit(lines, exited, graceMs);
  // It had to be killed: what it started may ignore SIGTERM too.
  if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is gone */ }
}

/**
 * The process groups of the CLIs running now. They are out of the daemon's own group, so launchd's
 * clean-up of a daemon that died no longer reaches them: on its way out, the daemon ends them itself.
 * (A SIGKILL of the daemon still leaves them; each CLI then ends on EOF, its tools may not.)
 */
const groups = new Set<number>();
export function trackGroup(child: { pid?: number; once(e: 'exit', f: () => void): unknown }): void {
  const pid = child.pid;
  if (!pid) return;
  groups.add(pid);
  child.once('exit', () => groups.delete(pid));
}
process.on('exit', () => { for (const g of groups) try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ } });

/**
 * stderr lines a healthy CLI prints, never a reason it died. Claude Code 2.1.332 prints the first at
 * every start of a profile given a connector (the allow list leaves the account's other connectors
 * out): "Warning: claude.ai MCP servers blocked by enterprise policy: claude.ai Google Drive, ...", and
 * with one connector left out (a deny list of one, connectors: all) "MCP server blocked" (measured).
 */
export const BENIGN_STDERR = [/^Warning: claude\.ai MCP servers? blocked by enterprise policy:/];

/**
 * The connectors one such line names as blocked, as Claude Code 2.1.332 prints it (its template, read
 * in the binary: "Warning: " + "claude.ai MCP server" or "servers" + " blocked by enterprise policy: "
 * + the names, joined by ", "): ["claude.ai Gmail", ...]. None for any other line.
 */
export function blockedConnectorNames(line: string): string[] {
  const m = /^Warning: claude\.ai MCP servers? blocked by enterprise policy:\s*(.*)$/.exec(line.trim());
  return m ? m[1].split(/,\s*/).map((n) => n.trim()).filter(Boolean) : [];
}

/**
 * The connectors a launch blocks in `connectors: all` (allLaunch): the serverUrl entries of its deny
 * list, when it has no allow list. Zero for any other launch: a granted profile's allow list blocks
 * every other connector of the account, so its warning names more than Angelia dropped.
 */
export function deniedConnectorCount(settings: Record<string, unknown>): number {
  if ('allowedMcpServers' in settings || !Array.isArray(settings.deniedMcpServers)) return 0;
  return new Set((settings.deniedMcpServers as unknown[]).flatMap((e) => (e && typeof e === 'object' && typeof (e as { serverUrl?: unknown }).serverUrl === 'string' ? [(e as { serverUrl: string }).serverUrl] : []))).size;
}

/**
 * The daemon's check of a deny list by address (connectors: all), which matches nothing when a pattern
 * is wrong or a connector moved, and so fails open. Undefined when the start blocked at least as many
 * connectors as it drops; else the log's warning. Not proof either way: a dropped connector the
 * account does not have (never connected, or disconnected in the Claude app) is no line either, and
 * one pattern that matches two connectors gives two names.
 */
export function blockedShort(denied: number, blocked: string[]): string | undefined {
  if (!denied || blocked.length >= denied) return undefined;
  return `connectors: all: this start dropped ${denied} connector${denied === 1 ? '' : 's'} by address, but Claude Code named ${blocked.length} as blocked${blocked.length ? ` (${blocked.join(', ')})` : ''}: a dropped connector may be loading (a wrong address in the table, or one the Claude app changed), or the account does not have it, or its connector list did not load`;
}

/**
 * Why the child died, for the log and for the retry decision. Always starts with `exit`, because
 * that prefix is what tells the orchestrator a brand-new session died before it ever answered.
 */
export function exitReason(failure: string): string {
  const line = failure.split('\n').map((l) => l.trim()).filter((l) => l && !BENIGN_STDERR.some((re) => re.test(l))).pop();
  return line ? `exit: ${line.slice(0, 200)}` : 'exit';
}

/**
 * One JSON object per line of a child's stdout, split on `\n` only. Node's readline also ends a line
 * at U+2028 and U+2029, which JSON.stringify leaves raw inside strings: a model answer holding one
 * was cut in two, both halves failed to parse, and when that line was the result the turn never
 * ended. Anything that is not a JSON object is skipped.
 */
export function onJsonLines(stdout: NodeJS.ReadableStream & { setEncoding(e: BufferEncoding): unknown }, fn: (obj: any) => void): void {
  // The part of a line seen so far, in pieces: joined only when its newline comes, so one long line
  // (a base64 image in a tool result) costs one pass, not one per chunk.
  let parts: string[] = [];
  const emit = (raw: string) => {
    let m: unknown;
    try { m = JSON.parse(raw.replace(/\r$/, '')); } catch { return; }
    if (m && typeof m === 'object') fn(m);
  };
  stdout.setEncoding('utf8');
  stdout.on('data', (s: string) => {
    let from = 0, i: number;
    while ((i = s.indexOf('\n', from)) !== -1) {
      parts.push(s.slice(from, i));
      emit(parts.join(''));
      parts = [];
      from = i + 1;
    }
    if (from < s.length) parts.push(s.slice(from));
  });
  // A last line with no newline, as readline would have given it.
  stdout.on('end', () => { if (parts.length) emit(parts.join('')); parts = []; });
}

/**
 * The wiring every print-mode brain gives its CLI child: its group tracked (trackGroup); its exit
 * reported, and so is a spawn that never happened at all (no such binary, no permission to execute it),
 * which raises `error` and never `exit`: without it the turn waits for a line that can never come, and
 * the queue behind it waits with it. EPIPE from a write to a child that has already gone is ignored: it
 * is an unhandled error event on the process otherwise, which is the daemon. stderr is kept, never
 * logged as it arrives (it can carry file paths and message text): its last 400 characters, or the
 * spawn's error, are the failure text, the reason given when the child dies without an answer, so a
 * deterministic failure (not logged in, an unknown flag) is not invisible. stdout is read as JSON lines.
 */
export function wireChild(child: import('node:child_process').ChildProcessWithoutNullStreams, w: {
  exit(code: number | null, signal: NodeJS.Signals | null): void;
  failure(text: string, from: 'error' | 'stderr'): void;
  line(obj: any): void;
  /** Each benign stderr line (BENIGN_STDERR), trimmed: the connectors it names as blocked are counted. */
  benign?(line: string): void;
}): void {
  trackGroup(child);
  let failure = '';
  child.on('exit', w.exit);
  child.on('error', (err) => { failure = err.message; w.failure(failure, 'error'); w.exit(null, null); });
  child.stdin.on('error', () => {});
  // Whole lines for `benign`: a chunk may end inside one.
  let part = '';
  const benign = (l: string) => { if (BENIGN_STDERR.some((re) => re.test(l.trim()))) w.benign?.(l.trim()); };
  child.stderr.on('end', () => { if (part) benign(part); part = ''; });
  child.stderr.on('data', (b: Buffer) => {
    const chunk = b.toString('utf8');
    if (w.benign) { const lines = (part + chunk).split('\n'); part = lines.pop() ?? ''; lines.forEach(benign); }
    // A line a healthy CLI prints (BENIGN_STDERR) is no failure text: kept, it could be the reason given.
    const text = chunk.split('\n').filter((l) => !BENIGN_STDERR.some((re) => re.test(l.trim()))).join('\n');
    if (!text) return;
    failure = (failure + text).slice(-400); w.failure(failure, 'stderr');
  });
  onJsonLines(child.stdout, w.line);
}

/** One JSON line for a CLI's stdin, with U+2028 and U+2029 escaped: JSON.stringify leaves them raw,
 *  and a reader that splits lines the way Node's readline does would cut the message there. */
export function jsonLine(obj: unknown): string {
  return JSON.stringify(obj).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + '\n';
}
