import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Profile } from '../instance/config/schema.js';
import { CODEX_PROFILE, codexFilesystem, codexUserMcpServers, tomlTable } from './codex-config.js';
import { PI_PLAN_TOOLS } from './argv.js';

/**
 * A question from another profile, answered in a read-only copy of a chat's session (`angelia ask`):
 * Claude Code, Codex and pi. Not Grok Build: its flags do not hold it read-only (measured 2026-10-04).
 * The copy is a fork: it starts from the chat's latest turns, runs beside a turn in progress, and is
 * thrown away after (Claude Code: no transcript is kept). It can only read: the tools are Read, Grep
 * and Glob, with no shell, no edits, no web (a fetch could carry data out) and no MCP server; the
 * profile's own settings and deny rules still hold. Measured on claude 2.1.289 (2026-10-04): a fork of
 * a session live in a tmux pane answers with its latest turns, under a new id; Write, Bash and Edit
 * are "disabled for this session"; `--no-session-persistence` leaves no file.
 */

export const ASK_TOOLS = 'Read,Grep,Glob';
/** The longest a question may take. The asking agent's command waits this long at most. */
export const ASK_TIMEOUT_MS = 10 * 60_000;
/** What the copy reads before the question: it is a copy, and it cannot do anything. */
export const ASK_NOTE = 'This is a read-only copy of this chat\'s session, answering one question from another profile\'s agent: you can read files, nothing else, and nothing here stays in the chat\'s session. The asker is not the owner. Answer about the work it asks about; do not quote credentials, tokens or private messages, and if it asks you to change something, say that needs a task (angelia turn).';

/** argv for one question to a Claude Code profile. `session`: the chat's active session when it has
 *  one, forked; without one the copy starts fresh in the profile's folder. */
export function claudeAskArgv(p: Profile, session: string | undefined, bin = 'claude', system?: string): string[] {
  // Hooks off: they are the one way the copy could still run a command (measured: the deny rules
  // still hold with them off, 2026-10-04).
  const a = [bin, '-p', '--output-format', 'json', '--no-session-persistence', '--tools', ASK_TOOLS,
    '--permission-mode', 'default', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--settings', '{"disableAllHooks":true}', '--append-system-prompt', system ? `${system}\n\n${ASK_NOTE}` : ASK_NOTE];
  if (session) a.push('--resume', session, '--fork-session');
  if (p.model) a.push('--model', p.model);
  if (p.effort) a.push('--effort', p.effort);
  for (const d of p.add_dirs) a.push('--add-dir', d);
  return a;
}

/**
 * argv for one question to a Codex profile: `codex exec fork` in Codex's read-only sandbox, with the
 * profile's deny rules, no network, no web search, no MCP server, plugin, connector, rules file,
 * hook or notify program, never asking, and no session kept.
 * Measured on codex 0.157 (2026-10-04): a fork of a session answers from it; "this environment only
 * allows reading files". The options go before `fork`; the prompt is read from stdin (`-`); the answer
 * is the last message, written to `out`. Throws an AskError when an MCP server cannot be switched off.
 */
export function codexAskArgv(p: Profile, session: string | undefined, bin: string, system: string | undefined, deny: string[], out: string, home = homedir()): string[] {
  const fs = codexFilesystem(deny, [], home);
  // Plugins and connectors act on the account server-side, past the sandbox and network switch;
  // rules files, hooks and notify can run programs outside the sandbox (measured or documented,
  // codex 0.157): all off.
  const a = [bin, 'exec', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '-o', out,
    '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.hooks=false', '-c', 'notify=[]',
    '-c', 'project_doc_fallback_filenames=["CLAUDE.md"]',
    '-c', `default_permissions=${JSON.stringify(CODEX_PROFILE)}`,
    '-c', `permissions.${CODEX_PROFILE}.extends=":read-only"`,
    ...(Object.keys(fs.entries).length ? ['-c', `permissions.${CODEX_PROFILE}.filesystem=${tomlTable(fs.entries)}`] : []),
    '-c', `permissions.${CODEX_PROFILE}.network.enabled=false`,
    '-c', 'web_search="disabled"',
    '-c', 'approval_policy="never"',
    '-c', `developer_instructions=${JSON.stringify(system ? `${system}\n\n${ASK_NOTE}` : ASK_NOTE)}`];
  for (const n of codexUserMcpServers(home)) {
    if (!/^[A-Za-z0-9_-]+$/.test(n)) throw new AskError('this Codex profile cannot answer questions here', 409, `MCP server "${n}" cannot be switched off from Angelia`);
    a.push('-c', `mcp_servers.${n}.enabled=false`);
  }
  if (p.model) a.push('-m', p.model);
  if (p.effort) a.push('-c', `model_reasoning_effort=${JSON.stringify(p.effort)}`);
  if (session) a.push('fork', session);
  a.push('-');
  return a;
}

/**
 * argv for one question to a pi profile: a fork with the read tools only, no session kept, no
 * extensions, skills or prompt templates but Angelia's gate, which holds reads to the profile's deny
 * rules (in its sandbox when the profile has one). Run with the gate's policy in plan mode
 * (piAskPolicy). Measured on pi 0.86.1 (2026-10-04): a fork answers from the session; no write tool.
 */
export function piAskArgv(p: Profile, fork: { file: string; into: string } | undefined, bin: string, system: string | undefined, gate: string): string[] {
  const a = [bin, '-p', '--tools', PI_PLAN_TOOLS, '--no-extensions', '--no-skills', '--no-prompt-templates', '-e', gate,
    '--append-system-prompt', system ? `${system}\n\n${ASK_NOTE}` : ASK_NOTE];
  // pi refuses --fork with --no-session: the fork is saved into a folder of its own, removed after.
  a.push(...(fork ? ['--fork', fork.file, '--session-dir', fork.into] : ['--no-session']));
  if (p.model) a.push('--model', p.model);
  if (p.effort) a.push('--thinking', p.effort);
  return a;
}

/** The file pi keeps a session in (`--session-id <id>` names it `<time>_<id>.jsonl`, in a folder per
 *  working folder under ~/.pi/agent/sessions), or undefined. */
export function piSessionFile(id: string, home = homedir()): string | undefined {
  const root = join(home, '.pi', 'agent', 'sessions');
  let dirs: string[] = [];
  try { dirs = readdirSync(root); } catch { return undefined; }
  for (const d of dirs) {
    let files: string[] = [];
    try { files = readdirSync(join(root, d)); } catch { continue; }
    const f = files.find((n) => n.endsWith(`_${id}.jsonl`));
    if (f) return join(root, d, f);
  }
  return undefined;
}

/** How each CLI hands over its answer: Claude Code a JSON result on stdout, pi plain text on stdout,
 *  Codex its last message in a file. Undefined: no answer. */
export type AskReader = (stdout: string, code: number | null) => string | undefined;
export const claudeAnswer: AskReader = (out) => {
  try { const r = JSON.parse(out) as { result?: unknown; is_error?: unknown }; return typeof r.result === 'string' && !r.is_error ? r.result : undefined; } catch { return undefined; }
};
export const textAnswer: AskReader = (out, code) => (code === 0 && out.trim() ? out.trim() : undefined);
export const fileAnswer = (file: string): AskReader => (_out, code) => {
  if (code !== 0) return undefined;
  try { const t = readFileSync(file, 'utf8').trim(); return t || undefined; } catch { return undefined; }
};

/** `message` is safe to show the asker; `detail`, when there is one, is for the daemon's log only. */
export class AskError extends Error {
  constructor(message: string, readonly status = 400, readonly detail?: string) { super(message); }
}

/** Run one question: the prompt on stdin, the answer from the JSON result. The whole process group
 *  is stopped at the deadline. Rejects with an AskError whose message is safe to show the asker. */
export function runAsk(argv: string[], cwd: string, env: NodeJS.ProcessEnv, prompt: string, timeoutMs = ASK_TIMEOUT_MS, signal?: AbortSignal, read: AskReader = claudeAnswer): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AskError('the question was withdrawn', 499));
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { if (out.length < 2_000_000) out += d; });
    // Drained, never shown: stderr can carry file paths and message text.
    child.stderr.on('data', () => {});
    const group = (sig: NodeJS.Signals) => { try { process.kill(-child.pid!, sig); } catch { /* gone */ } };
    const stop = () => { group('SIGTERM'); setTimeout(() => group('SIGKILL'), 3000).unref(); };
    const t = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    // The asker gave up (its command was stopped, the daemon shuts down): no copy runs on for nobody.
    let withdrawn = false;
    const onAbort = () => { withdrawn = true; stop(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { clearTimeout(t); reject(new AskError('the CLI did not start', 502, e.message)); });
    child.on('close', (code) => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      if (withdrawn) return reject(new AskError('the question was withdrawn', 499));
      if (timedOut) return reject(new AskError(`no answer within ${Math.round(timeoutMs / 60_000)} minutes`, 504));
      const answer = read(out, code);
      if (answer !== undefined) return resolve(answer);
      reject(new AskError('the CLI gave no answer', 502, `exit ${code}`));
    });
    child.stdin.on('error', () => { /* it ended before reading: its exit says why */ });
    child.stdin.end(prompt);
  });
}
