import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyedQueue } from '../src/core/session/queue.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('jobs on one key run serially, different keys in parallel', async () => {
  const q = new KeyedQueue();
  const log: string[] = [];
  const job = (k: string, n: number, ms: number) => q.enqueue(k, async () => { log.push(`${k}${n}>`); await sleep(ms); log.push(`${k}${n}<`); });
  const all = Promise.all([job('a', 1, 40), job('a', 2, 10), job('b', 1, 10)]);
  assert.equal(q.queued('a'), 2);
  await all;
  assert.deepEqual(log.filter((l) => l.startsWith('a')), ['a1>', 'a1<', 'a2>', 'a2<']);
  assert.ok(log.indexOf('b1<') < log.indexOf('a1<'));
  assert.equal(q.queued('a'), 0);
});

test('a failing job does not block the next one', async () => {
  const q = new KeyedQueue();
  await assert.rejects(q.enqueue('k', async () => { throw new Error('boom'); }));
  assert.equal(await q.enqueue('k', async () => 42), 42);
});
