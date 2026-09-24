import { readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, join, relative, isAbsolute, sep } from 'node:path';
import { parse } from 'yaml';
import { Config, Profile } from './schema.js';
import { expandHome, isInside } from '../../core/paths.js';
import { isGroupChat } from '../../core/types.js';
import { EVERYONE } from '../../core/router/gate.js';

export class ConfigError extends Error {}

/** Legal but risky combinations. Printed by check-config and logged by the daemon; never fatal. */
export function configWarnings(cfg: Config, workspace?: string): string[] {
  const out: string[] = [];
  cfg.routes.forEach((r, i) => {
    const p = cfg.profiles[r.profile];
    if (!p) return;
    const where = `routes[${i}] (${r.platform} ${r.chat})`;
    const groupish = isGroupChat(r.platform, r.chat);
    if (groupish && p.shell && !r.owners.length) out.push(`${where}: shell: true on a group route with no owners: /sh is refused for everyone there`);
    if (groupish && r.mention === 'any') out.push(`${where}: mention: any in a group: every message goes to the agent`);
    const everyone = r.allow_from.includes(EVERYONE);
    if (groupish && everyone) out.push(`${where}: allow_from: "*", so every member of this group can talk to the agent and steer it within ${p.permission_mode}: reading your files, and anything its approvals let through${p.isolated ? '' : `. It can also message your other profiles; set isolated: true on ${r.profile} unless it needs them`}. A list of numbers is safer than "*"`);
    if (groupish && !everyone && !r.allow_from.length && !r.owners.length) out.push(`${where}: no owners and no allow_from: nobody in this group can talk to the agent`);
  });
  for (const [name, p] of Object.entries(cfg.profiles)) {
    if (p.tui && p.backend !== 'claude-code') out.push(`profiles.${name}: tui: true is Claude Code only and is ignored by ${p.backend}`);
  }
  const used = new Set(cfg.routes.map((r) => r.profile));
  for (const name of Object.keys(cfg.profiles)) {
    // Dead config is not harmless: it reads like a live grant, and the day a route is added back
    // nobody rereads what the profile allows.
    if (!used.has(name)) out.push(`profiles.${name}: no route names it, so nothing reaches it — delete it, or add the route it is waiting for`);
  }
  for (const [name, c] of Object.entries(cfg.capabilities)) {
    if ((c.kind === 'skill' || c.kind === 'directory') && !existsSync(expandHome(c.path))) out.push(`capabilities.${name}: ${c.path} does not exist`);
    // A skill is instance knowledge and belongs in the repo. A directory is usually data, which stays out.
    if (c.kind === 'skill' && workspace && !isInside(c.path, workspace)) out.push(`capabilities.${name}: the skill lives outside the workspace (${c.path}), so it is not in git and does not move with the instance; move it to _capabilities/skills/${name}/ and write path: _capabilities/skills/${name} (angelia guide capabilities)`);
  }
  for (const [name, p] of Object.entries(cfg.profiles)) for (const w of selfDenyWarnings(name, p.cwd)) out.push(w);
  for (const k of removed.get(cfg) ?? []) out.push(`${k}: ${REMOVED_NOTE}`);
  if (cfg.defaults.unmatched === 'reply') out.push('defaults.unmatched: reply answers strangers and confirms the bot is alive; drop is the quiet default');
  return out;
}

/**
 * A deny rule in the profile's own settings that covers the profile's own folder. Seen 2026-09-22:
 * a profile moved into the instance kept `Edit(~/.angelia/**)`, written when that path was only
 * the router's state, and could no longer write its own memory. The CLI enforces the rule silently.
 */
export function selfDenyWarnings(name: string, cwd: string, home = homedir()): string[] {
  let deny: unknown;
  try { deny = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'))?.permissions?.deny; } catch { return []; }
  if (!Array.isArray(deny)) return [];
  const real = resolve(cwd);
  const out: string[] = [];
  for (const rule of deny as unknown[]) {
    const m = /^(Read|Edit)\((.+)\)$/.exec(String(rule));
    if (!m) continue;
    // Only a folder rule can cover a whole home: `x/**`, or `//x/**` in Claude's absolute form.
    const g = /^(.*?)\/?\*\*$/.exec(m[2]);
    if (!g) continue;
    // Claude's four forms: //abs is absolute, ~/x is under home, /x is from the project root (the folder
    // holding .claude/), and x or ./x from the folder it runs in: for a profile, both are its cwd.
    const r = g[1];
    const root = m[2].startsWith('//') ? resolve(r.slice(1) || '/') : r === '~' || r.startsWith('~/') ? resolve(join(home, r.slice(1))) : resolve(real, r.replace(/^\/+/, ''));
    if (isInside(real, root)) out.push(`profiles.${name}: .claude/settings.json denies ${rule}, which covers the profile's own folder ${cwd}; the agent cannot ${m[1] === 'Edit' ? 'write its own files' : 'read its own files'} there`);
  }
  return out;
}

export { expandHome };

const SECRET_MARKERS = ['.env', 'secrets'];

/**
 * Keys Angelia no longer has. Payments and fingerprint approvals were removed on 2026-09-23; a table
 * written before that still loads, so an upgrade never stops a running instance, and check-config
 * and the daemon name each leftover so it can be deleted.
 */
const REMOVED_KEYS = ['pay', 'approvals'];
const REMOVED_NOTE = 'payments and fingerprint approvals were removed from Angelia on 2026-09-23; this is ignored, delete it';
const removed = new WeakMap<Config, string[]>();

function removedKeys(raw: unknown): string[] {
  const has = (o: unknown, k: string) => !!o && typeof o === 'object' && k in o;
  const r = raw as { profiles?: Record<string, unknown>; onboard?: { profile?: unknown } } | undefined;
  const out = REMOVED_KEYS.filter((k) => has(r, k));
  for (const [name, p] of Object.entries(r?.profiles ?? {})) for (const k of REMOVED_KEYS) if (has(p, k)) out.push(`profiles.${name}.${k}`);
  for (const k of REMOVED_KEYS) if (has(r?.onboard?.profile, k)) out.push(`onboard.profile.${k}`);
  return out;
}

export function loadConfig(path: string): Config {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(`cannot read ${path}: ${(e as Error).message}`);
  }
  const parsed = Config.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ConfigError(`${first.path.join('.') || '<root>'}: ${first.message}`);
  }
  const cfg = parsed.data;
  removed.set(cfg, removedKeys(raw));
  for (const [name, p] of Object.entries(cfg.profiles)) {
    p.cwd = resolve(expandHome(p.cwd));
    p.add_dirs = p.add_dirs.map((d) => resolve(expandHome(d)));
    if (!existsSync(p.cwd) || !statSync(p.cwd).isDirectory()) {
      throw new ConfigError(`profiles.${name}.cwd: not a directory: ${p.cwd}`);
    }
    if (p.permission_mode === 'bypassPermissions' && !p.unsafe_ok) {
      // add_dirs are as reachable to the agent as cwd is, and are often the wider grant of the two:
      // a profile whose own folder is clean can still be handed a whole home directory next to it.
      for (const dir of [p.cwd, ...p.add_dirs]) {
        const hit = SECRET_MARKERS.find((m) => existsSync(join(dir, m)));
        if (hit) {
          const where = dir === p.cwd ? 'a directory' : `${dir}, which it can also reach,`;
          throw new ConfigError(
            `profiles.${name}: bypassPermissions on ${where} containing ${hit}; set unsafe_ok: true to allow`,
          );
        }
      }
    }
  }
  if (cfg.defaults.unmatched === 'onboard' && !cfg.onboard) throw new ConfigError('defaults.unmatched: onboard needs an onboard: { owners } block');
  if (cfg.onboard) {
    // Checked now, not on the day a new chat arrives and the profile it makes fails to load.
    const t = Profile.safeParse({ ...cfg.onboard.profile, cwd: '/' });
    if (!t.success) { const f = t.error.issues[0]; throw new ConfigError(`onboard.profile.${f.path.join('.')}: ${f.message}`); }
    if ('cwd' in cfg.onboard.profile) throw new ConfigError('onboard.profile.cwd: each new profile gets its own folder; set onboard.folder for where they go');
  }
  cfg.routes.forEach((r, i) => {
    if (!cfg.profiles[r.profile]) throw new ConfigError(`routes[${i}].profile: unknown profile "${r.profile}"`);
    // Every member of the group would run commands on this machine with no prompt and nothing around them.
    const p = cfg.profiles[r.profile];
    if (isGroupChat(r.platform, r.chat) && p.permission_mode === 'bypassPermissions' && r.allow_from.includes(EVERYONE) && !(p.sandbox && p.backend === 'claude-code')) {
      throw new ConfigError(`routes[${i}] (${r.platform} ${r.chat}): a group on the bypassPermissions profile ${r.profile}, open to every member (allow_from: "*"), without the sandbox. List who may in allow_from, or set sandbox: true on a Claude Code profile`);
    }
    // A route for a platform the table does not set up passes the router and has nobody to reply
    // through: the daemon crashed in reply(), and the API answered with the raw TypeError.
    if (!cfg[r.platform]) throw new ConfigError(`routes[${i}]: a ${r.platform} route, and the table has no ${r.platform}: block to send through`);
  });
  // A relative capability path is read from the table's own folder, the workspace, and never from
  // wherever the command happened to run: `_capabilities/<name>` then works on any machine.
  const base = dirname(resolve(path));
  for (const c of Object.values(cfg.capabilities)) {
    if (c.kind === 'skill' || c.kind === 'directory') c.path = resolve(base, expandHome(c.path));
    if (c.kind === 'skill' || c.kind === 'mcp') c.secrets = c.secrets.map((s) => resolve(base, expandHome(s)));
  }
  // A misspelt name in a deny list is a hole that looks like a wall, so every name must exist.
  const known = (where: string, names: string[]) => {
    for (const n of names) if (!cfg.capabilities[n]) throw new ConfigError(`${where}: unknown capability "${n}"`);
  };
  known('defaults.capabilities', cfg.defaults.capabilities);
  known('defaults.deny', cfg.defaults.deny);
  const both = cfg.defaults.capabilities.filter((n) => cfg.defaults.deny.includes(n));
  if (both.length) throw new ConfigError(`defaults: ${both.join(', ')} both given and denied`);
  for (const [name, p] of Object.entries(cfg.profiles)) {
    known(`profiles.${name}.capabilities`, p.capabilities);
    known(`profiles.${name}.except`, p.except);
    known(`profiles.${name}.deny`, p.deny);
    const clash = p.capabilities.filter((n) => p.deny.includes(n));
    if (clash.length) throw new ConfigError(`profiles.${name}: ${clash.join(', ')} both given and denied`);
  }
  if (cfg.whatsapp) cfg.whatsapp.auth_dir = resolve(expandHome(cfg.whatsapp.auth_dir));
  return cfg;
}
