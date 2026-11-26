import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEY_MISS_LINE, NOT_RUN_LINE, promptKey } from '../src/brain/tui.js';
import { promptKey as hookKey } from '../scripts/turn-origin.mjs';
import { ROW, stubChat, until, wait } from './tui-stub.js';

// The key misses 0.4.7 did not explain (2026-11-26, a customer's 0.4.4 server): the lead to test was
// a message typed into a running turn and not taken (M1), the box holding it at the turn's end, a new
// message (M2) clearing the box and pasting, and M1's follow then setting the kept key to M1's, so
// M2's marker missed. Driven here through the real orchestrator with stub panes (tui-stub.ts). Own
// state dir and socket before the brain modules load.
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-keymiss2-'));
process.env.ANGELIA_TMUX_SOCKET = `angelia-test-keymiss2-${process.pid}`;

const working = (p: { rows: (...r: object[]) => void; prompt: () => object; show: (s: 'busy') => void }) => { p.rows(p.prompt(), ROW.call('t1')); p.show('busy'); };
/** The key the Stop hook made of the last typed prompt in the transcript. */
const lastPromptKey = (file: string): string => {
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.type === 'user' && typeof r.message?.content === 'string');
  return hookKey(rows[rows.length - 1].message.content);
};

describe('a message typed into a turn and not taken, then a new message at the turn\'s end', { concurrency: true, timeout: 120_000 }, () => {
  test('the box held the untaken message and nothing ran it: the next message is keyed as typed, and the untaken one is typed again and answered, never lost', { timeout: 40_000 }, async (t) => {
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
    await c.say('two');
    const p = c.pane();
    assert.equal(p.queued.length, 1, 'Claude Code queued it (its enqueue row is in the transcript)');
    // The turn ends without giving it to the model. It is back in the input box (as "Press up to edit
    // queued messages" puts it there), and Claude Code runs no turn for it.
    p.rows(ROW.result('t1'), ROW.text('One.'));
    p.show('draft');
    p.stop('One.');
    p.rows(ROW.over());
    // The next message comes at the turn's end.
    const third = c.say('three');
    await first;
    await third;
    await until(() => p.enters === 3, 15_000).catch(() => {});
    const b = c.brain();
    assert.ok(p.logs.some((l) => /the input box held text before a paste; cleared/.test(l)), p.logs.join('\n'));
    assert.ok(!p.logs.some((l) => l.startsWith(KEY_MISS_LINE)), p.logs.join('\n'));
    assert.equal(b.typedKey, lastPromptKey(p.transcript), 'the kept key is the key of the prompt Claude Code stored for the last turn');
    assert.ok(c.sent.includes('One.'), JSON.stringify(c.sent));
    assert.equal(p.enters, 3, `the untaken message was typed again as a turn of its own (typed: ${JSON.stringify(p.buffers.map((x) => x.slice(-12)))})`);
    await until(() => c.sent.includes('Answer 2.') && c.sent.includes('Answer 3.'), 8000).catch(() => {});
    assert.ok(c.sent.includes('Answer 2.') && c.sent.includes('Answer 3.'), `both answered: ${JSON.stringify(c.sent)}`);
    assert.ok(p.logs.some((l) => l.startsWith(NOT_RUN_LINE)), p.logs.join('\n'));
  });

  test('the pane stays busy past the follow\'s start wait: the untaken message is not typed again, and runs once', { timeout: 40_000 }, async (t) => {
    // followStartMs (30 s in the daemon) short: the pane is still at work when it passes.
    const c = await stubChat({ followStartMs: 800 } as object); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    await c.say('two');
    const p = c.pane();
    // The turn ends without giving it to the model; the pane stays busy (another plugin's Stop hook),
    // with the message still in Claude Code's queue.
    p.rows(ROW.result('t1'), ROW.text('One.'));
    p.stop('One.');
    p.rows(ROW.over());
    await first;
    assert.ok(p.logs.some((l) => /no turn ran for the messages/.test(l)), p.logs.join('\n'));
    // Claude Code runs it at last.
    p.rows(ROW.prompt(p.queued[0]), ROW.text('Two by itself.'));
    p.show('idle');
    p.stop('Two by itself.');
    p.rows(ROW.over());
    await until(() => !p.marked());
    await wait(1000);
    assert.equal(p.buffers.length, 2, `typed once each: ${JSON.stringify(p.buffers.map((x) => x.slice(-12)))}`);
    assert.equal(p.queued.length, 1);
    assert.equal(p.enters, 1);
    assert.ok(!p.logs.some((l) => l.startsWith(NOT_RUN_LINE) || l.startsWith(KEY_MISS_LINE)), p.logs.join('\n'));
  });

  test('the untaken message ran by itself (as Claude Code 2.1.332 does): read as the follow, not typed again', { timeout: 40_000 }, async (t) => {
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
    await c.say('two');
    const p = c.pane();
    p.rows(ROW.result('t1'), ROW.text('One.'));
    p.show('idle');
    p.stop('One.');
    p.rows(ROW.over());
    await wait(300);
    p.rows(ROW.prompt(p.queued[0]), ROW.text('Two by itself.'));
    p.stop('Two by itself.');
    p.rows(ROW.over());
    await Promise.race([first, wait(10_000)]);
    await until(() => c.sent.includes('Two by itself.'), 8000).catch(() => { throw new Error(`${JSON.stringify(c.sent)}\n${p.logs.join('\n')}\n${c.log.join('\n')}`); });
    await c.say('three');
    assert.equal(p.enters, 2, 'typed once');
    assert.ok(c.sent.includes('Answer 2.'), JSON.stringify(c.sent));
    assert.ok(!p.logs.some((l) => l.startsWith(KEY_MISS_LINE) || l.startsWith(NOT_RUN_LINE)), p.logs.join('\n'));
  });
});

describe('the key a turn\'s marker is held to is the key of what that turn typed', { concurrency: true, timeout: 60_000 }, () => {
  test('the brain\'s kept key changed while the turn runs (as a follow of another message would set it): the turn\'s own marker still matches', { timeout: 20_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) p.rows(p.prompt(), ROW.call('t1')); });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    const b = c.brain(), p = c.pane();
    const own = b.typedKey;
    assert.equal(own, promptKey(p.typed));
    b.typedKey = promptKey('another message, typed into the turn before');
    b.typedBy = 'follow';
    p.rows(ROW.result('t1'), ROW.text('One.'));
    p.show('idle');
    p.stop('One.');
    await first;
    assert.ok(c.sent.includes('One.'), `${JSON.stringify(c.sent)}\n${p.logs.join('\n')}`);
    assert.ok(!p.logs.some((l) => l.startsWith(KEY_MISS_LINE)), p.logs.join('\n'));
  });

  test('a message typed into this turn ran by itself before this turn\'s marker was read: its answer goes to the chat, not dropped as a key miss', { timeout: 30_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    await c.say('two');
    const p = c.pane();
    // This turn's own Stop is not seen (its marker overwritten before a poll read it); the untaken
    // message's turn, which Claude Code runs only after this one, writes the marker the reader finds.
    p.rows(ROW.result('t1'), ROW.text('One.'), ROW.over(), ROW.prompt(p.queued[0]), ROW.text('Two by itself.'));
    p.show('idle');
    p.stop('Two by itself.');
    p.rows(ROW.over());
    await first;
    await until(() => c.sent.includes('Two by itself.'), 8000).catch(() => {});
    assert.ok(c.sent.includes('Two by itself.'), `${JSON.stringify(c.sent)}\n${p.logs.join('\n')}`);
    assert.ok(!p.logs.some((l) => l.startsWith(KEY_MISS_LINE)), p.logs.join('\n'));
  });
});
