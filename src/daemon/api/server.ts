import { AskError } from '../../brain/ask.js';
import { FileError } from '../../instance/profile-files.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extractMediaTags, MediaError, type MediaRequest } from '../../core/deliver/media.js';
import { HandoffError } from '../../core/handoff.js';
import type { AttachFile, HandoffRequest, HandoffResult } from '../../core/orchestrator.js';
import { APP_COMMANDS, type AppCommand } from '../../core/commands.js';
import type { ChatListener } from '../../core/events.js';

export interface ApiDeps {
  /** Post a line into a chat. `fromKey`: another profile's agent posted it, and the line says so. */
  send(key: string, text: string, fromKey?: string): Promise<void>;
  /** Type a prompt into a chat's session. `fromAgent`: an agent asked, with its own chat's token, so
   *  the prompt is plain text and never a CLI command; otherwise it runs as if an owner had sent it. */
  turn(key: string, text: string, fromAgent: boolean, fromKey?: string, surface?: 'app', turnId?: string, media?: string[]): Promise<void>;
  /** Copy files the owner dropped in the app into the chat's inbox; returns the copies. Rejects with a
   *  MediaError whose message is safe to show. */
  attach?(key: string, files: AttachFile[]): Promise<string[]>;
  /** A router command pressed in the app; the answer is for the app. */
  command?(key: string, name: AppCommand): Promise<string>;
  /** Attach a file to a chat. `byOwner`: the owner's token asked; otherwise an agent did, and the file
   *  must be one its profile may read. Rejects with a MediaError whose message is safe to show. */
  sendMedia(key: string, req: MediaRequest, byOwner: boolean): Promise<void>;
  /** Is `key` a routed chat? */
  routed(key: string): boolean;
  /** A question for chat `key`, answered in a read-only copy of its session (`angelia ask`). `fromKey`:
   *  another profile's agent asked. Rejects with an AskError whose message is safe to show. */
  ask?(key: string, text: string, fromKey?: string, signal?: AbortSignal): Promise<string>;
  /** Has the chat as many turns running and waiting as it may? A /turn is then refused with 429. */
  queueFull?(key: string): boolean;
  /** May the agent of chat `from` ask chat `to` (answer_from) or give it a task (accept_from)?
   *  Undefined: yes; else why not. Checked before `reach`. */
  peerAllowed?(kind: 'ask' | 'turn', from: string, to: string): string | undefined;
  /** May the agent of chat `from` message chat `to`, another profile's? Undefined: yes; else why not. */
  reach?(from: string, to: string): string | undefined;
  /** `/angelia-handoff` from a terminal. Rejects with a HandoffError whose message is for the terminal. */
  handoff?(req: HandoffRequest): Promise<HandoffResult>;
  /** The owner's reads, for a client on this machine (a desktop app). Each is optional: a route
   *  whose dep is absent answers 404. */
  events?(fn: ChatListener): () => void;
  answerPermission?(key: string, id: string, allow: boolean): boolean;
  status?(): unknown;
  profiles?(): unknown;
  sessions?(key: string): unknown;
  history?(key: string, session?: string, limit?: number, before?: string): unknown;
  /** The permission requests waiting now, every chat. */
  permissions?(): unknown[];
  /** A profile's jobs and their last runs; undefined for a profile that does not exist. */
  jobs?(profile: string): unknown;
  /** A profile's instruction file, a folder's entries, one file (instance/profile-files.ts); undefined
   *  for a profile that does not exist; a FileError for what the rules refuse. */
  instructions?(profile: string): unknown;
  files?(profile: string, path: string): unknown;
  file?(profile: string, path: string): unknown;
  /** Memory, skills (and one skill's text), capabilities (instance/profile-views.ts), same contract. */
  memory?(profile: string): unknown;
  skills?(profile: string): unknown;
  skill?(profile: string, name: string): unknown;
  capabilities?(profile: string): unknown;
}

/** Owner-only reads, by path. `/events` is a stream and handled on its own. */
const READS = new Set(['/status', '/profiles', '/sessions', '/history', '/events', '/permissions', '/jobs', '/instructions', '/files', '/file', '/memory', '/skills', '/skill', '/capabilities']);
/** The version of the owner's read API (the routes a desktop app uses). A client refuses another. */
export const DESK_API_VERSION = 1;
/** What this daemon adds to version 1, so a client can offer it or say to update. An old daemon
 *  ignores a field it does not know (files sent to it would be dropped without a word). */
export const DESK_FEATURES = ['command', 'files', 'views'] as const;
/** Files one app turn may carry. */
export const TURN_FILES_MAX = 10;
/** Keep-alive comment on an idle event stream, so a client can tell a quiet daemon from a dead one. */
const PING_MS = 15_000;
/** Bytes an event stream may hold for a client that is not reading before it is cut. */
export const STREAM_MAX_BUFFER = 1 << 20;

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
    this.server = createServer((req, res) => void this.handle(req, res).catch((e) => json(res, { error: publicMessage(e) }, 500)));
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(socket, () => { chmodSync(socket, 0o600); resolve(); });
    });
  }

  /** Open event streams are cut, or closing would wait for every client to hang up. */
  close(): Promise<void> {
    return new Promise((r) => { if (!this.server) return r(); this.server.close(() => r()); this.server.closeAllConnections(); });
  }

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
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, { ok: true, api: DESK_API_VERSION, features: DESK_FEATURES });
    if (req.method === 'GET' && READS.has(url.pathname)) return this.read(req, res, url);
    const route = req.method === 'POST' ? url.pathname : '';
    if (route !== '/send' && route !== '/turn' && route !== '/ask' && route !== '/send-media' && route !== '/handoff' && route !== '/permission' && route !== '/command') return json(res, { error: 'not found' }, 404);
    const body = await readJson(req);
    // The header when there is one (a client keeps the token out of bodies and logs); the body
    // field for the clients that predate it.
    const given = bearer(req) ?? String(body.token ?? '');
    if (route === '/permission') {
      // The owner's token only: an agent must never answer its own permission request.
      if (!same(this.token, given)) return json(res, { error: 'bad token: only the owner answers a permission request' }, 403);
      if (!this.d.answerPermission) return json(res, { error: 'not found' }, 404);
      const key = String(body.key ?? ''), id = String(body.id ?? '');
      if (!key || !id || typeof body.allow !== 'boolean') return json(res, { error: 'key, id and allow (true or false) required' }, 400);
      if (!this.d.answerPermission(key, id, body.allow)) return json(res, { error: 'nothing with that id is waiting (answered already, or timed out)' }, 409);
      return json(res, { ok: true });
    }
    if (route === '/command') {
      // The owner's token only: these are an owner's chat commands, pressed in the app.
      if (!same(this.token, given)) return json(res, { error: 'bad token: only the owner sends a command from the app' }, 403);
      if (!this.d.command) return json(res, { error: 'not found' }, 404);
      const key = String(body.key ?? ''), name = String(body.command ?? '');
      if (!(APP_COMMANDS as readonly string[]).includes(name)) return json(res, { error: `command must be one of ${APP_COMMANDS.join(', ')}` }, 400);
      if (!this.d.routed(key)) return json(res, { error: 'not a routed chat' }, 404);
      return json(res, { ok: true, text: await this.d.command(key, name as AppCommand) });
    }
    if (route === '/handoff') {
      // The owner's token only: an agent that could hand a session to a chat could pick any chat.
      if (!same(this.token, given)) return json(res, { error: 'bad token: a handoff runs from a terminal session, with the owner\'s token' }, 403);
      if (!this.d.handoff) return json(res, { error: 'this daemon cannot take a handoff' }, 404);
      const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
      try {
        return json(res, { ok: true, ...(await this.d.handoff({
          cwd: String(body.cwd ?? ''), summary: String(body.summary ?? ''),
          session: str(body.session), brief: str(body.brief), project: str(body.project), chat: str(body.chat),
        })) });
      } catch (e) {
        if (e instanceof HandoffError) return json(res, { error: e.message }, 400);
        throw e;
      }
    }
    const key = String(body.key ?? '');
    const from = String(body.from ?? '');
    const who = this.who(given, key, from);
    if (!who) return json(res, { error: 'bad token (an agent\'s token works for its own chat, and for another profile\'s only with its own chat as from)' }, 403);
    if (who === 'peer') {
      if (route === '/send-media') return json(res, { error: 'files go only into your own chat; send the other profile a path in a message instead' }, 403);
      if (!this.d.routed(key)) return json(res, { error: 'not a routed chat' }, 404);
      // Whether this profile may ask or task that one at all, before the hourly count: a refusal is free.
      const kind = route === '/ask' ? 'ask' : route === '/turn' ? 'turn' : undefined;
      const denied = kind ? (this.d.peerAllowed ? this.d.peerAllowed(kind, from, key) : 'profiles cannot message each other here') : undefined;
      if (denied) return json(res, { error: denied }, 403);
      const no = this.d.reach ? this.d.reach(from, key) : 'profiles cannot message each other here';
      if (no) return json(res, { error: no }, 403);
    }
    if (route === '/send-media') {
      const path = String(body.path ?? '');
      if (!key || !path) return json(res, { error: 'key and path required' }, 400);
      if (!this.d.routed(key)) return json(res, { error: 'not a routed chat' }, 404);
      try {
        await this.d.sendMedia(key, { path, caption: body.caption ? String(body.caption) : undefined, voice: body.voice === undefined ? undefined : body.voice !== false, fileName: body.file_name ? String(body.file_name) : undefined }, who === 'owner');
      } catch (e) {
        if (e instanceof MediaError) return json(res, { error: e.message }, 400);
        throw e;
      }
      return json(res, { ok: true });
    }
    const text = String(body.text ?? '');
    const files = body.files === undefined ? undefined : attachFiles(body.files);
    if (files !== undefined && route !== '/turn') return json(res, { error: 'files go with /turn only' }, 400);
    if (files === null) return json(res, { error: `files must be 1 to ${TURN_FILES_MAX} paths, each a string or { path, from }` }, 400);
    if (!key || (!text && !files)) return json(res, { error: files === undefined ? 'key and text required' : 'key required' }, 400);
    if (!this.d.routed(key)) return json(res, { error: 'not a routed chat' }, 404);
    if (route === '/ask') {
      // A question answered in a read-only copy of the chat's session; the answer is this response.
      if (!this.d.ask) return json(res, { error: 'this daemon cannot answer questions' }, 404);
      if (who === 'chat') return json(res, { error: 'ask another chat; your own session is you' }, 400);
      if (files !== undefined) return json(res, { error: 'files go with /turn only' }, 400);
      // The asker's command stopped waiting: its copy is stopped too.
      const gone = new AbortController();
      res.on('close', () => { if (!res.writableEnded) gone.abort(); });
      try { return json(res, { answer: await this.d.ask(key, text, who === 'peer' ? from : undefined, gone.signal) }); }
      catch (e) { if (e instanceof AskError) return json(res, { error: e.message }, e.status); throw e; }
    }
    if (route === '/send') {
      // `MEDIA:<absolute path>` lines are honoured here too, so a script that already writes them
      // can post text and files in one call.
      const { text: rest, media } = who === 'peer' ? { text, media: [] } : extractMediaTags(text);
      if (rest) await this.d.send(key, rest, who === 'peer' ? from : undefined);
      try { for (const item of media) await this.d.sendMedia(key, item, who === 'owner'); }
      catch (e) { if (e instanceof MediaError) return json(res, { error: e.message }, 400); throw e; }
      return json(res, { ok: true, ...(media.length ? { media: media.length } : {}) });
    }
    // `reply: 'caller'`: the owner typing in a client; the answer comes back as events, not in the chat.
    const app = body.reply === 'caller';
    if (app && who !== 'owner') return json(res, { error: 'reply to the caller is for the owner\'s token only' }, 403);
    // Files only from the owner in the app: an agent hands another profile a path in its message.
    if (files !== undefined && !app) return json(res, { error: 'files go with an app turn only (owner\'s token, reply: caller)' }, 403);
    // Before any file is copied: a refused turn must not leave its files in the inbox.
    if (this.d.queueFull?.(key)) return json(res, { error: 'this chat already has as many messages waiting as it takes; try again after it answers, or /stop it' }, 429);
    let media: string[] = [];
    if (files !== undefined) {
      if (!this.d.attach) return json(res, { error: 'this daemon cannot take files from the app' }, 404);
      try { media = await this.d.attach(key, files); }
      catch (e) { if (e instanceof MediaError) return json(res, { error: e.message }, 400); throw e; }
    }
    // The id the turn's events carry, so a client can tell its turns apart in the stream.
    const turn = randomUUID();
    void this.d.turn(key, text, who !== 'owner', who === 'peer' ? from : undefined, app ? 'app' : undefined, turn, media);
    return json(res, { ok: true, queued: true, turn });
  }

  /** GET with the owner's token in `Authorization: Bearer`. An agent's token reads nothing: a chat's
   *  agent must not read other chats' history, and its own it already has. */
  private async read(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!same(this.token, bearer(req) ?? '')) return json(res, { error: 'bad token: reads take the owner\'s token' }, 403);
    const key = url.searchParams.get('key') ?? '';
    const d = this.d;
    switch (url.pathname) {
      case '/status': return d.status ? json(res, d.status()) : json(res, { error: 'not found' }, 404);
      case '/profiles': return d.profiles ? json(res, d.profiles()) : json(res, { error: 'not found' }, 404);
      case '/permissions': return d.permissions ? json(res, { permissions: d.permissions() }) : json(res, { error: 'not found' }, 404);
      case '/jobs': {
        if (!d.jobs) return json(res, { error: 'not found' }, 404);
        const page = d.jobs(url.searchParams.get('profile') ?? '');
        return page === undefined ? json(res, { error: 'no such profile' }, 404) : json(res, page);
      }
      case '/instructions':
      case '/files':
      case '/file':
      case '/memory':
      case '/skills':
      case '/skill':
      case '/capabilities': {
        const views: Record<string, ((profile: string, arg: string) => unknown) | undefined> = {
          '/instructions': d.instructions, '/files': d.files, '/file': d.file, '/memory': d.memory, '/skills': d.skills, '/skill': d.skill, '/capabilities': d.capabilities,
        };
        const fn = views[url.pathname];
        if (!fn) return json(res, { error: 'not found' }, 404);
        const arg = url.pathname === '/skill' ? url.searchParams.get('name') ?? '' : url.searchParams.get('path') ?? '';
        let page: unknown;
        try { page = fn(url.searchParams.get('profile') ?? '', arg); }
        catch (e) {
          if (e instanceof FileError) return json(res, { error: e.message }, e.status);
          throw e;
        }
        return page === undefined ? json(res, { error: 'no such profile' }, 404) : json(res, page);
      }
      case '/sessions':
        if (!d.sessions) return json(res, { error: 'not found' }, 404);
        if (!d.routed(key)) return json(res, { error: 'not a routed chat' }, 404);
        return json(res, d.sessions(key));
      case '/history': {
        if (!d.history) return json(res, { error: 'not found' }, 404);
        if (!d.routed(key)) return json(res, { error: 'not a routed chat' }, 404);
        const limit = Number(url.searchParams.get('limit') ?? '') || undefined;
        let page: unknown;
        try { page = await d.history(key, url.searchParams.get('session') ?? undefined, limit, url.searchParams.get('before') ?? undefined); }
        catch (e) {
          // A CLI that could not give the history (orchestrator HistoryError): said, not shown as empty.
          const status = typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : 500;
          return json(res, { error: (e as Error).message }, status);
        }
        return page === undefined ? json(res, { error: 'this chat has no session with that id' }, 404) : json(res, page);
      }
      case '/events': {
        if (!d.events) return json(res, { error: 'not found' }, 404);
        if (key && !d.routed(key)) return json(res, { error: 'not a routed chat' }, 404);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(': angelia events\n\n');
        // A client that stops reading is cut off rather than buffered for: it reconnects and reads
        // what it missed from /history.
        const write = (chunk: string) => { if (res.writableLength > STREAM_MAX_BUFFER) res.destroy(); else res.write(chunk); };
        const off = d.events((e) => { if (!key || e.key === key) write(`data: ${JSON.stringify(e)}\n\n`); });
        const ping = setInterval(() => write(': ping\n\n'), PING_MS);
        req.on('close', () => { off(); clearInterval(ping); });
        return;
      }
    }
  }
}

export { API_SOCKET } from '../../instance/instance.js';

/** What a failed request says to its client. A system error (EACCES, ENOENT…) carries a path, and with
 *  it the user's name: a client, possibly a phone, gets a fixed line instead. */
export function publicMessage(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return `a file could not be read (${code})`;
  return (e as Error | undefined)?.message ?? 'internal error';
}

/** The token of one chat's agent: stable across restarts, so a tmux pane that outlives the daemon
 *  keeps a working one, and worthless for any other chat. */
export function sessionToken(owner: string, key: string): string {
  return createHmac('sha256', owner).update(`angelia-session:${key}`).digest('base64url');
}

/** The token in `Authorization: Bearer`, or undefined when the header is absent. */
function bearer(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
}

/** `files` of a /turn: paths, or `{ path, from }` for a copy the app made of a file picked at `from`.
 *  Null when the field is not that. */
function attachFiles(v: unknown): AttachFile[] | null {
  if (!Array.isArray(v) || !v.length || v.length > TURN_FILES_MAX) return null;
  const out: AttachFile[] = [];
  for (const f of v) {
    if (typeof f === 'string' && f) out.push({ path: f });
    else if (f && typeof f === 'object' && typeof f.path === 'string' && f.path && (f.from === undefined || (typeof f.from === 'string' && f.from))) out.push({ path: f.path, ...(f.from !== undefined ? { from: f.from as string } : {}) });
    else return null;
  }
  return out;
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
