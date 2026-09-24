import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeJid, bareId, isGroupJid, LidMap } from '../src/adapters/whatsapp/ids.js';
import { parseMessage, toInbound, messageContent } from '../src/adapters/whatsapp/parse.js';

const US = ['15550000000:12@s.whatsapp.net', '11111111111111:3@lid'];
const group = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ key: { remoteJid: '120363000000000001@g.us', fromMe: false, participant: '22222222222222@lid', id: 'ABC' }, pushName: 'Someone', message, ...extra });

test('jid helpers strip device suffixes and know groups', () => {
  assert.equal(normalizeJid('15550000000:12@s.whatsapp.net'), '15550000000@s.whatsapp.net');
  assert.equal(normalizeJid('11111111111111:3@lid'), '11111111111111@lid');
  assert.equal(bareId('15550000000:12@s.whatsapp.net'), '15550000000');
  assert.ok(isGroupJid('1@g.us')); assert.ok(!isGroupJid('1@s.whatsapp.net'));
});

test('LidMap reads Baileys lid-mapping files and falls back to the bare id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-wa-'));
  writeFileSync(join(dir, 'lid-mapping-15551111111.json'), JSON.stringify('22222222222222@lid'));
  const m = new LidMap(dir);
  assert.equal(m.phoneFor('22222222222222:5@lid'), '15551111111');
  assert.equal(m.phoneFor('33333333333333@lid'), '33333333333333');
  assert.equal(m.phoneFor('15559999999@s.whatsapp.net'), '15559999999');
});

test('parse: text, mention by jid or by lid, reply to us, caption media, ignored kinds', () => {
  const plain = parseMessage(group({ conversation: 'hello' }), US)!;
  assert.deepEqual(plain, { chat: '120363000000000001@g.us', sender: '22222222222222@lid', senderName: 'Someone', text: 'hello', isGroup: true, mentioned: false, media: undefined });
  const byPhone = parseMessage(group({ extendedTextMessage: { text: '@bot hi', contextInfo: { mentionedJid: ['15550000000@s.whatsapp.net'] } } }), US)!;
  assert.equal(byPhone.mentioned, true);
  const byLid = parseMessage(group({ extendedTextMessage: { text: '@bot hi', contextInfo: { mentionedJid: ['11111111111111@lid'] } } }), US)!;
  assert.equal(byLid.mentioned, true);
  const reply = parseMessage(group({ extendedTextMessage: { text: 'yes', contextInfo: { participant: '15550000000:12@s.whatsapp.net', quotedMessage: { conversation: 'x' } } } }), US)!;
  assert.equal(reply.mentioned, true);
  const other = parseMessage(group({ extendedTextMessage: { text: 'no', contextInfo: { mentionedJid: ['5@s.whatsapp.net'] } } }), US)!;
  assert.equal(other.mentioned, false);
  const img = parseMessage(group({ imageMessage: { caption: 'look', mimetype: 'image/jpeg' } }), US)!;
  assert.equal(img.text, 'look'); assert.equal(img.media?.kind, 'image');
  const wrapped = parseMessage(group({ ephemeralMessage: { message: { conversation: 'vanishing' } } }), US)!;
  assert.equal(wrapped.text, 'vanishing');
  assert.equal(parseMessage(group({ reactionMessage: { text: '👍' } }), US), null);
  assert.equal(parseMessage(group({ protocolMessage: { type: 0 } }), US), null);
  assert.equal(parseMessage(group({ conversation: 'me' }, { key: { remoteJid: '1@g.us', fromMe: true } }), US), null);
  assert.equal(parseMessage({ key: { remoteJid: 'status@broadcast' }, message: { conversation: 'x' } }, US), null);
  const dm = parseMessage({ key: { remoteJid: '15551111111@s.whatsapp.net', fromMe: false }, pushName: 'P', message: { conversation: 'dm' } }, US)!;
  assert.equal(dm.isGroup, false); assert.equal(dm.sender, '15551111111@s.whatsapp.net');
  assert.deepEqual(messageContent({ key: {}, message: { viewOnceMessageV2: { message: { imageMessage: {} } } } }), { imageMessage: {} });
});

test('toInbound writes the sender the way routing.yaml expects', () => {
  const p = parseMessage(group({ conversation: 'hi' }), US)!;
  const i = toInbound(p, '15551111111', ['/x/.inbox/a.jpg']);
  assert.equal(i.platform, 'whatsapp'); assert.equal(i.sender, '15551111111'); assert.deepEqual(i.media, ['/x/.inbox/a.jpg']);
});

test('media size: read from fileLength in every shape Baileys uses, before any download', async () => {
  const { byteLength } = await import('../src/adapters/whatsapp/parse.js');
  assert.equal(byteLength(123), 123);
  assert.equal(byteLength('456'), 456);
  assert.equal(byteLength({ low: 5, high: 1, unsigned: true }), 2 ** 32 + 5);
  assert.equal(byteLength({ low: -1, high: 0 }), 2 ** 32 - 1);
  assert.equal(byteLength(undefined), undefined);
  assert.equal(byteLength('12x'), undefined);
  const big = parseMessage({ key: { remoteJid: '15551230000@s.whatsapp.net', id: 'D1' }, message: { documentMessage: { fileName: 'a.zip', mimetype: 'application/zip', fileLength: { low: 0, high: 1 } } } }, US)!;
  assert.equal(big.media?.size, 2 ** 32);
});

test('a message id is handed on once, however often it is delivered; old ids fall out', async () => {
  const { SeenIds } = await import('../src/adapters/whatsapp/parse.js');
  const s = new SeenIds(2);
  assert.equal(s.first('c/1'), true);
  assert.equal(s.first('c/1'), false);
  assert.equal(s.first('d/1'), true); // same id in another chat is another message
  assert.equal(s.first('c/2'), true); // pushes c/1 out
  assert.equal(s.first('c/1'), true);
});

