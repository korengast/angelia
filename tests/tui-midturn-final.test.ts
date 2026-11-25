import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promptKey } from '../src/brain/tui.js';
import { ROW, stubChat, until, wait } from './tui-stub.js';

// The final look at midturn (2026-11-25): B1, L2, L3. Own state dir and socket before the brain
// modules load; the panes are stubs (tui-stub.ts).
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-midturn-final-'));
process.env.ANGELIA_TMUX_SOCKET = `angelia-test-midturn-final-${process.pid}`;

const working = (p: { rows: (...r: object[]) => void; prompt: () => object; show: (s: 'busy') => void }) => { p.rows(p.prompt(), ROW.call('t1')); p.show('busy'); };

describe('midturn final look, through the real orchestrator with stub panes', { concurrency: true, timeout: 180_000 }, () => {
  test('B1: the next turn\'s prompt row written before the marker is read is still found: its answer reaches the chat', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    await c.say('two');
    const p = c.pane();
    assert.equal(p.queued.length, 1);
    // The turn ends without taking it, and Claude Code starts the next turn at once: its prompt row and
    // first call are written before the daemon reads the first marker.
    p.rows(ROW.result('t1'), ROW.text('First.'));
    p.stop('First.');
    p.rows(ROW.over(), ROW.prompt(p.queued[0]), ROW.call('t2'));
    await until(() => c.sent.length === 1);
    p.rows(ROW.result('t2'), ROW.text('Second.'));
    p.show('idle');
    p.stop('Second.');
    await first;
    assert.deepEqual(c.sent, ['First.', 'Second.']);
  });

  test('B1: a marker keyed as the untaken message is that turn\'s answer, even with no prompt row read', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    await c.say('two');
    const p = c.pane();
    p.rows(ROW.result('t1'), ROW.text('First.'));
    p.stop('First.'); p.rows(ROW.over());
    await until(() => c.sent.length === 1);
    // A prompt row in a form the reader does not know; the hook keys it all the same.
    p.rows({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'image' }] } }, ROW.text('Second.'));
    p.show('idle');
    p.mark({ text: 'Second.', origin: 'prompt', prompt_key: promptKey(p.queued[0]), prompts: 1 });
    await first;
    assert.deepEqual(c.sent, ['First.', 'Second.']);
  });

  test('L2: an empty box after the Enter with nothing in the transcript is no take: the message runs as its own turn', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => {
      if (n === 1) working(p);
      if (n === 2) { p.rows(p.prompt(), ROW.text('Second.')); p.stop('Second.'); }
    });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    c.pane().loseTake();
    const second = c.say('two');
    await until(() => c.pane().lockedAtEnter.length >= 1);
    await wait(4000);
    assert.equal(c.pane().queued.length, 0);
    c.pane().rows(ROW.result('t1'), ROW.text('First.'));
    c.pane().show('idle');
    c.pane().stop('First.');
    await first; await second;
    assert.deepEqual(c.sent, ['First.', 'Second.'], 'not lost: it ran as a turn of its own');
    assert.equal(c.pane().enters, 2);
  });

  test('L3: a mark of a hook that died is cleaned away', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    const b = c.brain();
    const dead = join(b.dir, 'pretool', '999999.in');
    writeFileSync(dead, '1');
    b.pretoolBusy(b.turnSentAt);
    assert.equal(existsSync(dead), false);
    c.pane().rows(ROW.result('t1'), ROW.text('Done.'));
    c.pane().show('idle');
    c.pane().stop('Done.');
    await first;
  });
});
