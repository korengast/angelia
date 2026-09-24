import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { STRIP_ENV } from '../brain/argv.js';
import type { Config } from '../instance/config/schema.js';
import { allCapabilityEnv } from '../capabilities/resolve.js';

/** `~/.angelia/env`: `NAME=value` lines, `export` and quotes allowed. The daemon reads it itself
 *  (launchd gives it no shell that sourced the file) and keeps the values in memory, never in
 *  `process.env`, so nothing it starts inherits them by accident. Values are never printed. */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

/** Set one variable in the env file and leave every other line as it was; the file stays mode 600.
 *  Rewriting the file with one line would delete every capability secret stored beside the token. */
export function setEnvVar(path: string, name: string, value: string): void {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').replace(/\n$/, '').split('\n') : [];
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}=`);
  const at = lines.findIndex((l) => re.test(l));
  if (at >= 0) lines[at] = `${name}=${value}`; else lines.push(`${name}=${value}`);
  writeFileSync(path, lines.filter((l, i) => l !== '' || i < lines.length - 1).join('\n') + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Set per agent by the daemon (its chat, its API token), so never passed down from the daemon's own
 *  environment: a daemon restarted from inside an agent must not hand one chat's identity to all. */
export const SESSION_ENV = ['ANGELIA_SESSION_KEY', 'ANGELIA_API_TOKEN'];

export interface ChildEnv {
  /** What the child gets. */
  env: NodeJS.ProcessEnv;
  /** The secret names it was given: the variables its profile's capabilities declare. */
  granted: string[];
  /** Secret names it must never see, even from a host that still carries them (a tmux server
   *  started by an older daemon, or from a shell that exported them). */
  withheld: string[];
}

/** Secret names the table implies, whether or not `~/.angelia/env` holds them: the bot token's variable,
 *  and every variable a capability declares (it may come from the daemon's own shell). */
export function tableSecrets(cfg: Config): string[] {
  return [...(cfg.telegram ? [cfg.telegram.token_env] : []), ...allCapabilityEnv(cfg)];
}

/**
 * The environment of anything the daemon starts for a profile: its agent, `/sh`, its jobs.
 *
 * `secrets` is what `~/.angelia/env` holds; `hidden` names more secrets that may sit in `base` (the
 * bot token when the daemon's own shell exported it, every variable any capability declares). None
 * of them reaches the child except the names in `want`, the `env:` of the MCP capabilities this
 * profile is allowed: the bank's login goes to the profile given the bank and to no other. The
 * billing variables never go, even when a capability names one.
 *
 * With no `want`, this is the environment of a host every profile shares: Angelia's tmux server.
 */
export function profileEnv(base: NodeJS.ProcessEnv, secrets: Record<string, string>, hidden: string[], want: string[] = []): ChildEnv {
  const secret = new Set([...hidden, ...Object.keys(secrets)]);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!secret.has(k) && !STRIP_ENV.includes(k) && !SESSION_ENV.includes(k)) env[k] = v;
  const granted: string[] = [];
  for (const k of new Set(want)) {
    const v = secrets[k] ?? base[k];
    if (v === undefined || STRIP_ENV.includes(k)) continue;
    env[k] = v;
    granted.push(k);
  }
  return { env, granted: granted.sort(), withheld: [...secret].filter((k) => !granted.includes(k)).sort() };
}
