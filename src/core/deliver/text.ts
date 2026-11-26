export const FAILURE_LINE = 'Something broke on my side. Try again, or /new.';

/** The failure line with the reason the daemon logged, so the chat can tell a lost login from a
 *  dead pane without a terminal. The home folder is written as `~`: the reason often names the
 *  profile's cwd, and a group has members who are not the owner. For the same members, a group
 *  never sees the last line of the agent's error output ("exit: …"), which can quote anything. */
export function failureLine(reason?: string, home?: string, group = false): string {
  let r = (reason ?? '').trim().replace(/\s+/g, ' ');
  if (group && r.startsWith('exit:')) r = 'exit';
  if (!r || r === 'exception') return FAILURE_LINE;
  const said = r === 'exit' ? 'the agent exited without answering' : r;
  const tidy = home ? said.split(home).join('~') : said;
  return `Something broke on my side (${tidy.slice(0, 300)}). Try again, or /new.`;
}
/** tmux mode: the message was not typed into a session that is alive (busy with work of its own, or a
 *  dialog open). The session and its background work go on; the chat sends the message again. `reason`:
 *  the turn's, `not delivered: <why>` (brain/tui.ts, NOT_TYPED). */
export function notDeliveredLine(reason?: string): string {
  const why = (reason ?? '').replace(/^not delivered:\s*/, '').trim();
  return `Your message did not reach the agent${why ? `: ${why}` : ''}. Nothing was stopped, and its background work goes on. Send the message again in a few minutes. /stop ends the session, and its background work with it.`;
}
/** tmux mode: the turn's reader gave up on a tmux server that did not answer (brain/tui.ts,
 *  TMUX_STALLS calls in a row timed out). The reason the turn ends with, and the chat's line for it. */
export const TMUX_STALLED = 'tmux did not answer';
export const TMUX_STALLED_LINE = 'tmux on this Mac did not answer for over a minute, so Angelia stopped watching this turn. The agent got your message and the session goes on: its answer reaches the chat when it comes. /stop ends it.';
/** tmux mode: the session was handed to another reader (a handoff) while this message waited for the
 *  prompt, so it was never typed. No ids in it. */
export const RELEASED_LINE = 'Your message did not reach the agent: the session changed while the message waited. Send the message again.';
export const PERMISSION_TIMEOUT_LINE = 'No answer to the permission request in time, so it was denied.';
/** A turn that ended well with nothing new for the chat. Grok Build ends its turn this way after a denial
 *  (measured 2026-10-27), so the chat saw its own "no" and then nothing; Claude Code in print mode, Codex
 *  and pi can all end a turn with an empty final too. One line, so the chat knows the turn is over. */
export const DENIED_LINE = 'Denied; the agent stopped.';
export const NO_ANSWER_LINE = 'The agent ended its turn without an answer. Send your message again, or /new for a fresh session.';
/** tmux mode: the agent's answers to turns it started by itself (the end of a background task), past
 *  the hourly cap for one chat. Said at most once an hour; the answers past the cap are not kept. */
export function selfCapLine(max: number): string {
  return `The agent keeps reporting by itself, as its background work ends: ${max} such messages reached this chat in the last hour, so more are held back. Ask it for what you miss.`;
}
export const UNMATCHED_LINE = '[Angelia] This chat is not routed to a profile.';
export const NOT_OWNER_LINE = 'Only an owner of this chat can do that.';
/** A chat answer to a request no hook waits for any more (it stepped aside when the chat stopped
 *  being read): Claude asks in its own dialog instead. */
/** What the agent hears when a `permission_prompts: deny` profile refuses a request without asking.
 *  A chat "no", the app and a timeout keep the CLI's plain "Denied from chat": after those the owner
 *  may well say "run it again", and a tool result that says "do not retry" would stand in the way. */
export const AUTO_DENY_MESSAGE = 'Not permitted. Do not retry it; tell the user it is not permitted.';
/** permission_prompts: deny, past the cap in one turn: the agent kept asking, so the turn was stopped. */
export function autoDenyCapLine(max: number): string {
  return `The agent asked for ${max} things this profile does not permit, so Angelia stopped it.`;
}
/** permission_prompts: deny, but no hook waited for the refusal (tmux mode): Claude asks in its own dialog. */
export const AUTO_DENY_FAILED_LINE = 'Claude asked for a permission this profile refuses, but the refusal could not reach it. Answer it in the Claude app or in its pane.';
export const LATE_ANSWER_LINE = 'Too late: that request is no longer waiting for the chat. If Claude still asks, answer it in the Claude app or in its pane.';

/** The request as the chat sees it. A bare "yes" or "no" answers it where that cannot land on another
 *  request (orchestrator.ts, bareAnswer); "yes <id>" names it outright and works in every case. */
export function permissionLine(id: string, tool: string, preview: string): string {
  return `🔐 ${tool}: ${preview}\nReply "yes" or "no". (request ${shortId(id)})`;
}

/** Above a request of a turn the agent started by itself between the chat's turns, tied to the chat's
 *  work (the end of its background task, its teammate's message): nobody in the chat asked for this turn. */
export const SELF_ASK_LINE = 'The agent woke up by itself (a background task ended, or a message came) and asks:';
/** Above a request between the chat's turns of a turn nothing ties to the chat's work (a scheduled
 *  prompt, another session's message, one the owner may have typed in the Claude app): asked, whatever
 *  the levels say. */
export const SELF_ASK_UNTIED_LINE = 'A turn Angelia did not type in this session asks (the agent woke by itself, or someone typed in the Claude app):';

/** A request's id as the chat is shown it. */
export function shortId(id: string): string { return id.slice(0, 8); }

// Ids are not all hex: Grok Build's are `call-…`, and the chat is shown their first eight characters.
// A digit or a dash marks an id, so "yes please" stays a message. A comma, full stop or exclamation
// mark may follow the id ("yes d640cc6a.").
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+((?=[0-9a-z_-]*[0-9-])[0-9a-z_-]{5,40})[.,!]*\s*$/i;
/** An answer with no id: the word alone, a full stop or exclamation mark after it at most. */
export const BARE_ANSWER_RE = /^\s*(y|yes|n|no|כן|לא)[.!]*\s*$/i;

export function parsePermissionReply(text: string): { id: string; allow: boolean } | null {
  // A group passes on only messages that @mention the bot, so the answer often carries one
  // ("yes d640cc6a @972…"); WhatsApp and Telegram both keep it in the text. Only a mention that starts
  // a word goes: "no 12345@s.whatsapp.net" is not an answer to request 12345.
  const m = PERMISSION_REPLY_RE.exec(text.replace(/(^|\s)@\S+/g, ' '));
  if (!m) return null;
  return { id: m[2], allow: /^y/i.test(m[1]) };
}

/**
 * yes / no / y / n / כן / לא and nothing else: true to allow, false to deny, null for any other text.
 * Only the bot's own mention may stand beside the word (`botMentions`: the tokens the adapter read as
 * naming the bot, Inbound.botMentions). An answer with an id names its request, so any mention may ride
 * with it; a bare word names nothing, and "@someone yes" is said to someone. Whether the word answers
 * anything is the orchestrator's to say (bareAnswer).
 */
export function parseBareAnswer(text: string, botMentions: string[] = []): boolean | null {
  const own = new Set(botMentions.map((t) => t.toLowerCase()));
  const rest = text.split(/\s+/).filter((w) => !own.has(w.toLowerCase().replace(/[.,!]+$/, ''))).join(' ');
  const m = BARE_ANSWER_RE.exec(rest);
  if (!m) return null;
  return /^(y|כן)/i.test(m[1]);
}

/** A press on a request's button (Telegram) when the request is over: answered, timed out, or from before a restart. */
export const BUTTON_GONE_LINE = 'That request is no longer waiting.';
/** A bare answer, or a press, on a request posted a moment ago: it may have been meant for something
 *  else, with the request appearing under it. Also a bare answer whose platform gave it no time. */
export const READ_FIRST_LINE = 'That request only just arrived, so your answer was not taken for it. Read the request, then answer again.';

type Asked = { id: string; tool: string; preview: string };
const start = (preview: string, max = 60) => { const what = preview.replace(/\s+/g, ' ').trim(); return what.length > max ? `${what.slice(0, max)}…` : what; };

/** A bare answer with several requests open: which they are, and the two ways to say which one. */
export function whichOneLine(open: Asked[]): string {
  return `Which one? ${open.length} requests are waiting:\n${open.map((r) => `${shortId(r.id)} ${r.tool}: ${start(r.preview)}`).join('\n')}\nAnswer "yes <id>" or "no <id>", or reply to the request's own message.`;
}

/** What a bare answer was taken for, said back to the chat: the word named no request, so the chat is
 *  told which one it landed on. */
export function answeredLine(allow: boolean, ask: Asked): string {
  return `${pressedText(allow, ask)} (request ${shortId(ask.id)})`;
}

/** The same for a press on a button, in the press's own answer (Bot API: at most 200 characters). */
export function pressedText(allow: boolean, ask: Pick<Asked, 'tool' | 'preview'>): string {
  return `${allow ? 'Allowed' : 'Denied'}: ${ask.tool}: ${start(ask.preview)}`;
}

/**
 * A bare answer in a chat where a request ended a moment ago with no answer from the chat (it timed
 * out, was answered in the app or the pane, its turn ended): the word may have been typed for that one
 * and sent late, which no clock here can tell (a phone that was offline sends it when it is back, and
 * the platform stamps it then). So for a while a bare word answers nothing and is never passed to the
 * agent. `open`: a request waits now, and this is how to answer it; `buttons`: its line has them.
 */
export function afterCloseLine(open: boolean, buttons: boolean): string {
  if (!open) return 'Too late: that request is no longer waiting, and your word was not passed to the agent. If it was meant for the agent, say it in more words.';
  return `A request in this chat ended a moment ago, so "yes" or "no" alone is not taken for a few minutes. Reply to the open request's own message${buttons ? ', press its button,' : ''} or answer with its id ("yes <id>").`;
}

/** A bare answer to a request that was in the chat, or came into it, around the time another one ended
 *  with no answer from the chat: a word typed for that other one may arrive at any time while this
 *  one waits, so this one takes no bare word at all. How to answer it instead. */
export function followsCloseLine(buttons: boolean): string {
  return `Another request in this chat ended without an answer around the time this one was asked, so "yes" or "no" alone is not taken for it. Reply to the request's own message${buttons ? ', press its button,' : ''} or answer with its id ("yes <id>").`;
}

/**
 * A CLI that ran out of its usage allowance answers with one short line ("You've reached your Fable
 * limit…"). Kept short on purpose: a long agent reply that merely talks about limits is not one.
 */
const LIMIT = /(reached|hit|exceeded) (your|the) [\w .-]{0,40}limit|usage limit|out of (usage|credits)|quota (exceeded|exhausted)|rate[ _-]?limit(ed)?\b|model_requires_usage_credits/i;

export function isLimitText(text: string): boolean {
  return text.length > 0 && text.length <= 400 && LIMIT.test(text);
}

/** What to add under a limit message: how to keep going on another model now. */
export function limitHint(backend: string): string {
  if (backend === 'claude-code') return 'To keep going now, switch model for this session: send /model opus (or /model sonnet). /model default goes back once the limit resets.';
  if (backend === 'pi') return 'To keep going now, switch model for this session: send /model to see the ones pi is signed in to, then /model provider/model. /model default goes back once the limit resets.';
  return 'To keep going now, switch model for this session: send /model <name>. /model default goes back once the limit resets.';
}
