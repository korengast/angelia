/**
 * What happens in each chat, for a client on this machine that shows it live (a desktop app).
 * The orchestrator emits these as it goes; the API streams them to the owner only (api/server.ts).
 * Nothing is stored: a client that was not listening reads the history from the CLI's transcript.
 */
export type ChatEvent = { key: string; at: string } & (
  /** A turn began: the message as the agent got it, before the envelope. `surface: 'app'` when the
   *  owner typed it in a client; its answer then goes back to the client only, never to the chat. */
  | { type: 'turn'; turn: string; text: string; sender: string; surface: 'chat' | 'app'; queued: number }
  /** A line the agent said along the way, at once, not held back by the chat's rate limit. Commentary:
   *  the lines a chat was sent come again as `out`, and an answer often repeats the last progress line,
   *  so a client shows progress as the turn's working state and `out` as the messages. */
  | { type: 'progress'; text: string }
  /** A line the chat got (or, for an app turn, would have got): answers, notices, command replies. */
  | { type: 'out'; text: string }
  | { type: 'permission'; id: string; tool: string; preview: string; detail?: string }
  /** `timeout`: nobody answered in time, so it was denied. `terminal`: answered in the CLI's own
   *  dialog (a tmux pane, or the CLI's app attached to it). */
  | { type: 'permission-answered'; id: string; allow: boolean; by: 'chat' | 'app' | 'timeout' | 'terminal' }
  | { type: 'turn-end'; turn: string; ok: boolean; reason?: string; queued: number }
);

/** A `ChatEvent` without the fields every event carries, as the orchestrator builds it. */
export type ChatEventBody = ChatEvent extends infer E ? E extends ChatEvent ? Omit<E, 'key' | 'at'> : never : never;

export type ChatListener = (e: ChatEvent) => void;
