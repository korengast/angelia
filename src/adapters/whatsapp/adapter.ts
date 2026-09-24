import { mkdirSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import pino from 'pino';
import { ChatChains, MAX_INBOUND, SenderQuota, saveInbound } from '../inbox.js';
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage, DisconnectReason, type WASocket } from 'baileys';
import qrcode from 'qrcode-terminal';
import type { Inbound } from '../../core/types.js';
import type { Sender } from '../../core/orchestrator.js';
import { LidMap, normalizeJid } from './ids.js';
import { parseMessage, SeenIds, type WaMessageLike } from './parse.js';
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
}

const MAX_MEDIA = MAX_INBOUND;
const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4', 'audio/ogg; codecs=opus': '.ogg', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'application/pdf': '.pdf' };

/**
 * WhatsApp as a linked device (Baileys, in-process). One socket per daemon. Pairing by code
 * printed to the terminal, QR as fallback. Reconnects on every close except a logout.
 * Learnings baked in from an earlier bridge: `getMessage` must exist or E2EE retries drop messages
 * silently; our own echoes come back as fromMe; people appear as `@lid` as often as by phone.
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
  private lastBackoffNotice = 0;

  constructor(private readonly opts: WhatsAppAdapterOptions) {
    super();
    this.log = opts.log ?? (() => {});
    this.say = opts.say ?? ((l) => console.log(l));
    this.lids = new LidMap(opts.authDir);
  }

  get connected(): boolean { return this.state === 'connected'; }

  async start(): Promise<void> {
    mkdirSync(this.opts.authDir, { recursive: true, mode: 0o700 });
    await this.open();
  }

  private async open(): Promise<void> {
    if (this.stopping) return;
    this.state = 'connecting';
    const { state, saveCreds } = await useMultiFileAuthState(this.opts.authDir);
    const version = await this.waVersion();
    // ANGELIA_WA_DEBUG=<file>: full Baileys debug log to that file (pairing diagnostics). Never on by default: it contains message payloads.
    const debugFile = process.env.ANGELIA_WA_DEBUG;
    const logger = debugFile ? pino({ level: 'trace' }, pino.destination({ dest: debugFile, sync: true })) : pino({ level: 'silent' });
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger,
      // Pairing by code is known to fail with some browser descriptors; a Chrome desktop identity works.
      browser: ['Angelia', 'Chrome', '120.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async () => ({ conversation: '' }),
    });
    this.sock = sock;
    sock.ev.on('creds.update', () => { void saveCreds(); this.lids.reload(); });
    sock.ev.on('connection.update', (u) => void this.onConnection(u as Record<string, any>, sock));
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      for (const m of messages) void this.onMessage(m as unknown as WaMessageLike).catch((e) => this.log(`whatsapp: message error ${(e as Error).message}`));
    });
    // A QR link sets `me` and never `registered`; a code link sets both.
    this.registered = !!(state.creds.registered || state.creds.me);
    if (!this.registered && this.opts.pairing === 'code' && !(this.opts.phone ?? '').replace(/\D/g, '')) throw new Error('whatsapp: pairing by code needs whatsapp.phone in routing.yaml (E.164, e.g. +15551234567)');
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
      const me = normalizeJid(sock.user?.id);
      this.log(`whatsapp: connected as ${me ? me.slice(0, 4) + '…' : '?'}`);
      this.emit('open');
      if (this.opts.pairOnly) { this.say('Paired. Credentials saved.'); setTimeout(() => this.emit('paired'), 2000); }
      return;
    }
    if (u.connection === 'close') {
      this.state = 'disconnected';
      const code: number | undefined = u.lastDisconnect?.error?.output?.statusCode;
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
        setTimeout(() => void this.open().catch((e) => this.log(`whatsapp: reopen failed ${(e as Error).message}`)), 1000);
        return;
      }
      if (code === DisconnectReason.loggedOut) { this.log('whatsapp: logged out; delete the auth dir and pair again'); this.emit('logged-out'); return; }
      let delay = this.backoffMs;
      if (code === DisconnectReason.restartRequired) delay = 1000;
      else if (code === DisconnectReason.connectionReplaced) { delay = Math.min(this.backoffMs * 2, 30 * 60_000); this.backoffMs = delay; if (Date.now() - this.lastBackoffNotice > 6 * 3600_000) { this.lastBackoffNotice = Date.now(); this.log('whatsapp: conflict (440): another client holds this session; backing off'); } }
      else { this.backoffMs = Math.min(this.backoffMs * 2, 30_000); delay = this.backoffMs; }
      this.log(`whatsapp: closed code=${code ?? '?'} reconnect_in=${delay}ms`);
      setTimeout(() => void this.open().catch((e) => this.log(`whatsapp: reopen failed ${(e as Error).message}`)), delay);
    }
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
      if ((p.media.size ?? 0) > MAX_MEDIA) { this.log(`whatsapp: media over ${MAX_MEDIA >> 20} MB not downloaded chat=${p.chat.slice(0, 8)}…`); note(`a ${p.media.kind} over ${MAX_MEDIA >> 20} MB was sent and not downloaded`); }
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
          else { this.log(`whatsapp: media passed ${MAX_MEDIA >> 20} MB while downloading, dropped chat=${p.chat.slice(0, 8)}…`); note(`a ${p.media.kind} over ${MAX_MEDIA >> 20} MB was sent and not downloaded`); }
        } catch (e) { this.log(`whatsapp: media download failed chat=${p.chat.slice(0, 8)}…: ${String((e as Error).message ?? e).slice(0, 160)}`); }
      }
      if (!head.text && !media.length) return;
      // Not awaited: the chat's turn queue keeps the order from here, and a turn can run for an hour.
      void this.opts.onInbound({ ...head, media }).catch((e) => this.log(`whatsapp: handler error ${(e as Error).message}`));
    });
  }

  async send(chat: string, text: string): Promise<void> {
    if (!this.sock || !this.connected) throw new Error('whatsapp: not connected');
    await this.sock.sendMessage(chat, { text });
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
    if (m.kind === 'image') { await this.sock.sendMessage(chat, { image: { url: m.path }, caption, mimetype: m.mime }); return; }
    if (m.kind === 'video') { await this.sock.sendMessage(chat, { video: { url: m.path }, caption, mimetype: m.mime }); return; }
    if (m.kind === 'audio' && m.voice !== false) {
      // WhatsApp shows a voice bubble only for ogg/opus; anything else is converted first.
      const v = await asVoice(m.path);
      try {
        const ptt = isOpus(v.path);
        await this.sock.sendMessage(chat, { audio: { url: v.path }, mimetype: ptt ? 'audio/ogg; codecs=opus' : m.mime, ptt });
      } finally { v.cleanup(); }
      return;
    }
    await this.sock.sendMessage(chat, { document: { url: m.path }, fileName: m.fileName, caption, mimetype: m.mime });
  }

  async typing(chat: string, on: boolean): Promise<void> {
    const t = this.typingTimers.get(chat);
    if (t) { clearInterval(t); this.typingTimers.delete(chat); }
    if (!on) { await this.sock?.sendPresenceUpdate('paused', chat).catch(() => {}); return; }
    const ping = () => this.sock?.sendPresenceUpdate('composing', chat).catch(() => {});
    void ping();
    this.typingTimers.set(chat, setInterval(ping, 4000));
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
    try { this.sock?.end(undefined); } catch { /* already closed */ }
    this.state = 'disconnected';
  }
}
