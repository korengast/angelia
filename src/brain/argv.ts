import type { Profile } from '../instance/config/schema.js';
import type { BrainSession } from './brain.js';
import { readRecord, strictMcpArgs } from '../capabilities/compile.js';

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

export function claudeArgv(p: Profile, s: BrainSession, bin = 'claude', system?: string): string[] {
  const a = [bin, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio'];
  if (p.permission_mode === 'bypassPermissions') a.push('--dangerously-skip-permissions');
  else a.push('--permission-mode', p.permission_mode);
  a.push(s.started ? '--resume' : '--session-id', s.id);
  if (p.model) a.push('--model', p.model);
  if (p.effort) a.push('--effort', p.effort);
  for (const d of p.add_dirs) a.push('--add-dir', d);
  if (p.chrome) a.push('--chrome');
  a.push(NO_SCREEN_TOOLS);
  a.push(...strictMcpArgs(p.cwd));
  if (system) a.push('--append-system-prompt', system);
  return a;
}

/** A stable, readable name per profile and session: the tmux session and the Remote Control name.
 *  Only an interactive session joins Remote Control (measured 2026-09-19 against claude 2.1.278: in
 *  print mode the flag is accepted and ignored), so print mode never passes it; tui mode always does. */
export function remoteControlName(p: Profile, s: BrainSession): string {
  const dir = p.cwd.replace(/\/+$/, '').split('/').pop() || 'angelia';
  return `angelia-${dir}-${s.id.slice(0, 8)}`.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').slice(0, 60);
}

/** The same CLI as `claudeArgv`, hosted in a terminal instead of print mode. An interactive
 *  session is the only kind Remote Control registers, so this is what puts a chat in the Claude
 *  app; it also keeps MCP servers warm between turns and lets background tasks outlive a turn.
 *  The answer comes back through the Stop hook in `settings`, not through stdout. */
export function claudeTuiArgv(p: Profile, s: BrainSession, bin: string, settings: string, name: string, system?: string): string[] {
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
  a.push(...strictMcpArgs(p.cwd));
  if (system) a.push('--append-system-prompt', system);
  return a;
}

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
