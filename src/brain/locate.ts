import { execFileSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import type { Config, Profile } from '../instance/config/schema.js';
import type { BackendName } from './brain.js';

/** Default executable per backend; a profile's `bin:` wins. */
export const DEFAULT_BIN: Record<BackendName, string> = { 'claude-code': 'claude', grok: 'grok', pi: 'pi', codex: 'codex', agy: 'agy' };

/** Where the CLIs install themselves when PATH does not say. The daemon must not depend on
 *  the PATH of whatever shell started it: on 2026-09-21 a restart inherited one without
 *  ~/.local/bin, every tmux pane ran `claude`, found nothing and died, and the chat heard only
 *  "the agent exited while starting". */
export function fallbackDirs(home = homedir()): string[] {
  return [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.bun', 'bin'), join(home, '.npm-global', 'bin'), '/usr/bin'];
}

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
}

/** An absolute path to `bin`, or undefined. A name is looked up on PATH first, then in the usual
 *  install folders; a path (anything with a slash, `~` allowed) is taken as given. */
export function locateBin(bin: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
  if (bin.includes('/')) {
    const p = bin === '~' || bin.startsWith('~/') ? join(home, bin.slice(1)) : resolve(bin);
    return executable(p) ? p : undefined;
  }
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), ...fallbackDirs(home)];
  for (const d of dirs) if (executable(join(d, bin))) return join(d, bin);
  return undefined;
}

/** The executable a profile runs. */
export function profileBin(p: Profile): string {
  return p.bin ?? DEFAULT_BIN[p.backend];
}

/** The oldest agy Angelia drives: the one ADR 0017 measured (`agy acp`, session/resume, set_model). */
export const MIN_AGY_VERSION = '1.5.14';

/** `a` is older than `b`, both x.y.z. */
export function olderThan(a: string, b: string): boolean {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

const versions = new Map<string, string | undefined>();
/** `bin --version`, once per binary per process: x.y.z, or undefined when it does not say. */
export function binVersion(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!versions.has(bin)) {
    let v: string | undefined;
    try { v = /(\d+\.\d+\.\d+)/.exec(execFileSync(bin, ['--version'], { env, timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))?.[1]; } catch { v = undefined; }
    versions.set(bin, v);
  }
  return versions.get(bin);
}

/** One line per profile whose CLI cannot be found, or (agy) is older than Angelia drives, for
 *  check-config and the daemon log. */
export function cliWarnings(cfg: Config, env: NodeJS.ProcessEnv = process.env, home = homedir(), version: (bin: string) => string | undefined = (b) => binVersion(b, env)): string[] {
  const out: string[] = [];
  for (const [name, p] of Object.entries(cfg.profiles)) {
    const bin = profileBin(p);
    const found = locateBin(bin, env, home);
    if (found && p.backend === 'agy') {
      const v = version(found);
      if (!v) out.push(`profiles.${name}: \`${found} --version\` did not print a version; Angelia drives agy ${MIN_AGY_VERSION} or newer`);
      else if (olderThan(v, MIN_AGY_VERSION)) out.push(`profiles.${name}: agy ${v} is older than ${MIN_AGY_VERSION}, the oldest Angelia drives; update agy`);
    }
    if (found) continue;
    out.push(p.bin
      ? `profiles.${name}.bin: ${bin} is not an executable file: every turn in this profile will fail`
      : `profiles.${name}: ${p.backend} runs \`${bin}\`, which is not on PATH or in ${fallbackDirs(home).join(', ')}: every turn in this profile will fail. Install it, or set bin: to its full path`);
  }
  return out;
}

/** PATH with the folder of every located CLI added at the end, so the agents themselves (and a
 *  later restart, which copies this environment) can find them by name too. */
export function pathWithBins(cfg: Config, env: NodeJS.ProcessEnv = process.env, home = homedir()): { path: string; added: string[] } {
  const parts = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const added: string[] = [];
  for (const p of Object.values(cfg.profiles)) {
    const found = locateBin(profileBin(p), env, home);
    if (!found) continue;
    const d = dirname(found);
    if (!parts.includes(d) && !added.includes(d)) added.push(d);
  }
  return { path: [...parts, ...added].join(delimiter), added };
}
