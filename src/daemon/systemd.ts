import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServiceBackend, ServiceInput, ServiceProgram } from './service.js';

/**
 * The daemon as a systemd user unit: it starts at login (with linger, at boot), comes back after a
 * crash, and no longer lives and dies with the terminal that started it. The unit carries the PATH,
 * worked out when it is written, and no secret: the token stays in the state folder's `env` file.
 * The four values `read` needs ride in one JSON comment line, so nothing is parsed out of quoting.
 */
export const UNIT = 'angelia.service';

/** systemctl --user, with the args after it. */
export type Run = (args: string[]) => { code: number; out: string };

export function unitPath(home = homedir()): string {
  const base = process.env.XDG_CONFIG_HOME || join(home, '.config');
  return join(base, 'systemd', 'user', UNIT);
}

/** systemd expands `%x` specifiers in unit values and in `append:` paths; `%%` is a literal percent. */
export function escapeSpecifiers(s: string): string {
  return s.replace(/%/g, '%%');
}

/** One quoted word: backslash and quote escaped, `%` doubled. ExecStart also expands `$VAR`, so there `$` is doubled
 *  too (`exec`); Environment= does not, so a `$` stays literal there. */
const word = (s: string, exec = false): string => {
  const q = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  return `"${exec ? q.replace(/\$/g, '$$$$') : q}"`;
};

export function buildUnit(i: ServiceInput): string {
  for (const v of [i.node, i.entry, i.config, i.stateDir, i.path, i.home, i.lang ?? '']) {
    if (/[\n\r]/.test(v)) throw new Error('a path with a newline cannot go in a systemd unit');
  }
  const env = [`PATH=${i.path}`, `HOME=${i.home}`, `ANGELIA_STATE_DIR=${i.stateDir}`, ...(i.lang ? [`LANG=${i.lang}`] : [])];
  const out = `append:${escapeSpecifiers(join(i.stateDir, 'daemon.out'))}`;
  return `# Written by angelia service install. Rewrite it with the same command, not by hand.
# angelia: ${JSON.stringify({ config: i.config, node: i.node, entry: i.entry, stateDir: i.stateDir })}
[Unit]
Description=Angelia daemon
After=network-online.target

[Service]
ExecStart=${[i.node, i.entry, 'daemon', i.config].map((a) => word(a, true)).join(' ')}
WorkingDirectory=${escapeSpecifiers(i.stateDir)}
Environment=${env.map((a) => word(a)).join(' ')}
Restart=on-failure
RestartSec=10
StandardOutput=${out}
StandardError=${out}

[Install]
WantedBy=default.target
`;
}

/** The program a written unit starts, from its `# angelia:` line; undefined when absent or broken. */
export function readUnit(text: string): ServiceProgram | undefined {
  const line = /^# angelia: (.*)$/m.exec(text)?.[1];
  if (!line) return undefined;
  try {
    const { config, node, entry, stateDir } = JSON.parse(line);
    return [config, node, entry, stateDir].every((v) => typeof v === 'string') ? { config, node, entry, stateDir } : undefined;
  } catch { return undefined; }
}

function systemctl(args: string[]): { code: number; out: string } {
  const r = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A user manager answers: `show-environment` exits 0. False in a container or over ssh without one. */
export function systemdAvailable(run: Run = systemctl): boolean {
  return run(['show-environment']).code === 0;
}

/** This process runs inside a systemd unit (any, not necessarily ours: see startedByService). */
export function underSystemd(env: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform === 'linux' && !!env.INVOCATION_ID;
}

/** Stop the service's daemon, then wait until the unit is no longer active: up to 25 s, as launchd's. */
export function systemdStop(run: Run = systemctl, sleep: (ms: number) => void = sleepSync): void {
  run(['stop', UNIT]);
  for (let i = 0; i < 100; i++) {
    if (run(['is-active', UNIT]).code !== 0) return;
    sleep(250);
  }
  throw new Error(`systemd still holds ${UNIT} 25s after stop, so a start now could fail. Try again in a moment.`);
}

/** Load the unit from the file on disk (so a rewritten unit takes effect), enable it, and start the daemon. */
export function systemdStart(run: Run = systemctl): void {
  for (const args of [['daemon-reload'], ['enable', UNIT], ['start', UNIT]]) {
    const r = run(args);
    if (r.code !== 0) throw new Error(`systemctl --user ${args[0]} failed: ${r.out || `exit ${r.code}`}`);
  }
}

/** Running under the manager (is-active), not merely enabled: an enabled but stopped unit must still be started by install. */
export function systemdLoaded(run: Run = systemctl): boolean {
  return run(['is-active', UNIT]).code === 0;
}

/** Without linger the user manager, and our daemon with it, stops at logout. undefined when it is on or was just turned on, else the line to show. */
export function linger(
  user: string,
  run: (cmd: string, args: string[]) => { code: number; out: string } = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  },
): string | undefined {
  if (run('loginctl', ['show-user', user, '-p', 'Linger']).out.includes('Linger=yes')) return undefined;
  if (run('loginctl', ['enable-linger', user]).code === 0) return undefined;
  return `Run sudo loginctl enable-linger ${user} once, or the daemon stops when you log out.`;
}

export const systemd: ServiceBackend = {
  name: 'systemd',
  filePath: unitPath,
  render: buildUnit,
  read: readUnit,
  loaded: () => systemdLoaded(),
  start: () => systemdStart(),
  stop: () => systemdStop(),
  remove(home) {
    systemctl(['disable', UNIT]);
    const f = unitPath(home);
    if (existsSync(f)) unlinkSync(f);
    systemctl(['daemon-reload']);
  },
  startedByService: () => process.env.SYSTEMD_EXEC_PID === String(process.pid),
};
