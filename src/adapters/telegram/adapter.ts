import { Bot, GrammyError, InputFile, type Context } from 'grammy';
import type { BotFullInfo } from 'grammy/types';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import type { Inbound } from '../../core/types.js';
import type { Sender, SendOptions, Sent } from '../../core/orchestrator.js';
import { COMMANDS } from '../../core/commands.js';
import { ext, isOpus, type Media } from '../../core/deliver/media.js';
import { shortId } from '../../core/deliver/text.js';
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
  /** The bot was added to a group: the chat, and the id of the one who added it. */
  onJoined?: (chat: string, by: string[], at?: number) => Promise<void>;
  /** A press on Yes or No under a permission request (Orchestrator.pressed); `id` is the request the
   *  pressed message was sent for, in full (none: a message this adapter put no buttons under since
   *  it started). Gives what to tell the person who pressed, and whether the
   *  request is over. Synchronous, like everything grammY waits on here. Absent: requests go out with
   *  no buttons. */
  onPress?: (i: Pick<Inbound, 'platform' | 'chat' | 'thread' | 'sender' | 'isGroup'>, id: string | undefined, allow: boolean) => { text: string; over: boolean };
  log?: (line: string) => void;
  /** The bot's own identity, when already known (tests): skips the getMe call handleUpdate needs first. */
  botInfo?: BotFullInfo;
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

/** What a request's buttons carry back: the answer and the request's short id (callback_data, 1-64 bytes). */
const PRESS = /^ask:([yn]):([0-9a-z_-]{1,8})$/i;
/** What a send gives back: the message's id, and Telegram's date for it in ms (whole seconds). */
const stamp = (m: { message_id?: number; date?: number }): Sent => ({ ...(m?.message_id !== undefined ? { id: String(m.message_id) } : {}), ...(m?.date ? { at: m.date * 1000 } : {}) });
/** Requests whose buttons are remembered for removal; past it the oldest go (their buttons then stay until pressed). */
const ASKED_MAX = 200;

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
  /** The request whose buttons each message carries, by `<chat>/<message id>`, while it is open. */
  private asked = new Map<string, string>();
  /** Chats with a request line on its way out: its message id is not known yet (asking). */
  private asking = new Map<string, number>();
  /** What kind of chat each one is ('private', 'group', 'supergroup', 'channel'), as Telegram said. */
  private kinds = new Map<string, string>();

  /** What Telegram is doing right now: 'starting', 'polling', 'conflict: ...', 'stopped: ...' or
   *  'error: ...'. `angelia status` shows this and nothing else. */
  get state(): string { return this.current; }

  constructor(private readonly opts: TelegramAdapterOptions) {
    this.bot = new Bot(opts.token, opts.botInfo ? { botInfo: opts.botInfo } : undefined);
    if (opts.botInfo) this.username = opts.botInfo.username ?? '';
    this.log = opts.log ?? (() => {});
    this.bot.on('message', (ctx) => this.onMessage(ctx));
    // callback_query is among the update types polling asks for by default (grammY passes an empty
    // allowed_updates: every type but chat_member and the two reaction ones).
    this.bot.on('callback_query', (ctx) => this.onPress(ctx));
    // my_chat_member is also among the default types: the bot's own membership changed.
    this.bot.on('my_chat_member', (ctx) => this.onMembership(ctx));
    // grammY rethrows anything a handler throws, and an unhandled rejection out of the polling
    // loop takes the whole daemon down - every other chat on every other platform with it.
    this.bot.catch((err) => this.log(`telegram: handler error ${err.message}`));
  }

  async start(): Promise<void> {
    let me: BotFullInfo;
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
  /** The bot went from out of a group to in it: who did it, for an armed profile (connect.ts). */
  private onMembership(ctx: Context): void {
    const u = ctx.myChatMember;
    if (!u || !this.opts.onJoined || (u.chat.type !== 'group' && u.chat.type !== 'supergroup')) return;
    const was = u.old_chat_member.status, now = u.new_chat_member.status;
    if (!(was === 'left' || was === 'kicked') || !(now === 'member' || now === 'administrator')) return;
    void this.opts.onJoined(String(u.chat.id), [String(u.from.id)], u.date * 1000).catch((e: Error) => this.log(`telegram: join handler error ${e.message}`));
  }

  private onMessage(ctx: Context): void {
    const m = ctx.message!;
    const chat = String(m.chat.id);
    if (standIn(m)) { this.log(`telegram: drop chat=${chat} reason=sent-as-channel-or-anonymous-admin`); return; }
    const isGroup = m.chat.type === 'group' || m.chat.type === 'supergroup';
    if (this.kinds.size >= 1000) this.kinds.clear();
    this.kinds.set(chat, m.chat.type);
    const text = m.text ?? m.caption ?? '';
    const me = `@${this.username.toLowerCase()}`;
    // The bot's own @name as written, each time: what a bare "yes" may carry and still be bare.
    const botMentions: string[] = [];
    // A command tapped in a group's menu arrives as /status@bot: that addresses the bot as much as a mention does.
    let mentioned = false;
    for (const e of m.entities ?? m.caption_entities ?? []) {
      const word = text.slice(e.offset, e.offset + e.length);
      if (e.type === 'mention' && word.toLowerCase() === me) { mentioned = true; botMentions.push(word); }
      else if (e.type === 'bot_command' && word.toLowerCase().endsWith(me)) mentioned = true;
    }
    mentioned ||= m.reply_to_message?.from?.id === ctx.me.id;
    // A reply, by the id of the message replied to. In a forum topic every message that is no reply
    // still names the topic's first (service) message there: that is not one. A reply into another
    // chat, or a bare quote, has no message of this chat to name.
    const to = m.reply_to_message && !(m.is_topic_message && (m.reply_to_message.message_id === m.message_thread_id || m.reply_to_message.forum_topic_created)) ? m.reply_to_message : undefined;
    const reply = to ? { id: String(to.message_id), ours: to.from?.id === ctx.me.id } : m.external_reply || m.quote ? { ours: false } : undefined;
    // What a reply quotes: the part the user selected when there is one (Bot API TextQuote; the only text
    // a reply to another chat, external_reply, carries), else the whole message replied to, or its caption.
    const quoted = m.quote?.text || m.reply_to_message?.text || m.reply_to_message?.caption || undefined;
    const head: Omit<Inbound, 'media'> = {
      platform: 'telegram', chat,
      thread: m.message_thread_id !== undefined && m.is_topic_message ? String(m.message_thread_id) : undefined,
      sender: String(m.from?.id ?? ''), senderName: m.from?.first_name,
      text, isGroup, mentioned,
      ...(quoted ? { quoted } : {}),
      ...(reply ? { reply } : {}),
      ...(botMentions.length ? { botMentions } : {}),
      ...(m.date ? { at: m.date * 1000 } : {}),
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
          } else { this.log(`telegram: getFile gave no file_path chat=${chat}`); note('the file sent could not be downloaded'); }
        } catch (e) {
          // Said to the agent too (#35): a file with no caption would otherwise be no turn at all, and one
          // with a caption would be answered as if nothing was attached.
          this.log(`telegram: media download failed chat=${chat}: ${String((e as Error).message ?? e).split(this.opts.token).join('<token>').slice(0, 160)}`);
          note('the file sent could not be downloaded');
        }
      }
      if (!head.text && !media.length) return;
      try { void Promise.resolve(this.opts.onInbound({ ...head, media })).catch(failed); } catch (e) { failed(e); }
    }).catch(failed);
  }

  /**
   * Yes or No pressed under a permission request. A press counts only on a message this adapter put
   * buttons under, and only with the data of one of those two buttons: the request is the one that
   * message was sent for, never one the data names (the data is the client's word; a changed client can
   * send any). The sender is the person who pressed, and whether they may answer is the orchestrator's
   * to say, by the rules of a typed "yes <id>". The callback is always answered, or the person's app
   * shows a spinner on the button.
   */
  private onPress(ctx: Context): void {
    const q = ctx.callbackQuery!, m = q.message;
    const say = (text?: string) => void ctx.answerCallbackQuery(text ? { text: text.slice(0, 200) } : undefined).catch((e) => this.log(`telegram: press not answered: ${this.redact(String((e as Error).message ?? e))}`));
    const hit = PRESS.exec(q.data ?? '');
    if (!hit || !m || !this.opts.onPress) return say();
    const chat = String(m.chat.id), k = `${chat}/${m.message_id}`, id = this.asked.get(k);
    if (STAND_IN_IDS.includes(q.from.id)) { this.log(`telegram: drop press chat=${chat} reason=sent-as-channel-or-anonymous-admin`); return say(); }
    // A request line is on its way out in this chat right now: its message id is not known yet, so
    // this may be a press on it. Nothing is answered and nothing removed.
    if (id === undefined && this.asking.get(chat)) return say();
    if (id !== undefined && hit[2].toLowerCase() !== shortId(id).toLowerCase()) { this.log(`telegram: drop press chat=${chat} reason=not-this-message's-button`); return say(); }
    const thread = 'is_topic_message' in m && m.is_topic_message && m.message_thread_id !== undefined ? String(m.message_thread_id) : undefined;
    let r: { text: string; over: boolean };
    // Everything but a private chat has its owners named in the table: a channel too, where a "group"
    // read of the chat's kind would make every subscriber the owner. With no id (buttons this adapter
    // does not know: a request from before a restart) the orchestrator still says whether the chat is
    // routed and hears this person: a stranger's presses in any other chat get the bare answer and
    // no call to the Bot API beyond it.
    try { r = this.opts.onPress({ platform: 'telegram', chat, thread, sender: String(q.from.id), isGroup: m.chat.type !== 'private' }, id, hit[1].toLowerCase() === 'y'); }
    catch (e) { this.log(`telegram: handler error ${e instanceof Error ? e.message : String(e)}`); return say(); }
    say(r.text);
    // An answer taken here already took the buttons away (askDone). What is left: a request that was
    // over before the press, whose buttons were never removed, and buttons from before a restart.
    if (r.over && (id === undefined || this.asked.delete(k))) this.clearButtons(chat, m.message_id);
  }

  askDone(chat: string, id: string): void {
    for (const [k, asked] of this.asked) {
      if (asked !== id || !k.startsWith(`${chat}/`)) continue;
      this.asked.delete(k);
      this.clearButtons(chat, Number(k.slice(chat.length + 1)));
    }
  }

  /** The text stays; a failure is logged only (the message was deleted, the bot was removed). */
  private clearButtons(chat: string, message: number): void {
    void this.bot.api.editMessageReplyMarkup(chat, message, { reply_markup: { inline_keyboard: [] } })
      .catch((e) => this.log(`telegram: buttons not removed chat=${chat}: ${this.redact(String((e as Error).message ?? e))}`));
  }

  /** May a request in this chat carry buttons? Not in a channel: its subscribers are no members the
   *  table knows, and a request there is answered by id, from a chat with owners. A positive id is a
   *  person; any other chat is asked of Telegram once. Unknown (the call failed): no buttons. */
  private async buttonsIn(chat: string): Promise<boolean> {
    if (!chat.startsWith('-')) return true;
    let kind = this.kinds.get(chat);
    if (kind === undefined) {
      try { kind = (await this.bot.api.getChat(chat)).type; } catch (e) { this.log(`telegram: chat kind not read, request sent without buttons chat=${chat}: ${this.redact(String((e as Error).message ?? e))}`); }
      if (kind) this.kinds.set(chat, kind);
    }
    return kind === 'group' || kind === 'supergroup';
  }

  /** Every message received so far has been handed on (tests, and a clean stop). */
  drained(): Promise<void> { return this.chains.idle(); }

  async chatName(chat: string): Promise<string | undefined> {
    const c = await this.bot.api.getChat(chat);
    return ('title' in c && c.title) || ('first_name' in c && c.first_name) || undefined;
  }

  /** `o.ask`: the text is a permission request's line; Yes and No go under it, each carrying the answer
   *  and the request's short id. The line itself still says how to answer by typing. Returns the
   *  message's id and the time Telegram dates it. */
  async send(chat: string, text: string, thread?: string, o?: SendOptions): Promise<Sent> {
    const topic = thread ? { message_thread_id: Number(thread) } : undefined;
    const id = o?.ask !== undefined && this.opts.onPress && PRESS.test(`ask:y:${shortId(o.ask)}`) && await this.buttonsIn(chat) ? shortId(o.ask).toLowerCase() : undefined;
    if (id === undefined) return stamp(await this.bot.api.sendMessage(chat, text, topic));
    this.asking.set(chat, (this.asking.get(chat) ?? 0) + 1);
    try {
      const sent = await this.bot.api.sendMessage(chat, text, { ...topic, reply_markup: { inline_keyboard: [[{ text: 'Yes', callback_data: `ask:y:${id}` }, { text: 'No', callback_data: `ask:n:${id}` }]] } });
      this.asked.set(`${chat}/${sent.message_id}`, o!.ask!);
      if (this.asked.size > ASKED_MAX) this.asked.delete(this.asked.keys().next().value as string);
      return stamp(sent);
    } finally {
      const n = (this.asking.get(chat) ?? 1) - 1;
      if (n > 0) this.asking.set(chat, n); else this.asking.delete(chat);
    }
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
