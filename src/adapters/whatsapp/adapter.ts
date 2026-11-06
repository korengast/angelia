import { mkdirSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import pino from 'pino';
import { ChatChains, MAX_INBOUND, SenderQuota, saveInbound } from '../inbox.js';
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage, DisconnectReason, type AnyMessageContent, type WASocket } from 'baileys';
import qrcode from 'qrcode-terminal';
import type { Inbound } from '../../core/types.js';
import type { Sender } from '../../core/orchestrator.js';
import { LidMap, normalizeJid } from './ids.js';
import { parseMessage, SeenIds, type WaMessageLike } from './parse.js';
import { SentMessages } from './sent.js';
import { isOpus, type Media } from '../../core/deliver/media.js';
import { asVoice } from '../../voice/opus.js';

export interface WhatsAppAdapterOptions {
  authDir: string;
  pairing: 'code' | 'qr';
  /** E.164 digits, needed for pairing by code. */
  phone?: string;
  /** Profile cwd for a message that would pass routing and gating, else undefined: nothing is downloaded for anyone else. */
  inboxFor: (i: Omit<Inbound, 'media'>) => string | undefined;
  onInbound: (i: Inbound) => Promise<void>;
  log?: (line: string) => void;
  /** Pairing only: exit once the socket is open and credentials are saved. */
  pairOnly?: boolean;
  /** Lines meant for the terminal (pairing code, QR). Defaults to stdout. */
  say?: (line: string) => void;
  /** Baileys' socket maker, unless given (tests pass a fake: no network, no pairing). */
  makeSocket?: typeof makeWASocket;
  /** The clock and the pace of the not-connected check (tests pass a fake clock and a short pace). */
  now?: () => number;
  watchEveryMs?: number;
}

const MAX_MEDIA = MAX_INBOUND;
/** How a note to the agent names a kind of file: "a photo", "a voice note", never "a image". */
const KIND_NAME: Record<string, string> = { image: 'photo', audio: 'voice note', video: 'video', document: 'document', sticker: 'sticker' };
/** Paired and not connected for this long, the adapter says 'dead' (see check()). Baileys' own keepalive turns a
 *  dead socket into a close within about a minute, and a reconnect takes seconds, so five minutes is never a
 *  working session. */
const DEAD_MS = 5 * 60_000;
const WATCH_EVERY_MS = 30_000;
const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4', 'audio/ogg; codecs=opus': '.ogg', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'application/pdf': '.pdf' };

/**
 * WhatsApp as a linked device (Baileys, in-process). One socket per daemon. Pairing by code
 * printed to the terminal, QR as fallback. Reconnects on every close except a logout.
 * Learnings baked in from an earlier bridge: a device that cannot decrypt what we sent asks again,
 * and only `getMessage` can answer after a reconnect; our own echoes come back as fromMe; people
 * appear as `@lid` as often as by phone.
 */
export class WhatsAppAdapter extends EventEmitter implements Sender {
  private sock?: WASocket;
  private state: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  private stopping = false;
  private lids: LidMap;
  private typingTimers = new Map<string, NodeJS.Timeout>();
  private log: (line: string) => void;
  private say: (line: string) => void;
  private backoffMs = 3000;
  private reconnect?: NodeJS.Timeout;
  private lastBackoffNotice = 0;
  /** A field, not made in open(): what we sent must outlive a reconnect, when a retry needs it most. */
  private sent = new SentMessages();
  private now: () => number;
  private watch?: NodeJS.Timeout;
  /** When the connection last opened or closed, or the check last acted: it counts from here. */
  private since = -1;
  /** The check has opened again once already: the next window says 'dead'. Cleared by an open. */
  private reopened = false;
  /** Set by a 440 close, cleared by the next attempt: another client holds the session, and a fresh process
   *  would only trade 440s with it faster. */
  private conflict = false;

  constructor(private readonly opts: WhatsAppAdapterOptions) {
    super();
    this.log = opts.log ?? (() => {});
    this.say = opts.say ?? ((l) => console.log(l));
    this.now = opts.now ?? Date.now;
    this.lids = new LidMap(opts.authDir);
  }

  get connected(): boolean { return this.state === 'connected'; }

  async start(): Promise<void> {
    mkdirSync(this.opts.authDir, { recursive: true, mode: 0o700 });
    // Before open(), and counting from the first start only: a first open that throws is started again
    // by the daemon (30 s, then doubling), and a start that keeps throwing after open() read the
    // credentials (`registered` set: the check is silent before that) reaches the dead path after
    // DEAD_MS twice, like any other failure; a count reset at each retry would race the check's tick.
    // One timer however often start() is called; unref'd, so it never holds a process open.
    if (this.since < 0) this.since = this.now();
    clearInterval(this.watch);
    this.watch = setInterval(() => this.check(), this.opts.watchEveryMs ?? WATCH_EVERY_MS);
    this.watch.unref();
    await this.open();
  }

  /**
   * Every close reconnects, and Baileys' keepalive turns a dead socket into a close, so a session that
   * once worked comes back by itself; during a WhatsApp outage Baileys closes every 20-40 s, each close
   * resets the count, and this check never fires there, by design. What it catches is a socket that
   * neither opens nor closes: open() throwing or hanging in the auth state or the socket maker, a socket
   * that never says open, a reopen that fails. The adapter would sit as 'connecting' in status for good,
   * with nothing in the log. Paired and not connected for DEAD_MS, it first does in this process what a
   * fresh one would: ends the socket and opens again. A second DEAD_MS with no open and no close, and it
   * says 'dead': under launchd the daemon exits non-zero for a fresh process; started by hand it logs
   * that a restart is needed, and the reopen here goes on every DEAD_MS. Not while pairing (the owner is
   * typing a code), after a logout (pairing again is the fix), while stopping, or during a 440 backoff.
   */
  private check(): void {
    // The clock first, every tick: a test counts its calls to see the timer end with stop().
    const idle = this.now() - this.since;
    if (this.connected || this.stopping || this.conflict || !this.registered || this.opts.pairOnly || idle < DEAD_MS) return;
    this.since = this.now();
    if (this.reopened) { this.log('whatsapp: still not connected after opening again; a fresh process is needed'); this.emit('dead'); }
    else this.log(`whatsapp: not connected for ${DEAD_MS / 60_000} min; ending the socket and opening again`);
    this.reopened = true;
    const sock = this.sock;
    this.sock = undefined;
    this.retire(sock);
    this.reopenIn(0);
  }

  private async open(): Promise<void> {
    if (this.stopping) return;
    this.state = 'connecting';
    // The attempt a 440 backoff waited for gets its own DEAD_MS: the backoff itself may have been 30 min.
    if (this.conflict) { this.conflict = false; this.since = this.now(); }
    const { state, saveCreds } = await useMultiFileAuthState(this.opts.authDir);
    // A QR link sets `me` and never `registered`; a code link sets both. Known before the socket is made,
    // so a socket maker that throws leaves the not-connected check armed.
    this.registered = !!(state.creds.registered || state.creds.me);
    // Checked before any socket exists: a setup that cannot pair would otherwise leave a socket and
    // its reconnects behind at every retry of the start.
    if (!(state.creds.registered || state.creds.me) && this.opts.pairing === 'code' && !(this.opts.phone ?? '').replace(/\D/g, '')) throw new Error('whatsapp: pairing by code needs whatsapp.phone in routing.yaml (E.164, e.g. +15551234567)');
    const version = await this.waVersion();
    // ANGELIA_WA_DEBUG=<file>: full Baileys debug log to that file (pairing diagnostics). Never on by default: it contains message payloads.
    const debugFile = process.env.ANGELIA_WA_DEBUG;
    const logger = debugFile ? pino({ level: 'trace' }, pino.destination({ dest: debugFile, sync: true })) : pino({ level: 'silent' });
    const sock = (this.opts.makeSocket ?? makeWASocket)({
      ...(version ? { version } : {}),
      auth: state,
      logger,
      // Pairing by code is known to fail with some browser descriptors; a Chrome desktop identity works.
      browser: ['Angelia', 'Chrome', '120.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      // A retry receipt resends whatever this returns, so a blank stand-in arrives as an empty bubble.
      // Baileys' own cache answers first, but only for 5 minutes and it is cleared when the socket
      // ends. Unknown ids get undefined: Baileys then resends nothing, which is the honest outcome.
      getMessage: async (key) => this.sent.get(key.id),
    });
    // The socket this one replaces (the check() path ends one that never opened) is done with: a late
    // close from it would start a second socket beside this one, and a late save would write its credentials.
    const old = this.sock;
    this.sock = sock;
    this.retire(old);
    sock.ev.on('creds.update', () => { if (sock !== this.sock) return; void saveCreds(); this.lids.reload(); });
    sock.ev.on('connection.update', (u) => { if (sock === this.sock) void this.onConnection(u as Record<string, any>, sock); });
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      for (const m of messages) void this.onMessage(m as unknown as WaMessageLike).catch((e) => this.log(`whatsapp: message error ${(e as Error).message}`));
    });
    if (!this.registered && this.opts.pairing === 'qr') this.say('Scan the QR below with WhatsApp > Linked devices > Link a device.');
  }

  private version?: Promise<[number, number, number] | undefined>;

  /** The WhatsApp Web version to announce: asked once per daemon, for five seconds at most. Without an
   *  answer Baileys uses the one it ships with. A reconnect never waits on it again. */
  private waVersion(): Promise<[number, number, number] | undefined> {
    this.version ??= Promise.race([
      fetchLatestBaileysVersion().then((r) => r.version as [number, number, number]).catch(() => undefined),
      sleep(5000, undefined, { ref: false }),
    ]);
    return this.version;
  }

  private registered = false;
  private wipes = 0;
  private codeRequested = false;

  /** Ask for a pairing code once the server has opened the pairing window (the first `qr` update). */
  private async requestCode(sock: WASocket): Promise<void> {
    if (this.codeRequested) return;
    this.codeRequested = true;
    const phone = (this.opts.phone ?? '').replace(/\D/g, '');
    try {
      const code = await sock.requestPairingCode(phone);
      this.say(`WhatsApp pairing code: ${code.match(/.{1,4}/g)?.join('-') ?? code}`);
      this.say('On the phone: WhatsApp > Linked devices > Link a device > Link with phone number instead. The code is valid for about a minute.');
    } catch (e) {
      this.say(`pairing code request failed: ${(e as Error).message}`);
      this.say('WhatsApp has been rejecting pairing codes from third-party clients. Set `pairing: qr` and run `angelia pair` again.');
      this.emit('code-failed');
    }
  }

  private async onConnection(u: Record<string, any>, sock: WASocket): Promise<void> {
    if (u.qr && !this.registered) {
      if (this.opts.pairing === 'qr') { this.emit('qr', String(u.qr)); qrcode.generate(u.qr, { small: true }, (s: string) => this.say(s)); }
      else void this.requestCode(sock);
    }
    if (u.isNewLogin) { this.say('Phone accepted the link. Finishing…'); this.emit('scanned'); }
    if (u.connection === 'open') {
      this.state = 'connected';
      this.registered = true;
      this.backoffMs = 3000;
      this.since = this.now();
      this.conflict = false;
      this.reopened = false;
      const me = normalizeJid(sock.user?.id);
      this.log(`whatsapp: connected as ${me ? me.slice(0, 4) + '…' : '?'}`);
      this.emit('open');
      if (this.opts.pairOnly) { this.say('Paired. Credentials saved.'); setTimeout(() => this.emit('paired'), 2000); }
      return;
    }
    if (u.connection === 'close') {
      this.state = 'disconnected';
      this.since = this.now();
      this.emit('close');
      const code: number | undefined = u.lastDisconnect?.error?.output?.statusCode;
      this.conflict = code === DisconnectReason.connectionReplaced;
      const why: string = u.lastDisconnect?.error?.message ?? '';
      this.codeRequested = false; // a reconnect opens a new pairing window; a new code is requested if still unpaired
      if (this.stopping) return;
      if (why) this.log(`whatsapp: close reason=${why.slice(0, 120)}`);
      // A half-finished link leaves credentials the server no longer knows: while pairing, start clean instead of giving up.
      if (code === DisconnectReason.loggedOut && this.opts.pairOnly && this.wipes < 2) {
        this.wipes++;
        this.log('whatsapp: stale credentials from an unfinished link; starting clean');
        rmSync(this.opts.authDir, { recursive: true, force: true });
        mkdirSync(this.opts.authDir, { recursive: true, mode: 0o700 });
        this.emit('restart');
        this.reopenIn(1000);
        return;
      }
      // Logged out, nothing reconnects, and a fresh process would not be paired either: the check ends too.
      if (code === DisconnectReason.loggedOut) { clearInterval(this.watch); this.log('whatsapp: logged out; delete the auth dir and pair again'); this.emit('logged-out'); return; }
      let delay = this.backoffMs;
      if (code === DisconnectReason.restartRequired) delay = 1000;
      else if (code === DisconnectReason.connectionReplaced) { delay = Math.min(this.backoffMs * 2, 30 * 60_000); this.backoffMs = delay; if (Date.now() - this.lastBackoffNotice > 6 * 3600_000) { this.lastBackoffNotice = Date.now(); this.log('whatsapp: conflict (440): another client holds this session; backing off'); } }
      else { this.backoffMs = Math.min(this.backoffMs * 2, 30_000); delay = this.backoffMs; }
      this.log(`whatsapp: closed code=${code ?? '?'} reconnect_in=${delay}ms`);
      this.reopenIn(delay);
    }
  }

  /** One pending reopen at a time: the check() path and a close must not each start a socket. */
  private reopenIn(ms: number): void {
    clearTimeout(this.reconnect);
    this.reconnect = setTimeout(() => void this.open().catch((e) => this.log(`whatsapp: reopen failed ${(e as Error).message}`)), ms);
  }

  /** End a socket we are done with. end() is async: a rejection would escape the try and become an unhandled one. */
  private retire(sock: WASocket | undefined): void {
    try { sock?.end(undefined)?.catch(() => {}); } catch { /* already closed */ }
  }

  private ourIds(): string[] {
    const u = this.sock?.user as { id?: string; lid?: string } | undefined;
    return [normalizeJid(u?.id), normalizeJid(u?.lid)].filter(Boolean);
  }

  private seen = new SeenIds();
  private chains = new ChatChains();
  private quota = new SenderQuota();

  private async onMessage(m: WaMessageLike): Promise<void> {
    const p = parseMessage(m, this.ourIds());
    if (!p) return;
    // Checked before any await: two deliveries of one message arriving together must not both pass.
    if (m.key.id && !this.seen.first(`${p.chat}/${m.key.id}`)) return;
    const senderId = this.lids.phoneFor(p.sender);
    const head: Omit<Inbound, 'media'> = { platform: 'whatsapp', chat: p.chat, sender: senderId, senderName: p.senderName, text: p.text, isGroup: p.isGroup, mentioned: p.mentioned };
    const inbox = this.opts.inboxFor(head);
    const note = (why: string) => { head.text = `${head.text}${head.text ? '\n' : ''}[${why}]`; };
    let fetchIt = false;
    // The declared size is checked before a byte is fetched, as Telegram does; the download itself is
    // capped too, since the declaration is the sender's word. A file not fetched is said to the agent,
    // so it can tell the sender instead of answering as if nothing came.
    if (inbox && p.media && p.media.kind !== 'sticker') {
      if ((p.media.size ?? 0) > MAX_MEDIA) { this.log(`whatsapp: media over ${MAX_MEDIA >> 20} MB not downloaded chat=${p.chat.slice(0, 8)}…`); note(`a ${KIND_NAME[p.media.kind] ?? p.media.kind} over ${MAX_MEDIA >> 20} MB was sent and not downloaded`); }
      else if (!this.quota.take(senderId)) { this.log(`whatsapp: media not downloaded chat=${p.chat.slice(0, 8)}… reason=sender-hourly-limit`); note(`a ${p.media.kind} was sent and not downloaded: too many files from this sender this hour`); }
      else fetchIt = true;
    }
    // In order within the chat (a text after a photo arrives after it), side by side across chats.
    await this.chains.run(p.chat, async () => {
      const media: string[] = [];
      if (fetchIt && inbox && p.media) {
        try {
          const stream = (await downloadMediaMessage(m as never, 'stream', {}, { logger: pino({ level: 'silent' }), reuploadRequest: this.sock!.updateMediaMessage })) as AsyncIterable<Buffer>;
          const ext = p.media.fileName?.match(/\.[A-Za-z0-9]{1,5}$/)?.[0] ?? EXT[p.media.mime ?? ''] ?? '';
          const dest = await saveInbound(inbox, ext, stream, MAX_MEDIA);
          if (dest) media.push(dest);
          else { this.log(`whatsapp: media passed ${MAX_MEDIA >> 20} MB while downloading, dropped chat=${p.chat.slice(0, 8)}…`); note(`a ${KIND_NAME[p.media.kind] ?? p.media.kind} over ${MAX_MEDIA >> 20} MB was sent and not downloaded`); }
        } catch (e) {
          // Said to the agent too (#35): a file with no caption would otherwise be no turn at all.
          this.log(`whatsapp: media download failed chat=${p.chat.slice(0, 8)}…: ${String((e as Error).message ?? e).slice(0, 160)}`);
          note(`the ${KIND_NAME[p.media.kind] ?? p.media.kind} sent could not be downloaded`);
        }
      }
      if (!head.text && !media.length) return;
      // Not awaited: the chat's turn queue keeps the order from here, and a turn can run for hours.
      void this.opts.onInbound({ ...head, media }).catch((e) => this.log(`whatsapp: handler error ${(e as Error).message}`));
    });
  }

  async send(chat: string, text: string): Promise<void> {
    if (!this.sock || !this.connected) throw new Error('whatsapp: not connected');
    await this.post(chat, { text });
  }

  /** Every outgoing message goes through here, so a retry receipt can find it later. */
  private async post(chat: string, content: AnyMessageContent): Promise<void> {
    this.sent.remember(await this.sock!.sendMessage(chat, content));
  }

  /** A group's subject, for naming its profile. A DM has no name here. */
  async chatName(chat: string): Promise<string | undefined> {
    if (!this.sock || !chat.endsWith('@g.us')) return undefined;
    return (await this.sock.groupMetadata(chat)).subject || undefined;
  }

  /** Attach a file. Baileys streams it from disk, so a large document never sits in this process's heap. */
  async sendMedia(chat: string, m: Media): Promise<void> {
    if (!this.sock || !this.connected) throw new Error('whatsapp: not connected');
    const caption = m.caption || undefined;
    if (m.kind === 'image') { await this.post(chat, { image: { url: m.path }, caption, mimetype: m.mime }); return; }
    if (m.kind === 'video') { await this.post(chat, { video: { url: m.path }, caption, mimetype: m.mime }); return; }
    if (m.kind === 'audio' && m.voice !== false) {
      // WhatsApp shows a voice bubble only for ogg/opus; anything else is converted first.
      const v = await asVoice(m.path);
      try {
        const ptt = isOpus(v.path);
        await this.post(chat, { audio: { url: v.path }, mimetype: ptt ? 'audio/ogg; codecs=opus' : m.mime, ptt });
      } finally { v.cleanup(); }
      return;
    }
    await this.post(chat, { document: { url: m.path }, fileName: m.fileName, caption, mimetype: m.mime });
  }

  async typing(chat: string, on: boolean): Promise<void> {
    const t = this.typingTimers.get(chat);
    if (t) { clearInterval(t); this.typingTimers.delete(chat); }
    if (!on) { await this.sock?.sendPresenceUpdate('paused', chat).catch(() => {}); return; }
    const ping = () => this.sock?.sendPresenceUpdate('composing', chat).catch(() => {});
    void ping();
    this.typingTimers.set(chat, setInterval(() => void ping(), 4000));
  }

  /** Log this linked device out on the phone's side, then forget the credentials. Other linked devices are untouched. */
  async logout(): Promise<void> {
    this.stopping = true;
    try { await this.sock?.logout(); } catch { /* not connected: the phone keeps listing the device until removed by hand */ }
    this.state = 'disconnected';
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.typingTimers.values()) clearInterval(t);
    this.typingTimers.clear();
    clearTimeout(this.reconnect);
    clearInterval(this.watch);
    this.retire(this.sock);
    this.state = 'disconnected';
  }
}
