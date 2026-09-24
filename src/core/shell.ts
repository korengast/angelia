import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

export interface ShellOptions { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; maxChars?: number }
export interface ShellResult { code: number | null; signal: string | null; timedOut: boolean; text: string }

const MAX_CHARS = 12_000;

/** Run a script with the user's login shell, capture combined output, cap its size, and format one chat message. */
export function runShell(script: string, o: ShellOptions): Promise<ShellResult> {
  const shell = o.env?.SHELL ?? process.env.SHELL ?? '/bin/zsh';
  const cwd = o.cwd.replace(/^~(?=$|\/)/, homedir());
  return new Promise((resolve) => {
    const child = spawn(shell, ['-lc', script], { cwd, env: o.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const bufs: Buffer[] = [];
    let kept = 0, total = 0;
    const max = o.maxChars ?? MAX_CHARS;
    // Everything is counted; only the first part is kept, enough for `max` characters of any width.
    const grab = (b: Buffer) => { total += b.length; if (kept < max * 4) { bufs.push(b); kept += b.length; } };
    child.stdout.on('data', grab);
    child.stderr.on('data', grab);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid); }, o.timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: null, signal: null, timedOut, text: `sh: ${err.message}` }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, text: format(Buffer.concat(bufs).toString('utf8'), code, signal, timedOut, max, total) });
    });
  });
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

function format(out: string, code: number | null, signal: string | null, timedOut: boolean, max: number, bytes = Buffer.byteLength(out)): string {
  let body = out.replace(/\s+$/, '');
  if (body.length > max) body = body.slice(0, max).replace(/\s+$/, '') + `\n… [truncated, ${bytes} bytes in all]`;
  const tail = timedOut ? 'timed out' : code === 0 ? 'exit 0' : `exit ${code ?? signal ?? '?'}`;
  return body ? `${body}\n[${tail}]` : `(no output)\n[${tail}]`;
}
