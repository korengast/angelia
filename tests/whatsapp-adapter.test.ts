import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WhatsAppAdapter, type WhatsAppAdapterOptions } from '../src/adapters/whatsapp/adapter.js';

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
  const pass = async (ms: number) => { clock.now += ms; t.mock.timers.tick(ms); await settle(20); };
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
  assert.ok(log.some((l) => /7 members tagged in one message, 2 left as text \(at most 5\)/.test(l)), log.join('\n'));
});
