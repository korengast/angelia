import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEY_MISS_LINE, NOT_RUN_LINE, promptKey, TAKEN_LATE_LINE } from '../src/brain/tui.js';
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
  test('review-lows-046: a message Claude Code ran and the chat got the answer of is not typed again after a new conversation', { timeout: 30_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { p.rows(p.prompt(), ROW.text(`Answer ${n}.`)); p.stop(`Answer ${n}.`); p.rows(ROW.over()); });
    await c.say('one');
    const b = c.brain(), p = c.pane();
    // A message pressed into a turn, never seen taken; Claude Code ran it by itself and the chat got its
    // answer (followerOf marks it answered).
    const text = 'a message pressed into the turn before';
    b.unsure.set('m-1', { key: promptKey(text), text, transcript: b.transcript, offset: 0, at: Date.now() - 5000, turn: 1, answered: true });
    // A turn's marker then names a new conversation (another session id): the old file's offsets go.
    const other = join(c.cwd, '00000000-0000-4000-8000-000000000abc.jsonl');
    writeFileSync(other, '');
    p.mark({ text: 'x', transcript_path: other });
    b.takeMarker(Date.now() - 1000);
    // Its own turn comes: not typed again (it ran, and was answered).
    const out: { kind: string; text?: string }[] = [];
    for await (const e of b.turn(text, { msg: 'm-1' })) out.push(e);
    assert.equal(p.enters, 1, 'not typed a second time');
    assert.equal(out.at(-1)?.text, TAKEN_LATE_LINE);
  });
  test('midturn final look L1: an untaken message and a late-taken one that Claude Code joins into one prompt: one answer, none typed again', { timeout: 40_000 }, async (t) => {
    const c = await stubChat({ followStartMs: 1500 } as object); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => {
      if (n === 1) { working(p); return; }
      p.rows(p.prompt(), ROW.text(`Answer ${n}.`));
      p.stop(`Answer ${n}.`);
      p.rows(ROW.over());
    });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    await c.say('first message typed in');
    const p = c.pane();
    // The second one's queue row comes after the confirm wait: it is not seen taken (unsure).
    p.slowRow(2500);
    const second = c.say('second message typed in');
    await until(() => p.queued.length === 2 && p.logs.some((l) => /for the running turn was not taken/.test(l)), 10_000);
    await wait(1200);
    // The turn takes neither; Claude Code joins both into one prompt and runs it.
    p.rows(ROW.result('t1'), ROW.text('One.'));
    p.stop('One.');
    p.rows(ROW.over(), ROW.prompt(`${p.queued[0]}\n\n${p.queued[1]}`), ROW.text('Both at once.'));
    p.show('idle');
    await wait(300);
    p.stop('Both at once.');
    p.rows(ROW.over());
    await first; await second;
    await until(() => c.sent.includes('Both at once.'), 10_000).catch(() => {});
    await wait(1500);
    assert.ok(c.sent.includes('Both at once.'), `${JSON.stringify(c.sent)}\n${p.logs.join('\n')}`);
    assert.equal(c.sent.filter((x) => x === 'Both at once.').length, 1, JSON.stringify(c.sent));
    assert.equal(p.enters, 1, 'neither typed again');
  });
  test('late-answers L4: a slash command Angelia typed, closed on the quiet path: its late answer reaches the chat', { timeout: 30_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    // Written at the Enter (its time is the hook's prompt_at).
    const cmd = () => ({ type: 'user', timestamp: new Date().toISOString(), origin: { kind: 'human' }, message: { role: 'user', content: '<command-name>/review-it</command-name>\n<command-message>review-it</command-message>\n<command-args>now</command-args>' } });
    // Claude Code stores the command as its own row, not as the text typed; the screen reads idle.
    c.onEnter((n, p) => { if (n === 1) p.rows(cmd()); });
    await c.say('/review-it now');
    const p = c.pane();
    // The command's turn goes on after the quiet path closed it, and its Stop comes late.
    p.rows({ type: 'user', isMeta: true, message: { role: 'user', content: 'Review the code now.' } }, ROW.text('Reviewed: all good.'));
    p.stop('Reviewed: all good.');
    await until(() => !p.marked());
    await until(() => c.sent.includes('Reviewed: all good.'), 3000).catch(() => {});
    assert.ok(c.sent.includes('Reviewed: all good.'), `${JSON.stringify(c.sent)}\n${p.logs.join('\n')}`);
  });
  test('recheck-lows-046: a message taken late into a turn closed on the quiet path: that turn\'s late answer, which covers it, reaches the chat', { timeout: 40_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    const p = c.pane();
    // Its queue row comes after the confirm wait: not seen taken (unsure), so it waits for a turn of its own.
    p.slowRow(2500);
    const second = c.say('two');
    await until(() => p.queued.length === 1 && p.logs.some((l) => /for the running turn was not taken/.test(l)), 10_000);
    // The turn takes it late; the screen then reads idle with the call still open, and the quiet path
    // closes the turn with no answer.
    p.rows(ROW.queuedPrompt(p.queued[0]));
    p.show('idle');
    await first;
    // Its own turn finds it taken late: not typed again.
    await second;
    assert.ok(p.logs.some((l) => /taken late; it is not typed again/.test(l)), p.logs.join('\n'));
    // The turn goes on and its Stop comes: one answer for both.
    p.rows(ROW.result('t1'), ROW.text('One and two.'));
    p.stop('One and two.');
    await until(() => !p.marked());
    await until(() => c.sent.includes('One and two.'), 3000).catch(() => {});
    assert.ok(c.sent.includes('One and two.'), `${JSON.stringify(c.sent)}\n${p.logs.join('\n')}`);
    assert.equal(p.enters, 1);
  });
  test('join review: at a stop, a message queued again after a failed turn goes to the next daemon before a newer one held for the running turn', { timeout: 30_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) working(p); });
    void c.say('one');
    await until(() => c.pane()?.enters === 1);
    const q = (c.o as any).queue;
    const msg = (text: string, at: number) => ({ inbound: { platform: 'telegram', chat: '1', sender: 'u1', senderName: 'Owner', text, isGroup: false, mentioned: false, media: [], at }, bare: false });
    // Typed into a turn that failed, queued again as its own (intoTurnAgain): it came first.
    void q.enqueue(c.key, async () => {}, msg('older, queued again', Date.now() - 60_000)).catch(() => {});
    // A newer one, held while it waits for a moment in the running turn.
    q.hold(c.key, msg('newer, held', Date.now()));
    (c.o as any).cutTurns();
    const kept = JSON.parse(readFileSync(join(c.stateDir, 'adopt-turns.json'), 'utf8')).turns[0];
    assert.deepEqual(kept.waiting.map((w: { inbound: { text: string } }) => w.inbound.text), ['older, queued again', 'newer, held']);
  });
});
