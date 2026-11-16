import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { ServiceBackend, ServiceInput, ServiceProgram } from './service.js';

/**
 * The daemon as a macOS LaunchAgent: it starts at login, comes back after a crash, and no longer
 * lives and dies with the terminal that started it. A LaunchAgent, not a system daemon, because the
 * agents need the user's session: the keychain, tmux, the everyday Chrome.
 *
 * The plist carries the PATH, worked out when it is written, so the daemon never again depends on
 * the shell that happened to start it. It carries no secret: the token stays in the state folder's
 * `env` file, which the daemon reads itself.
 */
export const LABEL = 'angelia.daemon';

export function plistPath(home = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const unesc = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function buildPlist(i: ServiceInput): string {
  const env: Record<string, string> = { PATH: i.path, HOME: i.home, ANGELIA_STATE_DIR: i.stateDir };
  if (i.lang) env.LANG = i.lang;
  const out = join(i.stateDir, 'daemon.out');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by angelia service install. Rewrite it with the same command, not by hand. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[i.node, i.entry, 'daemon', i.config].map((a) => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${esc(i.stateDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${esc(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Back after a crash; a clean stop (SIGTERM, exit 0) stays stopped. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${esc(out)}</string>
  <key>StandardErrorPath</key><string>${esc(out)}</string>
</dict>
</plist>
`;
}

const domain = (): string => `gui/${userInfo().uid}`;

function launchctl(args: string[]): { code: number; out: string } {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** The routing table a written plist runs: the last argument after `daemon`. */
export function plistConfig(plist: string): string | undefined {
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1];
  if (!args) return undefined;
  const items = [...args.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unesc(m[1]));
  const i = items.indexOf('daemon');
  return i === -1 ? undefined : items[i + 1];
}

/** The node and the script a written plist starts the daemon with. */
export function plistProgram(plist: string): { node: string; entry: string } | undefined {
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1];
  if (!args) return undefined;
  const items = [...args.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unesc(m[1]));
  const i = items.indexOf('daemon');
  return i >= 2 ? { node: items[i - 2], entry: items[i - 1] } : undefined;
}

/** The instance a written plist belongs to. */
export function plistStateDir(plist: string): string | undefined {
  const m = /<key>ANGELIA_STATE_DIR<\/key><string>([^<]*)<\/string>/.exec(plist);
  return m ? unesc(m[1]) : undefined;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Stop the service's daemon and forget the job; it comes back only with serviceStart.
 *  bootout returns while launchd is still removing a job whose daemon runs, and a bootstrap in that
 *  window fails (5: Input/output error), so wait until the job is gone: up to 25 s, past launchd's
 *  20 s ExitTimeOut, after which it has killed the daemon. */
export function launchdStop(run = launchctl, sleep = sleepSync): void {
  const job = `${domain()}/${LABEL}`;
  if (run(['print', job]).code !== 0) return;
  run(['bootout', job]);
  for (let i = 0; i < 100; i++) {
    if (run(['print', job]).code !== 0) return;
    sleep(250);
  }
  throw new Error(`launchd still holds ${LABEL} 25s after bootout, so a start now would fail. Try again in a moment.`);
}

/** Load the job from the plist on disk (so a rewritten plist takes effect), and start the daemon.
 *  RunAtLoad alone does not start it: measured on macOS 26.5, a job bootstrapped into a running
 *  login session is left "pended nondemand spawn = speculative" and runs only at the next login.
 *  kickstart starts it now; on a daemon already running it does nothing. */
export function launchdStart(home = homedir(), run = launchctl): void {
  const job = `${domain()}/${LABEL}`;
  const r = run(['bootstrap', domain(), plistPath(home)]);
  if (r.code !== 0 && run(['print', job]).code !== 0) throw new Error(`launchctl bootstrap failed: ${r.out || `exit ${r.code}`}`);
  const k = run(['kickstart', job]);
  if (k.code !== 0) throw new Error(`launchctl kickstart failed: ${k.out || `exit ${k.code}`}`);
}

export const launchd: ServiceBackend = {
  name: 'launchd',
  filePath: plistPath,
  render: buildPlist,
  read(text: string): ServiceProgram | undefined {
    const config = plistConfig(text), prog = plistProgram(text), stateDir = plistStateDir(text);
    return config !== undefined && prog && stateDir !== undefined ? { config, node: prog.node, entry: prog.entry, stateDir } : undefined;
  },
  loaded: () => launchctl(['print', `${domain()}/${LABEL}`]).code === 0,
  start: (home) => launchdStart(home),
  stop: () => launchdStop(),
  remove(home) { const f = plistPath(home); if (existsSync(f)) unlinkSync(f); },
  startedByService: () => process.ppid === 1 && process.env.XPC_SERVICE_NAME === LABEL,
};
