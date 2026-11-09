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

/**
 * Unwrap ephemeral / view-once / caption wrappers to the message body Baileys nests them in. WhatsApp
 * stacks them (a document with a caption in a disappearing chat is ephemeral > documentWithCaption >
 * document), so this peels up to five layers, as Baileys' own normalizeMessageContent does (#34).
 * Baileys also peels editedMessage and the group status wrappers; those are left out on purpose, an edit
 * holds a protocol message and a group status post must not become a turn.
 */
export function messageContent(m: WaMessageLike): Record<string, any> {
  let c = m.message ?? {};
  for (let i = 0; i < 5; i++) {
    const inner = c.ephemeralMessage ?? c.viewOnceMessage ?? c.viewOnceMessageV2 ?? c.viewOnceMessageV2Extension ?? c.documentWithCaptionMessage;
    if (!inner?.message) break;
    c = inner.message;
  }
  return c;
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

/** A group member as `groupMetadata` lists them: `id` is the jid WhatsApp addresses them by (lid or phone). */
export interface Participant { id: string; lid?: string; phoneNumber?: string }

/** At most this many members are tagged in one message: a tag notifies even a member who muted the group. */
export const MAX_MENTIONS = 5;

/** `@<5-20 digits>`, `+` allowed, not inside a word, a URL path or an email address (`a@1555…`,
 *  `x.com/@1555…`, `@1555….example.com`), and never a part of a longer number. */
const TOKEN = /(?<![\p{L}\p{N}_/.@])@\+?(\d{5,20})(?![\p{L}\p{N}_]|\.[\p{L}\p{N}_])/gu;
/** Code is shown as written: a fenced block (an unclosed one runs to the end) or an inline span. */
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]+`/g;

export interface MentionOptions {
  /** The member's bare lid for a bare phone number, when known (the adapter's lid map): the agent may
   *  have been shown a phone the group itself hides. */
  lidFor?: (phone: string) => string | undefined;
  max?: number;
}

/**
 * `@<number>` in an outgoing group text. Two things, kept apart:
 * - The rewrite, always: a phone whose lid the lid map knows becomes `@<lid>`, so a phone the group
 *   hides never goes out, whether or not a tag is made (a progress line, a failed member fetch, a
 *   token past the cap). It needs no member list and no network.
 * - The tag, only with `members` (the caller wants tags and has the list): a phone or lid of a member
 *   becomes a mention, written as the member's `id`, the form WhatsApp renders as their name. At most
 *   `max` distinct members; the others are named as written (or by lid), untagged, and `capped`
 *   counts those members.
 * A number that is no member is left as written. Text inside backticks is never touched.
 */
export function withMentions(text: string, members: Participant[] | undefined, o: MentionOptions = {}): { text: string; mentions: string[]; capped: number } {
  const max = o.max ?? MAX_MENTIONS;
  const byNum = new Map<string, string>();
  for (const p of members ?? []) for (const j of [p.id, p.lid, p.phoneNumber]) if (j) byNum.set(bareId(j), normalizeJid(p.id));
  const mentions = new Set<string>(), capped = new Set<string>();
  const tag = (plain: string) => plain.replace(TOKEN, (tok, n: string) => {
    const lid = o.lidFor?.(n);
    const jid = byNum.get(n) ?? (lid ? byNum.get(lid) : undefined);
    if (jid && (mentions.has(jid) || mentions.size < max)) { mentions.add(jid); return `@${bareId(jid)}`; }
    if (jid) capped.add(jid);
    return lid ? `@${lid}` : tok;
  });
  let out = '', at = 0;
  for (const c of text.matchAll(CODE)) {
    out += tag(text.slice(at, c.index)) + c[0];
    at = c.index + c[0].length;
  }
  out += tag(text.slice(at));
  return { text: out, mentions: [...mentions], capped: capped.size };
}
