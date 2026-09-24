import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatChains, SenderQuota, pruneInbox, saveInbound } from '../src/adapters/inbox.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'angelia-inbox-'));

test('a download is streamed under a name of our own, and stops at the cap leaving nothing behind', async () => {
  const dir = tmp();
  const path = await saveInbound(dir, '.pdf', (async function* () { yield Buffer.from('ab'); yield Buffer.from('c'); })(), 3);
  assert.match(path!, /\.inbox\/\d+-[0-9a-f]{8}\.pdf$/);
  assert.equal(readFileSync(path!, 'utf8'), 'abc');
  let pulled = 0;
  const big = (async function* () { for (let i = 0; i < 100; i++) { pulled++; yield Buffer.alloc(10); } })();
  assert.equal(await saveInbound(dir, '.bin', big, 25), undefined);
  assert.equal(pulled, 3, 'stops reading at the cap');
  assert.deepEqual(readdirSync(join(dir, '.inbox')).length, 1, 'no partial file left');
  assert.match((await saveInbound(dir, '.x/../../evil', (async function* () { yield Buffer.from('z'); })()))!, /\/\d+-[0-9a-f]{8}$/, 'an odd extension is dropped');
});

test('the inbox keeps the newest files within its limits', () => {
  const dir = tmp();
  const inbox = join(dir, '.inbox');
  mkdirSync(inbox);
  for (let i = 0; i < 5; i++) { const f = join(inbox, `f${i}`); writeFileSync(f, 'x'.repeat(10)); utimesSync(f, 1000 + i, 1000 + i); }
  assert.deepEqual(pruneInbox(inbox, { bytes: 1000, files: 3 }).map((p) => p.split('/').pop()).sort(), ['f0', 'f1']);
  assert.deepEqual(pruneInbox(inbox, { bytes: 15, files: 100 }).map((p) => p.split('/').pop()), ['f3', 'f2']);
  assert.deepEqual(readdirSync(inbox), ['f4']);
});

test('a sender gets so many files an hour', () => {
  let now = 0;
  const q = new SenderQuota(2, () => now);
  assert.deepEqual([q.take('a'), q.take('a'), q.take('a'), q.take('b')], [true, true, false, true]);
  now = 3600_001;
  assert.equal(q.take('a'), true);
});

test('chat chains: in order within a chat, side by side across chats', async () => {
  const c = new ChatChains();
  const log: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  void c.run('a', async () => { await held; log.push('a1'); });
  void c.run('a', async () => { log.push('a2'); });
  await c.run('b', async () => { log.push('b1'); });
  assert.deepEqual(log, ['b1']);
  release();
  await c.idle();
  assert.deepEqual(log, ['b1', 'a1', 'a2']);
  void c.run('a', async () => { throw new Error('x'); }).catch(() => {});
  await c.run('a', async () => { log.push('a3'); });
  assert.equal(log.at(-1), 'a3', 'a failed job does not stop the chain');
});
