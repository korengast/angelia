import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk } from '../src/core/deliver/chunk.js';
import { parsePermissionReply } from '../src/core/deliver/text.js';
import { ProgressOutbox, RateLimiter } from '../src/core/deliver/rate.js';

test('short text is one chunk; empty is none', () => {
  assert.deepEqual(chunk('hi', 100), ['hi']);
  assert.deepEqual(chunk('  \n ', 100), []);
});

test('splits on paragraphs and respects the limit', () => {
  const paras = Array.from({ length: 10 }, (_, i) => `paragraph ${i} `.repeat(5).trim());
  const out = chunk(paras.join('\n\n'), 200);
  assert.ok(out.length > 1);
  for (const c of out) assert.ok(c.length <= 200, `chunk too long: ${c.length}`);
  assert.equal(out.join('\n\n').replace(/\s+/g, ' '), paras.join(' ').replace(/\s+/g, ' '));
});

test('code fences are closed and reopened across chunks', () => {
  const code = '```py\n' + Array.from({ length: 40 }, (_, i) => `x${i} = ${i}`).join('\n') + '\n```';
  const out = chunk('intro\n\n' + code, 120);
  assert.ok(out.length >= 3);
  for (const c of out) {
    const fences = (c.match(/```/g) ?? []).length;
    assert.equal(fences % 2, 0, `unbalanced fence in: ${c}`);
    assert.ok(c.length <= 120);
  }
  assert.ok(out[1].startsWith('```py'));
});

test('exact limit boundary and hard cut without whitespace', () => {
  assert.deepEqual(chunk('a'.repeat(50), 50), ['a'.repeat(50)]);
  const out = chunk('b'.repeat(120), 50);
  assert.deepEqual(out.map((c) => c.length), [45, 45, 30]);
});

test('Hebrew text is untouched', () => {
  const he = 'שלום עולם, זו בדיקה.\n\nשורה שנייה.';
  assert.deepEqual(chunk(he, 1000), [he]);
});

test('permission replies parse', () => {
  assert.deepEqual(parsePermissionReply('yes 6b480a6f'), { id: '6b480a6f', allow: true });
  assert.deepEqual(parsePermissionReply(' No 6b480a6f-d386 '), { id: '6b480a6f-d386', allow: false });
  assert.equal(parsePermissionReply('yes please'), null);
  assert.equal(parsePermissionReply('yes'), null);
});

test('rate limiter: gap between chunks and per-minute ceiling with a fake clock', async () => {
  let now = 0;
  const slept: number[] = [];
  const rl = new RateLimiter(3, [1000, 1000], () => now, async (ms) => { slept.push(ms); now += ms; }, () => 0);
  await rl.acquire(true); await rl.acquire(false); await rl.acquire(false);
  assert.deepEqual(slept, [1000, 1000]);
  await rl.acquire(true); // 4th within a minute must wait until the first stamp expires
  assert.equal(slept.length, 3);
  assert.ok(now >= 60_000);
});

test('rate limiter: a progress send waits while an urgent one does, and gives up when cancelled', async () => {
  let now = 0;
  const rl = new RateLimiter(3, [0, 0], () => now, async (ms) => { now += ms; await new Promise((r) => setImmediate(r)); }, () => 0);
  await rl.acquire(true); await rl.acquire(true); // one slot left: kept for the answer
  const order: string[] = [];
  const low = rl.acquireLow().then((ok) => order.push(`low ${ok}`));
  const high = rl.acquire(true).then(() => order.push('urgent'));
  await Promise.all([low, high]);
  assert.deepEqual(order, ['urgent', 'low true'], 'the answer takes the first free slot');
  let stop = false;
  const gave = rl.acquireLow(() => stop);
  stop = true;
  assert.equal(await gave, false);
});

test('progress lines that pile up go out as one message; close hands back what was never sent', async () => {
  let now = 0;
  const rl = new RateLimiter(2, [0, 0], () => now, async (ms) => { now += ms; await new Promise((r) => setImmediate(r)); }, () => 0);
  const sent: string[] = [];
  let release!: () => void;
  const first = new Promise<void>((r) => { release = r; });
  const box = new ProgressOutbox(rl, async (t) => { sent.push(t); if (sent.length === 1) await first; });
  const tick = () => new Promise((r) => setImmediate(r));
  box.push('one');
  while (sent.length < 1) await tick();
  box.push('two'); box.push('three'); // 'one' is still being sent and the minute is used up: these wait, together
  release();
  for (let n = 0; n < 1000 && sent.length < 2; n++) await tick();
  assert.deepEqual(sent, ['one', 'two\n\nthree']);
  assert.equal(box.lastSent, 'three');
  box.push('four'); // the next slot is a minute away
  assert.deepEqual(await box.close(), ['four']);
  box.push('five');
  assert.deepEqual(sent.length, 2, 'nothing goes out after close');
});

test('a hard cut never splits an emoji into two surrogate halves', () => {
  const text = 'x'.repeat(94) + '\u{1F600}'.repeat(40); // no spaces or newlines: hard cuts only
  const parts = chunk(text, 100);
  for (const p of parts) assert.ok(!/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(p), `lone surrogate at an edge of ${JSON.stringify(p)}`);
  assert.equal(parts.join(''), text);
});

/** Every character of the input, in order, survives the split (whitespace and added fence lines aside). */
function keepsText(input: string, parts: string[]): boolean {
  const want = input.replace(/\s+/g, '');
  const got = parts.join('').replace(/\s+/g, '');
  let i = 0;
  for (let j = 0; j < got.length && i < want.length; j++) if (got[j] === want[i]) i++;
  return i === want.length;
}

test('a fence line just under the limit ends, and no part outgrows the limit', () => {
  for (const limit of [3500, 4000]) {
    // The fence opener of limit-6 characters made room zero, and the loop never ended (heap out of memory).
    const text = '```' + 'x'.repeat(limit - 9) + '\n\n' + 'tail text '.repeat(50) + '\n' + 'y'.repeat(limit * 2);
    const out = chunk(text, limit);
    for (const c of out) assert.ok(c.length <= limit, `part of ${c.length} over ${limit}`);
    assert.ok(keepsText(text, out));
  }
});

test('a reopened fence carries only its opener and language, not a long info string', () => {
  const code = '```python ' + 'note '.repeat(30) + '\n' + Array.from({ length: 60 }, (_, i) => `x${i} = ${i}`).join('\n') + '\n```';
  const out = chunk(code, 200);
  assert.ok(out.length > 2);
  for (const c of out) assert.ok(c.length <= 200);
  assert.ok(out[1].startsWith('```python\n'), out[1].slice(0, 30));
});

test('chunk: random text with fences, long lines and emoji always ends within the limit', () => {
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const bits = ['word ', 'longer words here ', '\n', '\n\n', '```', '````js', '```' + 'i'.repeat(90), '😀', 'z'.repeat(150), '\t'];
  for (let run = 0; run < 400; run++) {
    const limit = 50 + rnd(400);
    let text = '';
    const n = 5 + rnd(120);
    for (let i = 0; i < n; i++) { const b = bits[rnd(bits.length)]; text += b.startsWith('`') ? '\n' + b + '\n' : b; }
    const out = chunk(text, limit);
    for (const c of out) assert.ok(c.length <= limit, `run ${run}: part of ${c.length} over ${limit}`);
    assert.ok(keepsText(text, out), `run ${run}: text lost`);
    for (const c of out) assert.ok(!/[\uD800-\uDBFF]$/.test(c) && !/^[\uDC00-\uDFFF]/.test(c), `run ${run}: split emoji`);
  }
});
