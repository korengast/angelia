import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROW, stubChat, until, wait, type PaneStub } from './tui-stub.js';

// The Fable recheck of 0.4.4: a message typed into a turn whose tmux stalled, and the owner's teammate
// settled as the chat's. Own state dir and socket before the brain modules load; the panes are stubs.
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-recheck-044-'));
process.env.ANGELIA_TMUX_SOCKET = `angelia-test-recheck-044-${process.pid}`;
const { TMUX_STALLED_LINE } = await import('../src/core/deliver/text.js');

const taken = async (p: PaneStub) => { await until(() => !p.marked()); await wait(150); };
const interrupted = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });

test('a message typed into a turn whose tmux stalls is not queued again: the turn runs on, and its late answer covers it', { timeout: 45_000 }, async (t) => {
  const c = await stubChat(); t.after(() => c.o.shutdown());
  c.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), ROW.call('t1')); p.show('busy'); } });
  const first = c.say('one');
  await until(() => c.pane()?.enters === 1);
  const b = c.brain();
  await until(() => !!b.beating, 10_000);
  await wait(150);
  await c.say('two');
  const p = c.pane();
  assert.equal(p.queued.length, 1, 'typed into the running turn');
  p.rows(ROW.queuedPrompt(p.queued[0]));
  await wait(800);
  // tmux stops answering: the reader gives up, the pane is kept, the turn runs on.
  const real = b.capture.bind(b);
  let slow = true;
  b.capture = async (l?: number) => { if (slow) { b.captureTimedOut = true; return ''; } b.captureTimedOut = false; return real(l); };
  const tm = b.tm.bind(b);
  b.tm = async (a: string[]) => (a[0] === 'has-session' && slow ? { code: 1, out: '', err: '', timedOut: true } : tm(a));
  await first;
  await wait(1500);
  assert.deepEqual(c.sent, [TMUX_STALLED_LINE]);
  assert.ok(!c.log.some((l) => /typed into a failed turn is queued as its own/.test(l)), c.log.join('\n'));
  assert.equal(p.enters, 1, 'not typed again as a turn of its own');
  // tmux answers again; the turn ends with one answer to both.
  slow = false;
  p.rows(ROW.result('t1'), ROW.text('One and two.'));
  p.stop('One and two.');
  await until(() => c.sent.length === 2, 10_000);
  assert.equal(c.sent[1], 'One and two.');
  await wait(800);
  assert.equal(p.enters, 1);
});

test('a teammate the owner spawned in a turn cut with Esc stays theirs when the chat\'s teammate then reports', { timeout: 18_000 }, async (t) => {
  const c = await stubChat(); t.after(() => c.o.shutdown());
  c.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), ...ROW.teammate('toolu_s', 'scout'), ROW.text('spawned')); p.stop('spawned'); } });
  await c.say('send a scout');
  const p = c.pane();
  const b = c.brain();
  // The owner, in the app, spawns a helper, then presses Esc: no Stop marker for that turn.
  p.rows(ROW.over(), ROW.prompt('a helper of mine'), ...ROW.teammate('toolu_h', 'helper'), interrupted());
  await wait(300);
  // The chat's scout reports: that turn is the chat's, and the helper is not of it.
  p.rows(ROW.teammateMessage('scout', 'done'), ROW.text('The scout is done.'));
  p.stop('The scout is done.');
  await until(() => c.sent.length === 2);
  assert.equal(b.oursTeammates.has('helper'), false, 'the owner\'s helper is not the chat\'s');
  p.rows(ROW.over(), ROW.teammateMessage('helper', 'mine'), ROW.text('Your helper is back.'));
  p.stop('Your helper is back.');
  await taken(p);
  assert.match(c.lines().at(-1)!, /the teammate that sent it was not started by a turn of this chat/);
  assert.deepEqual(c.sent, ['spawned', 'The scout is done.']);
});

test('a teammate spawned in a turn typed in the desk app is the owner\'s, though a tied turn comes next', { timeout: 18_000 }, async (t) => {
  const c = await stubChat(); t.after(() => c.o.shutdown());
  c.onEnter((n, p) => {
    if (n === 1) { p.rows(p.prompt(), ...ROW.teammate('toolu_s', 'scout'), ROW.text('spawned')); p.stop('spawned'); }
    if (n === 2) { p.rows(ROW.over(), p.prompt(), ...ROW.teammate('toolu_h', 'helper'), ROW.text('Spawned your helper.')); p.stop('Spawned your helper.'); }
  });
  await c.say('send a scout');
  const p = c.pane();
  const b = c.brain();
  // A turn the owner typed in the desk app into this chat's session (TurnFlags.app): not recorded.
  const said: string[] = [];
  for await (const e of b.turn('a helper of mine', { app: true })) if (e.kind === 'result') said.push(e.text);
  assert.deepEqual(said, ['Spawned your helper.']);
  // The chat's scout reports: its turn is tied, and the app turn's helper is not of it.
  p.rows(ROW.over(), ROW.teammateMessage('scout', 'done'), ROW.text('The scout is done.'));
  p.stop('The scout is done.');
  await until(() => c.sent.length === 2);
  assert.equal(b.oursTeammates.has('helper'), false, 'the desk app turn\'s helper is not the chat\'s');
  p.rows(ROW.over(), ROW.teammateMessage('helper', 'mine'), ROW.text('Your helper is back.'));
  p.stop('Your helper is back.');
  await taken(p);
  assert.match(c.lines().at(-1)!, /the teammate that sent it was not started by a turn of this chat/);
  assert.deepEqual(c.sent, ['spawned', 'The scout is done.']);
});
