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
  /** The self-awareness prompt, for backends that take one at launch (Claude Code). grok reads it from a file; see self.ts. */
  system?: string;
  /** Claude Code's projects folder (transcripts.ts). When set, a resume first places the session's
   *  transcript under the profile cwd's own folder, and a session whose conversation is gone from
   *  every folder starts fresh under the same id instead of failing every turn. Unset in tests. */
  projectsDir?: string;
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
