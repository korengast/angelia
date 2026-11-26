import { closeSync, constants, existsSync, fchmodSync, fstatSync, ftruncateSync, linkSync, lstatSync, mkdirSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Capability, Config, Profile } from '../instance/config/schema.js';
import { capabilityEnv, connectorMode, droppedConnectorNote, droppedConnectors, resolveProfile } from './resolve.js';
import { SELF_END, SELF_START, openAgentFile, rewriteAgentFile, upsertSelfBlock } from '../daemon/self.js';
import { API_SOCKET, HOME_PRIVATE, INSTANCE_DIR, STATE_LOGS, STATE_PRIVATE, commonDir, workspaceDir } from '../instance/instance.js';
import { expandHome, isInside, openNoFollow, readPlainText } from '../core/paths.js';
import { codexUserMcpServers } from '../brain/codex-config.js';
import { agyGeminiDir, agyGeminiPath } from '../brain/cache.js';
import { AGY_CONFIG_DEFAULT, AGY_INSTRUCTIONS, agyGeminiInputs, agyLaunchProblems } from '../brain/agy-instructions.js';
import { fileURLToPath } from 'node:url';

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
  /** What the profile reached in the state folder at this compile (stateReach): a deny change there
   *  that touches it is a table change, never only the state folder's own (ProfilePlan.stateOnly). */
  stateReach?: string[];
  /** Claude: the Claude app connectors granted, as the url patterns Claude Code matches them by. Every
   *  Claude compile writes it, empty when none is granted; a record without it is from before the kind,
   *  and launches as it did then (mcpLaunch). */
  connectors?: string[];
  /** Claude, with a connector: the MCP servers let in by name beside the connectors (allowedMcpServers):
   *  this folder's .mcp.json servers, and when MCP is not strict the user-level ones of this compile. */
  mcpAllow?: string[];
  /** Claude, with a connector: the servers of this folder's .mcp.json, loaded through --mcp-config. */
  mcpOwn?: string[];
  /** Claude, with a connector: the address patterns of the remote (http, sse) servers among mcpAllow
   *  (urlPattern: no query, no fragment). Measured on claude 2.1.332: once the allow list has a
   *  serverUrl entry, a remote server passes only by its address, never by its name, so each one is
   *  let in by its address as well. */
  mcpUrls?: string[];
  /** Claude, `connectors: all`: every connector of the account loads, but those of connectorsDenied
   *  (passed as deniedMcpServers, from the guard). No allow list; this folder's .mcp.json servers
   *  (mcpOwn) load through --mcp-config. The record is in the agent's folder, so it holds each dropped
   *  address as its keyed hash only (deniedHash, with recordKey): the guard in the state folder keeps
   *  the addresses. A record from 0.4.5 holds the addresses themselves, and one from 0.4.6 to 0.4.8 their
   *  plain hashes (`sha256:`); both compare the same (deniedMatches) until the next compile. */
  connectorsAll?: boolean;
  connectorsDenied?: string[];
  /** Claude, `connectors: all` on a profile whose MCP is strict: the user-level servers of this
   *  compile, kept out by name (deniedMcpServers), since --strict-mcp-config would drop every
   *  connector too. */
  mcpDeny?: string[];
}

export function readRecord(cwd: string): CompiledRecord | undefined {
  try { return JSON.parse(readPlainText(join(cwd, RECORD))) as CompiledRecord; } catch { return undefined; }
}

/** What a Claude launch passes for MCP: flags, and keys for the settings it passes with --settings. */
export interface McpLaunch { args: string[]; settings: Record<string, unknown> }

const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);

/** What the record in the agent's folder holds for a dropped connector's address (connectorsDenied):
 *  not the address, which tells the agent what it is kept from. With the state folder's key
 *  (recordKey) a keyed hash (`hmac:`): a connector's address is easy to guess, and a plain hash would
 *  let the agent test each guess against its record. Without a key the plain hash of 0.4.6 to 0.4.8
 *  (`sha256:`). One that is a hash already stays. */
export function deniedHash(url: string, key?: Buffer): string {
  if (isDeniedHash(url)) return url;
  return key ? `hmac:${createHmac('sha256', key).update(url).digest('hex').slice(0, 32)}` : `sha256:${createHash('sha256').update(url).digest('hex').slice(0, 32)}`;
}

/** A record's connectorsDenied entry that is a hash (deniedHash), not an address. */
const isDeniedHash = (v: string): boolean => v.startsWith('sha256:') || v.startsWith('hmac:');

/** A record's connectorsDenied entry stands for this address: the address itself (0.4.5), its plain
 *  hash (0.4.6 to 0.4.8), or its keyed one (with `key`, the state folder's). */
export function deniedMatches(entry: string, url: string, key?: Buffer): boolean {
  if (entry.startsWith('hmac:')) return !!key && entry === deniedHash(url, key);
  return entry === url || entry === deniedHash(url);
}

/** The key of the record's hashes (deniedHash), in the state folder's compiled/, which every
 *  profile's deny floor closes. Undefined when there is none yet and `make` is not set. */
const recordKeyFile = (stateDir: string) => join(stateDir, 'compiled', 'record.key');
export function recordKey(stateDir: string, make = false): Buffer | undefined {
  const file = recordKeyFile(stateDir);
  const read = (): Buffer | undefined => {
    try { const k = Buffer.from(readPlainText(file).trim(), 'hex'); return k.length >= 32 ? k : undefined; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
  };
  const k = read();
  if (k || !make) return k;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // wx: two compiles at once keep the first one's key.
  try { writeFileSync(file, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  const made = read();
  if (!made) throw new Error(`${file} does not hold a key; remove it, then compile again`);
  return made;
}

/** What a record says about the MCP launch, in the guard's shape (the guard holds it as compiled). */
function recordMcp(rec: CompiledRecord): NonNullable<LaunchGuard['mcp']> {
  return {
    strict: !!rec.mcpStrict, connectors: strings(rec.connectors), allow: strings(rec.mcpAllow), own: strings(rec.mcpOwn), urls: strings(rec.mcpUrls),
    ...(rec.connectorsAll === true ? { all: true, deniedUrls: strings(rec.connectorsDenied), deniedNames: strings(rec.mcpDeny) } : {}),
  };
}

/**
 * The launch of a profile in `connectors: all` (measured on claude 2.1.332, print mode, 2026-11-25):
 * no allow list, so Claude Code loads every connector of the account, one added later in the Claude
 * app included, and a `deniedMcpServers` list in --settings: the connectors dropped, by url (a deny
 * by a connector's name, "claude.ai Gmail", does nothing), and on a strict profile the user-level
 * servers, by name (that works for stdio and http servers alike). A deny wins over every allow list,
 * and deny lists of all settings files are merged: one in the profile's own .claude/ settings, empty
 * or not, takes nothing back. This folder's .mcp.json loads through --mcp-config, as for a granted
 * connector, and still loads beside the deny list.
 */
function allLaunch(file: string, own: string[], deniedNames: string[], deniedUrls: string[]): McpLaunch {
  const deny = [...deniedNames.map((serverName) => ({ serverName })), ...deniedUrls.map((serverUrl) => ({ serverUrl }))];
  // A record's hash is no address to deny by (only the guard has them): no connector loads, rather
  // than the dropped ones too. The launch check refuses such a start anyway.
  const blind = deniedUrls.some(isDeniedHash);
  return {
    args: existsSync(file) ? ['--mcp-config', file] : [],
    settings: { ...(deny.length && !blind ? { deniedMcpServers: deny } : {}), ...(blind ? { disableClaudeAiConnectors: true, ...(deniedNames.length ? { deniedMcpServers: deniedNames.map((serverName) => ({ serverName })) } : {}) } : {}), ...(own.length ? { disabledMcpjsonServers: own } : {}) },
  };
}

/**
 * Which MCP servers a compiled Claude profile loads. The one thing the daemon takes from a compile,
 * read at launch like any other file the CLI itself would read. Measured on claude 2.1.332 (print and
 * tmux mode, 2026-11-25):
 * - `--strict-mcp-config` loads only the --mcp-config file: no user-level server and no Claude app
 *   connector (claude.ai Gmail, Drive...), and no setting brings a connector back.
 * - `allowedMcpServers` in --settings loads only what it names: a server by `serverName`, a connector
 *   by `serverUrl` (a connector's name, "claude.ai Gmail", is refused as a serverName). Of two
 *   --settings flags only the last one counts, so the keys go into the one settings Angelia passes.
 * - `disableClaudeAiConnectors: true` drops every connector and keeps the user-level servers; true
 *   in any settings source wins.
 * - With a serverUrl entry in the list, a remote (http, sse) server passes by its url only: its name
 *   alone leaves it out. A stdio server passes by its name.
 * - `disabledMcpjsonServers` keeps the folder's own .mcp.json from loading a second time as the
 *   project's, whose approval dialog would hold a tmux pane; the --mcp-config copy still loads.
 * So: a profile granted a connector loads its .mcp.json and an allow list; a strict profile with
 * none is as before; a profile that is not strict loses the connectors only. A record from before
 * connectors (no `connectors` field) launches as it did then, until it is compiled again; only a
 * guard from before connectors lets such a record start (launchCheck, mcpLaunchProblems): the record
 * is in the agent's folder, so the guard in the state folder says what it must hold.
 */
export function mcpLaunch(cwd: string, from?: LaunchGuard['mcp']): McpLaunch {
  const file = join(cwd, '.mcp.json');
  if (from) return mcpLaunchFrom(file, from);
  const rec = readRecord(cwd);
  if (!rec || typeof rec !== 'object') return { args: [], settings: {} };
  if (rec.connectorsAll === true) return allLaunch(file, strings(rec.mcpOwn), strings(rec.mcpDeny), strings(rec.connectorsDenied));
  const connectors = strings(rec.connectors);
  if (connectors.length) {
    const own = strings(rec.mcpOwn);
    return {
      args: existsSync(file) ? ['--mcp-config', file] : [],
      settings: {
        allowedMcpServers: [...strings(rec.mcpAllow).map((serverName) => ({ serverName })), ...[...strings(rec.mcpUrls), ...connectors].map((serverUrl) => ({ serverUrl }))],
        ...(own.length ? { disabledMcpjsonServers: own } : {}),
      },
    };
  }
  if (rec.mcpStrict && existsSync(file)) return { args: ['--strict-mcp-config', '--mcp-config', file], settings: {} };
  return { args: [], settings: Array.isArray(rec.connectors) ? { disableClaudeAiConnectors: true } : {} };
}

/**
 * The launch as the last compile wrote it in the state folder (the guard), where the agent cannot
 * change it: the record in its own folder no longer decides (fix2 N1, L-a). A strict launch whose
 * .mcp.json is gone loads nothing rather than every user-level server (launchCheck refuses it too).
 */
function mcpLaunchFrom(file: string, g: NonNullable<LaunchGuard['mcp']>): McpLaunch {
  const connectors = strings(g.connectors), own = strings(g.own);
  if (g.all === true) return allLaunch(file, own, strings(g.deniedNames), strings(g.deniedUrls));
  if (connectors.length) {
    return {
      args: existsSync(file) ? ['--mcp-config', file] : [],
      settings: {
        allowedMcpServers: [...strings(g.allow).map((serverName) => ({ serverName })), ...[...strings(g.urls), ...connectors].map((serverUrl) => ({ serverUrl }))],
        ...(own.length ? { disabledMcpjsonServers: own } : {}),
      },
    };
  }
  if (g.strict) return { args: ['--strict-mcp-config', '--mcp-config', existsSync(file) ? file : '{"mcpServers":{}}'], settings: {} };
  return { args: [], settings: { disableClaudeAiConnectors: true } };
}

/** A profile's MCP launch from its guard in `stateDir`, or undefined when the guard has none (a compile
 *  from before connectors, or none at all): the caller then reads the record (mcpLaunch). */
export function guardMcpLaunch(stateDir: string, name: string, cwd: string): McpLaunch | undefined {
  const g = readGuard(stateDir, name);
  return g?.mcp && resolve(g.cwd) === resolve(cwd) ? mcpLaunch(cwd, g.mcp) : undefined;
}

/**
 * The allow-list pattern for a remote server's address: the scheme, host and path only, so a key in a
 * query (`?tavilyApiKey=...`) or a fragment never reaches the record, the command line or a settings
 * file; a `*` takes the cut part's place. Measured on claude 2.1.332 (a local http server at
 * `/mcp?key=...`): `.../mcp*` lets it in, `.../mcp` does not. An address with a user or password
 * before the host (`user:key@`) has no pattern: `*@` would widen the list, since `*` also matches
 * `/` (`https://evil.example/x@host/mcp`), so planProfile refuses it (userInfo) and this throws.
 * An address with no path before its query gets `/*`, never a bare `*`
 * after the host, which would also let in every host whose name starts with it (`host.evil.example`);
 * not measured: if Claude Code matches such an address without the `/`, the server does not load
 * beside the connectors (planProfile notes it). A key in the path is copied as it is.
 */
export function urlPattern(url: string): string {
  if (userInfo(url)) throw new Error('an MCP server address with a user or password has no allow-list pattern');
  const cut = url.search(/[?#]/);
  const base = cut < 0 ? url : url.slice(0, cut);
  if (cut < 0) return base;
  if (noPath(base)) return `${base}/*`;
  return base.endsWith('*') ? base : `${base}*`;
}

/** An address with a user or password before its host (`scheme://user:key@host`). Read as Node's URL
 *  parser reads it, after a trim, so the loose forms it also takes (`https:/u:p@h`, `https:\\u:p@h`,
 *  `https:u:p@h`, a leading space) count too. An address that does not parse (`${U:-https://u:p@h}`)
 *  counts when it has any `@` before its first `?` or `#`: fail closed, never copy it. */
export function userInfo(url: string): boolean {
  const u = url.trim();
  try {
    const parsed = new URL(u);
    return parsed.username !== '' || parsed.password !== '';
  } catch {
    const cut = u.search(/[?#]/);
    return (cut < 0 ? u : u.slice(0, cut)).includes('@');
  }
}

/** An address that is only a scheme and a host (and port): nothing after the host. */
const noPath = (url: string): boolean => /^[a-z][a-z0-9+.-]*:\/\/[^/]*$/i.test(url);

/** Two url patterns (`*`: any run of characters) of which one covers the other's address. */
function urlsOverlap(a: string, b: string): boolean {
  const covers = (p: string, s: string) => new RegExp(`^${p.split('*').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(s);
  return covers(a, b) || covers(b, a);
}

/** The MCP flags of a compiled Claude profile (mcpLaunch): strict for one that denies a server and is
 *  granted no connector, its own .mcp.json beside an allow list for one granted a connector. */
export function strictMcpArgs(cwd: string): string[] { return mcpLaunch(cwd).args; }

/**
 * What the last compile of a profile wrote, kept in the state folder, outside every profile: an agent
 * that deletes or edits the profile's own record, or breaks its settings file, cannot switch the check
 * off with it. The state folder is in the deny floor, and in the sandbox's reach only for reading the
 * socket.
 */
export interface LaunchGuard {
  cwd: string; deny: string[]; sandbox?: boolean;
  /** Codex: the profile ran in Codex's sandbox at the last compile; `sandbox: false` since is a refusal. */
  codexSandbox?: boolean;
  /** pi: its commands ran in Angelia's sandbox at the last compile; `sandbox: false` since is a refusal. */
  piSandbox?: boolean;
  /** agy: the whole agy process ran in Angelia's sandbox at the last compile; `sandbox: false` since is a refusal. */
  agySandbox?: boolean;
  /** The backend compiled for: its rules differ per CLI, so another backend since is a refusal. */
  backend?: Profile['backend'];
  /** agy: what the brain gives it at start, kept here where the agent cannot change it (agy-config.ts). */
  agy?: AgyGuard;
  /** As the record's stateReach, kept where the agent cannot change it. */
  stateReach?: string[];
  /** Claude: the user config file the last compile read for MCP servers (claudeUserFiles: inside
   *  CLAUDE_CONFIG_DIR when the shell that compiled set it). The agent reads the one of the daemon's
   *  environment: on a strict profile in `connectors: all` a start where the two differ is refused. */
  claudeConfig?: string;
  /** Claude: what the record said about MCP at the last compile (strict, the connectors granted, the
   *  servers let in by name). A record that says otherwise at launch is a refusal (launchCheck). */
  mcp?: {
    strict: boolean; connectors: string[]; allow: string[]; own?: string[]; urls?: string[];
    /** `connectors: all`: the record's connectorsAll, connectorsDenied and mcpDeny. */
    all?: boolean; deniedUrls?: string[]; deniedNames?: string[];
  };
}

/** One MCP server for agy's session/new, in ACP's stdio shape but for `env`: the names of the
 *  variables, whose values come from the daemon's environment at start (as Claude expands ${VAR}). */
export interface AgyMcpServer { name: string; command: string; args: string[]; env: string[] }
export interface AgyGuard { mcpServers: AgyMcpServer[]; skills: string[] }

/** What the last compile of a profile wrote, or undefined when it was never compiled or cannot be read. */
export function readGuard(stateDir: string, name: string): LaunchGuard | undefined {
  try { return JSON.parse(readPlainText(guardFile(stateDir, name))) as LaunchGuard; } catch { return undefined; }
}

const guardFile = (stateDir: string, name: string) => join(stateDir, 'compiled', `${encodeURIComponent(name)}.json`);

/** The MCP keys of a Claude profile's launch as a settings file, in the state folder: what print
 *  mode and the /status terminal line pass with --settings, so no command line names an address
 *  (fix2 N1). In a folder of its own: beside the guards, `<name>.settings.json` was also the guard of a
 *  profile named `<name>.settings`. Written by compile, only when there are keys, and at a launch
 *  (launchSettingsFile). */
export const mcpSettingsFile = (stateDir: string, name: string) => join(stateDir, 'compiled', 'settings', `${encodeURIComponent(name)}.json`);
/** Where 0.4.2 to 0.4.8 kept it: removed at a compile, unless it is the guard of another profile. */
const legacySettingsFile = (stateDir: string, name: string) => join(stateDir, 'compiled', `${encodeURIComponent(name)}.settings.json`);

/** The settings file of a launch's MCP keys (mcpSettingsFile), written now when it does not hold
 *  exactly them: the keys come from the guard, so they are what the compile wrote there (a guard from
 *  before the file, or a file removed, is no reason to put them on a command line). Undefined when
 *  there are no keys, or the file cannot be written: the caller passes them inline. */
export function launchSettingsFile(stateDir: string, name: string, settings: Record<string, unknown>): string | undefined {
  if (!Object.keys(settings).length) return undefined;
  const file = mcpSettingsFile(stateDir, name);
  const text = JSON.stringify(settings, null, 2) + '\n';
  try { if (readPlainText(file) === text) return file; } catch { /* missing or unreadable: written below */ }
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
    return file;
  } catch { return undefined; }
}

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
export function launchCheck(cfg: Config, name: string, stateDir = INSTANCE_DIR, home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const p = cfg.profiles[name];
  let g: LaunchGuard;
  try { g = JSON.parse(readPlainText(guardFile(stateDir, name))) as LaunchGuard; }
  catch (e) { return [(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'never compiled' : `the compiled record in ${join(stateDir, 'compiled')} cannot be read`]; }
  if (resolve(g.cwd) !== resolve(p.cwd)) return [`compiled for another folder (${g.cwd})`];
  if (g.backend && g.backend !== p.backend) return [`compiled for ${g.backend}, not ${p.backend}; compile again`];
  const read = (f: string): Record<string, any> | undefined => {
    try { return JSON.parse(readPlainText(join(p.cwd, '.claude', f))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; return undefined; }
  };
  const settings = read('settings.json'), localRead = read('settings.local.json'), local = localRead ?? {};
  if (!settings) return ['.claude/settings.json cannot be read, so the CLI would drop every deny rule in it'];
  const deny: string[] = settings.permissions?.deny ?? [];
  const out = g.deny.filter((r) => !deny.includes(r)).map((r) => `deny ${r}`);
  if (g.sandbox) {
    if (settings.sandbox?.enabled !== true || settings.sandbox?.allowUnsandboxedCommands !== false) out.push('sandbox off');
    if (local.sandbox?.enabled === false || local.sandbox?.allowUnsandboxedCommands === true) out.push('sandbox off in settings.local.json');
  }
  // Codex's and pi's sandboxes come from the table, not a settings file: turning one off there needs
  // a compile. (A guard from another backend returned above.)
  if ((g.codexSandbox || g.piSandbox || g.agySandbox) && p.sandbox === false) out.push(`sandbox off: the table turned ${g.codexSandbox ? 'Codex\'s sandbox' : g.piSandbox ? 'the sandbox for pi\'s commands' : 'agy\'s sandbox'} off since the last compile; compile again to accept it`);
  if (p.backend === 'agy') out.push(...agyLaunchProblems(p.cwd, p.add_dirs, agyGeminiPath(stateDir, name), g.agy?.skills ?? []));
  if (p.backend === 'claude-code') {
    let key: Buffer | undefined;
    try { key = recordKey(stateDir); } catch (e) { out.push(`the key of the compiled records cannot be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); compile again`); }
    out.push(...mcpLaunchProblems(p.cwd, g.mcp, settings, local, localRead === undefined, home, g.claudeConfig, env, key));
  }
  const agy = agyFloorProblem(cfg, name, g, stateDir, home);
  if (agy) out.push(agy);
  return out;
}

/**
 * The record in the profile's folder decides which MCP servers and connectors load (mcpLaunch); the
 * agent may write that folder. So it must say what the last compile wrote, kept in the state folder.
 * And a connector profile's own settings must carry no allowedMcpServers: measured on claude 2.1.332,
 * a list in .claude/settings.local.json is added to the one Angelia passes (Calendar and github
 * loaded beside the Gmail granted), so it would let in what the table did not give. In
 * `connectors: all` there is no allow list to add to, and a deny list cannot be taken back (allLaunch),
 * so such settings are no refusal there; a strict profile's user-level servers must still be the ones
 * the compile kept out by name.
 */
function mcpLaunchProblems(cwd: string, want: LaunchGuard['mcp'], settings: Record<string, any>, local: Record<string, any>, localBroken: boolean, home = homedir(), claudeConfig?: string, env: NodeJS.ProcessEnv = process.env, key?: Buffer): string[] {
  const rec = readRecord(cwd);
  const ok = !!rec && typeof rec === 'object' && !Array.isArray(rec);
  // A guard from before connectors: the record must be from before them too. One that names them
  // was written since by something other than a compile (review M1).
  if (!want) {
    if (ok && ['connectors', 'mcpAllow', 'mcpOwn', 'mcpUrls', 'connectorsAll', 'connectorsDenied', 'mcpDeny'].some((k) => k in rec!)) return ['the compiled record names Claude app connectors, but its last compile was before them; compile again'];
    return [];
  }
  // Fail closed (review H1): no record, or one without its connectors list, would launch as before
  // connectors, every one of them loaded; a strict launch needs its .mcp.json.
  if (!ok || !Array.isArray(rec!.connectors)) return ['the compiled record is missing or lacks its connectors list, so the launch would load every Claude app connector; compile again'];
  const out: string[] = [];
  const now = recordMcp(rec!);
  const all = want.all === true;
  if (now.strict !== !!want.strict || !same(now.connectors, want.connectors ?? []) || !same(now.allow, want.allow ?? []) || !same(now.own, want.own ?? []) || !same(now.urls, want.urls ?? [])
    || !!now.all !== all || !deniedSame(now.deniedUrls ?? [], want.deniedUrls ?? [], key) || !same(now.deniedNames ?? [], want.deniedNames ?? [])) out.push(`the compiled record's MCP launch (strict MCP, connectors, servers let in or kept out) is not what the last compile wrote; compile again`);
  if ((all ? (want.own ?? []).length : want.strict || (want.own ?? []).length) && !existsSync(join(cwd, '.mcp.json'))) out.push(`.mcp.json is gone, so the launch would not ${want.strict && !all && !(want.connectors ?? []).length ? 'be strict: user-level MCP servers would load' : 'load this profile\'s own servers'}; compile again`);
  // connectors: all on a strict profile: no --strict-mcp-config (it drops every connector), so each
  // user-level server is kept out by name, as the last compile listed them. One added since would load.
  if (all && want.strict) {
    // The file the agent reads: the one of the launch environment (the daemon's CLAUDE_CONFIG_DIR, which
    // the agent's environment keeps). The compile kept out the servers of the file it read (the guard's);
    // when the two differ, the agent's servers were never kept out, so the start is refused (fix4 M1).
    const file = claudeUserFiles(home, env).config;
    const known = (n: string) => (want.deniedNames ?? []).includes(n) || (want.own ?? []).includes(n);
    if (claudeConfig && resolve(claudeConfig) !== file) out.push(`the agent would read the Claude config ${file} (from the daemon's environment), but the last compile read ${claudeConfig}, so the user-level MCP servers of ${file} are not kept out on this strict profile (connectors: all); compile again in the daemon's environment (the same CLAUDE_CONFIG_DIR, or none)`);
    let user: string[] | undefined;
    try { user = Object.keys(claudeUserMcpServers(cwd, home, env, file)); } catch { user = undefined; }
    const extra = user?.filter((n) => !known(n)) ?? [];
    if (!user) out.push(`${file} cannot be read, so Angelia cannot see which user-level MCP servers would load on this strict profile (connectors: all); fix it`);
    else if (extra.length) out.push(`the user-level MCP server${extra.length > 1 ? 's' : ''} ${extra.map((n) => `"${n}" (${claudeServerEntry(cwd, n, file)})`).join(', ')} came after the last compile and would load: this profile denies an MCP server, and with connectors: all only a compile keeps the user-level ones out; compile again`);
    // A .mcp.json in a folder above the profile's is a source of its own (fix4 M2).
    let above: Map<string, string> | undefined;
    try { above = parentMcpServers(cwd); } catch (e) { out.push(`${(e as Error).message}; fix it`); }
    const late = [...(above ?? [])].filter(([n]) => !known(n));
    if (late.length) out.push(`${late.map(([n, f]) => `"${n}" (${f})`).join(', ')}: MCP server${late.length > 1 ? 's' : ''} in a .mcp.json above the profile's folder that came after the last compile and would load: this profile denies an MCP server, and with connectors: all only a compile keeps them out; compile again`);
  }
  if (all || (want.connectors ?? []).length) {
    // Measured on claude 2.1.332 (tmux): a server in .mcp.json that disabledMcpjsonServers does not
    // name opens the "New MCP server found" dialog, which holds the pane (fix2 L-d).
    const mcpFile = join(cwd, '.mcp.json');
    if (existsSync(mcpFile)) {
      let names: string[] | undefined;
      try { names = Object.keys((JSON.parse(readPlainText(mcpFile)) as { mcpServers?: object }).mcpServers ?? {}); } catch { names = undefined; }
      const extra = names?.filter((n) => !(want.own ?? []).includes(n)) ?? [];
      if (!names) out.push('.mcp.json cannot be read (not valid JSON, or not a plain file); fix the file');
      else if (extra.length) out.push(`.mcp.json names ${extra.map((n) => `"${n}"`).join(', ')}, which the last compile did not (a server added by hand would hold the session on an approval dialog); compile again`);
    }
  }
  if ((want.connectors ?? []).length && !all) {
    // An unreadable settings.local.json may still be read by Claude Code, list and all (review M3).
    if (localBroken) out.push('.claude/settings.local.json cannot be read, so Angelia cannot see whether it adds to the connectors this profile was granted; fix or remove it');
    for (const [f, s] of [['settings.json', settings], ['settings.local.json', local]] as const) {
      if (s && typeof s === 'object' && 'allowedMcpServers' in s) out.push(`.claude/${f} lists allowedMcpServers, which Claude Code adds to the connectors this profile was granted; remove it`);
    }
  }
  return out;
}

/** The record's dropped connectors (connectorsDenied, hashes or 0.4.5's addresses) are the guard's
 *  addresses, one for one: both are written sorted by address. */
function deniedSame(record: string[], guard: string[], key?: Buffer): boolean {
  return record.length === guard.length && record.every((h, i) => deniedMatches(h, guard[i], key));
}

/** One warning per Claude profile whose last compile was before connectors: its guard does not hold
 *  the MCP launch, so nothing checks what its record says about MCP (review M1). */
export function mcpGuardWarnings(cfg: Config, stateDir = INSTANCE_DIR): string[] {
  return Object.entries(cfg.profiles).flatMap(([name, p]) => {
    if (p.backend !== 'claude-code') return [];
    const g = readGuard(stateDir, name);
    return g && !g.mcp ? [`profiles.${name}: compiled before Claude app connectors, so its MCP launch is not checked against the state folder; compile again: angelia compile --write ${name}`] : [];
  });
}

/**
 * An agy profile keeps its conversations and a copy of the owner's agy sign-in in `<state>/agy/`
 * (agyStateRules). A profile compiled before that floor rule, or before another agy profile was added,
 * holds nothing there, and launchCheck alone refuses only a rule the last compile wrote. While any
 * other profile is on agy, such a profile does not start until it is compiled again.
 */
function agyFloorProblem(cfg: Config, name: string, g: LaunchGuard, stateDir: string, home: string): string | undefined {
  const others = Object.keys(cfg.profiles).filter((n) => n !== name && cfg.profiles[n].backend === 'agy');
  if (!others.length) return undefined;
  const p = cfg.profiles[name];
  const dirs = p.backend === 'agy' ? others.map((n) => agyGeminiPath(stateDir, n)) : [join(stateDir, 'agy')];
  const want = dirs.flatMap((d) => (['Read', 'Edit'] as const).map((t) => pathRule(t, glob(d), p.backend, home)));
  if (want.every((r) => (g.deny ?? []).includes(r))) return undefined;
  return `compiled before the agy backend's floor, so nothing keeps its agent out of the agy profiles' folders (their conversations and sign-in copies); the owner can fix it with: angelia compile --write ${name}`;
}

/**
 * Every deny rule that holds a profile's file tools, for the daemon to hold itself to when it reads a
 * file for that profile's agent: what the last compile wrote (the guard, where the agent cannot change
 * it), what the profile's settings say now, and the floor as the table has it today, which still
 * holds for a profile never compiled or compiled before the floor grew. A rule in any of them counts.
 */
export function agentDenyRules(cfg: Config, name: string, stateDir = INSTANCE_DIR, home = homedir()): string[] {
  let guard: string[] = [];
  try { guard = (JSON.parse(readPlainText(guardFile(stateDir, name))) as LaunchGuard).deny ?? []; } catch { /* never compiled: the floor still holds */ }
  const p = cfg.profiles[name];
  // The owner's own rules, placed once as Claude Code reads them (placeRule): every reader of this list
  // (the jobs' sandbox, the daemon's own checks) takes it absolute. Codex has no reading of its own for
  // .claude/settings.json, so Claude's is the owner's; grok reads that file itself, in its own form.
  const own = p.backend === 'grok' ? profilePermissions(p.cwd) : placedPermissions(p.cwd, home);
  return [...new Set([...guard, ...own.deny, ...profileFloor(cfg, name, stateDir, home)])];
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
    // A record written since connectors carries its MCP launch: seeded with it, as the deny rules are.
    // Not one whose dropped addresses are hashes (deniedHash): the guard needs the addresses, so that
    // launch is refused until a compile, never let start without its denies.
    const hashed = strings(rec.connectorsDenied).some(isDeniedHash);
    const mcp = p.backend === 'claude-code' && Array.isArray(rec.connectors) && !hashed ? { mcp: { ...recordMcp(rec), ...(rec.connectorsAll === true ? { deniedUrls: strings(rec.connectorsDenied) } : {}) } } : {};
    writeGuard(stateDir, name, { cwd: p.cwd, deny: rec.deny, ...(rec.sandbox ? { sandbox: true } : {}), ...mcp });
    seeded.push(name);
  }
  writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  return seeded;
}

export interface ProfilePlan {
  profile: string;
  changes: string[];
  /** The changes that are only the state folder's own entries coming and going: a deny rule, added or
   *  dropped, for a path in its closed part (stateClosedRules, keyRules) that no table rule names.
   *  `compile --check` does not count them as drift (review M3): a new log or backup there must not put
   *  every profile out of date. The agent is denied such an entry at once all the same: Angelia's
   *  sandboxes and its own checks read the floor live, and the daemon adds the rule to the profile's
   *  settings before its next start (refreshFloor). A dropped one is a deny of a path that is gone. */
  stateOnly: string[];
  conflicts: string[];
  duplicates: string[];
  notes: string[];
  /** `waitMs`: how long to wait for the compile lock (withCompileLock); the daemon asks for a short one. */
  apply(o?: { waitMs?: number }): void;
}

/** A path rule in the form this backend reads as absolute. For Claude a path under the home folder
 *  is written as `~/…` (measured: Claude 2.1.278 refuses the read), so the settings file carries no
 *  username and still holds after a move. grok keeps `/abs`: measured on grok 1.0.40, it ignores a `~` rule.
 *  pi has no rules of its own; Angelia's gate extension and the sandbox it runs pi's commands in read
 *  the same `/abs` form (pi-gate.ts), and Codex's sandbox gets them as absolute paths too (codex-config.ts). */
export function pathRule(tool: 'Read' | 'Edit', path: string, backend: Profile['backend'], home = homedir()): string {
  const abs = resolve(path);
  if (backend !== 'claude-code') return `${tool}(${abs})`;
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

/**
 * What each CLI keeps of every conversation, from every folder, your own terminal sessions included:
 * the transcripts, the prompt history, Claude's copies of the files an edit touched and of pasted
 * text; and the user-level configs, whose MCP entries often carry a token. Every profile is denied
 * all of them, whatever its backend: a grok profile's shell reads Claude's as easily as its own. The
 * CLIs read and write these from their own process, as they do their logins; the rules bind only
 * their tools and the commands those run. Claude's `shell-snapshots/` and `session-env/` stay
 * readable: its shell sources them before every command.
 */
export function cliStores(home = homedir(), env: NodeJS.ProcessEnv = process.env, backend?: Profile['backend']): { dirs: string[]; files: string[] } {
  // The default places, and wherever CLAUDE_CONFIG_DIR and CODEX_HOME moved them.
  const claude = [join(home, '.claude'), ...(env.CLAUDE_CONFIG_DIR ? [resolve(env.CLAUDE_CONFIG_DIR)] : [])];
  const codex = [join(home, '.codex'), ...(env.CODEX_HOME ? [resolve(env.CODEX_HOME)] : [])];
  const under = (roots: string[], names: string[]) => roots.flatMap((r) => names.map((n) => join(r, n)));
  return {
    dirs: [...new Set([
      ...under(claude, ['projects', 'file-history', 'paste-cache']),
      ...under(codex, ['sessions', 'archived_sessions', 'memories']),
      join(home, '.grok', 'sessions'), join(home, '.pi', 'agent', 'sessions'),
      // The owner's own ~/.gemini, whole, for an agy profile only: agy's and the Antigravity app's
      // conversations, artifacts, recordings, the app's browser profile (site logins), settings and MCP
      // configs. Its agy uses its own --gemini-dir, and Angelia's `agy models` runs in the daemon. A
      // profile on another backend keeps it open, as before the agy backend: the owner's own agy, run
      // there as a tool (the agy skill), signs in and keeps its conversations in it. Every backend keeps
      // `<state>/agy/**` closed (agyStateRules): the profiles' agy folders and sign-in copies.
      ...(backend === 'agy' ? [join(home, '.gemini')] : []),
    ])],
    files: [...new Set([
      // Claude's user config sits beside the home's .claude/, or inside a moved config folder.
      join(home, '.claude.json'), ...claude.slice(1).map((d) => join(d, '.claude.json')), ...under(claude, ['history.jsonl']),
      ...under(codex, ['history.jsonl', 'session_index.jsonl', 'config.toml']),
      join(home, '.grok', 'config.toml'),
    ])],
  };
}

/** Your credentials (HOME_PRIVATE) and every CLI's record of past conversations (cliStores), denied to
 *  the profile's file tools, for reading and writing: a line written into another chat's transcript is
 *  a turn it resumes with. A profile that needs one, such as a deploy profile and ~/.ssh, names that
 *  folder in add_dirs; a wider grant (the home folder itself) does not lift it. */
export function credentialRules(p: Profile, home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const lifted = (x: string) => p.add_dirs.some((d) => isInside(d, x, home));
  const stores = cliStores(home, env, p.backend);
  const dirs = [...HOME_PRIVATE.dirs.map((d) => join(home, d)), ...stores.dirs], files = [...HOME_PRIVATE.files.map((f) => join(home, f)), ...stores.files];
  return [...dirs.filter((d) => !lifted(d)).map(glob), ...files.filter((f) => !lifted(f))]
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

/** Another profile's keys: every entry under the instance's keys/ (folders and files, read from disk at
 *  compile) and every folder under keys/ that some profile names in add_dirs, denied to every profile
 *  that does not reach it by its own folder, add_dirs or an allowed directory capability (counted the
 *  way otherProfileRules counts them). Unlike other add_dirs, these are never shared: each holds one
 *  profile's deploy or API keys. A relative add_dirs entry is read from its profile's folder; on macOS
 *  paths are compared without regard to case, as the usual disk opens them. */
export function keyRules(cfg: Config, name: string, stateDir: string, home = homedir()): string[] {
  const p = cfg.profiles[name];
  const fold = (x: string) => (process.platform === 'darwin' ? x.toLowerCase() : x);
  const abs = (d: string, from: string) => resolve(from, expandHome(d, home));
  const inside = (a: string, b: string) => isInside(fold(a), fold(b), home);
  const keys = resolve(stateDir, 'keys');
  const entries = new Map<string, boolean>(); // path -> is a plain file
  try {
    for (const e of readdirSync(keys, { withFileTypes: true })) {
      const at = join(keys, e.name);
      if (!e.isSymbolicLink()) { entries.set(at, e.isFile()); continue; }
      // A link is denied by its name and by what it points at: the file tools follow it.
      let file = false;
      try { file = statSync(at).isFile(); entries.set(realpathSync(at), file); } catch { /* dangling: the name only */ }
      entries.set(at, file);
    }
  } catch { /* no keys/ yet */ }
  for (const q of Object.values(cfg.profiles)) {
    for (const d of q.add_dirs) {
      const a = abs(d, q.cwd);
      if (fold(a) !== fold(keys) && inside(a, keys) && !entries.has(a)) entries.set(a, false);
    }
  }
  const dirs = [...resolveProfile(cfg, name).allowed.values()].flatMap((c) => (c.kind === 'directory' ? [c.path] : []));
  const reach = [p.cwd, ...p.add_dirs.map((d) => abs(d, p.cwd)), ...dirs.map((d) => abs(d, p.cwd))];
  // Only a grant at keys/ or inside it lifts an entry, as a credential is lifted only by naming it: a
  // wider grant (the home folder, /) does not. A profile folder inside an entry keeps it too.
  const lifts = (e: string, r: string) => (inside(r, keys) && inside(e, r)) || inside(r, e);
  const out = new Set<string>();
  for (const [e, file] of entries) {
    if (reach.some((r) => lifts(e, r))) continue;
    for (const tool of ['Read', 'Edit'] as const) out.add(pathRule(tool, file ? e : glob(e), p.backend, home));
  }
  return [...out];
}

/** All a profile is denied whatever its capabilities: Angelia's state, your credentials, the other profiles. */
export function profileFloor(cfg: Config, name: string, stateDir: string, home = homedir()): string[] {
  const p = cfg.profiles[name];
  return [...new Set([...floorRules(p.backend, stateDir, home), ...credentialRules(p, home), ...otherProfileRules(cfg, name, home), ...keyRules(cfg, name, stateDir, home), ...sharedRules(p, stateDir, home), ...agyStateRules(cfg, name, stateDir, home), ...stateClosedRules(cfg, name, stateDir, home)])];
}

/** What in the state folder every agent may reach: the workspace (the profiles' folders, held apart by
 *  otherProfileRules), the logs and status (STATE_LOGS), the API socket, and the cache and agy folders,
 *  each held per profile by its own rules (the sandboxes' `cache` and `own`, agyStateRules). Anything
 *  else there is closed unless the profile reaches it (stateReach): see stateClosedRules. */
export const STATE_OPEN = ['workspace', ...STATE_LOGS, API_SOCKET, 'daemon.pid', 'cache', 'agy',
  // Installed programs an owner may keep there (a tool's Python environment, npm packages): code, not data.
  'venvs', 'packages', 'node_modules', 'bin',
  // The owner's tool data (meds, health, family...): profiles read it today through their tools and file
  // tools, so closing it would break them. Per-profile data rules are a separate change. Secrets stay closed.
  'data',
  // Code clones (the Angelia checkout and its worktrees): other profiles read them (posts, docs), and no
  // secret is kept there.
  'projects'];

/** Programs that run the script named after them: the script is the program whose entry opens. */
const INTERPRETERS = new Set(['python', 'python3', 'node', 'bash', 'sh', 'zsh', 'ruby', 'perl', 'deno', 'bun', 'tsx', 'uv', 'uvx']);

/** The paths a profile is given: its folder, add_dirs, the extra folders of its settings, and what its
 *  allowed capabilities name (a folder, a skill, its secret files, an MCP server's program and
 *  arguments, a path in a command). In the state folder these stay open (stateClosedRules). */
export function stateReach(cfg: Config, name: string, home = homedir(), stateDir?: string): string[] {
  const p = cfg.profiles[name];
  const out = [p.cwd, ...p.add_dirs, ...profilePermissions(p.cwd).dirs];
  const abs = (x: string) => resolve(expandHome(x.replace(/^\$HOME(?=\/)/, '~'), home));
  const state = stateDir && resolve(stateDir);
  // A program's path opens the whole entry of the state folder it sits in: it loads what is beside it.
  // Only the program itself (an MCP server's command, the first word of a command capability's run);
  // any other path a capability names opens only itself, and the state folder named as a whole opens
  // nothing (review 3, M2: one named secret, or a text naming ~/.angelia, opened the whole folder).
  const program = (x: string): string[] => {
    const a = abs(x);
    if (!state) return [a];
    if (a === state) return [];
    const rel = relative(state, a);
    return [rel && !rel.startsWith('..') && !isAbsolute(rel) ? join(state, rel.split(sep)[0]) : a];
  };
  const exact = (x: string): string[] => (state && abs(x) === state ? [] : [abs(x)]);
  const paths = (text: string) => text.match(/(?:~|\$HOME)?\/[^\s"'`;|&<>()]+/g) ?? [];
  for (const c of resolveProfile(cfg, name).allowed.values()) {
    if (c.kind === 'directory' || c.kind === 'skill') out.push(c.path);
    if (c.kind === 'skill' || c.kind === 'mcp') out.push(...c.secrets);
    // The program: the first word when it is a path, or the script an interpreter runs.
    const take = (words: string[]) => {
      const isPath = (w: string) => paths(w)[0] === w;
      let i = isPath(words[0] ?? '') ? 0 : -1;
      if (i < 0 && INTERPRETERS.has(basename(words[0] ?? ''))) i = words.findIndex((w, k) => k > 0 && isPath(w));
      out.push(...(i >= 0 ? program(words[i]) : []), ...words.filter((_, k) => k !== i).flatMap((w) => paths(w)).flatMap(exact));
    };
    if (c.kind === 'mcp') take([c.command ?? '', ...c.args]);
    if (c.kind === 'command') take(c.run.trim().split(/\s+/));
  }
  return [...new Set(out.map((x) => resolve(expandHome(x.replace(/^\$HOME(?=\/)/, '~'), home))))];
}

/**
 * The state folder closed by default (red team round 2: passkeys, the payment ledger, secrets/, data/,
 * routing backups were open, since the floor named only what it knew). Every entry there that is not
 * STATE_OPEN and that the profile does not reach is denied, for reading and writing, in every backend's
 * form; an entry that holds something the profile reaches is opened down to that, its other entries
 * closed. This is what the state folder holds now: a name made after the compile is closed at once in
 * Angelia's own sandboxes (agy, pi's commands, jobs, a grok copy: `closed` in sandboxProfile), and in a
 * Claude Code or Codex profile's rules before its agent's next start (refreshFloor, in the daemon's launch guard) or at its next compile. compile --check does not count such an entry as drift (ProfilePlan.stateOnly).
 */
export function stateClosedRules(cfg: Config, name: string, stateDir: string, home = homedir()): string[] {
  const p = cfg.profiles[name];
  const reach = stateReach(cfg, name, home, stateDir);
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names.sort()) {
      if (depth === 0 && STATE_OPEN.includes(n)) continue;
      const path = join(dir, n);
      if (reach.some((r) => isInside(path, r, home))) continue;
      if (passingLock(dir, n, names)) continue;
      let isDir = false;
      try { isDir = lstatSync(path).isDirectory(); } catch { continue; }
      if (isDir && depth < 4 && reach.some((r) => isInside(r, path, home))) { walk(path, depth + 1); continue; }
      out.push(isDir ? glob(path) : path);
    }
  };
  walk(resolve(stateDir), 0);
  return out.flatMap((x) => (['Read', 'Edit'] as const).map((t) => pathRule(t, x, p.backend, home)));
}

/**
 * A writer's lock beside the file it guards (withLock in init.ts: `<file>.lock`, its takeover guard
 * `<file>.lock.takeover`, and that guard's `.clear`). It lives for the length of one write and holds only a pid, so no deny rule is
 * written for it (review fix L6): every bind and onboarding compiles while the table's lock exists, and
 * each wrote a rule that the next start dropped again, churn in every profile's settings. Only a plain
 * file with one name and a pid's size: a link or a second name (a hard link to a secret) is denied as
 * any other entry is.
 */
function passingLock(dir: string, n: string, names: string[]): boolean {
  const m = /^(.+)\.lock(\.takeover(\.clear)?)?$/.exec(n);
  if (!m || !names.includes(m[1])) return false;
  try { const st = lstatSync(join(dir, n)); return st.isFile() && st.nlink === 1 && st.size <= 24; } catch { return false; }
}

/** The paths in the state folder an Angelia sandbox keeps open for a profile (sandboxProfile `closed`):
 *  STATE_OPEN and what the profile reaches. The rules still hold inside them. */
export function stateOpenPaths(cfg: Config, name: string, stateDir: string, home = homedir()): string[] {
  const s = resolve(stateDir);
  return [...STATE_OPEN.map((n) => join(s, n)), ...stateReach(cfg, name, home, s).filter((r) => isInside(r, s, home) && r !== s)];
}

/** One warning per agy profile that would not start: what agy would load that Angelia did not give
 *  it (agyLaunchProblems), for check-config. The daemon refuses the start on the same lines. */
export function agyWarnings(cfg: Config, stateDir = INSTANCE_DIR, home = homedir()): string[] {
  return Object.entries(cfg.profiles).filter(([, p]) => p.backend === 'agy').flatMap(([name, p]) => {
    const problems = agyLaunchProblems(p.cwd, p.add_dirs, agyGeminiPath(stateDir, name), readGuard(stateDir, name)?.agy?.skills ?? [], home);
    return problems.length ? [`profiles.${name}: agy will not start: ${problems.join('; ')}`] : [];
  });
}

/** agy keeps each profile's conversations, settings and MCP config in `<state>/agy/<hash>/`
 *  (agyGeminiPath). A profile on another backend is denied the whole folder; an agy profile every other
 *  profile's folder there, not its own, which agy itself reads and writes from inside the sandbox. */
export function agyStateRules(cfg: Config, name: string, stateDir: string, home = homedir()): string[] {
  const p = cfg.profiles[name];
  const dirs = p.backend === 'agy'
    ? Object.keys(cfg.profiles).filter((n) => n !== name).map((n) => agyGeminiPath(stateDir, n))
    : [join(stateDir, 'agy')];
  return dirs.flatMap((d) => (['Read', 'Edit'] as const).map((t) => pathRule(t, glob(d), p.backend, home)));
}

/**
 * agy's own inputs a profile's agent must not change: in its folder `.agents/` (skills, and an
 * mcp_config.json whose servers agy starts on its own) and the two instruction files agy reads; in
 * its --gemini-dir the rules files, the MCP config, the skills compile links and its settings (the agy
 * sandbox closes these again after it opens the folder, agySandboxProfile). Measured on agy 1.5.14:
 * with an empty config/mcp_config.json made beforehand (agy makes one itself on its first start) and
 * these paths closed to writing by the sandbox, agy starts and its write_file there is refused.
 */
export function agyLaunchRules(cwd: string, geminiDir: string, home = homedir()): string[] {
  return [
    ...[join('.agents', '**'), AGY_INSTRUCTIONS, 'AGENTS.md'].map((f) => join(cwd, f)),
    ...agyGeminiInputs(geminiDir),
  ].map((f) => pathRule('Edit', f, 'agy', home));
}

/** The workspace folders that reach every profile: _shared/ (doctrine their instructions import, the
 *  self prompt) and _capabilities/ (the skills and tools they run). Read-only but for a profile with
 *  shared_write: an agent talked into editing them would act in every other profile. */
export const SHARED_DIRS = ['_shared', '_capabilities'];
export function sharedRules(p: Profile, stateDir: string, home = homedir()): string[] {
  if (p.shared_write) return [];
  return SHARED_DIRS.map((d) => pathRule('Edit', glob(join(workspaceDir(stateDir), d)), p.backend, home));
}

/**
 * The profile's own files that decide how its agent is launched next time: the settings Claude merges,
 * Angelia's record (its mcpStrict decides which MCP servers load), the MCP list, the job file.
 * Measured on claude 2.1.280: under acceptEdits the first four already ask before a write; a deny turns
 * that prompt, which an owner might approve on a one-line preview, into a refusal, and covers grok.
 * The job file is pinned by its hash, and the scripts a job runs by jobPin (jobs.ts).
 */
export const LAUNCH_FILES = [join('.claude', 'settings.json'), join('.claude', 'settings.local.json'), RECORD, '.mcp.json', 'angelia-jobs.yaml'];

/** pi's own launch inputs in the profile folder: `.pi/` (extensions, settings and packages, SYSTEM.md,
 *  skills) and `.agents/` (skills). pi loads them once the folder is trusted, as code in its own
 *  process, so an agent that writes there runs whatever it wrote on the next start. */
export const PI_LAUNCH_DIRS = [join('.pi', '**'), join('.agents', '**')];

/**
 * pi's own folder in the home, for a pi profile: nothing in it is the agent's to change (its global
 * extensions, settings, trust decisions and packages load into every pi start, so a write there could
 * switch Angelia's gate or sandbox off next time). Its sessions are in every profile's floor
 * (cliStores). pi itself reads and writes there; the rules bind only its tools and the commands they run.
 */
export const piHomeRules = (home: string): string[] => [pathRule('Edit', join(home, '.pi', 'agent', '**'), 'pi', home)];

/** Codex's project inputs in the profile folder: `.codex/` (config, hooks, rules; loaded once the
 *  folder is trusted) and `.agents/` (skills). Its sandbox makes these read-only for the agent. */
export const CODEX_LAUNCH_DIRS = [join('.codex', '**'), join('.agents', '**')];

/** One warning per profile whose settings lack part of the floor: never compiled, or compiled before
 *  the floor grew (an update, a new profile). */
export function floorWarnings(cfg: Config, stateDir = INSTANCE_DIR, home = homedir()): string[] {
  return [...floorDenyWarnings(cfg, stateDir, home), ...mcpGuardWarnings(cfg, stateDir)];
}

function floorDenyWarnings(cfg: Config, stateDir: string, home: string): string[] {
  return Object.keys(cfg.profiles).flatMap((name) => {
    const deny = settingsDeny(cfg.profiles[name].cwd);
    const missing = profileFloor(cfg, name, stateDir, home).filter((r) => !deny.includes(r));
    return missing.length ? [`profiles.${name}: its agent's file tools may open Angelia's secrets, your credentials or another profile's folder (${missing.length} deny rules missing, such as ${missing[0]}); run angelia compile ${name} --write`] : [];
  });
}

function settingsDeny(cwd: string): string[] {
  return profilePermissions(cwd, false).deny;
}

/** The deny rules and extra folders a profile's settings hold; with `local`, merged with the owner's
 *  own settings.local.json, as Claude Code merges them. An unreadable file counts as empty. */
export function profilePermissions(cwd: string, local = true): { deny: string[]; dirs: string[] } {
  const perms = (f: string): Record<string, unknown> => { try { return JSON.parse(readPlainText(join(cwd, '.claude', f)))?.permissions ?? {}; } catch { return {}; } };
  const files = [perms('settings.json'), ...(local ? [perms('settings.local.json')] : [])];
  const list = (k: string) => [...new Set(files.flatMap((x) => (Array.isArray(x[k]) ? (x[k] as unknown[]).filter((v): v is string => typeof v === 'string') : [])))];
  return { deny: list('deny'), dirs: list('additionalDirectories') };
}

/**
 * An owner's Read or Edit rule, written as Claude Code reads it in the project's .claude/settings.json
 * (code.claude.com/docs/en/permissions, "How path patterns match"), in the absolute form Angelia's own
 * gate and sandbox read (pi's and agy's): `//abs` is absolute; `~/x` is the home's; `x` and `./x` are
 * the profile folder's; `/x` is the profile folder's (the settings source) for Claude Code, but
 * absolute in pi's and grok's own form, so both are denied (fails closed). Other rules as they are.
 */
export function placeRule(rule: string, cwd: string, _home = homedir()): string[] {
  const m = /^(Read|Edit)\(([\s\S]+)\)$/.exec(rule);
  if (!m) return [rule];
  const [, tool, raw] = m;
  if (raw.startsWith('//')) return [`${tool}(${raw.slice(1)})`];
  if (raw === '~' || raw.startsWith('~/')) return [rule];
  const rel = raw.startsWith('/') ? raw.slice(1) : raw;
  // join keeps a glob as written and folds `./` and `../` in.
  const inFolder = `${tool}(${join(resolve(cwd), rel)}${rel.endsWith('/') && rel.length > 1 ? '/' : ''})`;
  return raw.startsWith('/') ? [...new Set([rule, inFolder])] : [inFolder];
}

/**
 * profilePermissions for every reader that takes rules absolute (pi's and agy's gate and sandbox,
 * Codex's sandbox, a job's sandbox, the daemon's own checks; never Claude Code's settings): the rules the last compile wrote (already
 * absolute, `/abs` meaning the root, as pathRule writes them for these CLIs) as they are; every other
 * rule (the owner's own) placed as Claude Code reads it, and for `/x` as written too (placeRule). Without this a relative rule such
 * as `Read(./secret.txt)` was resolved against `/` and held nothing.
 */
export function placedPermissions(cwd: string, home = homedir()): { deny: string[]; dirs: string[] } {
  const s = profilePermissions(cwd);
  const compiled = new Set(readRecord(cwd)?.deny ?? []);
  return { ...s, deny: [...new Set(s.deny.flatMap((r) => (compiled.has(r) ? [r] : placeRule(r, cwd, home))))] };
}

/** Two profiles, one inside the other's folder: the outer one cannot be denied to the inner. */
export function nestingWarnings(cfg: Config, home = homedir()): string[] {
  const out: string[] = [];
  for (const [a, p] of Object.entries(cfg.profiles)) for (const [b, q] of Object.entries(cfg.profiles)) {
    if (a !== b && p.cwd !== q.cwd && isInside(q.cwd, p.cwd, home)) out.push(`profiles.${b}: its folder is inside profiles.${a}'s (${p.cwd}), so ${b}'s agent can read ${a}'s files; give each profile a folder of its own`);
  }
  return out;
}

/** Where the backend finds skills installed for every profile, which no compile can filter. pi takes a
 *  compiled profile's own skills on argv (`--skill`, argv.ts) and ignores Claude's folder. */
function userSkillDirs(backend: Profile['backend'], home: string): string[] {
  if (backend === 'pi') return [join(home, '.pi', 'agent', 'skills'), join(home, '.agents', 'skills')];
  if (backend === 'codex') return [join(process.env.CODEX_HOME ?? join(home, '.codex'), 'skills'), join(home, '.agents', 'skills')];
  // agy with its own --gemini-dir reads no skills from ~/.gemini; ~/.agents/skills is not measured, so it counts.
  if (backend === 'agy') return [join(home, '.agents', 'skills')];
  return [join(home, '.claude', 'skills')];
}

function glob(p: string): string { return p.endsWith('**') || p.includes('*') ? p : `${p.replace(/\/+$/, '')}/**`; }

function denyEntries(name: string, c: Capability, backend: Profile['backend'], home: string): string[] {
  const out: string[] = [];
  if (c.kind === 'mcp') out.push(`mcp__${name}`);
  // grok rejects Skill(...) as an unknown tool prefix (grok inspect: "skipped"), and pi's gate knows no
  // such rule, so both only get the path rules.
  if (c.kind === 'skill') out.push(...(backend === 'claude-code' ? [`Skill(${name})`] : []), pathRule('Read', glob(c.path), backend, home), pathRule('Edit', glob(c.path), backend, home));
  if (c.kind === 'directory') out.push(pathRule('Read', glob(c.path), backend, home), pathRule('Edit', glob(c.path), backend, home));
  if (c.kind === 'skill' || c.kind === 'mcp') for (const s of c.secrets) out.push(pathRule('Read', s, backend, home), pathRule('Edit', s, backend, home));
  return out;
}

/** The tool names of the Claude app connectors measured (claude 2.1.332): Claude Code names a
 *  connector's tools after its name on claude.ai, which the url does not carry. */
const CONNECTOR_TOOLS: Record<string, string> = {
  'gmailmcp.googleapis.com': 'Gmail',
  'calendarmcp.googleapis.com': 'Google_Calendar',
  'drivemcp.googleapis.com': 'Google_Drive',
};

/** How the capability line names a connector: what it is, its tools, and what it needs. */
function connectorLine(name: string, c: Extract<Capability, { kind: 'connector' }>): string {
  const host = c.url.replace(/^https:\/\//, '').split('/')[0];
  const label = CONNECTOR_TOOLS[host];
  const tools = label ? `mcp__claude_ai_${label}__*` : 'mcp__claude_ai_<its name>__*';
  const what = label ? label.replace(/_/g, ' ') : `the connector at ${host}`;
  return `- ${name}: ${what} through the Claude app connector (tools ${tools}); needs a claude.ai login.${c.when ? ` When: ${c.when.replace(/\.$/, '')}.` : ''}`;
}

function blockLines(allowed: Map<string, Capability>, backend: Profile['backend'], all?: string[]): string[] {
  const lines: string[] = [];
  // connectors: all (Claude Code only): the dropped ones by their capability names.
  if (all) lines.push(`- Claude app connectors: every connector of the claude.ai account loads (tools mcp__claude_ai_<its name>__*)${all.length ? `, but ${all.join(', ')}` : ''}; they need a claude.ai login.`);
  for (const [name, c] of allowed) {
    if (c.kind === 'command') lines.push(`- ${name}: run \`${c.run}\` when ${c.when}.`);
    else if (c.kind === 'mcp' && c.when) lines.push(`- ${name} (MCP server): ${c.when}.`);
    else if (c.kind === 'directory' && c.when) lines.push(`- ${name} (folder ${c.path}): ${c.when}.`);
    // Claude Code only: no other CLI loads a Claude app connector, so it gets no line.
    else if (c.kind === 'connector' && backend === 'claude-code') lines.push(connectorLine(name, c));
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
  try { return JSON.parse(readPlainText(path)); } catch (e) { throw new Error(`${path} is not valid JSON (${(e as Error).message}); fix it by hand first`); }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function mcpEntry(c: Extract<Capability, { kind: 'mcp' }>): Record<string, unknown> {
  if (c.url) return { type: 'http', url: c.url };
  const e: Record<string, unknown> = { command: c.command, args: c.args };
  // Claude expands ${VAR} in .mcp.json from its own environment: the value never lands in a file.
  if (c.env.length) e.env = Object.fromEntries(c.env.map((k) => [k, `\${${k}}`]));
  return e;
}

export interface PlanOptions {
  home?: string; self?: (profile: string) => string; /** The instance's state folder, for the floor. */ stateDir?: string;
  /** The environment the agent's own is made from (the daemon's, or the shell that compiles): for the
   *  connector login note. Default process.env. */
  env?: NodeJS.ProcessEnv;
}

/** Where Claude Code keeps the user's config and settings: ~/.claude.json and ~/.claude/settings.json,
 *  or both inside CLAUDE_CONFIG_DIR when it is set (as cliStores reads it). */
export function claudeUserFiles(home = homedir(), env: NodeJS.ProcessEnv = process.env): { config: string; settings: string } {
  const dir = env.CLAUDE_CONFIG_DIR ? resolve(expandHome(env.CLAUDE_CONFIG_DIR, home)) : undefined;
  return dir ? { config: join(dir, '.claude.json'), settings: join(dir, 'settings.json') } : { config: join(home, '.claude.json'), settings: join(home, '.claude', 'settings.json') };
}

/** The remote address of an MCP server entry (`type: http` or `sse`, or a bare `url`), if it has one. */
function serverUrl(e: unknown): string | undefined {
  const u = e && typeof e === 'object' ? (e as { url?: unknown }).url : undefined;
  return typeof u === 'string' && u ? u : undefined;
}

/**
 * The keys of `projects` in the user's Claude config that can hold a folder's local MCP servers:
 * the folder as given, its real path, its git root, and the main checkout's root when the folder is
 * in a worktree. Measured on claude 2.1.332 (`claude mcp add --scope local`, 2026-11-25): from a
 * folder inside a git repo, the server goes under the repo's root, by its real path, also from a
 * subfolder, through a link, or from a worktree (the main checkout's root); outside a repo, under
 * the folder's real path. Every profile is in one git repo (the workspace), so the folder alone
 * misses them. Read with fs only (no git process): a `.git` folder is a root, a `.git` file of a
 * worktree names its git folder, whose `commondir` leads to the main one.
 */
export function claudeProjectKeys(cwd: string): string[] {
  const keys = new Set([resolve(cwd)]);
  let real: string;
  try { real = realpathSync(cwd); } catch { return [...keys]; }
  keys.add(real);
  for (let at = real; ; at = dirname(at)) {
    const dot = join(at, '.git');
    let st;
    try { st = statSync(dot); } catch { st = undefined; }
    if (st?.isDirectory()) { keys.add(at); break; }
    if (st?.isFile()) {
      keys.add(at);
      try {
        const m = /^gitdir:\s*(.+)$/m.exec(readPlainText(dot));
        if (m) {
          const gitdir = resolve(at, m[1].trim());
          const main = realpathSync(resolve(gitdir, readPlainText(join(gitdir, 'commondir')).trim()));
          // Only a real worktree: its git folder is <main>/worktrees/<name> and points back to this .git
          // file. A .git file made by hand cannot add another repo's key (Claude Code checks it too).
          const real = realpathSync(gitdir);
          const back = realpathSync(resolve(real, readPlainText(join(real, 'gitdir')).trim()));
          // A bare repo's worktree: Claude Code keys it by the bare folder itself (measured).
          if (dirname(real) === join(main, 'worktrees') && back === realpathSync(dot)) keys.add(basename(main) === '.git' ? dirname(main) : main);
        }
      } catch { /* a submodule (no commondir) or a broken link: its own root is the key */ }
      break;
    }
    if (dirname(at) === at) break;
  }
  return [...keys];
}

/**
 * The MCP servers Claude Code loads for a folder from the user's own config (claudeUserFiles, or
 * `file` when given: the one the last compile read, kept in the guard): its user-level ones and the
 * folder's local ones, under every key that can hold them (claudeProjectKeys), by name, with the
 * address of a remote one. A missing file is none; a broken one throws, as userMcpServers does: read
 * as none, it would leave them all out of a connector profile's list.
 */
export function claudeUserMcpServers(cwd: string, home = homedir(), env: NodeJS.ProcessEnv = process.env, file = claudeUserFiles(home, env).config): Record<string, { url?: string }> {
  let text = '';
  try { text = readPlainText(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (!text) return {};
  let j: { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> };
  try { j = JSON.parse(text); } catch { throw new Error(`${file} is not valid JSON, so its MCP servers cannot be listed; fix the file, then compile again`); }
  const local = claudeProjectKeys(cwd).map((k) => j.projects?.[k]?.mcpServers);
  const all: Record<string, unknown> = Object.assign({}, j.mcpServers, ...local);
  return Object.fromEntries(Object.keys(all).sort().map((n) => [n, serverUrl(all[n]) ? { url: serverUrl(all[n]) } : {}]));
}

/** Which entry of the Claude config `file` holds the server `name` for this folder, for a refusal. */
function claudeServerEntry(cwd: string, name: string, file: string): string {
  try {
    const j = JSON.parse(readPlainText(file)) as { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> };
    const key = claudeProjectKeys(cwd).find((k) => j.projects?.[k]?.mcpServers?.[name] !== undefined);
    if (key !== undefined) return `in ${file}, projects["${key}"].mcpServers`;
  } catch { /* the caller read it; the file name says enough */ }
  return `in ${file}, mcpServers`;
}

/**
 * The MCP servers of each .mcp.json in a folder above `cwd`, up to the filesystem root, by name, with
 * the file that names it (the nearest one). Measured on claude 2.1.332: `claude mcp list` in a child
 * folder lists a server of the parent's .mcp.json ("Pending approval"), so it is a source a strict
 * profile in `connectors: all` keeps out by name. The folder as given and its real path, each walked
 * (the agent's process sees the real one). Plain files only, at readPlainText's size cap; a missing
 * one is none, any other failure throws: read as none, its servers would load.
 */
export function parentMcpServers(cwd: string): Map<string, string> {
  const starts = [resolve(cwd)];
  try { starts.push(realpathSync(cwd)); } catch { /* gone: the path as given */ }
  const files: string[] = [];
  for (const start of starts) {
    for (let at = dirname(start); ; at = dirname(at)) {
      const f = join(at, '.mcp.json');
      if (!files.includes(f)) files.push(f);
      if (dirname(at) === at) break;
    }
  }
  const out = new Map<string, string>();
  for (const f of files) {
    let text: string;
    try { text = readPlainText(f); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`${f} cannot be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}), so Angelia cannot see which MCP servers it adds above the profile's folder`);
    }
    let servers: unknown;
    try { servers = (JSON.parse(text) as { mcpServers?: unknown }).mcpServers ?? {}; } catch { throw new Error(`${f} is not valid JSON, so Angelia cannot see which MCP servers it adds above the profile's folder`); }
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error(`${f}: mcpServers is not an object, so Angelia cannot see which MCP servers it adds above the profile's folder`);
    for (const n of Object.keys(servers)) if (!out.has(n)) out.set(n, f);
  }
  return out;
}

/** The names Claude Code takes in an allowedMcpServers serverName entry (measured: any other is dropped). */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/** Who sets CLAUDE_CODE_OAUTH_TOKEN for this profile's agent, if anyone: a long-lived token in place of
 *  the claude.ai login, with which Claude Code loads no connector. The API key and cloud provider
 *  variables never reach an agent (STRIP_ENV), so they need no word here. */
function oauthTokenSource(cfg: Config, name: string, env: NodeJS.ProcessEnv): string | undefined {
  const k = 'CLAUDE_CODE_OAUTH_TOKEN';
  if (capabilityEnv(cfg, name).includes(k)) return `an MCP capability of this profile declares ${k}`;
  if (env[k]) return `${k} is set in the environment the agent starts from`;
  return undefined;
}

/**
 * MCP servers configured for the whole user, which grok loads in every folder (it reads Claude's
 * ~/.claude.json too) and cannot switch off per folder. Names only; nothing else is read.
 */
export function userMcpServers(home = homedir()): string[] {
  const names = new Set<string>();
  // A missing file means no servers. Any other failure throws: a malformed file read as "no servers"
  // would drop every mcp__ deny on the next --write.
  const read = (f: string) => { try { return readPlainText(f); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw e; } };
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

/**
 * The folders under a profile's folder that compile writes in, that are links. The agent may write its
 * own folder, and compile runs outside every sandbox: `.claude` swapped for a link would carry the
 * settings, the record and the skill links to wherever it points.
 */
function linkedFolders(cwd: string, paths: string[][]): string[] {
  const out = new Set<string>();
  for (const parts of paths) {
    let at = cwd;
    for (const part of parts) {
      at = join(at, part);
      let st;
      try { st = lstatSync(at); } catch { break; }
      if (st.isSymbolicLink()) { out.add(at); break; }
    }
  }
  return [...out];
}

/**
 * Write a whole file in a profile's folder without following a link anywhere on the way (`openNoFollow`), and only into a plain file with no other name
 * (a hard link would carry the write out of the folder). One descriptor from the check to the write.
 * O_NONBLOCK: a FIFO in the file's place must not hold the daemon (which compiles for /backend); the
 * plain-file check then refuses it.
 */
export function writePlain(cwd: string, file: string, text: string): void {
  const path = join(realpathSync(cwd), relative(cwd, file));
  let fd: number;
  try { fd = openNoFollow(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NONBLOCK, 0o644); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(`${file} is reached through a link; compile writes no file through one`);
    if ((e as NodeJS.ErrnoException).code === 'ENXIO') throw new Error(`${file} is not a plain file with one name; compile writes only those`);
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new Error(`${file} is not a plain file with one name; compile writes only those`);
    ftruncateSync(fd, 0);
    writeSync(fd, text, 0);
  } finally { closeSync(fd); }
}

export function planProfile(cfg: Config, name: string, opts: PlanOptions = {}): ProfilePlan {
  const p = cfg.profiles[name];
  const home = opts.home ?? homedir();
  const stateDir = opts.stateDir ?? (opts.home ? join(opts.home, '.angelia') : INSTANCE_DIR);
  const { allowed, denied } = resolveProfile(cfg, name);
  const rec = readRecord(p.cwd);
  const changes: string[] = [], conflicts: string[] = [], duplicates: string[] = [], notes: string[] = [];

  // Skills: a link per allowed skill; a denied one must not be there at all.
  // Codex finds project skills in .agents/skills (measured with skills/list), not in Claude's folder.
  // agy: in its own --gemini-dir, config/skills (measured 1.5.14: a linked skill folder there loads).
  const skillsRel = p.backend === 'codex' ? ['.agents', 'skills'] : ['.claude', 'skills'];
  const gdir = p.backend === 'agy' ? agyGeminiPath(stateDir, name) : undefined;
  const skillsDir = gdir ? join(gdir, 'config', 'skills') : join(p.cwd, ...skillsRel);
  for (const l of linkedFolders(p.cwd, [['.claude'], ...(gdir ? [] : [skillsRel])])) conflicts.push(`${l} is a link: compile writes only into plain folders, so move it aside by hand`);
  if (gdir) for (const l of linkedFolders(dirname(gdir), [[basename(gdir)], [basename(gdir), 'config'], [basename(gdir), 'config', 'skills']])) conflicts.push(`${l} is a link: compile writes only into plain folders, so move it aside by hand`);
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
    for (const user of userSkillDirs(p.backend, home).map((d) => join(d, n))) if (existsOrLink(user)) conflicts.push(`denied skill ${n} is installed for every profile at ${user}; remove it there`);
  }

  // MCP. Claude: the profile's .mcp.json, loaded strictly, so user-level servers stay out — but only
  // when the profile denies a server. A profile that denies none (master) keeps the user-level ones too.
  const strict = p.backend === 'claude-code' && [...denied.values()].some((c) => c.kind === 'mcp');
  const mcpPath = join(p.cwd, '.mcp.json');
  const wantMcp: Record<string, Record<string, unknown>> = {};
  for (const [n, c] of allowed) if (c.kind === 'mcp') wantMcp[n] = mcpEntry(c);
  let mcpOp: (() => void) | undefined;
  const agyMcp: AgyMcpServer[] = [];
  const connectors = [...allowed].flatMap(([n, c]) => (c.kind === 'connector' ? [[n, c] as const] : []));
  const connectorUrls = connectors.map(([, c]) => c.url);
  let mcpAllow: string[] = [], mcpOwn: string[] = [], mcpUrls: string[] = [], droppedUrls: string[] = [], mcpDeny: string[] = [];
  let recKey: Buffer | undefined, keyMissing = false;
  const all = p.backend === 'claude-code' && connectorMode(cfg, name) === 'all';
  const dropped = all ? droppedConnectors(cfg, name) : [];
  if (p.backend !== 'claude-code' && connectors.length) notes.push(`Claude app connectors work only with Claude Code, so ${connectors.map(([n]) => n).join(', ')} ${connectors.length === 1 ? 'is' : 'are'} not given to this ${p.backend} profile`);
  if (p.backend !== 'claude-code' && p.connectors === 'all') notes.push(`connectors: all is for Claude Code only: this ${p.backend} profile gets no Claude app connector`);
  if (p.backend === 'claude-code') {
    const cur = readJson(mcpPath);
    const servers: Record<string, unknown> = { ...cur.mcpServers };
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
    if (strict && !rec?.mcpStrict) changes.push(all ? '+ strict MCP: user-level servers (such as github, tavily) are left out, by name; the account\'s connectors still load (connectors: all)' : '+ strict MCP: only this folder\'s .mcp.json is loaded; user-level servers (such as github, tavily) are left out');
    if (!strict && rec?.mcpStrict) changes.push('- strict MCP: user-level servers (such as github, tavily) load again');
    if (!strict) notes.push('no MCP server is denied here, so MCP is not strict: user-level servers (such as github, tavily) load as well');
    if (touched) mcpOp = () => writePlain(p.cwd, mcpPath, JSON.stringify({ ...cur, mcpServers: servers }, null, 2) + '\n');

    // connectors: all (allLaunch): every connector of the account, no allow list, a deny list of the
    // ones dropped. A strict profile keeps its user-level servers out by name: --strict-mcp-config
    // would drop every connector too.
    const wasAll = rec?.connectorsAll === true;
    if (all) {
      droppedUrls = [...new Set(dropped.map(([, u]) => u))].sort();
      // The key the record's hashes are made with: read here, made only by apply(), the first time one
      // is needed, so a plan (the drift check, compile without --write) writes nothing in the state folder.
      recKey = recordKey(stateDir);
      keyMissing = droppedUrls.length > 0 && !recKey;
      mcpOwn = Object.keys(servers).sort();
      if (strict) {
        const keepOut = Object.keys(claudeUserMcpServers(p.cwd, home, opts.env ?? process.env)).filter((n) => !mcpOwn.includes(n));
        for (const n of keepOut) if (!SERVER_NAME.test(n)) conflicts.push(`the user-level MCP server "${n}" has a character other than letters, digits, - and _: this profile denies an MCP server, so with connectors: all its user-level servers are kept out by name, and Claude Code drops such a name from its lists, so this one would load; rename it in your Claude config`);
        // A .mcp.json above the profile's folder is another source (fix4 M2): its servers are kept out too.
        let above = new Map<string, string>();
        try { above = parentMcpServers(p.cwd); } catch (e) { conflicts.push(`${(e as Error).message}; this profile denies an MCP server, so with connectors: all its servers must be kept out by name; fix it`); }
        const aboveOut = [...above].filter(([n]) => !mcpOwn.includes(n) && !keepOut.includes(n));
        for (const [n, f] of aboveOut) if (!SERVER_NAME.test(n)) conflicts.push(`the MCP server "${n}" in ${f} (above the profile's folder) has a character other than letters, digits, - and _: this profile denies an MCP server, so with connectors: all such servers are kept out by name, and Claude Code drops such a name from its lists, so this one would load; rename it there`);
        mcpDeny = [...keepOut, ...aboveOut.map(([n]) => n)].filter((n) => SERVER_NAME.test(n)).sort();
        notes.push('connectors: all on a profile that denies an MCP server: its user-level servers and those of each .mcp.json above its folder are kept out by name, as this compile found them; one added later stops the start until the next compile. MCP servers that come from a plugin are not kept out');
      }
      // A deny matches by address only, so a wrong pattern or a connector that moved fails open: it loads.
      for (const [n] of dropped) notes.push(droppedConnectorNote(n));
      // A deny wins over everything: a given connector whose address a dropped one covers does not load.
      for (const [n, c] of connectors) {
        const by = dropped.filter(([, u]) => urlsOverlap(u, c.url)).map(([d]) => d);
        if (by.length) notes.push(`connectors: all: ${n} is given to this profile, but its address overlaps that of ${by.join(', ')}, which is dropped, so ${n} does not load either; give them addresses that do not overlap`);
      }
      if (!wasAll) changes.push(`+ connectors: all: every Claude app connector of the account loads for this profile, ones added later in the Claude app included${dropped.length ? `, but ${dropped.map(([n]) => n).join(', ')}` : ''}`);
      else {
        // Named by capability, never by address: the compile's lines can reach the agent (a chat that runs it).
        const before = strings(rec?.connectorsDenied);
        // Keyed hashes with no key to test them: which connector each stands for is unknown, so no
        // line per connector (each would read as dropped anew, or as loading again), only the change.
        const blind = keyMissing && before.some((h) => h.startsWith('hmac:'));
        if (blind) changes.push('~ record: the key of the dropped connectors\' hashes is gone from the state folder; a new one is made and the hashes written again');
        else for (const [n, u] of dropped) if (!before.some((h) => deniedMatches(h, u, recKey))) changes.push(`- connector ${n}: no longer loads for this profile`);
        for (const h of blind ? [] : before) {
          if (droppedUrls.some((u) => deniedMatches(h, u, recKey))) continue;
          const named = Object.entries(cfg.capabilities).filter(([, c]) => c.kind === 'connector' && deniedMatches(h, c.url, recKey)).map(([n]) => n);
          changes.push(named.length ? `+ connector ${named.join(', ')}: loads again for this profile` : '+ a connector this profile dropped before loads again');
        }
        // A record from before the keyed hash: an address, or a plain hash the agent could test guesses against.
        if (before.some((h) => !h.startsWith('hmac:'))) changes.push('~ record: the dropped connectors are kept as keyed hashes (the key stays in the state folder)');
      }
      if (!same(wasAll ? strings(rec?.mcpDeny) : [], mcpDeny)) changes.push(`~ MCP kept out by name: ${mcpDeny.length ? mcpDeny.join(', ') : 'no server'}`);
      for (const [f, s] of [['settings.json', readJson(join(p.cwd, '.claude', 'settings.json'))], ['settings.local.json', readJson(join(p.cwd, '.claude', 'settings.local.json'))]] as const) {
        if ('allowedMcpServers' in s) notes.push(`.claude/${f} lists allowedMcpServers, so Claude Code loads only what it names; the connectors this profile drops stay out all the same`);
        if (s.disableClaudeAiConnectors === true) notes.push(`.claude/${f} sets disableClaudeAiConnectors, so no connector loads`);
      }
      const token = oauthTokenSource(cfg, name, opts.env ?? process.env);
      if (token) notes.push(`connectors load only with a claude.ai login, and ${token}: with that token Claude Code loads no connector`);
    } else {
      if (wasAll) changes.push('- connectors: all: only the connectors given to this profile load');
      // Connectors (mcpLaunch): deny by default. One granted: no strict flag, this folder's .mcp.json and
      // an allow list of its servers, the user-level ones when MCP is not strict, and the connectors.
      // undefined: a Claude record from before connectors, whose launch loaded every one when not strict.
      const was = rec && (rec.backend ?? 'claude-code') === 'claude-code' ? (Array.isArray(rec.connectors) ? strings(rec.connectors) : undefined) : [];
      for (const [n, c] of connectors) if (!was?.includes(c.url)) changes.push(`+ connector ${n}: the Claude app connector at ${c.url} loads for this profile`);
      for (const u of was ?? []) if (!connectorUrls.includes(u)) changes.push(`- connector ${u}: no longer loads for this profile`);
      if (connectors.length) {
        mcpOwn = Object.keys(servers).sort();
        const userAll = strict ? {} : claudeUserMcpServers(p.cwd, home, opts.env ?? process.env);
        // A user-level server whose name Claude Code would drop from the list is left off it, with a
        // note (the owner's own config, not this profile's); a name in this folder's .mcp.json stops
        // the compile, since its server would silently not load (fix2 L-b).
        const user = Object.fromEntries(Object.entries(userAll).filter(([n]) => SERVER_NAME.test(n)));
        for (const n of Object.keys(userAll)) if (!(n in user) && !mcpOwn.includes(n)) notes.push(`the user-level MCP server "${n}" has a character other than letters, digits, - and _, which Claude Code drops from its allow list, so it does not load beside the connectors; rename it in your Claude config to have it`);
        // A user or password in the address: no pattern lets in just that server (urlPattern). A
        // user-level one is left off the list, with a note, so it does not load here.
        for (const [n, s] of Object.entries(user)) {
          if (!s.url || !userInfo(s.url)) continue;
          delete user[n];
          if (!mcpOwn.includes(n)) notes.push(`the address of the user-level MCP server ${n} holds a user or password before its host, which no allow-list pattern can match without letting in other addresses too, so it does not load beside the connectors; take them out of the address in your Claude config and send them in a header to have it`);
        }
        mcpAllow = [...new Set([...mcpOwn, ...Object.keys(user)])].sort();
        // A remote server passes the list by its address only, once a connector's url is on it (mcpUrls).
        const remote = new Map<string, string>();
        for (const n of Object.keys(user)) if (user[n].url) remote.set(n, user[n].url!);
        for (const n of mcpOwn) { const u = serverUrl(servers[n]); if (u) remote.set(n, u); }
        // The same in this folder's .mcp.json stops the compile. Named by server, never by address:
        // the address holds the password. A capability takes no headers, so its fix is another one.
        for (const [n, u] of remote) {
          if (!userInfo(u)) continue;
          remote.delete(n);
          const fix = n in wantMcp ? `take them out of its url in the routing table (capabilities.${n}); a capability takes no headers, so for a server that needs a header, remove the capability and write the server into ${mcpPath} by hand, with its headers` : 'take them out of the address and send them in a header (headers in its MCP config) instead';
          conflicts.push(`the address of the MCP server ${n} holds a user or password before its host, which no allow-list pattern can match without letting in other addresses too; ${fix}`);
        }
        mcpUrls = [...new Set([...remote.values()].map(urlPattern))].sort();
        for (const [n, u] of remote) if (/[?#]/.test(u) && noPath(u.slice(0, u.search(/[?#]/)))) notes.push(`the address of the MCP server ${n} has no path before its query, so it is on the allow list as its host and /*, which Claude Code may not match against it: this server may not load beside the connectors; give its address a path (such as /mcp)`);
        for (const [n, u] of remote) if (u.includes('${')) notes.push(`the address of the MCP server ${n} holds \${...}, and Claude Code matches the allow list against the address after it fills that in, so this server may not load beside the connectors`);
        for (const n of mcpOwn) if (!SERVER_NAME.test(n)) conflicts.push(`the MCP server name "${n}" (in ${mcpPath}) has a character other than letters, digits, - and _; Claude Code drops such a name from its allow list, so the server would not load beside the connectors; rename it`);
        if (!was?.length) changes.push(`~ MCP by allow list: only ${mcpAllow.length ? `the servers ${mcpAllow.join(', ')} and ` : ''}the granted connectors load${strict ? '' : '; a user-level server added later loads after the next compile'}`);
        // The names only: an address may hold a host the owner keeps private (fix2 N1).
        else if (!same(rec?.mcpAllow ?? [], mcpAllow) || !same(rec?.mcpUrls ?? [], mcpUrls)) changes.push(`~ MCP allow list: ${mcpAllow.length ? mcpAllow.join(', ') : 'no server'}${mcpUrls.length ? ` (${mcpUrls.length} remote by address too)` : ''}, beside the connectors`);
        if (!strict) notes.push('MCP servers that come from a plugin are not in the allow list, so they may not load for this profile');
        for (const [f, s] of [['settings.json', readJson(join(p.cwd, '.claude', 'settings.json'))], ['settings.local.json', readJson(join(p.cwd, '.claude', 'settings.local.json'))]] as const) {
          if ('allowedMcpServers' in s) conflicts.push(`${join(p.cwd, '.claude', f)} lists allowedMcpServers, which Claude Code adds to the list Angelia passes, so it would let in servers or connectors this profile was not granted; remove it by hand`);
          if (s.disableClaudeAiConnectors === true) notes.push(`.claude/${f} sets disableClaudeAiConnectors, so no connector loads, the granted ones included`);
        }
        const userFile = claudeUserFiles(home, opts.env ?? process.env).settings;
        let userSettings: Record<string, any> = {};
        try { userSettings = readJson(userFile); } catch { /* not ours to fix; nothing to say about it */ }
        if ('allowedMcpServers' in userSettings) notes.push(`${userFile} lists allowedMcpServers; Claude Code merges such lists across settings files, so what it names may load here too`);
        const token = oauthTokenSource(cfg, name, opts.env ?? process.env);
        if (token) notes.push(`connectors load only with a claude.ai login, and ${token}: with that token Claude Code loads no connector`);
      } else if (!strict && rec && was === undefined) {
        changes.push('- claude.ai connectors: this profile no longer loads the Claude app connectors (claude.ai Gmail, Drive...); it is granted none. Before, a profile with no MCP server denied loaded every one');
      }
    }
    // Compiled before connectors: its guard does not hold the MCP launch yet (review M1), so nothing
    // checks the record's; a strict profile would otherwise read as up to date.
    const g = readGuard(stateDir, name);
    if (g && (g.backend ?? 'claude-code') === 'claude-code' && !g.mcp) changes.push('+ MCP launch kept in the state folder: before each start the daemon checks what the record says about MCP and connectors against it');
    // The start check reads the Claude config this compile reads (LaunchGuard.claudeConfig): another one
    // since (CLAUDE_CONFIG_DIR set or not) is a change, so the guard follows it.
    const userConfig = claudeUserFiles(home, opts.env ?? process.env).config;
    if (g?.mcp && g.claudeConfig && g.claudeConfig !== userConfig) changes.push(`~ Claude config read for MCP servers: ${userConfig} (was ${g.claudeConfig})`);
  } else if (p.backend === 'agy') {
    // Given in session/new, never written to a file agy reads by itself (ADR 0017, D).
    for (const [n, c] of allowed) {
      if (c.kind !== 'mcp') continue;
      if (c.url) notes.push(`agy: the MCP server ${n} is reached by URL, which Angelia does not give agy yet; it is left out`);
      else agyMcp.push({ name: n, command: c.command!, args: c.args, env: c.env });
    }
    if (agyMcp.some((m) => m.env.length)) notes.push('agy: the MCP servers get their environment variables from the daemon\'s environment at each start');
  } else if (p.backend === 'codex') {
    if (Object.keys(wantMcp).length) notes.push(`codex: allowed MCP servers are not written yet (${Object.keys(wantMcp).join(', ')}); add them with codex mcp add`);
  } else if (p.backend === 'pi') {
    if (Object.keys(wantMcp).length) notes.push(`pi has no MCP: the allowed servers (${Object.keys(wantMcp).join(', ')}) are not available to this profile`);
    // Claude Code's sandbox also limits the shell's network; pi's holds files only.
    if (p.sandbox === true) notes.push("pi's sandbox holds files, not the network: its commands reach any host (sandbox.network.allowedDomains is Claude Code's)");
    // pi puts the prefix in front of the command Angelia's gate already wrapped: it runs unsandboxed.
    if (p.sandbox !== false) for (const f of [join(home, '.pi', 'agent', 'settings.json'), join(p.cwd, '.pi', 'settings.json')]) {
      let set: unknown;
      try { set = JSON.parse(readPlainText(f))?.shellCommandPrefix; } catch { continue; }
      if (set) notes.push(`pi's shellCommandPrefix (${f}) runs before each command outside the sandbox, and what it sets does not reach the command; remove it`);
    }
  } else {
    if (Object.keys(wantMcp).length) notes.push(`grok: allowed MCP servers are not written yet (${Object.keys(wantMcp).join(', ')}); add them with grok mcp add --scope project in ${p.cwd}`);
  }

  // Settings: deny entries and extra folders, only ever the ones recorded as ours.
  const settingsPath = join(p.cwd, '.claude', 'settings.json');
  const settings = readJson(settingsPath);
  const perms: Record<string, any> = { ...settings.permissions };
  const launch = [...LAUNCH_FILES, ...(p.backend === 'pi' ? PI_LAUNCH_DIRS : p.backend === 'codex' ? CODEX_LAUNCH_DIRS : [])].map((f) => pathRule('Edit', join(p.cwd, f), p.backend, home));
  if (p.backend === 'pi') launch.push(...piHomeRules(home));
  if (gdir) launch.push(...agyLaunchRules(p.cwd, gdir, home));
  const wantDeny = [...new Set([...profileFloor(cfg, name, stateDir, home), ...launch, ...[...denied].flatMap(([n, c]) => denyEntries(n, c, p.backend, home))])];
  // grok has no strict mode: servers set up for the whole user reach every folder, so each one this
  // profile was not given is denied by name. (Claude leaves them out through --strict-mcp-config.)
  if (p.backend === 'grok') for (const n of userMcpServers(home)) if (!(n in wantMcp) && !wantDeny.includes(`mcp__${n}`)) wantDeny.push(`mcp__${n}`);
  // Codex: the same for the servers in its own config; the launch switches each denied one off (codex-config.ts).
  if (p.backend === 'codex') for (const n of codexUserMcpServers(home)) if (!(n in wantMcp) && !wantDeny.includes(`mcp__${n}`)) wantDeny.push(`mcp__${n}`);
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
  const isStateOnly = stateOnlyTest(cfg, name, stateDir, home, readGuard(stateDir, name)?.stateReach ?? rec?.stateReach, launch);
  const stateOnly = changes.filter((c) => { const m = /^[+-] deny ([\s\S]+)$/.exec(c); return !!m && isStateOnly(m[1]); });

  // The CLI's sandbox (Claude only). The API socket is always reachable from it, so turning the
  // sandbox on by hand does not cut the agent off from angelia send; `sandbox: true` turns it on,
  // with no unsandboxed escape (without that, a command the sandbox stops can run outside it).
  const sb: Record<string, any> = { ...settings.sandbox };
  const net: Record<string, any> = { ...sb.network };
  let sandboxChanged = false;
  const wantSockets = p.backend === 'claude-code' ? [join(stateDir, API_SOCKET)] : [];
  const sockets: string[] = [...(net.allowUnixSockets ?? [])];
  for (const x of rec?.sockets ?? []) if (!wantSockets.includes(x) && sockets.includes(x)) { sockets.splice(sockets.indexOf(x), 1); changes.push(`- sandbox socket ${x}`); sandboxChanged = true; }
  for (const x of wantSockets) if (!sockets.includes(x)) { sockets.push(x); changes.push(`+ sandbox socket ${x}`); sandboxChanged = true; }
  const wantSandbox = p.backend === 'claude-code' && p.sandbox;
  if (p.backend === 'agy') {
    notes.push(p.sandbox === false
      ? 'agy: sandbox: false: agy and every command it runs are not in a sandbox; Angelia answers its permission requests from the deny rules, but a Read deny inside the folder does not bind (agy reads files there without asking), nor any rule for a shell command\'s own reads'
      : 'agy: Angelia answers every permission request from the deny rules, and agy runs inside a macOS sandbox made from them (shell commands included)');
    notes.push(`agy: CLAUDE.md is copied to ${AGY_INSTRUCTIONS} with its imports expanded before every start; edit CLAUDE.md, never that file`);
    const lacks = ['tmux mode (tui)', ...(p.chrome ? ['chrome: true (agy has no browser tool here)'] : []), 'prompt caching'];
    notes.push(`agy has none of these Claude Code features: ${lacks.join(', ')}`);
    conflicts.push(...agyLaunchProblems(p.cwd, p.add_dirs, gdir!, undefined, home));
  }
  if (p.sandbox && p.backend === 'grok') notes.push('sandbox: true is for Claude Code, Codex and pi; grok has no such setting here, so it is ignored');
  if (p.backend === 'pi') notes.push(p.sandbox === false ? 'pi: sandbox: false, so shell commands run outside the sandbox: the deny rules hold only pi\'s file tools' : 'pi: the deny rules hold pi\'s file tools (Angelia\'s gate) and every shell command (each runs in a macOS sandbox made from them)');
  if (p.backend === 'codex') notes.push(p.sandbox === false ? 'codex: sandbox: false, so the agent runs with full access: the deny rules bind nothing, and in every mode it runs commands without asking' : 'codex: the deny rules and the writable folders are held by Codex\'s own sandbox (the OS), shell commands included');
  if (p.backend === 'codex' && existsSync(join(p.cwd, 'AGENTS.md'))) notes.push('codex: this folder has an AGENTS.md, which Codex reads instead of CLAUDE.md, so the instructions and the capability block in CLAUDE.md do not reach it; merge them and remove AGENTS.md');
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
  const lines = blockLines(allowed, p.backend, all ? dropped.map(([n]) => n) : undefined);
  const claudeMd = join(p.cwd, 'CLAUDE.md');
  const selfText = p.backend === 'grok' || p.backend === 'agy' ? opts.self?.(name) : undefined;
  const text = blockText(selfText, lines);
  const md = openAgentFile(claudeMd);
  if (md === 'link') conflicts.push(`${claudeMd} is a link or has another name (a hard link); Angelia writes only a plain file there, so make it one`);
  const hasBlock = typeof md === 'object' && md.text.includes(SELF_START);
  if (typeof md === 'object') closeSync(md.fd);
  let blockOp: (() => void) | undefined;
  if (!same(rec?.blockLines ?? [], lines) || (text && !hasBlock)) {
    changes.push(lines.length ? `~ CLAUDE.md managed block: ${lines.length - 1} capability line(s)` : '- CLAUDE.md capability lines');
    blockOp = () => {
      if (text) {
        const r = upsertSelfBlock(claudeMd, text);
        if (r === 'broken') throw new Error(`${claudeMd} has one angelia:self marker without the other; fix it by hand`);
        if (r === 'link') throw new Error(`${claudeMd} is a link or not a plain file; Angelia writes only a plain file there`);
      }
      else removeBlock(claudeMd);
    };
  }
  if (existsSync(claudeMd)) {
    const outside = stripBlock(readPlainText(claudeMd));
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
  if (p.permission_mode === 'bypassPermissions' && !wantSandbox && !((p.backend === 'codex' || p.backend === 'pi') && p.sandbox !== false)) notes.push('bypassPermissions: deny rules stop the file tools, not the shell; a program the agent runs can still read a denied path (sandbox: true closes that for Claude Code)');
  const userSkills = userSkillDirs(p.backend, home).flatMap((d) => safeList(d)).filter((n) => n !== HANDOFF_NAME);
  if (p.backend === 'pi') {
    // pi's global settings can add skill folders and packages for every folder; compile cannot filter those.
    let global: Record<string, unknown> = {};
    try { global = JSON.parse(readPlainText(join(home, '.pi', 'agent', 'settings.json'))); } catch { /* none, or not ours to fix */ }
    const extra = ['skills', 'packages'].filter((k) => Array.isArray(global[k]) && (global[k] as unknown[]).length);
    if (extra.length) notes.push(`pi's global settings list ${extra.join(' and ')} for every folder (${join(home, '.pi', 'agent', 'settings.json')}); a denied skill there still loads`);
  }
  if (userSkills.length) notes.push(`skills installed for every profile, not filtered: ${userSkills.join(', ')}`);

  const record: CompiledRecord = {
    version: 1, backend: p.backend, links: wantLinks, // written only by apply(), which refuses on any conflict
    // Codex: the servers it may load, checked against Codex's merged config at every start (codex.ts).
    mcpServers: p.backend === 'claude-code' || p.backend === 'codex' ? Object.keys(wantMcp) : p.backend === 'agy' ? agyMcp.map((m) => m.name) : [], mcpStrict: strict,
    deny: wantDeny, additionalDirectories: wantDirs, blockLines: lines, compiledAt: new Date().toISOString(),
    ...(wantSandbox ? { sandbox: true } : {}), ...(wantSockets.length ? { sockets: wantSockets } : {}),
    stateReach: reachInState(cfg, name, stateDir, home),
    ...(p.backend === 'claude-code' ? all
      ? { connectors: [], connectorsAll: true, connectorsDenied: droppedUrls.map((u) => deniedHash(u, recKey)), mcpOwn, mcpDeny }
      : { connectors: connectorUrls, ...(connectorUrls.length ? { mcpAllow, mcpOwn, mcpUrls } : {}) } : {}),
  };

  const guardMcp: LaunchGuard['mcp'] = p.backend !== 'claude-code' ? undefined : all
    ? { strict, connectors: [], allow: [], own: mcpOwn, urls: [], all: true, deniedUrls: droppedUrls, deniedNames: mcpDeny }
    : { strict, connectors: connectorUrls, allow: connectorUrls.length ? mcpAllow : [], own: connectorUrls.length ? mcpOwn : [], urls: connectorUrls.length ? mcpUrls : [] };
  return {
    profile: name, changes, conflicts, duplicates, notes, stateOnly,
    apply(o = {}) { withCompileLock(stateDir, () => {
      if (conflicts.length) throw new Error(`not compiling ${name}: ${conflicts.length} conflict(s)`);
      // The key, made now if the plan found none, and the hashes with it.
      if (keyMissing) record.connectorsDenied = droppedUrls.map((u) => deniedHash(u, recordKey(stateDir, true)));
      if (gdir) {
        // agy makes this file on its first start; made empty here first, so the sandbox can close it.
        agyGeminiDir(stateDir, name);
        mkdirSync(join(gdir, 'config', 'skills'), { recursive: true, mode: 0o700 });
        const mcp = join(gdir, 'config', 'mcp_config.json');
        if (!existsOrLink(mcp)) writeFileSync(mcp, '', { mode: 0o600, flag: 'wx' });
        const conf = join(gdir, 'config', 'config.json');
        if (!existsOrLink(conf)) writeFileSync(conf, AGY_CONFIG_DEFAULT, { mode: 0o600, flag: 'wx' });
      }
      for (const op of linkOps) op();
      mcpOp?.();
      if (settingsChanged || sandboxChanged) {
        const out: Record<string, any> = { ...settings, permissions: perms };
        if (Object.keys(sb).length) out.sandbox = sb; else delete out.sandbox;
        mkdirSync(dirname(settingsPath), { recursive: true });
        writePlain(p.cwd, settingsPath, JSON.stringify(out, null, 2) + '\n');
      }
      blockOp?.();
      if (wantDirs.includes(common)) mkdirSync(common, { recursive: true });
      mkdirSync(join(p.cwd, '.claude'), { recursive: true });
      writePlain(p.cwd, join(p.cwd, RECORD), JSON.stringify(record, null, 2) + '\n');
      writeGuard(stateDir, name, { cwd: p.cwd, deny: wantDeny, backend: p.backend, ...(wantSandbox ? { sandbox: true } : {}), ...(p.backend === 'codex' && p.sandbox !== false ? { codexSandbox: true } : {}), ...(p.backend === 'pi' && p.sandbox !== false ? { piSandbox: true } : {}), ...(p.backend === 'agy' && p.sandbox !== false ? { agySandbox: true } : {}), ...(gdir ? { agy: { mcpServers: agyMcp, skills: Object.keys(wantLinks) } } : {}), stateReach: record.stateReach, ...(guardMcp ? { mcp: guardMcp, claudeConfig: claudeUserFiles(home, opts.env ?? process.env).config } : {}) });
      const sfile = mcpSettingsFile(stateDir, name);
      const keys = guardMcp ? mcpLaunch(p.cwd, guardMcp).settings : {};
      if (Object.keys(keys).length) { if (!launchSettingsFile(stateDir, name, keys)) throw new Error(`${sfile} cannot be written`); }
      else rmSync(sfile, { force: true });
      // The copy where 0.4.2 to 0.4.8 kept it holds the same addresses: not left behind, unless that
      // path is the guard of a profile named `<name>.settings`.
      if (!(`${name}.settings` in cfg.profiles)) rmSync(legacySettingsFile(stateDir, name), { force: true });
    }, o.waitMs); },
  };
}

/** The absolute path a Read or Edit rule names, in any backend's form (pathRule), without a trailing
 *  `/**`; undefined for any other rule. */
function rulePath(rule: string, home: string): string | undefined {
  const m = /^(?:Read|Edit)\(([\s\S]+)\)$/.exec(rule);
  if (!m) return undefined;
  const raw = m[1].replace(/\/\*\*$/, '');
  const abs = raw.startsWith('~/') ? join(home, raw.slice(2)) : raw.startsWith('//') ? raw.slice(1) : raw;
  return isAbsolute(abs) ? resolve(abs) : undefined;
}

/** The paths a profile reaches in the state folder (stateReach), kept in its record. */
function reachInState(cfg: Config, name: string, stateDir: string, home: string): string[] {
  const s = resolve(stateDir);
  return stateReach(cfg, name, home, s).filter((r) => isInside(r, s, home) && r !== s).sort();
}

/** The floor's rules that come from the table and the version, not from what the state folder holds. */
function tableFloor(cfg: Config, name: string, stateDir: string, home: string): string[] {
  const p = cfg.profiles[name];
  return [...floorRules(p.backend, stateDir, home), ...credentialRules(p, home), ...otherProfileRules(cfg, name, home),
    ...sharedRules(p, stateDir, home), ...agyStateRules(cfg, name, stateDir, home),
    ...[...resolveProfile(cfg, name).denied].flatMap(([n, c]) => denyEntries(n, c, p.backend, home))];
}

/**
 * ProfilePlan.stateOnly: is this deny rule only the state folder's own entry coming or going? Its path
 * is inside the state folder, not the folder itself, no rule of the table's own names it, and it
 * neither lies in nor holds anything the profile reaches there, now (stateOpenPaths) or at its last
 * compile (the record's stateReach): an add_dirs entry given or taken there is a table change (review
 * fix M3). A record without stateReach (compiled before it) has nothing to compare: nothing is.
 */
function stateOnlyTest(cfg: Config, name: string, stateDir: string, home: string, lastReach: string[] | undefined, extra: string[] = []): (rule: string) => boolean {
  if (!lastReach) return () => false;
  const s = resolve(stateDir);
  const reach = [...stateOpenPaths(cfg, name, s, home), ...lastReach];
  const named = new Set([...tableFloor(cfg, name, stateDir, home), ...extra]);
  return (rule) => {
    if (named.has(rule)) return false;
    const at = rulePath(rule, home);
    return !!at && at !== s && isInside(at, s, home) && !reach.some((o) => isInside(at, o, home) || isInside(o, at, home));
  };
}

/** Writes a whole file in a profile's folder by a new file renamed over it: a reader never sees it half
 *  written, and a link in its place is replaced, never written through. No link on the way (openNoFollow). */
function replacePlain(cwd: string, file: string, text: string, mode = 0o644): void {
  const path = join(realpathSync(cwd), relative(cwd, file));
  const tmp = `${path}.angelia-${process.pid}.tmp`;
  // The file keeps its own mode (a 0600 settings file stays 0600, review fix N2); a new one takes `mode`.
  try { const st = lstatSync(path); if (st.isFile()) mode = st.mode & 0o777; } catch { /* not there yet */ }
  rmSync(tmp, { force: true });
  const fd = openNoFollow(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try { writeSync(fd, text, 0); fchmodSync(fd, mode); } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

const lockDepth = new Map<string, number>();
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
/** No compile holds the lock this long: one older is left by a writer that is gone, even when its
 *  process id now belongs to another process (review fix N3). */
export const LOCK_STALE_MS = 60_000;

/**
 * One writer at a time of the compiled files (a profile's settings, record and guard): `angelia compile
 * --write`, onboarding, a new agent, the daemon's floor refresh. A lock file in the state folder's
 * compiled/, holding the writer's process id. One whose process is gone, or older than LOCK_STALE_MS,
 * is taken over by renaming it aside, which only one waiter can do. Held again inside the same process,
 * it is not waited for. Throws after `waitMs`. The wait blocks its thread, so the daemon asks for a
 * short one (launch-guard.ts).
 */
export function withCompileLock<T>(stateDir: string, fn: () => T, waitMs = 2000): T {
  const key = resolve(stateDir);
  const depth = lockDepth.get(key) ?? 0;
  if (depth) { lockDepth.set(key, depth + 1); try { return fn(); } finally { lockDepth.set(key, depth); } }
  const dir = join(key, 'compiled');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, '.compile.lock');
  const until = Date.now() + waitMs;
  for (;;) {
    try { writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let pid = NaN, age = 0, ino = 0;
      try { const st = statSync(lock); ino = st.ino; age = Date.now() - st.mtimeMs; pid = Number(readPlainText(lock).trim()); } catch { continue; }
      if ((Number.isInteger(pid) && pid > 0 && !alive(pid)) || age > LOCK_STALE_MS) {
        // Renamed aside, not removed: of two waiters only one rename finds it. A lock made fresh in
        // between (another inode) is put back with link, which never replaces one made since.
        const aside = `${lock}.stale-${process.pid}-${Date.now()}`;
        try { renameSync(lock, aside); } catch { continue; }
        try { if (statSync(aside).ino !== ino) linkSync(aside, lock); } catch { /* one is there again: wait for it */ }
        rmSync(aside, { force: true });
        continue;
      }
      if (Date.now() > until) throw new Error(`another compile is writing the compiled files (process ${pid || '?'}); try again`);
      pause(25);
    }
  }
  lockDepth.set(key, 1);
  try { return fn(); } finally { lockDepth.delete(key); rmSync(lock, { force: true }); }
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
  const f = openAgentFile(file);
  if (f === 'link') throw new Error(`${file} is a link or has another name; Angelia writes only a plain file there`);
  if (!f) return;
  const next = stripBlock(f.text).replace(/^\n+/, '');
  if (next !== f.text) rewriteAgentFile(f.fd, next); else closeSync(f.fd);
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

const HANDOFF_NAME = 'angelia-handoff';
/** The skill as shipped, beside dist/ and src/. */
export const HANDOFF_SKILL = fileURLToPath(new URL('../../capabilities/builtin/angelia-handoff/SKILL.md', import.meta.url));
const HANDOFF_MARK = '<!-- Written by angelia compile, and replaced on the next one: change it in Angelia, not here. -->';

/**
 * `/angelia-handoff` for every terminal Claude Code session on this machine: a copy in the user's own
 * skills folder, since a terminal can hand off from any folder. It carries a mark; a file there
 * without the mark belongs to someone else and is left alone. Not in any profile's filter: the skill
 * refuses to run inside a chat's agent (angelia handoff checks for the agent's token).
 */
export function planHandoffSkill(home = homedir(), source = HANDOFF_SKILL): { change?: string; conflict?: string; apply(): void } {
  const at = join(home, '.claude', 'skills', HANDOFF_NAME, 'SKILL.md');
  const want = readPlainText(source).replace(/^(---\n[\s\S]*?\n---\n)/, `$1${HANDOFF_MARK}\n`);
  let cur: string | undefined;
  try { cur = readPlainText(at); } catch { /* not there yet */ }
  if (cur === want) return { apply() {} };
  if (cur !== undefined && !cur.includes(HANDOFF_MARK)) return { conflict: `${at} exists and is not Angelia's; move it aside to get /angelia-handoff`, apply() {} };
  return {
    change: `${cur === undefined ? '+' : '~'} ${at} (/angelia-handoff, for terminal sessions)`,
    apply: () => { mkdirSync(dirname(at), { recursive: true }); writeFileSync(at, want); },
  };
}
/** What a floor refresh wrote, and how to put it back. `floor`: the floor it worked from, when it read
 *  one (the launch guard checks against that same list, review fix L1). */
export interface FloorRefresh { added: string[]; dropped: string[]; floor?: string[]; undo(): void }

/**
 * Adds to a compiled profile's deny rules what its floor (profileFloor) holds now and its settings
 * lack: another profile added to the table (its folder, its agy folder, review M2), a new entry in
 * the state folder (stateClosedRules, review M3), a floor an update grew. And drops a rule an earlier
 * compile or refresh wrote for an entry of the state folder that is gone (ProfilePlan.stateOnly), so
 * passing names (a .tmp) do not pile up. Deny rules only: a deny is never a grant, so this carries no
 * capability live that the owner has not compiled (compile goes live one profile at a time). Into the
 * settings, the guard and, when it can be read, the record (the agent can delete that one; nothing
 * here waits on it). Not a rule the guard holds and the settings lost: that was removed outside
 * Angelia, and the launch check refuses it. Nothing for a profile never compiled, compiled for another
 * folder or backend, or whose settings cannot be read: the launch check refuses it anyway. Under the
 * compile lock. Throws when a write fails, after putting back what it wrote.
 */
export function refreshFloor(cfg: Config, name: string, stateDir = INSTANCE_DIR, home = homedir(), o: { waitMs?: number } = {}): FloorRefresh {
  return withCompileLock(stateDir, () => {
    const none: FloorRefresh = { added: [], dropped: [], undo() {} };
    const p = cfg.profiles[name];
    if (!p) return none;
    const g = readGuard(stateDir, name);
    if (!g || resolve(g.cwd) !== resolve(p.cwd) || (g.backend && g.backend !== p.backend)) return none;
    const settingsPath = join(p.cwd, '.claude', 'settings.json');
    let settingsText: string, settings: Record<string, any>;
    try { settingsText = readPlainText(settingsPath); settings = JSON.parse(settingsText); } catch { return none; }
    if (!settings || typeof settings !== 'object') return none;
    const have: string[] = Array.isArray(settings.permissions?.deny) ? settings.permissions.deny : [];
    const ours = g.deny ?? [];
    const floor = profileFloor(cfg, name, stateDir, home);
    const added = floor.filter((r) => !have.includes(r) && !ours.includes(r));
    const recordPath = join(p.cwd, RECORD);
    let recordText: string | undefined, rec: CompiledRecord | undefined;
    try { recordText = readPlainText(recordPath); rec = JSON.parse(recordText) as CompiledRecord; } catch { recordText = undefined; }
    // The record is in the agent's own folder, so it may hold anything: a field of the wrong shape is
    // read as absent, never thrown on (review fix L4), or the profile would refuse every start.
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { rec = undefined; recordText = undefined; }
    const recDeny: string[] = Array.isArray(rec?.deny) ? rec.deny.filter((r): r is string => typeof r === 'string') : [];
    const recReach = Array.isArray(rec?.stateReach) && rec.stateReach.every((r) => typeof r === 'string') ? rec.stateReach : undefined;
    // A guard from before stateReach takes what the profile reaches now (review fix N1), unless a rule
    // its compile wrote denies part of that: then the table gave it more since, and only a compile says so.
    const reachNow = reachInState(cfg, name, stateDir, home);
    const lastReach = g.stateReach ?? recReach;
    // (Read rules only: the launch rules close files in the profile's own folder to writing, on purpose.)
    const seed = !g.stateReach && !ours.some((r) => { const at = r.startsWith('Read(') && rulePath(r, home); return !!at && reachNow.some((x) => isInside(x, at, home) || isInside(at, x, home)); });
    const stateOnly = stateOnlyTest(cfg, name, stateDir, home, lastReach ?? (seed ? reachNow : undefined));
    const dropped = ours.filter((r) => !floor.includes(r) && stateOnly(r) && !existsOrLink(rulePath(r, home)!));
    if (!added.length && !dropped.length && !seed) return { ...none, floor };
    const guardPath = guardFile(stateDir, name), guardText = readPlainText(guardPath);
    const next = (list: string[] | undefined) => [...new Set([...(list ?? []).filter((r) => !dropped.includes(r)), ...added])];
    // With the same wait: in the daemon a failure path must not block every chat either (review fix C2).
    const undo = () => withCompileLock(stateDir, () => {
      replacePlain(p.cwd, settingsPath, settingsText);
      if (recordText !== undefined) replacePlain(p.cwd, recordPath, recordText);
      replacePlain(dirname(guardPath), guardPath, guardText, 0o600);
    }, o.waitMs);
    try {
      // The settings first: a guard rule the settings lack is a refusal (launchCheck), never a gap.
      const rules = added.length || dropped.length;
      if (rules) replacePlain(p.cwd, settingsPath, JSON.stringify({ ...settings, permissions: { ...settings.permissions, deny: next(have) } }, null, 2) + '\n');
      if (rec && rules) replacePlain(p.cwd, recordPath, JSON.stringify({ ...rec, deny: next(recDeny) }, null, 2) + '\n');
      replacePlain(dirname(guardPath), guardPath, JSON.stringify({ ...g, deny: next(g.deny), ...(seed ? { stateReach: reachNow } : {}) }, null, 2) + '\n', 0o600);
    } catch (e) {
      try { undo(); } catch { /* the first error says what failed; a half-written refresh only adds denies */ }
      throw e;
    }
    return { added, dropped, floor, undo };
  }, o.waitMs);
}

/** The floor rules a profile's settings lack now: none may be missing when its agent starts. `floor`:
 *  the floor to check against (the one refreshFloor just wrote from), else the state folder read now. */
export function floorMissing(cfg: Config, name: string, stateDir = INSTANCE_DIR, home = homedir(), floor?: string[]): string[] {
  const deny = settingsDeny(cfg.profiles[name].cwd);
  return (floor ?? profileFloor(cfg, name, stateDir, home)).filter((r) => !deny.includes(r));
}

/**
 * refreshFloor for every compiled profile but those named (the one just added, compiled by itself):
 * a profile added to the table changes every other profile's floor (otherProfileRules: its folder;
 * agyStateRules: its agy folder, without which an agy profile refuses to start, agyFloorProblem).
 * All or nothing: a failure puts back every profile already refreshed, then throws. Under one hold of
 * the compile lock, waited for `o.waitMs` (the daemon asks for a short one, review fix C2).
 */
export function refreshFloors(cfg: Config, skip: string[], stateDir = INSTANCE_DIR, home = homedir(), o: { waitMs?: number } = {}): { refreshed: string[]; undo(): void } {
  const done: { name: string; r: FloorRefresh }[] = [];
  const undo = () => { for (const d of [...done].reverse()) d.r.undo(); };
  withCompileLock(stateDir, () => {
    try {
      for (const name of Object.keys(cfg.profiles)) {
        if (skip.includes(name)) continue;
        const r = refreshFloor(cfg, name, stateDir, home, o);
        if (r.added.length || r.dropped.length) done.push({ name, r });
      }
    } catch (e) {
      try { undo(); } catch { /* the first error is the one to report */ }
      throw e;
    }
  }, o.waitMs);
  return { refreshed: done.map((d) => d.name), undo };
}
