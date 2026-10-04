import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Profile } from '../instance/config/schema.js';
import type { BrainEvent } from '../core/types.js';
import { piArgv, childEnv, versionAtLeast } from './argv.js';
import { profilePermissions } from '../capabilities/compile.js';
import { BrainExited, PermissionBook, exitReason, jsonLine, onJsonLines, permissionPreview, stopChild, type Brain, type BrainOptions, type BrainSession } from './brain.js';
import { PERMISSION_TITLE, type PiPolicy } from './pi-gate.js';
import { LOST_SESSION_LINE } from './transcripts.js';
import { tmuxSocketPath } from './tmux.js';
import { cacheEnv, profileCacheDir } from './cache.js';

type Msg = Record<string, any>;

/** The extension UI methods that wait for an answer (pi rpc.md); the rest are fire-and-forget. */
const DIALOGS = ['select', 'confirm', 'input', 'editor'];

/** The gate pi loads with `-e`: the compiled file next to this one, or the source under tsx (tests). */
export function gatePath(): string {
  const js = fileURLToPath(new URL('./pi-gate.js', import.meta.url));
  return existsSync(js) ? js : fileURLToPath(new URL('./pi-gate.ts', import.meta.url));
}

/** pi's shell runs in macOS's sandbox unless the profile says `sandbox: false`. */
export const piSandboxed = (p: Profile): boolean => p.sandbox !== false;

/** The gate's policy: the mode, and from the profile's settings the deny rules (the launch guard has
 *  just checked the compiled ones) and extra folders (compile writes `_common/` and directory
 *  capabilities as additionalDirectories), the owner's settings.local.json merged in. With the
 *  sandbox, Angelia's tmux server is closed to commands too: other profiles' agents run there. */
export function piPolicy(p: Profile, cache?: string): PiPolicy {
  const s = profilePermissions(p.cwd);
  const sandbox = piSandboxed(p);
  return { mode: p.permission_mode as PiPolicy['mode'], cwd: p.cwd, dirs: [...new Set([...p.add_dirs, ...s.dirs])], deny: s.deny, sandbox, ...(sandbox ? { sockets: [tmuxSocketPath()] } : {}), ...(cache ? { cache } : {}) };
}

/** What the agent is told about its shell, after Angelia's self prompt: a refusal is the rules, not a
 *  fault to work around (the first probe's model reported a denied command as done). */
export function piSandboxNote(p: Profile, writable: string[] = [], name = '<profile>', cache = false): string {
  if (p.permission_mode === 'plan') return 'You are in plan mode: you read and search, you run no commands and change no files.';
  if (!piSandboxed(p)) return 'Your shell commands run without a sandbox (sandbox: false in the routing table); the profile\'s deny rules hold only your file tools.';
  const where = `${[p.cwd, ...writable].join(', ')}${cache ? ', your cache folder' : ''} and temp`;
  const unasked = p.permission_mode === 'bypassPermissions'
    ? `Nothing asks the owner, so your commands and file edits may write only in: ${where}.`
    : p.permission_mode === 'acceptEdits'
      ? 'Commands wait for the owner\'s yes in the chat, except plain read-only ones (ls, cat and the like); a command the owner approved may also write outside your folders.'
      : 'Every command waits for the owner\'s yes in the chat; one the owner approved may also write outside your folders.';
  return [
    `Your shell commands run inside a macOS sandbox set by Angelia. ${unasked}`,
    'Paths this profile may not read or change (credentials, Angelia\'s own state, other profiles\' folders) fail with "Operation not permitted", for every program you start too, so tools that keep their login there (gh, ssh keys, cloud CLIs) cannot use it.',
    `When the sandbox stops something, say so plainly and do not try to get around it. For a folder you need to write in, suggest the lasting fix: add it to add_dirs for this profile in routing.yaml, then \`angelia compile ${name} --write\` and a restart.`,
  ].join('\n');
}

/** The first pi with `agent_settled` (pi CHANGELOG, 0.80.4): on an older one no turn would ever end. */
export const MIN_PI_VERSION = '0.80.4';

/** `pi --version` per binary, asked once per daemon run and without blocking it. */
const versions = new Map<string, Promise<string>>();
function piVersion(bin: string, env: NodeJS.ProcessEnv): Promise<string> {
  let v = versions.get(bin);
  if (!v) {
    v = new Promise((resolve) => execFile(bin, ['--version'], { env, timeout: 15_000 }, (_e, out) => resolve(/\d+\.\d+\.\d+/.exec(String(out ?? ''))?.[0] ?? '')));
    versions.set(bin, v);
  }
  return v;
}

/** What pi prints on stderr when `--session-id` names a session it has no file for in this folder. */
const NO_SESSION = /No project session found with id/;

/** pi's tool input in the shape describeInput already knows (`file_path`, `old_string`, …). */
function previewInput(input: Msg): unknown {
  if (typeof input.path !== 'string') return input;
  if (typeof input.content === 'string') return { file_path: input.path, content: input.content };
  if (Array.isArray(input.edits) && input.edits.length === 1) return { file_path: input.path, old_string: input.edits[0]?.oldText, new_string: input.edits[0]?.newText };
  return input;
}

/**
 * One long-lived `pi --mode rpc` child per session key. Measured 2026-09-25 against pi 0.86.1:
 * `--session-id` takes the id Angelia mints, creating the session or resuming it without a replay;
 * one `{type:"prompt"}` line per turn; `agent_settled` ends it. pi has no permission prompt of its
 * own: the gate extension (pi-gate.ts) asks through `extension_ui_request` confirm dialogs, answered
 * with `extension_ui_response`. Records are split on `\n` only: pi's RPC docs warn that Node's
 * readline also splits on U+2028/U+2029, which are valid inside a JSON string.
 */
export class PiBrain extends EventEmitter implements Brain {
  private child?: ChildProcessWithoutNullStreams;
  private lines = new EventEmitter();
  private exited = false;
  private failure = '';
  /** pi said the session to resume was not there; `lostSeen` makes that a one-time finding. */
  private lost = false;
  private lostSeen = false;
  private versionCheck?: Promise<string>;
  /** A turn is reading the lines; outside one, a dialog from some extension is dismissed at once. */
  private inTurn = false;
  private nextId = 1;
  private permissions: PermissionBook;
  lastUsedAt = Date.now();
  version = '';
  /** pi accepts the id Angelia mints, so the backend id is the session id. */
  backendSessionId?: string;

  /** How long after pi accepted a prompt without starting a run Angelia asks whether one is coming.
   *  An extension command (`/llama` ships with pi 0.86.1) or an input handler takes the prompt and
   *  never starts one, so no `agent_settled` ever arrives (agent-session.js prompt()). */
  static noRunCheckMs = 1000;

  constructor(readonly profile: Profile, readonly session: BrainSession, private readonly opts: BrainOptions = {}) {
    super();
    this.permissions = new PermissionBook(opts.permissionTimeoutMs ?? 10 * 60_000, (id) => { if (this.answerPermission(id, false)) this.emit('permission-timeout', id); });
  }

  get alive(): boolean { return !!this.child && !this.exited; }

  start(): void {
    // The profile's own cache folder, next to the API socket in the state folder the daemon passes.
    // Without one (a bare test) there is none: never the live instance by default.
    const cache = piSandboxed(this.profile) && this.opts.apiSocket ? profileCacheDir(dirname(this.opts.apiSocket), 'pi', this.opts.profileName ?? this.profile.cwd) : undefined;
    const policy = piPolicy(this.profile, cache);
    const system = [this.opts.system, piSandboxNote(this.profile, policy.dirs, this.opts.profileName, !!cache)].filter(Boolean).join('\n\n');
    const [bin, ...args] = piArgv(this.profile, this.session, this.opts.bin ?? 'pi', system, gatePath());
    const env: NodeJS.ProcessEnv = { ...childEnv(this.opts.env), ANGELIA_PI_POLICY: JSON.stringify(policy), ...(cache ? cacheEnv(cache) : {}) };
    // The ssh agent would sign as the owner for a sandboxed command that cannot read ~/.ssh.
    if (policy.sandbox) delete env.SSH_AUTH_SOCK;
    this.versionCheck = piVersion(bin, env).then((v) => (this.version = v));
    const child = spawn(bin, args, { cwd: this.profile.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.backendSessionId = this.session.id;
    const done = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.exited) return;
      this.exited = true;
      this.permissions.clear();
      this.lines.emit('exit', { code, signal });
      this.emit('exit', { code, signal });
    };
    child.on('exit', done);
    child.on('error', (err) => { this.failure = err.message; done(null, null); });
    child.stdin.on('error', () => {});
    // Kept, never logged as it arrives; the tail is the reason given when the child dies unanswered.
    child.stderr.on('data', (b: Buffer) => {
      this.failure = (this.failure + b.toString('utf8')).slice(-400);
      // Tested on the kept tail, so a line split across two chunks is still seen.
      if (this.session.started && !this.lostSeen && NO_SESSION.test(this.failure)) this.lost = this.lostSeen = true;
    });
    onJsonLines(child.stdout, (m: Msg) => {
      if (!this.inTurn && m.type === 'extension_ui_request' && DIALOGS.includes(m.method)) { this.write({ type: 'extension_ui_response', id: m.id, cancelled: true }); return; }
      this.lines.emit('line', m);
    });
  }

  private write(obj: unknown): void {
    this.child?.stdin.write(jsonLine(obj));
  }

  async *turn(text: string): AsyncGenerator<BrainEvent> {
    if (!this.alive) throw new BrainExited('brain not running');
    this.lastUsedAt = Date.now();
    const version = await this.versionCheck;
    // The child may have died while the version was asked (no such binary): its exit is already past.
    if (!this.alive) { yield { kind: 'result', text: '', isError: true, reason: exitReason(this.failure) }; return; }
    if (version && !versionAtLeast(version, MIN_PI_VERSION)) { yield { kind: 'result', text: '', isError: true, reason: `version: pi ${version} < ${MIN_PI_VERSION}; run pi update` }; return; }
    const queue: Msg[] = [];
    let wake: (() => void) | null = null;
    const push = (m: Msg) => { queue.push(m); wake?.(); };
    const onExit = () => push({ type: '__exit' });
    this.lines.on('line', push);
    this.lines.on('exit', onExit);
    const reqId = `turn-${this.nextId++}`;
    const stateId = `state-${reqId}`;
    this.inTurn = true;
    // pi's /compact is an RPC command, not a prompt: sent as a prompt it only reaches the model.
    const compact = /^\/compact(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (compact) this.write({ id: reqId, type: 'compact', ...(compact[1]?.trim() ? { customInstructions: compact[1].trim() } : {}) });
    else this.write({ id: reqId, type: 'prompt', message: text });
    let answer = '';
    let error = '';
    let lastProgress = '';
    let ran = false;
    let check: NodeJS.Timeout | undefined;
    const askState = () => { check = setTimeout(() => { if (!ran) this.write({ id: stateId, type: 'get_state' }); }, PiBrain.noRunCheckMs); };
    const notice = (): BrainEvent | undefined => {
      if (!this.lost) return undefined;
      this.lost = false;
      this.emit('log', `pi session ${this.session.id.slice(0, 8)} not found for ${this.profile.cwd}; pi started it fresh`);
      return { kind: 'notice', text: LOST_SESSION_LINE };
    };
    /** What an extension command said through notify: its only output when it starts no run. */
    const notes: string[] = [];
    try {
      while (true) {
        if (!queue.length) await new Promise<void>((r) => (wake = r));
        wake = null;
        const m = queue.shift()!;
        if (m.type === '__exit') { yield { kind: 'result', text: '', isError: true, reason: exitReason(this.failure) }; return; }
        if (m.type === 'response' && m.id === reqId) {
          // A compact pi declines ("Nothing to compact") is an answer, not a failure of the agent.
          if (m.success === false && compact) { yield { kind: 'result', text: `Not compacted: ${String(m.error ?? 'pi declined')}.`.replace(/\.\.$/, '.'), isError: false }; return; }
          if (m.success === false) { yield { kind: 'result', text: '', isError: true, reason: String(m.error ?? 'prompt refused') }; return; }
          if (compact) {
            const d = m.data ?? {};
            const n = (x: unknown) => (typeof x === 'number' ? Math.round(x).toLocaleString('en-US') : '?');
            this.lastUsedAt = Date.now();
            yield { kind: 'result', text: `Compacted: ${n(d.tokensBefore)} tokens to about ${n(d.estimatedTokensAfter)}.`, isError: false };
            return;
          }
          askState();
          continue;
        }
        if (m.type === 'agent_start') { ran = true; continue; }
        if (m.type === 'response' && m.id === stateId) {
          const idle = m.data?.isStreaming === false && !m.data?.isCompacting && !m.data?.pendingMessageCount;
          if (!ran && idle) {
            this.lastUsedAt = Date.now();
            const n = notice(); if (n) yield n;
            yield { kind: 'result', text: notes.join('\n').trim(), isError: false };
            return;
          }
          // Busy but no run seen yet (compaction, a queued message): look again rather than end the turn.
          if (!ran) askState();
          continue;
        }
        if (m.type === 'message_end' && m.message?.role === 'assistant') {
          const content: Msg[] = Array.isArray(m.message.content) ? m.message.content : [];
          const said = content.filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join('').trim();
          if (m.message.stopReason === 'error' || m.message.stopReason === 'aborted') { error = String(m.message.errorMessage ?? m.message.stopReason); continue; }
          error = '';
          if (content.some((c) => c.type === 'toolCall')) {
            // Text written before a tool call is progress, as with the other backends.
            if (said && said !== lastProgress) { lastProgress = said; yield { kind: 'progress', text: said }; }
            answer = '';
          } else answer = said;
          continue;
        }
        if (m.type === 'extension_ui_request') {
          const dialog = DIALOGS.includes(m.method);
          if (m.method === 'notify' && typeof m.message === 'string') notes.push(m.message);
          if (m.method === 'confirm' && String(m.title ?? '').startsWith(PERMISSION_TITLE)) {
            const id = String(m.id);
            const tool = String(m.title).slice(PERMISSION_TITLE.length).trim() || '?';
            let input: Msg = {};
            try { input = JSON.parse(String(m.message ?? '{}')); } catch { /* shown as empty */ }
            this.permissions.add(id);
            yield { kind: 'permission', id, tool, ...permissionPreview(previewInput(input)) };
          } else if (dialog) {
            // Another extension asking for a screen the chat does not have: dismissed, never left waiting.
            this.write({ type: 'extension_ui_response', id: m.id, cancelled: true });
          }
          continue;
        }
        if (m.type === 'agent_settled') {
          this.lastUsedAt = Date.now();
          const n = notice(); if (n) yield n;
          if (!answer && error) { yield { kind: 'result', text: '', isError: true, reason: error }; return; }
          yield { kind: 'result', text: answer, isError: false };
          return;
        }
      }
    } finally {
      clearTimeout(check);
      this.inTurn = false;
      this.lines.off('line', push);
      this.lines.off('exit', onExit);
    }
  }

  answerPermission(id: string, allow: boolean): boolean {
    const full = this.permissions.take(id);
    if (!full) return false;
    this.write({ type: 'extension_ui_response', id: full, confirmed: allow });
    return true;
  }

  get pendingPermissionCount(): number { return this.permissions.size; }
  hasPendingPermission(id: string): boolean { return this.permissions.has(id); }

  async stop(graceMs = 5000): Promise<void> {
    if (this.child && !this.exited) await stopChild(this.child, this.lines, () => this.exited, graceMs);
  }

  kill(): void { this.child?.kill('SIGKILL'); }
}
