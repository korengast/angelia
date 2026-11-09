import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeJid, bareId, isGroupJid, LidMap } from '../src/adapters/whatsapp/ids.js';
import { parseMessage, toInbound, messageContent, withMentions, MAX_MENTIONS } from '../src/adapters/whatsapp/parse.js';

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
  // The way back, for tagging a member the group lists by lid only.
  assert.equal(m.lidFor('15551111111'), '22222222222222');
  assert.equal(m.lidFor('15559999999'), undefined);
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


test('withMentions: phone or lid tags the member by their id; strangers stay text', () => {
  const members = [
    { id: '15550002222@lid', phoneNumber: '15550003333@s.whatsapp.net' },
    { id: '15550001111@s.whatsapp.net' },
  ];
  const r = withMentions('hi @15550003333 and @+15550001111, not @999999999, email a@b.c', members);
  assert.equal(r.text, 'hi @15550002222 and @15550001111, not @999999999, email a@b.c');
  assert.deepEqual(r.mentions, ['15550002222@lid', '15550001111@s.whatsapp.net']);
  assert.deepEqual(withMentions('@15550002222 @15550002222', members).mentions, ['15550002222@lid']);
  assert.deepEqual(withMentions('no tags', members).mentions, []);
});

test('withMentions: a lid token tags a LID-group member; a PN-mode group rewrites a lid token to the phone id', () => {
  // LID group: id is the lid, the phone only when the server sent it.
  assert.deepEqual(withMentions('@22222222222222 hi', [{ id: '22222222222222@lid' }]), { text: '@22222222222222 hi', mentions: ['22222222222222@lid'], capped: 0 });
  // PN-mode group: id is the phone, the lid rides along.
  const pn = [{ id: '15550004444@s.whatsapp.net', lid: '33333333333333@lid' }];
  assert.deepEqual(withMentions('cc @33333333333333', pn), { text: 'cc @15550004444', mentions: ['15550004444@s.whatsapp.net'], capped: 0 });
});

test('withMentions: a device suffix in the id is dropped; a shorter or longer number is no match', () => {
  const members = [{ id: '15550001111:7@s.whatsapp.net' }];
  assert.deepEqual(withMentions('@15550001111', members).mentions, ['15550001111@s.whatsapp.net']);
  for (const t of ['@1555000111', '@155500011112', '@15550001111222233334444', '@1555']) {
    const r = withMentions(t, members);
    assert.deepEqual(r, { text: t, mentions: [], capped: 0 }, t);
  }
});

test('withMentions: a number in a URL, an email address or code is left as written', () => {
  const members = [{ id: '15550001111@s.whatsapp.net' }];
  for (const t of [
    'see https://x.com/@15550001111 now',
    'mail foo@15550001111.example.com',
    'mail a@15550001111',
    'host @15550001111.example.com',
    'run `@15550001111` here',
    'block:\n```\nping @15550001111\n```\ndone',
    'open fence ```\n@15550001111',
    'word@15550001111',
  ]) assert.deepEqual(withMentions(t, members), { text: t, mentions: [], capped: 0 }, t);
  // Next to code and punctuation it still tags.
  const r = withMentions('`x` (@15550001111), and @15550001111.', members);
  assert.equal(r.text, '`x` (@15550001111), and @15550001111.');
  assert.deepEqual(r.mentions, ['15550001111@s.whatsapp.net']);
});

test('withMentions: a phone the group hides becomes the member\'s lid through the lid map, never shown', () => {
  // The header showed the phone (from the lid map); the server listed the member by lid only.
  const members = [{ id: '44444444444444@lid' }];
  const lidFor = (n: string) => (n === '15550005555' ? '44444444444444' : undefined);
  assert.deepEqual(withMentions('thanks @+15550005555', members, { lidFor }), { text: 'thanks @44444444444444', mentions: ['44444444444444@lid'], capped: 0 });
  // Without the map the number stays as written: no tag, nothing made up.
  assert.deepEqual(withMentions('thanks @15550005555', members).mentions, []);
  // A known lid that is no member of this group is no match either.
  assert.deepEqual(withMentions('@15550005555', [{ id: '55555555555555@lid' }], { lidFor }).mentions, []);
});

test('withMentions: at most MAX_MENTIONS members; tokens past the cap stay as written, repeats of a tagged one still tag', () => {
  const members = Array.from({ length: 8 }, (_, n) => ({ id: `1555000000${n}@s.whatsapp.net` }));
  const text = members.map((m) => `@${m.id.slice(0, 11)}`).join(' ') + ' and again @15550000000';
  const r = withMentions(text, members);
  assert.equal(MAX_MENTIONS, 5);
  assert.equal(r.mentions.length, 5);
  assert.equal(r.capped, 3);
  assert.equal(r.text, text, 'every token is already the id form, so the text is the same');
  // With a + the cut is visible: the first five lose it, the rest keep it.
  const plus = withMentions(members.map((m) => `@+${m.id.slice(0, 11)}`).join(' '), members);
  assert.equal(plus.text, members.map((m, n) => `@${n < 5 ? '' : '+'}${m.id.slice(0, 11)}`).join(' '));
  assert.equal(withMentions(text, members, { max: 2 }).mentions.length, 2);
});

test('#34: stacked wrappers are all peeled: a captioned document in a disappearing chat, a view-once voice note', () => {
  const nested = group({ ephemeralMessage: { message: { documentWithCaptionMessage: { message: { documentMessage: { caption: 'the plan', fileName: 'plan.pdf', mimetype: 'application/pdf', fileLength: 12 } } } } } });
  const p = parseMessage(nested, US)!;
  assert.ok(p, 'two wrappers: still a turn');
  assert.equal(p.text, 'the plan');
  assert.equal(p.media?.kind, 'document');
  assert.equal(p.media?.fileName, 'plan.pdf');
  const voice = parseMessage(group({ ephemeralMessage: { message: { viewOnceMessageV2Extension: { message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', fileLength: 3 } } } } } }), US)!;
  assert.equal(voice.media?.kind, 'audio');
  assert.deepEqual(messageContent({ key: {}, message: { viewOnceMessageV2: { message: { ephemeralMessage: { message: { imageMessage: {} } } } } } }), { imageMessage: {} });
  // A wrapper with nothing inside stays as it is, and the parser treats it as not a turn.
  assert.deepEqual(messageContent({ key: {}, message: { ephemeralMessage: {} } }), { ephemeralMessage: {} });
});
