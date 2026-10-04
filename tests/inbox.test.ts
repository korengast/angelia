import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatChains, SenderQuota, inboxDir as inboxDirForTest, pruneInbox, saveInbound } from '../src/adapters/inbox.js';

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
  const name = (i: number) => `${1_700_000_000_000 + i}-0000000${i}.jpg`;
  for (let i = 0; i < 5; i++) { const f = join(inbox, name(i)); writeFileSync(f, 'x'.repeat(10)); utimesSync(f, 1000 + i, 1000 + i); }
  assert.deepEqual(pruneInbox(inbox, { bytes: 1000, files: 3 }).map((p) => p.split('/').pop() ?? '').sort((a, b) => a.localeCompare(b)), [name(0), name(1)]);
  assert.deepEqual(pruneInbox(inbox, { bytes: 15, files: 100 }).map((p) => p.split('/').pop()), [name(3), name(2)]);
  assert.deepEqual(readdirSync(inbox), [name(4)]);
});

test('pruning touches only files Angelia named, so a folder swapped in loses nothing of its own', () => {
  const dir = tmp();
  for (let i = 0; i < 5; i++) { const f = join(dir, `notes-${i}.md`); writeFileSync(f, 'x'.repeat(10)); utimesSync(f, 1000 + i, 1000 + i); }
  assert.deepEqual(pruneInbox(dir, { bytes: 1, files: 1 }), []);
  assert.equal(readdirSync(dir).length, 5);
});

test('a .inbox that is a link is refused: the daemon never writes where an agent points it', async () => {
  const dir = tmp();
  const elsewhere = tmp();
  symlinkSync(elsewhere, join(dir, '.inbox'));
  const file = () => (async function* () { yield Buffer.from('payload'); })();
  await assert.rejects(saveInbound(dir, '.plist', file()), /not a plain folder/);
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing written through the link');
  // A link deeper in: the profile path itself is resolved first, so a linked profile folder still works.
  const real = tmp();
  const linked = join(tmp(), 'profile');
  symlinkSync(real, linked);
  const saved = await saveInbound(linked, '.txt', file());
  assert.ok(saved && readFileSync(saved, 'utf8') === 'payload');
  assert.equal(readdirSync(join(real, '.inbox')).length, 1);
});

test('on macOS the write itself refuses a link anywhere in the path (the swap after the check)', { skip: process.platform !== 'darwin' }, async () => {
  const dir = realpathSync(tmp());
  const elsewhere = tmp();
  mkdirSync(join(dir, '.inbox'));
  // inboxDir has passed; the agent now swaps the folder for a link before the open.
  const orig = inboxDirForTest(dir);
  rmSync(join(dir, '.inbox'), { recursive: true });
  symlinkSync(elsewhere, join(dir, '.inbox'));
  await assert.rejects(open(join(orig, 'x.plist'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | 0x20000000, 0o600), /ELOOP/);
  assert.deepEqual(readdirSync(elsewhere), []);
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
