import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import type { Profile } from '../instance/config/schema.js';
import type { BrainEvent } from '../core/types.js';
import { grokArgv, childEnv } from './argv.js';
import { exitReason } from './claude.js';
import { BrainExited, PermissionBook, permissionPreview, waitExit, type Brain, type BrainOptions, type BrainSession } from './brain.js';

type Msg = Record<string, any>;

/**
 * One long-lived `grok agent stdio` child (Grok Build) per session key, driven over ACP
 * (Agent Client Protocol, JSON-RPC 2.0 on stdio). Measured 2026-09-15 against grok 1.0.13 / 1.0.30:
 * `initialize` -> `session/new` (the agent mints the id) or `session/load` (resume, capability
 * `loadSession`) -> `session/prompt` per turn. Text arrives as `session/update` notifications
 * (`agent_message_chunk`, `tool_call`); permission prompts as `session/request_permission` requests
 * the client answers with an option id. `--always-approve` on argv is the bypass stance.
 */
export class GrokBrain extends EventEmitter implements Brain {
  private child?: ChildProcessWithoutNullStreams;
  private lines = new EventEmitter();
  private exited = false;
  /** The tail of stderr, for the reason a child that died without answering gives. */
  private failure = '';
  private nextId = 1;
  private replies = new Map<number, { resolve: (v: Msg) => void; reject: (e: Error) => void }>();
  private permissions: PermissionBook;
  /** Pending permission id -> the JSON-RPC id and options grok offered. */
  private permissionRequests = new Map<string, { rpcId: unknown; allow?: string; deny?: string }>();
  private ready?: Promise<string>;
  lastUsedAt = Date.now();
  version = '';
  backendSessionId?: string;

  constructor(readonly profile: Profile, readonly session: BrainSession, private readonly opts: BrainOptions = {}) {
    super();
    this.permissions = new PermissionBook(opts.permissionTimeoutMs ?? 10 * 60_000, (id) => { if (this.answerPermission(id, false)) this.emit('permission-timeout', id); });
  }

  get alive(): boolean { return !!this.child && !this.exited; }

  start(): void {
    const [bin, ...args] = grokArgv(this.profile, this.opts.bin ?? 'grok');
    const child = spawn(bin, args, { cwd: this.profile.cwd, env: childEnv(this.opts.env), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const done = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.exited) return;
      this.exited = true;
      this.permissions.clear();
      for (const p of this.replies.values()) p.reject(new BrainExited('grok exited'));
      this.replies.clear();
      this.lines.emit('exit', { code, signal });
      this.emit('exit', { code, signal });
    };
    child.on('exit', done);
    // A spawn that never happened (no such binary, not executable) raises `error` and never `exit`;
    // without this the handshake waits forever and the chat's queue waits behind it.
    child.on('error', (err) => { this.failure = err.message; done(null, null); });
    // EPIPE from a write to a child that has gone is an error event on the daemon otherwise.
    child.stdin.on('error', () => {});
    // Kept, never logged as it arrives (it can carry message text); the tail is the reason given when
    // the child dies without an answer, as ClaudeBrain does.
    child.stderr.on('data', (b: Buffer) => { this.failure = (this.failure + b.toString('utf8')).slice(-400); });
    createInterface({ input: child.stdout }).on('line', (raw) => {
      let m: Msg;
      try { m = JSON.parse(raw); } catch { return; }
      this.dispatch(m);
    });
    this.ready = this.handshake();
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
    if (m.method === 'session/update') { this.lines.emit('update', m.params?.update ?? {}); return; }
    if (m.id !== undefined && m.method) {
      // A client-side request we did not advertise (fs, terminal). Refuse it cleanly.
      this.write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `unsupported: ${m.method}` } });
    }
  }

  private write(obj: unknown): void {
    this.child?.stdin.write(JSON.stringify(obj) + '\n');
  }

  private call(method: string, params: unknown): Promise<Msg> {
    if (!this.alive) return Promise.reject(new BrainExited('brain not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.replies.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** How many history updates the last session/load replayed (and this class dropped). */
  replayedUpdates = 0;

  /** initialize, then open or load the session. Resolves to the ACP session id. */
  private async handshake(): Promise<string> {
    const init = await this.call('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    if (typeof init.agentInfo?.version === 'string') this.version = init.agentInfo.version;
    const base = { cwd: this.profile.cwd, mcpServers: [] };
    if (this.session.started) {
      // ACP replays the whole conversation as session/update notifications before it answers
      // session/load. The chat already holds every one of those messages, so they are dropped on
      // purpose, and counted so the decision is visible. They must be drained here: an update still
      // arriving once a turn's listener is attached would be sent to the chat as a fresh answer.
      let replayed = 0;
      const drop = () => { replayed++; };
      this.lines.on('update', drop);
      try { await this.call('session/load', { ...base, sessionId: this.session.id }); }
      finally { this.lines.off('update', drop); this.replayedUpdates = replayed; }
      this.backendSessionId = this.session.id;
    } else {
      const s = await this.call('session/new', base);
      this.backendSessionId = String(s.sessionId);
    }
    return this.backendSessionId;
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
            const t = pendingText.trim();
            if (t && t !== lastFlushed) { lastFlushed = t; yield { kind: 'progress', text: t }; }
            pendingText = '';
          }
          continue;
        }
        if (item.__kind === 'permission') {
          const m: Msg = item.m;
          const options: Msg[] = Array.isArray(m.params?.options) ? m.params.options : [];
          const allow = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always');
          const deny = options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always');
          const tc: Msg = m.params?.toolCall ?? {};
          const id = String(tc.toolCallId ?? m.id);
          this.permissionRequests.set(id, { rpcId: m.id, allow: allow?.optionId, deny: deny?.optionId });
          this.permissions.add(id);
          const tool = String(tc._meta?.['x.ai/tool']?.name ?? tc.title ?? tc.kind ?? '?');
          yield { kind: 'permission', id, tool, ...permissionPreview(tc.rawInput ?? tc.title ?? '') };
          continue;
        }
        if (item.__kind === 'done') {
          this.lastUsedAt = Date.now();
          if (done instanceof Error) { yield { kind: 'result', text: '', isError: true, reason: this.exited ? exitReason(this.failure) : done.message }; return; }
          const stop = String((done as Msg)?.stopReason ?? 'end_turn');
          const text = pendingText.trim();
          if (stop === 'refusal' && !text) { yield { kind: 'result', text: '', isError: true, reason: 'refusal' }; return; }
          yield { kind: 'result', text, isError: false };
          return;
        }
      }
    } finally {
      this.lines.off('update', onUpdate);
      this.lines.off('permission', onPermission);
      this.lines.off('exit', onExit);
    }
  }

  answerPermission(id: string, allow: boolean): boolean {
    const full = this.permissions.take(id);
    if (!full) return false;
    const req = this.permissionRequests.get(full);
    this.permissionRequests.delete(full);
    if (!req) return false;
    const optionId = allow ? req.allow : req.deny;
    const outcome = optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
    this.write({ jsonrpc: '2.0', id: req.rpcId, result: { outcome } });
    return true;
  }

  get pendingPermissionCount(): number { return this.permissions.size; }
  hasPendingPermission(id: string): boolean { return this.permissions.has(id); }

  async stop(graceMs = 5000): Promise<void> {
    const c = this.child;
    if (!c || this.exited) return;
    c.stdin.end();
    if (await waitExit(this.lines, () => this.exited, graceMs)) return;
    c.kill('SIGTERM');
    if (await waitExit(this.lines, () => this.exited, graceMs)) return;
    c.kill('SIGKILL');
    await waitExit(this.lines, () => this.exited, graceMs);
  }

  kill(): void { this.child?.kill('SIGKILL'); }
}
