import { execFile } from 'node:child_process';
import { versionAtLeast } from './argv.js';
import { listsTeammates, paneIdle, tmux } from './tmux.js';

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

/** A pane the reap may end once it sat idle too long or runs an older Claude Code: a parked one, or a
 *  chat's active session that no brain holds (Orchestrator.idlePanes). `bin`: the profile's CLI, whose
 *  `--version` is the build installed now; without it only the idle rule applies. */
export interface IdlePane { name: string; key: string; bin?: string }

/** The x.y.z of a native Claude Code install in a path or command line (`…/claude/versions/2.1.310`).
 *  `claude/` is part of it: an MCP server under `~/.pyenv/versions/1.2.3` is no build of Claude's. */
export function buildIn(s: string): string | null {
  return /\bclaude\/versions\/(\d+\.\d+\.\d+)(?=$|[/\s])/.exec(s)?.[1] ?? null;
}

/**
 * Each session on Angelia's tmux server: when its window last saw input or output, in epoch seconds,
 * and its pane's process. `window_activity`, not `session_activity`: on tmux 3.7c the session's stays
 * at the time it was made, through send-keys, paste-buffer and pane output, so "idle 12h" would mean
 * "made 12h ago" (measured 2026-11-26). Undefined when tmux could not be read.
 */
export async function paneActivity(env: NodeJS.ProcessEnv): Promise<Map<string, { activity: number; pid: number }> | undefined> {
  const list = await tmux(['list-sessions', '-F', '#{session_name}\t#{window_activity}\t#{pane_pid}'], { env });
  if (list.code !== 0) return undefined;
  return new Map(list.out.split('\n').filter(Boolean).map((l) => { const [n, a, p] = l.split('\t'); return [n, { activity: Number(a) || 0, pid: Number(p) || 0 }] as const; }));
}

/** Why an idle pane is ended, or null to keep it. `activity`: tmux's `window_activity`, in epoch
 *  seconds. `running` / `installed`: the builds, when both could be read; compared by number, so
 *  2.1.310 is newer than 2.1.287. */
export function paneEndReason(o: { activity: number; now: number; idleHours: number; running: string | null; installed: string | null }): string | null {
  const hours = (o.now / 1000 - o.activity) / 3600;
  if (o.activity > 0 && hours >= o.idleHours) return `idle ${Math.floor(hours)}h`;
  if (o.running && o.installed && !versionAtLeast(o.running, o.installed)) return `old build ${o.running} -> ${o.installed}`;
  return null;
}

const run = (cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> =>
  new Promise((done) => execFile(cmd, args, { env, timeout: 15_000 }, (_e, stdout) => done(String(stdout ?? ''))));

/** The build a pane runs, from its process and the processes it started: the command line when it
 *  names a versions folder, else the executable itself, which lsof names with the symlink resolved
 *  (`~/.local/bin/claude` points into `versions/`, and the command line shows only the link). Null
 *  when neither says, an npm install for one. `table`: `ps -axo pid=,ppid=,args=` already read. */
export async function paneBuild(pid: number, table?: Promise<string>): Promise<string | null> {
  const procs = (await (table ?? run('ps', ['-axo', 'pid=,ppid=,args=']))).split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter((m) => m !== null);
  // The pane's own process first (the CLI, exec'd by env), then what it started.
  const mine = [...procs.filter((m) => Number(m[1]) === pid), ...procs.filter((m) => Number(m[2]) === pid)];
  for (const m of mine) {
    const exe = buildIn(m[3]) ? '' : (await run('lsof', ['-a', '-p', m[1], '-d', 'txt', '-Fn'])).split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? '';
    const v = buildIn(m[3]) ?? buildIn(exe);
    if (v) return v;
  }
  return null;
}

/** The build `bin --version` reports, or null. */
export async function installedBuild(bin: string, env?: NodeJS.ProcessEnv): Promise<string | null> {
  return /(\d+\.\d+\.\d+)/.exec(await run(bin, ['--version'], env))?.[1] ?? null;
}

/**
 * End the panes no chat is reading that have sat idle `idleHours`, or that run an older Claude Code
 * than the one installed. `release()` keeps a pane for good, and the orphan sweep spares every parked
 * and active one, so without this panes piled up: 19 of them on 9 builds, some idle three weeks, whose
 * MCP servers filled swap (2026-10-24). The next message starts the pane again with --resume. Only a
 * pane idle on screen goes (never mid-turn, never with a dialog open or a teammate listed), and
 * `mayEnd` is asked last, at the kill, so a message that came in meanwhile keeps it. Returns what was ended, and why.
 */
export async function reapPanes(panes: IdlePane[], env: NodeJS.ProcessEnv, o: {
  idleHours: number; mayEnd: (p: IdlePane) => boolean; now?: number;
  build?: (pid: number) => Promise<string | null>; installed?: (bin: string) => Promise<string | null>;
}): Promise<{ name: string; key: string; why: string }[]> {
  if (!panes.length) return [];
  const live = await paneActivity(env);
  if (!live) return [];
  const builds = new Map<string, Promise<string | null>>(); // one --version per CLI per sweep
  const installed = (bin: string) => { let v = builds.get(bin); if (!v) builds.set(bin, v = (o.installed ?? ((b) => installedBuild(b, env)))(bin)); return v; };
  let table: Promise<string> | undefined; // one process list per sweep, read only when a build is asked
  const build = o.build ?? ((pid: number) => paneBuild(pid, table ??= run('ps', ['-axo', 'pid=,ppid=,args='])));
  const gone: { name: string; key: string; why: string }[] = [];
  for (const p of panes) {
    const t = live.get(p.name);
    if (!t) continue;
    const pane = await tmux(['capture-pane', '-p', '-t', p.name, '-S', '-30'], { env });
    // Never one that still lists a teammate: ending it would end the teammate and lose its report.
    if (pane.code !== 0 || !paneIdle(pane.out) || listsTeammates(pane.out)) continue;
    const now = o.now ?? Date.now();
    let why = paneEndReason({ activity: t.activity, now, idleHours: o.idleHours, running: null, installed: null });
    if (!why && p.bin && t.pid) {
      const running = await build(t.pid);
      why = running ? paneEndReason({ activity: t.activity, now, idleHours: o.idleHours, running, installed: await installed(p.bin) }) : null;
    }
    if (!why || !o.mayEnd(p)) continue;
    if ((await tmux(['kill-session', '-t', p.name], { env })).code === 0) gone.push({ name: p.name, key: p.key, why });
  }
  return gone;
}
