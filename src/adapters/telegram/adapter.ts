import { Bot, GrammyError, InputFile, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import type { Inbound } from '../../core/types.js';
import type { Sender } from '../../core/orchestrator.js';
import { COMMANDS } from '../../core/commands.js';
import { ext, isOpus, type Media } from '../../core/deliver/media.js';
import { asVoice } from '../../voice/opus.js';
import { ChatChains, MAX_INBOUND, SenderQuota, saveInbound } from '../inbox.js';

export interface TelegramAdapterOptions {
  token: string;
  /** Profile cwd for a message that would pass routing and gating, else undefined: nothing is downloaded for anyone else. */
  inboxFor: (i: Omit<Inbound, 'media'>) => string | undefined;
  /** Called once per message and never awaited. grammY handles updates one at a time, and a turn can
   *  run for hours: waiting here would hold every later update behind it, including the owner's
   *  `yes <id>` to that turn's own permission prompt, and `/stop`. The call is synchronous up to its
   *  first await, so the order of messages within a chat is kept. */
  onInbound: (i: Inbound) => Promise<void> | void;
  log?: (line: string) => void;
  /** The bot's own identity, when already known (tests): skips the getMe call handleUpdate needs first. */
  botInfo?: UserFromGetMe;
  /** The Telegram chats in the routing table: only they get the command menu. */
  menuChats?: string[];
  /** The pause before polling is tried again (tests pass their own). It must end when `signal` aborts. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The clock that says how long polling has held (tests pass their own). */
  now?: () => number;
}

/** A file download gives up after this long: a stalled one must not hold its chat for good. */
const DOWNLOAD_MS = 60_000;

/** Polling that failed is tried again after 5 s, then twice as long each time, never more than a minute. */
const RETRY_FIRST_MS = 5_000;
const RETRY_MAX_MS = 60_000;
/** Pauses start again from 5 s only after polling has held this long. Two pollers on one token
 *  each get a getUpdates answered between the other's retries; a reset on every answer would keep
 *  them trading the token every 5 s for good. */
const STABLE_MS = 5 * 60_000;
export const CONFLICT = 'conflict: another process is polling this bot token; retrying';
export const REVOKED = 'stopped: the bot token was rejected (401). Put the new token in ~/.angelia/env and /restart';

/** A timer that does not keep the process alive, and ends early when the adapter stops. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const end = () => { clearTimeout(t); signal.removeEventListener('abort', end); done(); };
    const t = setTimeout(end, ms);
    t.unref();
    signal.addEventListener('abort', end, { once: true });
  });
}

/**
 * Telegram's stand-ins for people it hides: an anonymous group admin (GroupAnonymousBot), a post made
 * "as a channel" (Channel_Bot), and a linked channel's post (777000). Each id stands for many senders,
 * and such a message also carries `sender_chat`. As an owner or in allow_from, one of them would admit
 * everyone behind it, so these messages are dropped.
 */
export const STAND_IN_IDS = [1087968824, 136817688, 777000];
export function standIn(m: { sender_chat?: unknown; from?: { id: number } }): boolean {
  return !!m.sender_chat || (m.from !== undefined && STAND_IN_IDS.includes(m.from.id));
}

export class TelegramAdapter implements Sender {
  readonly bot: Bot;
  private username = '';
  private typingTimers = new Map<string, NodeJS.Timeout>();
  private log: (line: string) => void;
  private chains = new ChatChains();
  private quota = new SenderQuota();
  private current = 'starting';
  private stopping = false;
  private halt = new AbortController();
  private retryMs = RETRY_FIRST_MS;
  private pollingSince: number | undefined;
  private loop: Promise<void> = Promise.resolve();

  /** What Telegram is doing right now: 'starting', 'polling', 'conflict: ...', 'stopped: ...' or
   *  'error: ...'. `angelia status` shows this and nothing else. */
  get state(): string { return this.current; }

  constructor(private readonly opts: TelegramAdapterOptions) {
    this.bot = new Bot(opts.token, opts.botInfo ? { botInfo: opts.botInfo } : undefined);
    if (opts.botInfo) this.username = opts.botInfo.username;
    this.log = opts.log ?? (() => {});
    this.bot.on('message', (ctx) => this.onMessage(ctx));
    // grammY rethrows anything a handler throws, and an unhandled rejection out of the polling
    // loop takes the whole daemon down - every other chat on every other platform with it.
    this.bot.catch((err) => this.log(`telegram: handler error ${err.message}`));
  }

  async start(): Promise<void> {
    let me: UserFromGetMe;
    try { me = await this.bot.api.getMe(); }
    catch (e) {
      // A token Telegram refuses at boot would otherwise end the daemon before WhatsApp even starts:
      // 401 when revoked, 404 when it is not a token at all. A network error still throws, as before.
      if (e instanceof GrammyError && e.error_code === 401) { this.become(REVOKED); return; }
      // A 429 is a rate limit, not a refused token: it throws as before.
      if (e instanceof GrammyError && e.error_code >= 400 && e.error_code < 500 && e.error_code !== 429) {
        this.become(`stopped: Telegram refused the bot token (${e.error_code}: ${this.redact(e.description)}). Check it in ~/.angelia/env and /restart`);
        return;
      }
      throw e;
    }
    this.username = me.username ?? '';
    const menus = await this.setMenu(this.opts.menuChats ?? []);
    this.log(`telegram: polling as @${this.username}, ${COMMANDS.length} commands in the menu of ${menus} routed chat${menus === 1 ? '' : 's'}`);
    // Installed here, after anything the tests put in front of the Bot API, so it sees every answer.
    this.bot.api.config.use(async (prev, method, payload, signal) => {
      const res = await prev(method, payload, signal);
      if (method === 'getUpdates' && res.ok && !this.stopping) this.confirmed();
      return res;
    });
    this.loop = this.poll();
  }

  /**
   * grammY's bot.start() resolves only when polling stops, and rejects on a 401 or 409 (every other
   * failure it retries by itself). Left alone, that rejection was one log line, and the status kept
   * saying polling while nothing arrived. So the rejection is caught here: 401 stops for good, since
   * only a new token helps; anything else is tried again with a growing pause.
   */
  private async poll(): Promise<void> {
    while (!this.stopping) {
      try {
        // onStart comes before the first getUpdates, and a 409 comes after it. On a retry only an
        // answered getUpdates says polling works again, or each retry would log a false recovery.
        await this.bot.start({ onStart: () => { if (this.current === 'starting') { this.current = 'polling'; this.pollingSince = this.now(); } } });
        if (!this.stopping) this.become('stopped: polling ended by itself');
        return;
      } catch (e) {
        if (this.stopping) return;
        if (e instanceof GrammyError && e.error_code === 401) { this.become(REVOKED); return; }
        if (e instanceof GrammyError && e.error_code === 409) this.become(CONFLICT);
        else this.become(`error: ${this.redact(String((e as Error)?.message ?? e))}; retrying`);
      }
      if (this.pollingSince !== undefined && this.now() - this.pollingSince >= STABLE_MS) this.retryMs = RETRY_FIRST_MS;
      this.pollingSince = undefined;
      const ms = this.retryMs;
      this.retryMs = Math.min(ms * 2, RETRY_MAX_MS);
      await (this.opts.wait ?? pause)(ms, this.halt.signal);
    }
  }

  /** A getUpdates came back: polling works. */
  private confirmed(): void {
    if (this.current === 'polling') return;
    const again = this.current !== 'starting';
    this.current = 'polling';
    this.pollingSince = this.now();
    if (again) this.log('telegram: polling again');
  }

  private now(): number { return (this.opts.now ?? Date.now)(); }

  private redact(text: string): string { return text.split(this.opts.token).join('<token>').slice(0, 160); }

  /** One log line per change of state, not one per retry. */
  private become(state: string): void {
    if (state === this.current) return;
    this.current = state;
    this.log(`telegram: ${state}`);
  }

  /** The polling loop has ended (tests). */
  polled(): Promise<void> { return this.loop; }

  async stop(): Promise<void> {
    // First: polling ends because of this, and that end must not be read as a failure.
    this.stopping = true;
    this.halt.abort();
    for (const t of this.typingTimers.values()) clearInterval(t);
    this.typingTimers.clear();
    await this.bot.stop();
    this.current = 'stopped';
  }

  /**
   * The command menu in each routed chat only. A menu for everyone would show "/sh — run a shell
   * command" to anyone who opens the bot. The menu of a chat taken out of the table stays until
   * Telegram drops it; its commands are ignored there like any other message. Returns how many
   * chats got it.
   */
  async setMenu(chats: string[]): Promise<number> {
    const commands = COMMANDS.map((c) => ({ command: c.command, description: c.description }));
    try { await this.bot.api.deleteMyCommands(); } catch (e) { this.log(`telegram: could not clear the global menu: ${(e as Error).message}`); }
    let set = 0;
    for (const chat of new Set(chats)) {
      try { await this.bot.api.setMyCommands(commands, { scope: { type: 'chat', chat_id: Number(chat) } }); set++; }
      catch (e) { this.log(`telegram: no menu for chat=${chat}: ${(e as Error).message}`); }
    }
    return set;
  }

  /**
   * Returns before any download: grammY hands updates over one at a time, so a slow file here would
   * hold every Telegram chat, `/stop` and `yes <id>` included. The download and the hand-over run on
   * the chat's own chain instead, so a text still arrives after the photo it follows.
   */
  private onMessage(ctx: Context): void {
    const m = ctx.message!;
    const chat = String(m.chat.id);
    if (standIn(m)) { this.log(`telegram: drop chat=${chat} reason=sent-as-channel-or-anonymous-admin`); return; }
    const isGroup = m.chat.type === 'group' || m.chat.type === 'supergroup';
    const text = m.text ?? m.caption ?? '';
    const me = `@${this.username.toLowerCase()}`;
    // A command tapped in a group's menu arrives as /status@bot: that addresses the bot as much as a mention does.
    const mentioned =
      (m.entities ?? m.caption_entities ?? []).some((e) => {
        const word = text.slice(e.offset, e.offset + e.length).toLowerCase();
        return (e.type === 'mention' && word === me) || (e.type === 'bot_command' && word.endsWith(me));
      }) ||
      m.reply_to_message?.from?.id === ctx.me.id;
    const head: Omit<Inbound, 'media'> = {
      platform: 'telegram', chat,
      thread: m.message_thread_id !== undefined && m.is_topic_message ? String(m.message_thread_id) : undefined,
      sender: String(m.from?.id ?? ''), senderName: m.from?.first_name,
      text, isGroup, mentioned,
    };
    const inbox = this.opts.inboxFor(head);
    const file = inbox ? m.document ?? m.photo?.at(-1) ?? m.voice ?? m.audio ?? m.video : undefined;
    const note = (why: string) => { head.text = `${head.text}${head.text ? '\n' : ''}[${why}]`; };
    let fetchIt = false;
    // The Bot API serves files up to 20 MB. A file not fetched is said to the agent, as WhatsApp does, so
    // it can tell the sender instead of answering as if nothing came.
    if (file && (file.file_size ?? 0) > MAX_INBOUND) { this.log(`telegram: file over ${MAX_INBOUND >> 20} MB not downloaded chat=${chat}`); note(`a file over ${MAX_INBOUND >> 20} MB was sent and not downloaded`); }
    else if (file && !this.quota.take(head.sender)) { this.log(`telegram: file not downloaded chat=${chat} reason=sender-hourly-limit`); note('a file was sent and not downloaded: too many files from this sender this hour'); }
    else if (file) fetchIt = true;
    const failed = (e: unknown) => this.log(`telegram: handler error ${e instanceof Error ? e.message : String(e)}`);
    void this.chains.run(chat, async () => {
      const media: string[] = [];
      if (fetchIt && file && inbox) {
        try {
          const f = await ctx.api.getFile(file.file_id);
          if (f.file_path) {
            const res = await fetch(`https://api.telegram.org/file/bot${this.opts.token}/${f.file_path}`, { signal: AbortSignal.timeout(DOWNLOAD_MS) });
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
            const dest = await saveInbound(inbox, extname(f.file_path), Readable.fromWeb(res.body as any));
            if (dest) media.push(dest); else note(`a file over ${MAX_INBOUND >> 20} MB was sent and not downloaded`);
          }
        } catch (e) {
          this.log(`telegram: media download failed chat=${chat}: ${String((e as Error).message ?? e).split(this.opts.token).join('<token>').slice(0, 160)}`);
        }
      }
      if (!head.text && !media.length) return;
      try { void Promise.resolve(this.opts.onInbound({ ...head, media })).catch(failed); } catch (e) { failed(e); }
    }).catch(failed);
  }

  /** Every message received so far has been handed on (tests, and a clean stop). */
  drained(): Promise<void> { return this.chains.idle(); }

  async chatName(chat: string): Promise<string | undefined> {
    const c = await this.bot.api.getChat(chat);
    return ('title' in c && c.title) || ('first_name' in c && c.first_name) || undefined;
  }

  async send(chat: string, text: string, thread?: string): Promise<void> {
    await this.bot.api.sendMessage(chat, text, thread ? { message_thread_id: Number(thread) } : undefined);
  }

  /**
   * Attach a file. The Bot API is picky: sendVoice takes ogg/opus only, sendAudio mp3/m4a only,
   * sendPhoto rejects anything it does not consider an image. Everything else goes as a document,
   * which always works and still shows a preview for known types.
   */
  async sendMedia(chat: string, m: Media, thread?: string): Promise<void> {
    const opts = { ...(m.caption ? { caption: m.caption } : {}), ...(thread ? { message_thread_id: Number(thread) } : {}) };
    if (m.kind === 'image' && ext(m.path) !== 'webp') { await this.bot.api.sendPhoto(chat, new InputFile(m.path), opts); return; }
    if (m.kind === 'video') { await this.bot.api.sendVideo(chat, new InputFile(m.path), opts); return; }
    if (m.kind === 'audio') {
      if (m.voice !== false) {
        const v = await asVoice(m.path);
        try { if (isOpus(v.path)) { await this.bot.api.sendVoice(chat, new InputFile(v.path), opts); return; } } finally { v.cleanup(); }
      }
      if (['mp3', 'm4a'].includes(ext(m.path))) { await this.bot.api.sendAudio(chat, new InputFile(m.path), opts); return; }
    }
    await this.bot.api.sendDocument(chat, new InputFile(m.path, m.fileName), opts);
  }

  async typing(chat: string, on: boolean): Promise<void> {
    const t = this.typingTimers.get(chat);
    if (t) { clearInterval(t); this.typingTimers.delete(chat); }
    if (!on) return;
    const ping = () => this.bot.api.sendChatAction(chat, 'typing').catch(() => {});
    void ping();
    this.typingTimers.set(chat, setInterval(() => void ping(), 4000));
  }
}
