import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WhatsAppAdapter, transientNetError, errorLine, type WhatsAppAdapterOptions } from '../src/adapters/whatsapp/adapter.js';
import type { Inbound } from '../src/core/types.js';

/** The slice of a Baileys socket the adapter's connection handling uses. Nothing here touches the network or pairs. */
class FakeSocket {
  ev = new EventEmitter();
  user = undefined;
  codes: string[] = [];
  ended = 0;
  /** What was sent, and the member lists asked for: the send() tests read them. */
  posts: { chat: string; content: Record<string, any> }[] = [];
  fetches: string[] = [];
  members: Record<string, { id: string; lid?: string; phoneNumber?: string }[]> = {};
  failFetch?: Error;
  constructor(readonly config: Record<string, any>) {}
  async groupMetadata(jid: string) {
    this.fetches.push(jid);
    if (this.failFetch) throw this.failFetch;
    return { id: jid, subject: 'Team', participants: this.members[jid] ?? [] };
  }
  async sendMessage(chat: string, content: Record<string, any>) { this.posts.push({ chat, content }); return { key: { id: `m${this.posts.length}` }, message: {} }; }
  async requestPairingCode(phone: string) { this.codes.push(phone); return 'ABCD1234'; }
  async end() { this.ended++; }
  open() { this.ev.emit('connection.update', { connection: 'open' }); }
  close(statusCode: number, message = 'closed') { this.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { message, output: { statusCode } } } }); }
}

/** One adapter on fake sockets, with the log and the terminal lines. */
function rig(extra: Partial<WhatsAppAdapterOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'angelia-wa-adapter-'));
  const authDir = join(root, 'auth');
  const sockets: FakeSocket[] = [];
  const log: string[] = [], said: string[] = [];
  const a = new WhatsAppAdapter({
    authDir, pairing: 'qr', inboxFor: () => undefined,
    onInbound: async () => {},
    log: (l) => log.push(l), say: (l) => said.push(l),
    makeSocket: ((config: Record<string, any>) => { const s = new FakeSocket(config); sockets.push(s); return s; }) as never,
    ...extra,
  });
  // Never ask the network for the WhatsApp Web version.
  Object.assign(a as unknown as Record<string, unknown>, { version: Promise.resolve(undefined) });
  return { a, root, authDir, sockets, log, said };
}

/** Wait on the event loop, not on a timer, so it works with mocked timers too. */
async function until(cond: () => boolean, what = 'condition', ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setImmediate(r)); }
}
/** Let pending work run for a while, for checks that something did NOT happen. */
const settle = (ms = 50) => until(() => false, '', ms).catch(() => {});

test('a close reconnects on one timer, and a socket the adapter replaced is ended and no longer heard', async () => {
  const { a, sockets, log } = rig();
  await a.start();
  assert.equal(sockets.length, 1);
  sockets[0].open();
  sockets[0].close(515, 'restart required');
  await until(() => sockets.length === 2, 'the reopen');
  assert.equal(sockets[0].ended, 1, 'the old socket is ended when the new one is made');
  sockets[0].close(408, 'late close from the old socket');
  await settle();
  assert.equal(sockets.length, 2, 'a late close from the retired socket starts nothing');
  assert.ok(log.some((l) => /closed code=515/.test(l)));
  await a.stop();
  assert.equal(sockets[1].ended, 1);
});

/** The not-connected check on a fake clock: the interval runs every second of mocked time, the clock is ours.
 *  Paired, as a daemon's is: the fake socket never saves credentials, and each open() reads them again. */
function watched(t: TestContext, extra: Partial<WhatsAppAdapterOptions> = {}, paired = true) {
  const clock = { now: 0 };
  const r = rig({ now: () => clock.now, watchEveryMs: 1000, ...extra });
  if (paired) { mkdirSync(r.authDir, { recursive: true }); writeFileSync(join(r.authDir, 'creds.json'), JSON.stringify({ registered: true })); }
  const dead: number[] = [];
  r.a.on('dead', () => dead.push(clock.now));
  // Mocked time and our clock move together; the reopen timers (6 s and up) fire on the way.
  // 100 ms of real time per step: the reopen reads the auth folder from disk, which took more
  // than 20 ms on a loaded runner (release 0.3.26 check failed here twice).
  const pass = async (ms: number) => { clock.now += ms; t.mock.timers.tick(ms); await settle(100); };
  return { ...r, clock, dead, pass };
}

test('watchdog: paired and not connected for 5 min opens again in-process; a second 5 min says dead; a late open resets the count', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { a, sockets, log, dead, pass } = watched(t);
  await a.start();
  sockets[0].open();
  sockets[0].close(408, 'connection lost');
  await pass(4 * 60_000);
  assert.ok(sockets.length > 1, 'the reconnects ran meanwhile');
  assert.deepEqual(dead, [], 'not before 5 min');
  sockets.at(-1)!.open(); // the session came back by itself: the count starts over
  await pass(4 * 60_000);
  assert.deepEqual(dead, []);
  sockets.at(-1)!.close(500);
  await pass(5 * 60_000 - 1000);
  assert.deepEqual(dead, []);
  const n = sockets.length, live = sockets.at(-1)!;
  await pass(1000);
  assert.equal(dead.length, 0, 'the first window opens again, in this process');
  assert.equal(live.ended, 1, 'the socket that never opened is ended');
  assert.equal(sockets.length, n + 1, 'and a new one made');
  assert.equal(log.filter((l) => l === 'whatsapp: not connected for 5 min; ending the socket and opening again').length, 1);
  await pass(5 * 60_000 - 1000);
  assert.deepEqual(dead, []);
  await pass(1000);
  assert.equal(dead.length, 1, 'dead after the second window');
  assert.equal(log.filter((l) => l === 'whatsapp: still not connected after opening again; a fresh process is needed').length, 1);
  await pass(5 * 60_000);
  assert.equal(dead.length, 2, 'started by hand nothing exits: it goes on opening again, and says so each window');
  assert.equal(sockets.length, n + 3);
  sockets.at(-1)!.open(); // back: the next failure starts from the reopen step again
  sockets.at(-1)!.close(500);
  await pass(5 * 60_000);
  assert.equal(dead.length, 2);
  await a.stop();
});

test('watchdog: a socket that never opens after a reopen counts too; a close between the windows keeps the second one', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { a, sockets, dead, pass } = watched(t);
  await a.start();
  sockets[0].open();
  sockets[0].close(515, 'restart required');
  await pass(1000);
  assert.equal(sockets.length, 2, 'reopened');
  await pass(5 * 60_000); // sockets[1] never says open: ended, opened again
  assert.equal(sockets.length, 3);
  sockets[2].close(408); // Baileys is alive after all: the count starts over, the reopen step is kept
  await pass(5 * 60_000 - 1000);
  assert.deepEqual(dead, []);
  await pass(1000);
  assert.equal(dead.length, 1);
  await a.stop();
});

test('watchdog: a start that keeps throwing counts from the first start, not from each retry', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { a, dead, pass, log } = watched(t, { makeSocket: (() => { throw new Error('no socket'); }) as never });
  await assert.rejects(a.start(), /no socket/);
  await pass(3 * 60_000);
  await assert.rejects(a.start(), /no socket/); // the daemon's retry
  await pass(2 * 60_000);
  assert.equal(log.filter((l) => /opening again/.test(l)).length, 1, 'acted 5 min after the first start');
  await pass(5 * 60_000);
  assert.equal(dead.length, 1);
  await a.stop();
});

test('watchdog: silent while pairing (not registered, or pairOnly), when connected, and after a logout', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const unpaired = watched(t, {}, false);
  await unpaired.a.start(); // no credentials: not registered
  await unpaired.pass(10 * 60_000);
  assert.deepEqual(unpaired.dead, []);
  await unpaired.a.stop();

  const pairing = watched(t, { pairOnly: true });
  await pairing.a.start();
  pairing.sockets[0].open();
  pairing.sockets[0].close(428);
  await pairing.pass(10 * 60_000);
  assert.deepEqual(pairing.dead, []);
  await pairing.a.stop();

  const connected = watched(t);
  await connected.a.start();
  connected.sockets[0].open();
  await connected.pass(10 * 60_000);
  assert.deepEqual(connected.dead, []);
  await connected.a.stop();

  const out = watched(t);
  await out.a.start();
  out.sockets[0].open();
  out.sockets[0].close(401, 'logged out');
  await out.pass(10 * 60_000);
  assert.deepEqual(out.dead, []);
  assert.equal(out.sockets.length, 1);
  await out.a.stop();
});

test('watchdog: silent during a 440 backoff; the attempt after it gets its own 5 min', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { a, sockets, dead, pass } = watched(t);
  await a.start();
  sockets[0].open();
  sockets[0].close(440, 'conflict');
  await pass(5000); // inside the 6 s backoff, five checks ran
  assert.equal(sockets.length, 1);
  await pass(1000); // the reopen
  assert.equal(sockets.length, 2);
  assert.deepEqual(dead, []);
  await pass(5 * 60_000 - 1000);
  assert.equal(sockets.length, 2, 'the new attempt counts from its own start, not from the 440 close');
  await pass(1000);
  assert.equal(sockets.length, 3, 'opened again');
  await pass(5 * 60_000);
  assert.equal(dead.length, 1);
  await a.stop();
});

test('watchdog: stop() ends the timer', async () => {
  let ticks = 0;
  const { a } = rig({ now: () => { ticks++; return Date.now(); }, watchEveryMs: 5 });
  await a.start();
  await until(() => ticks >= 3, 'the check to run');
  await a.stop();
  const after = ticks;
  await settle(60);
  assert.equal(ticks, after, 'no check after stop');
});

const G = '120363000000000001@g.us';

/** A connected adapter on one fake socket, with members for G. */
async function connected(extra: Partial<WhatsAppAdapterOptions> = {}) {
  const r = rig(extra);
  await r.a.start();
  const sock = r.sockets[0];
  sock.members[G] = [{ id: '22222222222222@lid', phoneNumber: '15550002222@s.whatsapp.net' }, { id: '33333333333333@lid' }];
  sock.open();
  return { ...r, sock };
}

test('send: an answer with @<number> in a group tags the member; no @<digit>, a DM or an untagged send fetches nothing', async (t) => {
  const { a, sock } = await connected(); t.after(() => a.stop());
  await a.send(G, 'hi @+15550002222', undefined, { mentions: true });
  assert.deepEqual(sock.posts.at(-1), { chat: G, content: { text: 'hi @22222222222222', mentions: ['22222222222222@lid'] } });
  assert.equal(sock.fetches.length, 1);
  // The next send in the same minute, and Baileys' own lookup for it, hit the cache.
  await a.send(G, 'and @33333333333333', undefined, { mentions: true });
  assert.deepEqual(sock.posts.at(-1)!.content.mentions, ['33333333333333@lid']);
  assert.equal(sock.fetches.length, 1, 'cached');
  assert.equal((await sock.config.cachedGroupMetadata(G)).participants.length, 2);
  sock.fetches.length = 0;
  await a.send(G, 'no tags here, mail a@b.c', undefined, { mentions: true });
  await a.send('15550002222@s.whatsapp.net', 'dm @15550002222', undefined, { mentions: true });
  await a.send(G, 'a progress line @15550002222');
  await a.send(G, 'a line @15550002222', undefined, { mentions: false });
  assert.deepEqual(sock.posts.slice(-4).map((p) => p.content), [
    { text: 'no tags here, mail a@b.c' }, { text: 'dm @15550002222' }, { text: 'a progress line @15550002222' }, { text: 'a line @15550002222' },
  ]);
  assert.equal(sock.fetches.length, 0);
  // A number that is no member: sent as written, no mentions field.
  await a.send(G, 'call @15559999999', undefined, { mentions: true });
  assert.deepEqual(sock.posts.at(-1)!.content, { text: 'call @15559999999' });
});

test('send: a member fetch that fails sends the text as written and logs one line', async (t) => {
  const { a, sock, log } = await connected(); t.after(() => a.stop());
  sock.failFetch = new Error('rate-overlimit');
  await a.send(G, 'hi @15550002222', undefined, { mentions: true });
  assert.deepEqual(sock.posts.at(-1)!.content, { text: 'hi @15550002222' });
  assert.equal(log.filter((l) => /group members not fetched.*rate-overlimit/.test(l)).length, 1);
});

test('send: a group change drops its cached members; a new socket starts with none', async (t) => {
  const { a, sock, sockets } = await connected(); t.after(() => a.stop());
  await a.send(G, '@15550002222', undefined, { mentions: true });
  sock.ev.emit('group-participants.update', { id: G, author: 'x', participants: [], action: 'add' });
  assert.equal(await sock.config.cachedGroupMetadata(G), undefined);
  await a.send(G, '@15550002222', undefined, { mentions: true });
  sock.ev.emit('groups.update', [{ id: G, subject: 'New name' }]);
  assert.equal(await sock.config.cachedGroupMetadata(G), undefined);
  assert.equal(sock.fetches.length, 2);
  await a.send(G, '@15550002222', undefined, { mentions: true });
  sock.close(515, 'restart required');
  await until(() => sockets.length === 2, 'the reopen');
  assert.equal(await sockets[1].config.cachedGroupMetadata(G), undefined);
});

test('send: a phone the group lists only by lid is tagged through the lid map; past five members the rest stay text, logged', async (t) => {
  const { a, sock, authDir, log } = await connected(); t.after(() => a.stop());
  // Baileys writes this file; creds.update reloads the map.
  writeFileSync(join(authDir, 'lid-mapping-15550003333.json'), JSON.stringify('33333333333333@lid'));
  sock.ev.emit('creds.update', {});
  await a.send(G, 'thanks @15550003333', undefined, { mentions: true });
  assert.deepEqual(sock.posts.at(-1)!.content, { text: 'thanks @33333333333333', mentions: ['33333333333333@lid'] });
  sock.members[G] = Array.from({ length: 7 }, (_, n) => ({ id: `1555000000${n}@s.whatsapp.net` }));
  sock.ev.emit('group-participants.update', { id: G, author: 'x', participants: [], action: 'add' });
  await a.send(G, sock.members[G].map((m) => `@${m.id.slice(0, 11)}`).join(' '), undefined, { mentions: true });
  assert.equal(sock.posts.at(-1)!.content.mentions.length, 5);
  assert.ok(log.some((l) => /7 members named in one message, 2 not tagged \(at most 5\)/.test(l)), log.join('\n'));
});

test('send: a phone the lid map knows goes out as the lid with tags off, after a failed fetch, and past the cap', async (t) => {
  const { a, sock, authDir } = await connected(); t.after(() => a.stop());
  writeFileSync(join(authDir, 'lid-mapping-15550003333.json'), JSON.stringify('33333333333333@lid'));
  sock.ev.emit('creds.update', {});
  // A progress line: no tag, no fetch, and still no phone.
  await a.send(G, 'asking @15550003333 now');
  assert.deepEqual(sock.posts.at(-1)!.content, { text: 'asking @33333333333333 now' });
  assert.equal(sock.fetches.length, 0);
  // A DM is left alone.
  await a.send('15550002222@s.whatsapp.net', 'about @15550003333');
  assert.deepEqual(sock.posts.at(-1)!.content, { text: 'about @15550003333' });
  // The fetch fails: no tag, no phone.
  sock.failFetch = new Error('timed out');
  await a.send(G, 'thanks @15550003333', undefined, { mentions: true });
  assert.deepEqual(sock.posts.at(-1)!.content, { text: 'thanks @33333333333333' });
  // Past the cap: five others are tagged first; the sixth is named by lid, untagged.
  sock.failFetch = undefined;
  sock.members[G] = [...Array.from({ length: 5 }, (_, n) => ({ id: `1555000000${n}@s.whatsapp.net` })), { id: '33333333333333@lid' }];
  await a.send(G, `${[0, 1, 2, 3, 4].map((n) => `@1555000000${n}`).join(' ')} @15550003333`, undefined, { mentions: true });
  const last = sock.posts.at(-1)!.content;
  assert.equal(last.mentions.length, 5);
  assert.ok(!last.mentions.includes('33333333333333@lid'));
  assert.match(last.text, /@33333333333333$/);
});

test('a reply carries the quoted text to the handler, and a plain message carries none', async (t) => {
  const got: Record<string, unknown>[] = [];
  const r = rig({ onInbound: async (i) => { got.push(i as never); } });
  t.after(() => r.a.stop());
  await r.a.start();
  const sock = r.sockets[0];
  sock.open();
  const msg = (id: string, message: Record<string, unknown>) => ({ key: { remoteJid: '120363000000000001@g.us', fromMe: false, participant: '22222222222222@lid', id }, pushName: 'Someone', message });
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [
    msg('Q1', { extendedTextMessage: { text: '@bot', contextInfo: { quotedMessage: { conversation: 'line 1\nline 2' } } } }),
    msg('Q2', { conversation: 'plain' }),
  ] });
  await until(() => got.length === 2, 'two inbound messages');
  assert.equal(got[0].quoted, 'line 1\nline 2');
  assert.equal('quoted' in got[1], false);
});

/** A join as Baileys 7 hands it: the participant-add stub message (messageTimestamp from the
 *  notification's `t`), in a messages.upsert of type append. */
let stubN = 0;
const addStub = (o: { group?: string; author?: string; authorPn?: string; participants: unknown[]; t?: number; type?: number }) => ({ type: 'append', messages: [{
  key: { remoteJid: o.group ?? G, fromMe: false, id: `STUB${++stubN}`, participant: o.author, participantAlt: o.authorPn },
  messageStubType: o.type ?? 27,
  messageStubParameters: o.participants.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))),
  messageTimestamp: o.t ?? Math.floor(Date.now() / 1000),
}] });

test('the bot added to a group: onJoined gets the group and who added it, by phone when the lid map knows it', async (t) => {
  const joined: [string, string[]][] = [];
  const { a, sock, authDir } = await connected({ onJoined: async (chat, by) => { joined.push([chat, by]); } }); t.after(() => a.stop());
  // The bot's own ids, as a linked device's socket has them.
  (sock as { user: unknown }).user = { id: '15550000000:12@s.whatsapp.net', lid: '11111111111111:3@lid' };
  writeFileSync(join(authDir, 'lid-mapping-15550004444.json'), JSON.stringify('44444444444444@lid'));
  sock.ev.emit('creds.update', {});
  sock.ev.emit('messages.upsert', addStub({ author: '44444444444444@lid', participants: [{ id: '11111111111111@lid' }] }));
  // Someone else added, the bot removed (another stub type), a participants event alone (no stub): nothing.
  sock.ev.emit('messages.upsert', addStub({ author: '44444444444444@lid', participants: [{ id: '15559990000@s.whatsapp.net' }] }));
  sock.ev.emit('messages.upsert', addStub({ author: '44444444444444@lid', participants: [{ id: '11111111111111@lid' }], type: 28 }));
  sock.ev.emit('group-participants.update', { id: G, author: '44444444444444@lid', participants: [{ id: '11111111111111@lid' }], action: 'add' });
  // An older Baileys hands jids, with the device suffix; the author's phone may come as participantAlt; an invite link's join.
  sock.ev.emit('messages.upsert', addStub({ author: '55555555555555@lid', authorPn: '15556667777@s.whatsapp.net', participants: ['15550000000:12@s.whatsapp.net'], type: 31 }));
  await settle();
  assert.deepEqual(joined, [[G, ['15550004444', '44444444444444']], [G, ['15556667777', '55555555555555']]]);
});

test('an add carries the stub\'s own time; one handed over while the socket catches up is not used (L4, L5)', async (t) => {
  const joined: [string, string[], number][] = [];
  const logs: string[] = [];
  const { a, sock } = await connected({ onJoined: async (chat, by, at) => { joined.push([chat, by, at]); }, log: (l) => logs.push(l) }); t.after(() => a.stop());
  (sock as { user: unknown }).user = { id: '15550000000:12@s.whatsapp.net', lid: '11111111111111:3@lid' };
  const add = (t?: number) => addStub({ author: '44444444444444@lid', participants: [{ id: '11111111111111@lid' }], ...(t ? { t } : {}) });
  // A reconnect: Baileys says the missed notifications are still coming, then replays the old add.
  sock.ev.emit('connection.update', { receivedPendingNotifications: false });
  sock.ev.emit('messages.upsert', add());
  await settle();
  assert.deepEqual(joined, [], 'a replay is not used');
  assert.ok(logs.some((l) => /add of the bot arrived while catching up/.test(l)));
  sock.ev.emit('connection.update', { receivedPendingNotifications: true });
  // One that comes after the catching up, from an hour ago (a queued stub): its own time, not now.
  const hourAgo = Math.floor(Date.now() / 1000) - 3600;
  sock.ev.emit('messages.upsert', add(hourAgo));
  // A protobuf Long, as fromObject may make it.
  sock.ev.emit('messages.upsert', { ...add(), messages: [{ ...add().messages[0], messageTimestamp: { low: hourAgo + 5, high: 0 } }] });
  await settle();
  assert.deepEqual(joined.map((j) => j[2]), [hourAgo * 1000, (hourAgo + 5) * 1000]);
});

test('join, end to end: an owner adds the bot (seen by lid), the adapter tells the orchestrator, the group is routed to the armed profile, and a message sent at once waits for that and routes there', async (t) => {
  const { loadConfig } = await import('../src/instance/config/load.js');
  const { writeAccepted } = await import('../src/instance/accepted.js');
  const { arm, armedFor, connectWiring } = await import('../src/instance/connect.js');
  const { Orchestrator } = await import('../src/core/orchestrator.js');
  const FAKE_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'angelia-wa-join-'));
  const inst = join(dir, 'instance'), folder = join(dir, 'agents', 'recipes');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'CLAUDE.md'), '# recipes\n');
  const table = join(dir, 'routing.yaml');
  writeFileSync(table, `profiles:\n  recipes: {cwd: ${folder}}\nroutes: []\nwhatsapp: {}\ndefaults: {max_out_per_min: 1000}\nonboard: {owners: ["15550004444"], allow_from: ["*"], mention: any, connect_mention: any, folder: ${join(dir, 'agents')}}\n`);
  const cfg = loadConfig(table);
  writeAccepted(cfg, inst);
  arm(inst, { profile: 'recipes', platform: 'whatsapp' });
  let o: InstanceType<typeof Orchestrator> | undefined;
  const logs: string[] = [];
  const { a, sock, authDir } = await connected({ onInbound: (i) => o!.handle(i), onJoined: (chat, by, at) => o!.joined('whatsapp', chat, by, at) });
  t.after(() => a.stop());
  const US = { id: '15550000000:12@s.whatsapp.net', lid: '11111111111111:3@lid' };
  // The bot's ids, and the typing signal the turn sends, which this fake socket lacks.
  Object.assign(sock, { user: US, sendPresenceUpdate: async () => {} });
  o = new Orchestrator(cfg, { whatsapp: a }, { stateDir: inst, bins: { 'claude-code': FAKE_CLAUDE }, chunkGapMs: [0, 0], log: (l) => logs.push(l), connect: connectWiring({ table, cfg, instance: inst }) });
  t.after(() => o!.shutdown());
  // Baileys knows the owner's lid; the add names the owner by lid only.
  writeFileSync(join(authDir, 'lid-mapping-15550004444.json'), JSON.stringify('44444444444444@lid'));
  sock.ev.emit('creds.update', {});
  sock.ev.emit('group-participants.update', { id: G, author: '44444444444444@lid', participants: [{ id: US.lid }], action: 'add' });
  sock.ev.emit('messages.upsert', addStub({ author: '44444444444444@lid', participants: [{ id: US.lid }] }));
  // Someone else in the group writes at once, before the route is there.
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: G, fromMe: false, participant: '22222222222222@lid', id: 'J1' }, pushName: 'Pat', message: { conversation: 'what is for dinner' } }] });
  await until(() => sock.posts.some((s) => String(s.content.text).startsWith('echo:')), 'the answer');
  assert.equal(cfg.routes.at(-1)!.chat, G);
  assert.equal(cfg.routes.at(-1)!.profile, 'recipes');
  assert.equal(armedFor(inst, 'whatsapp'), undefined);
  assert.ok(logs.includes(`connected key=whatsapp:${G} profile=recipes on=join`), logs.join('\n'));
  const out = sock.posts.map((s) => String(s.content.text));
  assert.equal(out.length, 1, 'no Connected line, only the answer');
  assert.match(out[0], /^echo: \[whatsapp group 120363000000000001@g\.us · Pat \(22222222222222\)\]\n\nwhat is for dinner$/);
});

/** An adapter on one open fake socket that hands every inbound message to `got`, for the download tests. */
async function receiving(t: TestContext, extra: Partial<WhatsAppAdapterOptions>) {
  const got: Inbound[] = [];
  const r = rig({ onInbound: async (i) => { got.push(i); }, ...extra });
  t.after(() => r.a.stop());
  await r.a.start();
  r.sockets[0].open();
  return { ...r, got, upsert: (messages: unknown[]) => r.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages }) };
}

/** What undici's fetch throws when the network drops: "fetch failed", the reason in `cause`. */
const fetchFailed = (code = 'ECONNRESET') => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`read ${code}`), { code }) });
const DM = '15551111111@s.whatsapp.net';

test('a media download that fails on the network is tried again, and the photo arrives; the log names the cause', async (t) => {
  const profile = mkdtempSync(join(tmpdir(), 'angelia-wa-profile-'));
  let calls = 0;
  const download = (async () => {
    calls++;
    if (calls === 1) throw fetchFailed('ETIMEDOUT');
    // The second try breaks while the file streams in: its partial file must not stay.
    if (calls === 2) return (async function* () { yield Buffer.from('JP'); throw fetchFailed('ECONNRESET'); })();
    return (async function* () { yield Buffer.from('JPEG'); })();
  }) as never;
  const { got, log, upsert } = await receiving(t, { inboxFor: () => profile, download, retryMs: [5, 5] });
  upsert([{ key: { remoteJid: DM, id: 'FLAP' }, message: { imageMessage: { caption: 'look', mimetype: 'image/jpeg', fileLength: 4 } } }]);
  await until(() => got.length === 1, 'the photo');
  assert.equal(calls, 3);
  assert.equal(got[0].text, 'look');
  assert.equal(got[0].media.length, 1);
  assert.equal(readFileSync(got[0].media[0], 'utf8'), 'JPEG');
  assert.deepEqual(readdirSync(join(profile, '.inbox')).length, 1, 'no partial file from the broken try');
  assert.ok(log.some((l) => /media download try 1 failed .*fetch failed \(cause: ETIMEDOUT read ETIMEDOUT\); again in 0 s/.test(l)), log.join('\n'));
  assert.ok(log.some((l) => /media download try 2 failed .*cause: ECONNRESET/.test(l)));
  assert.ok(!log.some((l) => /media download failed/.test(l)));
});

test('a network error on every try: three tries, then the agent is told, with the cause in the log', async (t) => {
  const profile = mkdtempSync(join(tmpdir(), 'angelia-wa-profile-'));
  let calls = 0;
  const { got, log, upsert } = await receiving(t, { inboxFor: () => profile, download: (async () => { calls++; throw fetchFailed('ENOTFOUND'); }) as never, retryMs: [5, 5] });
  upsert([{ key: { remoteJid: DM, id: 'DOWN' }, message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 4 } } }]);
  await until(() => got.length === 1, 'the note');
  assert.equal(calls, 3);
  assert.equal(got[0].text, '[the photo sent could not be downloaded]');
  assert.ok(log.some((l) => /media download failed .*fetch failed \(cause: ENOTFOUND read ENOTFOUND\)/.test(l)));
});

test('an error that is not the network (an HTTP status) is not tried again', async (t) => {
  const profile = mkdtempSync(join(tmpdir(), 'angelia-wa-profile-'));
  let calls = 0;
  const { got, upsert } = await receiving(t, { inboxFor: () => profile, download: (async () => { calls++; throw new Error('media host said 500'); }) as never, retryMs: [5, 5] });
  upsert([{ key: { remoteJid: DM, id: 'BAD' }, message: { imageMessage: { caption: 'see this', mimetype: 'image/jpeg', fileLength: 10 } } }]);
  await until(() => got.length === 1, 'the caption of the failed photo');
  assert.equal(calls, 1);
  assert.equal(got[0].text, 'see this\n[the photo sent could not be downloaded]');
});

test('transientNetError: network breaks yes; an HTTP status, an abort or a size error no', () => {
  assert.equal(transientNetError(fetchFailed()), true);
  assert.equal(transientNetError(Object.assign(new Error('x'), { code: 'UND_ERR_SOCKET' })), true);
  assert.equal(transientNetError(new Error('socket hang up')), true);
  assert.equal(transientNetError(new Error('media host said 500')), false);
  assert.equal(transientNetError(new Error('no answer in 60 s')), false);
  assert.equal(transientNetError(undefined), false);
  assert.equal(errorLine(new Error('plain')), 'plain');
});
