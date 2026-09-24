import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, mkdtempSync, readFileSync } from 'node:fs';
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
});

test('mentioned: an @mention of the bot (any case) or a reply to it; another bot\'s name is not', async () => {
  const { tg, got } = rig();
  await tg.bot.handleUpdate(group('@angelia_BOT what now', { entities: [{ type: 'mention', offset: 0, length: 12 }] }));
  await tg.bot.handleUpdate(group('@other_bot what now', { entities: [{ type: 'mention', offset: 0, length: 10 }] }));
  await tg.bot.handleUpdate(group('yes', { reply_to_message: { message_id: 1, date: 1, chat: { id: -100, type: 'supergroup', title: 'Trip' }, from: { id: ME.id, is_bot: true, first_name: 'Angelia' } } }));
  await tg.bot.handleUpdate(group('yes', { reply_to_message: { message_id: 1, date: 1, chat: { id: -100, type: 'supergroup', title: 'Trip' }, from: { id: 9, is_bot: false, first_name: 'Ann' } } }));
  assert.deepEqual(got.map((i) => i.mentioned), [true, false, true, false]);
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
