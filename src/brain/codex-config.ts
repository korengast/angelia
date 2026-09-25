import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Profile } from '../instance/config/schema.js';

/**
 * Codex's own sandbox holds a Codex profile to Angelia's rules: `-c` overrides on the app-server's
 * command line (not a file the agent could edit) define a permission profile, and macOS Seatbelt
 * (bubblewrap on Linux) enforces it for every command the agent runs, shell included. Measured
 * 2026-09-25 on codex-cli 0.157.0 with `codex sandbox`: a `deny` entry blocked a read directly,
 * through a shell and through a symlink, a listing and a write; network is off unless enabled. With
 * network on and Codex's network proxy off, every Unix socket on the machine is reachable (found by a
 * review, then measured): the proxy is on, all web domains allowed, and only Angelia's socket listed.
 */

/** Codex profiles run sandboxed unless the profile says `sandbox: false`. */
export const codexSandboxed = (p: Profile): boolean => p.sandbox !== false;

/** The permission profile's name in Codex's config. */
export const CODEX_PROFILE = 'angelia';

/** A TOML inline table of string values: `{"key"="value", ...}`. JSON's string escapes are TOML's. */
export function tomlTable(entries: Record<string, string>): string {
  // TOML also wants DEL escaped; a lone surrogate stays an escape Codex refuses, so it fails closed.
  const q = (x: string) => JSON.stringify(x).replace(/\x7f/g, '\\u007F');
  return `{${Object.entries(entries).map(([k, v]) => `${q(k)}=${q(v)}`).join(',')}}`;
}

/**
 * The filesystem entries of the profile's sandbox, from the rules compile wrote to its settings
 * (Claude's rule shapes): a path with a Read rule is denied (Codex cannot deny reading and allow
 * writing), one with only an Edit rule (the launch files) is read-only, and the profile's extra
 * folders are writable. A rule with a glob inside the path is left out and returned as skipped;
 * compile writes none, only an owner's own rule can.
 */
export function codexFilesystem(deny: string[], writable: string[], home = homedir()): { entries: Record<string, string>; skipped: string[] } {
  const kinds = new Map<string, Set<string>>();
  const skipped: string[] = [];
  const abs = (p: string) => {
    const x = p.replace(/^\/\//, '/');
    const e = x === '~' ? home : x.startsWith('~/') ? join(home, x.slice(2)) : x;
    return isAbsolute(e) ? resolve(e) : undefined;
  };
  for (const r of deny) {
    const m = /^(Read|Edit)\((.+)\)$/.exec(r);
    if (!m) continue;
    const path = abs(m[2].replace(/\/\*\*$/, ''));
    if (!path || path.includes('*')) { skipped.push(r); continue; }
    if (!kinds.has(path)) kinds.set(path, new Set());
    kinds.get(path)!.add(m[1]);
  }
  const entries: Record<string, string> = {};
  for (const d of writable) { const p = abs(d); if (p) entries[p] = 'write'; }
  for (const [path, k] of kinds) entries[path] = k.has('Read') ? 'deny' : 'read';
  return { entries, skipped };
}

const codexConfigText = (home: string): string => {
  try { return readFileSync(join(process.env.CODEX_HOME ?? join(home, '.codex'), 'config.toml'), 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw e; }
};

/** MCP servers set up in Codex's own config for every folder: `[mcp_servers.<name>]` tables (bare or
 *  quoted names) and keys of an `[mcp_servers]` table. Names only. */
export function codexUserMcpServers(home = homedir()): string[] {
  const text = codexConfigText(home);
  const names = new Set<string>();
  for (const m of text.matchAll(/^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*[\].]/gm)) names.add(m[1] ?? m[2] ?? m[3]);
  const table = /^\s*\[\s*mcp_servers\s*\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(text);
  if (table) for (const m of table[1].matchAll(/^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=/gm)) names.add(m[1] ?? m[2] ?? m[3]);
  return [...names].sort();
}

/**
 * Why Codex's merged config makes the profile unsafe to start, from `config/read` with its layers:
 * a layer other than Angelia's own flags (the owner's config, a trusted project's, the system's)
 * that sets anything under `permissions.angelia` would merge with it and can reopen what it closes
 * (a review proved it with `dangerously_allow_all_unix_sockets`); and a server the profile denies
 * must be off in the result. Read from Codex itself, so every TOML spelling counts.
 */
export function codexConfigConflict(read: { config?: Record<string, any>; layers?: Record<string, any>[] | null }, allowed: string[]): string | undefined {
  for (const l of read.layers ?? []) {
    // A layer Codex does not apply (an untrusted project's) cannot loosen anything.
    if (l.name?.type === 'sessionFlags' || l.disabledReason) continue;
    const mine = l.config?.permissions?.[CODEX_PROFILE];
    if (mine && typeof mine === 'object' && Object.keys(mine).length) return `a Codex config layer (${l.name?.file ?? l.name?.dotCodexFolder ?? l.name?.type ?? 'unknown'}) sets permissions.${CODEX_PROFILE}, which would merge with Angelia's sandbox rules; remove it there`;
  }
  // Every server Codex would load must be one the profile was given: names come from Codex's own
  // merged view, so a server written in any form, or in a trusted project's config, counts.
  const on = Object.entries(read.config?.mcp_servers ?? {}).filter(([n, v]) => !allowed.includes(n) && (v as Record<string, unknown>)?.enabled !== false).map(([n]) => n);
  return on.length ? `MCP servers this profile was not given would load: ${on.join(', ')}; switch them off in your Codex config or give them to the profile as capabilities` : undefined;
}

/** A profile's own cache folder, under Angelia's state: not temp, which every sandboxed profile may
 *  write (a review planted code in another profile's npx cache that way). Named by a hash, so no two
 *  profile names meet in one folder. */
export function codexCacheDir(stateDir: string, profileName: string): string {
  return join(stateDir, 'cache', 'codex', createHash('sha256').update(profileName).digest('hex').slice(0, 16));
}

/** Caches the common tools write into the home folder, moved into the profile's own cache folder
 *  (npm's error would otherwise advise `sudo chown`; ~/.npm/_npx holds code run later outside). */
export function codexCacheEnv(dir: string): NodeJS.ProcessEnv {
  return { npm_config_cache: join(dir, 'npm'), UV_CACHE_DIR: join(dir, 'uv'), PIP_CACHE_DIR: join(dir, 'pip'), XDG_CACHE_HOME: join(dir, 'xdg') };
}

export interface CodexLaunch {
  deny: string[];
  /** Folders besides cwd the agent may write: add_dirs, _common/, directory capabilities. */
  writable: string[];
  /** Angelia's API socket, which `angelia send-media` and `angelia turn` use from inside the sandbox. */
  socket?: string;
  home?: string;
}

/**
 * The `-c` overrides for `codex app-server`. CLAUDE.md is read through Codex's fallback name (it
 * looks for AGENTS.md first). Sandboxed, the permission profile extends `:workspace` (`:read-only`
 * in plan mode) with the deny floor, the writable folders and network on, which Angelia's socket
 * needs. A user-level MCP server the profile's rules deny (`mcp__<name>`) is switched off.
 */
export function codexOverrides(p: Profile, l: CodexLaunch): { args: string[]; skipped: string[]; refuse?: string } {
  const home = l.home ?? homedir();
  const args = ['-c', 'project_doc_fallback_filenames=["CLAUDE.md"]'];
  let skipped: string[] = [];
  if (codexSandboxed(p)) {
    const fs = codexFilesystem(l.deny, p.permission_mode === 'plan' ? [] : l.writable, home);
    skipped = fs.skipped;
    args.push('-c', `default_permissions=${JSON.stringify(CODEX_PROFILE)}`);
    args.push('-c', `permissions.${CODEX_PROFILE}.extends=${JSON.stringify(p.permission_mode === 'plan' ? ':read-only' : ':workspace')}`);
    if (Object.keys(fs.entries).length) args.push('-c', `permissions.${CODEX_PROFILE}.filesystem=${tomlTable(fs.entries)}`);
    args.push('-c', `permissions.${CODEX_PROFILE}.network.enabled=true`);
    // The proxy is what makes the socket list hold; the web stays open through it.
    args.push('-c', 'features.network_proxy=true');
    args.push('-c', `permissions.${CODEX_PROFILE}.network.domains=${tomlTable({ '*': 'allow' })}`);
    args.push('-c', `permissions.${CODEX_PROFILE}.network.unix_sockets=${tomlTable(l.socket ? { [l.socket]: 'allow' } : {})}`);
    // Deny rules make a plain "run outside the sandbox" useless: Codex keeps the whole sandbox on a yes
    // (measured 0.157.0). These let the agent ask for one folder instead, which a yes really adds.
    if (codexApproval(p) === 'on-request') args.push('-c', 'features.exec_permission_approvals=true', '-c', 'features.request_permissions_tool=true');
  }
  const denied = new Set(l.deny.filter((r) => r.startsWith('mcp__')).map((r) => r.slice(5)));
  for (const n of codexUserMcpServers(home)) {
    if (!denied.has(n)) continue;
    // A `-c` key keeps quotes as part of the name, so a name that needs them cannot be switched off here.
    if (!/^[A-Za-z0-9_-]+$/.test(n)) return { args, skipped, refuse: `the MCP server "${n}" in your Codex config is denied to this profile, but its name cannot be switched off from Angelia; rename it` };
    args.push('-c', `mcp_servers.${n}.enabled=false`);
  }
  return { args, skipped };
}

/** Angelia's permission modes in Codex's terms. An approval in Codex always means more than the
 *  sandbox gives, so default and acceptEdits ask only for that; bypass never asks and never widens; plan reads. */
export function codexApproval(p: Profile): 'on-request' | 'never' {
  return p.permission_mode === 'bypassPermissions' || p.permission_mode === 'plan' ? 'never' : 'on-request';
}

/**
 * What the agent is told about its sandbox, after Angelia's self prompt. The owner asked for this
 * (2026-09-25): a command the sandbox stops ends in a concrete suggestion, add_dirs. In default and
 * acceptEdits the agent may also ask to run it once outside the sandbox, which the owner answers in
 * the chat: a review measured that without that line Codex never asked, so those modes acted like bypass.
 */
export function codexSandboxNote(p: Profile, writable: string[], name = '<profile>'): string {
  if (!codexSandboxed(p)) return 'This Codex profile runs without a sandbox (sandbox: false in the routing table).';
  const plan = p.permission_mode === 'plan';
  const asks = p.permission_mode === 'default' || p.permission_mode === 'acceptEdits';
  return [
    plan
      ? 'You run inside Codex\'s sandbox, set by Angelia, in plan mode: you only read, you write nothing.'
      : `You run inside Codex's sandbox, set by Angelia. You may write only in: ${[p.cwd, ...writable].join(', ')}, and the temp folder. A .git folder at the top of those is read-only, so you cannot commit.`,
    'Some paths (credentials, Angelia\'s own state, other profiles\' folders) cannot be read at all. Network is web only (HTTP and HTTPS through a proxy): no SSH, no local ports, you cannot run a server and connect to it; add_dirs does not change that. Package caches (npm, pip, uv) live in your own cache folder. `ps` and `pkill` do not work.',
    `When the sandbox stops something ("Operation not permitted"), say so plainly and suggest the lasting fix: add the folder to add_dirs for this profile in routing.yaml, then \`angelia compile ${name} --write\` and a restart.${asks ? ' If the owner needs it now, you may also ask for access to that exact folder (write or read) for this turn; the owner approves or declines it in the chat. Asking to run a command fully outside the sandbox does not work here: the sandbox stays even after a yes.' : ' Do not try to get around the sandbox.'}`,
  ].join('\n');
}
