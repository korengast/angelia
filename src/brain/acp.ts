import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Profile } from '../instance/config/schema.js';
import type { BrainEvent } from '../core/types.js';
import type { ToolRequest } from '../core/permission-rules.js';
import { childEnv } from './argv.js';
import { BrainExited, PermissionBook, exitReason, jsonLine, permissionPreview, stopChild, wireChild, type Brain, type BrainOptions, type BrainSession, CHILD_GROUP, signalGroup } from './brain.js';

export type Msg = Record<string, any>;

/** What the brain does with a permission request before the chat sees it (AcpBrain.gate). */
export type GateDecision = 'allow' | 'block' | 'ask';
/** A block that names the rule, for the refused line the chat sees. */
export interface GateBlock { action: 'block'; reason: string }

/** A request the brain refused on its own (a 'block' from gate), kept for the session. */
export interface BlockedRequest { tool: string; preview: string; at: number; reason?: string; between?: true }

/**
 * A long-lived ACP agent (Agent Client Protocol, JSON-RPC 2.0 on stdio) per session key. Shared by
 * the CLIs that speak it (grok, agy): spawn, `initialize`, a session opened by the subclass
 * (`openSession`), `session/prompt` per turn with its `session/update` notifications read as the
 * turn's text and progress, `session/request_permission` relayed to the chat (or decided by `gate`),
 * stop and kill, and a start timeout. A subclass gives the launch line and the session handshake.
 */
export abstract class AcpBrain extends EventEmitter implements Brain {
  /** How long `initialize` and the session handshake may take. Read from the subclass, so a test may set it per backend. */
  static startTimeoutMs = 60_000;
  private child?: ChildProcessWithoutNullStreams;
  /** Lines from the child, by kind: `update`, `permission`, `exit`. */
  protected lines = new EventEmitter();
  private exited = false;
  /** The tail of stderr, for the reason a child that died without answering gives. */
  private failure = '';
  private nextId = 1;
  private replies = new Map<number, { resolve: (v: Msg) => void; reject: (e: Error) => void }>();
  private permissions: PermissionBook;
  /** Pending permission id -> the JSON-RPC id and options the agent offered, and the tool's name. */
  private permissionRequests = new Map<string, { rpcId: unknown; allow?: string; deny?: string; tool: string }>();
  /** Tools refused in the running turn, by the owner, a timeout or `gate`. */
  protected refusedThisTurn: string[] = [];
  /** Every request `gate` blocked in this session, oldest first. */
  readonly blocked: BlockedRequest[] = [];
  private ready?: Promise<string>;
  lastUsedAt = Date.now();
  lastOutputAt?: number;
  version = '';
  backendSessionId?: string;
  /** How many history updates the last session/load replayed (and this class dropped). */
  replayedUpdates = 0;

  constructor(readonly profile: Profile, readonly session: BrainSession, protected readonly opts: BrainOptions = {}) {
    super();
    this.permissions = new PermissionBook(opts.permissionTimeoutMs ?? 10 * 60_000, (id) => { if (this.answerPermission(id, false)) this.emit('permission-timeout', id); });
  }

  /** The CLI's name, in the messages the chat may see ("grok exited"). */
  protected abstract readonly cliName: string;
  /** The full launch line, executable first. */
  protected abstract argv(): string[];
  /** After `initialize`: open or resume the session; resolves to the ACP session id. Sets `backendSessionId`. */
  protected abstract openSession(init: Msg): Promise<string>;
  /** The tool's name as the permission line shows it. */
  protected abstract toolName(toolCall: Msg): string;
  /** The request in Claude Code's naming, for the profile's permission rules; undefined when it cannot be named. */
  protected toolRequest(_toolCall: Msg): ToolRequest | undefined { return undefined; }
  /** Work before the child is spawned (folders, files it reads at start). */
  protected beforeSpawn(): void {}
  /** Each tool_call update, in a turn and between turns: for a backend that watches what never asks. */
  protected onToolCall(_u: Msg): void {}
  /** The child's environment. */
  protected spawnEnv(): NodeJS.ProcessEnv { return childEnv(this.opts.env); }
  /**
   * Whether the agent may speak between turns (a background command done, agy wakes itself; ADR 0017 H).
   * When true, after the first turn the stream is read on: its text goes to the chat as an `unasked`
   * answer once it has been quiet for `quietMs`, and its permission requests are gated as in a turn,
   * with 'ask' refused (no turn is open to ask in). False keeps the old reading: nothing between turns.
   */
  protected readonly wakesBetweenTurns: boolean = false;
  /** How long the stream must be quiet before a between-turns answer is sent. */
  static quietMs = 1500;

  /**
   * The one place a permission request is decided before the chat is asked: 'allow' and 'block' answer
   * the agent at once, 'ask' relays the request to the chat. Every request is asked by default.
   */
  protected gate(_toolCall: Msg, _request: ToolRequest | undefined): GateDecision | GateBlock { return 'ask'; }

  /** The answer of a turn that ended with no text. `refused`: the tools refused in it, in order. */
  protected emptyAnswer(_refused: string[]): string { return ''; }

  get alive(): boolean { return !!this.child && !this.exited; }

  /** A turn is reading the stream; outside one, after the first, `wakesBetweenTurns` reads it. */
  private inTurn = false;
  private betweenArmed = false;
  private between = { text: '', refused: [] as string[], timer: undefined as NodeJS.Timeout | undefined };

  start(): void {
    this.beforeSpawn();
    const [bin, ...args] = this.argv();
    const child = spawn(bin, args, { cwd: this.profile.cwd, env: this.spawnEnv(), stdio: ['pipe', 'pipe', 'pipe'], ...CHILD_GROUP });
    this.child = child;
    if (this.wakesBetweenTurns) {
      this.lines.on('update', (u: Msg) => { if (this.betweenArmed && !this.inTurn) this.betweenUpdate(u); });
      this.lines.on('permission', (m: Msg) => { if (this.betweenArmed && !this.inTurn) this.betweenPermission(m); });
    }
    const done = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.exited) return;
      this.exited = true;
      clearTimeout(this.between.timer);
      this.permissions.clear();
      for (const p of this.replies.values()) p.reject(new BrainExited(`${this.cliName} exited`));
      this.replies.clear();
      this.lines.emit('exit', { code, signal });
      this.emit('exit', { code, signal });
    };
    // A spawn that never happened would otherwise leave the handshake waiting for ever (wireChild).
    wireChild(child, { exit: done, failure: (t) => { this.failure = t; }, line: (m: Msg) => { this.lastOutputAt = Date.now(); this.dispatch(m); } });
    // An agent that never answers initialize would hold the chat's first turn for good (Codex has the
    // same guard). Stopped then, so the next message starts a fresh process; the timer is cleared as
    // soon as the handshake ends, or it would kill a healthy brain later.
    const limit = (this.constructor as typeof AcpBrain).startTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    this.ready = Promise.race([this.handshake(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { this.kill(); reject(new Error(`${this.cliName} did not answer within ${Math.round(limit / 1000)} s of starting; check that \`${this.cliName} --version\` runs in a terminal`)); }, limit);
      timer.unref?.();
    })]).finally(() => clearTimeout(timer));
    this.ready.catch(() => {});
  }

  private dispatch(m: Msg): void {
    if (m.id !== undefined && m.method === undefined) {
      const p = this.replies.get(m.id);
      if (!p) return;
      this.replies.delete(m.id);
      if (m.error) p.reject(new Error(String(m.error.message ?? JSON.stringify(m.error))));
      else p.resolve(m.result ?? {});
      return;
    }
    if (m.method === 'session/request_permission') { this.lines.emit('permission', m); return; }
    if (m.method === 'session/update') {
      // Another session of the same process (an agy subagent Angelia attached): its text is not this
      // chat's answer; the parent reports what it did.
      const other = m.params?.sessionId !== undefined && this.backendSessionId !== undefined && m.params.sessionId !== this.backendSessionId;
      this.lines.emit(other ? 'other-update' : 'update', m.params?.update ?? {}, m.params?.sessionId);
      return;
    }
    if (m.id !== undefined && m.method) {
      // A client-side request we did not advertise (fs, terminal). Refuse it cleanly.
      this.write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `unsupported: ${m.method}` } });
    }
  }

  private write(obj: unknown): void {
    this.child?.stdin.write(jsonLine(obj));
  }

  protected call(method: string, params: unknown): Promise<Msg> {
    if (!this.alive) return Promise.reject(new BrainExited('brain not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.replies.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /**
   * `session/load` with the history it replays dropped. ACP replays the whole conversation as
   * session/update notifications before it answers. The chat already holds every one of those
   * messages, so they are dropped on purpose, and counted so the decision is visible. They must be
   * drained here: an update still arriving once a turn's listener is attached would be sent to the
   * chat as a fresh answer.
   */
  protected async loadDroppingReplay(params: Msg): Promise<Msg> {
    let replayed = 0;
    const drop = () => { replayed++; };
    this.lines.on('update', drop);
    try { return await this.call('session/load', params); }
    finally { this.lines.off('update', drop); this.replayedUpdates = replayed; }
  }

  /** initialize, then open or load the session. Resolves to the ACP session id. */
  private async handshake(): Promise<string> {
    const init = await this.call('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    if (typeof init.agentInfo?.version === 'string') this.version = init.agentInfo.version;
    return this.openSession(init);
  }

  async *turn(text: string): AsyncGenerator<BrainEvent> {
    if (!this.alive || !this.ready) throw new BrainExited('brain not running');
    this.lastUsedAt = Date.now();
    let sid: string;
    try { sid = await this.ready; }
    catch (e) { yield { kind: 'result', text: '', isError: true, reason: this.exited ? exitReason(this.failure) : `handshake: ${(e as Error).message}` }; return; }

    const queue: Msg[] = [];
    let wake: (() => void) | null = null;
    const push = (m: Msg) => { queue.push(m); wake?.(); };
    const onUpdate = (u: Msg) => push({ __kind: 'update', u });
    const onPermission = (m: Msg) => push({ __kind: 'permission', m });
    const onExit = () => push({ __kind: 'exit' });
    this.lines.on('update', onUpdate);
    this.lines.on('permission', onPermission);
    this.lines.on('exit', onExit);
    this.refusedThisTurn = [];
    this.inTurn = true;
    // What the agent said between turns and was still waiting for quiet goes first, as its own answer.
    const before = this.takeBetween();
    if (before) yield { kind: 'unasked', answer: 'self', text: before };
    let done: Msg | Error | undefined;
    this.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text }] })
      .then((r) => { done = r; push({ __kind: 'done' }); }, (e: Error) => { done = e; push({ __kind: 'done' }); });

    let pendingText = '';
    let lastFlushed = '';
    try {
      while (true) {
        if (!queue.length) await new Promise<void>((r) => (wake = r));
        wake = null;
        const item = queue.shift()!;
        if (item.__kind === 'exit') { yield { kind: 'result', text: '', isError: true, reason: exitReason(this.failure) }; return; }
        if (item.__kind === 'update') {
          const u: Msg = item.u;
          if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') pendingText += String(u.content.text ?? '');
          else if (u.sessionUpdate === 'tool_call') {
            this.onToolCall(u);
            const t = pendingText.trim();
            if (t && t !== lastFlushed) { lastFlushed = t; yield { kind: 'progress', text: t }; }
            pendingText = '';
          }
          continue;
        }
        if (item.__kind === 'permission') {
          const m: Msg = item.m;
          const options: Msg[] = Array.isArray(m.params?.options) ? m.params.options : [];
          // Only ever this one call: an allow_always would let the agent skip every later ask of its kind.
          // Without an allow_once, an approval is answered as a refusal (cancelled).
          const allow = options.find((o) => o.kind === 'allow_once');
          const deny = options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always');
          const tc: Msg = m.params?.toolCall ?? {};
          const id = String(tc.toolCallId ?? m.id);
          const tool = this.toolName(tc);
          const request = this.toolRequest(tc);
          const shown = permissionPreview(tc.rawInput ?? tc.title ?? '');
          let verdict = this.gate(tc, request);
          if (verdict === 'allow' && !allow) verdict = { action: 'block', reason: `${this.cliName} offered no allow-once answer` };
          if (verdict !== 'ask') {
            const reason = typeof verdict === 'object' ? verdict.reason : undefined;
            if (verdict !== 'allow') { this.refusedThisTurn.push(reason ? `${tool}: ${reason}` : tool); this.blocked.push({ tool, preview: shown.preview, at: Date.now(), ...(reason ? { reason } : {}) }); }
            this.reply(m.id, verdict === 'allow' ? allow?.optionId : deny?.optionId);
            continue;
          }
          this.permissionRequests.set(id, { rpcId: m.id, allow: allow?.optionId, deny: deny?.optionId, tool });
          this.permissions.add(id);
          yield { kind: 'permission', id, tool, ...shown, ...(request ? { request } : {}) };
          continue;
        }
        if (item.__kind === 'done') {
          this.lastUsedAt = Date.now();
          if (done instanceof Error) { yield { kind: 'result', text: '', isError: true, reason: this.exited ? exitReason(this.failure) : done.message }; return; }
          const stop = String((done as Msg)?.stopReason ?? 'end_turn');
          const text = pendingText.trim();
          if (stop === 'refusal' && !text) { yield { kind: 'result', text: '', isError: true, reason: 'refusal' }; return; }
          yield { kind: 'result', text: text || this.emptyAnswer([...this.refusedThisTurn]), isError: false };
          return;
        }
      }
    } finally {
      this.lines.off('update', onUpdate);
      this.lines.off('permission', onPermission);
      this.lines.off('exit', onExit);
      this.inTurn = false;
      if (this.wakesBetweenTurns) this.betweenArmed = true;
    }
  }

  /** Between turns: the agent's text gathers until the stream has been quiet for `quietMs`. */
  private betweenUpdate(u: Msg): void {
    if (u.sessionUpdate === 'tool_call') this.onToolCall(u);
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') this.between.text += String(u.content.text ?? '');
    else if (u.sessionUpdate === 'tool_call' && this.between.text && !this.between.text.endsWith('\n\n')) this.between.text += '\n\n';
    else if (u.sessionUpdate === 'tool_call') this.emit('log', `${this.cliName} between turns: tool ${this.toolName(u)} ${String(u.status ?? '')}`);
    this.armQuiet();
  }

  /** Between turns: gate() answers; what it would ask the chat is refused, as no turn is open to ask in. */
  private betweenPermission(m: Msg): void {
    const options: Msg[] = Array.isArray(m.params?.options) ? m.params.options : [];
    const allow = options.find((o) => o.kind === 'allow_once');
    const deny = options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always');
    const tc: Msg = m.params?.toolCall ?? {};
    const tool = this.toolName(tc);
    const verdict = this.gate(tc, this.toolRequest(tc));
    if (verdict === 'allow') { this.reply(m.id, allow?.optionId); this.armQuiet(); return; }
    const reason = typeof verdict === 'object' ? verdict.reason : verdict === 'ask' ? 'asked between turns, when no one could answer' : undefined;
    this.blocked.push({ tool, preview: permissionPreview(tc.rawInput ?? tc.title ?? '').preview, at: Date.now(), ...(reason ? { reason } : {}), between: true });
    this.between.refused.push(reason ? `${tool}: ${reason}` : tool);
    this.emit('log', `${this.cliName} between turns: refused ${tool}${reason ? ` (${reason})` : ''}`);
    this.reply(m.id, deny?.optionId);
    this.armQuiet();
  }

  private armQuiet(): void {
    clearTimeout(this.between.timer);
    this.between.timer = setTimeout(() => {
      const text = this.takeBetween();
      if (text) this.emit('unasked', { answer: 'self', text });
    }, (this.constructor as typeof AcpBrain).quietMs);
    this.between.timer.unref?.();
  }

  /** The between-turns answer gathered so far, emptied. */
  private takeBetween(): string {
    clearTimeout(this.between.timer);
    const text = this.between.text.trim() || (this.between.refused.length ? this.emptyAnswer(this.between.refused) : '');
    this.between = { text: '', refused: [], timer: undefined };
    return text;
  }

  /** Answer a permission request with an option id; none means the request was cancelled. */
  protected reply(rpcId: unknown, optionId: string | undefined): void {
    const outcome = optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
    this.write({ jsonrpc: '2.0', id: rpcId, result: { outcome } });
  }

  answerPermission(id: string, allow: boolean): boolean {
    const full = this.permissions.take(id);
    if (!full) return false;
    const req = this.permissionRequests.get(full);
    this.permissionRequests.delete(full);
    if (!req) return false;
    if (!allow) this.refusedThisTurn.push(req.tool);
    this.reply(req.rpcId, allow ? req.allow : req.deny);
    return true;
  }

  /** The running child's pid, for a backend that ends what the child started (agy). */
  protected get childPid(): number | undefined { return this.child && !this.exited ? this.child.pid : undefined; }

  get pendingPermissionCount(): number { return this.permissions.size; }
  hasPendingPermission(id: string): boolean { return this.permissions.has(id); }

  async stop(graceMs = 5000): Promise<void> {
    if (this.child && !this.exited) await stopChild(this.child, this.lines, () => this.exited, graceMs);
  }

  kill(): void { if (this.child && !this.exited) signalGroup(this.child, 'SIGKILL'); }
}
