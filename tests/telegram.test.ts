import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update, UserFromGetMe } from 'grammy/types';
import { TelegramAdapter } from '../src/adapters/telegram/adapter.js';
import type { Inbound } from '../src/core/types.js';
import type { Media } from '../src/core/deliver/media.js';

/**
 * The Telegram adapter against grammY's own update path, with the Bot API faked at the transformer
 * seam: no network, no token. The bot's identity is given up front, the way it would come from getMe.
 */
const ME: UserFromGetMe = { id: 42, is_bot: true, first_name: 'Angelia', username: 'Angelia_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };

function rig(inbox?: string) {
  const got: Inbound[] = [];
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const tg = new TelegramAdapter({ token: '000:fake', botInfo: ME, inboxFor: () => inbox, onInbound: async (i) => { got.push(i); }, log: (l) => logs.push(l) });
  tg.bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === 'getFile') return { ok: true, result: { file_id: 'f', file_unique_id: 'u1', file_path: 'documents/file_1.pdf' } } as never;
    return { ok: true, result: true } as never;
  });
  return { tg, got, calls, logs };
}

let n = 0;
const update = (message: Record<string, unknown>): Update => ({ update_id: ++n, message: { message_id: n, date: 1, ...message } } as unknown as Update);
// A message with a file has no `text` field at all: the caption is the only text, as in a real update.
const dm = (text: string, extra: Record<string, unknown> = {}) => update({ chat: { id: 7, type: 'private', first_name: 'Sam' }, from: { id: 7, is_bot: false, first_name: 'Sam' }, ...(text ? { text } : {}), ...extra });
const group = (text: string, extra: Record<string, unknown> = {}) => update({ chat: { id: -100, type: 'supergroup', title: 'Trip' }, from: { id: 7, is_bot: false, first_name: 'Sam' }, text, ...extra });

test('a DM is delivered as a dm from its own user; a group message carries the group flag', async () => {
  const { tg, got } = rig();
  await tg.bot.handleUpdate(dm('hello'));
  await tg.bot.handleUpdate(group('hi all'));
  assert.deepEqual(got.map((i) => [i.platform, i.chat, i.sender, i.senderName, i.text, i.isGroup, i.mentioned, i.media]), [
    ['telegram', '7', '7', 'Sam', 'hello', false, false, []],
    ['telegram', '-100', '7', 'Sam', 'hi all', true, false, []],
  ]);
  // The time Telegram dates the message, in ms (the helper dates every message second 1).
  assert.deepEqual(got.map((i) => i.at), [1000, 1000]);
});

test('mentioned: an @mention of the bot (any case) or a reply to it; another bot\'s name is not', async () => {
  const { tg, got } = rig();
  await tg.bot.handleUpdate(group('@angelia_BOT what now', { entities: [{ type: 'mention', offset: 0, length: 12 }] }));
  await tg.bot.handleUpdate(group('@other_bot what now', { entities: [{ type: 'mention', offset: 0, length: 10 }] }));
  await tg.bot.handleUpdate(group('yes', { reply_to_message: { message_id: 1, date: 1, chat: { id: -100, type: 'supergroup', title: 'Trip' }, from: { id: ME.id, is_bot: true, first_name: 'Angelia' } } }));
  await tg.bot.handleUpdate(group('yes', { reply_to_message: { message_id: 1, date: 1, chat: { id: -100, type: 'supergroup', title: 'Trip' }, from: { id: 9, is_bot: false, first_name: 'Ann' } } }));
  assert.deepEqual(got.map((i) => i.mentioned), [true, false, true, false]);
});

test('a reply carries what it quotes: the selected part, else the text, else the caption; a reply with neither carries nothing', async () => {
  const { tg, got } = rig();
  const to = (extra: Record<string, unknown>) => ({ message_id: 1, date: 1, chat: { id: -100, type: 'supergroup', title: 'Trip' }, from: { id: 9, is_bot: false, first_name: 'Ann' }, ...extra });
  await tg.bot.handleUpdate(group('what?', { reply_to_message: to({ text: 'line 1\nline 2' }) }));
  await tg.bot.handleUpdate(group('nice', { reply_to_message: to({ photo: [{ file_id: 'p', file_unique_id: 'p', width: 1, height: 1 }], caption: 'the view' }) }));
  await tg.bot.handleUpdate(group('hm', { reply_to_message: to({ sticker: { file_id: 's', file_unique_id: 's', type: 'regular', width: 1, height: 1, is_animated: false, is_video: false } }) }));
  await tg.bot.handleUpdate(group('this part', { reply_to_message: to({ text: 'a long message with a part' }), quote: { text: 'a part', position: 20 } }));
  // A reply to a message in another chat: no reply_to_message, the quote is the only text.
  await tg.bot.handleUpdate(group('from there', { external_reply: { origin: { type: 'user', date: 1, sender_user: { id: 9, is_bot: false, first_name: 'Ann' } } }, quote: { text: 'quoted elsewhere', position: 0 } }));
  await tg.bot.handleUpdate(group('empty quote', { reply_to_message: to({ text: 'whole' }), quote: { text: '', position: 0 } }));
  await tg.bot.handleUpdate(group('no reply'));
  assert.deepEqual(got.map((i) => i.quoted), ['line 1\nline 2', 'the view', undefined, 'a part', 'quoted elsewhere', 'whole', undefined]);
  assert.deepEqual(got.map((i) => 'quoted' in i), [true, true, false, true, true, true, false]);
  // What it replies to, as a fact apart from the text: the message's id, and not ours (Ann wrote it).
  // A reply into another chat names no message of this one.
  assert.deepEqual(got.map((i) => i.reply), [{ id: '1', ours: false }, { id: '1', ours: false }, { id: '1', ours: false }, { id: '1', ours: false }, { ours: false }, { id: '1', ours: false }, undefined]);
});

test('a topic message carries its thread; a plain group message does not', async () => {
  const { tg, got } = rig();
  await tg.bot.handleUpdate(group('in topic', { message_thread_id: 55, is_topic_message: true }));
  await tg.bot.handleUpdate(group('reply in general', { message_thread_id: 55 }));
  assert.deepEqual(got.map((i) => i.thread), ['55', undefined]);
});

test('files: nothing is fetched for a chat that is not routed; a routed one lands in .inbox; over the cap it is skipped', async () => {
  const doc = (size: number) => ({ document: { file_id: 'f', file_unique_id: 'u1', file_name: 'a.pdf', file_size: size }, caption: 'see' });
  const cold = rig();
  await cold.tg.bot.handleUpdate(dm('', doc(10)));
  assert.equal(cold.calls.length, 0, 'unrouted: no getFile');
  assert.deepEqual(cold.got.map((i) => [i.text, i.media]), [['see', []]]);

  const inbox = mkdtempSync(join(tmpdir(), 'angelia-tg-'));
  const warm = rig(inbox);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('%PDF-1.4 bytes')) as typeof fetch;
  try {
    await warm.tg.bot.handleUpdate(dm('', doc(10)));
    await warm.tg.bot.handleUpdate(dm('', doc(21 * 1024 * 1024)));
    await warm.tg.drained();
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(warm.calls.map((c) => c.method), ['getFile'], 'one download; the oversized one never asked');
  const [name] = readdirSync(join(inbox, '.inbox'));
  assert.match(name, /^\d+-[0-9a-f]{8}\.pdf$/, 'Angelia names the file: a resent one does not overwrite, a planted link is not followed');
  const dest = join(inbox, '.inbox', name);
  assert.equal(readFileSync(dest, 'utf8'), '%PDF-1.4 bytes');
  assert.deepEqual(warm.got.map((i) => i.media), [[dest], []]);
  assert.equal(warm.got[1].text, 'see\n[a file over 20 MB was sent and not downloaded]', 'the agent is told, as on WhatsApp');
});

test('a stalled download holds only its own chat, and a text after a photo still comes after it', async () => {
  const inbox = mkdtempSync(join(tmpdir(), 'angelia-tg-'));
  const r = rig(inbox);
  const realFetch = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  globalThis.fetch = (async () => { await gate; return new Response('bytes'); }) as typeof fetch;
  try {
    await r.tg.bot.handleUpdate(dm('', { document: { file_id: 'f', file_unique_id: 'u', file_name: 'a.pdf', file_size: 5 }, caption: 'photo' }));
    await r.tg.bot.handleUpdate(dm('after the photo'));
    await r.tg.bot.handleUpdate(group('@angelia_bot elsewhere', { entities: [{ type: 'mention', offset: 0, length: 12 }] }));
    await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual(r.got.map((i) => i.text), ['@angelia_bot elsewhere'], 'the other chat is not held');
    release();
    await r.tg.drained();
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(r.got.map((i) => i.text), ['@angelia_bot elsewhere', 'photo', 'after the photo']);
});

test('a command tapped in a group menu (/status@bot) counts as a mention', async () => {
  const r = rig();
  await r.tg.bot.handleUpdate(group('/status@angelia_bot', { entities: [{ type: 'bot_command', offset: 0, length: 19 }] }));
  await r.tg.bot.handleUpdate(group('/status@other_bot', { entities: [{ type: 'bot_command', offset: 0, length: 17 }] }));
  await r.tg.drained();
  assert.deepEqual(r.got.map((i) => [i.text, i.mentioned]), [['/status@angelia_bot', true], ['/status@other_bot', false]]);
});

test('sendMedia picks the Bot API method by kind, and a thread rides along', async () => {
  const { tg, calls } = rig();
  const m = (path: string, kind: Media['kind'], extra: Partial<Media> = {}): Media => ({ path, kind, mime: 'x', bytes: 1, fileName: path.split('/').pop()!, ...extra });
  await tg.sendMedia('7', m('/f/a.jpg', 'image', { caption: 'pic' }));
  await tg.sendMedia('7', m('/f/a.webp', 'image'));
  await tg.sendMedia('7', m('/f/a.mp4', 'video'), '55');
  await tg.sendMedia('7', m('/f/a.mp3', 'audio', { voice: false }));
  await tg.sendMedia('7', m('/f/a.ogg', 'audio'));
  await tg.sendMedia('7', m('/f/a.pdf', 'document', { fileName: 'report.pdf' }));
  assert.deepEqual(calls.map((c) => c.method), ['sendPhoto', 'sendDocument', 'sendVideo', 'sendAudio', 'sendVoice', 'sendDocument']);
  assert.equal(calls[0].payload.caption, 'pic');
  assert.equal(calls[2].payload.message_thread_id, 55);
});

test('a long turn does not hold the next update: the owner\'s permission reply and /stop get through', async () => {
  const got: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  // The daemon's handler resolves only when the queued turn ends; this one ends when the test says so.
  const tg = new TelegramAdapter({ token: '000:fake', botInfo: ME, inboxFor: () => undefined, onInbound: async (i) => { got.push(i.text); if (i.text === 'long task') await held; } });
  const batch = (tg.bot as unknown as { handleUpdates(u: Update[]): Promise<void> }).handleUpdates([dm('long task'), dm('yes 6b480a6f'), dm('/stop')]);
  const outcome = await Promise.race([batch.then(() => 'handled'), new Promise((r) => setTimeout(() => r('held behind the turn'), 1000))]);
  release();
  assert.equal(outcome, 'handled');
  assert.deepEqual(got, ['long task', 'yes 6b480a6f', '/stop'], 'in the order they came');
});

test('a handler that throws is logged, not raised out of the polling loop', async () => {
  const logs: string[] = [];
  const tg = new TelegramAdapter({ token: '000:fake', botInfo: ME, inboxFor: () => undefined, onInbound: async () => { throw new Error('boom'); }, log: (l) => logs.push(l) });
  // The polling loop's path, which is where bot.catch applies; a direct handleUpdate rethrows by design.
  await (tg.bot as unknown as { handleUpdates(u: Update[]): Promise<void> }).handleUpdates([dm('hello')]);
  assert.ok(logs.some((l) => /handler error .*boom/.test(l)), logs.join('\n'));
});

test('a message sent as a channel or by an anonymous admin is dropped: its id stands for many people', async () => {
  const { tg, got, logs } = rig();
  await tg.bot.handleUpdate(group('as the channel', { sender_chat: { id: -100, type: 'supergroup', title: 'Trip' }, from: { id: 1087968824, is_bot: true, first_name: 'Group' } }));
  await tg.bot.handleUpdate(group('linked post', { from: { id: 777000, is_bot: false, first_name: 'Telegram' } }));
  await tg.bot.handleUpdate(group('a person'));
  assert.deepEqual(got.map((i) => i.text), ['a person']);
  assert.ok(logs.some((l) => /sent-as-channel-or-anonymous-admin/.test(l)));
});

test('the command menu goes to routed chats only: the global one is cleared', async () => {
  const { tg, calls, logs } = rig();
  assert.equal(await tg.setMenu(['7', '-100', '7']), 2);
  assert.deepEqual(calls.map((c) => [c.method, (c.payload.scope as { chat_id?: number } | undefined)?.chat_id]), [['deleteMyCommands', undefined], ['setMyCommands', 7], ['setMyCommands', -100]]);
  assert.ok((calls[1].payload.commands as { command: string }[]).some((c) => c.command === 'sh'));
  assert.deepEqual(logs, []);
});
test('#35: a failed download is said to the agent, with or without a caption; so is a getFile answer with no path', async () => {
  const inbox = mkdtempSync(join(tmpdir(), 'angelia-tg-'));
  const r = rig(inbox);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
  try {
    await r.tg.bot.handleUpdate(dm('', { document: { file_id: 'f', file_unique_id: 'u', file_name: 'a.pdf', file_size: 5 }, caption: 'see' }));
    await r.tg.bot.handleUpdate(dm('', { voice: { file_id: 'v', file_unique_id: 'u2', duration: 3, file_size: 5 } }));
    await r.tg.drained();
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(r.got.map((i) => [i.text, i.media]), [['see\n[the file sent could not be downloaded]', []], ['[the file sent could not be downloaded]', []]]);
  assert.ok(r.logs.some((l) => /media download failed .*HTTP 500/.test(l)), 'the log line stays');

  const got: Inbound[] = [];
  const noPath = new TelegramAdapter({ token: '000:fake', botInfo: ME, inboxFor: () => inbox, onInbound: async (i) => { got.push(i); }, log: () => {} });
  noPath.bot.api.config.use(async (_prev, method) => (method === 'getFile' ? { ok: true, result: { file_id: 'f', file_unique_id: 'u1' } } : { ok: true, result: true }) as never);
  await noPath.bot.handleUpdate(dm('', { voice: { file_id: 'v', file_unique_id: 'u3', duration: 3, file_size: 5 } }));
  await noPath.drained();
  assert.deepEqual(got.map((i) => [i.text, i.media]), [['[the file sent could not be downloaded]', []]]);
});

test('reply facts and the bot\'s own mention: a reply to the bot\'s message is ours; a topic\'s first message is no reply; only the bot\'s @name is listed', async () => {
  const { tg, got } = rig();
  const bots = { message_id: 501, date: 1, chat: { id: -100, type: 'supergroup', title: 'Trip' }, from: { id: ME.id, is_bot: true, first_name: 'Angelia' }, text: 'a request' };
  await tg.bot.handleUpdate(group('yes', { reply_to_message: bots }));
  // In a forum topic a message that replies to nothing still names the topic's first message.
  await tg.bot.handleUpdate(group('yes', { message_thread_id: 55, is_topic_message: true, reply_to_message: { ...bots, message_id: 55, forum_topic_created: { name: 'Plans', icon_color: 1 } } }));
  await tg.bot.handleUpdate(group('yes', { message_thread_id: 55, is_topic_message: true, reply_to_message: { ...bots, message_id: 77 } }));
  await tg.bot.handleUpdate(group('@ann @Angelia_BOT yes', { entities: [{ type: 'mention', offset: 0, length: 4 }, { type: 'mention', offset: 5, length: 12 }] }));
  await tg.bot.handleUpdate(group('@ann yes', { entities: [{ type: 'mention', offset: 0, length: 4 }] }));
  assert.deepEqual(got.map((i) => i.reply), [{ id: '501', ours: true }, undefined, { id: '77', ours: true }, undefined, undefined]);
  assert.deepEqual(got.map((i) => i.botMentions), [undefined, undefined, undefined, ['@Angelia_BOT'], undefined]);
});

/**
 * The adapter in front of an orchestrator whose chat asks for permission (tests/asker.ts): what the Bot
 * API was sent, and a way to wait for it. Messages the bot sends get ids from 501 and Telegram's date
 * for them (`lineDate`, in seconds; default two seconds behind this machine's clock, as a platform a
 * little behind would give).
 */
async function asking(t: { after(fn: () => unknown): void }, opts: Record<string, unknown> = {}, rigged: { route?: Record<string, unknown>; chatKind?: string; lineDate?: () => number; hold?: Promise<void> } = {}) {
  const { Config } = await import('../src/instance/config/schema.js');
  const { Orchestrator } = await import('../src/core/orchestrator.js');
  const { asker, openAsks } = await import('./asker.js');
  const calls: { method: string; payload: Record<string, any> }[] = [];
  const logs: string[] = [];
  let o: InstanceType<typeof Orchestrator> | undefined;
  const tg = new TelegramAdapter({ token: '000:fake', botInfo: ME, inboxFor: () => undefined, onInbound: (i) => o!.handle(i), onPress: (i, id, allow) => o!.pressed(i, id, allow), log: (l) => logs.push(l) });
  const route = { platform: 'telegram', chat: -100, profile: 'a', mention: 'required', owners: ['7'], allow_from: ['*'], ...rigged.route };
  let sentId = 500;
  tg.bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    if (method === 'sendMessage') {
      if (rigged.hold && String((payload as { text: string }).text).startsWith('🔐')) await rigged.hold;
      return { ok: true, result: { message_id: ++sentId, date: (rigged.lineDate ?? (() => Math.floor(Date.now() / 1000) - 2))(), chat: { id: route.chat, type: 'supergroup', title: 'Trip' } } } as never;
    }
    if (method === 'getChat') return { ok: true, result: { id: route.chat, type: rigged.chatKind ?? 'supergroup', title: 'Trip' } } as never;
    return { ok: true, result: true } as never;
  });
  const cfg = Config.parse({ profiles: { a: { cwd: mkdtempSync(join(tmpdir(), 'angelia-tg-ask-')) } }, routes: [route], defaults: { max_out_per_min: 1000 } });
  o = new Orchestrator(cfg, { telegram: tg }, { stateDir: mkdtempSync(join(tmpdir(), 'angelia-tg-orch-')), bareAnswerMinMs: 0, log: (l) => logs.push(l), ...opts });
  t.after(async () => { await o!.shutdown(); await tg.stop(); });
  const key = `telegram:${route.chat}`;
  const f = asker(o, key);
  const texts = () => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.payload.text));
  const until = async (cond: () => boolean, what: string) => {
    const end = Date.now() + 5000;
    while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 5)); }
  };
  const open = () => openAsks(o!, key);
  return { tg, o, f, calls, logs, texts, until, open };
}
const A = 'aaaa1111-0000-4000-8000-000000000001', B = 'bbbb2222-0000-4000-8000-000000000002';
const LINE = { [A]: '🔐 Bash: touch aaaa\nReply "yes" or "no". (request aaaa1111)', [B]: '🔐 Bash: touch bbbb\nReply "yes" or "no". (request bbbb2222)' };
const SAM = { id: 7, is_bot: false, first_name: 'Sam' }, ANN = { id: 9, is_bot: false, first_name: 'Ann' };
const nowSec = () => Math.floor(Date.now() / 1000);
/** A message that names the bot, dated now by Telegram unless said otherwise. */
const toBot = (text: string, date = nowSec() + 1) => group(`@Angelia_bot ${text}`, { date, entities: [{ type: 'mention', offset: 0, length: 12 }] });
/** A reply to message `id` of this chat, as Telegram sends it: the message replied to rides along whole. */
const replyTo = (text: string, id: number, quoted: string, extra: Record<string, unknown> = {}, author: Record<string, unknown> = { id: ME.id, is_bot: true, first_name: 'Angelia' }) =>
  group(text, { date: nowSec() + 1, reply_to_message: { message_id: id, date: 1, chat: { id: -100, type: 'supergroup', title: 'Trip' }, from: author, text: quoted }, ...extra });
/** A press on a button under message `message` of the bot's, as Telegram sends it. */
const press = (data: string | undefined, from: Record<string, unknown> = SAM, message = 501, chat: Record<string, unknown> = { id: -100, type: 'supergroup', title: 'Trip' }): Update =>
  ({ update_id: ++n, callback_query: { id: `cq${n}`, from, chat_instance: 'ci', ...(data === undefined ? {} : { data }), message: { message_id: message, date: 1, chat, from: { id: ME.id, is_bot: true, first_name: 'Angelia' }, text: 'a request' } } } as unknown as Update);
const of = (calls: { method: string; payload: Record<string, any> }[], method: string) => calls.filter((c) => c.method === method).map((c) => c.payload);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a reply "yes" answers the request whose message it replies to, by that message\'s id, through grammY\'s own update path; a reply to anything else is a message for the agent', async (t) => {
  const { tg, f, texts, until, open } = await asking(t);
  await tg.bot.handleUpdate(toBot(`ASK:${A},${B}`));
  await until(() => texts().length === 2, 'two request lines');
  assert.deepEqual(texts(), [LINE[A], LINE[B]]);
  // Not answers, each a message for the agent behind the running turn: a member who is no owner
  // replies yes to B's line; the owner replies yes to a person's message that quotes B's line word
  // for word; to another message of the bot's; to B's line's id under another author.
  await tg.bot.handleUpdate(replyTo('yes', 502, LINE[B], { from: ANN }));
  await tg.bot.handleUpdate(replyTo('@Angelia_bot yes', 400, LINE[B], { entities: [{ type: 'mention', offset: 0, length: 12 }] }, ANN));
  await tg.bot.handleUpdate(replyTo('yes', 499, 'Shall I book the table for 8?'));
  await tg.bot.handleUpdate(replyTo('@Angelia_bot yes', 502, LINE[B], { entities: [{ type: 'mention', offset: 0, length: 12 }] }, ANN));
  await tg.drained();
  await pause(30);
  assert.deepEqual(f.answers, []);
  assert.deepEqual(texts(), [LINE[A], LINE[B]], 'and nothing was said about them');
  // The owner replies to B's line, quoting only a part of it that names nothing: B, by the message.
  await tg.bot.handleUpdate(replyTo('yes', 502, LINE[B], { quote: { text: 'touch', position: 9 } }));
  await until(() => f.answers.length === 1, 'the answer');
  assert.deepEqual(f.answers, [[B, true]]);
  assert.deepEqual(open(), [A]);
  await tg.bot.handleUpdate(replyTo('לא', 501, LINE[A]));
  await until(() => f.turns.length === 5, 'the four that were no answers, as turns after the turn');
  assert.deepEqual(f.answers, [[B, true], [A, false]]);
  assert.ok(f.turns.slice(1).every((x) => x.endsWith('yes')), f.turns.join(' | '));
});

test('a bare answer is held to Telegram\'s own clock: the request\'s line by the date its send returned, the answer by its message\'s date; "@someone yes" is said to someone', async (t) => {
  const { READ_FIRST_LINE } = await import('../src/core/deliver/text.js');
  // Telegram's clock is 100 s behind this machine's: by ours the line would look long read.
  const line = nowSec() - 100;
  const { tg, f, texts, until, logs } = await asking(t, { bareAnswerMinMs: undefined }, { lineDate: () => line });
  await tg.bot.handleUpdate(toBot(`ASK:${A}`));
  await until(() => texts().length === 1, 'the request line');
  // "@ann @Angelia_bot yes" reaches the agent (it names the bot) and is no answer (it names Ann).
  await tg.bot.handleUpdate(group('@ann @Angelia_bot yes', { date: line + 30, entities: [{ type: 'mention', offset: 0, length: 4 }, { type: 'mention', offset: 5, length: 12 }] }));
  // Dated two seconds after the line: not read yet.
  await tg.bot.handleUpdate(toBot('yes', line + 2));
  await until(() => texts().at(-1) === READ_FIRST_LINE, 'the read-it-first line');
  // Dated in the line's own second plus three: the line's second may have been at its end.
  await tg.bot.handleUpdate(toBot('yes', line + 3));
  await until(() => texts().filter((x) => x === READ_FIRST_LINE).length === 2, 'the second read-it-first line');
  assert.deepEqual(f.answers, []);
  assert.equal(logs.filter((l) => l.includes('reason=request-just-posted id=aaaa1111')).length, 2, logs.join('\n'));
  await tg.bot.handleUpdate(toBot('yes', line + 4));
  await until(() => f.answers.length === 1, 'the answer');
  assert.deepEqual(f.answers, [[A, true]]);
  await until(() => texts().includes('Allowed: Bash: touch aaaa (request aaaa1111)'), 'what the bare word was taken for');
  await until(() => f.turns.length === 2, 'the word said to Ann, as a turn');
  assert.match(f.turns[1], /@ann @Angelia_bot yes$/);
});

test('a permission request goes out with Yes and No buttons; the owner\'s press answers it and the buttons go; anyone else\'s, a forged one and one too soon do not', async (t) => {
  const { NOT_OWNER_LINE, BUTTON_GONE_LINE, READ_FIRST_LINE } = await import('../src/core/deliver/text.js');
  const { tg, f, calls, logs, texts, until, open } = await asking(t, { bareAnswerMinMs: 150 });
  await tg.bot.handleUpdate(toBot(`ASK:${A}`));
  await until(() => texts().length === 1, 'the request line');
  const sent = of(calls, 'sendMessage')[0];
  assert.equal(sent.text, LINE[A], 'the text still says how to answer by typing');
  assert.deepEqual(sent.reply_markup, { inline_keyboard: [[{ text: 'Yes', callback_data: 'ask:y:aaaa1111' }, { text: 'No', callback_data: 'ask:n:aaaa1111' }]] });
  const answers = () => of(calls, 'answerCallbackQuery').map((p) => p.text);
  const pressed = async (u: Update) => { const n0 = answers().length; await tg.bot.handleUpdate(u); await until(() => answers().length === n0 + 1, 'the press answered'); return answers().at(-1); };
  // The owner, at once: a second request can take the first one's place under a finger.
  assert.equal(await pressed(press('ask:y:aaaa1111')), READ_FIRST_LINE);
  await pause(170);
  // A member who is no owner: told so in the press's own answer.
  assert.equal(await pressed(press('ask:y:aaaa1111', ANN)), NOT_OWNER_LINE);
  // An anonymous admin stands for many people. Data that is not one of this message's two buttons: of
  // some other kind, none, another request's id, a shorter id that a prefix match would take.
  assert.equal(await pressed(press('ask:y:aaaa1111', { id: 1087968824, is_bot: true, first_name: 'Group' })), undefined);
  for (const data of ['yes aaaa1111', undefined, 'ask:y:zzzz9999', 'ask:y:a', 'ask:y:aaaa111', 'ask:y:aaaa1111-0000']) assert.equal(await pressed(press(data, data === 'ask:y:a' ? ANN : SAM)), undefined, String(data));
  assert.deepEqual(f.answers, []);
  assert.deepEqual(open(), [A]);
  assert.deepEqual(of(calls, 'editMessageReplyMarkup'), [], 'the open request keeps its buttons through all of it');
  assert.equal(logs.filter((l) => l === 'telegram: drop press chat=-100 reason=not-this-message\'s-button').length, 3, logs.join('\n'));
  // The owner presses No: the press's own answer says what was denied.
  assert.equal(await pressed(press('ask:n:aaaa1111')), 'Denied: Bash: touch aaaa');
  await until(() => texts().at(-1) === 'done: aaaa=no', 'the turn\'s answer');
  assert.deepEqual(f.answers, [[A, false]]);
  assert.deepEqual(texts(), [LINE[A], 'done: aaaa=no'], 'no line in the chat for a press');
  assert.deepEqual(of(calls, 'editMessageReplyMarkup'), [{ chat_id: '-100', message_id: 501, reply_markup: { inline_keyboard: [] } }], 'the buttons went, once');
  // Buttons still on some screen, or from before a restart: nothing is answered, no turn starts, they go.
  assert.equal(await pressed(press('ask:y:aaaa1111')), BUTTON_GONE_LINE);
  assert.equal(await pressed(press('ask:y:cccc3333', SAM, 444)), BUTTON_GONE_LINE);
  await until(() => of(calls, 'editMessageReplyMarkup').length === 3, 'the stale buttons removed');
  assert.deepEqual(f.answers, [[A, false]]);
  assert.equal(f.turns.length, 1, 'a press is never a message for the agent');
  // Unknown buttons go only for someone a routed chat hears. A stranger pressing in a chat that is not
  // routed, as often as they like, gets the bare answer every press gets and no other Bot API call.
  const before = calls.length;
  for (let k = 0; k < 5; k++) assert.equal(await pressed(press('ask:y:cccc3333', { id: 666, is_bot: false, first_name: 'Stranger' }, 9, { id: -999, type: 'supergroup', title: 'Elsewhere' })), undefined);
  assert.deepEqual(calls.slice(before).map((c) => c.method), Array(5).fill('answerCallbackQuery'));
  assert.equal(of(calls, 'editMessageReplyMarkup').length, 3);
});

test('unknown buttons in a routed chat go only at a press by someone the chat hears', async (t) => {
  const { BUTTON_GONE_LINE } = await import('../src/core/deliver/text.js');
  // This group hears its owner only (no allow_from).
  const { tg, calls, until } = await asking(t, {}, { route: { allow_from: [] } });
  const answers = () => of(calls, 'answerCallbackQuery').map((p) => p.text);
  await tg.bot.handleUpdate(press('ask:y:cccc3333', ANN, 444));
  await until(() => answers().length === 1, 'the member\'s press answered');
  assert.deepEqual(answers(), [undefined]);
  assert.deepEqual(of(calls, 'editMessageReplyMarkup'), []);
  await tg.bot.handleUpdate(press('ask:y:cccc3333', SAM, 444));
  await until(() => of(calls, 'editMessageReplyMarkup').length === 1, 'the owner\'s press removed them');
  assert.deepEqual(answers(), [undefined, BUTTON_GONE_LINE]);
  assert.deepEqual(of(calls, 'editMessageReplyMarkup'), [{ chat_id: '-100', message_id: 444, reply_markup: { inline_keyboard: [] } }]);
});

test('a channel gets no buttons, and a press there is nobody\'s yes: every subscriber is not an owner', async (t) => {
  const { NOT_OWNER_LINE } = await import('../src/core/deliver/text.js');
  // A channel routed for a job's lines: nobody writes there, a scheduled turn asks.
  const { tg, o, f, calls, until, open } = await asking(t, {}, { route: { chat: -1005 }, chatKind: 'channel' });
  const turn = o.injectTurn('telegram:-1005', `ASK:${A}`, false, undefined, 'job nightly');
  await until(() => of(calls, 'sendMessage').length === 1, 'the request line in the channel');
  assert.equal(of(calls, 'sendMessage')[0].reply_markup, undefined, 'no buttons');
  assert.deepEqual(of(calls, 'getChat'), [{ chat_id: '-1005' }], 'the chat\'s kind was asked of Telegram');
  const channel = { id: -1005, type: 'channel', title: 'Job log' };
  await tg.bot.handleUpdate(press('ask:y:aaaa1111', { id: 666, is_bot: false, first_name: 'Subscriber' }, 501, channel));
  await until(() => of(calls, 'answerCallbackQuery').length === 1, 'the press answered');
  assert.deepEqual(f.answers, [], 'nothing approved');
  assert.deepEqual(open(), [A]);
  // And were there buttons on a channel's message, the one who pressed is held to the owners list: a
  // channel is no private chat, where the chat's own user is the owner.
  assert.deepEqual(o.pressed({ platform: 'telegram', chat: '-1005', sender: '666', isGroup: true }, A, true), { text: NOT_OWNER_LINE, over: false });
  f.end();
  await turn;
});

test('a press in a chat that is not private is held to the owners list whatever kind the chat is', async (t) => {
  const { NOT_OWNER_LINE } = await import('../src/core/deliver/text.js');
  const { tg, f, calls, texts, until } = await asking(t);
  await tg.bot.handleUpdate(toBot(`ASK:${A}`));
  await until(() => texts().length === 1, 'the request line');
  // The message with the buttons is in a chat Telegram calls a channel.
  await tg.bot.handleUpdate(press('ask:y:aaaa1111', ANN, 501, { id: -100, type: 'channel', title: 'Trip' }));
  await until(() => of(calls, 'answerCallbackQuery').length === 1, 'the press answered');
  assert.equal(of(calls, 'answerCallbackQuery')[0].text, NOT_OWNER_LINE);
  assert.deepEqual(f.answers, []);
  await tg.bot.handleUpdate(press('ask:y:aaaa1111', SAM, 501, { id: -100, type: 'channel', title: 'Trip' }));
  await until(() => f.answers.length === 1, 'the owner\'s press');
});

test('a press while a request\'s line is still on its way out removes nothing: its message is not known yet', async (t) => {
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  const { tg, f, calls, texts, until } = await asking(t, {}, { hold });
  await tg.bot.handleUpdate(toBot(`ASK:${A}`));
  await until(() => texts().length === 1, 'the send started');
  // Telegram already shows message 501 to the chat; this adapter has not heard its id yet.
  await tg.bot.handleUpdate(press('ask:y:aaaa1111'));
  await until(() => of(calls, 'answerCallbackQuery').length === 1, 'the press answered');
  assert.equal(of(calls, 'answerCallbackQuery')[0].text, undefined);
  assert.deepEqual(of(calls, 'editMessageReplyMarkup'), []);
  release();
  await pause(30);
  await tg.bot.handleUpdate(press('ask:y:aaaa1111'));
  await until(() => f.answers.length === 1, 'the press after the send');
  assert.deepEqual(f.answers, [[A, true]]);
});

test('the buttons go when the request is answered by typing, and when its turn ends with it still open; a failed removal is only logged', async (t) => {
  const { tg, f, calls, logs, texts, until, open } = await asking(t);
  tg.bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === 'editMessageReplyMarkup' && (payload as { message_id: number }).message_id === 502) return { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' } as never;
    return prev(method, payload, signal);
  });
  await tg.bot.handleUpdate(toBot(`ASK:${A},${B}`));
  await until(() => texts().length === 2, 'two request lines');
  assert.deepEqual(of(calls, 'sendMessage').map((p) => p.reply_markup.inline_keyboard[0][0].callback_data), ['ask:y:aaaa1111', 'ask:y:bbbb2222']);
  await tg.bot.handleUpdate(toBot('yes aaaa1111'));
  await until(() => f.answers.length === 1, 'the typed answer');
  await until(() => of(calls, 'editMessageReplyMarkup').length === 1, 'the answered request\'s buttons removed');
  assert.deepEqual(of(calls, 'editMessageReplyMarkup')[0], { chat_id: '-100', message_id: 501, reply_markup: { inline_keyboard: [] } });
  assert.deepEqual(open(), [B]);
  // The turn ends with B never answered (a /stop, a crash).
  f.end();
  await until(() => texts().at(-1) === 'done: aaaa=yes', 'the turn\'s end');
  await until(() => logs.some((l) => l.startsWith('telegram: buttons not removed chat=-100: ')), 'the logged failure');
  assert.deepEqual(open(), []);
  assert.match(logs.find((l) => l.startsWith('telegram: buttons not removed'))!, /message to edit not found/);
});
