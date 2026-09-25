import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { STATE_DIR } from './daemon.js';
import { SESSION_ENV } from '../core/env.js';
import { entry, plistPath, serviceInstalled, serviceLoaded, serviceStart, serviceStop, tableMismatch } from './service.js';
import { configPath } from '../instance/instance.js';

/**
 * Stop the running daemon and start a new one in its OWN session.
 *
 * Why it is not `kill` plus a background start: a chat routed to Angelia runs its agent as a child
 * of the daemon. If that agent restarts the daemon the naive way, it kills its own parent, the
 * shutdown reaps the process group, and the new daemon never starts — the gateway stays down and
 * the chat goes silent. So: detach, and refuse outright when the caller is the daemon's own agent.
 */
export async function restartCommand(argv: string[]): Promise<void> {
  try { await restart(argv); } catch (e) {
    // Launched for /restart, nobody reads this process's stderr: leave the reason where the daemon
    // that launched it looks when it sees a failed exit (watchChatRestart).
    if (argv.includes('--from-daemon')) try { writeFileSync(join(STATE_DIR, RESTART_ERROR), (e as Error).message); } catch {}
    throw e;
  }
}

async function restart(argv: string[]): Promise<void> {
  // --from-daemon: launched by the daemon itself for /restart, already detached into its own session
  // (launchChatRestart), so the guards below would refuse the one caller that is safe.
  const fromDaemon = argv.includes('--from-daemon');
  const force = argv.includes('--force') || fromDaemon;
  const rest = argv.filter((a) => a !== '--force' && a !== '--from-daemon');
  // Give the daemon time to deliver "restarting" before it is stopped.
  if (fromDaemon) await wait(3000);
  const pidFile = join(STATE_DIR, 'daemon.pid');
  const old = readPid(pidFile);

  // Two ways the caller can be the daemon's own agent, and both must be refused.
  // In print mode the agent is a child process, so the pid chain shows it. In tui mode the chain
  // is cut: the session hangs off the tmux server, which is its own session leader. The env var the
  // daemon hands every agent is the signal that survives both, so it is checked first.
  if (!force) {
    const key = process.env.ANGELIA_SESSION_KEY;
    if (key) {
      throw new Error(
        `this command is running as the agent of ${key}, so restarting would cut the chat it answers.\n` +
        'Run angelia restart from a terminal of your own, or pass --force and accept losing this turn\'s reply.',
      );
    }
    if (old && alive(old) && ancestors(process.pid).includes(old)) {
      throw new Error(`this shell runs under daemon ${old}: stopping it would kill this command too.\nRun angelia restart from a terminal of your own.`);
    }
  }

  // Under launchd the service owns the daemon: stop the job, then load it again from the plist on
  // disk, so a rewritten plist takes effect. A daemon still started by hand is stopped first, which
  // is how `angelia service install` hands over to the service.
  if (serviceInstalled()) {
    const mismatch = tableMismatch(rest[0], readFileSync(plistPath(), 'utf8'), fromDaemon);
    if (mismatch) throw new Error(mismatch);
    serviceStop();
    if (old && alive(old)) process.kill(old, 'SIGTERM');
    for (let i = 0; i < 80 && old && alive(old); i++) await wait(250);
    if (old && alive(old)) throw new Error(`daemon ${old} did not stop; not starting a second one`);
    if (old) console.log(`stopped ${old}`);
    serviceStart();
    for (let i = 0; i < 60; i++) {
      const now = readPid(pidFile);
      if (now && now !== old && alive(now) && serviceLoaded()) { console.log(`angelia is up under launchd, pid ${now}`); return; }
      await wait(250);
    }
    throw new Error(`the service did not bring the daemon up within 15s. Last lines are in ${join(STATE_DIR, 'daemon.out')}`);
  }

  if (old && alive(old)) {
    process.kill(old, 'SIGTERM');
    for (let i = 0; i < 40 && alive(old); i++) await wait(250);
    if (alive(old)) throw new Error(`daemon ${old} did not stop; not starting a second one`);
    console.log(`stopped ${old}`);
  }

  const config = configPath(rest[0] ?? lastConfig());
  const out = openSync(join(STATE_DIR, 'daemon.out'), 'a');
  // A forced restart from inside an agent would otherwise hand that one session's identity to the
  // whole new daemon, and from there to every agent it spawns.
  // The daemon reads ~/.angelia/env itself and keeps it out of its environment (core/env.ts).
  const env = { ...process.env };
  for (const k of SESSION_ENV) delete env[k];
  const child = spawn(process.execPath, [entry(), 'daemon', config], {
    cwd: STATE_DIR, env, detached: true, stdio: ['ignore', out, out],
  });
  child.unref();

  // The daemon writes its pid file as it comes up; wait for it so a failed start is not reported as a success.
  for (let i = 0; i < 40; i++) {
    const now = readPid(pidFile);
    if (now && now !== old && alive(now)) { console.log(`angelia is up, pid ${now}`); return; }
    await wait(250);
  }
  throw new Error(`the new daemon did not come up within 10s. Last lines are in ${join(STATE_DIR, 'daemon.out')}`);
}

/** Written by the daemon before a /restart, read and removed by the daemon that replaces it, so the
 *  chat that asked hears the restart finished. Older than ten minutes is stale and ignored. */
export const RESTART_NOTE = 'restart-note.json';
/** Written by a /restart that failed; read by the daemon that launched it, if that one still runs. */
export const RESTART_ERROR = 'restart-error.txt';
const NOTE_TTL_MS = 10 * 60_000;

/**
 * /restart from a chat. The one thing that must not happen is what `/sh angelia restart` would do:
 * run the restart as a child of the daemon it stops, so it dies with it and nothing starts again.
 * So the restart runs in its own session (detached: setsid), and survives its parent's exit. The
 * caller has already checked the routing table; a table that does not load never gets this far.
 */
export function launchChatRestart(key: string, configPath: string, onFail: (why: string) => void, stateDir = STATE_DIR): void {
  writeFileSync(join(stateDir, RESTART_NOTE), JSON.stringify({ key, at: new Date().toISOString() }));
  try { unlinkSync(join(stateDir, RESTART_ERROR)); } catch {}
  const out = openSync(join(stateDir, 'daemon.out'), 'a');
  const env = { ...process.env };
  for (const k of SESSION_ENV) delete env[k];
  const child = spawn(process.execPath, [entry(), 'restart', '--from-daemon', configPath], {
    cwd: stateDir, env, detached: true, stdio: ['ignore', out, out],
  });
  watchChatRestart(child, onFail, stateDir);
  child.unref();
}

/**
 * A /restart that succeeds kills this daemon, so only a failure is ever seen here: the restart
 * refused (a table that is not the service's), or the old daemon would not stop. Then this daemon is
 * still the one running and the chat that asked must hear it, not wait for a "back up" that never
 * comes. The note is dropped too, so a later start does not announce a restart nobody finished.
 */
export function watchChatRestart(child: Pick<ChildProcess, 'once'>, onFail: (why: string) => void, stateDir = STATE_DIR): void {
  child.once('exit', (code: number | null, signal: string | null) => {
    if (code === 0) return;
    let why = '';
    try { why = readFileSync(join(stateDir, RESTART_ERROR), 'utf8').trim(); unlinkSync(join(stateDir, RESTART_ERROR)); } catch {}
    try { unlinkSync(join(stateDir, RESTART_NOTE)); } catch {}
    onFail(why || (signal ? `the restart was killed by ${signal}` : `the restart exited with code ${code}`));
  });
}

export function takeRestartNote(stateDir = STATE_DIR, now = Date.now()): { key: string } | undefined {
  const path = join(stateDir, RESTART_NOTE);
  let note: { key?: string; at?: string };
  try { note = JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
  try { unlinkSync(path); } catch {}
  if (!note.key || !note.at || now - Date.parse(note.at) > NOTE_TTL_MS) return undefined;
  return { key: note.key };
}

function readPid(path: string): number {
  try { return Number(readFileSync(path, 'utf8').trim()) || 0; } catch { return 0; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' && !!process.env.CODEX_SANDBOX; }
}

/** The config the daemon was last started with, recorded in status.json. */
function lastConfig(): string | undefined {
  try {
    const s = JSON.parse(readFileSync(join(STATE_DIR, 'status.json'), 'utf8')) as { config?: string };
    return s.config && existsSync(s.config) ? s.config : undefined;
  } catch { return undefined; }
}

function ancestors(pid: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 10 && pid > 1; i++) {
    const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
    const parent = Number((r.stdout ?? '').trim());
    if (!parent) break;
    out.push(parent);
    pid = parent;
  }
  return out;
}
