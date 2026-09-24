import { Bot, InputFile, type Context } from 'grammy';
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
   *  run for an hour: waiting here would hold every later update behind it, including the owner's
   *  `yes <id>` to that turn's own permission prompt, and `/stop`. The call is synchronous up to its
   *  first await, so the order of messages within a chat is kept. */
  onInbound: (i: Inbound) => Promise<void> | void;
  log?: (line: string) => void;
  /** The bot's own identity, when already known (tests): skips the getMe call handleUpdate needs first. */
  botInfo?: UserFromGetMe;
  /** The Telegram chats in the routing table: only they get the command menu. */
  menuChats?: string[];
}

/** A file download gives up after this long: a stalled one must not hold its chat for good. */
const DOWNLOAD_MS = 60_000;

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
    const me = await this.bot.api.getMe();
    this.username = me.username ?? '';
    const menus = await this.setMenu(this.opts.menuChats ?? []);
    this.log(`telegram: polling as @${this.username}, ${COMMANDS.length} commands in the menu of ${menus} routed chat${menus === 1 ? '' : 's'}`);
    void this.bot.start({ onStart: () => {} });
  }

  async stop(): Promise<void> {
    for (const t of this.typingTimers.values()) clearInterval(t);
    this.typingTimers.clear();
    await this.bot.stop();
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
    ping();
    this.typingTimers.set(chat, setInterval(ping, 4000));
  }
}
