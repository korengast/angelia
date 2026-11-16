import { isDaemonPid } from './pid.js';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fallbackDirs, locateBin, pathWithBins } from '../brain/locate.js';
import { effectiveTable } from '../instance/accepted.js';
import { loadConfig } from '../instance/config/load.js';
import { STATE_DIR } from './daemon.js';
import { configPath } from '../instance/instance.js';
import { launchd } from './launchd.js';
import { linger, systemd, systemdAvailable, systemdEnable } from './systemd.js';

export { LABEL } from './launchd.js';

export interface ServiceInput { node: string; entry: string; config: string; stateDir: string; path: string; home: string; lang?: string }

/** What a written service file starts: the routing table, the node and script, and the instance it belongs to. */
export interface ServiceProgram { config: string; node: string; entry: string; stateDir: string }

/** One service manager's way to run the daemon: launchd's plist today, systemd's unit next. */
export interface ServiceBackend {
  name: 'launchd' | 'systemd';
  filePath(home?: string): string;
  render(i: ServiceInput): string;
  read(text: string): ServiceProgram | undefined;
  loaded(): boolean;
  start(home?: string): void;
  stop(): void;
  remove(home?: string): void;
  /** This process is the one the service manager started. */
  startedByService(): boolean;
}

/** The backend of this platform: launchd on macOS, systemd on Linux, else none. */
export function backend(platform: NodeJS.Platform = process.platform): ServiceBackend | undefined {
  return platform === 'darwin' ? launchd : platform === 'linux' ? systemd : undefined;
}

export function serviceFile(home = homedir()): string | undefined {
  return backend()?.filePath(home);
}

/** The program the installed service file starts, or undefined when there is no backend, file, or a file it cannot read. */
export function readService(home = homedir()): ServiceProgram | undefined {
  const svc = backend();
  if (!svc) return undefined;
  try { return svc.read(readFileSync(svc.filePath(home), 'utf8')); } catch { return undefined; }
}

/** Why this command must not touch the installed service: it belongs to another instance. One label
 *  and one plist serve the whole user, so a test instance (ANGELIA_STATE_DIR) would otherwise
 *  overwrite or remove the real one. */
export function otherInstance(stateDir = STATE_DIR, file = serviceFile(), svc = backend()): string | undefined {
  if (!file || !svc) return undefined;
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return undefined; }
  const theirs = svc.read(text)?.stateDir;
  if (!theirs || resolve(theirs) === resolve(stateDir)) return undefined;
  return `the installed service runs the instance in ${theirs}, not this one (${stateDir}). Uninstall it from that instance first, or add --force to replace it.`;
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

/** Why a restart that names a table cannot go through the service, or undefined when it can.
 *  A person naming a table the service does not run is told so. The daemon (`fromDaemon`, for
 *  /restart) is not: under the service the plist is the authority, and after `angelia service
 *  install <new table>` the running daemon still carries the old path - which is exactly the restart
 *  that has to go through. */
export function tableMismatch(given: string | undefined, prog: ServiceProgram | undefined, fromDaemon = false): string | undefined {
  if (!given || fromDaemon) return undefined;
  const runs = prog?.config;
  if (runs && resolve(given) === resolve(runs)) return undefined;
  return `the service runs ${runs ?? 'the table in its plist'}, not ${resolve(given)}. To change it: angelia service install <routing.yaml>`;
}

/** A service exists for this instance. One plist per user, so it belongs to the instance whose
 *  state folder it names; another instance on the same account (a test, a second setup) must never
 *  stop or start it. */
export function serviceInstalled(home = homedir(), stateDir = STATE_DIR): boolean {
  const theirs = readService(home)?.stateDir;
  return theirs !== undefined && theirs === resolve(stateDir);
}

export function serviceLoaded(): boolean {
  return backend()?.loaded() ?? false;
}

/** Stop the service's daemon and forget the job; it comes back only with serviceStart. */
export function serviceStop(): void {
  backend()?.stop();
}

/** Load the service from the file on disk (so a rewritten file takes effect), and start the daemon. */
export function serviceStart(home = homedir()): void {
  backend()?.start(home);
}

function readPid(): number {
  try { return Number(readFileSync(join(STATE_DIR, 'daemon.pid'), 'utf8').trim()) || 0; } catch { return 0; }
}


export async function serviceCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const svc = backend();
  if (!svc) throw new Error('angelia service supports macOS (launchd) and Linux (systemd --user). Here, run angelia daemon under your own supervisor.');
  const force = rest.includes('--force');
  const args = rest.filter((a) => a !== '--force');
  switch (sub) {
    case 'install': {
      if (svc.name === 'systemd' && !systemdAvailable()) {
        throw new Error('angelia service needs systemd --user here (systemctl --user does not answer). Run angelia daemon under your own supervisor.');
      }
      const other = force ? undefined : otherInstance();
      if (other) throw new Error(other);
      const config = resolve(configPath(args[0]));
      // A table that does not load never becomes a service. The PATH comes from the accepted table: a
      // bin an agent wrote into the table must not become a folder on the daemon's PATH.
      const cfg = effectiveTable(loadConfig(config), STATE_DIR).cfg;
      const bins = pathWithBins(cfg);
      const extra = [...bins.path.split(delimiter), dirname(process.execPath)];
      const text = svc.render({
        node: stableNode(), entry: entry(), config, stateDir: STATE_DIR,
        path: servicePath(process.env, extra), home: homedir(), lang: process.env.LANG,
      });
      mkdirSync(dirname(svc.filePath()), { recursive: true });
      writeFileSync(svc.filePath(), text, { mode: 0o644 });
      console.log(`wrote ${svc.filePath()}`);
      const pid = readPid();
      if (serviceLoaded()) {
        console.log(svc.name === 'systemd'
          ? 'The service is already loaded. The new unit takes effect at the next angelia restart (or /restart from a chat).'
          : 'The service is already loaded. The new plist takes effect at the next angelia restart (or /restart from a chat).');
      } else if (isDaemonPid(pid)) {
        // Enabled now, started at the handover: a unit never enabled would not start at boot.
        if (svc.name === 'systemd') systemdEnable();
        console.log(`A daemon started by hand is running (pid ${pid}). angelia restart, or /restart from a chat, moves it onto the service.`);
      } else {
        serviceStart();
        console.log(`Service loaded: the daemon starts now and at every ${svc.name === 'systemd' ? 'boot' : 'login'}.`);
      }
      if (svc.name === 'systemd') {
        const advice = linger(userInfo().username);
        if (advice) console.log(advice);
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
      svc.remove();
      console.log('Service removed. The daemon is stopped; start it by hand with angelia daemon, or install the service again.');
      break;
    }
    case 'status': {
      const pid = readPid();
      console.log(`file    ${serviceInstalled() ? svc.filePath() : 'not installed'}`);
      console.log(`loaded  ${serviceLoaded() ? 'yes' : 'no'}`);
      console.log(`daemon  ${isDaemonPid(pid) ? `pid ${pid}` : 'not running'}`);
      break;
    }
    default:
      throw new Error('usage: angelia service <install [routing.yaml]|uninstall|status>');
  }
}
