import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Profile } from '../instance/config/schema.js';
import { cleanText, type BrainEvent, type UnaskedAnswer } from '../core/types.js';
import { isLimitText } from '../core/deliver/text.js';
import { childEnv, CLAUDE_ENV, claudeTuiArgv, MIN_CLAUDE_VERSION, remoteControlName, STRIP_ENV, tuiSettings, versionAtLeast } from './argv.js';
import { PermissionBook, type Brain, type BrainOptions, type BrainSession, type PermissionAnswer, type TurnFlags } from './brain.js';
import { addDirAccepted, addDirDialog, importsAccepted, importsDialogOpen, loadBuffer, paneAboveFoot, paneBusy, paneHasBox, paneIdle, pasteLanded, permissionDialog, submitPasted, tmux, TMUX_SOCKET, trustAccepted, trustDialogOpen } from './tmux.js';
import { paneVerdict, PermissionRelay, REJECTED, RELAY_BEAT_MS, relayedPermission, ScreenDialogs } from './tui-permissions.js';
import { LOST_SESSION_LINE, placeTranscript, transcriptPath } from './transcripts.js';
import { mcpLaunch, readRecord } from '../capabilities/compile.js';
import { readPlainText } from '../core/paths.js';

export { transcriptPath } from './transcripts.js';

const HOOK = fileURLToPath(new URL('../../scripts/tui-stop-hook.mjs', import.meta.url));
const PERMISSION_HOOK = fileURLToPath(new URL('../../scripts/tui-permission-hook.mjs', import.meta.url));
/** Claude's limit for the permission hook, in seconds: past the hook's own give-up, which is past the
 *  daemon's ten-minute deny. */
const PERMISSION_HOOK_TIMEOUT_S = 900;
const POLL_MS = 700;
/** How long claude's add-dir dialog must stand before keys reach it (it drops them for ~1 s, 2.1.326). */
const ADD_DIR_SETTLE_MS = 1500;
const START_TIMEOUT_MS = 90_000;
/** How long a message waits for the pane's prompt. Past it the message goes back to the chat as not
 *  delivered, and a pane that works or waits for a person is kept (notTyped). */
const PROMPT_TIMEOUT_MS = 10 * 60_000;
/** How long a paste may take to show in the input box before it counts as not shown. */
const LAND_MS = 2400;
/** How many times one message is pasted when it never showed in the box (nothing was submitted). */
const PASTE_TRIES = 3;

/** How a paste went. `keep`: the pane is alive and was left as it was, so it must not be ended for
 *  this: it may hold background agents, a dialog for a person, or a turn of its own. `why`: for the chat. */
type Pasted = { ok: true } | { ok: false; why: string; keep: boolean };

/** The reason of a turn whose message was not typed into a live pane that is kept: the chat is told to
 *  send it again (core/deliver/text.ts, notDeliveredLine), and the pane is not ended. */
export const NOT_TYPED = 'not delivered';
/** A turn has no end time: a long build or a run of subagents may take hours, and `/stop` ends a
 *  stuck one. Each full hour the chat gets one line saying so, so a silent turn is not taken for a
 *  crash. */
const TURN_NOTICE_MS = 60 * 60_000;
/** Said when a message reaches a session that is busy with something else, mostly a turn typed in the Claude app. */
export const BUSY_PANE_LINE = 'The session is busy with another turn (in the Claude app or its pane); your message waits for it.';
/** A pane and transcript unchanged this long: the hourly line says the turn may be stuck. A working
 *  CLI redraws its spinner and timer every second, so only a screen that waits on nothing is this still. */
const STILL_MS = 30 * 60_000;
/** How long a pane must sit at an idle prompt, with nothing new in the transcript and no answer
 *  from the Stop hook, before the turn counts as over anyway. A slash command such as `/compact`
 *  is handled by the CLI itself and ends without a Stop event, so without this the turn would
 *  simply hang. */
export const QUIET_MS = 12_000;
/** The same wait when the turn's last transcript row is the assistant's text. That is the answer of
 *  a turn whose Stop hook failed, or text that a tool call still follows: the call's row is written
 *  when its input is whole, which can take longer than QUIET_MS for a large file, and the rows do not
 *  say which (stop_reason on a row is not measured). The Stop hook lands within a second of a real
 *  end, so only a failed hook waits this long. Counted from the last transcript row of any kind.
 *  BrainOptions.quietTextMs shortens it (tests). */
const QUIET_TEXT_MS = 90_000;
/** The same wait when the transcript shows the turn open (a tool runs, the model owes an answer): the
 *  net under row shapes turnRows does not know, and under a turn that ended with no Stop hook and no
 *  closing row. Counted from the last transcript row of any kind and from the last change of the
 *  screen above the input box's foot: a working CLI redraws its spinner clock there every second, so
 *  a turn at work is never ended by this, and a teammate's clock under the box does not hold a dead
 *  one open. The orchestrator's stall clock does not run for a tmux turn, so this is the only bound. */
const QUIET_OPEN_MS = 3 * 60_000;
/** After a chat answer, a dialog that still asks the same thing this long is taken as asking again. */
const REASK_MS = 2500;
/** How long a request answered in the pane may go without a result in the transcript before it counts
 *  as allowed: Claude writes a refusal at once, so a call still waiting on its result is running. */
const DECIDE_MS = 3000;
/** The most of a turn's transcript read to find how a request answered in the pane went. */
const TRANSCRIPT_SLICE_MAX = 8 * 1024 * 1024;

/** How often the Stop marker is looked for between turns, while the session is held: one check that
 *  a file exists. Short: the next Stop overwrites the file, so a late answer followed at once by a
 *  task's end would be lost to a slow reader. BrainOptions.idlePollMs shortens it (tests). */
const IDLE_POLL_MS = 1000;
/** What an agent answers when it has nothing for the chat (jobs.ts reads the same word). */
const SILENT = '[SILENT]';

/** The Stop hook's file (scripts/tui-stop-hook.mjs). `origin`, `origin_why`, `prompt_at`, `prompt_key`,
 *  `prompts`, `origin_ids`: what started the turn, as the hook read it from the transcript
 *  (scripts/turn-origin.mjs). */
interface Marker {
  text?: unknown; at?: number; transcript_path?: string; origin?: unknown; origin_why?: unknown; prompt_at?: unknown;
  prompt_key?: unknown; prompts?: unknown; origin_ids?: unknown;
}

/** The key of a typed prompt, as scripts/turn-origin.mjs (promptKey) computes it from the transcript:
 *  the paste tags left out, NFC, every run of white space one space, trimmed, SHA-256, 32 hex digits. */
export function promptKey(text: string): string {
  return createHash('sha256').update(text.replace(PASTED_TAG, ' ').normalize('NFC').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 32);
}
/** The tags Claude Code wraps a pasted text of several lines in, in the transcript (turn-origin.mjs). */
const PASTED_TAG = /<\/?pasted_content id="[0-9a-f]{4}">/g;

/** An answer as the chat got it and as the hook read it, made comparable: line ends, white space at
 *  a line's end, runs of blank lines, Unicode form. */
export function sameAnswer(a: string, b: string): boolean {
  const norm = (s: string) => s.normalize('NFC').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const x = norm(a), y = norm(b);
  return !!y && (x === y || x.endsWith(`\n\n${y}`));
}

/** The start of the line a turn writes when it drops a marker whose typed prompt is not the one it
 *  typed (daemon/health.ts counts it, brain/canary.ts fails on it). */
export const KEY_MISS_LINE = 'tmux: marker dropped, prompt key miss:';

/** Background tasks remembered as started in a turn of Angelia's: a task's end is delivered by these. */
const OURS_MAX = 500;

/** Calls kept while their result is awaited, so a turn of a thousand shell commands does not grow the map. */
const CALLS_MAX = 500;

/**
 * The tool_use ids of the background tasks a slice of transcript rows starts, as Claude Code writes
 * them: a shell command sent to the background (a `Bash` call whose result row carries
 * `backgroundTaskId`) and a subagent launched to run on its own (`status: async_launched`, or
 * `teammate_spawned` for a named one). The end of each comes back as a `<task-notification>` naming the
 * same id, which the Stop hook reports as `origin_ids`. `calls`: the kind of each call whose result
 * has not come yet, kept by the caller across slices (a call and its result may be read apart).
 */
export function backgroundStarts(chunk: string, calls: Map<string, 'bash' | 'agent'> = new Map()): string[] {
  const out: string[] = [];
  type Block = { type?: unknown; id?: unknown; name?: unknown; tool_use_id?: unknown };
  for (const l of chunk.split('\n')) {
    let r: { type?: unknown; message?: { content?: unknown }; toolUseResult?: unknown } | null;
    try { r = JSON.parse(l); } catch { continue; }
    if (!Array.isArray(r?.message?.content)) continue;
    const content = r.message.content as Block[];
    if (r.type === 'assistant') {
      for (const b of content) {
        if (b?.type !== 'tool_use' || typeof b.id !== 'string') continue;
        if (b.name === 'Bash') calls.set(b.id, 'bash');
        else if (b.name === 'Agent' || b.name === 'Task') calls.set(b.id, 'agent');
        else continue;
        if (calls.size > CALLS_MAX) calls.delete(calls.keys().next().value!);
      }
      continue;
    }
    if (r.type !== 'user') continue;
    const results = content.filter((b) => b?.type === 'tool_result' && typeof b.tool_use_id === 'string');
    // The result object belongs to the row's one call; a row of several is not guessed at.
    if (results.length !== 1) continue;
    const id = String(results[0].tool_use_id), kind = calls.get(id);
    calls.delete(id);
    const res = r.toolUseResult as { backgroundTaskId?: unknown; status?: unknown } | undefined;
    if (!res || typeof res !== 'object') continue;
    // A background id counts for a shell call only (a call not seen is taken for one, as Claude Code
    // gives that id to shell commands alone).
    if (res.backgroundTaskId && (kind ?? 'bash') === 'bash') out.push(id);
    else if (res.status === 'async_launched' || res.status === 'teammate_spawned') out.push(id);
  }
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Settings files Claude Code merges with ours that carry a Stop hook of their own. */
export function otherStopHooks(cwd: string, home = homedir()): string[] {
  const files = [join(home, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')];
  return files.filter((f) => {
    try { const h = JSON.parse(readPlainText(f))?.hooks?.Stop; return Array.isArray(h) && h.length > 0; } catch { return false; }
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
export function tmuxWarnings(profiles: Record<string, Profile>, version: string | null = tmuxVersion(), platform: NodeJS.Platform = process.platform): string[] {
  const tui = Object.entries(profiles).filter(([, p]) => p.tui && p.backend === 'claude-code').map(([n]) => n);
  if (!tui.length) return [];
  if (version === null) return [`tui: true in ${tui.join(', ')}, and tmux is not installed: those chats cannot start. brew install tmux`];
  const m = /(\d+)\.(\d+)/.exec(version);
  if (!m || Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 7)) return [];
  return [`tui: true in ${tui.join(', ')}, and ${version} is older than 3.7, which is the first to clean pasted text. Angelia strips control characters from messages, but upgrade: ${platform === 'darwin' ? 'brew upgrade tmux' : 'upgrade tmux to 3.7+'}, then tmux -L angelia kill-server when the chats are quiet (every pane resumes on its next message)`];
}

/** The start of the reason a pane gives when it died before its first prompt. */
export const START_EXIT = 'the agent exited while starting';

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
    try { s = JSON.parse(readPlainText(f)); } catch { continue; }
    if (s?.apiKeyHelper) return `billing: ${f} sets apiKeyHelper, so this session would bill an API key instead of the subscription`;
  }
  const out = await new Promise<string>((done) => execFile(bin, ['--version'], { env, timeout: 15_000 }, (_e, stdout) => done(String(stdout ?? ''))));
  const v = /(\d+\.\d+\.\d+)/.exec(out)?.[1];
  if (v && !versionAtLeast(v, MIN_CLAUDE_VERSION)) return `version: claude ${v} < ${MIN_CLAUDE_VERSION}`;
  return null;
}

/** A value for a POSIX shell, in single quotes. */
const shq = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;

/** Settings handed to the session: the Stop hook that reports the turn's answer, and the
 *  PermissionRequest hook that carries each request to the chat (tui-permissions.ts). `--settings` is
 *  merged with the user's and the project's settings, not a replacement for them (claude-code#11392):
 *  a Stop hook of their own also runs on every Angelia turn. `otherStopHooks` names those files. */
export function hookSettings(hook = HOOK, permission = PERMISSION_HOOK): unknown {
  return {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: `node ${JSON.stringify(hook)}`, timeout: 150 }] }],
      PermissionRequest: [{ hooks: [{ type: 'command', command: `node ${JSON.stringify(permission)}`, timeout: PERMISSION_HOOK_TIMEOUT_S }] }],
    },
  };
}

/** For a dialog on the pane that did not come through the hook (tui-permissions.ts, ScreenDialogs).
 *  `socket`: the tmux server the pane is on, when not Angelia's own. */
export function screenOnlyLine(pane: string, socket = TMUX_SOCKET): string {
  return `A permission dialog is open that did not come through Angelia, so only the screen says what it asks and it cannot be answered from here. Answer it in the Claude app, or in the pane (tmux -L ${socket} attach -t ${pane}); /stop ends the turn.`;
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
  private relay: PermissionRelay;
  /** When a relayed request last came, was answered or went: a dialog on the pane just then is its own. */
  private relayedAt = 0;
  /** The heartbeat of the turn read from the chat now, and the reader (`gen`) it belongs to. */
  private beating?: { timer: NodeJS.Timeout; gen: number };
  private ready?: Promise<string | null>;
  private up = false;
  private transcript: string;
  private at = 0;
  /** Where this turn's rows begin in the transcript, for reading how a request answered in the pane went. */
  private from = 0;
  /** Where the turn stands by the rows read from `from` on (turnRows): the second sign, next to the
   *  screen, of whether the turn is over. */
  private rows: TurnRows = 'none';
  /** One line for the chat before the next turn's answer, when the launch had to say something (a lost conversation). */
  private notice: string | null = null;
  lastUsedAt = Date.now();
  version = '';
  backendSessionId?: string;
  /** tmux session name and Remote Control name: the same readable string in both places. */
  readonly name: string;
  /** When the turn now running was typed in; unset between turns. Markers older than it are not its answer. */
  turnSentAt?: number;
  /** Bumped whenever the reader of the pane changes (a release, the background, a follow): a watch
   *  loop that sees it move stops reading, so two loops never read one pane. */
  private gen = 0;
  /** Tool-use ids of the background tasks started in Angelia's turns (read while a turn of its own
   *  ran). A task the owner started from the app is not among them. */
  private ours = new Set<string>();
  /** The calls that may start a background task, until their result row is read (backgroundStarts). */
  private calls = new Map<string, 'bash' | 'agent'>();
  /** Rows read now are of a turn Angelia typed here: set at its Enter (submit), cleared when that turn
   *  ends or its reader changes. Not turnSentAt: adopt() sets that with the transcript read from its
   *  start, and a released pane keeps it. */
  private recording = false;
  /** The last turn typed here that ended with no Stop marker (the quiet path), until its marker comes
   *  or another turn begins: when it was typed, when it was closed, and what the chat got as its answer. */
  private quietEnd?: { sentAt: number; endedAt: number; said: string; key: string };
  /** The key (promptKey) of what this turn typed, from its Enter until the turn ends. */
  private typedKey = '';
  /** The reader between turns (startIdle): it looks for a Stop marker no turn of Angelia's waits for. */
  private idle?: NodeJS.Timeout;
  /** Since when this object reads the session: its first turn. A marker from before is of a time when
   *  nobody held the session, and is not delivered late. */
  private heldSince?: number;

  constructor(
    readonly profile: Profile,
    readonly session: BrainSession,
    private readonly opts: BrainOptions = {},
  ) {
    super();
    this.name = remoteControlName(profile, session);
    this.transcript = transcriptPath(profile.cwd, session.id);
    this.relay = new PermissionRelay(join(this.dir, 'permissions'));
    this.permissions = new PermissionBook(opts.permissionTimeoutMs ?? 10 * 60_000, (id) => { if (this.answerPermission(id, false)) this.emit('permission-timeout', id); });
  }

  get alive(): boolean { return this.up; }
  get pendingPermissionCount(): number { return this.permissions.size; }
  hasPendingPermission(id: string): boolean { return this.permissions.has(id); }

  private get dir(): string { return join(this.opts.stateDir ?? process.env.ANGELIA_STATE_DIR ?? join(homedir(), '.angelia'), 'tui', this.name); }
  private get settingsPath(): string { return join(this.dir, 'settings.json'); }
  private get markerPath(): string { return join(this.dir, 'turn.json'); }
  private get launchPath(): string { return join(this.dir, 'launch.sha256'); }
  private get envPath(): string { return join(this.dir, 'env'); }

  /** The tmux server this pane is on: Angelia's own, unless the caller named another (the canary). */
  private get socket(): string { return this.opts.tmuxSocket ?? TMUX_SOCKET; }

  /** Every tmux call runs with the server's environment, never the agent's: the first call starts the
   *  server, and every profile's panes inherit what it started with. */
  private tm(args: string[], o: { scope?: boolean } = {}) {
    return tmux(args, { env: this.opts.hostEnv ?? childEnv(process.env), socket: this.socket, ...o });
  }

  /** The launch, plus what decides the agent's environment and permissions: a change in any of them
   *  relaunches an idle pane. Claude reads the compiled settings once, at launch, so a new deny from
   *  `angelia compile` reaches a pane only through a relaunch. */
  private fingerprint(resume: boolean): string {
    const rec = readRecord(this.profile.cwd);
    // The sandbox flag only when set, so records from before it existed keep their fingerprint.
    // The MCP keys of the settings file too (connectors, tuiSettings), only when there are any, as the sandbox flag.
    const mcp = (this.opts.mcp ?? mcpLaunch(this.profile.cwd)).settings;
    const compiled = rec ? JSON.stringify([rec.deny, rec.additionalDirectories, rec.mcpServers, rec.mcpStrict, ...(rec.sandbox ? ['sandbox'] : []), ...(Object.keys(mcp).length ? [mcp] : [])]) : 'none';
    return launchFingerprint(this.argv(resume), HOOK, [`granted=${(this.opts.granted ?? []).join(',')}`, `withheld=${(this.opts.withheld ?? []).join(',')}`, `compiled=${compiled}`, `env=${Object.entries(CLAUDE_ENV).map(([k, v]) => `${k}=${v}`).join(',')}`, `permission-hook=${PERMISSION_HOOK}`]);
  }

  start(): void { this.ready = this.ensure(); }

  /** The start's outcome, for a caller that wants it apart from the first turn (canary.ts): null once
   *  the pane is at a prompt, else the line that says why it is not. */
  whenReady(): Promise<string | null> { return this.ready ?? Promise.resolve('brain not started'); }

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
    writeFileSync(this.settingsPath, JSON.stringify(tuiSettings(this.profile, hookSettings(), this.opts.mcp), null, 2));
    this.relay.reset();
    const pinned: string[] = [];
    for (const k of ['PATH', 'HOME', 'LANG', 'SHELL', 'ANGELIA_SESSION_KEY']) {
      if (env[k]) pinned.push('-e', `${k}=${env[k]}`);
    }
    pinned.push('-e', `ANGELIA_TUI_MARKER=${this.markerPath}`);
    for (const [k, v] of Object.entries(CLAUDE_ENV)) pinned.push('-e', `${k}=${v}`);
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
    // remain-on-exit off in the same call: the server reads the user's ~/.tmux.conf, and a dead pane
    // left on screen would pass for a live session, so a turn would wait on it for ever.
    const r = await this.tm(['new-session', '-d', '-s', this.name, '-c', this.profile.cwd, '-x', '220', '-y', '50', ...pinned, ...wrap, 'env', ...unset, ...argv, ';', 'set-option', '-w', '-t', this.name, 'remain-on-exit', 'off'], { scope: true });
    if (r.code !== 0) { rmSync(this.envPath, { force: true }); return `tmux could not start the session: ${r.err.trim() || 'new-session failed'}`; }
    writeFileSync(this.launchPath, this.fingerprint(resume));
    this.up = true;
    const deadline = Date.now() + START_TIMEOUT_MS;
    let asked: { dir: string; at: number; answered: number } | undefined;
    const answered = new Set<string>();
    let unlisted: string | undefined;
    while (Date.now() < deadline) {
      // The pane is gone with its output, so say what was run and where: that is the one way to see why.
      if (!(await this.sessionAlive())) { this.up = false; return `${START_EXIT} (${argv[0]} in ${this.profile.cwd}; run it there by hand to see why)`; }
      const pane = await this.capture(40);
      // Dialogs before the prompt: each counts only as the last dialog on screen with no input box
      // below it, so a resumed conversation that quotes one is the prompt. Idle first would let a
      // stale frame in the history (between two rules) pass for a box while a dialog is open.
      if (trustDialogOpen(pane)) { await this.acceptDialog(trustDialogOpen, trustAccepted); continue; }
      if (importsDialogOpen(pane)) { await this.acceptDialog(importsDialogOpen, importsAccepted); continue; }
      const dir = addDirDialog(pane);
      if (dir !== null) {
        // claude 2.1.326 drops keys for about a second after it draws this dialog (measured: Down and
        // Enter at once leave it on "No"), and a profile with two new folders gets one dialog each.
        // So wait until a folder's dialog has stood ADD_DIR_SETTLE_MS, and give an answer time to land
        // before the same folder is answered again.
        if (asked?.dir !== dir) asked = { dir, at: Date.now(), answered: 0 };
        // Yes only for a folder the owner listed in add_dirs: that line was the answer. Anything else
        // stays unanswered, and once it has stood as long (one frame drawn mid-redraw is no answer)
        // the start fails with the folder named.
        if (!addDirListed(dir, this.profile.add_dirs, homedir(), this.profile.cwd)) {
          if (Date.now() - asked.at < ADD_DIR_SETTLE_MS) { await sleep(250); continue; }
          this.emit('log', `pane ${this.name} asks to add ${dir}, which is not in add_dirs`);
          unlisted = dir;
          break;
        }
        if (Date.now() - asked.at < ADD_DIR_SETTLE_MS || Date.now() - asked.answered < ADD_DIR_SETTLE_MS * 2) { await sleep(250); continue; }
        // Bound to this folder: when its dialog closes and the next folder's opens, that one waits for
        // its own listed check and settle time, and gets no Down or Enter meant for this one.
        // The same folder can be answered more than once (an Enter dropped while the dialog was new).
        if (await this.acceptDialog((p) => addDirDialog(p) === dir, addDirAccepted) && !answered.has(dir)) {
          answered.add(dir);
          this.emit('log', `pane ${this.name} answered add-dir ${dir}`);
        }
        asked.answered = Date.now();
        continue;
      }
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
    // Named, so the owner sees which folder to list (or why claude asks about it) without the log.
    if (unlisted !== undefined) return `the session did not start: claude asks to add the folder ${unlisted}, which is not in this profile's add_dirs`;
    return `the session never reached a prompt (look with: tmux -L ${this.socket} attach -t ${this.name})`;
  }

  private argv(resume: boolean): string[] {
    return claudeTuiArgv(this.profile, { ...this.session, started: resume }, this.opts.bin ?? 'claude', this.settingsPath, this.name, this.opts.system, this.opts.mcp);
  }

  private launchedWith(): string | undefined {
    try { return readFileSync(this.launchPath, 'utf8').trim(); } catch { return undefined; }
  }

  /** The first run in a directory asks whether the folder is trusted, with "No, exit" preselected,
   *  and then whether its CLAUDE.md may import files outside it, with "No" preselected again.
   *  routing.yaml already names this directory as the profile's home and the permission mode it
   *  runs under, and the imports are the owner's own shared doctrine, so the answer was given when
   *  that line was written; press it instead of hanging. `accepted` says the cursor is on the yes
   *  row; it is checked before Enter, so a redraw can never turn this into "No". `open` says the
   *  same dialog is still the one on screen; once it is not, no key is sent, since a key meant for
   *  this dialog would answer the next one. */
  private async acceptDialog(open: (pane: string) => boolean, accepted: (pane: string) => boolean): Promise<boolean> {
    for (let i = 0; i < 8; i++) {
      const pane = await this.capture(40);
      if (!open(pane)) return false;
      if (accepted(pane)) { await this.tm(['send-keys', '-t', this.name, 'Enter']); return true; }
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
   *  check it landed, then Enter. Never press Enter on an unverified box. `submit` runs right before
   *  Enter, once the pane is idle and the text has landed: whatever the turn measures from (the
   *  transcript size, the Stop marker, the time) starts there, not before a wait in which someone
   *  else's turn in the Claude app could finish. `gen`: the reader this paste is for; a handoff
   *  during the wait takes the pane, and then nothing is typed into it. */
  private async paste(raw: string, submit: () => void = () => {}, gen = this.gen): Promise<Pasted> {
    // The last gate before text becomes keys: whoever called, no control character reaches the pane.
    const text = cleanText(raw);
    const deadline = Date.now() + (this.opts.promptTimeoutMs ?? PROMPT_TIMEOUT_MS);
    // Whether the screen changed while the message waited: a CLI at work redraws its spinner clock,
    // background agents their rows. A screen that never moved for the whole wait is a hung CLI.
    let moved = false;
    for (let attempt = 1; ; attempt++) {
      let pane = await this.capture(30);
      while (!paneIdle(pane)) {
        if (!(await this.sessionAlive())) return { ok: false, why: 'exit', keep: false };
        if (gen !== this.gen) return { ok: false, why: 'released', keep: true };
        if (Date.now() > deadline) return this.notTyped(pane, moved);
        await sleep(POLL_MS);
        const now = await this.capture(30);
        if (now !== pane) moved = true;
        pane = now;
      }
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      if ((await loadBuffer(this.name, text, this.dir, (a) => this.tm(a))).code !== 0) {
        this.emit('log', `tmux: the message could not be loaded into a paste buffer pane=${this.name}`);
        return { ok: false, why: 'tmux could not load the message into the session', keep: true };
      }
      await this.tm(['paste-buffer', '-p', '-d', '-b', this.name, '-t', this.name]);
      const landBy = Date.now() + (this.opts.landMs ?? LAND_MS);
      let why = 'the pasted message never showed in the box';
      // Nothing was submitted, so the paste may be tried again from the wait for the prompt.
      let again = true;
      while (Date.now() < landBy) {
        await sleep(300);
        const now = await this.capture(20);
        if (!pasteLanded(now, text)) continue;
        // A turn started in the app between the idle check and now: Claude would queue our text
        // after it, and its answer would look like ours. Clear the box and say no.
        if (gen !== this.gen || paneBusy(now)) { why = 'the pane became busy before Enter'; break; }
        submit();
        if (await submitPasted(text, () => this.capture(20), () => this.tm(['send-keys', '-t', this.name, 'Enter']))) return { ok: true };
        // Enter was pressed: Claude may yet take it, and a second paste would send it twice.
        why = 'the pasted message was not taken after three Enters';
        again = false;
        break;
      }
      this.emit('log', `tmux: ${why} (attempt ${attempt}) pane=${this.name}`);
      await this.tm(['send-keys', '-t', this.name, 'C-u']); // clear whatever landed, submit nothing
      if (gen !== this.gen) return { ok: false, why: 'released', keep: true };
      if (!again || attempt >= PASTE_TRIES || Date.now() > deadline) {
        return { ok: false, why: again ? 'Claude Code did not show the pasted message' : 'Claude Code did not take the message', keep: true };
      }
      moved = true; // it drew a prompt since the wait began
    }
  }

  /** The message waited the whole bound for a prompt that never came. Kept (the chat is told to send
   *  it again, the pane goes on) unless the pane looks hung: its screen never moved, no dialog waits
   *  for a person, and no turn of this chat ever started background work in it. Only then may it be
   *  ended, as a dead one would. Never a key into what holds it: a dialog is answered by a person.
   *  Only a real permission dialog counts as one. Any other screen with no input box that is not at
   *  work (a stuck login, a menu, an error) is ended and started fresh, as before 0.4.1: kept, it
   *  would hold the chat for good (review fix L5). */
  private notTyped(pane: string, moved: boolean): Pasted {
    const dialog = permissionDialog(pane) !== null;
    // Which background tasks are still open is not tracked here: any the chat's turns started counts.
    const tasks = this.ours.size;
    const mins = Math.round((this.opts.promptTimeoutMs ?? PROMPT_TIMEOUT_MS) / 60_000);
    const wait = mins >= 1 ? `${mins} minute${mins === 1 ? '' : 's'}` : 'a while';
    this.keepScreen('not-typed.txt', `no prompt for ${wait}`);
    if (!dialog && !paneBusy(pane) && !paneHasBox(pane)) {
      this.emit('log', `tmux: no prompt for ${wait}, no input box and no permission dialog (a login, a menu or an error screen): the pane is ended to start fresh pane=${this.name}`);
      return { ok: false, why: 'stuck', keep: false };
    }
    if (!moved && !dialog && !tasks) {
      this.emit('log', `tmux: no prompt for ${wait} and the screen never moved, no dialog, no background work: the pane looks hung pane=${this.name}`);
      return { ok: false, why: 'hung', keep: false };
    }
    this.emit('log', `tmux: no prompt for ${wait}; the message goes back to the chat and the pane is kept (screen ${moved ? 'moving' : 'still'}, ${dialog ? 'a dialog open' : 'no dialog'}, ${tasks} background task(s) started by this chat) pane=${this.name}`);
    return {
      ok: false, keep: true,
      why: dialog ? 'a dialog is open in the session and waits for an answer in the Claude app or its pane'
        : `the session stayed busy for ${wait} with work of its own (a background task's report, or a turn typed in the Claude app)`,
    };
  }

  /** Keep the screen of a pane whose turn ended or was held on what the screen showed, next to its
   *  settings: the one way to see what it showed, without a terminal open at the right second. One
   *  file per reason, overwritten. In the pane's private folder, not the log: it can show the conversation. */
  private keepScreen(file: string, why: string): void {
    void (async () => {
      try {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        writeFileSync(join(this.dir, file), `${new Date().toISOString()} ${why}\n${await this.capture(40)}\n`, { mode: 0o600 });
      } catch { /* the log line stands on its own */ }
    })();
  }

  async *turn(text: string, o: TurnFlags = {}): AsyncGenerator<BrainEvent> {
    this.lastUsedAt = Date.now();
    const problem = await (this.ready ?? Promise.resolve('brain not started'));
    if (problem) { yield { kind: 'result', text: '', isError: true, reason: problem }; return; }
    if (this.notice) { yield { kind: 'notice', text: this.notice }; this.notice = null; }
    // The session may be busy with a turn typed in the Claude app: the message waits for it, and the
    // chat is told why nothing happens yet.
    // An empty capture is a pane that is gone, which paste() reports; a dialog is not a turn.
    if (paneBusy(await this.capture(30))) yield { kind: 'notice', text: BUSY_PANE_LINE };
    let sentAt = Date.now();
    const gen = this.gen;
    const left: { over?: UnaskedAnswer } = {};
    const submit = () => {
      // A Stop marker still here is of a turn that ended before this one: read as between turns, so a
      // late answer or a task's result is told before this turn's answer, never just deleted.
      left.over = this.takeIdle() ?? undefined;
      this.at = this.from = fileSize(this.transcript); // only rows written from here on are this turn's
      this.rows = 'none';
      rmSync(this.markerPath, { force: true });
      sentAt = Date.now();
      // From here on a marker is this turn's (takeMarker): the reader between turns keeps off it.
      this.turnSentAt = sentAt;
      // A turn typed in the desk app is the owner's own: what it starts is not the chat's (TurnFlags).
      this.recording = !o.app;
      this.heldSince ??= sentAt;
      this.quietEnd = undefined;
      this.typedKey = promptKey(cleanText(text));
    };
    const typed = await this.paste(text, submit, gen);
    if (left.over) yield { kind: 'unasked', ...left.over };
    if (!typed.ok) {
      // Typed or not, no turn of ours runs: a marker that comes now is not this message's answer.
      if (this.turnSentAt === sentAt) this.turnSentAt = undefined;
      this.recording = false;
      if (!this.up || typed.why === 'exit') { yield { kind: 'result', text: '', isError: true, reason: 'exit' }; return; }
      if (typed.why === 'released') { yield { kind: 'result', text: '', isError: true, reason: 'released', keep: true }; return; }
      // A pane that is alive goes on with what it does: its background agents live in it. Only a hung
      // one (notTyped) is given back to be ended.
      if (typed.keep) { yield { kind: 'result', text: '', isError: true, reason: `${NOT_TYPED}: ${typed.why}`, keep: true }; return; }
      yield { kind: 'result', text: '', isError: true, reason: 'the message could not be typed into the session (no prompt, or Claude Code did not take it)' };
      return;
    }
    yield* this.watch(sentAt, false, gen, text.trimStart().startsWith('/'));
  }

  /**
   * Keep the running turn going with nobody reading it: a handoff moved the chat to another session
   * while this one worked. Yields a permission event for each new dialog (nothing answers it from
   * here: it waits, as it would in a forgotten terminal, until someone answers it in the Claude app,
   * in tmux, or after `/resume`), and a result once the turn is over. No time limit.
   */
  backgroundTurn(): AsyncGenerator<BrainEvent> {
    const gen = ++this.gen;
    this.recording = false; // nobody reads it for the chat: what it starts from here is not the chat's
    this.permissions.clear();
    this.stopBeat();
    this.stopIdle();
    this.up = false;
    return this.watch(this.turnSentAt ?? Date.now(), true, gen);
  }

  /** Read the running turn again, in the foreground: `/resume` of a session sent to the background.
   *  The pane is this brain's again from the call on (alive, reader switched); what the result yields
   *  is what `turn` would have. */
  follow(): AsyncGenerator<BrainEvent> {
    const gen = ++this.gen;
    // The rows read now may reach back to the transcript's start (an adopted pane): none of their
    // tasks is taken for the chat's.
    this.recording = false;
    // And no typed key to hold the turn's marker to: what this object typed last may be of another turn.
    this.typedKey = '';
    this.stopIdle();
    this.up = true;
    this.ready = Promise.resolve(null);
    this.lastUsedAt = Date.now();
    this.turnSentAt ??= Date.now();
    this.heldSince ??= this.turnSentAt;
    // The rows written while nobody read are not shown again (the events are dropped), but they say
    // where the turn stands (a tool that runs still, an answer owed), so the quiet pane cannot end it
    // early from here either. Read as every poll reads, so the turn's rows start on a whole line.
    this.readTranscript();
    this.from = this.at;
    return this.watch(this.turnSentAt ?? Date.now(), false, gen);
  }

  /** Take over a pane that runs already, without starting one: a restarted daemon finds a turn it had
   *  sent to the background. False when nothing runs under this name any more. */
  async adopt(turnSentAt: number): Promise<boolean> {
    this.turnSentAt = turnSentAt;
    if ((await this.tm(['has-session', '-t', this.name])).code !== 0) return false;
    this.ready = Promise.resolve(null);
    return true;
  }

  /** The polling half of a turn. `background`: no permission book and no relay (nobody in the chat
   *  answers), and no hourly line. Ends early, as a failed result, once another reader takes the pane
   *  (`gen` moved). `command`: the turn is a slash command typed as is, which the CLI may answer
   *  itself, so an end with no answer is expected. */
  private async *watch(sentAt: number, background: boolean, gen: number, command = false): AsyncGenerator<BrainEvent> {
    let pending: string | null = null;
    // Relayed requests by id, and those answered in the pane or the app whose outcome the transcript
    // has yet to show.
    const asked = new Map<string, { tool: string; input: unknown }>();
    const deciding = new Map<string, { tool: string; input: unknown; since: number }>();
    const dialogs = new DialogWatch();
    const screen = new ScreenDialogs();
    let quietSince = 0, held = false, grewAt = 0, failed = false;
    // The screen above the box's foot, and when it last changed.
    let lastAbove = '', aboveAt = 0;
    const quietMs = this.opts.quietMs ?? QUIET_MS, quietTextMs = this.opts.quietTextMs ?? QUIET_TEXT_MS, quietOpenMs = this.opts.quietOpenMs ?? QUIET_OPEN_MS;
    let hours = 0, lastPane = '', movedAt = Date.now();
    // A dialog still open when the turn ends can no longer be answered from the chat: its timer goes too.
    // A turn read for the chat leaves the session held: from here the reader between turns looks at it.
    const over = (): void => { this.turnSentAt = undefined; this.recording = false; this.lastUsedAt = Date.now(); this.permissions.clear(); if (!background) { this.stopBeat(); this.startIdle(); } };
    // How the turn ended, for the log: which path, how long it ran and how long its answer is, never the words.
    const ended = (how: string, answer: string): void => { this.emit('log', `tmux: turn ended by ${how} after ${Math.round((Date.now() - sentAt) / 1000)} s, answer ${answer.length} chars pane=${this.name}`); };
    if (!background) this.startBeat(gen);
    try {
      for (;;) {
        await sleep(POLL_MS);
        if (gen !== this.gen) { this.recording = false; yield { kind: 'result', text: '', isError: true, reason: 'released' }; return; }
        const h = Math.floor((Date.now() - sentAt) / TURN_NOTICE_MS);
        if (!background && h > hours) {
          hours = h;
          const still = Math.floor((Date.now() - movedAt) / 60_000);
          // A notice, not a progress line: the answer is never taken for a repeat of it.
          yield { kind: 'notice', text: still >= STILL_MS / 60_000
            ? `Nothing has moved in this turn for ${still} minutes; it may be stuck. /stop ends it.`
            : `Still working on this turn after ${h === 1 ? 'an hour' : `${h} hours`}. /stop ends it.` };
        }
        const readTo = this.at;
        const rows = this.readTranscript();
        if (this.at !== readTo) grewAt = Date.now(); // a row of any kind, bookkeeping too
        if (rows.length) { quietSince = 0; movedAt = Date.now(); }
        // This turn's reader: whether the CLI's error row is the last word it read (turnRows).
        if (this.at !== readTo) failed = this.rows === 'error';
        for (const ev of rows) {
          if (ev.kind === 'text') { if (pending) yield { kind: 'progress', text: pending }; pending = ev.text; }
          else if (pending) { yield { kind: 'progress', text: pending }; pending = null; }
        }
        // A turn Claude Code started by itself ended while this one waited to be taken (a task's end
        // was queued first): that marker is no answer to this turn. Told as between turns, and this
        // turn waits on for its own.
        if (!background) {
          const m = this.readMarker();
          if (m?.at && m.at >= sentAt && m.origin === 'notification') {
            // Its last text was read here as this turn's: it is that turn's answer, never a progress line of this one.
            pending = null;
            const a = this.takeIdle(true, failed);
            if (a) yield { kind: 'unasked', ...a };
            // That error row was the other turn's: it says nothing of this turn's own answer.
            failed = false;
            continue;
          }
          // A turn whose one typed prompt is not what this turn typed: someone pressed Enter in the
          // app in the gap before Angelia's Enter. Its answer is theirs; this turn waits for its own.
          // Not for a slash command, whose row is not the text typed.
          if (m?.at && m.at >= sentAt && !command && m.origin === 'prompt' && m.prompts === 1 && typeof m.prompt_key === 'string' && this.typedKey && m.prompt_key !== this.typedKey) {
            rmSync(this.markerPath, { force: true });
            pending = null;
            const text = String(m.text ?? '').trim();
            // One fixed line: `angelia health` counts it, and the canary fails on it (a new Claude Code
            // that stores a typed prompt another way would drop every answer here).
            this.emit('log', `${KEY_MISS_LINE} prompts=1 chars=${text.length} pane=${this.name}`);
            continue;
          }
        }
        const done = this.takeMarker(sentAt);
        if (deciding.size) yield* this.decide(deciding, done !== null);
        if (done !== null) {
          over();
          ended('the Stop marker', done);
          yield { kind: 'result', text: done, isError: false };
          return;
        }
        // After the progress lines, so the chat reads what the agent said before what it asks to run.
        if (!background) {
          for (const r of this.relay.take()) {
            this.relayedAt = Date.now();
            this.permissions.add(r.id);
            asked.set(r.id, { tool: r.tool, input: r.input });
            yield relayedPermission(r);
          }
          // Answered in the app or in the terminal: Claude ended the hook. The transcript says how.
          for (const id of this.relay.gone()) {
            this.relayedAt = Date.now();
            this.permissions.take(id);
            const a = asked.get(id);
            if (a) { asked.delete(id); deciding.set(id, { ...a, since: Date.now() }); }
          }
        }
        const pane = await this.capture(30);
        if (pane !== lastPane) {
          lastPane = pane; movedAt = Date.now();
          const above = paneAboveFoot(pane);
          if (above !== lastAbove) { lastAbove = above; aboveAt = Date.now(); }
        }
        const open = permissionDialog(pane);
        if (background) {
          // Told to the chat once, and answered in the app or the pane: nobody answers from the chat.
          const seen = dialogs.see(open, () => true);
          if (seen.announce && open) yield { kind: 'permission', id: seen.announce, tool: open.tool, preview: open.preview };
        } else if (screen.see(open ? `${open.tool}\n${open.preview}` : null, this.permissions.size > 0 || Date.now() - this.relayedAt < REASK_MS)) {
          yield { kind: 'notice', text: screenOnlyLine(this.name, this.socket) };
        }
        if (!pane && (await this.tm(['has-session', '-t', this.name])).code !== 0) {
          if (!background) this.up = false;
          over();
          yield { kind: 'result', text: '', isError: true, reason: 'exit' };
          return;
        }
        // A relayed request waits on the hook, and the pane may look idle while it does.
        if (paneIdle(pane) && !dialogs.open && !open && !this.permissions.size) {
          if (!quietSince) quietSince = Date.now();
          else if (Date.now() - quietSince <= quietMs) { /* not quiet long enough yet */ }
          else if (this.rows === 'open' && Date.now() - Math.max(quietSince, grewAt, aboveAt) <= quietOpenMs) {
            // The screen reads idle, and the transcript says the turn is open: a tool runs, or the
            // model owes its answer. The screen is a drawing that changes between versions: a foot it
            // had not seen before read as idle and cut working turns (2.1.329). So the screen alone
            // never ends an open turn: the Stop marker does, or rows that close it, or QUIET_OPEN_MS
            // with no new row and nothing moving above the box's foot.
            if (!held) {
              held = true;
              this.emit('log', `tmux: the pane reads idle ${Math.round((Date.now() - sentAt) / 1000)} s into the turn, but its transcript shows the turn open; waiting for the Stop marker (screen kept in idle-open.txt) pane=${this.name}`);
              this.keepScreen('idle-open.txt', 'the pane read idle while the transcript showed the turn open');
            }
          } else if (this.rows === 'said' && Date.now() - Math.max(quietSince, grewAt) <= quietTextMs) {
            // Text is the last row: a tool call may still follow it (QUIET_TEXT_MS).
          } else {
            // No Stop event is coming: either the CLI answered the message itself, or the hook failed
            // and the transcript holds the answer.
            over();
            const stood = { none: 'has no turn', command: 'has a slash command only', said: 'ends with text', error: 'ends with an error row of the CLI',
              open: `open, no new row and nothing moving above the input box for ${Math.round((Date.now() - Math.max(quietSince, grewAt, aboveAt)) / 1000)} s` }[this.rows];
            const how = `the quiet pane (no Stop marker; transcript ${stood})`;
            const answer = pending ?? '';
            ended(how, answer);
            // The Stop marker may still come (a failed read of the screen, a slow hook): then it is this
            // turn's answer, late (takeIdle).
            if (!background) this.quietEnd = { sentAt, endedAt: Date.now(), said: answer, key: this.typedKey };
            // No answer at all, and not to a slash command: the chat may be told the agent gave none, so
            // keep the screen that read as idle.
            if (!answer && (!command || this.rows === 'open')) this.keepScreen('quiet-empty.txt', `the turn ended by ${how} with no answer`);
            yield { kind: 'result', text: answer, isError: false };
            return;
          }
        } else quietSince = 0;
      }
    } finally {
      // However the reader ends (an answer, an exit, let go of, or abandoned by its caller), its
      // heartbeat ends with it, unless a newer reader has taken the pane since.
      if (!background && this.beating?.gen === gen) this.stopBeat();
    }
  }

  /** Report each request answered in Claude's own dialog once the transcript shows how it went. A
   *  refusal is written at once; a call still without a result after DECIDE_MS was allowed and runs.
   *  A call the transcript does not show is not guessed at. `last`: the turn ends, decide now. */
  private *decide(deciding: Map<string, { tool: string; input: unknown; since: number }>, last: boolean): Generator<BrainEvent> {
    const chunk = readSlice(this.transcript, this.from);
    for (const [id, d] of deciding) {
      const v = paneVerdict(chunk, d.tool, d.input);
      const late = last || Date.now() - d.since > DECIDE_MS;
      if (typeof v === 'boolean' || (v === 'running' && late)) yield { kind: 'permission-answered', id, allow: v !== false };
      else if (!late) continue;
      else this.emit('log', `permission ${id.slice(0, 8)} answered in the pane; the transcript does not show how`);
      deciding.delete(id);
    }
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
      const rows = buf.subarray(0, cut).toString('utf8');
      this.rows = turnRows(rows, this.rows);
      // Started while a turn of Angelia's was read: its end may wake the agent, and that answer is the chat's.
      if (this.recording) for (const id of backgroundStarts(rows, this.calls)) {
        this.ours.add(id);
        if (this.ours.size > OURS_MAX) this.ours.delete(this.ours.values().next().value!);
      }
      return transcriptEvents(rows);
    } catch {
      return [];
    } finally {
      closeSync(fd);
    }
  }

  /** The Stop hook's file as it stands, or null: none, or one not whole or not the hook's. */
  private readMarker(): Marker | null {
    if (!existsSync(this.markerPath)) return null;
    try {
      const row: unknown = JSON.parse(readFileSync(this.markerPath, 'utf8'));
      return row && typeof row === 'object' && typeof (row as Marker).at === 'number' ? row as Marker : null;
    } catch { return null; }
  }

  /** The Stop hook's file, but only when it belongs to this turn: a session the user drives from
   *  the Claude app writes markers too, and one of those must never be sent as an answer. Between
   *  turns the same file is read by takeIdle, which holds to that rule by what started the turn. */
  private takeMarker(sentAt: number): string | null {
    const row = this.readMarker();
    if (!row?.at || row.at < sentAt) return null;
    rmSync(this.markerPath, { force: true });
    if (row.transcript_path && row.transcript_path !== this.transcript) {
      this.transcript = row.transcript_path;
      const id = sessionOf(row.transcript_path);
      if (id && id !== this.session.id) this.backendSessionId = id; // the CLI forked the session
    }
    return String(row.text ?? '');
  }

  /**
   * A Stop marker that came with no turn of Angelia's open: taken (the file goes), and returned when it
   * is an answer the chat should get.
   *
   * Late: the last turn typed here was closed without its marker (the quiet path), and this one is that
   * turn's. The hook says when the turn's last typed row was written (`prompt_at`): Angelia's own
   * message is typed between that turn's Enter and its close, a turn someone typed in the Claude app
   * afterwards is not. The key of the turn's one typed prompt must be the key of what Angelia typed
   * (`prompt_key`). Delivered unless the chat already has these words as that turn's answer.
   *
   * Self-started: the hook says Claude Code queued what started the turn (`origin: notification`),
   * and each task whose end it names (`origin_ids`) was started while a turn of Angelia's was read
   * (`ours`); such a marker counts as use of the session (lastUsedAt), sent or not. A turn a person
   * typed (`prompt`), one the hook could not place (`unknown`, or a marker of an older hook with no
   * origin), or one that names no task of Angelia's turns, is never delivered: the owner is working
   * in the app. `inTurn`: found while a turn of Angelia's waits for its own marker (that turn's reader
   * reads the rows, and nothing is late).
   *
   * Never the CLI's own error row or usage limit, an empty answer, or `[SILENT]`. Each marker not
   * delivered is one log line with the reason, never the words.
   */
  private takeIdle(inTurn = false, turnFailed = false): UnaskedAnswer | null {
    const m = this.readMarker();
    if (!m?.at) return null;
    rmSync(this.markerPath, { force: true });
    const text = String(m.text ?? '').trim();
    const no = (why: string): null => { this.emit('log', `tmux: a turn ended between turns and its answer is not delivered: ${why}; ${text.length} chars pane=${this.name}`); return null; };
    if (m.transcript_path && m.transcript_path !== this.transcript) {
      if (sessionOf(m.transcript_path) !== sessionOf(this.transcript)) return no('it is of another session (started in the Claude app)');
      this.transcript = m.transcript_path; // the same file under another spelling of its folder
    }
    // The rows since the last look: whether the CLI's error row is the last word. Not inside a turn:
    // its own reader reads them, for the chat, and says what it found (`turnFailed`).
    if (!inTurn) this.readTranscript();
    const failedRow = inTurn ? turnFailed : this.rows === 'error';
    const late = inTurn ? undefined : this.quietEnd;
    if (late && m.at >= late.sentAt) {
      // Whatever this marker is, the turn closed on the quiet path is over: a Stop only comes after it.
      this.quietEnd = undefined;
      const typedAt = typeof m.prompt_at === 'number' ? m.prompt_at : undefined;
      if (m.origin !== 'notification' && typedAt !== undefined && typedAt >= late.sentAt - 1000 && typedAt <= late.endedAt) {
        // And its one typed prompt is what Angelia typed (the hook's key of it): a turn someone typed in
        // the app inside that window, or into that turn, is theirs.
        if (m.prompt_key !== late.key || m.prompts !== 1) return no('late, but the prompt the hook read is not the one Angelia typed');
        // A usage limit comes as the CLI's error row too: named as what it is.
        if (isLimitText(text)) return no('late, and a usage limit of the CLI');
        if (failedRow) return no('late, and an API error of the CLI, not an answer');
        if (!text) return no('late, with no text');
        if (text === SILENT) return no('late, and [SILENT]');
        // The same words, or the lines before them too, which went out as progress lines.
        if (sameAnswer(text, late.said)) return no('late, and the chat has it as the turn\'s answer');
        return { answer: 'late', text };
      }
    }
    if (m.origin !== 'notification') {
      const why = typeof m.origin_why === 'string' ? m.origin_why.replace(/[^\w <>(),-]/g, '').slice(0, 120) : '';
      return no(m.origin === 'prompt' ? `a person typed it in the Claude app or the pane${why ? ` (${why})` : ''}` : `what started it is not known${why ? ` (${why})` : ''}`);
    }
    if (this.heldSince === undefined || m.at < this.heldSince) return no('it ended before this session was read');
    // Only the end of work a turn of Angelia's started: the owner's own background work, a prompt the
    // session scheduled, a message from a teammate stay in the app.
    const ids = Array.isArray(m.origin_ids) ? m.origin_ids.filter((x): x is string => typeof x === 'string') : [];
    if (!ids.length || !ids.every((id) => this.ours.has(id))) return no(ids.length ? 'the work it reports was not started by a turn of this chat' : 'nothing ties it to work a turn of this chat started');
    // A session woken by the end of the chat's own work is in use, whatever it then says (nothing,
    // [SILENT], an error): its idle time starts again, so long background work stays read while it is
    // active. Only tied ends count: the owner's own work in the app does not hold the pane.
    this.lastUsedAt = Date.now();
    if (isLimitText(text)) return no('a usage limit of the CLI');
    if (failedRow) return no('an API error of the CLI, not an answer');
    if (!text) return no('no text');
    if (text === SILENT) return no('[SILENT]');
    return { answer: 'self', text };
  }

  /** Read the Stop marker between turns, from the end of this session's first turn here until the
   *  pane is let go of, stopped or handed off (`gen`). While a turn of Angelia's runs it keeps off:
   *  from the turn's Enter on, a marker is that turn's answer. One file check per tick, nothing else. */
  private startIdle(): void {
    if (this.idle || !this.up) return;
    const gen = this.gen;
    this.idle = setInterval(() => {
      if (gen !== this.gen || !this.up) { this.stopIdle(); return; }
      if (this.turnSentAt !== undefined) return;
      try {
        const a = this.takeIdle();
        if (a) this.emit('unasked', a);
      } catch (e) { this.emit('log', `tmux: reading between turns failed: ${(e as Error).message} pane=${this.name}`); }
    }, this.opts.idlePollMs ?? IDLE_POLL_MS);
    this.idle.unref();
  }

  private stopIdle(): void {
    if (this.idle) clearInterval(this.idle);
    this.idle = undefined;
  }

  /** A chat answer goes to the hook waiting on that request, and to no other; no key is pressed. False
   *  when that hook has stepped aside already: Claude then asks in its own dialog. */
  answerPermission(id: string, allow: boolean, how: PermissionAnswer = {}): boolean {
    const full = this.permissions.take(id);
    if (!full) return false;
    this.relayedAt = Date.now();
    return this.relay.answer(full, allow, how.message);
  }

  /** The hook relays while this beats: written now, then every RELAY_BEAT_MS, whatever the reader is
   *  waiting on. One reader beats at a time. */
  private startBeat(gen: number): void {
    if (this.beating) clearInterval(this.beating.timer);
    this.relay.beat();
    const timer = setInterval(() => this.relay.beat(), RELAY_BEAT_MS);
    timer.unref();
    this.beating = { timer, gen };
  }

  /** Nobody reads the chat now: a waiting hook steps aside at once. */
  private stopBeat(): void {
    if (this.beating) clearInterval(this.beating.timer);
    this.beating = undefined;
    this.relay.quiet();
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
    this.gen++; // a turn being read stops being read; the pane goes on with it
    this.recording = false;
    this.permissions.clear();
    this.stopBeat();
    // Nobody reads it between turns either: what the session says by itself from here on stays in it.
    this.stopIdle();
    this.quietEnd = this.heldSince = undefined;
    this.up = false;
  }

  async stop(): Promise<void> {
    this.gen++;
    this.permissions.clear();
    this.stopBeat();
    this.stopIdle();
    this.quietEnd = this.heldSince = undefined;
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
 * Which permission dialog on the pane is new, one poll at a time, for a turn read in the background:
 * the chat hears of each once. A dialog that was answered can be followed by the next one before any
 * poll sees the pane without a dialog: that one is announced when it asks something else, or when the
 * same question is still up once the answer had time to land.
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

/** True when `dir`, as Claude Code's add-dir dialog shows it, is one of the profile's add_dirs
 *  (a leading ~ is the home folder; a trailing slash does not count). A relative entry is resolved
 *  against `base`, the profile's cwd, where claude runs and resolves it too. */
export function addDirListed(dir: string, addDirs: string[], home = homedir(), base = process.cwd()): boolean {
  if (!dir) return false;
  // Claude shows the folder as it resolved it (/tmp is /private/tmp on macOS), so the real path counts too.
  const forms = (d: string) => {
    const p = resolve(base, d.replace(/^~(?=$|\/)/, home)).replace(/(.)\/+$/, '$1');
    try { return [p, realpathSync(p)]; } catch { return [p]; }
  };
  const want = forms(dir);
  return addDirs.some((d) => forms(d).some((f) => want.includes(f)));
}

/** Where a turn stands by its transcript rows. `none`: nothing of a turn was written (the CLI answered
 *  the message itself), or the turn was cut short (Esc, a "No" in Claude Code's own dialog).
 *  `command`: a slash command's row and nothing after it; the CLI may answer it itself, so it counts
 *  as `none` until a prompt for the model follows. `open`: the last row is a prompt, a tool call,
 *  thinking or a tool result, so a tool runs or the model owes an answer. `said`: the last row is the
 *  assistant's text, which ends a finished turn, or comes before a tool call not written yet.
 *  `error`: the last row is the CLI's own row for a failed API call or a usage limit
 *  (`isApiErrorMessage`, or an `error` on the row), after which nothing follows; its text is the
 *  turn's answer, as it was before. */
export type TurnRows = 'none' | 'command' | 'open' | 'said' | 'error';

/** A user row that is the CLI's record of a slash command, not a prompt for the model. */
const COMMAND_ROW = /^<command-(name|message|args)>/;
/** What the CLI wrote around a command it ran itself: its output, and the caveat before it. */
const LOCAL_ROW = /^<local-command-[a-z]+>/;
/** What Claude Code writes as a user row when a turn is cut short with Esc (with or without "for
 *  tool use"); no Stop hook runs after it. Not measured on 2.1.329: the text is Claude Code's own. */
const INTERRUPTED = '[Request interrupted by user';
/** A tool result that says the person refused the call in Claude Code's own dialog (paneVerdict in
 *  tui-permissions.ts reads the same two shapes). The turn stops there, with no Stop hook. */
function refused(row: { toolUseResult?: unknown }, b: { is_error?: unknown; content?: unknown }): boolean {
  return row.toolUseResult === REJECTED || (b.is_error === true && (typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')).startsWith("The user doesn't want to proceed"));
}

/**
 * Where the turn stands after the rows in `chunk`, starting from `state`. The last row that counts
 * decides. Rows that count are the session's own user and assistant message rows, as the other
 * readers here take them (history.ts, the Stop hook's finalText): not a subagent's (isSidechain), not
 * the bookkeeping Claude Code writes between them (system and queue-operation rows, snapshots). A row
 * may hold one content block or several; they are read in order, so text followed by a tool call
 * reads `open`. A meta row counts only right after a slash command's row: it is then the prompt the
 * command made for the model (a skill's text), and the model works from there.
 */
export function turnRows(chunk: string, state: TurnRows = 'none'): TurnRows {
  for (const line of chunk.split('\n')) {
    if (!line.includes('"user"') && !line.includes('"assistant"')) continue; // most rows are bookkeeping
    let row: { type?: unknown; isSidechain?: unknown; isMeta?: unknown; isCompactSummary?: unknown; isVisibleInTranscriptOnly?: unknown; isApiErrorMessage?: unknown; error?: unknown; toolUseResult?: unknown; message?: { content?: unknown } } | null;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || row.isSidechain === true) continue;
    const content = row.message?.content;
    const blocks = (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []) as { type?: unknown; text?: unknown; is_error?: unknown; content?: unknown }[];
    if (row.type === 'assistant') {
      if (row.isApiErrorMessage === true || (typeof row.error === 'string' && row.error.length > 0)) { state = 'error'; continue; }
      for (const b of blocks) {
        if (b?.type === 'text') { if (String(b.text ?? '').trim()) state = 'said'; }
        // A tool call, or thinking: the model is at work.
        else if (b?.type === 'tool_use' || b?.type === 'thinking' || b?.type === 'redacted_thinking') state = 'open';
      }
    } else if (row.type === 'user') {
      if (row.isCompactSummary === true || row.isVisibleInTranscriptOnly === true) continue;
      const text = blocks.map((b) => (b?.type === 'text' ? String(b.text ?? '') : '')).join('\n').trim();
      if (row.isMeta === true) { if (state === 'command' && !LOCAL_ROW.test(text)) state = 'open'; continue; }
      const results = blocks.filter((b) => b?.type === 'tool_result');
      if (text.startsWith(INTERRUPTED) || results.some((b) => refused(row, b))) state = 'none';
      else if (results.length) state = 'open';
      else if (LOCAL_ROW.test(text)) { if (state === 'command') state = 'none'; }
      else if (COMMAND_ROW.test(text)) { if (state === 'none') state = 'command'; }
      // A prompt: typed, or one Claude Code wrote for the model (a hook's feedback, an image).
      else if (text || blocks.length) state = 'open';
    }
  }
  return state;
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

/** The transcript from `from` on, at most the last TRANSCRIPT_SLICE_MAX bytes of it. */
function readSlice(path: string, from: number): string {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return ''; }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(from, size - TRANSCRIPT_SLICE_MAX);
    if (size <= start) return '';
    const buf = Buffer.allocUnsafe(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

/** The session a transcript file is of: its name without the extension. */
function sessionOf(path: string): string | undefined {
  return path.split('/').pop()?.replace(/\.jsonl$/, '');
}

function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}
