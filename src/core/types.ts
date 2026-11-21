export type Platform = 'whatsapp' | 'telegram';

/**
 * Chat text as plain text: line breaks become `\n`, tabs stay, every other control character goes
 * (C0, DEL, C1). A client can put any byte in a message, and in a tmux pane an escape sequence is
 * not text but keys: on tmux before 3.7 the bracketed-paste end marker (ESC [ 2 0 1 ~) inside a
 * message ends the paste early and types the rest into the CLI, Enter included (measured on 3.6a).
 * Applied once, where a message comes in, so logs and print mode get the same text.
 */
export function cleanText(s: string): string {
  // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
  return s.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
/** A name someone else chose (a sender's display name, a group's subject), made safe to put in a
 *  line the agent reads as Angelia's: one line, no brackets, no braces, bounded. */
export function cleanName(name: string, max = 40): string {
  return name.replace(/[[\]{}\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
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
  /** The text of the message this one replies to (quotes), when the platform sends it. */
  quoted?: string;
  /** This message is a reply (a swipe-reply, a Telegram reply): the id of the message replied to, as
   *  the platform names it in that chat (absent when the platform gives none: a reply into another
   *  chat), and whether that message is one this bot sent. The adapter's facts, never the sender's text:
   *  a reply picks a permission request by this id (orchestrator.ts, bareAnswer), not by what it quotes. */
  reply?: { id?: string; ours: boolean };
  /** The @tokens in `text` that name the bot itself, as written ("@Angelia_bot", "@15550000000").
   *  Another member's mention is never here: "@someone yes" is said to someone. */
  botMentions?: string[];
  /** When the platform says the message was sent, in ms (WhatsApp and Telegram give whole seconds).
   *  A message can reach the daemon long after it was typed (a reconnect, a download in front of it);
   *  a bare answer to a permission request is held to this time, not to when it arrived. */
  at?: number;
  /** 'app': the owner typed it in a client on this machine (the API's reply-to-caller turn). What
   *  the turn says goes to that client as events (core/events.ts) and never to the chat. */
  surface?: 'app';
  /** The id a client was given for this turn (the API's /turn); its events carry it. */
  turnId?: string;
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
  /** A handoff moved the chat on while this session's turn was running (ISO time the turn was typed in).
   *  Its pane keeps working with nobody reading it; cleared when the turn is over or /resume takes it back. */
  background_since?: string;
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
  | { kind: 'permission'; id: string; tool: string; preview: string; /** The whole request, when the preview had to cut it. */ detail?: string;
      /** The request in Claude Code's naming, for the profile's permission rules; none when the backend cannot name it. */ request?: { tool: string; input?: unknown } }
  /** A request given to the chat was answered outside Angelia: in the CLI's own dialog (its pane or app). */
  | { kind: 'permission-answered'; id: string; allow: boolean }
  /** An answer of the session that this turn did not ask for, found as the turn was typed: told to the
   *  chat before the turn's own answer (UnaskedAnswer). Between turns a brain emits it as `unasked`. */
  | ({ kind: 'unasked' } & UnaskedAnswer)
  | { kind: 'result'; text: string; isError: boolean; reason?: string };

/**
 * An answer of a session that no turn of Angelia's is waiting for (tmux mode, brain/tui.ts).
 * `late`: the answer of a turn Angelia typed and closed without it, come after all.
 * `self`: the answer of a turn the CLI started by itself: the end of a background task that a turn of
 * Angelia's started. Never a turn a person typed in the CLI's own app or pane.
 */
export interface UnaskedAnswer { answer: 'late' | 'self'; text: string }

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
