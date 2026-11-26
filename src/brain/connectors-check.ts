import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_ENV } from './argv.js';
import { deniedConnectorCount, trackGroup } from './brain.js';

/**
 * tmux mode's count of the connectors a `connectors: all` launch blocks. A pane has no stderr for
 * Angelia to read, and its screen shows no "blocked by enterprise policy" line (measured on Claude Code
 * 2.1.332: not at the start, not in /mcp). `claude --settings <deny> mcp list` costs no model call and
 * leaves the denied connectors out of its list, but does not name them either. So the list is read
 * twice, with the launch's MCP keys and with them less the connector denies, in the profile's folder
 * and with a minimal environment: the connectors only the second names are the ones the launch
 * blocks, the same names the print-mode warning gives (blockedConnectorNames).
 */

/** How long one `claude mcp list` may take: it health-checks every server (measured: about 12 s). */
export const MCP_LIST_TIMEOUT_MS = 90_000;

/**
 * The claude.ai connectors in the output of `claude mcp list` (2.1.332): one line per server,
 * "<name>: <url or command> - <status>", a connector's name starting with "claude.ai " and its address
 * with http. The first ": http" ends the name, since a name can hold a colon but no ": http".
 */
export function listedConnectors(out: string): string[] {
  return [...new Set(out.split('\n').flatMap((l) => { const m = /^(claude\.ai .+?): https?:\/\/\S+ - /.exec(l.trim()); return m ? [m[1]] : []; }))];
}

/**
 * What a `claude mcp list` run gets of the profile's environment: only what claude needs to find its
 * config and its sign-in, and to reach the network. No granted secret, no ANGELIA_SESSION_KEY, no
 * chat's ANGELIA_API_TOKEN: every stdio server the run does not deny starts with this environment.
 */
export const MCP_LIST_ENV = [
  'HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
  'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
];

export function mcpListEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of MCP_LIST_ENV) if (base[k] !== undefined) env[k] = base[k];
  return { ...env, ...extra };
}

/**
 * The launch's MCP keys less its connector denies (serverUrl entries): the plain run's settings. It
 * still keeps the denied servers by name and the folder's .mcp.json out, so no server the launch
 * denies starts in the plain run either; only the connectors it drops come back. Undefined when
 * nothing is left.
 */
export function plainSettings(settings: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = { ...settings };
  if (Array.isArray(settings.deniedMcpServers)) {
    const names = settings.deniedMcpServers.filter((e) => !(e && typeof e === 'object' && 'serverUrl' in e));
    if (names.length) out.deniedMcpServers = names; else delete out.deniedMcpServers;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Where the settings files of the list runs go: under the state folder's compiled/, which every
 * profile's deny floor closes, never the temp folder, which the agent's Bash can read (it runs as
 * the same user, and mode 0600 does not keep it out). Each run's file is removed when it ends.
 */
export const mcpListRoot = (stateDir: string): string => join(stateDir, 'compiled', 'mcp-list');

/** The files a daemon that died mid-check left: removed at daemon start (daemon.ts). It removes every
 *  run folder, not only the dead daemon's: one daemon runs per state folder (daemon.pid), so no run of
 *  a daemon can be going. A run of another process at that moment (a tmux pane of `angelia canary`)
 *  loses its settings file: its list fails, and that check says it cannot tell (null), never more. */
export function clearMcpListFiles(stateDir: string): void { rmSync(mcpListRoot(stateDir), { recursive: true, force: true }); }

/** The most of a list's output that is read. */
const MCP_LIST_MAX = 4 << 20;

/**
 * One `claude mcp list`, with these settings when given: its connectors, or null when it failed. It
 * runs in its own process group under a timer of ours: at the timeout the whole group is killed and
 * the answer is given at once, so a claude that does not exit, or a server it started that holds its
 * output open, never holds the queue of checks. The settings go by a private file under mcpListRoot of
 * `stateDir`, never on the command line: they name the dropped connectors' addresses, and any process
 * of the user (the agent's too) can list a command line.
 */
export function mcpListConnectors(bin: string, cwd: string, env: NodeJS.ProcessEnv, stateDir: string, settings?: Record<string, unknown>, timeoutMs = MCP_LIST_TIMEOUT_MS): Promise<string[] | null> {
  let dir: string | undefined;
  const args = ['mcp', 'list'];
  if (settings) {
    try {
      const root = mcpListRoot(stateDir);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      dir = mkdtempSync(join(root, 'run-'));
      const file = join(dir, 'settings.json');
      writeFileSync(file, JSON.stringify(settings), { mode: 0o600 });
      args.unshift('--settings', file);
    } catch { if (dir) rmSync(dir, { recursive: true, force: true }); return Promise.resolve(null); }
  }
  return new Promise((done) => {
    const child = spawn(bin, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    trackGroup(child); // the daemon's exit ends it too
    let out = '', over = false;
    const end = (result: string[] | null): void => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      // Whatever is left of the run (a server it started) goes with it.
      if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is gone */ }
      child.stdout.destroy();
      if (dir) rmSync(dir, { recursive: true, force: true });
      done(result);
    };
    const timer = setTimeout(() => end(null), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { out += d; if (out.length > MCP_LIST_MAX) end(null); });
    child.on('error', () => end(null));
    child.on('close', (code) => end(code === 0 ? listedConnectors(out) : null));
  });
}

/** The checks run one profile at a time (two `claude mcp list` runs at once, not two per profile). */
let queue: Promise<unknown> = Promise.resolve();

/**
 * The connectors the launch's MCP keys (`settings`) block: listed without its connector denies, not
 * with them. `env` is the profile's; the runs get only mcpListEnv of it. `stateDir`: the daemon's state
 * folder, where the runs' settings files go (mcpListRoot). Null when it cannot tell: a
 * list failed; the plain list names no connector (the account has none, or its connector list did not
 * load), so a short count would say nothing about the addresses; or the list with the denies names no
 * connector while the plain one names more than the denies have addresses (its connector list did not
 * load either, and every connector would count as blocked).
 */
export function tuiBlockedConnectors(bin: string, cwd: string, env: NodeJS.ProcessEnv, settings: Record<string, unknown>, stateDir: string, timeoutMs = MCP_LIST_TIMEOUT_MS): Promise<string[] | null> {
  const run = async (): Promise<string[] | null> => {
    const e = mcpListEnv(env, CLAUDE_ENV);
    const [all, kept] = await Promise.all([mcpListConnectors(bin, cwd, e, stateDir, plainSettings(settings), timeoutMs), mcpListConnectors(bin, cwd, e, stateDir, settings, timeoutMs)]);
    if (!all || !kept || !all.length) return null;
    if (!kept.length && all.length > deniedConnectorCount(settings)) return null;
    const left = new Set(kept);
    return all.filter((n) => !left.has(n));
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}
