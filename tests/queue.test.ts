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

test('drop takes back the waiting jobs, not the running one, and later jobs run', async () => {
  const q = new KeyedQueue();
  const ran: string[] = [];
  let release!: () => void;
  const first = q.enqueue('k', () => new Promise<string>((r) => { release = () => r('first'); ran.push('first'); }));
  const waiting = [q.enqueue('k', async () => { ran.push('w1'); return 'w1'; }), q.enqueue('k', async () => { ran.push('w2'); return 'w2'; })];
  await sleep(5);
  assert.equal(q.drop('k'), 2);
  assert.equal(q.queued('k'), 1, 'only the running job counts once the rest are dropped');
  assert.equal(q.drop('k'), 0, 'nothing left to take back');
  const later = q.enqueue('k', async () => { ran.push('later'); return 'later'; });
  release();
  assert.equal(await first, 'first');
  assert.deepEqual(await Promise.all(waiting), [undefined, undefined]);
  assert.equal(await later, 'later');
  assert.deepEqual(ran, ['first', 'later']);
  await sleep(0); // the depth count settles a tick after the job's own promise
  assert.equal(q.queued('k'), 0);
});
