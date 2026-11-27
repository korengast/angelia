import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAILURE_LINE } from '../src/core/deliver/text.js';
import { ROW, stubChat } from './tui-stub.js';

// 0.4.10 (a customer's server): a warm pane whose tmux session is gone (killed, crashed) failed the next
// turn with reason=exit, "Something broke on my side": the pane is launched only at start(), and the
// paste gave up once has-session said no. Own state dir and socket before the brain modules load.
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-dead-pane-'));
process.env.ANGELIA_TMUX_SOCKET = `angelia-test-dead-pane-${process.pid}`;

const answer = (n: number, p: { rows: (...r: object[]) => void; prompt: () => object; stop: (t: string) => void }) => {
  p.rows(p.prompt(), ROW.text(`Answer ${n}.`)); p.stop(`Answer ${n}.`);
};

test('a warm pane whose session is gone before the next message: launched again (resumed), and the message is answered', { timeout: 30_000 }, async (t) => {
  const c = await stubChat(); t.after(() => c.o.shutdown());
  c.onEnter((n, p) => answer(n, p));
  await c.say('one');
  assert.ok(c.sent.includes('Answer 1.'));
  const p = c.pane();
  p.die();
  await c.say('two');
  assert.ok(c.sent.includes('Answer 2.'), `the chat got: ${JSON.stringify(c.sent)}`);
  assert.ok(!c.sent.some((s) => s.startsWith('Something broke')), 'no failure line');
  assert.equal(c.pane(), p, 'the same brain: launched again in place');
  assert.equal(p.launches.length, 1);
  assert.ok(p.launches[0].includes('--resume'), 'the conversation is resumed');
  assert.match(p.typed, /two/);
  assert.ok(c.log.some((l) => /tmux: the session of pane \S+ is gone before the message was typed; launched again/.test(l)), c.log.join('\n'));
});

test('the same, and that launch fails: the turn fails as before, after one try', { timeout: 30_000 }, async (t) => {
  const c = await stubChat(); t.after(() => c.o.shutdown());
  c.onEnter((n, p) => answer(n, p));
  await c.say('one');
  const p = c.pane();
  p.failLaunch();
  p.die();
  await c.say('two');
  assert.equal(p.launches.length, 1, 'one launch, not a loop');
  assert.ok(!c.sent.includes('Answer 2.'));
  assert.ok(c.sent.some((s) => s.startsWith(FAILURE_LINE.slice(0, 20))), `the chat got: ${JSON.stringify(c.sent)}`);
});

test('an Up meant for the resume dialog that reached the box after the dialog closed: the old prompt is cleared, and only the message is sent', { timeout: 30_000 }, async (t) => {
  const c = await stubChat({ promptTimeoutMs: 8000 } as never); t.after(() => c.o.shutdown());
  c.onEnter((n, p) => { p.rows(p.prompt(), ROW.text(`Answer ${n}.`)); p.stop(`Answer ${n}.`); });
  await c.say('one');
  const p = c.pane();
  p.show('resume');
  await c.say('two');
  assert.ok(c.sent.includes('Answer 2.'), `the chat got: ${JSON.stringify(c.sent)}`);
  assert.match(p.typed, /\ntwo$/);
  assert.ok(!p.typed.includes('beta'), 'the called-back prompt is not sent with it');
  assert.ok(p.logs.some((l) => /the input box held text before a paste; cleared: 29 chars/.test(l)), 'the called-back prompt was cleared before the paste');
});
