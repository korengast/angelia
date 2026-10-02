import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error -- the site's Worker is plain JavaScript, without types
import worker, { parseRange } from '../site/worker/ranges.js';

test('site ranges: one bytes range is cut, the rest is the whole file or 416', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=0-1', 1000), { start: 0, end: 1 }, 'the probe Safari sends first');
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 }, 'an end past the file is the last byte');
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
  assert.equal(parseRange('bytes=1000-', 1000), 'bad');
  assert.equal(parseRange('bytes=-0', 1000), 'bad');
  for (const whole of [null, '', 'bytes=-', 'bytes=0-1,5-9', 'items=0-1', 'bytes=50-10']) assert.equal(parseRange(whole, 1000), undefined, String(whole));
});

/** The Worker in front of a stand-in asset server holding one file. */
async function ask(headers: Record<string, string>, method = 'GET') {
  const file = new Uint8Array(1000).map((_, i) => i % 256);
  const env = { ASSETS: { fetch: async (r: Request) => new Response(r.method === 'HEAD' ? null : file, { headers: { 'content-type': 'video/mp4', etag: '"v1"' } }) } };
  const res: Response = await worker.fetch(new Request('https://x/angelia-demo.mp4', { method, headers }), env);
  return { res, body: new Uint8Array(await res.arrayBuffer()) };
}

test('site ranges: the Worker answers 206 with the bytes, 416 past the end, 200 otherwise, ranges always offered', async () => {
  const part = await ask({ range: 'bytes=10-19' });
  assert.equal(part.res.status, 206);
  assert.equal(part.res.headers.get('content-range'), 'bytes 10-19/1000');
  assert.equal(part.res.headers.get('content-type'), 'video/mp4');
  assert.deepEqual([...part.body], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  const past = await ask({ range: 'bytes=5000-' });
  assert.equal(past.res.status, 416);
  assert.equal(past.res.headers.get('content-range'), 'bytes */1000');
  const whole = await ask({});
  assert.equal(whole.res.status, 200);
  assert.equal(whole.res.headers.get('accept-ranges'), 'bytes');
  assert.equal(whole.body.length, 1000);
  const changed = await ask({ range: 'bytes=10-19', 'if-range': '"v0"' });
  assert.equal(changed.res.status, 200, 'another ETag: the whole file');
  assert.equal((await ask({ range: 'bytes=10-19', 'if-range': '"v1"' })).res.status, 206);
  const head = await ask({ range: 'bytes=10-19' }, 'HEAD');
  assert.equal(head.res.status, 206);
  assert.equal(head.res.headers.get('content-range'), 'bytes 10-19/1000');
  assert.equal(head.body.length, 0);
});
