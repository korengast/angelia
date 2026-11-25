import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { RECORD, type CompiledRecord } from '../capabilities/compile.js';
import { isLimitText } from '../core/deliver/text.js';
import type { BrainEvent } from '../core/types.js';
import { Config } from '../instance/config/schema.js';
import { INSTANCE_DIR } from '../instance/instance.js';
import { childEnv } from './argv.js';
import { catalog } from './catalog.js';
import { DEFAULT_BIN, locateBin } from './locate.js';
import { paneBusy, paneIdle, tmux, tmuxSocketPath } from './tmux.js';
import { projectFolder, projectsDir } from './transcripts.js';
import { KEY_MISS_LINE, QUIET_MS, TuiBrain, tmuxVersion } from './tui.js';

/**
 * `angelia canary`: tmux mode tried for real against the Claude Code build installed now, in a pane
 * nobody uses. tmux mode reads a screen and a transcript, and a new build of the CLI can change
 * either (a new start dialog, a taller foot under the input box); until now the owner learned of it
 * from answers that never came. This runs the same TuiBrain the daemon runs, on a tmux server of its
 * own and in a folder made for it, and says which of five things no longer holds.
 *
 * The pane is held as a chat's pane is, not looser: permission mode `default`, so its one shell
 * command comes to the canary as a permission request through the relay hook, and the canary allows
 * that exact command and nothing else; and no MCP server, the owner's own included.
 *
 * It costs a few model calls on the owner's plan each time (three short turns on the cheapest model), so
 * `--if-new-build` runs it only when `claude --version` is not the build that last passed.
 */

export const CHECKS = ['start', 'pong', 'multi-line paste', 'tool run', 'idle after', 'slash command'] as const;
export type CheckName = (typeof CHECKS)[number];
export interface CanaryCheck { name: CheckName; ok: boolean; ms: number; detail: string; skipped?: true }
/** What a run of the checks gives. `unjudged`: why the build could not be judged (the plan's limit, a
 *  failed API call, a lost login): neither a pass nor a fail, and nothing to record. */
export interface CanaryRun { checks: CanaryCheck[]; unjudged?: string }

/** How long the shell command of the tool turn sleeps: longer than the quiet wait (QUIET_MS, 12 s),
 *  which is the wait a pane misread as idle would end the turn after. */
export const TOOL_SLEEP_S = 20;
/** The files that command makes in the pane's folder, before and after its sleep: between the two
 *  the command runs, whatever the screen says. */
const STARTED = 'canary-started', FINISHED = 'canary-finished';
/** The one shell command the pane is asked to run, and the only one the canary allows. */
export const toolCommand = (sleepS: number): string => `touch ${STARTED} && sleep ${sleepS} && touch ${FINISHED}`;
/** A slash command Claude Code answers itself, with no model call and no dialog: the turn has no Stop
 *  event, so it ends by the quiet pane. `/clear` is not a router command (commands.ts), so a chat's
 *  `/clear` reaches the CLI as this does; it empties the conversation, which in this pane is the last thing anyone needs.
 *  Measured on 2.1.329: ended by the quiet pane after 14 s. `/cost` and `/status` open a panel there
 *  that only Esc closes, so a turn with either never ends. */
export const SLASH_COMMAND = '/clear';
/** A chat turn as Angelia types one: several lines, Hebrew, an envelope and a quoted line. Claude Code
 *  stores a paste of several lines in the transcript another way than a one-line one (2.1.330 wraps it
 *  in tags), and the Stop hook's key of the typed prompt must still be the key of what was typed: on a
 *  miss the turn drops its own marker (KEY_MISS_LINE) and the chat gets no answer. */
export const PASTE_TEXT = ['[canary chat · Owner · a check of the build]', 'Replying to (quoted by the sender\'s app; author not verified):', '> שורה מצוטטת', '', 'שלום. Reply with the single word pasted'].join('\n');
/** How long the pane may take to read idle after a turn's answer: the owner's own Stop hooks, which
 *  Claude Code runs beside Angelia's, hold the spinner until they end. */
const IDLE_LIMIT_MS = 30_000;
/** How long past the quiet wait the slash command may take before the pane is stopped. */
const COMMAND_LIMIT_MS = 60_000;
/** The longest a model turn may take before the canary stops the pane and calls it failed: a tmux turn
 *  has no time limit of its own. */
const TURN_LIMIT_MS = 3 * 60_000;

export interface CanaryWaits {
  /** TuiBrain's quiet wait, as the brain under test was given it. */
  quietMs: number;
  sleepS: number;
  /** How often the screen is read while the command runs. */
  sampleMs: number;
  turnMs: number;
  /** How long the pane may take to read idle after a turn. */
  idleMs: number;
  /** How far past the quiet wait the slash command's end may come, in seconds, and how long past it
   *  the pane is given before it is stopped. */
  commandSlackS: number;
  commandMs: number;
}

/** What the checks need of a pane: TuiBrain's own surface, and the screen. */
export interface CanaryBrain {
  start(): void;
  whenReady(): Promise<string | null>;
  turn(text: string): AsyncGenerator<BrainEvent>;
  answerPermission(id: string, allow: boolean): boolean;
  stop(): Promise<void>;
  on(event: 'log', fn: (line: string) => void): unknown;
}
export interface CanaryRig {
  brain: CanaryBrain;
  /** The pane's screen now; '' when it cannot be read. */
  capture(): Promise<string>;
  /** The pane's working folder. */
  cwd: string;
  /** Keep a screen for the owner to look at: a failure, or the one screen that did not read busy. */
  keep(file: string, screen: string, why: string): void;
  /** The run was told to stop (a signal): no further check runs. */
  aborted?(): boolean;
}

/** How TuiBrain says a turn ended, from its log lines (tui.ts, `ended`): by the Stop hook's marker, or
 *  by the quiet pane when no marker came. `seconds` is the turn's length as that line counts it. */
export function turnEnd(logs: string[]): { by: 'stop' | 'quiet'; seconds: number } | null {
  const line = logs.filter((l) => l.startsWith('tmux: turn ended by ')).pop();
  const m = line && /^tmux: turn ended by (.*) after (\d+) s, answer \d+ chars/.exec(line);
  if (!m) return null;
  const by = m[1].startsWith('the Stop marker') ? 'stop' : 'quiet';
  return { by, seconds: Number(m[2]) };
}

/** The CLI lost its login: only `claude` then `/login` on the host helps. Kept to what Claude Code
 *  and the API say for it. */
const LOGIN = /not logged in|please run \/login|invalid api key|oauth token (has )?expired|authentication_error/i;
export const loginLost = (text: string): boolean => LOGIN.test(text);

const cut = (text: string, max = 120): string => { const t = text.replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/** Why a turn's result says nothing about the build: the plan ran out, or the CLI lost its login.
 *  Any build ends such a turn the same way. Null: the result can be judged. A short answer that is
 *  the CLI's own login line (it comes as the turn's text) counts as a lost login. */
export function cannotJudge(r: { text: string; isError: boolean; reason?: string }): string | null {
  if (isLimitText(r.text)) return `the plan's usage limit was reached ("${cut(r.text)}")`;
  const reason = r.reason ?? '';
  if ((r.isError && loginLost(reason)) || (r.text.length < 200 && loginLost(r.text))) return `Claude Code lost its login ("${cut(r.text || reason)}")`;
  return null;
}

/** An answer as one bare word: no quotes, stars or full stop around it. */
const word = (text: string): string => text.trim().toLowerCase().replace(/^[\s"'`*]+|[\s"'`*.!]+$/g, '');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The five checks, on a pane that is not started yet. Each says pass or fail and how long it took. A
 * check that cannot run because the pane is gone (it never started, a turn had to be stopped, the
 * build could not be judged, the run was told to stop) is listed as skipped, which counts as not passed.
 */
export async function runChecks(rig: CanaryRig, waits: Partial<CanaryWaits> = {}): Promise<CanaryRun> {
  const w: CanaryWaits = { quietMs: QUIET_MS, sleepS: TOOL_SLEEP_S, sampleMs: 1000, turnMs: TURN_LIMIT_MS, idleMs: IDLE_LIMIT_MS, commandSlackS: 10, commandMs: COMMAND_LIMIT_MS, ...waits };
  const run: CanaryRun = { checks: [] };
  const logs: string[] = [];
  rig.brain.on('log', (l) => logs.push(l));
  /** Why the pane takes no more turns, once it does not. In an object: closures set it. */
  const pane: { gone: string | null } = { gone: null };
  const gone = (): string | null => { if (!pane.gone && rig.aborted?.()) pane.gone = 'the run was stopped'; return pane.gone; };
  const done = (name: CheckName, t0: number, problems: string[], pass: string, file: string, screen?: string): void => {
    const ok = !problems.length;
    run.checks.push({ name, ok, ms: Date.now() - t0, detail: ok ? pass : problems.join('; ') });
    // A turn that could not be judged shows nothing of the build: its screen is not kept.
    if (!ok && screen !== undefined && !run.unjudged) rig.keep(file, screen, problems.join('; '));
  };

  /** One turn, read to its end. Past `limitMs` the screen is kept and the pane stopped, which ends the
   *  read. `allow`: the one request the canary says yes to, by its whole text; any other gets a no. */
  const turn = async (name: CheckName, text: string, limitMs: number, file: string, allow?: string) => {
    const from = logs.length;
    let result: Extract<BrainEvent, { kind: 'result' }> | undefined, timedOut = false, asked = 0;
    const refused: string[] = [];
    const timer = setTimeout(() => {
      timedOut = true;
      const why = pane.gone = `the pane was stopped when the ${name} turn did not end in ${Math.round(limitMs / 1000)} s`;
      void (async () => { rig.keep(file, await rig.capture(), why); await rig.brain.stop(); })();
    }, limitMs);
    try {
      for await (const e of rig.brain.turn(text)) {
        if (e.kind === 'permission') {
          // The request as the relay hook carried it from Claude Code: the command's whole text, with
          // its space collapsed (brain.ts, permissionPreview). Yes to the canary's own, to the letter,
          // and from the shell tool only: no other tool with a `command` input gets it.
          const mine = allow !== undefined && e.tool === 'Bash' && e.preview === allow;
          if (mine) asked++; else refused.push(`${e.tool}: ${cut(e.preview, 100)}`);
          rig.brain.answerPermission(e.id, mine);
        } else if (e.kind === 'result') result = e;
      }
    } finally { clearTimeout(timer); }
    if (!timedOut && result?.isError && result.reason === 'exit') pane.gone = 'the pane exited';
    const problems: string[] = [];
    const end = turnEnd(logs.slice(from));
    const cannot = !timedOut && result ? cannotJudge(result) : null;
    if (cannot) { run.unjudged = cannot; pane.gone = `this build could not be judged (${cannot})`; problems.push(`could not judge: ${cannot}`); }
    else if (timedOut) problems.push(`the turn did not end in ${Math.round(limitMs / 1000)} s`);
    else if (!result) problems.push('the turn gave no result');
    else if (result.isError) problems.push(`the turn failed: ${result.reason ?? 'no reason given'}`);
    if (refused.length) problems.push(`${refused.length === 1 ? 'a permission request' : `${refused.length} permission requests`} that the canary did not expect got a no (${refused[0]})`);
    // A turn that was stopped has its screen kept already, from before the stop; after it there is none.
    return { result, end, problems, asked, held: logs.slice(from).some((l) => l.includes('transcript shows the turn open')), screen: timedOut ? undefined : await rig.capture() };
  };
  const skip = (name: CheckName): void => { run.checks.push({ name, ok: false, ms: 0, detail: `not run: ${pane.gone}`, skipped: true }); };
  const endedBy = (by: string | undefined): string => (by === 'quiet' ? 'the quiet pane' : by === 'stop' ? 'the Stop marker' : 'no path the log names');

  // a. The pane starts and reaches a prompt; TuiBrain answers the start dialogs.
  let t0 = Date.now();
  if (gone()) skip('start');
  else {
    rig.brain.start();
    const problem = await rig.brain.whenReady();
    const first = await rig.capture();
    if (problem) pane.gone = 'the pane did not start';
    done('start', t0, problem ? [problem] : paneIdle(first) ? [] : ['the pane was called ready, but its screen does not read idle'], 'the pane reached a prompt', 'start.txt', first);
  }

  // b. A one-word turn, ended by the Stop marker.
  if (gone()) skip('pong');
  else {
    t0 = Date.now();
    const t = await turn('pong', 'Reply with the single word pong', w.turnMs, 'pong.txt');
    if (!t.problems.length) {
      if (word(t.result!.text) !== 'pong') t.problems.push(`the answer was ${JSON.stringify(t.result!.text.slice(0, 60))}, not pong`);
      if (t.end?.by !== 'stop') t.problems.push(`the turn ended by ${endedBy(t.end?.by)}, not by the Stop marker`);
    }
    done('pong', t0, t.problems, 'answered pong, ended by the Stop marker', 'pong.txt', t.screen);
  }

  // b2. A multi-line paste (a chat turn's shape), ended by the Stop marker with its prompt key matched.
  if (gone()) skip('multi-line paste');
  else {
    t0 = Date.now();
    const from = logs.length;
    const t = await turn('multi-line paste', PASTE_TEXT, w.turnMs, 'multi-line-paste.txt');
    const missed = logs.slice(from).some((l) => l.startsWith(KEY_MISS_LINE));
    if (!t.problems.length) {
      if (missed) t.problems.push('the Stop hook\'s key of the typed prompt did not match what was typed, so the turn dropped its own answer (this build stores a pasted prompt in a way the hook does not read)');
      else if (word(t.result!.text) !== 'pasted') t.problems.push(`the answer was ${JSON.stringify(t.result!.text.slice(0, 60))}, not pasted`);
      if (t.end?.by !== 'stop') t.problems.push(`the turn ended by ${endedBy(t.end?.by)}, not by the Stop marker`);
    }
    done('multi-line paste', t0, t.problems, 'answered pasted, ended by the Stop marker, its prompt key matched', 'multi-line-paste.txt', t.screen);
  }

  // c. One tool run longer than the quiet wait. Its command comes as a permission request through the
  // relay hook, which the canary allows; then the screens read while it runs must read busy.
  if (gone()) skip('tool run');
  else {
    t0 = Date.now();
    const started = join(rig.cwd, STARTED), finished = join(rig.cwd, FINISHED), command = toolCommand(w.sleepS);
    // One screen that does not read busy may be a frame caught half drawn; two in a row are a screen
    // the reader takes for idle, which is what cuts a working turn.
    let samples = 0, notBusy = 0, inRow = 0, worstRow = 0, reading = false;
    const sampler = setInterval(() => {
      if (reading || !existsSync(started) || existsSync(finished)) return;
      reading = true;
      void rig.capture().then((screen) => {
        // Ended while the screen was read: that frame may be the next one. An empty read is no frame.
        if (!screen || existsSync(finished)) return;
        samples++;
        if (paneBusy(screen)) { inRow = 0; return; }
        worstRow = Math.max(worstRow, ++inRow);
        if (!notBusy++) rig.keep('tool-run-not-busy.txt', screen, 'the first screen that did not read busy while the command ran');
      }).finally(() => { reading = false; });
    }, w.sampleMs);
    const prompt = `Run this shell command with the Bash tool, exactly as written, in one call, not in the background: ${command} . When it has ended, reply with the single word done`;
    const t = await turn('tool run', prompt, w.turnMs + w.sleepS * 1000, 'tool-run.txt', command).finally(() => clearInterval(sampler));
    const ran = existsSync(started) && existsSync(finished) ? statSync(finished).mtimeMs - statSync(started).mtimeMs : -1;
    if (!t.problems.length) {
      if (word(t.result!.text) !== 'done') t.problems.push(`the answer was ${JSON.stringify(t.result!.text.slice(0, 60))}, not done`);
      if (t.end?.by !== 'stop') t.problems.push(`the turn ended by ${endedBy(t.end?.by)}, not by the Stop marker`);
    }
    if (!run.unjudged) {
      if (ran < 0) t.problems.push('the command did not run to its end');
      else if (ran < w.quietMs) t.problems.push(`the command ran ${Math.round(ran / 1000)} s, not longer than the quiet wait`);
      else if (!samples) t.problems.push('no screen was read while the command ran');
      if (worstRow >= 2) t.problems.push(`${notBusy} of ${samples} screens did not read busy while the command ran, ${worstRow} of them in a row (the first is kept)`);
      if (t.held) t.problems.push('the pane read idle with the turn open (the daemon would wait on the Stop marker)');
    }
    // Not asked: the owner's own settings allow the command, so Claude Code had nothing to ask.
    const how = t.asked === 1 ? 'asked once, allowed by the relay' : t.asked ? `asked ${t.asked} times, allowed by the relay` : 'not asked: the owner\'s settings allow the command';
    done('tool run', t0, t.problems, `answered done after a ${Math.round(ran / 1000)} s command (${how}), ended by the Stop marker; ${samples - notBusy} of ${samples} screens read busy${notBusy === 1 ? ' (the other is kept)' : notBusy ? ' (the first of the others is kept)' : ''}`, 'tool-run.txt', t.screen);
  }

  // d. After the turn the pane reads idle: the next message can be typed.
  if (gone()) skip('idle after');
  else {
    t0 = Date.now();
    let screen = await rig.capture();
    while (!paneIdle(screen) && Date.now() - t0 < w.idleMs) { await sleep(250); screen = await rig.capture(); }
    done('idle after', t0, paneIdle(screen) ? [] : [`the pane did not read idle within ${Math.round(w.idleMs / 1000)} s of the turn's end`], 'the pane reads idle', 'idle-after.txt', screen);
  }

  // e. A slash command the CLI answers itself: no Stop event comes, so the quiet pane ends it, soon.
  if (gone()) skip('slash command');
  else {
    t0 = Date.now();
    const quietS = Math.ceil(w.quietMs / 1000);
    const t = await turn('slash command', SLASH_COMMAND, w.quietMs + w.commandMs, 'slash-command.txt');
    if (!t.problems.length) {
      if (t.end?.by !== 'quiet') t.problems.push(`${SLASH_COMMAND} ended by ${t.end?.by === 'stop' ? 'the Stop marker (the model answered it)' : 'no path the log names'}, not by the quiet pane`);
      else if (t.end.seconds > quietS + w.commandSlackS) t.problems.push(`${SLASH_COMMAND} ended by the quiet pane after ${t.end.seconds} s, not within ${quietS + w.commandSlackS} s`);
    }
    done('slash command', t0, t.problems, `${SLASH_COMMAND} ended by the quiet pane after ${t.end?.seconds} s`, 'slash-command.txt', t.screen);
  }
  return run;
}

/** The model the pane runs: the cheapest alias Claude Code's catalog has (catalog.ts lists them from
 *  the largest to the smallest). */
export async function canaryModel(): Promise<string> {
  const { models } = await catalog('claude-code', undefined, {});
  return models[models.length - 1].id;
}

/** The pane's own files that TuiBrain keeps when a start or a turn goes wrong (tui.ts). */
const PANE_FILES = ['screen.txt', 'idle-open.txt', 'quiet-empty.txt', 'paste-failed.txt'];

/** A stop asked for from outside (Ctrl-C, a closed terminal, a job's time limit) while a pane is up:
 *  end the pane first. `aborted`: from then on no check runs and nothing more is kept or recorded. */
let cleanupNow: (() => Promise<void>) | null = null;
let aborted = false;

/** A run's tmux server is `angelia-canary-<pid>`, and its temp folder `angelia-canary-<pid>-XXXXXX`:
 *  the pid says whose it is, so what a run that was killed left behind can be told from a run that is
 *  going on now. */
const SERVER_NAME = /^angelia-canary-(\d+)$/, ROOT_NAME = /^angelia-canary-(\d+)-[A-Za-z0-9]{6}$/;

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Remove, and never throw: a busy folder is tried a few times, and a failure is the caller's to name. */
function remove(path: string): boolean {
  try { rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); return true; } catch { return false; }
}

const names = (dir: string): string[] => { try { return readdirSync(dir); } catch { return []; } };

/** Claude Code's folder for the pane's sessions, worked out while the pane's folder is there (it is
 *  named after the resolved path). Null unless the name is one of a canary's: nothing else is removed. */
function projectOf(root: string, projects = projectsDir()): string | null {
  const project = join(projects, projectFolder(join(root, 'canary')));
  return basename(project).includes('angelia-canary-') ? project : null;
}

/**
 * What a canary run that was killed (SIGKILL, a power cut) left behind: its tmux server with the pane
 * in it, its temp folder, its session's transcript. Found by exact name and a pid that no longer
 * runs; a run that is going on is left alone. Returns the names it ended or removed.
 */
export async function sweepOrphans(env: NodeJS.ProcessEnv, o: { socketDir?: string; tmp?: string; projects?: string; alive?: (pid: number) => boolean } = {}): Promise<string[]> {
  const socketDir = o.socketDir ?? dirname(tmuxSocketPath()), tmp = o.tmp ?? tmpdir(), alive = o.alive ?? pidAlive;
  const gone: string[] = [];
  for (const name of names(socketDir)) {
    const m = SERVER_NAME.exec(name);
    if (!m || alive(Number(m[1]))) continue;
    await tmux(['kill-server'], { socket: name, env });
    if (remove(join(socketDir, name))) gone.push(name);
  }
  for (const name of names(tmp)) {
    const m = ROOT_NAME.exec(name);
    if (!m || alive(Number(m[1]))) continue;
    const root = join(tmp, name), project = projectOf(root, o.projects);
    if (remove(root)) gone.push(name);
    if (project) remove(project);
  }
  return gone;
}

/**
 * The checks on a real pane: a tmux server of its own, a folder of its own in the system temp folder,
 * a second one passed as an extra folder (so the add-dir dialog is one of the start dialogs), the
 * cheapest model. The pane is held as a chat's pane is: permission mode `default`, and the compiled
 * record and empty .mcp.json of a profile that is given no MCP server, so Claude Code is started with
 * `--strict-mcp-config` and loads none, the owner's own included (argv.ts, mcpLaunch). The owner's
 * hooks, settings and CLAUDE.md still load: that is how a chat's pane starts too. The pane, the
 * server, the folders and the session's transcript are removed at the end, whatever happened.
 */
export async function liveRun(bin: string, keep: CanaryRig['keep'], keepFile: (name: string, from: string) => void): Promise<CanaryRun> {
  const env = childEnv(process.env);
  await sweepOrphans(env).catch(() => []);
  const root = mkdtempSync(join(tmpdir(), `angelia-canary-${process.pid}-`));
  const cwd = join(root, 'canary'), extra = join(root, 'extra'), stateDir = join(root, 'state');
  const socket = `angelia-canary-${process.pid}`;
  let brain: TuiBrain | undefined;
  const project = { path: null as string | null };
  // Each step on its own: one that fails does not keep the next from running, and none throws, so
  // the checks' result is never lost to the cleanup.
  const cleanup = async (): Promise<void> => {
    cleanupNow = null;
    try { await brain?.stop(); } catch { /* the server goes next */ }
    try { await tmux(['kill-server'], { socket, env }); } catch { /* none was started */ }
    remove(join(dirname(tmuxSocketPath()), socket));
    remove(root);
    if (project.path) remove(project.path);
  };
  cleanupNow = cleanup;
  try {
    for (const d of [cwd, extra, stateDir, join(cwd, '.claude')]) mkdirSync(d, { mode: 0o700 });
    project.path = projectOf(root);
    const record: CompiledRecord = { version: 1, backend: 'claude-code', links: {}, mcpServers: [], mcpStrict: true, deny: [], additionalDirectories: [], blockLines: [], compiledAt: new Date().toISOString() };
    writeFileSync(join(cwd, RECORD), JSON.stringify(record, null, 2));
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2));
    const profile = Config.parse({ profiles: { canary: { cwd, tui: true, permission_mode: 'default', model: await canaryModel(), add_dirs: [extra] } }, routes: [] }).profiles.canary;
    const pane = brain = new TuiBrain(profile, { id: randomUUID(), started: false }, { bin, tmuxSocket: socket, stateDir });
    const logs: string[] = [];
    pane.on('log', (l: string) => logs.push(`${new Date().toISOString()} ${l}`));
    const capture = async (): Promise<string> => {
      const r = await tmux(['capture-pane', '-p', '-t', pane.name, '-S', '-30'], { socket, env });
      return r.code === 0 ? r.out : '';
    };
    const run = await runChecks({ brain: pane, capture, cwd, keep, aborted: () => aborted });
    if (run.checks.some((c) => !c.ok) && !run.unjudged && !aborted) {
      const last = await capture(); // empty when the pane was stopped: the stopped turn's own file has its screen
      if (last) keep('final.txt', last, 'the screen when the checks ended');
      await sleep(300); // TuiBrain writes its own kept screens just after the result
      for (const f of PANE_FILES) keepFile(`pane-${f}`, join(stateDir, 'tui', pane.name, f));
      keep('brain.log', logs.join('\n'), 'what the tmux brain logged');
    }
    return run;
  } finally { await cleanup(); }
}

// ---- the command -------------------------------------------------------------------------------

const STATE_FILE = 'canary.json';
export interface CanaryState {
  /** The last build whose every check passed: `--if-new-build` runs only on another. */
  passed?: { version: string; at: string };
  last?: { version: string; at: string; passed: boolean; failed: string[]; screens: string | null };
}

export function readCanaryState(stateDir: string): CanaryState {
  try { return JSON.parse(readFileSync(join(stateDir, STATE_FILE), 'utf8')) as CanaryState; } catch { return {}; }
}

function writeCanaryState(stateDir: string, s: CanaryState): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, STATE_FILE);
  // The pid in the name: two runs at once (a job and a person) do not write one temp file.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

/** Can the state folder be written? Asked before any model call: a run whose result cannot be
 *  recorded (a job in a sandbox) would cost the calls again at every run. Returns the reason, or null. */
function stateProblem(stateDir: string): string | null {
  const probe = join(stateDir, `${STATE_FILE}.${process.pid}.probe`);
  try {
    mkdirSync(join(stateDir, 'tui'), { recursive: true, mode: 0o700 });
    writeFileSync(probe, '', { mode: 0o600 });
    rmSync(probe, { force: true });
    return null;
  } catch (e) { return (e as NodeJS.ErrnoException).code ?? (e as Error).message; }
}

/** The canary cannot run here at all: no tmux, no CLI, not logged in, a state folder it cannot write.
 *  Exit 2, never a pass or a fail. */
export class CanaryBlocked extends Error {}

export interface CanaryReport {
  version: string;
  passed: boolean;
  /** Why this build could not be judged: then `passed` is false, nothing was recorded, and the exit is 2. */
  unjudged?: string;
  checks: CanaryCheck[];
  /** The folder with the kept screens, when a check failed or one screen did not read busy. */
  screens: string | null;
  /** The verdict, one plain line fit for a chat. */
  line: string;
}

export interface CanaryDeps {
  /** `tmux -V`, or null without tmux. */
  tmux(): string | null;
  /** The claude the daemon runs for a profile that names no `bin`. */
  bin(): string | undefined;
  /** `claude --version`, as `2.1.329`. */
  version(bin: string): Promise<string | null>;
  /** `claude auth status`; null when the build cannot say. */
  loggedIn(bin: string): Promise<boolean | null>;
  run(bin: string, keep: CanaryRig['keep'], keepFile: (name: string, from: string) => void): Promise<CanaryRun>;
}

interface Ran { code: number | null; out: string; err: string }
const run = (bin: string, args: string[]): Promise<Ran> =>
  new Promise((done) => execFile(bin, args, { env: childEnv(process.env), timeout: 20_000, encoding: 'utf8' }, (e, stdout, stderr) => {
    const code = (e as (NodeJS.ErrnoException & { code?: unknown }) | null)?.code;
    done({ code: !e ? 0 : typeof code === 'number' ? code : null, out: String(stdout ?? ''), err: String(stderr ?? '') });
  }));

/**
 * What `claude auth status` says. Its exit code is the documented part (0 logged in, 1 not); the
 * `loggedIn` field of the JSON it prints is read when it is there (seen on 2.1.329) and decides only
 * with the code or in its place. Null: this build cannot say (no such command, it did not end), and
 * the start check then shows what the pane shows.
 */
export function loginState(r: Ran): boolean | null {
  let said: unknown;
  try { said = (JSON.parse(r.out) as { loggedIn?: unknown } | null)?.loggedIn; } catch { /* not JSON */ }
  if (r.code === 0) return said !== false;
  if (r.code === null) return typeof said === 'boolean' ? said : null;
  if (typeof said === 'boolean') return said;
  // A build without the command says so and exits non-zero too.
  return /unknown (command|option)|usage:/i.test(`${r.err}\n${r.out}`) ? null : false;
}

const LIVE: CanaryDeps = {
  tmux: tmuxVersion,
  bin: () => locateBin(DEFAULT_BIN['claude-code']),
  version: async (bin) => /(\d+\.\d+\.\d+)/.exec((await run(bin, ['--version'])).out)?.[1] ?? null,
  loggedIn: async (bin) => loginState(await run(bin, ['auth', 'status'])),
  run: liveRun,
};

const home = (path: string): string => (path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);

/** The verdict line: what a daily job posts. */
export function verdictLine(version: string, checks: CanaryCheck[], screens: string | null): string {
  const failed = checks.filter((c) => !c.ok);
  if (!failed.length) return `Claude Code ${version}: tmux mode canary passed (${checks.length} of ${checks.length}).`;
  const first = failed.find((c) => !c.skipped) ?? failed[0];
  const what = first.detail.length > 160 ? `${first.detail.slice(0, 159)}…` : first.detail;
  return `Claude Code ${version}: tmux mode canary FAILED: ${first.name}: ${what}${failed.length > 1 ? ` (${checks.length - failed.length} of ${checks.length} passed)` : ''}.${screens ? ` Screens: ${home(screens)}.` : ''}`;
}

/** The line for a build that could not be judged: no verdict, and why. */
export const unjudgedLine = (version: string, why: string): string =>
  `Claude Code ${version}: tmux mode canary could not judge this build: ${cut(why, 200)}. Nothing is recorded; the next run tries again.`;

/**
 * Run the canary. Null: `ifNewBuild` was asked and the installed build is the one that last passed,
 * so nothing ran. Throws CanaryBlocked when it cannot run here.
 */
export async function canary(o: { ifNewBuild?: boolean; stateDir?: string; now?: Date; deps?: Partial<CanaryDeps> } = {}): Promise<CanaryReport | null> {
  const d: CanaryDeps = { ...LIVE, ...o.deps };
  const stateDir = o.stateDir ?? INSTANCE_DIR;
  if (d.tmux() === null) throw new CanaryBlocked('tmux is not installed');
  const bin = d.bin();
  if (!bin) throw new CanaryBlocked(`the ${DEFAULT_BIN['claude-code']} CLI was not found on PATH or in the usual install folders`);
  const version = await d.version(bin);
  if (!version) throw new CanaryBlocked(`${bin} --version printed no version`);
  const state = readCanaryState(stateDir);
  if (o.ifNewBuild && state.passed?.version === version) return null;
  const unwritable = stateProblem(stateDir);
  if (unwritable) throw new CanaryBlocked(`the state folder ${home(stateDir)} cannot be written (${unwritable}), so the result could not be recorded; a sandboxed profile's job cannot run the canary`);
  if ((await d.loggedIn(bin)) === false) throw new CanaryBlocked(`Claude Code is not logged in (${bin} auth status); run claude and /login`);

  const at = (o.now ?? new Date()).toISOString();
  // Under tui/, which no agent may open (instance.ts, STATE_PRIVATE): a screen shows the account's plan line.
  const folder = join(stateDir, 'tui', 'canary', at.replace(/[:.]/g, '-'));
  let kept = false;
  const dir = (): string => { if (!kept) { mkdirSync(folder, { recursive: true, mode: 0o700 }); kept = true; } return folder; };
  const keep: CanaryRig['keep'] = (file, screen, why) => {
    if (aborted) return;
    try { writeFileSync(join(dir(), file), `${new Date().toISOString()} ${why}\n${screen}\n`, { mode: 0o600 }); } catch { /* the check's own line stands */ }
  };
  const keepFile = (name: string, from: string): void => {
    if (aborted) return;
    try { if (existsSync(from)) copyFileSync(from, join(dir(), name)); } catch { /* as above */ }
  };
  const { checks, unjudged } = await d.run(bin, keep, keepFile);
  // Told to stop while it ran: the checks it did not get to say nothing, and the process is ending.
  if (aborted) throw new CanaryBlocked('the run was stopped by a signal');
  const screens = kept ? folder : null;
  // No verdict on the build: the state stays as it was, so the next run tries again.
  if (unjudged) return { version, passed: false, unjudged, checks, screens, line: unjudgedLine(version, unjudged) };
  const passed = checks.every((c) => c.ok);
  writeCanaryState(stateDir, {
    ...(passed ? { passed: { version, at } } : state.passed ? { passed: state.passed } : {}),
    last: { version, at, passed, failed: checks.filter((c) => !c.ok).map((c) => c.name), screens },
  });
  return { version, passed, checks, screens, line: verdictLine(version, checks, screens) };
}

export function canaryText(r: CanaryReport): string {
  const rows = r.checks.map((c) => `${c.ok ? 'ok  ' : c.skipped ? 'skip' : r.unjudged ? '?   ' : 'FAIL'}  ${c.name.padEnd(Math.max(...CHECKS.map((n) => n.length)))}  ${(c.ms / 1000).toFixed(1).padStart(5)} s  ${c.detail}`);
  // A pass can keep one screen too (the one frame that did not read busy): say where it is.
  return [...rows, r.line, ...(r.passed && r.screens ? [`One screen is kept in ${home(r.screens)}.`] : [])].join('\n');
}

/**
 * `angelia canary [--if-new-build] [--json]`. Exit 0: every check passed (or nothing ran). 1: a check
 * failed. 2: it could not run here, or could not judge the build (the plan's limit, a failed API
 * call, a lost login). With `--if-new-build` it is made for a daily `run:` job (jobs.ts, runJob):
 * silent on a build that passed before; one line on standard output for a pass, which the job posts;
 * and for a failure, or a build it could not judge, the one line on standard error with exit 1 or 2,
 * which the job posts as its failure line (a job's standard output is dropped when it fails).
 */
export async function canaryCommand(argv: string[]): Promise<number> {
  const ifNewBuild = argv.includes('--if-new-build'), json = argv.includes('--json');
  // SIGHUP too: a terminal that closes, or an ssh session that drops, must not leave the pane running.
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    process.once(sig, () => { aborted = true; void (cleanupNow?.() ?? Promise.resolve()).finally(() => process.exit(code)); });
  }
  let r: CanaryReport | null;
  try { r = await canary({ ifNewBuild }); } catch (e) {
    if (!(e instanceof CanaryBlocked)) throw e;
    console.error(`angelia canary could not run: ${e.message}`);
    return 2;
  }
  if (!r) return 0;
  if (json) console.log(JSON.stringify(r, null, 2));
  else if (r.unjudged) { if (!ifNewBuild) console.log(canaryText({ ...r, line: '' }).trimEnd()); console.error(r.line); }
  else if (!ifNewBuild) console.log(canaryText(r));
  else if (r.passed) console.log(r.line);
  else console.error(r.line);
  return r.unjudged ? 2 : r.passed ? 0 : 1;
}
