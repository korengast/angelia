import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selfCapLine } from '../src/core/deliver/text.js';
import { ROW, stubChat, until, wait, type PaneStub } from './tui-stub.js';

// Own state dir and socket before the brain modules load: nothing here can touch a live Angelia. The
// panes are stubs (tui-stub.ts); the Stop hook that writes the markers is the real script.
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-self-'));
process.env.ANGELIA_TMUX_SOCKET = `angelia-test-self-${process.pid}`;

/** A first turn, answered the usual way: from its end on the pool holds the session between turns. */
const first = (n: number, p: PaneStub) => {
  if (n === 1) { p.rows(p.prompt(), ...ROW.background('toolu_1'), ...ROW.background('toolu_2'), ...ROW.background('toolu_3'), ROW.text('Started.')); p.stop('Started.'); }
};
/** A marker of a turn a task's end started, of a task the first turn started. */
const woke = (text: string) => ({ text, origin: 'notification', origin_ids: ['toolu_1'] });
/** Wait until the reader between turns took the marker, and a little more for what it started. */
const taken = async (p: PaneStub) => { await until(() => !p.marked()); await wait(150); };

// tmux mode: between turns, Claude Code may wake the agent by itself (a background task ended), and
// the agent answers with nobody waiting. That answer reaches the chat; a turn typed in the Claude app
// never does.
describe('tmux mode: a turn the agent started by itself, between turns', { concurrency: true }, () => {
  test('the answer to a task\'s end reaches the chat; a turn typed in the app, or one of unknown start, does not', { timeout: 18_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter(first);
    await c.say('start the build');
    assert.deepEqual(c.sent, ['Started.']);
    const p = c.pane();

    // The task ends, Claude Code wakes the agent, the agent reports, the Stop hook runs.
    p.rows(ROW.notification(), ROW.text('The build passed: 212 tests.'));
    p.stop('The build passed: 212 tests.');
    await until(() => c.sent.length === 2);
    assert.equal(c.sent[1], 'The build passed: 212 tests.');
    assert.deepEqual(c.lines(), [`self-started answer delivered key=${c.key} chars=28`]);

    // A prompt the session scheduled for itself fires: nothing ties it to a turn of the chat's, so it stays in the app.
    p.rows(ROW.over(), ...ROW.scheduled('Check the mail.'), ROW.text('No new mail.'));
    p.stop('No new mail.');
    await taken(p);
    assert.match(c.lines()[1], /is not delivered: nothing ties it to work a turn of this chat started; 12 chars/);
    // The end of a task the owner started from the app, not in a turn of the chat's.
    p.rows(ROW.over(), ROW.notification('toolu_owner'), ROW.text('Your own build passed.'));
    p.stop('Your own build passed.');
    await taken(p);
    assert.match(c.lines()[2], /is not delivered: the work it reports was not started by a turn of this chat; 22 chars/);
    c.log.splice(c.log.indexOf(c.lines()[1]), 2); // the checks below count from the task's answer

    // The owner types in the Claude app: that turn's answer stays there.
    p.rows(ROW.over(), ROW.prompt('typed in the app'), ROW.text('For the app only.'));
    p.stop('For the app only.');
    await taken(p);
    assert.match(c.lines()[1], /^tmux: a turn ended between turns and its answer is not delivered: a person typed it in the Claude app or the pane \(a typed prompt \(origin human\)\); 17 chars pane=\S+ key=telegram:1$/);

    // A task ended while the owner's typed turn ran, and both were answered in one turn: the app's.
    p.rows(ROW.prompt('and the logs?'), ROW.call('t5'), ROW.result('t5'), ROW.notification('toolu_2'), ROW.text('Clean. And the second build passed.'));
    p.stop('Clean. And the second build passed.');
    await taken(p);
    assert.match(c.lines()[2], /a person typed it in the Claude app or the pane \(a typed prompt \(origin human\), <task-notification> \(origin task-notification\)\)/);

    // A row nobody typed, of a kind the hook does not know; and a marker with no origin at all (an older hook).
    p.rows({ type: 'user', origin: { kind: 'some-new-kind' }, message: { role: 'user', content: 'Check the mail.' } }, ROW.text('No mail.'));
    p.stop('No mail.');
    await taken(p);
    assert.match(c.lines()[3], /is not delivered: what started it is not known \(a row nobody typed \(origin some-new-kind\)\); 8 chars/);
    p.mark({ text: 'From an older hook.' });
    await taken(p);
    assert.match(c.lines()[4], /is not delivered: what started it is not known; 19 chars/);

    assert.deepEqual(c.sent, ['Started.', 'The build passed: 212 tests.'], 'only the task\'s answer went out');
    assert.equal(c.lines().length, 5, 'one line per marker, delivered or not');
    assert.ok(!c.log.some((l) => /212 tests|For the app|No mail|older hook/.test(l)), 'never the words');
  });

  test('a pane adopted after a restart: the old task starts its first read finds are not the chat\'s', { timeout: 18_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), ROW.text('Started.')); p.stop('Started.'); } });
    await c.say('start the build');
    const b = c.brain(), p = c.pane();
    // The owner started a task from the app; a restarted daemon adopts the pane and reads it from the start.
    p.rows(ROW.prompt('build it from the app'), ...ROW.background('toolu_owner'), ROW.text('Building.'));
    assert.equal(await b.adopt(Date.now()), true);
    b.at = 0;
    b.readTranscript();
    b.turnSentAt = undefined;
    p.rows(ROW.over(), ROW.notification('toolu_owner'), ROW.text('Your build passed.'));
    p.stop('Your build passed.');
    await taken(p);
    assert.deepEqual(c.sent, ['Started.']);
    assert.match(c.lines().at(-1)!, /not delivered: the work it reports was not started by a turn of this chat; 18 chars/);
  });

  test('nothing to say is nothing sent: no text, [SILENT], the CLI\'s error row, a usage limit', { timeout: 18_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter(first);
    await c.say('start the build');
    const p = c.pane();
    p.mark(woke(''));
    await taken(p);
    p.mark(woke(' [SILENT]\n'));
    await taken(p);
    // The API failed in the turn the task's end started: Claude Code wrote its own row, and the hook hands it on.
    p.rows(ROW.notification(), ROW.apiError('API Error: 500 Internal server error'));
    p.stop('API Error: 500 Internal server error');
    await taken(p);
    p.mark(woke("You've reached your usage limit. It resets at 9pm."));
    await taken(p);
    assert.deepEqual(c.sent, ['Started.']);
    assert.deepEqual(c.lines().map((l) => /not delivered: (.*?); \d+ chars/.exec(l)?.[1]), ['no text', '[SILENT]', 'an API error of the CLI, not an answer', 'a usage limit of the CLI']);
    // After the error row the session went on and answered: that is an answer again.
    p.rows(ROW.notification('toolu_3'), ROW.text('The second build passed.'));
    p.stop('The second build passed.');
    await until(() => c.sent.length === 2);
    assert.equal(c.sent[1], 'The second build passed.');
  });

  test('at most six an hour reach one chat; then one line of Angelia\'s says more are held back', { timeout: 18_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { first(n, p); if (n === 2) { p.rows(p.prompt(), ROW.text('Two reports.')); p.stop('Two reports.'); } });
    await c.say('start the build');
    const p = c.pane();
    for (let n = 1; n <= 9; n++) { p.mark(woke(`Report ${n}.`)); await taken(p); }
    assert.deepEqual(c.sent, ['Started.', 'Report 1.', 'Report 2.', 'Report 3.', 'Report 4.', 'Report 5.', 'Report 6.', selfCapLine(6)], 'a loop of notifications does not flood the chat');
    assert.equal(c.lines().filter((l) => l === `self-started answer not delivered key=${c.key} reason=hourly-limit chars=9`).length, 3);
    await c.say('what did I miss?');
    assert.equal(c.sent.at(-1), 'Two reports.');
    // A late answer is not one of them: the cap is for turns the agent started.
    assert.equal((c.o as any).selfSent.get(c.key).at.length, 6);
  });

  test('a session the pool let go of is not read: no reader stays, and what it said meanwhile is not sent later', { timeout: 18_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    // No background task here: one that runs keeps the session held.
    c.onEnter((n, p) => { p.rows(p.prompt(), ROW.text(n === 1 ? 'Started.' : 'Second.')); p.stop(n === 1 ? 'Started.' : 'Second.'); });
    assert.equal((await c.say('start the build'), c.brain().idle !== undefined), true, 'held by the pool: read between turns');
    const b1 = c.brain(), p1 = c.pane();
    // The idle time passes (defaults.idle_exit_minutes): the pool lets the pane go, and it lives on.
    await c.o.reapIdle(Date.now() + 31 * 60_000);
    assert.equal(b1.idle, undefined, 'no timer left');
    assert.equal(b1.alive, false);
    p1.mark(woke('The build passed.'));
    await wait(300);
    assert.equal(p1.marked(), true, 'nobody reads it');
    assert.deepEqual(c.sent, ['Started.']);
    // The next message reattaches the pane with a new reader: the old marker is from before it read.
    await c.say('second');
    assert.notEqual(c.brain(), b1);
    assert.deepEqual(c.sent, ['Started.', 'Second.']);
    assert.match(c.lines().at(-1)!, /is not delivered: it ended before this session was read; 17 chars/);
    // Stopped for good (/new, /stop): the reader goes too.
    const b2 = c.brain();
    assert.notEqual(b2.idle, undefined);
    await b2.stop();
    assert.equal(b2.idle, undefined);
  });

  test('a session woken again and again by the chat\'s own work stays read past the idle time; one that is not is let go as before', { timeout: 18_000 }, async (t) => {
    // The idle time is 1.2 s here (30 minutes by default); the daemon's reap timer is the calls below.
    const IDLE_MS = 1200;
    const c = await stubChat({}, { idle_exit_minutes: IDLE_MS / 60_000 }); t.after(() => c.o.shutdown());
    c.onEnter(first);
    await c.say('start the watch');
    const b = c.brain(), p = c.pane();
    // The tasks end (their queue rows): from here only the markers can hold the pane.
    for (const id of ['toolu_1', 'toolu_2', 'toolu_3']) p.rows({ type: 'queue-operation', operation: 'enqueue', content: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n</task-notification>` });
    await wait(100);
    const since = Date.now();
    // Only turns the agent started itself, each well inside the idle time: a result, nothing, a silent one.
    const said = ['The first check is fine.', '', '[SILENT]', 'The fourth check failed.'];
    for (let n = 0; Date.now() - since < IDLE_MS * 2.5; n++) {
      p.mark(woke(said[n % said.length]));
      await until(() => !p.marked());
      await wait(350);
      await c.o.reapIdle();
      assert.equal(b.alive, true, `still held ${Date.now() - since} ms after the chat's last turn`);
      assert.notEqual(b.idle, undefined, 'and read between turns');
    }
    assert.ok(Date.now() - since > IDLE_MS * 2, 'more than two idle times went by');
    assert.equal(c.brain(), b, 'the same brain all along');
    assert.ok(c.sent.includes('The first check is fine.') && c.sent.includes('The fourth check failed.'), 'and its results reached the chat');
    // A turn typed in the Claude app, and the end of the owner's own task, do not hold the pane.
    const used = b.lastUsedAt;
    p.mark({ text: 'For the app only.', origin: 'prompt', prompt_at: Date.now() });
    await until(() => !p.marked());
    p.mark({ text: 'Your own build.', origin: 'notification', origin_ids: ['toolu_owner'] });
    await until(() => !p.marked());
    assert.equal(b.lastUsedAt, used);
    // Nothing more arrives: after the idle time the pool lets the pane go, as it always did.
    await wait(IDLE_MS + 200);
    await c.o.reapIdle();
    assert.equal(b.alive, false);
    assert.equal(b.idle, undefined, 'no reader left');
    assert.ok(c.log.includes(`reap key=${c.key}`));
  });

  test('a turn handed to the background is read by its own reader: none is left between turns', { timeout: 18_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter(first);
    await c.say('start the build');
    const b = c.brain(), p = c.pane();
    assert.notEqual(b.idle, undefined);
    // A handoff: the pane is read in the background until its turn is over, with nobody to deliver to.
    b.turnSentAt = Date.now();
    const bg = b.backgroundTurn();
    assert.equal(b.idle, undefined);
    const over = bg.next();
    p.mark(woke('Background turn done.'));
    assert.deepEqual((await over).value, { kind: 'result', text: 'Background turn done.', isError: false }, 'the turn\'s own marker');
    await wait(200);
    assert.equal(b.idle, undefined, 'a background reader starts none');
    assert.deepEqual(c.sent, ['Started.']);
  });

  test('a late answer of a turn typed in the desk app goes back to the app, not to the chat', { timeout: 18_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    const out: string[] = [];
    c.o.onEvent((e) => { if (e.type === 'out') out.push(e.text); });
    c.onEnter((n, p) => { if (n === 1) p.rows(p.prompt(), ROW.call('t1')); });
    await c.o.injectTurn(c.key, 'from the desk', false, undefined, 'scheduled', 'app');
    c.pane().rows(ROW.result('t1'), ROW.text('The check passed.'));
    c.pane().stop('The check passed.');
    await until(() => out.includes('The check passed.'));
    assert.deepEqual(c.sent, [], 'the chat got nothing: the turn was the app\'s');
    assert.deepEqual(c.lines(), [`late answer delivered key=${c.key} chars=17`]);
  });
});
