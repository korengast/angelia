import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Profile } from '../instance/config/schema.js';
import { cleanText, type BrainEvent } from '../core/types.js';
import { childEnv, claudeTuiArgv, MIN_CLAUDE_VERSION, remoteControlName, STRIP_ENV, versionAtLeast } from './argv.js';
import { PermissionBook, type Brain, type BrainOptions, type BrainSession } from './brain.js';
import { importsAccepted, importsDialogOpen, paneIdle, pasteLanded, permissionDialog, tmux, trustAccepted, trustDialogOpen } from './tmux.js';
import { LOST_SESSION_LINE, placeTranscript, transcriptPath } from './transcripts.js';
import { readRecord } from '../capabilities/compile.js';

export { transcriptPath } from './transcripts.js';

const HOOK = fileURLToPath(new URL('../../scripts/tui-stop-hook.mjs', import.meta.url));
const POLL_MS = 700;
const START_TIMEOUT_MS = 90_000;
const PROMPT_TIMEOUT_MS = 10 * 60_000;
const TURN_TIMEOUT_MS = 60 * 60_000;
/** How long a pane must sit at an idle prompt, with nothing new in the transcript and no answer
 *  from the Stop hook, before the turn counts as over anyway. A slash command such as `/compact`
 *  is handled by the CLI itself and ends without a Stop event, so without this the turn would
 *  simply hang. */
const QUIET_MS = 12_000;
/** After a chat answer, a dialog that still asks the same thing this long is taken as asking again. */
const REASK_MS = 2500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Settings files Claude Code merges with ours that carry a Stop hook of their own. */
export function otherStopHooks(cwd: string, home = homedir()): string[] {
  const files = [join(home, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')];
  return files.filter((f) => {
    try { const h = JSON.parse(readFileSync(f, 'utf8'))?.hooks?.Stop; return Array.isArray(h) && h.length > 0; } catch { return false; }
  });
}

/** One warning per tui profile whose Stop hook would run beside Angelia's. */
export function tuiHookWarnings(profiles: Record<string, Profile>, home = homedir()): string[] {
  return Object.entries(profiles).filter(([, p]) => p.tui && p.backend === 'claude-code').flatMap(([name, p]) => {
    const f = otherStopHooks(p.cwd, home);
    return f.length ? [`profiles.${name}: tui: true, and ${f.join(', ')} has a Stop hook of its own; it runs after every Angelia turn too, since --settings merges hooks instead of replacing them`] : [];
  });
}

/** `tmux -V` as printed ("tmux 3.6a"), or null when tmux is not installed. */
export function tmuxVersion(): string | null {
  try { return execFileSync('tmux', ['-V'], { encoding: 'utf8', timeout: 5000 }).trim(); } catch { return null; }
}

/**
 * tmux sanitises a pasted buffer only from 3.7 on ("Pass paste buffer through vis(3)", CHANGES 3.6b
 * to 3.7). Before that, an escape sequence inside a message could end the paste early and type the
 * rest into the CLI. Angelia strips control characters from every message (cleanText), so this is a
 * warning and not a refusal; the upgrade closes whatever tmux itself might still let through.
 */
export function tmuxWarnings(profiles: Record<string, Profile>, version: string | null = tmuxVersion()): string[] {
  const tui = Object.entries(profiles).filter(([, p]) => p.tui && p.backend === 'claude-code').map(([n]) => n);
  if (!tui.length) return [];
  if (version === null) return [`tui: true in ${tui.join(', ')}, and tmux is not installed: those chats cannot start. brew install tmux`];
  const m = /(\d+)\.(\d+)/.exec(version);
  if (!m || Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 7)) return [];
  return [`tui: true in ${tui.join(', ')}, and ${version} is older than 3.7, which is the first to clean pasted text. Angelia strips control characters from messages, but upgrade: brew upgrade tmux, then tmux -L angelia kill-server when the chats are quiet (every pane resumes on its next message)`];
}

/** What a pane was launched with, minus the one pair that differs between a first launch and a
 *  resume of the same session. A pane from before fingerprints existed has none, so it counts as stale.
 *  The Stop hook's script path counts too: Claude reads its settings once, at launch, so a pane
 *  started before the package moved would keep calling a script that is no longer there. */
export function launchFingerprint(argv: string[], hook = HOOK, extra: string[] = []): string {
  const a = [...argv];
  const i = a.findIndex((x) => x === '--resume' || x === '--session-id');
  if (i !== -1) a.splice(i, 2);
  return createHash('sha256').update([...a, `hook=${hook}`, ...extra].join('\0')).digest('hex');
}

/** Take names out of the global environment of Angelia's tmux server, when one is running. A server
 *  keeps the environment of whatever started it for as long as it lives, and hands it to every new
 *  pane: one started by a daemon that still held the bot token would give it to every agent after
 *  an upgrade. Returns the names that were there, never their values. */
export async function scrubTmuxServer(names: string[], env?: NodeJS.ProcessEnv): Promise<string[]> {
  const r = await tmux(['show-environment', '-g'], { env });
  if (r.code !== 0) return []; // no server running: nothing to clean
  const present = new Set(r.out.split('\n').map((l) => l.split('=')[0]));
  const found = [...new Set(names)].filter((n) => present.has(n)).sort();
  for (const n of found) await tmux(['set-environment', '-g', '-u', n], { env });
  return found;
}

/** Settings files Claude Code reads for this folder, the managed one included. */
export function claudeSettingsFiles(cwd: string, home = homedir()): string[] {
  return [join(home, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json'),
    '/Library/Application Support/ClaudeCode/managed-settings.json'];
}

/**
 * What print mode learns from the CLI's first line (the billing source, the version) and refuses on,
 * checked before a pane is started, since a pane prints no such line. An apiKeyHelper in any settings
 * file the session reads switches it to per-token billing; the variables are unset already. A key
 * stored by /login is not visible from outside and is not checked. Returns the refusal, or null.
 */
export async function tuiLaunchProblem(bin: string, cwd: string, env: NodeJS.ProcessEnv, home = homedir()): Promise<string | null> {
  for (const f of claudeSettingsFiles(cwd, home)) {
    let s: { apiKeyHelper?: unknown } | undefined;
    try { s = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
    if (s?.apiKeyHelper) return `billing: ${f} sets apiKeyHelper, so this session would bill an API key instead of the subscription`;
  }
  const out = await new Promise<string>((done) => execFile(bin, ['--version'], { env, timeout: 15_000 }, (_e, stdout) => done(String(stdout ?? ''))));
  const v = /(\d+\.\d+\.\d+)/.exec(out)?.[1];
  if (v && !versionAtLeast(v, MIN_CLAUDE_VERSION)) return `version: claude ${v} < ${MIN_CLAUDE_VERSION}`;
  return null;
}

/** A value for a POSIX shell, in single quotes. */
const shq = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;

/** Settings handed to the session: the Stop hook that reports the turn's answer. `--settings` is
 *  merged with the user's and the project's settings, not a replacement for them (claude-code#11392):
 *  a Stop hook of their own also runs on every Angelia turn. `otherStopHooks` names those files. */
export function hookSettings(hook = HOOK): unknown {
  return { hooks: { Stop: [{ hooks: [{ type: 'command', command: `node ${JSON.stringify(hook)}`, timeout: 150 }] }] } };
}

/**
 * One Claude Code session living in a tmux pane, the way a person runs it. Angelia types the turn
 * into the pane, a Stop hook writes the answer to a file, and this class turns the transcript into
 * the same progress / permission / result events every other backend emits.
 *
 * What it buys over print mode: the session appears in the Claude app (Remote Control only ever
 * worked for an interactive session), it survives a daemon restart because the pane is on Angelia's
 * own tmux server, MCP servers and background tasks live between turns, and slash commands behave
 * exactly as they do in a terminal. What it costs: the pane is read with `capture-pane`, so the
 * markers below are strings on a screen, not a protocol.
 */
export class TuiBrain extends EventEmitter implements Brain {
  private permissions: PermissionBook;
  private ready?: Promise<string | null>;
  private up = false;
  private transcript: string;
  private at = 0;
  /** One line for the chat before the next turn's answer, when the launch had to say something (a lost conversation). */
  private notice: string | null = null;
  lastUsedAt = Date.now();
  version = '';
  backendSessionId?: string;
  /** tmux session name and Remote Control name: the same readable string in both places. */
  readonly name: string;

  constructor(
    readonly profile: Profile,
    readonly session: BrainSession,
    private readonly opts: BrainOptions = {},
  ) {
    super();
    this.name = remoteControlName(profile, session);
    this.transcript = transcriptPath(profile.cwd, session.id);
    this.permissions = new PermissionBook(opts.permissionTimeoutMs ?? 10 * 60_000, (id) => { if (this.answerPermission(id, false)) this.emit('permission-timeout', id); });
  }

  get alive(): boolean { return this.up; }
  get pendingPermissionCount(): number { return this.permissions.size; }
  hasPendingPermission(id: string): boolean { return this.permissions.has(id); }

  private get dir(): string { return join(process.env.ANGELIA_STATE_DIR ?? join(homedir(), '.angelia'), 'tui', this.name); }
  private get settingsPath(): string { return join(this.dir, 'settings.json'); }
  private get markerPath(): string { return join(this.dir, 'turn.json'); }
  private get launchPath(): string { return join(this.dir, 'launch.sha256'); }
  private get envPath(): string { return join(this.dir, 'env'); }

  /** Every tmux call runs with the server's environment, never the agent's: the first call starts the
   *  server, and every profile's panes inherit what it started with. */
  private tm(args: string[]) {
    return tmux(args, { env: this.opts.hostEnv ?? childEnv(process.env) });
  }

  /** The launch, plus what decides the agent's environment and permissions: a change in any of them
   *  relaunches an idle pane. Claude reads the compiled settings once, at launch, so a new deny from
   *  `angelia compile` reaches a pane only through a relaunch. */
  private fingerprint(resume: boolean): string {
    const rec = readRecord(this.profile.cwd);
    // The sandbox flag only when set, so records from before it existed keep their fingerprint.
    const compiled = rec ? JSON.stringify([rec.deny, rec.additionalDirectories, rec.mcpServers, rec.mcpStrict, ...(rec.sandbox ? ['sandbox'] : [])]) : 'none';
    return launchFingerprint(this.argv(resume), HOOK, [`granted=${(this.opts.granted ?? []).join(',')}`, `withheld=${(this.opts.withheld ?? []).join(',')}`, `compiled=${compiled}`]);
  }

  start(): void { this.ready = this.ensure(); }

  /** Attach to the pane if it is already there (a restarted daemon finds its agents alive),
   *  otherwise start one. Resolves to an error line, or null when the session is usable.
   *
   *  A pane that survives a restart keeps the argv it was born with, so a new self prompt, model or
   *  add_dirs would never reach it. Each launch records a fingerprint of its argv; on reattach a
   *  different one means the pane is stale, and an idle stale pane is relaunched with --resume, which
   *  keeps the conversation. A busy one is left alone: cutting a turn is worse than one more stale turn. */
  private async ensure(): Promise<string | null> {
    let resume = this.session.started;
    if (await this.sessionAlive()) {
      if (this.launchedWith() === this.fingerprint(true)) return null;
      if (!paneIdle(await this.capture(40))) return null;
      await this.tm(['kill-session', '-t', this.name]);
      this.up = false;
      resume = true;
    }
    const env = childEnv(this.opts.env);
    const refused = await tuiLaunchProblem(this.opts.bin ?? 'claude', this.profile.cwd, env);
    if (refused) return refused;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.settingsPath, JSON.stringify(hookSettings(), null, 2));
    const pinned: string[] = [];
    for (const k of ['PATH', 'HOME', 'LANG', 'SHELL', 'ANGELIA_SESSION_KEY']) {
      if (env[k]) pinned.push('-e', `${k}=${env[k]}`);
    }
    pinned.push('-e', `ANGELIA_TUI_MARKER=${this.markerPath}`);
    // The tmux server is long-lived and carries whatever environment started it, so the billing
    // variables and every secret this profile was not given are unset for the child itself, rather
    // than merely left out of ours.
    const unset = [...STRIP_ENV, ...(this.opts.withheld ?? [])].flatMap((k) => ['-u', k]);
    // The secrets it was given go through a file only this user can read, which the pane deletes
    // once it has read it: `-e` would leave them in the session's environment for any process of
    // this user to list with `tmux show-environment`.
    rmSync(this.envPath, { force: true });
    const granted = (this.opts.granted ?? []).filter((k) => env[k] !== undefined);
    const wrap: string[] = [];
    if (granted.length) {
      writeFileSync(this.envPath, granted.map((k) => `export ${k}=${shq(env[k]!)}`).join('\n') + '\n', { mode: 0o600 });
      wrap.push('/bin/sh', '-c', '. "$0"; rm -f "$0"; exec "$@"', this.envPath);
    }
    if (resume && this.opts.projectsDir) {
      const placed = placeTranscript(this.profile.cwd, this.session.id, this.opts.projectsDir);
      if (placed.status === 'copied') this.emit('log', `transcript ${this.session.id.slice(0, 8)} copied from ${placed.from} for ${this.profile.cwd}`);
      if (placed.status === 'missing') {
        // The conversation is gone from every project folder: `--resume` would end the launch with
        // "No conversation found", every turn, until someone typed /new. Start fresh under the same id
        // instead, and say so in the chat once.
        this.emit('log', `transcript ${this.session.id.slice(0, 8)} not found under ${this.opts.projectsDir}; starting fresh in ${this.profile.cwd}`);
        this.notice = LOST_SESSION_LINE;
        resume = false;
      }
    }
    const argv = this.argv(resume);
    const r = await this.tm(['new-session', '-d', '-s', this.name, '-c', this.profile.cwd, '-x', '220', '-y', '50', ...pinned, ...wrap, 'env', ...unset, ...argv]);
    if (r.code !== 0) { rmSync(this.envPath, { force: true }); return `tmux could not start the session: ${r.err.trim() || 'new-session failed'}`; }
    writeFileSync(this.launchPath, this.fingerprint(resume));
    this.up = true;
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // The pane is gone with its output, so say what was run and where: that is the one way to see why.
      if (!(await this.sessionAlive())) { this.up = false; return `the agent exited while starting (${argv[0]} in ${this.profile.cwd}; run it there by hand to see why)`; }
      const pane = await this.capture(40);
      if (trustDialogOpen(pane)) { await this.acceptDialog(trustAccepted); continue; }
      if (importsDialogOpen(pane)) { await this.acceptDialog(importsAccepted); continue; }
      if (paneIdle(pane)) return null;
      await sleep(500);
    }
    // The pane is about to be killed with its screen, so keep what it showed: that is the one way
    // to learn which dialog or error held it, without a terminal open at the right second.
    // Kept in the pane's private folder, not the log: on a resume the screen can show the conversation.
    const screen = join(this.dir, 'screen.txt');
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(screen, `${new Date().toISOString()}\n${await this.capture(40)}\n`, { mode: 0o600 });
      this.emit('log', `pane ${this.name} never reached a prompt; its screen is in ${screen}`);
    } catch { this.emit('log', `pane ${this.name} never reached a prompt`); }
    return `the session never reached a prompt (look with: tmux -L angelia attach -t ${this.name})`;
  }

  private argv(resume: boolean): string[] {
    return claudeTuiArgv(this.profile, { ...this.session, started: resume }, this.opts.bin ?? 'claude', this.settingsPath, this.name, this.opts.system);
  }

  private launchedWith(): string | undefined {
    try { return readFileSync(this.launchPath, 'utf8').trim(); } catch { return undefined; }
  }

  /** The first run in a directory asks whether the folder is trusted, with "No, exit" preselected,
   *  and then whether its CLAUDE.md may import files outside it, with "No" preselected again.
   *  routing.yaml already names this directory as the profile's home and the permission mode it
   *  runs under, and the imports are the owner's own shared doctrine, so the answer was given when
   *  that line was written; press it instead of hanging. `accepted` says the cursor is on the yes
   *  row; it is checked before Enter, so a redraw can never turn this into "No". */
  private async acceptDialog(accepted: (pane: string) => boolean): Promise<boolean> {
    for (let i = 0; i < 8; i++) {
      if (accepted(await this.capture(40))) { await this.tm(['send-keys', '-t', this.name, 'Enter']); return true; }
      await this.tm(['send-keys', '-t', this.name, 'Down']);
      await sleep(300);
    }
    return false;
  }

  private async sessionAlive(): Promise<boolean> {
    const r = await this.tm(['has-session', '-t', this.name]);
    this.up = r.code === 0;
    return this.up;
  }

  private async capture(lines = 30): Promise<string> {
    const r = await this.tm(['capture-pane', '-p', '-t', this.name, '-S', `-${lines}`]);
    return r.code === 0 ? r.out : '';
  }

  /** Type one message into the pane: wait for a prompt, paste (newlines stay inside one message),
   *  check it landed, then Enter. Never press Enter on an unverified box. */
  private async paste(raw: string): Promise<boolean> {
    // The last gate before text becomes keys: whoever called, no control character reaches the pane.
    const text = cleanText(raw);
    const deadline = Date.now() + PROMPT_TIMEOUT_MS;
    while (!paneIdle(await this.capture(30))) {
      if (Date.now() > deadline || !(await this.sessionAlive())) return false;
      await sleep(POLL_MS);
    }
    await this.tm(['set-buffer', '-b', this.name, '--', text]);
    await this.tm(['paste-buffer', '-p', '-d', '-b', this.name, '-t', this.name]);
    for (let i = 0; i < 8; i++) {
      await sleep(300);
      if (pasteLanded(await this.capture(20), text)) {
        await this.tm(['send-keys', '-t', this.name, 'Enter']);
        return true;
      }
    }
    await this.tm(['send-keys', '-t', this.name, 'C-u']); // clear whatever landed, submit nothing
    return false;
  }

  async *turn(text: string): AsyncGenerator<BrainEvent> {
    this.lastUsedAt = Date.now();
    const problem = await (this.ready ?? Promise.resolve('brain not started'));
    if (problem) { yield { kind: 'result', text: '', isError: true, reason: problem }; return; }
    if (this.notice) { yield { kind: 'notice', text: this.notice }; this.notice = null; }
    this.at = fileSize(this.transcript); // only rows written from here on are this turn's
    rmSync(this.markerPath, { force: true });
    const sentAt = Date.now();
    if (!(await this.paste(text))) {
      yield { kind: 'result', text: '', isError: true, reason: this.up ? 'the session never came back to a prompt' : 'exit' };
      return;
    }
    let pending: string | null = null;
    const dialogs = new DialogWatch();
    let quietSince = 0;
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const rows = this.readTranscript();
      if (rows.length) quietSince = 0;
      for (const ev of rows) {
        if (ev.kind === 'text') { if (pending) yield { kind: 'progress', text: pending }; pending = ev.text; }
        else if (pending) { yield { kind: 'progress', text: pending }; pending = null; }
      }
      const done = this.takeMarker(sentAt);
      if (done !== null) {
        this.lastUsedAt = Date.now();
        yield { kind: 'result', text: done, isError: false };
        return;
      }
      const pane = await this.capture(30);
      const open = permissionDialog(pane);
      const seen = dialogs.see(open, (id) => this.permissions.has(id));
      if (seen.gone) this.permissions.take(seen.gone); // answered in the app or in the terminal
      if (seen.announce && open) {
        this.permissions.add(seen.announce);
        yield { kind: 'permission', id: seen.announce, tool: open.tool, preview: open.preview };
      }
      if (!pane && !(await this.sessionAlive())) { yield { kind: 'result', text: '', isError: true, reason: 'exit' }; return; }
      if (paneIdle(pane) && !dialogs.open) {
        if (!quietSince) quietSince = Date.now();
        else if (Date.now() - quietSince > QUIET_MS) {
          // No Stop event is coming: either the CLI answered the message itself, or the hook failed
          // and the transcript holds the answer.
          this.lastUsedAt = Date.now();
          yield { kind: 'result', text: pending ?? '', isError: false };
          return;
        }
      } else quietSince = 0;
    }
    yield { kind: 'result', text: '', isError: true, reason: 'the turn did not finish in an hour' };
  }

  /** New transcript rows since the last read, as the two things a progress line cares about.
   *  Only whole lines are consumed, so a row still being written is read on the next pass and a
   *  multi-byte character never gets split across two reads. */
  private readTranscript(): TranscriptEvent[] {
    let fd: number;
    try { fd = openSync(this.transcript, 'r'); } catch { return []; }
    try {
      const size = fstatSync(fd).size;
      if (size <= this.at) return [];
      const buf = Buffer.allocUnsafe(size - this.at);
      readSync(fd, buf, 0, buf.length, this.at);
      const cut = buf.lastIndexOf(10);
      if (cut < 0) return [];
      this.at += cut + 1;
      return transcriptEvents(buf.subarray(0, cut).toString('utf8'));
    } catch {
      return [];
    } finally {
      closeSync(fd);
    }
  }

  /** The Stop hook's file, but only when it belongs to this turn: a session the user drives from
   *  the Claude app writes markers too, and one of those must never be sent as an answer. */
  private takeMarker(sentAt: number): string | null {
    if (!existsSync(this.markerPath)) return null;
    let row: { text?: string; at?: number; transcript_path?: string } = {};
    try { row = JSON.parse(readFileSync(this.markerPath, 'utf8')); } catch { return null; }
    if (!row.at || row.at < sentAt) return null;
    rmSync(this.markerPath, { force: true });
    if (row.transcript_path && row.transcript_path !== this.transcript) {
      this.transcript = row.transcript_path;
      const id = row.transcript_path.split('/').pop()?.replace(/\.jsonl$/, '');
      if (id && id !== this.session.id) this.backendSessionId = id; // the CLI forked the session
    }
    return String(row.text ?? '');
  }

  /** Chat approvals press the key a person would press. A prompt answered in the Claude app or in
   *  the terminal simply disappears from the pane, and the turn goes on. */
  answerPermission(id: string, allow: boolean): boolean {
    const full = this.permissions.take(id);
    if (!full) return false;
    void this.tm(['send-keys', '-t', this.name, allow ? '1' : 'Escape']);
    return true;
  }

  /**
   * Let the pane go on living. This is the whole reason for running in tmux: the server is
   * Angelia's own, so a restart or a 30-minute idle reap costs nothing and `ensure()` reattaches
   * by name on the next message, with MCP servers and background tasks still warm.
   *
   * It was declared on the interface, called by the orchestrator, and never implemented here -
   * so every reap and every restart ran `stop()` instead and killed the pane, silently, because
   * the next message respawned and resumed by id.
   */
  async release(): Promise<void> {
    this.permissions.clear();
    this.up = false;
  }

  async stop(): Promise<void> {
    this.permissions.clear();
    await this.tm(['kill-session', '-t', this.name]);
    this.up = false;
    this.emit('exit', { code: 0, signal: null });
  }

  kill(): void { void this.stop(); }
}

/**
 * End the panes on Angelia's tmux server that no chat will reach again: a name with one of this
 * table's tui prefixes that is not in `keep`, sitting idle. A daemon restart forgets which panes it
 * released, and a /new after that would otherwise leave the old one running for good, with its MCP
 * servers, its permissions and its Remote Control registration. A busy pane is left alone.
 */
export async function sweepPanes(keep: Set<string>, prefixes: string[], env: NodeJS.ProcessEnv): Promise<string[]> {
  if (!prefixes.length) return [];
  const list = await tmux(['list-sessions', '-F', '#{session_name}'], { env });
  if (list.code !== 0) return [];
  const gone: string[] = [];
  for (const name of list.out.split('\n').filter(Boolean)) {
    if (keep.has(name) || !prefixes.some((p) => name.startsWith(p))) continue;
    const pane = await tmux(['capture-pane', '-p', '-t', name, '-S', '-30'], { env });
    if (pane.code !== 0 || !paneIdle(pane.out)) continue;
    if ((await tmux(['kill-session', '-t', name], { env })).code === 0) gone.push(name);
  }
  return gone;
}

/**
 * Which permission dialog on the pane is new, one poll at a time. A dialog answered from the chat can
 * be followed by the next one before any poll sees the pane without a dialog: that one is announced
 * when it asks something else, or when the same question is still up once the key had time to land.
 */
export class DialogWatch {
  private id: string | null = null;
  private asked = '';
  private answeredAt = 0;

  get open(): boolean { return this.id !== null; }

  see(dialog: { tool: string; preview: string } | null, pending: (id: string) => boolean, now = Date.now()): { announce?: string; gone?: string } {
    if (this.id && !pending(this.id)) this.answeredAt ||= now;
    if (!dialog) {
      const gone = this.id ?? undefined;
      this.id = null; this.answeredAt = 0;
      return gone ? { gone } : {};
    }
    const asked = `${dialog.tool}\n${dialog.preview}`;
    if (this.id && !(this.answeredAt && (asked !== this.asked || now - this.answeredAt > REASK_MS))) return {};
    this.id = randomUUID().slice(0, 8); this.asked = asked; this.answeredAt = 0;
    return { announce: this.id };
  }
}

export type TranscriptEvent = { kind: 'text'; text: string } | { kind: 'tool' };

/** Assistant text and tool calls, in order, from a slice of a Claude Code transcript. */
export function transcriptEvents(chunk: string): TranscriptEvent[] {
  const out: TranscriptEvent[] = [];
  for (const line of chunk.split('\n')) {
    let row: { type?: string; message?: { content?: unknown } };
    try { row = JSON.parse(line); } catch { continue; }
    const content = row?.message?.content;
    if (row?.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const b of content as { type?: string; text?: string }[]) {
      if (b?.type === 'text' && String(b.text ?? '').trim()) out.push({ kind: 'text', text: String(b.text).trim() });
      else if (b?.type === 'tool_use') out.push({ kind: 'tool' });
    }
  }
  return out;
}

function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}
