import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEY_MISS_LINE, NOT_RUN_LINE, promptKey } from '../src/brain/tui.js';
import { ROW, stubChat, until, wait } from './tui-stub.js';

// 0.4.10: the rare timing cases where an answer was lost or a message typed twice in tmux mode. Each
// test failed before its fix. Own state dir and socket before the brain modules load; stub panes.
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-answers-0410-'));
process.env.ANGELIA_TMUX_SOCKET = `angelia-test-answers-0410-${process.pid}`;

const working = (p: { rows: (...r: object[]) => void; prompt: () => object; show: (s: 'busy') => void }) => { p.rows(p.prompt(), ROW.call('t1')); p.show('busy'); };

describe('0.4.10 lost or doubled answers', { concurrency: true, timeout: 180_000 }, () => {
  test('fix-keymiss2: an untaken message that runs after the follow\'s busy timeout: its answer reaches the chat, once', { timeout: 40_000 }, async (t) => {
    const c = await stubChat({ followStartMs: 800 } as object); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    await c.say('two');
    const p = c.pane();
    p.rows(ROW.result('t1'), ROW.text('One.'));
    p.stop('One.');
    p.rows(ROW.over());
    await first;
    assert.ok(p.logs.some((l) => /no turn ran for the messages/.test(l)), p.logs.join('\n'));
    // Claude Code runs it at last, after the follow's wait.
    p.rows(ROW.prompt(p.queued[0]), ROW.text('Two by itself.'));
    p.show('idle');
    p.stop('Two by itself.');
    p.rows(ROW.over());
    await until(() => !p.marked());
    await until(() => c.sent.includes('Two by itself.'), 3000).catch(() => {});
    assert.deepEqual(c.sent, ['One.', 'Two by itself.'], p.logs.join('\n'));
    assert.equal(p.enters, 1);
    assert.ok(!p.logs.some((l) => l.startsWith(NOT_RUN_LINE) || l.startsWith(KEY_MISS_LINE)), p.logs.join('\n'));
  });
  test('recheck-keymiss2: busy most of the follow\'s wait, then idle with the message back in the box: it is typed again and answered, not left for the next paste to clear', { timeout: 40_000 }, async (t) => {
    const c = await stubChat({ followStartMs: 1500, quietMs: 1200 } as object); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => {
      if (n === 1) { working(p); return; }
      p.rows(p.prompt(), ROW.text(`Answer ${n}.`));
      p.stop(`Answer ${n}.`);
      p.rows(ROW.over());
    });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    await c.say('two');
    const p = c.pane();
    // The turn ends; the pane stays busy (a long Stop hook), then goes idle with the untaken message
    // back in the box, a moment before the follow's wait is over.
    p.rows(ROW.result('t1'), ROW.text('One.'));
    p.stop('One.');
    p.rows(ROW.over());
    setTimeout(() => p.show('draft'), 1100);
    await first;
    await until(() => c.sent.includes('Answer 2.'), 10_000).catch(() => {});
    assert.ok(c.sent.includes('Answer 2.'), `typed again and answered: ${JSON.stringify(c.sent)}\n${p.logs.join('\n')}`);
    assert.ok(p.logs.some((l) => l.startsWith(NOT_RUN_LINE)), p.logs.join('\n'));
  });
  test('review-keymiss2: a short untaken message that another message starts with is not taken for run: it is typed again and answered', { timeout: 40_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => {
      if (n === 1) { working(p); return; }
      p.rows(p.prompt(), ROW.text(`Answer ${n}.`));
      p.stop(`Answer ${n}.`);
      p.rows(ROW.over());
    });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    await c.say('ok');
    await c.say('ok and the logs too');
    const p = c.pane();
    assert.equal(p.queued.length, 2);
    // The turn takes the second one only; the first is back in the box, and no turn runs it.
    p.rows(ROW.queuedPrompt(p.queued[1]), ROW.result('t1'), ROW.text('One, and the logs.'));
    p.show('draft');
    p.stop('One, and the logs.');
    p.rows(ROW.over());
    await first;
    await until(() => c.sent.includes('Answer 2.'), 10_000).catch(() => {});
    assert.ok(c.sent.includes('Answer 2.'), `typed again and answered: ${JSON.stringify(c.sent)}\n${p.logs.join('\n')}`);
  });
  test('review-keymiss2 + final2: a turn Claude Code ran by itself for an unsure message ends while this turn\'s own text is read: that text is still this turn\'s answer on the quiet path', { timeout: 40_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) p.rows(p.prompt()); });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    const b = c.brain(), p = c.pane();
    await until(() => !!b.beating, 10_000);
    // A message pressed into the turn before, never seen taken (unsure): Claude Code ran it by itself.
    const text = 'a message pressed into the turn before';
    b.unsure.set('m-1', { key: promptKey(text), text, transcript: b.transcript, offset: 0, at: Date.now() - 5000, turn: 1, answered: false });
    // In one poll: that turn's text and marker, and this turn's own text after it. This turn's Stop
    // hook then fails (no marker): the quiet path ends it.
    p.rows(ROW.prompt(text), ROW.text('The pressed one.'), ROW.over(), ROW.text('Own answer.'));
    p.mark({ text: 'The pressed one.', origin: 'prompt', prompt_key: promptKey(text), prompts: 1 });
    p.show('idle');
    await first;
    await until(() => c.sent.length >= 2, 3000).catch(() => {});
    // Once each: the pressed one's words are not also a progress line of this turn (midturn final2).
    assert.deepEqual(c.sent, ['The pressed one.', 'Own answer.'], p.logs.join('\n'));
  });
});
