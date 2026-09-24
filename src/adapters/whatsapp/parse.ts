import type { Inbound } from '../../core/types.js';
import { normalizeJid, isGroupJid, bareId } from './ids.js';

/** The slice of a Baileys `WAMessage` this router reads. Kept structural so tests need no Baileys. */
export interface WaMessageLike {
  key: { remoteJid?: string | null; fromMe?: boolean | null; participant?: string | null; id?: string | null };
  pushName?: string | null;
  message?: Record<string, any> | null;
}

export type MediaKind = 'image' | 'document' | 'audio' | 'video' | 'sticker';

export interface ParsedMessage {
  chat: string;
  sender: string;        // full jid, normalized (phone or lid form)
  senderName?: string;
  text: string;
  isGroup: boolean;
  mentioned: boolean;
  /** size: what the sender's message declares, in bytes, when it declares one. */
  media?: { kind: MediaKind; mime?: string; fileName?: string; size?: number };
}

/** fileLength arrives as a number, a numeric string, or a protobuf Long ({ low, high }). */
export function byteLength(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') return /^\d+$/.test(v) ? Number(v) : undefined;
  if (v && typeof v === 'object' && 'low' in v) {
    const { low, high } = v as { low: number; high?: number };
    return (high ?? 0) * 2 ** 32 + (low >>> 0);
  }
  return undefined;
}

/** Message ids already handed on, so a redelivery (a reconnect, an `append` batch that repeats a
 *  `notify`) never becomes a second turn. Bounded: the oldest ids fall out first. */
export class SeenIds {
  private ids = new Set<string>();
  constructor(private readonly max = 2000) {}
  /** True the first time a key is offered, false for every repeat. */
  first(key: string): boolean {
    if (this.ids.has(key)) return false;
    this.ids.add(key);
    if (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value as string);
    return true;
  }
}

/** Unwrap ephemeral / view-once / caption wrappers to the message body Baileys nests them in. */
export function messageContent(m: WaMessageLike): Record<string, any> {
  const c = m.message ?? {};
  return c.ephemeralMessage?.message ?? c.viewOnceMessage?.message ?? c.viewOnceMessageV2?.message ?? c.documentWithCaptionMessage?.message ?? c;
}

/**
 * Baileys message -> the router's view of it, or null when it is nothing we act on
 * (protocol messages, reactions, our own echoes, status broadcasts).
 * `us` lists our own ids (phone and lid forms) for mention detection.
 */
export function parseMessage(m: WaMessageLike, us: string[]): ParsedMessage | null {
  const chat = normalizeJid(m.key.remoteJid);
  if (!chat || chat === 'status@broadcast' || chat.endsWith('@newsletter')) return null;
  if (m.key.fromMe) return null;
  const c = messageContent(m);
  if (!c || Object.keys(c).length === 0) return null;
  const isGroup = isGroupJid(chat);
  const sender = normalizeJid(isGroup ? m.key.participant : chat) || chat;
  const ours = new Set(us.map(bareId).filter(Boolean));

  let text = '';
  let media: ParsedMessage['media'];
  let ctx: Record<string, any> | undefined;
  if (typeof c.conversation === 'string') text = c.conversation;
  else if (c.extendedTextMessage) { text = String(c.extendedTextMessage.text ?? ''); ctx = c.extendedTextMessage.contextInfo; }
  else if (c.imageMessage) { text = String(c.imageMessage.caption ?? ''); ctx = c.imageMessage.contextInfo; media = { kind: 'image', mime: c.imageMessage.mimetype, size: byteLength(c.imageMessage.fileLength) }; }
  else if (c.videoMessage) { text = String(c.videoMessage.caption ?? ''); ctx = c.videoMessage.contextInfo; media = { kind: 'video', mime: c.videoMessage.mimetype, size: byteLength(c.videoMessage.fileLength) }; }
  else if (c.documentMessage) { text = String(c.documentMessage.caption ?? ''); ctx = c.documentMessage.contextInfo; media = { kind: 'document', mime: c.documentMessage.mimetype, fileName: c.documentMessage.fileName, size: byteLength(c.documentMessage.fileLength) }; }
  else if (c.audioMessage) { ctx = c.audioMessage.contextInfo; media = { kind: 'audio', mime: c.audioMessage.mimetype, size: byteLength(c.audioMessage.fileLength) }; }
  else if (c.stickerMessage) { media = { kind: 'sticker', mime: c.stickerMessage.mimetype }; }
  else return null; // reactions, protocol, poll updates, calls: not a turn

  const mentionedJids: string[] = Array.isArray(ctx?.mentionedJid) ? ctx!.mentionedJid : [];
  const quotedBy = ctx?.participant ? bareId(String(ctx.participant)) : '';
  const mentioned = mentionedJids.some((j) => ours.has(bareId(String(j)))) || (!!quotedBy && ours.has(quotedBy));
  return { chat, sender, senderName: m.pushName ?? undefined, text, isGroup, mentioned, media };
}

/** ParsedMessage -> Inbound, with the sender written the way routing.yaml expects (bare phone or lid). */
export function toInbound(p: ParsedMessage, senderId: string, mediaPaths: string[]): Inbound {
  return { platform: 'whatsapp', chat: p.chat, sender: senderId, senderName: p.senderName, text: p.text, isGroup: p.isGroup, mentioned: p.mentioned, media: mediaPaths };
}
