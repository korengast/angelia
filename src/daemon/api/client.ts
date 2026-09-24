import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { STATE_DIR } from '../daemon.js';
import { API_SOCKET, readApiToken } from './server.js';

/** The daemon's API socket, in the instance folder. */
export function apiSocket(stateDir = STATE_DIR): string {
  return join(stateDir, API_SOCKET);
}

/** An agent's own token (its environment) first, else the owner's file. The agent's works only
 *  for its own chat. */
function token(): string {
  const t = process.env.ANGELIA_API_TOKEN || readApiToken(join(STATE_DIR, 'api.token'));
  if (!t) throw new Error('no api token: is the daemon running?');
  return t;
}

/** One POST to the running daemon over its socket. Throws with the daemon's own error text. */
export function post(path: string, body: Record<string, unknown>, socket = apiSocket()): Promise<Record<string, unknown>> {
  return new Promise((resolvePost, reject) => {
    const req = request({ socketPath: socket, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        let out: Record<string, unknown> = {};
        try { out = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        if ((res.statusCode ?? 500) >= 400) reject(new Error(String(out.error ?? `http ${res.statusCode}`)));
        else resolvePost(out);
      });
    });
    req.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? new Error(`the daemon is not running (no answer on ${socket})`) : e));
    req.end(JSON.stringify(body));
  });
}

/** `angelia send <platform:chat> <text>` and `angelia turn <platform:chat> <text | - | @file>`: talk to the running daemon. */
export async function localCall(kind: 'send' | 'turn', argv: string[]): Promise<void> {
  const [key, ...rest] = argv;
  if (!key || !rest.length) throw new Error(`usage: angelia ${kind} <platform:chat> <text | - | @file>`);
  let text = rest.join(' ');
  if (text === '-') text = readFileSync(0, 'utf8');
  else if (text.startsWith('@')) text = readFileSync(text.slice(1), 'utf8');
  await apiCall(kind, key, text);
  console.log(kind === 'send' ? 'sent' : 'queued');
}

/** One send or turn through the running daemon's API. An agent says which chat it is (its session
 *  key), so its token also works toward another profile's chat when the daemon allows that. */
export async function apiCall(kind: 'send' | 'turn', key: string, text: string): Promise<void> {
  const from = process.env.ANGELIA_API_TOKEN ? process.env.ANGELIA_SESSION_KEY : undefined;
  await post(`/${kind}`, { token: token(), key, text, ...(from && from !== key ? { from } : {}) });
}

/** `angelia send-media <platform:chat> <absolute path> [caption]`, with `--name` and `--no-voice`. */
export async function sendMediaCall(argv: string[]): Promise<void> {
  const flags: Record<string, string | boolean> = {};
  const words: string[] = [];
  for (let n = 0; n < argv.length; n++) {
    const a = argv[n];
    if (a === '--no-voice') flags.voice = false;
    else if (a === '--name') flags.file_name = argv[++n] ?? '';
    else if (a === '--caption') flags.caption = argv[++n] ?? '';
    else words.push(a);
  }
  const [key, path, ...rest] = words;
  if (!key || !path) throw new Error('usage: angelia send-media <platform:chat> <absolute path> [caption] [--name FILE] [--no-voice]');
  if (rest.length && flags.caption === undefined) flags.caption = rest.join(' ');
  await post('/send-media', { token: token(), key, path: resolve(path), ...flags });
  console.log('sent');
}
