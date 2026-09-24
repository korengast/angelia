import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Capability, Config, Profile } from '../instance/config/schema.js';
import { resolveProfile } from './resolve.js';
import { SELF_END, SELF_START, upsertSelfBlock } from '../daemon/self.js';
import { API_SOCKET, HOME_PRIVATE, INSTANCE_DIR, STATE_PRIVATE, commonDir, workspaceDir } from '../instance/instance.js';
import { isInside } from '../core/paths.js';

/**
 * `angelia compile`: turn a profile's capabilities into the profile's own files, the ones its CLI
 * already reads. Nothing here runs inside the daemon; the daemon reads only the record's
 * `mcpStrict` and `blockLines` (argv.ts, daemon.ts), never the table's capabilities.
 *
 * What was measured and shaped this (claude 2.1.278, grok 1.0.40, 2026-09-21):
 * - A deny rule does not stop a skill: `/name` typed in the chat runs a denied skill in Claude, and
 *   grok ignores `Skill(...)` entirely. So a denied skill is kept ABSENT from the profile's skills
 *   folder; the deny entries are a second layer.
 * - `mcp__<server>` deny holds on both. Claude's `--strict-mcp-config` hides user-level servers.
 * - Path rules differ: Claude reads `Read(//abs)` as absolute and `Read(/abs)` as relative to the
 *   settings file; grok is the other way round. A wrong form is silently a no-op.
 * - Under bypassPermissions a shell command still reads any file. Said out loud, never implied away.
 *
 * Only what Angelia wrote itself (the record) is ever changed or removed. A hand entry that breaks
 * a deny stops the compile and is named; it is not "fixed".
 */

export const RECORD = join('.claude', 'angelia-compiled.json');

export interface CompiledRecord {
  version: 1;
  backend: Profile['backend'];
  links: Record<string, string>;
  mcpServers: string[];
  mcpStrict: boolean;
  deny: string[];
  additionalDirectories: string[];
  blockLines: string[];
  compiledAt: string;
  /** Claude: the sandbox keys compile set (`enabled` and no unsandboxed escape), when the profile asks. */
  sandbox?: boolean;
  /** Claude: Unix sockets compile lets the sandbox reach: the daemon's API. */
  sockets?: string[];
}

export function readRecord(cwd: string): CompiledRecord | undefined {
  try { return JSON.parse(readFileSync(join(cwd, RECORD), 'utf8')) as CompiledRecord; } catch { return undefined; }
}

/** A compiled Claude profile loads only its own .mcp.json. The one thing the daemon takes from a
 *  compile, read at launch like any other file the CLI itself would read. */
export function strictMcpArgs(cwd: string): string[] {
  const rec = readRecord(cwd);
  const file = join(cwd, '.mcp.json');
  return rec?.mcpStrict && existsSync(file) ? ['--strict-mcp-config', '--mcp-config', file] : [];
}

/**
 * What the last compile of a profile wrote, kept in the state folder, outside every profile: an agent
 * that deletes or edits the profile's own record, or breaks its settings file, cannot switch the check
 * off with it. The state folder is in the deny floor, and in the sandbox's reach only for reading the
 * socket.
 */
export interface LaunchGuard { cwd: string; deny: string[]; sandbox?: boolean }

const guardFile = (stateDir: string, name: string) => join(stateDir, 'compiled', `${encodeURIComponent(name)}.json`);

function writeGuard(stateDir: string, name: string, g: LaunchGuard): void {
  mkdirSync(join(stateDir, 'compiled'), { recursive: true, mode: 0o700 });
  writeFileSync(guardFile(stateDir, name), JSON.stringify(g, null, 2) + '\n', { mode: 0o600 });
}

/**
 * What stops a profile's agent from starting: empty means go. Fails closed: a profile never compiled,
 * a guard compiled for another folder, a settings file that cannot be read, a deny rule the last
 * compile wrote that is gone, the sandbox turned off. A rule the table added since the last compile
 * (an update that grew the floor) is not a refusal; floorWarnings names it.
 */
export function launchCheck(cfg: Config, name: string, stateDir = INSTANCE_DIR): string[] {
  const p = cfg.profiles[name];
  let g: LaunchGuard;
  try { g = JSON.parse(readFileSync(guardFile(stateDir, name), 'utf8')) as LaunchGuard; }
  catch (e) { return [(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'never compiled' : `the compiled record in ${join(stateDir, 'compiled')} cannot be read`]; }
  if (resolve(g.cwd) !== resolve(p.cwd)) return [`compiled for another folder (${g.cwd})`];
  const read = (f: string): Record<string, any> | undefined => {
    try { return JSON.parse(readFileSync(join(p.cwd, '.claude', f), 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; return undefined; }
  };
  const settings = read('settings.json'), local = read('settings.local.json') ?? {};
  if (!settings) return ['.claude/settings.json cannot be read, so the CLI would drop every deny rule in it'];
  const deny: string[] = settings.permissions?.deny ?? [];
  const out = g.deny.filter((r) => !deny.includes(r)).map((r) => `deny ${r}`);
  if (g.sandbox) {
    if (settings.sandbox?.enabled !== true || settings.sandbox?.allowUnsandboxedCommands !== false) out.push('sandbox off');
    if (local.sandbox?.enabled === false || local.sandbox?.allowUnsandboxedCommands === true) out.push('sandbox off in settings.local.json');
  }
  return out;
}

/**
 * Once, on the first start of a version with the state-side guard: each compiled profile that has no
 * guard yet takes its own record as what its last compile wrote, so an instance compiled before keeps
 * running, even when some profiles were compiled again before that start. A marker in the folder
 * makes it once; after that a missing guard means never compiled. Returns the profiles seeded.
 */
export function seedGuards(cfg: Config, stateDir = INSTANCE_DIR): string[] {
  const dir = join(stateDir, 'compiled');
  const marker = join(dir, '.seeded');
  if (existsSync(marker)) return [];
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const seeded: string[] = [];
  for (const [name, p] of Object.entries(cfg.profiles)) {
    const rec = readRecord(p.cwd);
    if (!rec || existsSync(guardFile(stateDir, name))) continue;
    writeGuard(stateDir, name, { cwd: p.cwd, deny: rec.deny, ...(rec.sandbox ? { sandbox: true } : {}) });
    seeded.push(name);
  }
  writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  return seeded;
}

export interface ProfilePlan {
  profile: string;
  changes: string[];
  conflicts: string[];
  duplicates: string[];
  notes: string[];
  apply(): void;
}

/** A path rule in the form this backend reads as absolute. For Claude a path under the home folder
 *  is written as `~/…` (measured: Claude 2.1.278 refuses the read), so the settings file carries no
 *  username and still holds after a move. grok keeps `/abs`: measured on grok 1.0.40, it ignores a `~` rule. */
export function pathRule(tool: 'Read' | 'Edit', path: string, backend: Profile['backend'], home = homedir()): string {
  const abs = resolve(path);
  if (backend === 'grok') return `${tool}(${abs})`;
  const h = resolve(home);
  return abs.startsWith(h + sep) ? `${tool}(~/${abs.slice(h.length + 1)})` : `${tool}(/${abs})`;
}

/**
 * The instance's own state that no agent may open (STATE_PRIVATE): every profile gets a Read and Edit
 * deny for these, whatever its capabilities. Measured on claude 2.1.280: the deny also refused a
 * plain `grep` of the path in Bash. A command that builds the path itself is beyond what a rule can
 * see, so this is not a sandbox.
 * The logs are not in it: ids and counts, which the agent mending the setup needs.
 */
export const STATE_FLOOR = [...STATE_PRIVATE.files, ...STATE_PRIVATE.dirs.map((d) => `${d}/**`)];

export function floorRules(backend: Profile['backend'], stateDir: string, home = homedir()): string[] {
  return STATE_FLOOR.flatMap((f) => [pathRule('Read', join(stateDir, f), backend, home), pathRule('Edit', join(stateDir, f), backend, home)]);
}

/** Your credentials (HOME_PRIVATE), denied to the profile's file tools. A profile that needs one, such
 *  as a deploy profile and ~/.ssh, names that folder in add_dirs; a wider grant (the home folder
 *  itself) does not lift it. */
export function credentialRules(p: Profile, home = homedir()): string[] {
  const lifted = (x: string) => p.add_dirs.some((d) => isInside(d, x, home));
  return [...HOME_PRIVATE.dirs.map((d) => join(home, d)).filter((d) => !lifted(d)).map(glob), ...HOME_PRIVATE.files.map((f) => join(home, f)).filter((f) => !lifted(f))]
    .flatMap((x) => [pathRule('Read', x, p.backend, home), pathRule('Edit', x, p.backend, home)]);
}

/** Every other profile's folder: one chat's instructions, memory and received files stay its own. A
 *  profile reaches another's folder only when its own folder, add_dirs or an allowed directory
 *  capability holds it (the workspace in add_dirs is how a master profile mends the others). A folder
 *  that holds this profile's own is left alone: denying it would lock the agent out of itself
 *  (check-config names that nesting). Other profiles' add_dirs are not denied: they are usually shared. */
export function otherProfileRules(cfg: Config, name: string, home = homedir()): string[] {
  const p = cfg.profiles[name];
  const dirs = [...resolveProfile(cfg, name).allowed.values()].flatMap((c) => (c.kind === 'directory' ? [c.path] : []));
  const reach = [p.cwd, ...p.add_dirs, ...dirs];
  const out = new Set<string>();
  for (const [n, q] of Object.entries(cfg.profiles)) {
    if (n === name || reach.some((r) => isInside(q.cwd, r, home) || isInside(r, q.cwd, home))) continue;
    for (const tool of ['Read', 'Edit'] as const) out.add(pathRule(tool, glob(q.cwd), p.backend, home));
  }
  return [...out];
}

/** All a profile is denied whatever its capabilities: Angelia's state, your credentials, the other profiles. */
export function profileFloor(cfg: Config, name: string, stateDir: string, home = homedir()): string[] {
  const p = cfg.profiles[name];
  return [...new Set([...floorRules(p.backend, stateDir, home), ...credentialRules(p, home), ...otherProfileRules(cfg, name, home)])];
}

/**
 * The profile's own files that decide how its agent is launched next time: the settings Claude merges,
 * Angelia's record (its mcpStrict decides which MCP servers load), the MCP list, the job file.
 * Measured on claude 2.1.280: under acceptEdits the first four already ask before a write; a deny turns
 * that prompt, which an owner might approve on a one-line preview, into a refusal, and covers grok.
 * The job file is pinned by its hash, and the scripts a job runs by jobPin (jobs.ts).
 */
export const LAUNCH_FILES = [join('.claude', 'settings.json'), join('.claude', 'settings.local.json'), RECORD, '.mcp.json', 'angelia-jobs.yaml'];

/** One warning per profile whose settings lack part of the floor: never compiled, or compiled before
 *  the floor grew (an update, a new profile). */
export function floorWarnings(cfg: Config, stateDir = INSTANCE_DIR, home = homedir()): string[] {
  return Object.keys(cfg.profiles).flatMap((name) => {
    const deny = settingsDeny(cfg.profiles[name].cwd);
    const missing = profileFloor(cfg, name, stateDir, home).filter((r) => !deny.includes(r));
    return missing.length ? [`profiles.${name}: its agent's file tools may open Angelia's secrets, your credentials or another profile's folder (${missing.length} deny rules missing, such as ${missing[0]}); run angelia compile ${name} --write`] : [];
  });
}

function settingsDeny(cwd: string): string[] {
  try { return JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'))?.permissions?.deny ?? []; } catch { return []; }
}

/** Two profiles, one inside the other's folder: the outer one cannot be denied to the inner. */
export function nestingWarnings(cfg: Config, home = homedir()): string[] {
  const out: string[] = [];
  for (const [a, p] of Object.entries(cfg.profiles)) for (const [b, q] of Object.entries(cfg.profiles)) {
    if (a !== b && p.cwd !== q.cwd && isInside(q.cwd, p.cwd, home)) out.push(`profiles.${b}: its folder is inside profiles.${a}'s (${p.cwd}), so ${b}'s agent can read ${a}'s files; give each profile a folder of its own`);
  }
  return out;
}

function glob(p: string): string { return p.endsWith('**') || p.includes('*') ? p : `${p.replace(/\/+$/, '')}/**`; }

function denyEntries(name: string, c: Capability, backend: Profile['backend'], home: string): string[] {
  const out: string[] = [];
  if (c.kind === 'mcp') out.push(`mcp__${name}`);
  // grok rejects Skill(...) as an unknown tool prefix (grok inspect: "skipped"), so it only gets the path rules.
  if (c.kind === 'skill') out.push(...(backend === 'grok' ? [] : [`Skill(${name})`]), pathRule('Read', glob(c.path), backend, home), pathRule('Edit', glob(c.path), backend, home));
  if (c.kind === 'directory') out.push(pathRule('Read', glob(c.path), backend, home), pathRule('Edit', glob(c.path), backend, home));
  if (c.kind === 'skill' || c.kind === 'mcp') for (const s of c.secrets) out.push(pathRule('Read', s, backend, home), pathRule('Edit', s, backend, home));
  return out;
}

function blockLines(allowed: Map<string, Capability>): string[] {
  const lines: string[] = [];
  for (const [name, c] of allowed) {
    if (c.kind === 'command') lines.push(`- ${name}: run \`${c.run}\` when ${c.when}.`);
    else if (c.kind === 'mcp' && c.when) lines.push(`- ${name} (MCP server): ${c.when}.`);
    else if (c.kind === 'directory' && c.when) lines.push(`- ${name} (folder ${c.path}): ${c.when}.`);
  }
  if (!lines.length) return [];
  return ['Capabilities of this profile, compiled by Angelia from the routing table (change them there, then angelia compile):', ...lines];
}

/** The text between the markers: the self prompt where the backend reads it from the file, then the lines. */
export function blockText(self: string | undefined, lines: string[]): string {
  return [self, lines.join('\n')].filter(Boolean).join('\n\n');
}

function readJson(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new Error(`${path} is not valid JSON (${(e as Error).message}); fix it by hand first`); }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function mcpEntry(c: Extract<Capability, { kind: 'mcp' }>): Record<string, unknown> {
  if (c.url) return { type: 'http', url: c.url };
  const e: Record<string, unknown> = { command: c.command, args: c.args };
  // Claude expands ${VAR} in .mcp.json from its own environment: the value never lands in a file.
  if (c.env.length) e.env = Object.fromEntries(c.env.map((k) => [k, `\${${k}}`]));
  return e;
}

export interface PlanOptions { home?: string; self?: (profile: string) => string; /** The instance's state folder, for the floor. */ stateDir?: string }

/**
 * MCP servers configured for the whole user, which grok loads in every folder (it reads Claude's
 * ~/.claude.json too) and cannot switch off per folder. Names only; nothing else is read.
 */
export function userMcpServers(home = homedir()): string[] {
  const names = new Set<string>();
  // A missing file means no servers. Any other failure throws: a malformed file read as "no servers"
  // would drop every mcp__ deny on the next --write.
  const read = (f: string) => { try { return readFileSync(f, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw e; } };
  const claude = read(join(home, '.claude.json'));
  if (claude) {
    let servers: object;
    try { servers = (JSON.parse(claude) as { mcpServers?: object }).mcpServers ?? {}; }
    catch { throw new Error(`${join(home, '.claude.json')} is not valid JSON, so its MCP servers cannot be denied; fix the file, then compile again`); }
    for (const n of Object.keys(servers)) names.add(n);
  }
  for (const m of read(join(home, '.grok', 'config.toml')).matchAll(/^\[mcp_servers\.("?)([^\]"]+)\1\]/gm)) names.add(m[2]);
  return [...names].sort();
}

export function planProfile(cfg: Config, name: string, opts: PlanOptions = {}): ProfilePlan {
  const p = cfg.profiles[name];
  const home = opts.home ?? homedir();
  const stateDir = opts.stateDir ?? (opts.home ? join(opts.home, '.angelia') : INSTANCE_DIR);
  const { allowed, denied } = resolveProfile(cfg, name);
  const rec = readRecord(p.cwd);
  const changes: string[] = [], conflicts: string[] = [], duplicates: string[] = [], notes: string[] = [];

  // Skills: a link per allowed skill; a denied one must not be there at all.
  const skillsDir = join(p.cwd, '.claude', 'skills');
  const wantLinks: Record<string, string> = {};
  for (const [n, c] of allowed) if (c.kind === 'skill') wantLinks[n] = c.path;
  const oldLinks = rec?.links ?? {};
  const linkOps: (() => void)[] = [];
  for (const [n, target] of Object.entries(oldLinks)) {
    if (wantLinks[n] === target) continue;
    const at = join(skillsDir, n);
    if (isLinkTo(at, target)) { changes.push(`- skill link ${n}`); linkOps.push(() => unlinkSync(at)); }
  }
  for (const [n, target] of Object.entries(wantLinks)) {
    const at = join(skillsDir, n);
    if (existsOrLink(at)) {
      if (isLinkTo(at, target)) {
        // Right target, old spelling (a full path where a relative one now belongs): rewrite it in
        // place. A rename over the old link, so a running session never sees the skill missing.
        const text = linkText(target, skillsDir, home);
        if (readlinkSync(at) === text) continue;
        changes.push(`~ skill link ${n} → ${text}`);
        linkOps.push(() => { const tmp = `${at}.angelia-relink`; rmSync(tmp, { force: true }); symlinkSync(text, tmp); renameSync(tmp, at); });
        continue;
      }
      conflicts.push(`${at} exists and is not a link to ${target}; move it aside by hand`);
      continue;
    }
    if (!existsSync(target)) { conflicts.push(`skill ${n}: ${target} does not exist`); continue; }
    changes.push(`+ skill link ${n} → ${target}`);
    linkOps.push(() => { mkdirSync(skillsDir, { recursive: true }); symlinkSync(linkText(target, skillsDir, home), at); });
  }
  for (const [n, c] of denied) {
    if (c.kind !== 'skill') continue;
    const here = join(skillsDir, n);
    const oursBefore = n in oldLinks && isLinkTo(here, oldLinks[n]); // removed above
    if (existsOrLink(here) && !(n in wantLinks) && !oursBefore) conflicts.push(`denied skill ${n} is present at ${here}; a deny rule does not stop a skill typed as /${n}, so remove it by hand`);
    const user = join(home, '.claude', 'skills', n);
    if (existsOrLink(user)) conflicts.push(`denied skill ${n} is installed for every profile at ${user}; remove it there`);
  }

  // MCP. Claude: the profile's .mcp.json, loaded strictly, so user-level servers stay out — but only
  // when the profile denies a server. A profile that denies none (master) keeps the user-level ones too.
  const strict = p.backend === 'claude-code' && [...denied.values()].some((c) => c.kind === 'mcp');
  const mcpPath = join(p.cwd, '.mcp.json');
  const wantMcp: Record<string, Record<string, unknown>> = {};
  for (const [n, c] of allowed) if (c.kind === 'mcp') wantMcp[n] = mcpEntry(c);
  let mcpOp: (() => void) | undefined;
  if (p.backend === 'claude-code') {
    const cur = readJson(mcpPath);
    const servers: Record<string, unknown> = { ...(cur.mcpServers ?? {}) };
    const ours = new Set(rec?.mcpServers ?? []);
    // A missing file is made only when there is something to put in it, or strict mode needs it to
    // exist: a profile with no capability at all gets its deny floor and nothing else.
    let touched = !existsSync(mcpPath) && (Object.keys(wantMcp).length > 0 || strict);
    for (const n of ours) if (!(n in wantMcp) && n in servers) { delete servers[n]; changes.push(`- mcp server ${n}`); touched = true; }
    for (const [n, e] of Object.entries(wantMcp)) {
      if (n in servers && !ours.has(n) && !same(servers[n], e)) { conflicts.push(`${mcpPath} already has a hand-written server "${n}"; remove it or rename the capability`); continue; }
      if (!same(servers[n], e)) { servers[n] = e; changes.push(`+ mcp server ${n}`); touched = true; }
    }
    for (const [n, c] of denied) if (c.kind === 'mcp' && n in servers && !ours.has(n)) conflicts.push(`${mcpPath} lists "${n}", which this profile denies; remove it by hand`);
    if (strict && !rec?.mcpStrict) changes.push('+ strict MCP: only this folder\'s .mcp.json is loaded; user-level servers (such as github, tavily) are left out');
    if (!strict && rec?.mcpStrict) changes.push('- strict MCP: user-level servers (such as github, tavily) load again');
    if (!strict) notes.push('no MCP server is denied here, so MCP is not strict: user-level servers (such as github, tavily) load as well');
    if (touched) mcpOp = () => writeFileSync(mcpPath, JSON.stringify({ ...cur, mcpServers: servers }, null, 2) + '\n');
  } else {
    if (Object.keys(wantMcp).length) notes.push(`grok: allowed MCP servers are not written yet (${Object.keys(wantMcp).join(', ')}); add them with grok mcp add --scope project in ${p.cwd}`);
  }

  // Settings: deny entries and extra folders, only ever the ones recorded as ours.
  const settingsPath = join(p.cwd, '.claude', 'settings.json');
  const settings = readJson(settingsPath);
  const perms: Record<string, any> = { ...(settings.permissions ?? {}) };
  const launch = LAUNCH_FILES.map((f) => pathRule('Edit', join(p.cwd, f), p.backend, home));
  const wantDeny = [...new Set([...profileFloor(cfg, name, stateDir, home), ...launch, ...[...denied].flatMap(([n, c]) => denyEntries(n, c, p.backend, home))])];
  // grok has no strict mode: servers set up for the whole user reach every folder, so each one this
  // profile was not given is denied by name. (Claude leaves them out through --strict-mcp-config.)
  if (p.backend === 'grok') for (const n of userMcpServers(home)) if (!(n in wantMcp) && !wantDeny.includes(`mcp__${n}`)) wantDeny.push(`mcp__${n}`);
  const capDirs = [...allowed.values()].filter((c) => c.kind === 'directory').map((c) => (c as { path: string }).path);
  // The co-working folder every profile that is not isolated may read and write; an isolated one is
  // denied it. Only once the instance has a workspace to hold it.
  const common = commonDir(stateDir);
  const hasCommon = existsSync(workspaceDir(stateDir));
  const wantDirs = hasCommon && !p.isolated ? [...capDirs, common] : capDirs;
  if (hasCommon && p.isolated) for (const tool of ['Read', 'Edit'] as const) { const r = pathRule(tool, glob(common), p.backend, home); if (!wantDeny.includes(r)) wantDeny.push(r); }
  const merge = (key: 'deny' | 'additionalDirectories', want: string[], old: string[]) => {
    const list: string[] = [...(perms[key] ?? [])];
    let changed = false;
    for (const x of old) if (!want.includes(x)) { const i = list.indexOf(x); if (i !== -1) { list.splice(i, 1); changes.push(`- ${key} ${x}`); changed = true; } }
    for (const x of want) if (!list.includes(x)) { list.push(x); changes.push(`+ ${key} ${x}`); changed = true; }
    if (changed) perms[key] = list;
    return changed;
  };
  const settingsChanged = [merge('deny', wantDeny, rec?.deny ?? []), merge('additionalDirectories', wantDirs, rec?.additionalDirectories ?? [])].some(Boolean);

  // The CLI's sandbox (Claude only). The API socket is always reachable from it, so turning the
  // sandbox on by hand does not cut the agent off from angelia send; `sandbox: true` turns it on,
  // with no unsandboxed escape (without that, a command the sandbox stops can run outside it).
  const sb: Record<string, any> = { ...(settings.sandbox ?? {}) };
  const net: Record<string, any> = { ...(sb.network ?? {}) };
  let sandboxChanged = false;
  const wantSockets = p.backend === 'claude-code' ? [join(stateDir, API_SOCKET)] : [];
  const sockets: string[] = [...(net.allowUnixSockets ?? [])];
  for (const x of rec?.sockets ?? []) if (!wantSockets.includes(x) && sockets.includes(x)) { sockets.splice(sockets.indexOf(x), 1); changes.push(`- sandbox socket ${x}`); sandboxChanged = true; }
  for (const x of wantSockets) if (!sockets.includes(x)) { sockets.push(x); changes.push(`+ sandbox socket ${x}`); sandboxChanged = true; }
  const wantSandbox = p.backend === 'claude-code' && p.sandbox;
  if (p.sandbox && p.backend !== 'claude-code') notes.push('sandbox: true is for Claude Code; grok has no such setting here, so it is ignored');
  if (wantSandbox) {
    if (sb.enabled !== true || sb.allowUnsandboxedCommands !== false) {
      changes.push('+ sandbox on, no unsandboxed escape');
      sb.enabled = true; sb.allowUnsandboxedCommands = false; sandboxChanged = true;
    }
  } else if (rec?.sandbox && (sb.enabled === true || sb.allowUnsandboxedCommands === false)) {
    changes.push('- sandbox (set by an earlier compile)');
    delete sb.enabled; delete sb.allowUnsandboxedCommands; sandboxChanged = true;
  }
  if (sandboxChanged) {
    if (sockets.length) net.allowUnixSockets = sockets; else delete net.allowUnixSockets;
    if (Object.keys(net).length) sb.network = net; else delete sb.network;
  }
  if (capDirs.length) notes.push('the directory kind is not measured yet on either backend; check the folder is reachable before relying on it');

  // The managed block in the instruction file.
  const lines = blockLines(allowed);
  const claudeMd = join(p.cwd, 'CLAUDE.md');
  const selfText = p.backend === 'grok' ? opts.self?.(name) : undefined;
  const text = blockText(selfText, lines);
  const hasBlock = existsSync(claudeMd) && readFileSync(claudeMd, 'utf8').includes(SELF_START);
  let blockOp: (() => void) | undefined;
  if (!same(rec?.blockLines ?? [], lines) || (text && !hasBlock)) {
    changes.push(lines.length ? `~ CLAUDE.md managed block: ${lines.length - 1} capability line(s)` : '- CLAUDE.md capability lines');
    blockOp = () => {
      if (text) { if (upsertSelfBlock(claudeMd, text) === 'broken') throw new Error(`${claudeMd} has one angelia:self marker without the other; fix it by hand`); }
      else removeBlock(claudeMd);
    };
  }
  if (existsSync(claudeMd)) {
    const outside = stripBlock(readFileSync(claudeMd, 'utf8'));
    for (const [n, c] of allowed) {
      if (c.kind !== 'command') continue;
      const key = c.run.split(/\s+/).slice(0, 2).join(' ');
      if (outside.includes(key)) duplicates.push(`CLAUDE.md already mentions \`${key}\` outside the managed block (capability ${n}); delete the hand line once you are happy with the compiled one`);
    }
  }

  // grok 1.0.40 reads a path rule only as /abs: `~/` is silently a no-op, in the settings file and in --deny (measured 2026-09-21).
  if (p.backend === 'grok') {
    const tilde = ['deny', 'allow', 'ask'].flatMap((k) => ((perms[k] ?? []) as string[]).filter((r) => /\(~\//.test(r)).map((r) => `${k} ${r}`));
    if (tilde.length) notes.push(`grok ignores rules written with ~ (write the full path instead): ${tilde.join(', ')}`);
  }
  if (p.permission_mode === 'bypassPermissions' && !wantSandbox) notes.push('bypassPermissions: deny rules stop the file tools, not the shell; a program the agent runs can still read a denied path (sandbox: true closes that for Claude Code)');
  const userSkills = safeList(join(home, '.claude', 'skills'));
  if (userSkills.length) notes.push(`skills installed for every profile, not filtered: ${userSkills.join(', ')}`);

  const record: CompiledRecord = {
    version: 1, backend: p.backend, links: wantLinks, // written only by apply(), which refuses on any conflict
    mcpServers: p.backend === 'claude-code' ? Object.keys(wantMcp) : [], mcpStrict: strict,
    deny: wantDeny, additionalDirectories: wantDirs, blockLines: lines, compiledAt: new Date().toISOString(),
    ...(wantSandbox ? { sandbox: true } : {}), ...(wantSockets.length ? { sockets: wantSockets } : {}),
  };

  return {
    profile: name, changes, conflicts, duplicates, notes,
    apply() {
      if (conflicts.length) throw new Error(`not compiling ${name}: ${conflicts.length} conflict(s)`);
      for (const op of linkOps) op();
      mcpOp?.();
      if (settingsChanged || sandboxChanged) {
        const out: Record<string, any> = { ...settings, permissions: perms };
        if (Object.keys(sb).length) out.sandbox = sb; else delete out.sandbox;
        mkdirSync(dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(out, null, 2) + '\n');
      }
      blockOp?.();
      if (wantDirs.includes(common)) mkdirSync(common, { recursive: true });
      mkdirSync(join(p.cwd, '.claude'), { recursive: true });
      writeFileSync(join(p.cwd, RECORD), JSON.stringify(record, null, 2) + '\n');
      writeGuard(stateDir, name, { cwd: p.cwd, deny: wantDeny, ...(wantSandbox ? { sandbox: true } : {}) });
    },
  };
}

function existsOrLink(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

/** A skill that shares a folder below home with the profile, the workspace, is linked relatively,
 *  so the committed link still works after the workspace is cloned onto another machine. */
export function linkText(target: string, from: string, home = homedir()): string {
  const a = resolve(target).split(sep), b = resolve(from).split(sep);
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  const common = a.slice(0, n).join(sep) || sep;
  return common === sep || common === resolve(home) || resolve(home).startsWith(common + sep) ? resolve(target) : relative(from, target);
}

function isLinkTo(p: string, target: string): boolean {
  try { return lstatSync(p).isSymbolicLink() && resolve(dirname(p), readlinkSync(p)) === resolve(target); } catch { return false; }
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir).filter((n) => !n.startsWith('.')); } catch { return []; }
}

function stripBlock(text: string): string {
  const s = text.indexOf(SELF_START), e = text.indexOf(SELF_END);
  return s !== -1 && e > s ? text.slice(0, s) + text.slice(e + SELF_END.length) : text;
}

function removeBlock(file: string): void {
  if (!existsSync(file)) return;
  const cur = readFileSync(file, 'utf8');
  const next = stripBlock(cur).replace(/^\n+/, '');
  if (next !== cur) writeFileSync(file, next);
}

/** The text a report prints for one profile's plan. */
export function planText(pl: ProfilePlan): string {
  const out = [`${pl.profile}:`];
  if (!pl.changes.length && !pl.conflicts.length) out.push('  up to date');
  for (const c of pl.changes) out.push(`  ${c}`);
  for (const c of pl.conflicts) out.push(`  CONFLICT ${c}`);
  for (const d of pl.duplicates) out.push(`  duplicate: ${d}`);
  for (const n of pl.notes) out.push(`  note: ${n}`);
  return out.join('\n');
}
