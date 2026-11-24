import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staleLock, takeOver, withLock } from '../src/instance/init.js';

const file = () => join(mkdtempSync(join(tmpdir(), 'angelia-lock-')), 'routing.yaml');
const age = (p: string, ms: number) => { const t = (Date.now() - ms) / 1000; utimesSync(p, t, t); };

test('a lock older than 60 s is dead even when its pid is a live process (a pid reused after a reboot), and is taken over (M1)', () => {
  const t = file();
  writeFileSync(`${t}.lock`, String(process.pid)); // alive: this very process
  age(`${t}.lock`, 61_000);
  assert.equal(withLock(t, () => 'ran', 200), 'ran');
  assert.ok(!existsSync(`${t}.lock`), 'ours, let go');
  assert.ok(!existsSync(`${t}.lock.takeover`), 'the takeover guard is gone');
});

test('a fresh lock of a live pid holds; one of a pid that is gone does not', () => {
  const t = file();
  writeFileSync(`${t}.lock`, String(process.pid));
  assert.throws(() => withLock(t, () => 'ran', 100), /being written by another process/);
  writeFileSync(`${t}.lock`, '999999'); // no such process
  assert.equal(withLock(t, () => 'ran', 200), 'ran');
});

test('a takeover removes only the lock it judged dead: a new lock made since stays, and a held guard waits (L7)', () => {
  const t = file(), lock = `${t}.lock`;
  writeFileSync(lock, '999999');
  const judged = staleLock(lock)!;
  assert.equal(typeof judged, 'number');
  // Another taker removed it and a live writer made a new one, under another inode, before this taker acts.
  writeFileSync(`${lock}.x`, String(process.pid));
  renameSync(`${lock}.x`, lock);
  assert.notEqual(statSync(lock).ino, judged);
  takeOver(lock, judged);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid), 'the live writer\'s lock is never moved or removed');
  // Another taker holds the guard: this one does nothing this round.
  writeFileSync(lock, '999999');
  writeFileSync(`${lock}.takeover`, '');
  takeOver(lock, staleLock(lock)!);
  assert.ok(existsSync(lock), 'left to the taker that holds the guard');
  // A guard left by a taker that died is cleared; the next round takes the dead lock.
  age(`${lock}.takeover`, 6000);
  takeOver(lock, staleLock(lock)!);
  assert.ok(!existsSync(`${lock}.takeover`));
  takeOver(lock, staleLock(lock)!);
  assert.ok(!existsSync(lock));
});

test('a stale takeover guard is cleared under a guard of its own: a clearer at work keeps others off it, and one left by a dead clearer goes after a minute (recheck item 4)', () => {
  const t = file(), lock = `${t}.lock`, guard = `${lock}.takeover`, clear = `${guard}.clear`;
  writeFileSync(lock, '999999');
  writeFileSync(guard, '');
  age(guard, 6000);
  // Another clearer holds `.clear`: this taker leaves the guard alone.
  writeFileSync(clear, '');
  takeOver(lock, staleLock(lock)!);
  assert.ok(existsSync(guard), 'left to the clearer at work');
  // A `.clear` a dead clearer left: gone after a minute, then the stale guard is cleared, then the lock taken.
  age(clear, 61_000);
  takeOver(lock, staleLock(lock)!);
  assert.ok(!existsSync(clear));
  takeOver(lock, staleLock(lock)!);
  assert.ok(!existsSync(guard), 'the stale guard cleared');
  assert.ok(!existsSync(`${clear}`), 'and its .clear let go');
  takeOver(lock, staleLock(lock)!);
  assert.ok(!existsSync(lock), 'the dead lock taken');
  // A guard that is fresh (a taker at work) is never cleared.
  writeFileSync(lock, '999999');
  writeFileSync(guard, '');
  takeOver(lock, staleLock(lock)!);
  assert.ok(existsSync(guard) && existsSync(lock));
});
