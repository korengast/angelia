import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, rmSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readPlainText } from '../core/paths.js';
import type { Profile } from '../instance/config/schema.js';
import type { ToolRequest } from '../core/permission-rules.js';
import { matches, parseRule } from '../core/permission-rules.js';
import { agyArgv, agyModel } from './argv.js';
import type { BrainOptions, BrainSession } from './brain.js';
import { AcpBrain, type GateBlock, type GateDecision, type Msg } from './acp.js';
import { agyGeminiDir, cacheEnv, profileCacheDir } from './cache.js';
import { agyMcpServers, prepareAgyStart, type AcpMcpServer } from './agy-config.js';
import { agyMcpName, agyMcpNames, agyRequest } from './tool-request.js';
import { AGY_CLEARED, AGY_CONFIG_DEFAULT, agyGeminiInputs } from './agy-instructions.js';

export { agyMcpName };
import { SANDBOX_EXEC, decide, sandboxProfile, type PiPolicy } from './pi-gate.js';
import { piPolicy, piSandboxed } from './pi.js';

/** agy runs inside macOS's sandbox unless the profile says `sandbox: false` (as pi's shell does). */
export const agySandboxed = (p: Profile): boolean => piSandboxed(p);

/**
 * The gate's policy for an agy profile: pi's (piPolicy: the mode, cwd, the extra folders, the deny
 * rules of the last compile, the sandbox, Angelia's tmux socket, the cache folder), and this
 * session's own deny rules on top.
 */
export function agyPolicy(p: Profile, cache?: string, extraDeny: string[] = []): PiPolicy {
  const policy = piPolicy(p, cache);
  policy.deny = [...new Set([...policy.deny, ...extraDeny])];
  return policy;
}

/** What the chat hears when agy started a subagent Angelia could not reach. */
export const AGY_LOST_SUBAGENT_LINE = 'agy started a subagent that Angelia could not reach, so nothing it asks can be approved and it may stop without a result. Ask agy to do the work itself.';

/** The PTY agy's run_command needs (ADR 0017 A): without it every command fails "failed to create PTY". */
export const AGY_PTY = [{ path: '/dev/ptmx', match: 'literal' as const, write: true }, { path: '/dev/ttys', match: 'prefix' as const, write: true }];

/** Where agy keeps its Google sign-in in a --gemini-dir when it cannot write the keychain (measured
 *  2026-11-21, agy 1.5.14: a fresh dir with only this file signs in, keychain closed). */
export const AGY_TOKEN = join('antigravity-cli', 'antigravity-oauth-token');

/** The keychain's command-line door. agy's keyring library starts it for every keychain read; with it
 *  closed and ~/Library/Keychains closed by the floor, agy reads its sign-in from AGY_TOKEN, and no
 *  command it runs can list or read the owner's keychain items (Claude Code's, gh's), which trust it. */
export const SECURITY_BIN = '/usr/bin/security';

/** The owner's agy sign-in as agy's keyring library keeps it (service `gemini`, go-keyring's base64
 *  form), read by the daemon outside any sandbox; undefined when there is none. */
export function keychainAgyLogin(): string | undefined {
  const r = spawnSync(SECURITY_BIN, ['find-generic-password', '-s', 'gemini', '-w'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
  const raw = r.status === 0 ? r.stdout.trim() : '';
  return raw.startsWith('go-keyring-base64:') ? Buffer.from(raw.slice(18), 'base64').toString('utf8') : raw || undefined;
}

const refreshOf = (text: string | undefined): string | undefined => { try { return JSON.parse(text ?? '')?.token?.refresh_token; } catch { return undefined; } };

/**
 * Puts the owner's agy sign-in into the gemini dir as AGY_TOKEN, so the sandboxed agy never needs the
 * keychain (agy reads the same JSON from the file that it keeps in the keychain; measured 2026-11-21,
 * agy 1.5.14). Done by the daemon before each start, outside the agent's sandbox: written when the
 * file is missing or holds another sign-in (the owner signed in again); a file agy refreshed itself
 * is kept. True when the file is there afterwards.
 */
export function agySeedLogin(geminiDir: string, read: () => string | undefined = keychainAgyLogin): boolean {
  const dest = join(geminiDir, AGY_TOKEN);
  // The folder is the agent's to write in: a link planted at the folder would carry the owner's
  // sign-in, or the daemon's write, somewhere else; it is not followed (fails closed).
  if (isLink(dirname(dest))) return false;
  // A link, a named pipe or a folder planted at the file itself is removed, then the file is seeded
  // (review 3, L4): left there, it would keep the sign-in out for good. A folder with files in it stays,
  // and the seed fails.
  try {
    const st = lstatSync(dest);
    if (st.isDirectory()) rmdirSync(dest);
    else if (!st.isFile()) unlinkSync(dest);
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
  let have: string | undefined;
  // Non-blocking and not through a link: a pipe planted meanwhile cannot hold the daemon (review 3, M1).
  try { have = readPlainText(dest, { follow: false, max: 1 << 20 }); } catch { /* none yet */ }
  const login = read();
  const fresh = login && refreshOf(login);
  if (fresh && fresh !== refreshOf(have)) {
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    if (isLink(dirname(dest))) return false;
    const tmp = `${dest}.${randomBytes(8).toString('hex')}.tmp`;
    if (!createOnly(tmp, login, 0o600)) return false;
    // rename replaces a link, never writes through one; checked again so a link planted meanwhile is
    // refused, not replaced silently.
    if (isLink(dest)) { try { unlinkSync(tmp); } catch { /* gone */ } return false; }
    renameSync(tmp, dest);
    return true;
  }
  return !!have?.trim();
}

const isLink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** Creates a new file, never through a link and never over one that is there: false when the name is
 *  taken (a file or a link) or reached through a link. The daemon's writes into a folder the agent writes in. */
export function createOnly(path: string, text: string, mode: number): boolean {
  let fd: number;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode); } catch { return false; }
  try { writeSync(fd, text, 0); } finally { closeSync(fd); }
  return true;
}

/** Every process below `root`, whatever its process group or session: agy runs each command in a
 *  shell of its own on a PTY, a new session, which a kill of agy's group does not reach (red team
 *  round 2). Read from `ps` before anything is killed, while they are still below it. */
export function descendants(root: number, table = (): string => spawnSync('/bin/ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 }).stdout ?? ''): number[] {
  const kids = new Map<number, number[]>();
  for (const line of table().split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid > 0 && ppid > 0) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  }
  const out: number[] = [];
  for (const queue = [root]; queue.length;) for (const k of kids.get(queue.shift()!) ?? []) if (!out.includes(k)) { out.push(k); queue.push(k); }
  return out;
}

const killAll = (pids: number[]) => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } };

/**
 * The sandbox the whole agy process runs in (ADR 0017, Consequences): the deny rules, writes only in
 * cwd, the extra folders, its --gemini-dir, its cache and temp; the other profiles' gemini dirs and
 * caches closed; Angelia's tmux socket closed; nothing started outside the sandbox on its behalf
 * (`open`, Apple Events); the PTY open; the keychain closed (the floor's ~/Library/Keychains, and
 * SECURITY_BIN not started: agy signs in from AGY_TOKEN, agySeedLogin); in the gemini dir the files
 * that change later sessions (agyGeminiInputs) closed to writing, after it. `closeSiblings: false` for a gemini dir that is not one of
 * Angelia's (a test's or the live probe's scratch folder), whose neighbours are not other profiles'. The gemini dir is opened again last, so a floor rule over the
 * state folder cannot close agy's own conversations and login copy to itself.
 */
export function agySandboxProfile(policy: PiPolicy, geminiDir: string, home = homedir(), o: { closeSiblings?: boolean } = {}): string {
  const writable = [policy.cwd, ...policy.dirs, geminiDir, ...(policy.cache ? [policy.cache] : [])];
  return sandboxProfile(policy.deny, home, {
    writable, noLaunch: true, sockets: policy.sockets, closed: policy.closed, cache: policy.cache, own: o.closeSiblings === false ? [] : [geminiDir],
    open: [{ path: geminiDir, match: 'subpath', write: true }, ...AGY_PTY],
    last: agyGeminiInputs(geminiDir).map((f) => `Edit(${f})`), noExec: [SECURITY_BIN],
  }) + AGY_NO_FIFO;
}

/** No named pipe anywhere: one planted where the daemon reads (the sign-in, CLAUDE.md, GEMINI.md)
 *  would hold it (review 3, M1). The reads are non-blocking too; this closes the door as well.
 *  agy's own pipes are anonymous, not files (measured: live tests pass with it). */
export const AGY_NO_FIFO = '\n(deny file-write-create (vnode-type FIFO))\n';

/**
 * The id agy is set to: the model as named when agy lists it (or lists nothing); a name without an
 * effort (`/model gemini-3.8-flash`, from the catalog, which shows models without the suffix) takes
 * high, then medium, then the first effort agy lists for it. Undefined: agy has no such model.
 */
export function agyResolveModel(model: string, available: string[]): string | undefined {
  if (!available.length || available.includes(model)) return model;
  for (const level of ['high', 'medium']) if (available.includes(`${model}-${level}`)) return `${model}-${level}`;
  return available.find((id) => id.startsWith(`${model}-`) && /^(low|medium|high|xhigh)$/.test(id.slice(model.length + 1)));
}

/** The ACP mode a profile's permission_mode selects. Never `auto`: it runs commands unasked. Plan and
 *  bypass are held by the gate, not by agy (agy's plan is advice to the model only). */
export function agyMode(p: Profile): 'default' | 'accept-edits' | 'plan' {
  return p.permission_mode === 'acceptEdits' ? 'accept-edits' : p.permission_mode === 'plan' ? 'plan' : 'default';
}

/** The deny rule (`mcp__server`, `mcp__server__*`, `mcp__server__tool`) that refuses an MCP tool, if any. */
export function mcpDenied(deny: string[], tool: string): string | undefined {
  return deny.find((text) => {
    if (!text.startsWith('mcp__')) return false;
    const r = parseRule(text);
    return typeof r !== 'string' && r.kind === 'mcp' && (r.exact ? tool === r.prefix : tool.startsWith(r.prefix));
  });
}

/** decide()'s refusal, shortened to its first sentence: the rule, for the refused line. */
const ruleOf = (reason: string) => reason.split(/(?<=\.)\s/)[0].replace(/\.$/, '');

/**
 * What Angelia does with one agy permission request (ADR 0017 gate map), from pi's decide():
 * read_file -> read, write_file/edit_file -> write/edit, run_command -> bash, an MCP tool under its
 * mcp__ name (refused by a matching deny rule); any other tool is asked, or blocked in plan mode.
 * Bypass allows all but what the rules deny.
 */
export function agyGate(policy: PiPolicy, tc: Msg, servers: string[] = [], home = homedir()): GateDecision | GateBlock {
  const name = String(tc.name ?? '');
  const raw: Msg = tc.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : {};
  const path = typeof raw.Path === 'string' ? raw.Path : typeof raw.TargetFile === 'string' ? raw.TargetFile : '';
  let tool: string, input: Record<string, unknown>;
  if (name === 'read_file') { tool = 'read'; input = { path }; }
  else if (name === 'write_file' || name === 'edit_file') {
    // An empty path would be read as cwd; a write with no path is not one the gate can place.
    if (!path) return policy.mode === 'plan' ? { action: 'block', reason: `Angelia's profile rules deny ${name} in plan mode` } : 'ask';
    tool = name === 'write_file' ? 'write' : 'edit'; input = { path };
  }
  else if (name === 'run_command') {
    tool = 'bash'; input = { command: String(raw.CommandLine ?? '') };
    // A Bash(...) deny rule (Claude Code's own kind, the owner's settings.json): the sandbox holds paths,
    // not commands, so the command is matched here, every part of it, without regard to case.
    const rule = policy.deny.find((text) => {
      if (!text.startsWith('Bash')) return false;
      const r = parseRule(text);
      return typeof r !== 'string' && (r.kind === 'bash' || (r.kind === 'tool' && r.tools.includes('Bash'))) && matches(r, { tool: 'Bash', input }, { cwd: policy.cwd, home }, false);
    });
    if (rule) return { action: 'block', reason: `Angelia's profile rules deny this command (rule ${rule})` };
  }
  else {
    // A request the gate cannot name (no tool name, or call_mcp_tool without its server and tool) could
    // be one a Bash(...) or mcp__ rule denies: it is never allowed unasked.
    if (!name || (name === 'call_mcp_tool' && (typeof raw.ServerName !== 'string' || typeof raw.ToolName !== 'string'))) {
      const what = name || 'a tool with no name';
      if (policy.mode === 'bypassPermissions') return { action: 'block', reason: `Angelia cannot tell which tool ${what} is, so bypass does not allow it` };
      return policy.mode === 'plan' ? { action: 'block', reason: `Angelia's profile rules deny ${what} in plan mode` } : 'ask';
    }
    const mcp = name === 'call_mcp_tool'
      ? `mcp__${raw.ServerName}__${raw.ToolName}` : agyMcpName(name, servers);
    if (mcp) {
      // `mcp_a_b_c` with servers a and a_b may be either's tool: a rule for any reading refuses it.
      for (const m of name === 'call_mcp_tool' ? [mcp] : [mcp, ...agyMcpNames(name, servers)]) {
        const rule = mcpDenied(policy.deny, m);
        if (rule) return { action: 'block', reason: `Angelia's profile rules deny ${m} (rule ${rule})` };
      }
    }
    // decide() asks for a tool it does not know (blocks it in plan mode); the prefix keeps an agy tool
    // from ever being read as one of pi's own.
    tool = mcp ?? `agy:${name || String(tc.kind ?? '?')}`; input = {};
  }
  const v = decide(policy, tool, input, home, 'agy');
  if (v.action === 'block') return { action: 'block', reason: ruleOf(v.reason) };
  return v.action;
}

/**
 * One long-lived `agy acp` child (Antigravity CLI) per session key, over ACP (acp.ts). Measured
 * 2026-11-21 against agy 1.5.14 (ADR 0017): `initialize` advertises `sessionCapabilities.resume`;
 * `session/new` mints the id and lists `models.availableModels`; `session/set_model` picks one and
 * `session/set_mode` the mode; `session/resume` reopens a session without replaying it (session/load
 * replays, like grok). Text arrives as `agent_message_chunk`; thoughts, usage and config updates are
 * ignored. Every request agy asks is answered by Angelia's gate (agyGate) or the chat, never by agy;
 * agy ends the turn silent after a reject: `emptyAnswer` says so. The whole process runs under
 * sandbox-exec (agySandboxProfile) unless the profile says `sandbox: false`, and agy may speak between
 * turns (a background command done): that reaches the chat as an unasked answer.
 */
export class AgyBrain extends AcpBrain {
  static override startTimeoutMs = 60_000;
  /** Where the owner's sign-in is read before a sandboxed start (a test gives its own). */
  static readLogin: () => string | undefined = keychainAgyLogin;
  protected readonly cliName = 'agy';
  protected override readonly wakesBetweenTurns = true;
  /** agy's own folder for this profile: settings, MCP config, conversations. */
  readonly geminiDir: string;
  /** The gate's policy, made at start. */
  policy?: PiPolicy;
  /** The sandbox profile agy runs in, made at start; undefined with `sandbox: false`. */
  sandbox?: string;
  private cache?: string;
  /** The models session/new or session/resume listed, for the check before set_model. */
  availableModels: string[] = [];
  /** The instance's state folder: the launch guard there holds what the last compile gave agy. */
  private readonly stateDir: string;

  constructor(profile: Profile, session: BrainSession, opts: BrainOptions = {}) {
    super(profile, session, opts);
    const state = opts.stateDir ?? (opts.apiSocket ? dirname(opts.apiSocket) : join(homedir(), '.angelia'));
    this.stateDir = state;
    this.geminiDir = opts.geminiDir ?? agyGeminiDir(state, opts.profileName ?? profile.cwd);
    // A subagent's own tool calls (an attached session's updates): its invoke_subagent is watched too.
    this.lines.on('other-update', (u: Msg) => { if (u?.sessionUpdate === 'tool_call') this.onToolCall(u); });
  }

  /** The model this session is set to. */
  get model(): string { return agyModel(this.profile); }

  protected argv(): string[] {
    const line = agyArgv(this.profile, this.geminiDir, this.opts.bin ?? 'agy');
    return this.sandbox ? [SANDBOX_EXEC, '-p', this.sandbox, ...line] : line;
  }

  protected override beforeSpawn(): void {
    // The cache next to the API socket in the state folder the daemon passes; a bare test has none.
    const sandboxed = agySandboxed(this.profile);
    this.cache = sandboxed && this.opts.apiSocket ? profileCacheDir(dirname(this.opts.apiSocket), 'agy', this.opts.profileName ?? this.profile.cwd) : undefined;
    this.policy = agyPolicy(this.profile, this.cache, this.opts.deny ?? []);
    if (sandboxed && this.opts.stateOpen) this.policy.closed = { dir: this.stateDir, open: [...this.opts.stateOpen, this.policy.cwd, ...this.policy.dirs, this.geminiDir, ...(this.cache ? [this.cache] : [])] };
    this.sandbox = sandboxed ? agySandboxProfile(this.policy, this.geminiDir, homedir(), { closeSiblings: !this.opts.geminiDir }) : undefined;
    if (sandboxed) {
      // The folders above the closed files cannot be made from inside, and agy makes an empty MCP
      // config on its first start if there is none (compile makes it for a profile's own dir).
      for (const d of ['config', 'antigravity-cli']) mkdirSync(join(this.geminiDir, d), { recursive: true, mode: 0o700 });
      // What agy writes itself where nothing can close it (its shell helpers): made fresh each start.
      for (const d of AGY_CLEARED) rmSync(join(this.geminiDir, d), { recursive: true, force: true });
      const mcp = join(this.geminiDir, 'config', 'mcp_config.json');
      // Created only where nothing is, a dangling link included (existsSync follows one).
      createOnly(mcp, '', 0o600);
      const conf = join(this.geminiDir, 'config', 'config.json');
      createOnly(conf, AGY_CONFIG_DEFAULT, 0o600);
      if (!agySeedLogin(this.geminiDir, AgyBrain.readLogin)) this.emit('log', 'agy: no sign-in copied into its folder; inside the sandbox agy cannot reach the keychain, so it will say it is not signed in');
    }
    this.writeInstructions();
  }

  /** agy's group, then every process that was below it (descendants), its commands' sessions too. */
  override kill(): void {
    const below = this.childPid ? descendants(this.childPid) : [];
    super.kill();
    killAll(below);
  }

  protected override spawnEnv(): NodeJS.ProcessEnv {
    const env = super.spawnEnv();
    if (!this.sandbox) return env;
    // The ssh agent would sign as the owner for a sandboxed command that cannot read ~/.ssh.
    delete env.SSH_AUTH_SOCK;
    return { ...env, ANGELIA_SANDBOX: 'agy', ...(this.cache ? cacheEnv(this.cache) : {}) };
  }

  override start(): void {
    // Without sandbox-exec here a sandboxed profile would spawn nothing useful: say why at once.
    if (agySandboxed(this.profile) && (process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC))) {
      this.emit('log', `agy: no ${SANDBOX_EXEC} on this system; set sandbox: false for this profile to run agy without it`);
    }
    super.start();
  }

  /** Refuse what agy would load that Angelia did not give it, then write agy's copy of CLAUDE.md
   *  (GEMINI.md, `@` imports expanded) before agy starts and reads it (agy-config.ts). */
  protected writeInstructions(): void {
    prepareAgyStart(this.profile, { stateDir: this.stateDir, name: this.opts.profileName ?? this.profile.cwd, geminiDir: this.geminiDir, ...(this.policy?.closed ? { stateOpen: this.policy.closed.open } : {}) });
  }

  /** The profile's compiled MCP servers, in ACP's shape, for session/new and resume (agy-config.ts). */
  protected mcpServers(): AcpMcpServer[] { return agyMcpServers(this.stateDir, this.opts.profileName ?? this.profile.cwd, { ...process.env, ...this.opts.env }); }

  /** agy's tools that never ask (ADR 0017 B): the gate cannot stop them, so each use is logged. */
  static readonly UNASKED_TOOLS = ['invoke_subagent', 'define_subagent', 'manage_subagents', 'swarm', 'run_workflow', 'schedule'];

  protected override onToolCall(u: Msg): void {
    const name = String(u.name ?? '');
    if (AgyBrain.UNASKED_TOOLS.includes(name)) this.emit('log', `agy used ${name}, which asks no permission (${String(u.title ?? '').slice(0, 80)})`);
    if (name === 'invoke_subagent') this.watchForChild();
  }

  /** When to look for a subagent's conversation after invoke_subagent, in ms. */
  static childScanMs = [300, 1000, 2500, 5000, 10_000];
  /** Conversations of this gemini dir that are not this session's subagents (seen at open, or checked). */
  private notChildren = new Set<string>();
  /** Subagent sessions attached with session/resume. */
  readonly children = new Set<string>();
  private childTimers: NodeJS.Timeout[] = [];

  private conversations(): string[] {
    try { return readdirSync(join(this.geminiDir, 'antigravity-cli', 'conversations')).filter((f) => /^[0-9a-f-]{36}\.db$/.test(f)).map((f) => f.slice(0, -3)); }
    catch { return []; }
  }

  /** How much of a conversation's db and write-ahead log is read for the parent's id: agy writes it
   *  with the conversation's first records. */
  static childHeadBytes = 1 << 20;

  /** Whether a conversation's files name this session, or a subagent of it already attached, as their
   *  parent (agy keeps it in the db, or its write-ahead log before a checkpoint). Read without blocking,
   *  only the head of each file. */
  private async ownChild(id: string): Promise<boolean> {
    const sids = [this.backendSessionId, ...this.children].filter((x): x is string => !!x);
    if (!sids.length) return false;
    const base = join(this.geminiDir, 'antigravity-cli', 'conversations', `${id}.db`);
    for (const x of ['', '-wal']) {
      let f: FileHandle | undefined;
      try {
        f = await open(base + x, 'r');
        const buf = Buffer.alloc(AgyBrain.childHeadBytes);
        const { bytesRead } = await f.read(buf, 0, buf.length, 0);
        const head = buf.subarray(0, bytesRead);
        if (sids.some((sid) => head.includes(sid))) return true;
      } catch { /* not there (yet) */ } finally { await f?.close().catch(() => {}); }
    }
    return false;
  }

  /**
   * agy's subagent (invoke_subagent) asks no permission to start, and its own requests never reach the
   * client on their own: it waits for ever (ADR 0017 H, measured 2026-11-21). No ACP message names it,
   * but its conversation appears in the gemini dir, naming this session as its parent; session/resume of
   * that id in the same process streams its requests, which then go through the gate and the chat like
   * any other (measured: the write ran after the approval and the parent reported it). A subagent's own
   * invoke_subagent is watched the same way, so a grandchild is attached too. Text of a subagent is not
   * delivered: the parent says what it did. A subagent that cannot be found is said in one line, since
   * nothing it asks can be answered.
   */
  private watchForChild(): void {
    // notChildren holds the conversations that were here when the session opened (openSession): never
    // read. Later ones are read, only their heads, until attached: a second subagent may start before the
    // first is found. The list is not taken here: agy can write the subagent's conversation before this
    // client has read its invoke_subagent line, and a list taken now held the subagent itself, so it was
    // never attached (CI 2026-11-22 and 2026-11-24, a loaded machine).
    const before = this.children.size;
    const scans = AgyBrain.childScanMs;
    for (const [i, ms] of scans.entries()) {
      const t = setTimeout(() => {
        if (!this.alive) return;
        void (async () => {
          for (const id of this.conversations()) {
            if (id === this.backendSessionId || this.children.has(id) || this.notChildren.has(id)) continue;
            if (!(await this.ownChild(id)) || this.children.has(id)) continue;
            this.children.add(id);
            this.emit('log', `agy subagent ${id.slice(0, 8)} attached`);
            this.call('session/resume', { sessionId: id, cwd: this.profile.cwd, mcpServers: this.mcpServers() })
              .catch((e: Error) => this.emit('log', `agy subagent ${id.slice(0, 8)} resume failed: ${e.message}`));
          }
          if (i === scans.length - 1 && this.children.size === before) {
            this.emit('log', 'agy subagent not found');
            this.emit('unasked', { answer: 'self', text: AGY_LOST_SUBAGENT_LINE });
          }
        })();
      }, ms);
      t.unref?.();
      this.childTimers.push(t);
    }
  }

  protected toolName(tc: Msg): string { return String(tc.name ?? tc.title ?? tc.kind ?? '?'); }

  protected override toolRequest(tc: Msg): ToolRequest | undefined { return agyRequest(tc, this.mcpServers().map((s) => s.name)); }

  protected override gate(tc: Msg, _request?: ToolRequest): GateDecision | GateBlock {
    if (!this.policy) return 'ask';
    return agyGate(this.policy, tc, this.mcpServers().map((s) => s.name));
  }

  protected override emptyAnswer(refused: string[]): string {
    if (!refused.length) return '';
    return `agy stopped after a refused action (${[...new Set(refused)].join('; ')}): it did not run.`;
  }

  /** The model ids a session/new or session/resume answer lists, when it lists any. */
  private noteModels(r: Msg): void {
    const list: Msg[] = Array.isArray(r?.models?.availableModels) ? r.models.availableModels : [];
    if (list.length) this.availableModels = list.map((m) => String(m.modelId));
  }

  protected async openSession(init: Msg): Promise<string> {
    const base = { cwd: this.profile.cwd, mcpServers: this.mcpServers() };
    if (this.session.started) {
      const caps: Msg = init.agentCapabilities?.sessionCapabilities ?? {};
      let resumed = false;
      if (caps.resume) {
        // No replay is expected; anything that still arrives before the answer is dropped all the same.
        const drop = () => { this.replayedUpdates++; };
        this.replayedUpdates = 0;
        this.lines.on('update', drop);
        try { this.noteModels(await this.call('session/resume', { ...base, sessionId: this.session.id })); resumed = true; }
        catch (e) { this.emit('log', `agy session/resume failed, trying session/load: ${(e as Error).message}`); }
        finally { this.lines.off('update', drop); }
      }
      if (!resumed) this.noteModels(await this.loadDroppingReplay({ ...base, sessionId: this.session.id }));
      this.backendSessionId = this.session.id;
    } else {
      const s = await this.call('session/new', base);
      this.noteModels(s);
      this.backendSessionId = String(s.sessionId);
    }
    const sessionId = this.backendSessionId;
    // Every conversation here now is another session's or an earlier one: none is a subagent of this turn.
    for (const id of this.conversations()) if (id !== sessionId) this.notChildren.add(id);
    // Checked before agy is asked: an unknown id is the owner's typo, and the list says what exists.
    const modelId = agyResolveModel(this.model, this.availableModels);
    if (!modelId) {
      throw new Error(`agy has no model ${this.model}; set model in the routing table to one of: ${this.availableModels.join(', ')}`);
    }
    try { await this.call('session/set_model', { sessionId, modelId }); }
    catch (e) { throw new Error(`agy refused model ${modelId}: ${(e as Error).message}`); }
    const mode = agyMode(this.profile);
    try { await this.call('session/set_mode', { sessionId, modeId: mode }); }
    catch (e) { throw new Error(`agy refused mode ${mode}: ${(e as Error).message}`); }
    return sessionId;
  }

  /** session/close first, so background commands and subagents end with the session (ADR 0017 H). */
  override async stop(graceMs = 5000): Promise<void> {
    for (const t of this.childTimers) clearTimeout(t);
    if (this.alive && this.backendSessionId) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.call('session/close', { sessionId: this.backendSessionId }).catch(() => {}),
        new Promise<void>((r) => { timer = setTimeout(r, Math.min(graceMs, 2000)); }),
      ]).finally(() => clearTimeout(timer));
    }
    // Read before the stop: once agy is gone its commands' own sessions are below nothing.
    const below = this.childPid ? descendants(this.childPid) : [];
    await super.stop(graceMs);
    killAll(below);
  }
}
