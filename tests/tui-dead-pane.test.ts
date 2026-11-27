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
  assert.ok(c.sent.includes('Answer 2.'), `the chat got: ${JSON.stringify(c.sent)}\nlog:\n${c.log.join('\n')}`);
  assert.ok(!c.sent.some((s) => s.startsWith('Something broke')), 'no failure line');
  assert.equal(c.pane(), p, 'the same brain: launched again in place');
  assert.equal(p.launches.length, 1);
  assert.ok(p.launches[0].includes('--resume'), 'the conversation is resumed');
  assert.match(p.typed, /two/);
  assert.ok(c.log.some((l) => /tmux: the session of pane \S+ is gone before the message was typed; launched again/.test(l)), c.log.join('\n'));
});

// Review fix (Fable, 0.4.10): the relaunch kept the dead process's state. Its tasks and teammates
// died with it and its requests wait for nobody, so the brain starts as a fresh launch does.
test('the launch again starts the brain fresh: no task, teammate, spawn or request of the dead process', { timeout: 30_000 }, async (t) => {
  const c = await stubChat(); t.after(() => c.o.shutdown());
  c.onEnter((n, p) => {
    if (n === 1) { p.rows(p.prompt(), ...ROW.background('toolu_1'), ...ROW.teammate('toolu_2', 'scout'), ROW.text('Answer 1.')); p.stop('Answer 1.'); }
    else answer(n, p);
  });
  await c.say('one');
  const b = c.brain();
  assert.ok(b.ours.has('toolu_1') && b.oursTeammates.has('scout') && b.openTasks.size > 0, 'the first turn\'s work is the chat\'s');
  // Between turns: a spawn not settled yet, a request the chat was asked, one asked between turns.
  b.pendingSpawns.push({ id: 'toolu_9', at: 0 });
  b.permissions.add('req-1');
  b.selfBook.add('req-2');
  assert.equal(b.pendingPermissionCount, 2);
  const p = c.pane();
  p.die();
  await c.say('two');
  assert.ok(c.sent.includes('Answer 2.'), `the chat got: ${JSON.stringify(c.sent)}\nlog:\n${c.log.join('\n')}`);
  assert.equal(c.brain(), b, 'the same brain, launched again in place');
  assert.equal(b.pendingPermissionCount, 0, 'no request of the dead process waits');
  assert.equal(b.hasPendingPermission('req-1'), false);
  assert.equal(b.ours.size, 0);
  assert.equal(b.peerIds.size, 0);
  assert.equal(b.oursTeammates.size, 0);
  assert.equal(b.openTeammates.size, 0);
  assert.equal(b.openTasks.size, 0);
  assert.deepEqual(b.pendingSpawns, [], 'what it spawned between turns is nobody\'s');
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
  assert.ok(c.sent.includes('Answer 2.'), `the chat got: ${JSON.stringify(c.sent)}\nlog:\n${c.log.join('\n')}`);
  assert.match(p.typed, /\ntwo$/);
  assert.ok(!p.typed.includes('beta'), 'the called-back prompt is not sent with it');
  assert.ok(p.logs.some((l) => /the input box held text before a paste; cleared: 29 chars/.test(l)), 'the called-back prompt was cleared before the paste');
});

// Fable recheck (0.4.10): a has-session that timed out read as a session that is gone, so the launch
// again cleared the state of a live process, which ensure() then found alive. A timeout is no answer:
// the pane is kept as it was, as the reader between turns does (watch).
test('a has-session that times out while the message waits: the pane is kept, its state too, and nothing is launched', { timeout: 30_000 }, async (t) => {
  const c = await stubChat(); t.after(() => c.o.shutdown());
  c.onEnter((n, p) => {
    if (n === 1) { p.rows(p.prompt(), ...ROW.background('toolu_1'), ROW.text('Answer 1.')); p.stop('Answer 1.'); }
    else answer(n, p);
  });
  await c.say('one');
  const b = c.brain();
  assert.ok(b.ours.has('toolu_1'), 'the first turn\'s task is the chat\'s');
  const p = c.pane();
  // The brain's own has-session check, with a tmux that does not answer once.
  b.sessionAlive = Object.getPrototypeOf(b).sessionAlive;
  const tm = b.tm;
  let slow = 0;
  b.tm = async (a: string[], ...rest: unknown[]) => {
    if (a[0] === 'has-session' && slow++ === 0) { setTimeout(() => p.show('idle'), 200); return { code: 1, out: '', err: '', timedOut: true }; }
    return tm(a, ...rest);
  };
  p.show('busy');
  await c.say('two');
  assert.equal(slow > 0, true, 'has-session was asked');
  assert.ok(c.sent.includes('Answer 2.'), `the chat got: ${JSON.stringify(c.sent)}\nlog:\n${c.log.join('\n')}`);
  assert.equal(p.launches.length, 0, 'not launched again');
  assert.ok(!c.log.some((l) => /is gone before the message was typed/.test(l)), c.log.join('\n'));
  assert.ok(b.ours.has('toolu_1'), 'the live process\'s task is still the chat\'s');
});
