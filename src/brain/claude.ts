import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Profile } from '../instance/config/schema.js';
import type { BrainEvent } from '../core/types.js';
import { claudeArgv, childEnv, versionAtLeast, CLAUDE_ENV, MIN_CLAUDE_VERSION } from './argv.js';
import { BrainExited, PermissionBook, blockedConnectorNames, blockedShort, deniedConnectorCount, exitReason, jsonLine, permissionPreview, stopChild, wireChild, type Brain, type BrainOptions, type BrainSession, type PermissionAnswer, CHILD_GROUP, signalGroup } from './brain.js';
import { LOST_SESSION_LINE, placeTranscript } from './transcripts.js';
import { mcpLaunch } from '../capabilities/compile.js';

export { BrainExited, exitReason, type BrainOptions } from './brain.js';

/** How long after the spawn the connectors Claude Code named as blocked are counted (checkBlocked). */
export const BLOCKED_CHECK_MS = 30_000;

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
  lastOutputAt?: number;
  version = '';
  /** Claude Code accepts the id Angelia mints, so the backend id is the session id. */
  backendSessionId?: string;
  /** connectors: all: how many connectors this launch drops by address, and the ones Claude Code's
   *  stderr named as blocked (blockedShort, checked once, BLOCKED_CHECK_MS after the spawn). */
  private deniedConnectors = 0;
  private blocked: string[] = [];
  private blockedTimer?: NodeJS.Timeout;

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
    const [bin, ...args] = claudeArgv(this.profile, session, this.opts.bin ?? 'claude', this.opts.system, this.opts.mcp);
    this.deniedConnectors = deniedConnectorCount((this.opts.mcp ?? mcpLaunch(this.profile.cwd)).settings);
    const child = spawn(bin, args, { cwd: this.profile.cwd, env: { ...childEnv(this.opts.env), ...CLAUDE_ENV }, stdio: ['pipe', 'pipe', 'pipe'], ...CHILD_GROUP });
    this.child = child;
    const done = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.exited) return;
      this.exited = true;
      clearTimeout(this.blockedTimer); // a child gone before the check says nothing about its connectors
      this.permissions.clear();
      this.lines.emit('exit', { code, signal });
      this.emit('exit', { code, signal });
    };
    wireChild(child, {
      exit: done,
      failure: (t) => { this.failure = t; },
      line: (obj: Line) => { this.lastOutputAt = Date.now(); this.lines.emit('line', obj); },
      benign: (line) => { this.blocked.push(...blockedConnectorNames(line)); },
    });
    // Claude Code does not wait for the account's connector list before the first turn (docs/reference.md,
    // "The first turn of a new session"), so its warning may come after that turn's result: the count
    // is read once, well after both tries of that request (5 s each) are over.
    if (this.deniedConnectors) { this.blockedTimer = setTimeout(() => this.checkBlocked(), this.opts.blockedCheckMs ?? BLOCKED_CHECK_MS); this.blockedTimer.unref(); }
    // Without this handshake the CLI never sends can_use_tool over stdio: it silently denies the tool
    // and the model tends to invent a result. Verified against claude 2.1.272.
    this.send({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize', hooks: {} } });
  }

  /** Once per start, while the child runs: a start that named fewer connectors as blocked than it
   *  drops says so in the log and as `connectors-short`, with the names it blocked. */
  private checkBlocked(): void {
    if (this.exited) return;
    const blocked = [...new Set(this.blocked)];
    const short = blockedShort(this.deniedConnectors, blocked);
    if (!short) return;
    this.emit('log', `warning: ${short}`);
    this.emit('connectors-short', short, blocked);
  }

  /** Returns an error string when the init line proves the child unusable. */
  private checkInit(init: Line): string | null {
    if (init.apiKeySource && init.apiKeySource !== 'none') return `billing: claude is using ${init.apiKeySource}, not the subscription`;
    this.version = String(init.claude_code_version ?? '0');
    if (!versionAtLeast(this.version, MIN_CLAUDE_VERSION)) return `version: claude ${this.version} < ${MIN_CLAUDE_VERSION}`;
    return null;
  }

  private send(obj: unknown): void {
    this.child?.stdin.write(jsonLine(obj));
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
          yield { kind: 'permission', id, tool: String(l.request.tool_name ?? '?'), ...permissionPreview(l.request.input), request: { tool: String(l.request.tool_name ?? '?'), input: l.request.input } };
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
  answerPermission(id: string, allow: boolean, how: PermissionAnswer = {}): boolean {
    const full = this.permissions.take(id);
    if (!full) return false;
    id = full;
    // The CLI runs the tool with updatedInput: an allow sends the request's own input back unchanged.
    const asked = this.requested.get(id) ?? {};
    this.requested.delete(id);
    this.send({
      type: 'control_response',
      response: { subtype: 'success', request_id: id, response: allow ? { behavior: 'allow', updatedInput: how.input ?? asked } : { behavior: 'deny', message: how.message ?? 'Denied from chat' } },
    });
    return true;
  }

  get pendingPermissionCount(): number { return this.permissions.size; }

  hasPendingPermission(id: string): boolean { return this.permissions.has(id); }

  /** Graceful stop: close stdin, then SIGTERM, then SIGKILL. */
  async stop(graceMs = 5000): Promise<void> {
    if (this.child && !this.exited) await stopChild(this.child, this.lines, () => this.exited, graceMs);
  }

  kill(): void { if (this.child && !this.exited) signalGroup(this.child, 'SIGKILL'); }

}
