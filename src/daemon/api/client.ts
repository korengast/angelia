import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
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

/** The owner's token alone, never an agent's: for what only the owner may do (a handoff). */
export function ownerToken(): string {
  const t = readApiToken(join(STATE_DIR, 'api.token'));
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

/** The text of send, turn and ask: `-` reads standard input, and `@file` reads that file, but only
 *  when it is the whole text, one word, and names a file that exists. Anything else is the text as
 *  written, so a message that starts with a WhatsApp tag (`@15551234567 hello`) is sent as it is. */
export function textArg(rest: string[]): string {
  const text = rest.join(' ');
  if (text === '-') return readFileSync(0, 'utf8');
  if (rest.length === 1 && /^@\S+$/.test(text)) {
    const path = text.slice(1);
    let file = false;
    try { file = statSync(path).isFile(); } catch {}
    if (file) return readFileSync(path, 'utf8');
  }
  return text;
}

/** A failure as one short first line: what did not happen and why, never the whole message. */
function failed(what: string, e: unknown): Error {
  const why = String((e as Error)?.message ?? e).split('\n')[0].slice(0, 200);
  return new Error(`${what}: ${why}`);
}

/** `angelia send <platform:chat> <text>` and `angelia turn <platform:chat> <text | - | @file>`: talk to the running daemon. */
export async function localCall(kind: 'send' | 'turn', argv: string[]): Promise<void> {
  const [key, ...rest] = argv;
  const usage = `usage: angelia ${kind} <platform:chat> ${kind === 'send' ? '[--source <label>] ' : ''}<text | - | @file> (@file: the whole text is @ and a path to an existing file)`;
  // `--source` (send only) goes right after the chat or at the very end, so a text may hold the words.
  let source: string | undefined;
  if (kind === 'send' && rest[0] === '--source') source = rest.splice(0, 2)[1] ?? '';
  else if (kind === 'send' && rest.length >= 2 && rest[rest.length - 2] === '--source') source = rest.splice(-2)[1];
  else if (kind === 'send' && rest.at(-1) === '--source') throw new Error(`--source needs a label\n${usage}`);
  if (!key || !rest.length || source === '') throw new Error(usage);
  const what = kind === 'send' ? 'not sent' : 'not queued';
  let text: string;
  try { text = textArg(rest); } catch (e) { throw failed(what, e); }
  try { await apiCall(kind, key, text, source); } catch (e) { throw failed(what, e); }
  console.log(kind === 'send' ? 'sent' : 'queued');
}

/** `angelia ask <platform:chat> <text | - | @file>`: a question another chat's agent answers in a
 *  read-only copy of its session. Returns the answer; waits up to ten minutes. */
export async function askCall(argv: string[]): Promise<string> {
  const [key, ...rest] = argv;
  if (!key || !rest.length) throw new Error('usage: angelia ask <platform:chat> <question | - | @file>');
  let text: string;
  try { text = textArg(rest); } catch (e) { throw failed('not asked', e); }
  const from = process.env.ANGELIA_API_TOKEN ? process.env.ANGELIA_SESSION_KEY : undefined;
  const r = await post('/ask', { token: token(), key, text, ...(from && from !== key ? { from } : {}) });
  return String(r.answer ?? '');
}

/** One send or turn through the running daemon's API. An agent says which chat it is (its session
 *  key), so its token also works toward another profile's chat when the daemon allows that.
 *  `source` (send only): who posted (`job <name>` from a job). */
export async function apiCall(kind: 'send' | 'turn', key: string, text: string, source?: string): Promise<void> {
  const from = process.env.ANGELIA_API_TOKEN ? process.env.ANGELIA_SESSION_KEY : undefined;
  await post(`/${kind}`, { token: token(), key, text, ...(from && from !== key ? { from } : {}), ...(source && kind === 'send' ? { source } : {}) });
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
    else if (a === '--source') flags.source = argv[++n] ?? '';
    else words.push(a);
  }
  const [key, path, ...rest] = words;
  if (!key || !path) throw new Error('usage: angelia send-media <platform:chat> <absolute path> [caption] [--name FILE] [--no-voice] [--source LABEL]');
  if (rest.length && flags.caption === undefined) flags.caption = rest.join(' ');
  await post('/send-media', { token: token(), key, path: resolve(path), ...flags });
  console.log('sent');
}
