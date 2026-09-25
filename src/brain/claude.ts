import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import type { Profile } from '../instance/config/schema.js';
import type { BrainEvent } from '../core/types.js';
import { claudeArgv, childEnv, versionAtLeast, MIN_CLAUDE_VERSION } from './argv.js';
import { BrainExited, PermissionBook, exitReason, permissionPreview, stopChild, type Brain, type BrainOptions, type BrainSession } from './brain.js';
import { LOST_SESSION_LINE, placeTranscript } from './transcripts.js';

export { BrainExited, exitReason, type BrainOptions } from './brain.js';

type Line = Record<string, any>;

/** One long-lived `claude -p --input-format stream-json` child for one session key. */
export class ClaudeBrain extends EventEmitter implements Brain {
  private child?: ChildProcessWithoutNullStreams;
  private lines = new EventEmitter();
  private exited = false;
  /** Tail of the child's stderr, plus a spawn error when there was one. Reported only if the
   *  child dies without producing a result. */
  private failure = '';
  private permissions: PermissionBook;
  /** Each pending request's tool input, sent back with an allow. */
  private requested = new Map<string, unknown>();
  /** One line for the chat before the first turn's answer, when the launch had to say something (a lost conversation). */
  private notice: string | null = null;
  lastUsedAt = Date.now();
  version = '';
  /** Claude Code accepts the id Angelia mints, so the backend id is the session id. */
  backendSessionId?: string;

  constructor(
    readonly profile: Profile,
    readonly session: BrainSession,
    private readonly opts: BrainOptions = {},
  ) {
    super();
    this.permissions = new PermissionBook(opts.permissionTimeoutMs ?? 10 * 60_000, (id) => { if (this.answerPermission(id, false)) this.emit('permission-timeout', id); });
  }

  get alive(): boolean {
    return !!this.child && !this.exited;
  }

  /** Spawn the child. The CLI emits its `system/init` line only after the first user message,
   *  so billing and version checks happen inside the first turn. */
  start(): void {
    let session = this.session;
    if (session.started && this.opts.projectsDir) {
      const placed = placeTranscript(this.profile.cwd, session.id, this.opts.projectsDir);
      if (placed.status === 'copied') this.emit('log', `transcript ${session.id.slice(0, 8)} copied from ${placed.from} for ${this.profile.cwd}`);
      if (placed.status === 'missing') {
        // See TuiBrain.ensure: a resume of a conversation that is gone fails every turn; a fresh
        // start under the same id answers, and the chat is told once.
        this.emit('log', `transcript ${session.id.slice(0, 8)} not found under ${this.opts.projectsDir}; starting fresh in ${this.profile.cwd}`);
        this.notice = LOST_SESSION_LINE;
        session = { ...session, started: false };
      }
    }
    const [bin, ...args] = claudeArgv(this.profile, session, this.opts.bin ?? 'claude', this.opts.system);
    const child = spawn(bin, args, { cwd: this.profile.cwd, env: childEnv(this.opts.env), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const done = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.exited) return;
      this.exited = true;
      this.permissions.clear();
      this.lines.emit('exit', { code, signal });
      this.emit('exit', { code, signal });
    };
    child.on('exit', done);
    // A spawn that never happened at all - no such binary, no permission to execute it - raises
    // `error` and never `exit`. Without this the turn waits for a line that can never come, and
    // the queue behind it waits with it.
    child.on('error', (err) => { this.failure = err.message; done(null, null); });
    // Writing to a child that has already gone raises EPIPE on the socket, which is an unhandled
    // error event on the process, which is the daemon.
    child.stdin.on('error', () => {});
    // Kept, never logged as it arrives: stderr can carry file paths and message text. Only the tail
    // is reported, and only when the child dies without an answer, because otherwise a deterministic
    // failure - not logged in, an unknown flag - is completely invisible.
    child.stderr.on('data', (b: Buffer) => { this.failure = (this.failure + b.toString('utf8')).slice(-400); });
    createInterface({ input: child.stdout }).on('line', (raw) => {
      let obj: Line;
      try { obj = JSON.parse(raw); } catch { return; }
      this.lines.emit('line', obj);
    });
    // Without this handshake the CLI never sends can_use_tool over stdio: it silently denies the tool
    // and the model tends to invent a result. Verified against claude 2.1.272.
    this.send({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize', hooks: {} } });
  }

  /** Returns an error string when the init line proves the child unusable. */
  private checkInit(init: Line): string | null {
    if (init.apiKeySource && init.apiKeySource !== 'none') return `billing: claude is using ${init.apiKeySource}, not the subscription`;
    this.version = String(init.claude_code_version ?? '0');
    if (!versionAtLeast(this.version, MIN_CLAUDE_VERSION)) return `version: claude ${this.version} < ${MIN_CLAUDE_VERSION}`;
    return null;
  }

  private send(obj: unknown): void {
    this.child?.stdin.write(JSON.stringify(obj) + '\n');
  }

  /**
   * Run one turn. Yields progress (only for a text block that a later block follows),
   * permission requests, and exactly one result.
   */
  async *turn(text: string): AsyncGenerator<BrainEvent> {
    if (!this.alive) throw new BrainExited('brain not running');
    this.lastUsedAt = Date.now();
    const queue: Line[] = [];
    let wake: (() => void) | null = null;
    const push = (l: Line) => { queue.push(l); wake?.(); };
    const onExit = () => push({ type: '__exit' });
    this.lines.on('line', push);
    this.lines.on('exit', onExit);
    this.send({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    let pendingText: string | null = null;
    try {
      if (this.notice) { yield { kind: 'notice', text: this.notice }; this.notice = null; }
      while (true) {
        if (!queue.length) await new Promise<void>((r) => (wake = r));
        wake = null;
        const l = queue.shift()!;
        if (l.type === '__exit') { yield { kind: 'result', text: '', isError: true, reason: exitReason(this.failure) }; return; }
        if (l.type === 'control_response') continue; // answer to our initialize
        if (l.type === 'system' && l.subtype === 'init') {
          if (typeof l.session_id === 'string') this.backendSessionId = l.session_id;
          const problem = this.checkInit(l);
          if (problem) { this.kill(); yield { kind: 'result', text: '', isError: true, reason: problem }; return; }
          continue;
        }
        if (l.type === 'assistant') {
          const blocks: Line[] = l.message?.content ?? [];
          for (const b of blocks) {
            if (b.type === 'text' && String(b.text ?? '').trim()) {
              if (pendingText) yield { kind: 'progress', text: pendingText };
              pendingText = String(b.text).trim();
            } else if (b.type === 'tool_use') {
              if (pendingText) { yield { kind: 'progress', text: pendingText }; pendingText = null; }
            }
          }
        } else if (l.type === 'control_request' && l.request?.subtype === 'can_use_tool') {
          const id = String(l.request_id);
          this.permissions.add(id);
          this.requested.set(id, l.request.input);
          yield { kind: 'permission', id, tool: String(l.request.tool_name ?? '?'), ...permissionPreview(l.request.input) };
        } else if (l.type === 'result') {
          this.lastUsedAt = Date.now();
          yield { kind: 'result', text: String(l.result ?? '').trim(), isError: !!l.is_error };
          return;
        }
      }
    } finally {
      this.lines.off('line', push);
      this.lines.off('exit', onExit);
    }
  }

  /** `id` may be a prefix of a pending request id (the chat sees the first 8 chars). */
  answerPermission(id: string, allow: boolean, input?: unknown): boolean {
    const full = this.permissions.take(id);
    if (!full) return false;
    id = full;
    // The CLI runs the tool with updatedInput: an allow sends the request's own input back unchanged.
    const asked = this.requested.get(id) ?? {};
    this.requested.delete(id);
    this.send({
      type: 'control_response',
      response: { subtype: 'success', request_id: id, response: allow ? { behavior: 'allow', updatedInput: input ?? asked } : { behavior: 'deny', message: 'Denied from chat' } },
    });
    return true;
  }

  get pendingPermissionCount(): number { return this.permissions.size; }

  hasPendingPermission(id: string): boolean { return this.permissions.has(id); }

  /** Graceful stop: close stdin, then SIGTERM, then SIGKILL. */
  async stop(graceMs = 5000): Promise<void> {
    if (this.child && !this.exited) await stopChild(this.child, this.lines, () => this.exited, graceMs);
  }

  kill(): void {
    this.child?.kill('SIGKILL');
  }

}
