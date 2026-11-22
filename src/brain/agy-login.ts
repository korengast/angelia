import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHILD_GROUP, jsonLine, onJsonLines, trackGroup } from './brain.js';
import { endChild } from './grok-history.js';

/** What the owner is told when agy is not signed in: a chat cannot answer agy's own sign-in. */
export const AGY_LOGIN_HINT = 'run `agy` once in a terminal and sign in; then agy answers in the chats';

/**
 * Whether agy is signed in on this Mac: `agy acp` in a scratch --gemini-dir and cwd, `initialize`,
 * then `session/new` (where agy 1.5.14 says "Authentication required" without a login), then
 * stopped. No model is called, and the scratch folder goes. Resolves to undefined when it is signed
 * in, else to why not, in words.
 */
export function agyLoginProblem(bin = 'agy', o: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<string | undefined> {
  const root = mkdtempSync(join(tmpdir(), 'angelia-agy-login-'));
  return new Promise<string | undefined>((resolve) => {
    const child = spawn(bin, ['acp', '--gemini-dir', join(root, 'g')], { cwd: root, env: o.env ?? process.env, stdio: ['pipe', 'pipe', 'ignore'], ...CHILD_GROUP });
    trackGroup(child);
    let done = false;
    const finish = (v: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      endChild(child);
      resolve(v);
    };
    const timer = setTimeout(() => finish(`agy did not answer within ${Math.round((o.timeoutMs ?? 60_000) / 1000)} s`), o.timeoutMs ?? 60_000);
    child.on('error', (e) => finish(`agy did not start: ${e.message}`));
    child.on('exit', () => finish('agy exited before it answered'));
    child.stdin.on('error', () => {});
    const send = (m: unknown) => child.stdin.write(jsonLine(m));
    onJsonLines(child.stdout, (m: Record<string, any>) => {
      if (m.id !== undefined && m.method) { send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unsupported' } }); return; }
      if (m.id === 1) {
        if (m.error) return finish(`agy refused to start: ${String(m.error.message ?? m.error.code)}`);
        send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: root, mcpServers: [] } });
      } else if (m.id === 2) {
        const why = m.error ? String(m.error.message ?? m.error.code) : '';
        finish(!m.error ? undefined : /auth/i.test(why) ? 'agy is not signed in' : `agy refused a session: ${why}`);
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } });
  }).finally(() => setTimeout(() => rmSync(root, { recursive: true, force: true }), 500).unref());
}
