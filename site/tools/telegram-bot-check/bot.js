// The Telegram bot check: getMe, getWebhookInfo, then getUpdates, straight from the browser to
// api.telegram.org (it answers these GETs with Access-Control-Allow-Origin: *). Read-only: no offset is
// sent, so no update is marked as read, and a webhook is reported, never deleted. Plain JavaScript;
// the page loads it as a module and tests/site-tools.test.ts imports it with a stand-in fetch.

export const API = 'https://api.telegram.org';

/** A token as @BotFather gives it: the bot's numeric id, a colon, and a 35-character secret. */
export const TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,50}$/;

/** The token, trimmed of what a copy from a chat or a .env line brings along. */
export const cleanToken = (text) => String(text ?? '').trim().replace(/^(TELEGRAM_BOT_TOKEN|BOT_TOKEN)\s*=\s*/, '').replace(/^["']|["']$/g, '').replace(/^bot(?=\d)/, '');

/** A failed step, in words for the page. `code` is Telegram's error_code, or 0 when nothing answered. */
export class CheckError extends Error {
  constructor(step, code, message) { super(message); this.step = step; this.code = code; }
}

/** One Bot API call. The token is in the path, as the Bot API wants it; no cookie, no referrer. */
async function call(fetchImpl, token, method, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  let res;
  try {
    res = await fetchImpl(`${API}/bot${token}/${method}${qs ? '?' + qs : ''}`, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
  } catch {
    throw new CheckError(method, 0, 'api.telegram.org did not answer. Check your connection, or whether a blocker or firewall stops it.');
  }
  let body;
  try { body = await res.json(); } catch { throw new CheckError(method, res.status, `api.telegram.org answered ${res.status} without JSON.`); }
  if (!body.ok) throw new CheckError(method, body.error_code ?? res.status, explain(method, body.error_code ?? res.status, String(body.description ?? '')));
  return body.result;
}

/** Telegram's error, with what to do about it. The description is Telegram's own text. */
export function explain(method, code, description) {
  if (code === 401) return 'Telegram refused the token (401 Unauthorized). It is wrong, or it was revoked in @BotFather. Copy it again from @BotFather.';
  if (code === 404) return 'Telegram does not know this token (404 Not Found). Check that you copied all of it.';
  if (code === 409 && /webhook/i.test(description)) return `getUpdates is refused while the bot has a webhook (409: ${description}).`;
  if (code === 409) return `Another program polled this bot after the check started, and Telegram ended the check's request, as it does in practice with the older of two (409: ${description}). Only one reader can poll at a time. If Angelia runs with this token, that is Angelia: stop it, then check again.`;
  if (code === 429) return `Telegram asks to slow down (429: ${description}). Wait a minute and check again.`;
  return `${method} failed (${code}: ${description}).`;
}

/** The name of a chat as Telegram's apps show it. */
export function chatName(chat) {
  if (chat.title) return chat.title;
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ');
  return name || (chat.username ? `@${chat.username}` : String(chat.id));
}

/**
 * Every chat the updates mention, newest first: id, type, name, how many updates, when the last came,
 * and who wrote (user ids, for an Angelia route's owners and allow_from). Updates of any kind count:
 * a message, an edit, a channel post, the bot being added to a group.
 */
export function chatsFrom(updates) {
  const chats = new Map();
  for (const u of updates ?? []) {
    for (const [kind, v] of Object.entries(u)) {
      if (kind === 'update_id' || !v || typeof v !== 'object') continue;
      const chat = v.chat ?? v.message?.chat;
      if (!chat || chat.id === undefined) continue;
      const c = chats.get(chat.id) ?? { id: chat.id, type: chat.type, name: chatName(chat), count: 0, last: 0, senders: new Map() };
      c.count += 1;
      c.last = Math.max(c.last, v.date ?? v.message?.date ?? 0);
      const from = v.from ?? v.message?.from;
      if (from && from.id !== undefined && !from.is_bot) c.senders.set(from.id, chatName(from));
      chats.set(chat.id, c);
    }
  }
  return [...chats.values()].sort((a, b) => b.last - a.last)
    .map((c) => ({ ...c, senders: [...c.senders].map(([id, name]) => ({ id, name })) }));
}

export const isGroup = (chat) => chat.type === 'group' || chat.type === 'supergroup';

/** The line for Angelia's routing.yaml. Owners approve what the agent runs, so no sender is ever put
 *  there: anyone in the group can be the one who wrote. A group's line holds a placeholder to replace. */
export const OWNER_PLACEHOLDER = 'YOUR_USER_ID';
export function routeLine(chat, profile = 'coding') {
  return `- { platform: telegram, chat: ${chat.id}, profile: ${profile}${isGroup(chat) ? `, owners: [${OWNER_PLACEHOLDER}]` : ''} }`;
}

/**
 * The whole check. Resolves to { bot, webhook, chats, updates } or throws a CheckError naming the step
 * that failed. With a webhook set, getUpdates is not called (it would only answer 409), and chats is null.
 */
export async function checkBot(token, fetchImpl = fetch) {
  const t = cleanToken(token);
  if (!TOKEN.test(t)) throw new CheckError('token', 0, 'That does not look like a bot token. It has the form 123456789:AA… (digits, a colon, then about 35 letters, digits, - and _).');
  const bot = await call(fetchImpl, t, 'getMe');
  const webhook = await call(fetchImpl, t, 'getWebhookInfo');
  if (webhook.url) return { bot, webhook, chats: null, updates: 0 };
  const updates = await call(fetchImpl, t, 'getUpdates', { limit: 100, timeout: 0 });
  return { bot, webhook, chats: chatsFrom(updates), updates: updates.length };
}
