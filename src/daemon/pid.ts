import { spawnSync } from 'node:child_process';

/** Is a process with this pid running? Inside Codex's sandbox kill(0) is refused for every pid
 *  (EPERM), which there means "yes": the refusal comes from the sandbox, not from a missing process. */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' && !!process.env.CODEX_SANDBOX; }
}

/**
 * Is `pid` a running Angelia daemon? A pid file left behind by a crash or a power cut can name some
 * other process after a reboot: the daemon would then refuse to start every ten seconds under
 * launchd, and `angelia restart` would stop a stranger. So the process's command line must be the
 * daemon's too. Where `ps` cannot be run (a sandbox), a live pid is taken at its word, as before.
 */
export function isDaemonPid(pid: number): boolean {
  if (!pid || pid === process.pid || !pidAlive(pid)) return false;
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
  // No answer from ps (a sandbox, a timeout): unknown, so the pid is taken at its word, as before.
  if (r.status === null || r.error || (r.status !== 0 && !r.stdout.trim())) return true;
  return /angelia/i.test(r.stdout) && /(^|\s)daemon(\s|$)/.test(r.stdout);
}
