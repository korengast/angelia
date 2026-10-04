import { spawn } from 'node:child_process';
import type { Profile } from '../instance/config/schema.js';

/**
 * A question from another profile, answered in a read-only copy of a chat's session (`angelia ask`).
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

/** `message` is safe to show the asker; `detail`, when there is one, is for the daemon's log only. */
export class AskError extends Error {
  constructor(message: string, readonly status = 400, readonly detail?: string) { super(message); }
}

/** Run one question: the prompt on stdin, the answer from the JSON result. The whole process group
 *  is stopped at the deadline. Rejects with an AskError whose message is safe to show the asker. */
export function runAsk(argv: string[], cwd: string, env: NodeJS.ProcessEnv, prompt: string, timeoutMs = ASK_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
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
      let r: { result?: unknown; is_error?: unknown } | undefined;
      try { r = JSON.parse(out); } catch { /* below */ }
      if (r && typeof r.result === 'string' && !r.is_error) return resolve(r.result);
      reject(new AskError('the CLI gave no answer', 502, r?.is_error ? String(r.result ?? 'an error').slice(0, 200) : `exit ${code}`));
    });
    child.stdin.on('error', () => { /* it ended before reading: its exit says why */ });
    child.stdin.end(prompt);
  });
}
