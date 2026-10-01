import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WAMessage } from 'baileys';
import { SentMessages } from '../src/adapters/whatsapp/sent.js';
import { WhatsAppAdapter } from '../src/adapters/whatsapp/adapter.js';
import type { Media } from '../src/core/deliver/media.js';

const { MAX, TTL_MS } = SentMessages;
const sent = (id: string | undefined, text: string | null = `text of ${id}`) =>
  ({ key: { remoteJid: '15550000000@s.whatsapp.net', fromMe: true, id }, message: text === null ? undefined : { conversation: text } }) as WAMessage;
const clock = () => { let t = 1_000_000; return { now: () => t, move: (ms: number) => { t += ms; } }; };

test('remembers a sent message and returns it by id', () => {
  const s = new SentMessages();
  s.remember(sent('A1'));
  assert.deepEqual(s.get('A1'), { conversation: 'text of A1' });
});

test('an unknown id, or no id at all, returns undefined, never a blank message', () => {
  const s = new SentMessages();
  s.remember(sent('A1'));
  assert.equal(s.get('NOPE'), undefined);
  assert.equal(s.get(undefined), undefined);
  assert.equal(s.get(null), undefined);
  assert.equal(s.get(''), undefined);
});

test('a send result with no id, no message, or nothing at all is ignored', () => {
  const s = new SentMessages();
  s.remember(undefined);
  s.remember(sent(undefined));
  s.remember(sent('NOMSG', null));
  assert.equal(s.size, 0);
  assert.equal(s.get('NOMSG'), undefined);
});

test('a message expires at the TTL: there one ms before, gone at it', () => {
  const c = clock();
  const s = new SentMessages(c.now);
  s.remember(sent('A1'));
  c.move(TTL_MS - 1);
  assert.deepEqual(s.get('A1'), { conversation: 'text of A1' });
  c.move(1);
  assert.equal(s.get('A1'), undefined);
});

test('expired entries are dropped on the next remember', () => {
  const c = clock();
  const s = new SentMessages(c.now);
  for (let i = 0; i < 10; i++) s.remember(sent(`OLD${i}`));
  c.move(TTL_MS);
  s.remember(sent('NEW'));
  assert.equal(s.size, 1);
  assert.deepEqual(s.get('NEW'), { conversation: 'text of NEW' });
});

test('beyond MAX the oldest go and the newest stay', () => {
  const c = clock();
  const s = new SentMessages(c.now);
  for (let i = 0; i < MAX + 3; i++) { s.remember(sent(`M${i}`)); c.move(1); }
  assert.equal(s.size, MAX);
  for (const i of [0, 1, 2]) assert.equal(s.get(`M${i}`), undefined);
  assert.deepEqual(s.get('M3'), { conversation: 'text of M3' });
  assert.deepEqual(s.get(`M${MAX + 2}`), { conversation: `text of M${MAX + 2}` });
});

test('remembering the same id again replaces it and does not grow', () => {
  const s = new SentMessages();
  s.remember(sent('A1', 'first'));
  s.remember(sent('A1', 'second'));
  assert.equal(s.size, 1);
  assert.deepEqual(s.get('A1'), { conversation: 'second' });
});

test('after 10 x MAX inserts the size never passed MAX', () => {
  const s = new SentMessages();
  let peak = 0;
  for (let i = 0; i < 10 * MAX; i++) { s.remember(sent(`X${i}`)); peak = Math.max(peak, s.size); }
  assert.equal(peak, MAX);
  assert.equal(s.size, MAX);
});

test('the adapter remembers every kind it sends: text, image, video, voice note, document', async () => {
  const a = new WhatsAppAdapter({ authDir: mkdtempSync(join(tmpdir(), 'angelia-wa-sent-')), pairing: 'qr', inboxFor: () => undefined, onInbound: async () => {} });
  let n = 0;
  const fake = { sendMessage: async (jid: string, content: Record<string, unknown>) => ({ key: { remoteJid: jid, fromMe: true, id: `ID${++n}` }, message: { fake: content } }) };
  Object.assign(a as unknown as Record<string, unknown>, { sock: fake, state: 'connected' });
  const chat = '120363000000000001@g.us';
  const media = (kind: Media['kind'], path: string): Media => ({ kind, path, mime: 'application/octet-stream', bytes: 1, fileName: path.split('/').pop()! });
  await a.send(chat, 'hello');
  await a.sendMedia(chat, media('image', '/x/a.jpg'));
  await a.sendMedia(chat, media('video', '/x/a.mp4'));
  await a.sendMedia(chat, media('audio', '/x/a.ogg')); // already opus: no conversion
  await a.sendMedia(chat, media('document', '/x/a.pdf'));
  const kept = (a as unknown as { sent: SentMessages }).sent;
  assert.equal(kept.size, 5);
  assert.deepEqual(kept.get('ID1'), { fake: { text: 'hello' } });
  assert.ok((kept.get('ID4') as Record<string, any>).fake.ptt);
  assert.ok((kept.get('ID5') as Record<string, any>).fake.document);
});
