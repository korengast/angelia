import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extractMediaTags, MediaError, type MediaRequest } from '../../core/deliver/media.js';

export interface ApiDeps {
  /** Post a line into a chat. `fromKey`: another profile's agent posted it, and the line says so. */
  send(key: string, text: string, fromKey?: string): Promise<void>;
  /** Type a prompt into a chat's session. `fromAgent`: an agent asked, with its own chat's token, so
   *  the prompt is plain text and never a CLI command; otherwise it runs as if an owner had sent it. */
  turn(key: string, text: string, fromAgent: boolean, fromKey?: string): Promise<void>;
  /** Attach a file to a chat. Rejects with a MediaError whose message is safe to show. */
  sendMedia(key: string, req: MediaRequest): Promise<void>;
  /** Is `key` a routed chat? */
  routed(key: string): boolean;
  /** May the agent of chat `from` message chat `to`, another profile's? Undefined: yes; else why not. */
  reach?(from: string, to: string): string | undefined;
}

/**
 * The daemon's API for this machine: `angelia send`, `angelia turn`, `angelia send-media`, job
 * launchers. It listens on a Unix socket in the instance folder (mode 700, the socket itself 600),
 * never on a port: no web page can reach it, and no other user on the Mac can answer in its place
 * while the daemon is down and catch the token the next call sends.
 *
 * Two kinds of token. The owner's (`api.token`, mode 600) works for every routed chat; the terminal
 * and scheduled jobs use it. Each agent gets its own in `ANGELIA_API_TOKEN`, derived from the owner's
 * and its session key. It works for its own chat, and, when the agent names its own chat as `from`,
 * for `send` and `turn` into another profile's chat that `reach` allows (neither profile isolated).
 * A turn from another profile arrives labelled with that profile, never as an owner's message.
 */
export class ApiServer {
  private server?: Server;
  readonly token: string;
  constructor(private readonly d: ApiDeps, token: string) {
    this.token = token;
  }

  listen(socket: string): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res).catch((e) => json(res, { error: (e as Error).message }, 500)));
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(socket, () => { chmodSync(socket, 0o600); resolve(); });
    });
  }

  close(): Promise<void> { return new Promise((r) => this.server?.close(() => r()) ?? r()); }

  /** 'owner', 'chat' (an agent's token, for this key), 'peer' (an agent's token for `from`, asking
   *  into another chat), or null. */
  private who(token: string, key: string, from: string): 'owner' | 'chat' | 'peer' | null {
    if (same(this.token, token)) return 'owner';
    if (key && same(sessionToken(this.token, key), token)) return 'chat';
    if (from && from !== key && same(sessionToken(this.token, from), token)) return 'peer';
    return null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, { ok: true });
    const route = req.method === 'POST' ? url.pathname : '';
    if (route !== '/send' && route !== '/turn' && route !== '/send-media') return json(res, { error: 'not found' }, 404);
    const body = await readJson(req);
    const key = String(body.key ?? '');
    const from = String(body.from ?? '');
    const who = this.who(String(body.token ?? ''), key, from);
    if (!who) return json(res, { error: 'bad token (an agent\'s token works for its own chat, and for another profile\'s only with its own chat as from)' }, 403);
    if (who === 'peer') {
      if (route === '/send-media') return json(res, { error: 'files go only into your own chat; send the other profile a path in a message instead' }, 403);
      if (!this.d.routed(key)) return json(res, { error: 'not a routed chat' }, 404);
      const no = this.d.reach ? this.d.reach(from, key) : 'profiles cannot message each other here';
      if (no) return json(res, { error: no }, 403);
    }
    if (route === '/send-media') {
      const path = String(body.path ?? '');
      if (!key || !path) return json(res, { error: 'key and path required' }, 400);
      if (!this.d.routed(key)) return json(res, { error: 'not a routed chat' }, 404);
      try {
        await this.d.sendMedia(key, { path, caption: body.caption ? String(body.caption) : undefined, voice: body.voice === undefined ? undefined : body.voice !== false, fileName: body.file_name ? String(body.file_name) : undefined });
      } catch (e) {
        if (e instanceof MediaError) return json(res, { error: e.message }, 400);
        throw e;
      }
      return json(res, { ok: true });
    }
    const text = String(body.text ?? '');
    if (!key || !text) return json(res, { error: 'key and text required' }, 400);
    if (!this.d.routed(key)) return json(res, { error: 'not a routed chat' }, 404);
    if (route === '/send') {
      // `MEDIA:<absolute path>` lines are honoured here too, so a script that already writes them
      // can post text and files in one call.
      const { text: rest, media } = who === 'peer' ? { text, media: [] } : extractMediaTags(text);
      if (rest) await this.d.send(key, rest, who === 'peer' ? from : undefined);
      try { for (const item of media) await this.d.sendMedia(key, item); }
      catch (e) { if (e instanceof MediaError) return json(res, { error: e.message }, 400); throw e; }
      return json(res, { ok: true, ...(media.length ? { media: media.length } : {}) });
    }
    void this.d.turn(key, text, who !== 'owner', who === 'peer' ? from : undefined);
    return json(res, { ok: true, queued: true });
  }
}

export { API_SOCKET } from '../../instance/instance.js';

/** The token of one chat's agent: stable across restarts, so a tmux pane that outlives the daemon
 *  keeps a working one, and worthless for any other chat. */
export function sessionToken(owner: string, key: string): string {
  return createHmac('sha256', owner).update(`angelia-session:${key}`).digest('base64url');
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The owner's token: read, or made on the first start. An existing file is put back to mode 600 if
 *  something widened it; `onWiden` hears about it. */
export function loadOrMintToken(path: string, onWiden?: (mode: number) => void): string {
  if (existsSync(path)) {
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) { chmodSync(path, 0o600); onWiden?.(mode); }
    const t = readFileSync(path, 'utf8').trim();
    if (t) return t;
  }
  const t = randomBytes(24).toString('base64url');
  writeFileSync(path, t + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  return t;
}

export function readApiToken(path: string): string | undefined {
  try { return readFileSync(path, 'utf8').trim() || undefined; } catch { return undefined; }
}

/**
 * Clear the way for the socket. A file left by a daemon that died is removed; a socket that answers
 * belongs to a daemon that is still running, and taking it over would cut that one off. The path
 * must fit a socket address (104 bytes on macOS).
 */
export async function claimSocket(path: string): Promise<void> {
  if (Buffer.byteLength(path) > 100) throw new Error(`the API socket path is too long for a socket (${path}); use a shorter ANGELIA_STATE_DIR`);
  if (!existsSync(path)) return;
  const live = await new Promise<boolean>((resolve) => {
    const s = connect(path);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
  if (live) throw new Error(`another daemon answers on ${path}`);
  unlinkSync(path);
}

function json(res: ServerResponse, o: unknown, status = 200): void { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); }

function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > 256 * 1024) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
