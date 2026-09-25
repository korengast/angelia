import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Profile } from '../instance/config/schema.js';
import type { BrainEvent } from '../core/types.js';
import { childEnv, versionAtLeast } from './argv.js';
import { BrainExited, PermissionBook, exitReason, permissionPreview, stopChild, type Brain, type BrainOptions, type BrainSession } from './brain.js';
import { CODEX_PROFILE, codexApproval, codexCacheDir, codexCacheEnv, codexConfigConflict, codexOverrides, codexSandboxNote, codexSandboxed } from './codex-config.js';
import { profilePermissions, readRecord } from '../capabilities/compile.js';
import { LOST_SESSION_LINE } from './transcripts.js';

type Msg = Record<string, any>;

/** The first Codex this was measured against (2026-09-25): its app-server protocol is still marked experimental. */
export const MIN_CODEX_VERSION = '0.157.0';

/** Thread items that are the agent doing something: text written before one is progress. */
const ACTIONS = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView', 'collabAgentToolCall']);

type Pending = { rpcId: unknown; kind: 'v2' | 'legacy' | 'grant'; grant?: unknown };

/**
 * What a request for more access asks for, in words: `permissions` of `item/permissions/requestApproval`
 * or `additionalPermissions` of a command approval (codex-cli 0.157.0, experimental API).
 */
export function describeGrant(g: Msg | null | undefined): string {
  if (!g) return '';
  const by: Record<string, string[]> = { write: [], read: [], deny: [] };
  const fs: Msg = g.fileSystem ?? {};
  const name = (x: Msg): string => x?.type === 'path' ? String(x.path) : x?.type === 'glob_pattern' ? String(x.pattern) : x?.type === 'special' ? `special ${JSON.stringify(x.value)}` : JSON.stringify(x);
  if (Array.isArray(fs.entries) && fs.entries.length) for (const e of fs.entries) (by[e.access] ??= []).push(name(e.path));
  else { for (const w of fs.write ?? []) by.write.push(String(w)); for (const r of fs.read ?? []) by.read.push(String(r)); }
  const parts = Object.entries(by).filter(([, v]) => v.length).map(([k, v]) => `${k === 'deny' ? 'no access' : `${k} access`} to ${[...new Set(v)].join(', ')}`);
  if (g.network?.enabled) parts.push('network');
  return parts.join('; ');
}

/**
 * One long-lived `codex app-server` child (JSON-RPC over stdio, one JSON object per line) per session
 * key. Measured 2026-09-25 against codex-cli 0.157.0: `initialize` + `initialized`, then
 * `thread/start` (Codex mints the id, so the row is renamed as for grok) or `thread/resume` (no
 * replay); one `turn/start` per turn, ended by `turn/completed`. Codex asks the client before a
 * command or an edit needs more than its sandbox gives (`item/commandExecution/requestApproval`,
 * `item/fileChange/requestApproval`, `item/permissions/requestApproval`); Angelia relays those to the
 * chat. A yes never lifts the sandbox, whose deny rules Codex will not escalate: it adds the access asked for. The sandbox itself, with the
 * profile's deny rules, comes from `codexOverrides` on argv. Records are split on `\n` only, as for
 * pi: Node's readline also splits on U+2028/U+2029, which JSON strings may hold raw.
 */
export class CodexBrain extends EventEmitter implements Brain {
  private child?: ChildProcessWithoutNullStreams;
  private lines = new EventEmitter();
  private exited = false;
  private failure = '';
  private nextId = 1;
  private replies = new Map<number, { resolve: (v: Msg) => void; reject: (e: Error) => void }>();
  private permissions: PermissionBook;
  /** Chat-facing permission id -> the JSON-RPC request waiting for the answer. */
  private pending = new Map<string, Pending>();
  /** What each file-change item is about to change, for the permission line (the request itself carries none). */
  private changes = new Map<string, string>();
  private notice: string | null = null;
  /** Why this profile must not start, found before the child was asked anything. */
  private refused?: string;
  /** MCP servers the last compile gave the profile: any other must be off in Codex's merged config. */
  private allowed: string[] = [];
  private ready?: Promise<string>;
  private turnId?: string;
  lastUsedAt = Date.now();
  version = '';
  backendSessionId?: string;

  /** How long Codex has to answer `initialize` after it is started. */
  static startTimeoutMs = 60_000;

  constructor(readonly profile: Profile, readonly session: BrainSession, private readonly opts: BrainOptions = {}) {
    super();
    this.permissions = new PermissionBook(opts.permissionTimeoutMs ?? 10 * 60_000, (id) => { if (this.answerPermission(id, false)) this.emit('permission-timeout', id); });
  }

  get alive(): boolean { return !!this.child && !this.exited; }

  start(): void {
    const perms = profilePermissions(this.profile.cwd);
    const sandboxed = codexSandboxed(this.profile);
    // The profile's own cache folder, writable to it alone (codexCacheDir), next to the API socket in the
    // state folder the daemon passes. Without one (a bare test) there is no cache: never the live instance by default.
    const cache = sandboxed && this.opts.apiSocket ? codexCacheDir(dirname(this.opts.apiSocket), this.opts.profileName ?? this.profile.cwd) : undefined;
    const writable = [...new Set([...this.profile.add_dirs, ...perms.dirs, ...(cache ? [cache] : [])])];
    this.allowed = readRecord(this.profile.cwd)?.mcpServers ?? [];
    let launch: ReturnType<typeof codexOverrides>;
    // The other profiles' caches next to this one's: denied, its own stays writable (the nearer entry wins).
    const deny = cache ? [...perms.deny, `Read(${dirname(cache)})`, `Edit(${dirname(cache)})`] : perms.deny;
    try { launch = codexOverrides(this.profile, { deny, writable, socket: this.opts.apiSocket }); }
    catch (e) { launch = { args: [], skipped: [], refuse: `your Codex config cannot be read (${(e as Error).message})` }; }
    this.refused = launch.refuse;
    if (launch.skipped.length) this.emit('log', `codex: rules the sandbox cannot hold as written are not passed to it: ${launch.skipped.join(', ')}`);
    let env = childEnv(this.opts.env);
    if (cache) {
      const caches = codexCacheEnv(cache);
      for (const d of Object.values(caches)) { try { mkdirSync(String(d), { recursive: true, mode: 0o700 }); } catch { /* the tool makes it */ } }
      env = { ...env, ...caches };
    }
    const child = spawn(this.opts.bin ?? 'codex', [...launch.args, 'app-server'], { cwd: this.profile.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const done = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.exited) return;
      this.exited = true;
      this.permissions.clear();
      for (const p of this.replies.values()) p.reject(new BrainExited('codex exited'));
      this.replies.clear();
      this.lines.emit('exit', { code, signal });
      this.emit('exit', { code, signal });
    };
    child.on('exit', done);
    child.on('error', (err) => { this.failure = err.message; done(null, null); });
    child.stdin.on('error', () => {});
    // Kept, never logged as it arrives; the tail is the reason given when the child dies unanswered.
    child.stderr.on('data', (b: Buffer) => { this.failure = (this.failure + b.toString('utf8')).slice(-400); });
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (s: string) => {
      buf += s;
      let i: number;
      while ((i = buf.indexOf('\n')) !== -1) {
        const raw = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        let m: Msg;
        try { m = JSON.parse(raw); } catch { continue; }
        if (m && typeof m === 'object') this.dispatch(m);
      }
    });
    this.ready = this.handshake(writable);
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
    if (m.id !== undefined && m.method) { this.request(m); return; }
    if (m.method) this.lines.emit('note', m);
  }

  /** A request from Codex. Approvals go to the chat through the current turn; the rest have no screen to show. */
  private request(m: Msg): void {
    switch (m.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
      case 'execCommandApproval':
      case 'applyPatchApproval':
        this.lines.emit('approval', m);
        return;
      // A request for more room than the sandbox gives (a folder, for this turn): the owner answers it
      // in the chat where Angelia asks at all; bypass and plan never widen the sandbox.
      case 'item/permissions/requestApproval':
        if (codexApproval(this.profile) === 'on-request') this.lines.emit('approval', m);
        else this.reply(m.id, { permissions: {}, scope: 'turn' });
        return;
      case 'item/tool/requestUserInput': this.reply(m.id, { answers: {} }); return;
      case 'mcpServer/elicitation/request': this.reply(m.id, { action: 'decline', content: null, _meta: null }); return;
      default: this.write({ id: m.id, error: { code: -32601, message: `unsupported: ${m.method}` } });
    }
  }

  private write(obj: unknown): void {
    this.child?.stdin.write(JSON.stringify(obj) + '\n');
  }

  private reply(id: unknown, result: unknown): void { this.write({ id, result }); }

  private call(method: string, params: unknown): Promise<Msg> {
    if (!this.alive) return Promise.reject(new BrainExited('brain not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.replies.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  /** initialize, then open or resume the thread. Resolves to Codex's thread id. */
  private async handshake(writable: string[]): Promise<string> {
    // A Codex that never answers (measured 2026-09-25: a Homebrew build macOS kept frozen at its first
    // loading step) would leave the chat on "typing" forever: after this long the turn fails with a reason.
    const init = await Promise.race([
      this.call('initialize', { clientInfo: { name: 'angelia', title: 'Angelia', version: '0' }, capabilities: { experimentalApi: true } }),
      new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error(`codex did not answer within ${Math.round(CodexBrain.startTimeoutMs / 1000)} s of starting; check that \`codex --version\` runs in a terminal (macOS may be holding a newly installed binary)`)), CodexBrain.startTimeoutMs); t.unref?.(); }),
    ]);
    this.version = /\/(\d+\.\d+\.\d+)/.exec(String(init.userAgent ?? ''))?.[1] ?? '';
    if (this.version && !versionAtLeast(this.version, MIN_CODEX_VERSION)) throw new Error(`version: codex ${this.version} < ${MIN_CODEX_VERSION}; update codex`);
    this.write({ method: 'initialized' });
    if (this.refused) throw new Error(`refused: ${this.refused}`);
    // What Codex merged from every config file, in whatever TOML form: nothing may loosen the profile.
    if (codexSandboxed(this.profile)) {
      const conflict = codexConfigConflict(await this.call('config/read', { includeLayers: true, cwd: this.profile.cwd }), this.allowed);
      if (conflict) throw new Error(`refused: ${conflict}`);
    }
    // Without a model of the profile's own, the one Codex marks as default for this account: the
    // model in ~/.codex/config.toml may be one the account refuses (measured: a ChatGPT login refused
    // an older default with 400).
    const model = this.profile.model ?? (await this.call('model/list', {}).then((r) => (r.data ?? []).find((x: Msg) => x.isDefault)?.id as string | undefined, () => undefined));
    const params = {
      cwd: this.profile.cwd,
      ...(model ? { model } : {}),
      approvalPolicy: codexApproval(this.profile),
      // Pinned: a Codex config may route approvals to a Codex model reviewer instead of the owner.
      approvalsReviewer: 'user',
      sandbox: codexSandboxed(this.profile) ? null : 'danger-full-access',
      developerInstructions: [this.opts.system, codexSandboxNote(this.profile, writable, this.opts.profileName)].filter(Boolean).join('\n\n'),
    };
    if (this.session.started) {
      try {
        return (this.backendSessionId = this.checked(await this.call('thread/resume', { threadId: this.session.id, ...params }), this.session.id));
      } catch (e) {
        const msg = (e as Error).message;
        // Only a thread Codex no longer has starts fresh (and the chat hears it once, as for Claude);
        // a busy one, or a refusal, is an error: a fresh thread would hide the old one from /resume.
        if (msg.startsWith('refused:') || !/no rollout|not found|unknown thread|does not exist/i.test(msg)) throw e;
        this.emit('log', `codex thread ${this.session.id.slice(0, 8)} could not be resumed (${msg}); starting fresh`);
        this.notice = LOST_SESSION_LINE;
      }
    }
    return (this.backendSessionId = this.checked(await this.call('thread/start', params)));
  }

  /** The thread id, once Codex's answer shows the sandbox and reviewer Angelia asked for. */
  private checked(r: Msg, fallback?: string): string {
    const profile = r.activePermissionProfile?.id;
    const sandbox = r.sandbox?.type;
    if (codexSandboxed(this.profile) && (profile !== CODEX_PROFILE || sandbox === 'dangerFullAccess')) throw new Error(`refused: Codex applied the permission profile ${profile ?? '(none)'} with sandbox ${sandbox ?? '(none)'}, not Angelia's`);
    if (r.approvalsReviewer !== undefined && r.approvalsReviewer !== 'user') throw new Error(`refused: Codex routes approvals to ${r.approvalsReviewer}, not the owner`);
    return String(r.thread?.id ?? fallback);
  }

  async *turn(text: string): AsyncGenerator<BrainEvent> {
    if (!this.alive || !this.ready) throw new BrainExited('brain not running');
    this.lastUsedAt = Date.now();
    let threadId: string;
    try { threadId = await this.ready; }
    catch (e) {
      const reason = this.exited ? exitReason(this.failure) : String((e as Error).message);
      // A child that cannot serve (too old, a thread it cannot open) is ended, not kept warm.
      if (this.alive) this.kill();
      yield { kind: 'result', text: '', isError: true, reason };
      return;
    }
    if (this.notice) { yield { kind: 'notice', text: this.notice }; this.notice = null; }

    const queue: Msg[] = [];
    let wake: (() => void) | null = null;
    const push = (m: Msg) => { queue.push(m); wake?.(); };
    const onNote = (m: Msg) => push(m);
    const onApproval = (m: Msg) => push({ __approval: m });
    const onExit = () => push({ __exit: true });
    this.lines.on('note', onNote);
    this.lines.on('approval', onApproval);
    this.lines.on('exit', onExit);
    let started: Msg | Error | undefined;
    const compact = /^\/compact(?:@\w+)?\s*$/.test(text.trim());
    const req = compact ? this.call('thread/compact/start', { threadId }) : this.call('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], ...(this.profile.effort ? { effort: this.profile.effort } : {}) });
    // The turn id is taken the moment the reply is read, so a stale completion queued behind it is not ours.
    req.then((r) => { started = r; if (r?.turn?.id) this.turnId = r.turn.id; push({ __started: true }); }, (e: Error) => { started = e; push({ __started: true }); });

    let pendingText = '';
    let lastProgress = '';
    try {
      while (true) {
        if (!queue.length) await new Promise<void>((r) => (wake = r));
        wake = null;
        const m = queue.shift()!;
        if (m.__exit) { yield { kind: 'result', text: '', isError: true, reason: exitReason(this.failure) }; return; }
        if (m.__started) {
          if (started instanceof Error) { yield { kind: 'result', text: '', isError: true, reason: started.message }; return; }
          continue;
        }
        if (m.__approval) {
          const a: Msg = m.__approval;
          const p: Msg = a.params ?? {};
          const id = randomUUID();
          const legacy = a.method === 'execCommandApproval' || a.method === 'applyPatchApproval';
          const grant = a.method === 'item/permissions/requestApproval';
          this.pending.set(id, { rpcId: a.id, kind: grant ? 'grant' : legacy ? 'legacy' : 'v2', grant: grant ? p.permissions : undefined });
          this.permissions.add(id);
          if (grant) {
            // Measured on 0.157.0: the sandbox and its deny rules stay; a yes adds this access for the turn.
            yield { kind: 'permission', id, tool: 'more access, this turn', ...permissionPreview(`${describeGrant(p.permissions) || 'nothing named'}${p.reason ? ` (${p.reason})` : ''}. Or add the folder to add_dirs instead.`) };
            continue;
          }
          const edit = a.method.includes('ileChange') || a.method === 'applyPatchApproval';
          const what = edit ? (this.changes.get(String(p.itemId)) ?? 'a file change') : String(Array.isArray(p.command) ? p.command.join(' ') : p.command ?? '');
          // A yes does not lift the sandbox (its deny rules cannot be escalated, measured on 0.157.0): the
          // line names the access the command asks for on top, if any, and the lasting way.
          const more = describeGrant(p.additionalPermissions);
          const why = [more && `asks ${more}`, p.reason, p.grantRoot ? `write access to ${p.grantRoot}` : ''].filter(Boolean).join('; ');
          yield { kind: 'permission', id, tool: edit ? 'edit' : 'command', ...permissionPreview(`${what}${why ? ` (${why})` : ''}. Or add the folder to add_dirs instead.`) };
          continue;
        }
        const params: Msg = m.params ?? {};
        if (params.threadId && params.threadId !== threadId) continue;
        if (m.method === 'item/started' && params.item) {
          const it: Msg = params.item;
          // Whole: permissionPreview cuts a long request and says how much, a quiet cut here could hide the harm.
          if (it.type === 'fileChange' && Array.isArray(it.changes)) this.changes.set(String(it.id), it.changes.map((c: Msg) => `${c.path}: ${String(c.diff ?? '')}`).join('\n'));
          if (ACTIONS.has(it.type) && pendingText && pendingText !== lastProgress) { lastProgress = pendingText; yield { kind: 'progress', text: pendingText }; pendingText = ''; }
          else if (ACTIONS.has(it.type)) pendingText = '';
          continue;
        }
        if (m.method === 'item/completed' && params.item?.type === 'agentMessage') {
          const said = String(params.item.text ?? '').trim();
          if (pendingText && said && pendingText !== lastProgress) { lastProgress = pendingText; yield { kind: 'progress', text: pendingText }; }
          if (said) pendingText = said;
          continue;
        }
        // The turn this request started (a compaction runs as a turn too): a late event of an earlier one is not ours.
        if (m.method === 'turn/started' && !this.turnId) { this.turnId = params.turn?.id; continue; }
        if (m.method === 'serverRequest/resolved') {
          // Codex settled a request itself (the turn ended): nothing is waiting for the chat's answer any more.
          for (const [pid, pend] of this.pending) if (pend.rpcId === params.requestId) { this.pending.delete(pid); this.permissions.take(pid); }
          continue;
        }
        if (m.method === 'turn/completed') {
          // Before this turn's id is known, a completion can only be a late one of an earlier turn.
          if (!this.turnId || (params.turn?.id && params.turn.id !== this.turnId)) continue;
          this.lastUsedAt = Date.now();
          const turn: Msg = params.turn ?? {};
          // The message as text too, so a usage limit reads as one (with the /model hint), not as "something broke".
          if (turn.status === 'failed') { const why = String(turn.error?.message ?? 'turn failed'); yield { kind: 'result', text: why, isError: true, reason: why }; return; }
          if (turn.status === 'interrupted') { yield { kind: 'result', text: pendingText, isError: !pendingText, reason: 'interrupted' }; return; }
          yield { kind: 'result', text: compact && !pendingText ? 'Compacted.' : pendingText, isError: false };
          return;
        }
      }
    } finally {
      this.turnId = undefined;
      this.changes.clear();
      this.lines.off('note', onNote);
      this.lines.off('approval', onApproval);
      this.lines.off('exit', onExit);
    }
  }

  answerPermission(id: string, allow: boolean): boolean {
    const full = this.permissions.take(id);
    if (!full) return false;
    const p = this.pending.get(full);
    this.pending.delete(full);
    if (!p) return false;
    if (p.kind === 'grant') { this.reply(p.rpcId, { permissions: allow ? p.grant ?? {} : {}, scope: 'turn' }); return true; }
    const decision = p.kind === 'legacy' ? (allow ? 'approved' : { denied: { rejection: 'Denied in the chat' } }) : (allow ? 'accept' : 'decline');
    this.reply(p.rpcId, { decision });
    return true;
  }

  get pendingPermissionCount(): number { return this.permissions.size; }
  hasPendingPermission(id: string): boolean { return this.permissions.has(id); }

  async stop(graceMs = 5000): Promise<void> {
    if (this.child && !this.exited) await stopChild(this.child, this.lines, () => this.exited, graceMs);
  }

  kill(): void { this.child?.kill('SIGKILL'); }
}
