import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fallbackDirs, locateBin, pathWithBins } from '../brain/locate.js';
import { loadConfig } from '../instance/config/load.js';
import { STATE_DIR } from './daemon.js';
import { configPath } from '../instance/instance.js';

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

/** Why this command must not touch the installed service: it belongs to another instance. One label
 *  and one plist serve the whole user, so a test instance (ANGELIA_STATE_DIR) would otherwise
 *  overwrite or remove the real one. */
export function otherInstance(stateDir = STATE_DIR, plist = plistPath()): string | undefined {
  let text: string;
  try { text = readFileSync(plist, 'utf8'); } catch { return undefined; }
  const theirs = plistStateDir(text);
  if (!theirs || resolve(theirs) === resolve(stateDir)) return undefined;
  return `the installed service runs the instance in ${theirs}, not this one (${stateDir}). Uninstall it from that instance first, or add --force to replace it.`;
}

export interface PlistInput { node: string; entry: string; config: string; stateDir: string; path: string; home: string; lang?: string }

export function buildPlist(i: PlistInput): string {
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

/** The PATH written into the plist: the one we have, the install folders that exist, the folder of
 *  every CLI the table uses, and node's own folder. Order kept, nothing twice. */
export function servicePath(env: NodeJS.ProcessEnv, extra: string[], home = homedir()): string {
  const parts: string[] = [];
  for (const d of [...(env.PATH ?? '').split(delimiter), ...extra, ...fallbackDirs(home), '/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    if (d && !parts.includes(d) && existsSync(d)) parts.push(d);
  }
  return parts.join(delimiter);
}

/** A node path that survives a Homebrew upgrade: the symlink on PATH when it points at this very
 *  node, since the Cellar path changes with every version. */
export function stableNode(): string {
  const onPath = locateBin('node');
  try { if (onPath && realpathSync(onPath) === realpathSync(process.execPath)) return onPath; } catch {}
  return process.execPath;
}

/** The daemon's entry: the `angelia` link npm puts on PATH when it points at this very file, so
 *  the plist survives the package folder moving (a rename, another prefix); else the file itself.
 *  When this file is gone, the link wins as well. Seen 2026-09-23: an update that moved dist/cli.js
 *  to dist/cli/cli.js under a running daemon, whose /restart then launched a path that no longer
 *  existed and failed with MODULE_NOT_FOUND, twice, until someone restarted it by hand. */
export function entry(self = fileURLToPath(new URL('../cli/cli.js', import.meta.url)), onPath = locateBin('angelia')): string {
  try { if (onPath && realpathSync(onPath) === realpathSync(self)) return onPath; } catch {}
  if (onPath && !existsSync(self)) return onPath;
  return self;
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

/** Why a restart that names a table cannot go through the service, or undefined when it can.
 *  A person naming a table the service does not run is told so. The daemon (`fromDaemon`, for
 *  /restart) is not: under the service the plist is the authority, and after `angelia service
 *  install <new table>` the running daemon still carries the old path - which is exactly the restart
 *  that has to go through. */
export function tableMismatch(given: string | undefined, plist: string, fromDaemon = false): string | undefined {
  if (!given || fromDaemon) return undefined;
  const runs = plistConfig(plist);
  if (runs && resolve(given) === resolve(runs)) return undefined;
  return `the service runs ${runs ?? 'the table in its plist'}, not ${resolve(given)}. To change it: angelia service install <routing.yaml>`;
}

/** The instance a written plist belongs to. */
export function plistStateDir(plist: string): string | undefined {
  const m = /<key>ANGELIA_STATE_DIR<\/key><string>([^<]*)<\/string>/.exec(plist);
  return m ? unesc(m[1]) : undefined;
}

/** A service exists for this instance. One plist per user, so it belongs to the instance whose
 *  state folder it names; another instance on the same account (a test, a second setup) must never
 *  stop or start it. */
export function serviceInstalled(home = homedir(), stateDir = STATE_DIR): boolean {
  if (process.platform !== 'darwin') return false;
  try { return plistStateDir(readFileSync(plistPath(home), 'utf8')) === resolve(stateDir); } catch { return false; }
}

export function serviceLoaded(): boolean {
  return process.platform === 'darwin' && launchctl(['print', `${domain()}/${LABEL}`]).code === 0;
}

/** Stop the service's daemon and forget the job; it comes back only with serviceStart. */
export function serviceStop(): void {
  if (serviceLoaded()) launchctl(['bootout', `${domain()}/${LABEL}`]);
}

/** Load the job from the plist on disk (so a rewritten plist takes effect), which starts the daemon. */
export function serviceStart(home = homedir()): void {
  const r = launchctl(['bootstrap', domain(), plistPath(home)]);
  if (r.code !== 0 && !serviceLoaded()) throw new Error(`launchctl bootstrap failed: ${r.out || `exit ${r.code}`}`);
}

function readPid(): number {
  try { return Number(readFileSync(join(STATE_DIR, 'daemon.pid'), 'utf8').trim()) || 0; } catch { return 0; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function serviceCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (process.platform !== 'darwin') throw new Error('angelia service is macOS only for now (launchd). On Linux, run angelia daemon under systemd or your own supervisor.');
  const force = rest.includes('--force');
  const args = rest.filter((a) => a !== '--force');
  switch (sub) {
    case 'install': {
      const other = force ? undefined : otherInstance();
      if (other) throw new Error(other);
      const config = resolve(configPath(args[0]));
      const cfg = loadConfig(config); // a table that does not load never becomes a service
      const bins = pathWithBins(cfg);
      const extra = [...bins.path.split(delimiter), dirname(process.execPath)];
      const plist = buildPlist({
        node: stableNode(), entry: entry(), config, stateDir: STATE_DIR,
        path: servicePath(process.env, extra), home: homedir(), lang: process.env.LANG,
      });
      mkdirSync(dirname(plistPath()), { recursive: true });
      writeFileSync(plistPath(), plist, { mode: 0o644 });
      console.log(`wrote ${plistPath()}`);
      const pid = readPid();
      if (serviceLoaded()) {
        console.log('The service is already loaded. The new plist takes effect at the next angelia restart (or /restart from a chat).');
      } else if (pid && alive(pid)) {
        console.log(`A daemon started by hand is running (pid ${pid}). angelia restart, or /restart from a chat, moves it onto the service.`);
      } else {
        serviceStart();
        console.log('Service loaded: the daemon starts now and at every login.');
      }
      break;
    }
    case 'uninstall': {
      if (!force && process.env.ANGELIA_SESSION_KEY) {
        throw new Error(`this command is running as the agent of ${process.env.ANGELIA_SESSION_KEY}: uninstalling stops the daemon, and nothing would start it again.\nRun it from a terminal of your own.`);
      }
      const other = force ? undefined : otherInstance();
      if (other) throw new Error(other);
      serviceStop();
      if (existsSync(plistPath())) unlinkSync(plistPath());
      console.log('Service removed. The daemon is stopped; start it by hand with angelia daemon, or install the service again.');
      break;
    }
    case 'status': {
      const pid = readPid();
      console.log(`plist   ${serviceInstalled() ? plistPath() : 'not installed'}`);
      console.log(`loaded  ${serviceLoaded() ? 'yes' : 'no'}`);
      console.log(`daemon  ${pid && alive(pid) ? `pid ${pid}` : 'not running'}`);
      break;
    }
    default:
      throw new Error('usage: angelia service <install [routing.yaml]|uninstall|status>');
  }
}
