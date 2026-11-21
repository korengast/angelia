import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WhatsAppAdapter, type WhatsAppAdapterOptions } from '../src/adapters/whatsapp/adapter.js';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import type { Inbound } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, 'fake-claude.mjs');
const GROUP = '120363000000000001@g.us';
const US = { id: '15550000000:12@s.whatsapp.net', lid: '11111111111111:3@lid' };

/** The slice of a Baileys socket the adapter uses. Nothing here touches the network or pairs. */
class FakeSocket {
  ev = new EventEmitter();
  user = US;
  sent: { jid: string; content: Record<string, any> }[] = [];
  presence: [string, string][] = [];
  codes: string[] = [];
  ended = 0;
  loggedOut = 0;
  private n = 0;
  /** The member lists asked for, by group, and a failure to give one: the send() tests read them. */
  fetches: string[] = [];
  members: Record<string, { id: string; lid?: string; phoneNumber?: string }[]> = {};
  failFetch?: Error;
  constructor(readonly config: Record<string, any>, private readonly tag: string) {}
  async sendMessage(jid: string, content: Record<string, any>) {
    this.sent.push({ jid, content });
    return { key: { remoteJid: jid, fromMe: true, id: `${this.tag}-${++this.n}` }, message: { conversation: String(content.text ?? '') } };
  }
  participants: Record<string, string | undefined>[] = [];
  meta: Record<string, unknown> = {};
  async groupMetadata(jid: string) {
    this.fetches.push(jid);
    if (this.failFetch) throw this.failFetch;
    return { id: jid, subject: 'The Group', participants: this.members[jid] ?? this.participants, ...this.meta };
  }
  async sendPresenceUpdate(kind: string, jid: string) { this.presence.push([kind, jid]); }
  async requestPairingCode(phone: string) { this.codes.push(phone); return 'ABCD1234'; }
  async logout() { this.loggedOut++; }
  async end() { this.ended++; }
  updateMediaMessage = async () => ({});
  open() { this.ev.emit('connection.update', { connection: 'open' }); }
  close(statusCode: number, message = 'closed') { this.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { message, output: { statusCode } } } }); }
  upsert(messages: unknown[], type = 'notify') { this.ev.emit('messages.upsert', { messages, type }); }
}

/** One adapter on fake sockets, with what reached the handler, the log, and the terminal lines. */
function rig(extra: Partial<WhatsAppAdapterOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'angelia-wa-adapter-'));
  const authDir = join(root, 'auth');
  const sockets: FakeSocket[] = [];
  const got: Inbound[] = [], log: string[] = [], said: string[] = [];
  const a = new WhatsAppAdapter({
    authDir, pairing: 'qr', inboxFor: () => undefined,
    onInbound: async (i) => { got.push(i); },
    log: (l) => log.push(l), say: (l) => said.push(l),
    makeSocket: ((config: Record<string, any>) => { const s = new FakeSocket(config, `S${sockets.length}`); sockets.push(s); return s; }) as never,
    ...extra,
  });
  // Never ask the network for the WhatsApp Web version.
  Object.assign(a as unknown as Record<string, unknown>, { version: Promise.resolve(undefined) });
  return { a, root, authDir, sockets, got, log, said };
}

/** Wait on the event loop, not on a timer, so it works with mocked timers too. */
async function until(cond: () => boolean, what = 'condition', ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setImmediate(r)); }
}
/** Let pending work run for a while, for checks that something did NOT happen. */
const settle = (ms = 50) => until(() => false, '', ms).catch(() => {});

const text = (chat: string, body: string, extra: Record<string, unknown> = {}, id = `M${Math.random()}`) =>
  ({ key: { remoteJid: chat, fromMe: false, id, ...(chat.endsWith('@g.us') ? { participant: '22222222222222:4@lid' } : {}) }, pushName: 'Pat', message: { conversation: body }, ...extra });

async function started(extra: Partial<WhatsAppAdapterOptions> = {}) {
  const r = rig(extra);
  await r.a.start();
  assert.equal(r.sockets.length, 1);
  return r;
}

test('reply facts and our own mention reach the handler: the quoted message\'s id, whether its author is us (phone or lid form), and only our @number', async (t) => {
  const got: Inbound[] = [];
  const r = rig({ onInbound: async (i) => { got.push(i); } });
  t.after(() => r.a.stop());
  await r.a.start();
  const sock = r.sockets[0];
  sock.open();
  const ext = (body: string, contextInfo: Record<string, unknown>) => text(GROUP, '', { message: { extendedTextMessage: { text: body, contextInfo } } });
  sock.upsert([
    ext('yes', { stanzaId: 'S0-2', participant: US.id, quotedMessage: { conversation: 'ours' } }),
    ext('yes', { stanzaId: 'S0-3', participant: '11111111111111@lid', quotedMessage: { conversation: 'ours, by lid' } }),
    ext('yes', { stanzaId: 'X9', participant: '99999999999999@lid', quotedMessage: { conversation: 'a member\'s' } }),
    ext('@99999999999999 @15550000000 yes', { mentionedJid: ['99999999999999@lid', US.id] }),
    ext('@11111111111111 yes', { mentionedJid: ['11111111111111@lid'] }),
    text(GROUP, 'yes'),
  ]);
  await until(() => got.length === 6, 'six inbound messages');
  assert.deepEqual(got.map((i) => i.reply), [{ id: 'S0-2', ours: true }, { id: 'S0-3', ours: true }, { id: 'X9', ours: false }, undefined, undefined, undefined]);
  assert.deepEqual(got.map((i) => i.botMentions), [undefined, undefined, undefined, ['@15550000000'], ['@11111111111111'], undefined]);
  assert.deepEqual(got.map((i) => i.mentioned), [true, true, false, true, true, false]);
});

test('a swipe-reply "yes" answers the request whose message it replies to, by that message\'s id, through the socket\'s own message path; a reply to anything else, and "@someone yes", are messages for the agent', async (t) => {
  const { asker, openAsks } = await import('./asker.js');
  const { READ_FIRST_LINE } = await import('../src/core/deliver/text.js');
  const A = 'aaaa1111-0000-4000-8000-000000000001', B = 'bbbb2222-0000-4000-8000-000000000002';
  let o: Orchestrator | undefined;
  const { a, sockets } = await started({ onInbound: (i) => o!.handle(i) });
  const cfg = Config.parse({
    profiles: { a: { cwd: here } },
    routes: [{ platform: 'whatsapp', chat: GROUP, profile: 'a', mention: 'required', owners: ['22222222222222'], allow_from: ['*'] }],
    defaults: { max_out_per_min: 1000 },
  });
  o = new Orchestrator(cfg, { whatsapp: a }, { stateDir: mkdtempSync(join(tmpdir(), 'angelia-wa-orch-')), bins: { 'claude-code': FAKE_CLAUDE }, bareAnswerMinMs: 0 });
  t.after(() => o!.shutdown());
  const f = asker(o, `whatsapp:${GROUP}`);
  const sock = sockets[0];
  // The owner and one more person: a group where a bare "yes" can be said to someone.
  sock.participants = [{ id: '22222222222222@lid' }, { id: '99999999999999@lid' }];
  sock.open();
  const lines = () => sock.sent.map((s) => String(s.content.text));
  const sec = () => Math.floor(Date.now() / 1000);
  const ext = (body: string, contextInfo: Record<string, unknown>, extra: Record<string, unknown> = {}) => text(GROUP, '', { message: { extendedTextMessage: { text: body, contextInfo } }, messageTimestamp: sec() + 1, ...extra });
  const mention = (body: string, extra: Record<string, unknown> = {}) => ext(`@15550000000 ${body}`, { mentionedJid: [US.id] }, extra);
  sock.upsert([mention(`ASK:${A},${B}`)]);
  await until(() => sock.sent.length === 2, 'two request lines');
  assert.deepEqual(lines(), ['🔐 Bash: touch aaaa\nReply "yes" or "no". (request aaaa1111)', '🔐 Bash: touch bbbb\nReply "yes" or "no". (request bbbb2222)']);
  // The fake socket numbers what it sends S0-1, S0-2: those are the two lines' ids.
  // Not answers: a reply to a member's message that quotes B's line word for word (and names us, or
  // the group would not hear it); a reply to another message of ours; B's line's id under a member's name.
  sock.upsert([
    ext('@15550000000 yes', { mentionedJid: [US.id], stanzaId: 'X9', participant: '99999999999999@lid', quotedMessage: { conversation: lines()[1] } }),
    ext('yes', { stanzaId: 'S0-77', participant: US.id, quotedMessage: { conversation: 'Shall I book the table for 8?' } }),
    ext('@15550000000 yes', { mentionedJid: [US.id], stanzaId: 'S0-2', participant: '99999999999999@lid', quotedMessage: { conversation: lines()[1] } }),
  ]);
  await settle();
  assert.deepEqual(f.answers, []);
  assert.equal(sock.sent.length, 2, 'and nothing was said about them');
  // The reply as WhatsApp sends it: the quoted message's id and author ride in contextInfo, and quoting
  // our own message is what addresses us in a group. No mention is typed. The author in its lid form.
  sock.upsert([ext('yes', { stanzaId: 'S0-2', participant: '11111111111111@lid', quotedMessage: { conversation: 'whatever the client put here' } })]);
  await until(() => f.answers.length === 1, 'the answer');
  assert.deepEqual(f.answers, [[B, true]]);
  assert.deepEqual(openAsks(o, `whatsapp:${GROUP}`), [A], 'the other request waits on');
  assert.equal(sock.sent.length, 2, 'a reply said which request: no receipt');
  // One open now. "@<a member> @<us> no" is heard (it names us) and is said to the member.
  sock.upsert([ext('@99999999999999 @15550000000 no', { mentionedJid: ['99999999999999@lid', US.id] })]);
  await settle();
  assert.equal(f.answers.length, 1);
  // A "no" WhatsApp stamped a minute ago (typed before the request, delivered after a reconnect) is
  // not taken; the stamp arrives as a protobuf Long. Nor is one with no stamp at all.
  sock.upsert([mention('no', { messageTimestamp: { low: sec() - 60, high: 0, unsigned: true } })]);
  await until(() => lines().filter((l) => l === READ_FIRST_LINE).length === 1, 'the read-it-first line');
  sock.upsert([mention('no', { messageTimestamp: undefined })]);
  await until(() => lines().filter((l) => l === READ_FIRST_LINE).length === 2, 'the second read-it-first line');
  assert.equal(f.answers.length, 1);
  // Stamped this second (WhatsApp gives whole seconds; one ahead of our clock counts as now): taken,
  // and the chat is told what for.
  sock.upsert([mention('no')]);
  await until(() => f.answers.length === 2, 'the second answer');
  assert.deepEqual(f.answers, [[B, true], [A, false]]);
  await until(() => lines().includes('Denied: Bash: touch aaaa (request aaaa1111)'), 'the receipt');
  await until(() => f.turns.length === 5, 'the four that were no answers, as turns after the turn');
  assert.ok(f.turns.slice(1, 4).every((x) => x.endsWith('yes')) && f.turns[4].endsWith('@99999999999999 @15550000000 no'), f.turns.join(' | '));
});
