import type { EventEmitter } from 'node:events';
import type { Profile } from '../instance/config/schema.js';
import type { BrainEvent } from '../core/types.js';

export type BackendName = Profile['backend'];

export interface BrainOptions {
  bin?: string;
  permissionTimeoutMs?: number;
  /** The agent's environment: no secret except the ones its profile was given (core/env.ts). */
  env?: NodeJS.ProcessEnv;
  /** tmux mode: the environment of Angelia's tmux server, which every profile's panes share. No
   *  secret at all. Default: this process's environment without the billing variables. */
  hostEnv?: NodeJS.ProcessEnv;
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
}

export interface BrainSession {
  id: string;
  started: boolean;
}

/**
 * The only seam between the router and a coding agent: start in a profile cwd, send a turn,
 * receive progress / permission / result, stop. Implementations live next to this file.
 */
export interface Brain extends EventEmitter {
  readonly profile: Profile;
  readonly session: BrainSession;
  lastUsedAt: number;
  /** Backend version when it reports one; empty otherwise. */
  version: string;
  /** The backend's own id for this conversation once known. Backends that mint their own ids
   *  (grok) differ from `session.id` after the first turn; the orchestrator renames the row. */
  backendSessionId?: string;
  readonly alive: boolean;
  start(): void;
  turn(text: string): AsyncGenerator<BrainEvent>;
  /** `id` may be a prefix of a pending request id (the chat sees the first 8 chars). */
  answerPermission(id: string, allow: boolean, input?: unknown): boolean;
  readonly pendingPermissionCount: number;
  hasPendingPermission(id: string): boolean;
  stop(graceMs?: number): Promise<void>;
  /** Let the session go without ending it. Backends whose session outlives the daemon (a tui pane)
   *  implement this, so an idle reap or a restart costs nothing; the rest are stopped instead. */
  release?(): Promise<void>;
  /** A handoff while a turn runs: after `release`, keep reading the turn with nobody answering, until it
   *  is over. Only a backend whose session outlives its reader has these (a tui pane). */
  backgroundTurn?(): AsyncGenerator<BrainEvent>;
  /** `/resume` of a session sent to the background: read its running turn in the foreground again.
   *  The brain is alive again from the call on, before the first event is read. */
  follow?(): AsyncGenerator<BrainEvent>;
  /** A restarted daemon takes back a session it had sent to the background. False: it is gone. */
  adopt?(turnSentAt: number): Promise<boolean>;
  /** When the running turn was typed in, for a background row that must survive a restart. */
  turnSentAt?: number;
  kill(): void;
}

export class BrainExited extends Error {}

/** Permission-prompt bookkeeping shared by every backend: pending ids, prefix lookup, timeouts. */
export class PermissionBook {
  private pending = new Map<string, NodeJS.Timeout>();

  constructor(private readonly timeoutMs: number, private readonly onTimeout: (id: string) => void) {}

  add(id: string): void {
    this.pending.set(id, setTimeout(() => this.onTimeout(id), this.timeoutMs));
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

/** Graceful stop of a backend's child: close stdin (every CLI here ends on EOF), then SIGTERM, then SIGKILL. */
export async function stopChild(child: { stdin: { end(): void }; kill(signal: NodeJS.Signals): boolean }, lines: EventEmitter, exited: () => boolean, graceMs: number): Promise<void> {
  child.stdin.end();
  if (await waitExit(lines, exited, graceMs)) return;
  child.kill('SIGTERM');
  if (await waitExit(lines, exited, graceMs)) return;
  child.kill('SIGKILL');
  await waitExit(lines, exited, graceMs);
}

/**
 * Why the child died, for the log and for the retry decision. Always starts with `exit`, because
 * that prefix is what tells the orchestrator a brand-new session died before it ever answered.
 */
export function exitReason(failure: string): string {
  const line = failure.split('\n').map((l) => l.trim()).filter(Boolean).pop();
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

/** One JSON line for a CLI's stdin, with U+2028 and U+2029 escaped: JSON.stringify leaves them raw,
 *  and a reader that splits lines the way Node's readline does would cut the message there. */
export function jsonLine(obj: unknown): string {
  return JSON.stringify(obj).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + '\n';
}
