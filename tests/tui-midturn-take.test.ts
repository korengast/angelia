import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promptKey, UNCONFIRMED_LINE } from '../src/brain/tui.js';
import { ROW, jsonl, stubChat, until, wait } from './tui-stub.js';

// The take check, after the last look at midturn (2026-11-25): the transcript's word that Claude Code
// queued the message, waited for; a prompt row of text blocks; an enqueue row of another message.
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-midturn-take-'));
process.env.ANGELIA_TMUX_SOCKET = `angelia-test-midturn-take-${process.pid}`;

const working = (p: { rows: (...r: object[]) => void; prompt: () => object; show: (s: 'busy') => void }) => { p.rows(p.prompt(), ROW.call('t1')); p.show('busy'); };

describe('the take of a message typed into a running turn', { concurrency: true, timeout: 180_000 }, () => {
  test('the box empties at the Enter and the confirming row comes seconds later: still one take, no second turn', { timeout: 45_000 }, async (t) => {
    const c = await stubChat({ confirmMs: 8000 }); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    c.pane().slowRow(4500);
    await c.say('two');
    const p = c.pane();
    assert.equal(p.queued.length, 1);
    assert.equal(p.lockedAtEnter.length, 1, 'one Enter');
    assert.ok(!c.log.some((l) => l.includes(UNCONFIRMED_LINE)));
    p.rows(ROW.queuedPrompt(p.queued[0]), ROW.result('t1'), ROW.text('Both.'));
    p.show('idle');
    p.stop('Both.');
    await first;
    await wait(300);
    assert.deepEqual(c.sent, ['Both.']);
    assert.equal(p.enters, 1);
  });

  test('no confirming row in time: one fixed log line, and the message runs as its own turn', { timeout: 45_000 }, async (t) => {
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
    await until(() => c.log.some((l) => l.includes(UNCONFIRMED_LINE)), 10_000);
    c.pane().rows(ROW.result('t1'), ROW.text('First.'));
    c.pane().show('idle');
    c.pane().stop('First.');
    await first; await second;
    assert.deepEqual(c.sent, ['First.', 'Second.']);
    assert.equal(c.log.filter((l) => l.includes(UNCONFIRMED_LINE)).length, 1, 'said once');
  });

  test('the transcript\'s word: an enqueue row of this message, a prompt row of text blocks; not another message\'s enqueue', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    const b = c.brain();
    const p = c.pane();
    const key = promptKey('our message');
    const from = (await import('node:fs')).statSync(p.transcript).size;
    appendFileSync(p.transcript, jsonl([{ type: 'queue-operation', operation: 'enqueue', content: 'someone else\'s message' }]));
    assert.equal(b.queuedSince(from, key), false, 'another message queued is not ours');
    appendFileSync(p.transcript, jsonl([{ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text: 'our message' }] } }]));
    assert.equal(b.queuedSince(from, key), true, 'a prompt row of text blocks counts');
    const from2 = (await import('node:fs')).statSync(p.transcript).size;
    appendFileSync(p.transcript, jsonl([{ type: 'queue-operation', operation: 'enqueue', content: 'our message' }]));
    assert.equal(b.queuedSince(from2, key), true, 'its own enqueue row counts');
    p.rows(ROW.result('t1'), ROW.text('Done.'));
    p.show('idle');
    p.stop('Done.');
    await first;
  });
});
