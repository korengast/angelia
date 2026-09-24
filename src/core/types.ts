export type Platform = 'whatsapp' | 'telegram';

/**
 * Chat text as plain text: line breaks become `\n`, tabs stay, every other control character goes
 * (C0, DEL, C1). A client can put any byte in a message, and in a tmux pane an escape sequence is
 * not text but keys: on tmux before 3.7 the bracketed-paste end marker (ESC [ 2 0 1 ~) inside a
 * message ends the paste early and types the rest into the CLI, Enter included (measured on 3.6a).
 * Applied once, where a message comes in, so logs and print mode get the same text.
 */
export function cleanText(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
/** A name someone else chose (a sender's display name, a group's subject), made safe to put in a
 *  line the agent reads as Angelia's: one line, no brackets, no braces, bounded. */
export function cleanName(name: string, max = 40): string {
  return name.replace(/[\[\]{}\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export interface Inbound {
  platform: Platform;
  chat: string;
  thread?: string;
  sender: string;
  senderName?: string;
  text: string;
  isGroup: boolean;
  mentioned: boolean;
  media: string[];
}

export interface SessionRow {
  id: string;
  created_at: string;
  last_used_at: string;
  turns: number;
  started: boolean;
  label: string;
  /** CLI that owns this session id; a session cannot move between CLIs. */
  backend?: string;
  /** /model and /effort overrides for this session only; /new starts clean. */
  model?: string;
  effort?: string;
}

export interface ChatSessions {
  active: string | null;
  history: SessionRow[];
}

export interface SessionMapFile {
  version: 1;
  chats: Record<string, ChatSessions>;
}

export type BrainEvent =
  | { kind: 'progress'; text: string }
  /** A line from Angelia about the session itself, delivered to the chat as is (not agent text). */
  | { kind: 'notice'; text: string }
  | { kind: 'permission'; id: string; tool: string; preview: string; /** The whole request, when the preview had to cut it. */ detail?: string }
  | { kind: 'result'; text: string; isError: boolean; reason?: string };

export function sessionKey(i: Pick<Inbound, 'platform' | 'chat' | 'thread'>): string {
  return i.thread ? `${i.platform}:${i.chat}:${i.thread}` : `${i.platform}:${i.chat}`;
}

/** The other way round: `telegram:-100…:5` is a chat and a topic, never a chat id with a colon in it. */
export function parseSessionKey(key: string): Pick<Inbound, 'platform' | 'chat' | 'thread'> {
  const [platform, chat = '', thread] = key.split(':');
  return { platform: platform as Inbound['platform'], chat, ...(thread ? { thread } : {}) };
}

/** A group chat, from its id alone: a WhatsApp group jid, or a negative Telegram chat id. */
export function isGroupChat(platform: string, chat: string): boolean {
  return platform === 'whatsapp' ? chat.endsWith('@g.us') : chat.startsWith('-');
}
