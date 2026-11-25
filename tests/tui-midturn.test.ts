import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paneBusy, paneIdle, paneMidTurn } from '../src/brain/tmux.js';
import { BUSY_PANE_LINE } from '../src/brain/tui.js';
import { Config } from '../src/instance/config/schema.js';
import { ROW, stubChat, until, wait } from './tui-stub.js';

// Own state dir and socket before the brain modules load: nothing here can touch a live Angelia. The
// panes are stubs (tui-stub.ts); the Stop hook that writes the markers is the real script.
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-midturn-'));
process.env.ANGELIA_TMUX_SOCKET = `angelia-test-midturn-${process.pid}`;

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/pane-${name}.txt`, import.meta.url)), 'utf8');

test('a running turn may be typed into only while its input box is on screen, empty, with no dialog (claude 2.1.332)', () => {
  // A turn at work (a sleep runs), the box empty: Claude Code queues what is submitted.
  assert.equal(paneMidTurn(fixture('busy-box-332')), true);
  assert.equal(paneBusy(fixture('busy-box-332')), true);
  assert.equal(paneIdle(fixture('busy-box-332')), false);
  // Messages queued already: the box shows Claude Code's own hint, which is no text.
  assert.equal(paneMidTurn(fixture('busy-queued-332')), true);
  // Someone's text in the box: Enter would send it with ours.
  assert.equal(paneMidTurn(fixture('busy-halftyped-332')), false);
  // A permission dialog replaces the box: Enter would answer it.
  assert.equal(paneMidTurn(fixture('permission-332')), false);
  assert.equal(paneMidTurn(fixture('permission')), false);
  // Not at work: a message there is a turn of its own.
  assert.equal(paneMidTurn(fixture('idle')), false);
  assert.equal(paneMidTurn(''), false);
});

test('midturn is a boolean on a profile, unset by default (on), and nothing else', () => {
  const base = { profiles: { a: { cwd: '/tmp' } }, routes: [] };
  assert.equal(Config.parse(base).profiles.a.midturn, undefined);
  assert.equal(Config.parse({ ...base, profiles: { a: { cwd: '/tmp', tui: true, midturn: false } } }).profiles.a.midturn, false);
  assert.throws(() => Config.parse({ ...base, profiles: { a: { cwd: '/tmp', midturn: 'yes' } } }));
});

/** The turn's first Enter: a tool call starts and the screen shows the turn at work. */
const working = (p: { rows: (...r: object[]) => void; prompt: () => object; show: (s: 'busy') => void }) => { p.rows(p.prompt(), ROW.call('t1')); p.show('busy'); };
const midLines = (log: string[]) => log.filter((l) => /running turn|mid-turn answer|ended between turns/.test(l));

describe('tmux mode: a chat message that comes while a turn runs', { concurrency: true, timeout: 180_000 }, () => {
  test('goes into the running turn: Claude Code takes it at the next tool boundary, and the turn\'s one answer answers both', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('run the long check');
    await until(() => c.pane()?.enters === 1);
    await wait(150); // the tool call has run past the settle time
    const second = c.say('also tell me the date');
    await until(() => c.pane().queued.length === 1);
    await second; // nothing else to wait for: it is in the turn
    const p = c.pane();
    assert.match(p.queued[0], /also tell me the date/, 'the message itself');
    assert.match(p.queued[0], /^\[/, 'under the same header line a turn gets');
    // Claude Code gives it to the model with the tool's result, and the turn ends once.
    p.rows(ROW.queuedPrompt(p.queued[0]), ROW.result('t1'), ROW.text('The check passed. It is Tuesday.'));
    p.show('idle');
    p.stop('The check passed. It is Tuesday.');
    await first;
    assert.deepEqual(c.sent, ['The check passed. It is Tuesday.'], 'one answer, no line about a queue or a busy session');
    assert.equal(p.enters, 1, 'no turn of its own was typed');
    assert.deepEqual(p.lockedAtEnter, [true], 'the Enter was pressed under the PreToolUse lock');
    assert.equal(existsSync(join(c.brain().dir, 'absorb.lock')), false, 'and the lock went once the message was taken');
    await wait(200);
    assert.deepEqual(c.sent.length, 1);
    assert.ok(c.log.some((l) => /message went into the running turn key=telegram:1/.test(l)));
  });

  test('when Claude Code runs it as the next turn after all, that turn is the chat\'s and its answer is delivered', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('write the report');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    await c.say('and send it to me');
    const p = c.pane();
    assert.equal(p.queued.length, 1);
    // The tool came back before the queue was read, and the model ended the turn: Claude Code then runs
    // the queued message as a turn of its own (measured on 2.1.332), with its own Stop.
    p.rows(ROW.result('t1'), ROW.text('The report is written.'));
    p.stop('The report is written.'); p.rows(ROW.over());
    await until(() => c.sent.length === 1);
    // Read as a turn of the chat's: it runs, and the chat sees it running.
    assert.ok((c.o as any).running.get(c.key), 'the turn Claude Code runs for it is the chat\'s running turn');
    p.rows(ROW.prompt(p.queued[0]), ROW.text('Sending it now.'), ROW.call('t2'), ROW.result('t2'), ROW.text('Sent.'));
    p.show('idle');
    p.stop('Sent.'); p.rows(ROW.over());
    await first;
    assert.deepEqual(c.sent, ['The report is written.', 'Sending it now.', 'Sent.'], 'its progress line and its answer');
    // And a turn someone else typed afterwards is still not the chat's.
    p.rows(ROW.prompt('typed in the app'), ROW.text('Private.'));
    p.stop('Private.'); p.rows(ROW.over());
    await until(() => !p.marked());
    await wait(150);
    assert.deepEqual(c.sent, ['The report is written.', 'Sending it now.', 'Sent.']);
    assert.equal(midLines(c.log).filter((l) => /a person typed it/.test(l)).length, 1);
  });

  test('a next message the chat sends while that separate turn runs is not told the session is busy', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => {
      if (n === 1) working(p);
      if (n === 2) { p.rows(p.prompt(), ROW.text('Third.')); p.stop('Third.'); }
    });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    await c.say('two');
    const p = c.pane();
    p.rows(ROW.result('t1'), ROW.text('First.'));
    p.stop('First.'); p.rows(ROW.over());
    await until(() => c.sent.length === 1);
    // Claude Code works on the queued message as its own turn when the next one comes.
    p.rows(ROW.prompt(p.queued[0]));
    const third = c.say('three');
    await wait(300);
    p.rows(ROW.text('Second.'));
    p.stop('Second.'); p.rows(ROW.over());
    p.show('idle');
    await first;
    await third;
    assert.ok(!c.sent.includes(BUSY_PANE_LINE), c.sent.join(' | '));
    assert.deepEqual(c.sent, ['First.', 'Second.', 'Third.']);
  });

  test('never typed while a permission dialog is open or the box holds someone\'s text: it waits for its own turn', { timeout: 45_000 }, async (t) => {
    for (const screen of ['dialog', 'half'] as const) {
      const c = await stubChat(); t.after(() => c.o.shutdown());
      c.onEnter((n, p) => {
        if (n === 1) { p.rows(p.prompt(), ROW.call('t1')); p.show(screen); }
        if (n === 2) { p.rows(p.prompt(), ROW.text('Second answer.')); p.stop('Second answer.'); }
      });
      const first = c.say('first');
      await until(() => c.pane()?.enters === 1);
      await wait(150);
      const second = c.say('second');
      await wait(800);
      const p = c.pane();
      assert.equal(p.buffers.length, 1, `${screen}: nothing was pasted into the turn`);
      // The turn ends; the message runs as a turn of its own, as before.
      p.rows(ROW.result('t1'), ROW.text('First answer.'));
      p.show('idle');
      p.stop('First answer.');
      await first;
      await second;
      assert.equal(p.enters, 2, screen);
      assert.equal(p.queued.length, 0, screen);
      assert.deepEqual(c.sent, ['First answer.', 'Second answer.'], screen);
    }
  });

  test('waits while no tool call runs (the model is writing), and goes in once one has run a moment', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), ROW.text('Looking.')); p.show('busy'); } });
    const first = c.say('look into it');
    await until(() => c.pane()?.enters === 1);
    const second = c.say('and the logs too');
    await wait(600);
    const p = c.pane();
    assert.equal(p.queued.length, 0, 'not while the model writes: a tool call it starts could open a dialog under the Enter');
    p.rows(ROW.call('t2'));
    await until(() => p.queued.length === 1);
    await second;
    p.rows(ROW.queuedPrompt(p.queued[0]), ROW.result('t2'), ROW.text('Both looked at.'));
    p.show('idle');
    p.stop('Both looked at.');
    await first;
    assert.deepEqual(c.sent, ['Looking.', 'Both looked at.']);
  });

  test('a subagent at work in the turn holds the message back (its calls can ask at any moment)', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    const agent = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { prompt: 'x' } }] } };
    c.onEnter((n, p) => {
      if (n === 1) { p.rows(p.prompt(), agent); p.show('busy'); }
      if (n === 2) { p.rows(p.prompt(), ROW.text('Second.')); p.stop('Second.'); }
    });
    const first = c.say('research it');
    await until(() => c.pane()?.enters === 1);
    const second = c.say('and more');
    await wait(600);
    const p = c.pane();
    assert.equal(p.queued.length, 0);
    p.rows({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 'a1', type: 'tool_result', content: 'ok' }] } }, ROW.text('First.'));
    p.show('idle');
    p.stop('First.'); p.rows(ROW.over());
    await first; await second;
    assert.deepEqual(c.sent, ['First.', 'Second.']);
  });

  test('a permission request waiting on the hook holds the message back: Claude Code draws its dialog while the hook runs', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('first');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    const b = c.brain();
    await until(() => b.intoTurnBlocked(b.gen, b.turnSentAt) === null);
    // The hook wrote a request (not yet taken by the reader): the screen may not show the dialog yet.
    mkdirSync(join(b.dir, 'permissions'), { recursive: true });
    writeFileSync(join(b.dir, 'permissions', `${randomUUID()}.request.json`), '{}');
    assert.equal(b.intoTurnBlocked(b.gen, b.turnSentAt), 'a permission request is open');
    c.pane().rows(ROW.result('t1'), ROW.text('Done.'));
    c.pane().show('idle');
    c.pane().stop('Done.');
    await first;
  });

  test('midturn: false keeps today\'s behaviour: the message waits for the turn and runs as its own', { timeout: 45_000 }, async (t) => {
    const c = await stubChat({}, {}, { midturn: false }); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => {
      if (n === 1) working(p);
      if (n === 2) { p.rows(p.prompt(), ROW.text('Second.')); p.stop('Second.'); }
    });
    const first = c.say('first');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    const second = c.say('second');
    await wait(600);
    const p = c.pane();
    assert.equal(p.buffers.length, 1, 'nothing pasted into the turn');
    p.rows(ROW.result('t1'), ROW.text('First.'));
    p.show('idle');
    p.stop('First.'); p.rows(ROW.over());
    await first; await second;
    assert.deepEqual(c.sent, ['First.', 'Second.']);
    assert.equal(p.enters, 2);
  });

  test('a command the router answers is never typed into the turn', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('first');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    await c.say('/status');
    const p = c.pane();
    assert.equal(p.queued.length, 0);
    assert.equal(p.buffers.length, 1);
    p.rows(ROW.result('t1'), ROW.text('Done.'));
    p.show('idle');
    p.stop('Done.');
    await first;
    assert.equal(c.sent[c.sent.length - 1], 'Done.');
  });

  test('several messages go in one by one, in the order they came', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('first');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    await Promise.all([c.say('message A'), c.say('message B'), c.say('message C')]);
    const p = c.pane();
    assert.equal(p.queued.length, 3);
    assert.deepEqual(p.queued.map((q) => /message ([ABC])/.exec(q)?.[1]), ['A', 'B', 'C']);
    p.rows(...p.queued.map((q) => ROW.queuedPrompt(q)), ROW.result('t1'), ROW.text('All three.'));
    p.show('idle');
    p.stop('All three.');
    await first;
    assert.deepEqual(c.sent, ['All three.']);
  });
});
