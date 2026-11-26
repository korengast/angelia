import type { Profile } from '../instance/config/schema.js';
import type { BrainSession } from './brain.js';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { mcpLaunch, readRecord, type McpLaunch } from '../capabilities/compile.js';

/** Variables that switch a CLI from the user's subscription to per-token API billing, or send it
 *  to another endpoint. None of them reaches any agent, whatever its backend: a grok profile's shell
 *  could run `claude`, and a key in the daemon's environment was never meant for the agents.
 *  The Gemini and grok names were read out of their binaries (Gemini's agy 1.2.7, grok 1.0.40, 2026-09-21): an agent may call either CLI as a tool. */
export const STRIP_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI',
  'XAI_API_KEY', 'GROK_CODE_XAI_API_KEY',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY',
];
export const MIN_CLAUDE_VERSION = '2.1.270';

/** Tools that wait for a click on a screen the chat does not have. AskUserQuestion is offered in
 *  Angelia's launch shape (measured 2026-09-21, claude 2.1.278: listed with --permission-prompt-tool
 *  stdio, gone with this flag); the first onboarded profile called it and waited forever. Without it
 *  the agent asks in its reply, which reaches the chat. The `=` form keeps the variadic flag from
 *  eating the next argument. */
export const NO_SCREEN_TOOLS = '--disallowed-tools=AskUserQuestion';

/** tmux mode's settings file: the hooks the pane runs (tui.ts) and the profile's MCP keys (mcpLaunch),
 *  in the one --settings the pane is started with. Of two --settings flags only the last counts
 *  (measured on claude 2.1.332: an allow list in the first was dropped). */
export function tuiSettings(p: Profile, hooks: unknown, mcp: McpLaunch = mcpLaunch(p.cwd)): Record<string, unknown> {
  return { ...mcp.settings, ...(hooks as Record<string, unknown>) };
}

/** `mcp`: the MCP launch the daemon took from the profile's guard (guardMcpLaunch); unset, it is read
 *  from the record in the profile's folder (mcpLaunch). `settingsFile`: the compile's copy of its keys
 *  (BrainOptions.mcpSettingsFile), passed by path when it holds exactly them; else they go inline. */
export function claudeArgv(p: Profile, s: BrainSession, bin = 'claude', system?: string, mcp: McpLaunch = mcpLaunch(p.cwd), settingsFile?: string): string[] {
  const a = [bin, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio'];
  if (p.permission_mode === 'bypassPermissions') a.push('--dangerously-skip-permissions');
  else a.push('--permission-mode', p.permission_mode);
  a.push(s.started ? '--resume' : '--session-id', s.id);
  if (p.model) a.push('--model', p.model);
  if (p.effort) a.push('--effort', p.effort);
  for (const d of p.add_dirs) a.push('--add-dir', d);
  if (p.chrome) a.push('--chrome');
  a.push(NO_SCREEN_TOOLS);
  // Print mode passes no other --settings: the MCP keys get one of their own, only when there are any,
  // so a launch with none (a strict profile with no connector) is the exact argv it was.
  a.push(...mcp.args);
  if (Object.keys(mcp.settings).length) a.push('--settings', settingsFile && sameKeys(settingsFile, mcp.settings) ? settingsFile : JSON.stringify(mcp.settings));
  if (system) a.push('--append-system-prompt', system);
  return a;
}

/** The settings file holds these keys and no others (compared as JSON). */
function sameKeys(file: string, settings: Record<string, unknown>): boolean {
  try { return JSON.stringify(JSON.parse(readFileSync(file, 'utf8'))) === JSON.stringify(settings); } catch { return false; }
}

/** A stable, readable name per profile and session: the tmux session and the Remote Control name.
 *  Only an interactive session joins Remote Control (measured 2026-09-19 against claude 2.1.278: in
 *  print mode the flag is accepted and ignored), so print mode never passes it; tui mode always does. */
export function remoteControlName(p: Profile, s: BrainSession): string {
  const dir = p.cwd.replace(/\/+$/, '').split('/').pop() || 'angelia';
  return `${p.session_prefix ?? 'angelia'}-${dir}-${s.id.slice(0, 8)}`.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').slice(0, 60);
}

/** The same CLI as `claudeArgv`, hosted in a terminal instead of print mode. An interactive
 *  session is the only kind Remote Control registers, so this is what puts a chat in the Claude
 *  app; it also keeps MCP servers warm between turns and lets background tasks outlive a turn.
 *  The answer comes back through the Stop hook in `settings`, not through stdout. */
export function claudeTuiArgv(p: Profile, s: BrainSession, bin: string, settings: string, name: string, system?: string, mcp: McpLaunch = mcpLaunch(p.cwd)): string[] {
  const a = [bin];
  if (p.permission_mode === 'bypassPermissions') a.push('--dangerously-skip-permissions');
  else a.push('--permission-mode', p.permission_mode);
  a.push('--settings', settings);
  a.push(s.started ? '--resume' : '--session-id', s.id);
  if (p.model) a.push('--model', p.model);
  if (p.effort) a.push('--effort', p.effort);
  for (const d of p.add_dirs) a.push('--add-dir', d);
  if (p.chrome) a.push('--chrome');
  a.push(NO_SCREEN_TOOLS);
  a.push('--remote-control', name);
  // The MCP keys are in the settings file (tuiSettings); the flags here.
  a.push(...mcp.args);
  if (system) a.push('--append-system-prompt', system);
  return a;
}

/** A word the shell takes as it is: an argument with a space or a quote is quoted, and a path
 *  under home is written from `~/`, which keeps a line for the phone short. */
function shellWord(v: string, home: string): string {
  const q = (x: string) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replace(/'/g, `'\\''`)}'`);
  return v === home ? '~' : v.startsWith(`${home}/`) ? `~/${q(v.slice(home.length + 1))}` : q(v);
}

/** The chat's Claude Code session, for the owner at a terminal: `/status` prints it, so the work goes
 *  on at the desk. What the chat runs comes along (its folder, permissions, model, effort, extra
 *  folders, MCP servers and connectors, no auto memory); what only a chat needs stays out (print mode, the self
 *  prompt, the Stop hook, Remote Control, the screen tools refused). */
/** `o.mcp`: the launch from the guard; `o.settingsFile`: the copy of its MCP keys in the state folder
 *  (launchSettingsFile), passed by path so the line names no address. Without a file that holds
 *  exactly them the keys go inline. */
export function claudeTerminalLine(p: Profile, id: string, home = homedir(), o: { mcp?: McpLaunch; settingsFile?: string } = {}): string {
  const w = (v: string) => shellWord(v, home);
  const a = [`cd ${w(p.cwd)}`, '&&', ...Object.entries(CLAUDE_ENV).map(([k, v]) => `${k}=${v}`), w(p.bin ?? 'claude')];
  if (p.permission_mode === 'bypassPermissions') a.push('--dangerously-skip-permissions');
  else if (p.permission_mode !== 'default') a.push('--permission-mode', p.permission_mode);
  a.push('--resume', id);
  if (p.model) a.push('--model', w(p.model));
  if (p.effort) a.push('--effort', p.effort);
  for (const d of p.add_dirs) a.push('--add-dir', w(d));
  if (p.chrome) a.push('--chrome');
  const mcp = o.mcp ?? mcpLaunch(p.cwd);
  a.push(...mcp.args.map(w));
  // The file only when it holds exactly these keys: one that is gone or another would start a session
  // with other MCP servers than the chat's.
  if (Object.keys(mcp.settings).length) a.push('--settings', w(o.settingsFile && sameKeys(o.settingsFile, mcp.settings) ? o.settingsFile : JSON.stringify(mcp.settings)));
  return a.join(' ');
}

/** Set for every Claude Code session Angelia starts, in print and tmux mode alike. Claude's auto
 *  memory keeps one folder per git repository (code.claude.com/docs/en/memory, 2.1.285), and every
 *  profile in the workspace shares its repository: each would load at start, and add to, what the
 *  others saved. A profile keeps its memory in its own folder instead. */
export const CLAUDE_ENV: Record<string, string> = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };

export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!STRIP_ENV.includes(k)) env[k] = v;
  return env;
}

export function versionAtLeast(actual: string, min: string): boolean {
  const a = actual.split('.').map(Number);
  const m = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (m[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (m[i] ?? 0)) return false;
  }
  return true;
}

/** grok (Grok Build) as an ACP agent over stdio. Sessions are created and resumed inside the
 *  protocol, so argv carries only model, effort and the permission stance. No self prompt here:
 *  measured 2026-09-21 on grok 1.0.40, `--rules` is accepted before `agent stdio` and ignored, so
 *  grok gets it from the profile's CLAUDE.md instead (self.ts). */
export function grokArgv(p: Profile, bin = 'grok'): string[] {
  const a = [bin];
  a.push('--permission-mode', p.permission_mode);
  a.push('agent');
  if (p.model) a.push('-m', p.model);
  // Passed as is: measured 2026-09-21 on grok 1.0.40, every level from low to max answers a turn.
  if (p.effort) a.push('--reasoning-effort', p.effort);
  if (p.permission_mode === 'bypassPermissions') a.push('--always-approve');
  a.push('stdio');
  return a;
}

/** Read-only tools for plan mode: pi has no plan mode of its own. */
export const PI_PLAN_TOOLS = 'read,grep,find,ls';

/** pi in RPC mode. Measured 2026-09-25 on pi 0.86.1: `--session-id` creates the session under the
 *  given id or resumes it, and `--append-system-prompt` is honoured in RPC mode. The permission
 *  stance is not on argv: the gate extension reads it from the environment (pi-gate.ts). A compiled
 *  profile's skills are passed one by one; pi does not read Claude's skills folder. */
export function piArgv(p: Profile, s: BrainSession, bin = 'pi', system?: string, gate?: string): string[] {
  const a = [bin, '--mode', 'rpc', '--session-id', s.id];
  if (p.model) a.push('--model', p.model);
  // Passed as is: pi's levels (off, minimal, low, medium, high, xhigh, max) include all of Angelia's.
  if (p.effort) a.push('--thinking', p.effort);
  if (p.permission_mode === 'plan') a.push('--tools', PI_PLAN_TOOLS);
  for (const path of Object.values(readRecord(p.cwd)?.links ?? {})) a.push('--skill', path);
  if (gate) a.push('-e', gate);
  if (system) a.push('--append-system-prompt', system);
  return a;
}

/** The model an agy profile runs when it names none (owner decision, 2026-11-21). */
export const AGY_DEFAULT_MODEL = 'gemini-4-hydrogen-high';
/** agy's effort levels: the last word of its model ids (session/new availableModels, agy 1.5.14). */
const AGY_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

/** The model id agy is set to: the profile's model, else the default. agy has no effort setting of its
 *  own: the level is the id's suffix, so an `effort` replaces the suffix the id has, or is added
 *  (max, which agy has not, becomes xhigh). */
export function agyModel(p: Profile): string {
  const model = p.model ?? AGY_DEFAULT_MODEL;
  if (!p.effort) return model;
  const level = p.effort === 'max' ? 'xhigh' : p.effort;
  const parts = model.split('-');
  const base = AGY_EFFORTS.includes(parts[parts.length - 1]) ? parts.slice(0, -1).join('-') : model;
  return `${base}-${level}`;
}

/** agy (Antigravity CLI) as an ACP agent over stdio. Sessions and the model are set inside the
 *  protocol (brain/agy.ts). `--gemini-dir` is the profile's own folder for agy's settings, MCP config
 *  and conversations, never the owner's ~/.gemini. Never `--dangerously-skip-permissions`: Angelia
 *  answers every permission request. */
export function agyArgv(p: Profile, geminiDir: string, bin = 'agy'): string[] {
  const a = [bin, 'acp', '--gemini-dir', geminiDir];
  for (const d of p.add_dirs) a.push('--add-dir', d);
  return a;
}
