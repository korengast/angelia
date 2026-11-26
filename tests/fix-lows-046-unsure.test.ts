import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UNCONFIRMED_LINE } from '../src/brain/tui.js';
import { ROW, stubChat, until, wait } from './tui-stub.js';

// 0.4.6 fix-lows: an unsure entry (a message pressed into a running turn, its take never confirmed)
// keeps the turn of its Enter. The running turn's own marker, keyed the same as that message ("ok"
// then "ok"), is that turn's answer, never the second message's follower.
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-fl046-unsure-'));
process.env.ANGELIA_TMUX_SOCKET = `angelia-test-fl046-unsure-${process.pid}`;

const working = (p: { rows: (...r: object[]) => void; prompt: () => object; show: (s: 'busy') => void }) => { p.rows(p.prompt(), ROW.call('t1')); p.show('busy'); };

describe('the same words pressed into the turn that runs them', { timeout: 90_000 }, () => {
  test('"ok" then "ok", the Enter not confirmed: the turn\'s own marker is its answer, and the second "ok" gets its own turn', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => {
      if (n === 1) working(p);
      if (n === 2) { p.rows(p.prompt(), ROW.text('Second.')); p.stop('Second.'); }
    });
    const first = c.say('ok');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    c.pane().loseTake();
    const second = c.say('ok');
    await until(() => c.log.some((l) => l.includes(UNCONFIRMED_LINE)), 10_000);
    const b = c.brain(), sentAt = b.turnSentAt;
    assert.deepEqual([...b.unsure.values()].map((u: { turn: number }) => u.turn), [sentAt], 'the unsure entry keeps the turn of its Enter');
    c.pane().rows(ROW.result('t1'), ROW.text('First.'));
    c.pane().show('idle');
    const ended = Date.now();
    c.pane().stop('First.');
    await first;
    assert.ok(Date.now() - ended < 2000, 'the turn ended at its own marker, not on the quiet path');
    await second;
    await wait(300);
    assert.deepEqual(c.sent, ['First.', 'Second.']);
    assert.deepEqual(c.lines(), [], 'no answer went out as one nobody asked for');
    assert.equal(c.pane().enters, 2, 'the second "ok" was typed as its own turn');
  });
});
