import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NO_ANSWER_LINE } from '../src/core/deliver/text.js';
import { promptKey } from '../src/brain/tui.js';
import { ROW, stubChat, until, wait } from './tui-stub.js';

// Own state dir and socket before the brain modules load: nothing here can touch a live Angelia. The
// panes are stubs (tui-stub.ts); the Stop hook that writes the markers is the real script.
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-late-'));
process.env.ANGELIA_TMUX_SOCKET = `angelia-test-late-${process.pid}`;

// tmux mode: a turn that Angelia closed with no Stop marker (the quiet pane) may still end later. Its
// marker then comes with nobody waiting for it. Each chat here waits on the quiet path on purpose, so
// they run side by side.
describe('tmux mode: the Stop marker of a turn that was closed without it', { concurrency: true }, () => {
  test('a turn closed with no answer, then its marker: the answer reaches the chat once, when it comes', { timeout: 18_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => {
      // The turn runs a tool, and the screen reads idle the whole time (a screen misread): closed after the bound.
      if (n === 1) p.rows(p.prompt(), ROW.call('t1'));
      if (n === 2) { p.rows(p.prompt(), ROW.text('Nothing more.')); p.stop('Nothing more.'); }
    });
    await c.say('run the long check');
    assert.deepEqual(c.sent, [NO_ANSWER_LINE], 'the chat was told the turn gave no answer');
    // The tool comes back, the agent answers, and the Stop hook runs: nobody is reading a turn now.
    c.pane().rows(ROW.result('t1'), ROW.text('The check passed.'));
    c.pane().stop('The check passed.');
    await until(() => c.sent.length === 2);
    assert.equal(c.sent[1], 'The check passed.', 'as the agent\'s words, with nothing around them');
    assert.deepEqual(c.lines(), [`late answer delivered key=${c.key} chars=17`], 'one log line, with the length and never the words');
    assert.equal(c.pane().marked(), false, 'the marker was taken');
    await wait(250);
    assert.equal(c.sent.length, 2, 'once');
    // The next turn is its own: nothing of the late answer comes again.
    await c.say('and now?');
    assert.deepEqual(c.sent.slice(2), ['Nothing more.']);
  });

  test('the same words the chat already has as the turn\'s answer are not sent again', { timeout: 18_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    // The Stop hook is slow: the turn is closed on its last text, which is the answer.
    c.onEnter((n, p) => { if (n === 1) p.rows(p.prompt(), ROW.text('Done.\r\n')); });
    await c.say('is it done?');
    assert.deepEqual(c.sent, ['Done.']);
    c.pane().stop('Done.');
    await until(() => !c.pane().marked());
    await wait(250);
    assert.deepEqual(c.sent, ['Done.']);
    assert.equal(c.lines().length, 1);
    assert.match(c.lines()[0], /^tmux: a turn ended between turns and its answer is not delivered: late, and the chat has it as the turn's answer; 5 chars pane=\S+ key=telegram:1$/);
  });

  test('the lines before the answer went out as progress lines: a marker that holds them too is not sent again', { timeout: 18_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) p.rows(p.prompt(), ROW.text('The first is fine.'), ROW.text('The second is fine too.')); });
    await c.say('check both');
    assert.deepEqual(c.sent, ['The first is fine.', 'The second is fine too.'], 'a progress line, then the last text as the answer');
    // The hook's text with other line ends and white space at the ends of lines: the same answer.
    c.pane().mark({ text: 'The first is fine.  \r\n\r\n\r\nThe second is fine too.\n', origin: 'prompt', prompt_at: c.pane().enteredAt[0] + 1, prompt_key: promptKey(c.pane().typed), prompts: 1 });
    await until(() => !c.pane().marked());
    await wait(250);
    assert.equal(c.sent.length, 2);
    assert.match(c.lines()[0], /late, and the chat has it as the turn's answer/);
  });

  test('a marker still there when the next message is typed is delivered before that turn\'s answer, never deleted', { timeout: 18_000 }, async (t) => {
    // The reader between turns is far away here: only the next turn's typing finds the marker.
    const c = await stubChat({ idlePollMs: 600_000 }); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 2) { p.rows(p.prompt(), ROW.text('The second answer.')); p.stop('The second answer.'); } });
    await c.say('first');
    assert.deepEqual(c.sent, [NO_ANSWER_LINE]);
    c.pane().rows(c.pane().prompt(c.pane().enteredAt[0] + 1), ROW.text('The first answer.'));
    c.pane().stop('The first answer.');
    await wait(200);
    assert.equal(c.pane().marked(), true, 'nobody took it yet');
    await c.say('second');
    assert.deepEqual(c.sent, [NO_ANSWER_LINE, 'The first answer.', 'The second answer.'], 'in order');
    assert.deepEqual(c.lines(), [`late answer delivered key=${c.key} chars=17`]);
  });

  test('a turn typed in the Claude app after the close is not taken for the late answer', { timeout: 18_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    await c.say('first');
    assert.deepEqual(c.sent, [NO_ANSWER_LINE]);
    await wait(30);
    // The owner types in the app: a marker comes after the closed turn, of another turn.
    c.pane().rows(ROW.prompt('typed in the app'), ROW.text('For the app only.'));
    c.pane().stop('For the app only.');
    await until(() => !c.pane().marked());
    await wait(250);
    assert.deepEqual(c.sent, [NO_ANSWER_LINE]);
    assert.match(c.lines()[0], /is not delivered: a person typed it in the Claude app or the pane \(a typed prompt \(origin human\)\); 17 chars/);
    // And with that the closed turn is over: a marker that names its time no longer passes for it.
    c.pane().mark({ text: 'Too late now.', origin: 'prompt', prompt_at: c.pane().enteredAt[0] + 1 });
    await until(() => !c.pane().marked());
    await wait(250);
    assert.deepEqual(c.sent, [NO_ANSWER_LINE]);
  });

  test('a marker of a turn the agent started by itself, come once a turn is typed, is told as such: the turn waits for its own', { timeout: 18_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => {
      if (n === 1) { p.rows(p.prompt(), ...ROW.background('toolu_1'), ROW.text('Started.')); p.stop('Started.'); }
      if (n === 2) {
        // Written right at Enter: Claude Code had queued the task's end first, and answered it before the message.
        p.rows(ROW.notification('toolu_1'), ROW.text('The build passed.'));
        p.stop('The build passed.');
        // Once the reader took that marker (the next Stop would overwrite it), the turn's own answer.
        void until(() => !p.marked(), 15_000).then(() => { p.rows(p.prompt(), ROW.text('Second.')); p.stop('Second.'); });
      }
    });
    await c.say('first');
    await c.say('second');
    assert.deepEqual(c.sent, ['Started.', 'The build passed.', 'Second.'], 'the task\'s answer as its own message, then the turn\'s');
    assert.deepEqual(c.lines(), [`self-started answer delivered key=${c.key} chars=17`]);
  });

  test('a marker that comes as a turn is typed, of work no turn of this chat started, is neither the turn\'s answer nor sent', { timeout: 18_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => {
      if (n === 1) { p.rows(p.prompt(), ROW.text('First.')); p.stop('First.'); }
      if (n === 2) {
        p.mark({ text: 'Racing answer.', origin: 'notification', origin_ids: ['toolu_9'] });
        // Once the reader took that marker (the next Stop would overwrite it), the turn's own answer.
        void until(() => !p.marked(), 15_000).then(() => { p.rows(p.prompt(), ROW.text('Second.')); p.stop('Second.'); });
      }
    });
    await c.say('first');
    await c.say('second');
    assert.deepEqual(c.sent, ['First.', 'Second.']);
    assert.match(c.lines()[0], /not delivered: the work it reports was not started by a turn of this chat; 14 chars/);
  });

  test('a turn the owner typed in the app just before Angelia\'s Enter: its answer is not this turn\'s, and the turn waits for its own', { timeout: 18_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => {
      if (n === 1) { p.rows(p.prompt(), ROW.text('First.')); p.stop('First.'); }
      if (n === 2) {
        p.rows(ROW.prompt('typed in the app'), ROW.text('For the app only.'));
        p.stop('For the app only.');
        void until(() => !p.marked(), 15_000).then(() => { p.rows(p.prompt(), ROW.text('Second.')); p.stop('Second.'); });
      }
    });
    await c.say('first');
    await c.say('second');
    assert.deepEqual(c.sent, ['First.', 'Second.']);
    assert.ok(c.pane().logs.some((l) => /^tmux: marker dropped, prompt key miss: prompts=1 chars=17 pane=\S+$/.test(l)));
  });

  test('a turn a task\'s end started, that ended in the CLI\'s error row while a turn waited: the row is not sent as an answer', { timeout: 18_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => {
      if (n === 1) { p.rows(p.prompt(), ...ROW.background('toolu_1'), ROW.text('Started.')); p.stop('Started.'); }
      if (n === 2) {
        p.rows(ROW.notification('toolu_1'), ROW.apiError('API Error: 500 Internal server error'));
        p.stop('API Error: 500 Internal server error');
        void until(() => !p.marked(), 15_000).then(() => { p.rows(p.prompt(), ROW.text('Second.')); p.stop('Second.'); });
      }
    });
    await c.say('first');
    await c.say('second');
    assert.deepEqual(c.sent, ['Started.', 'Second.']);
    assert.match(c.lines()[0], /not delivered: an API error of the CLI, not an answer; 36 chars/);
  });

  test('a late marker whose prompt is not the one Angelia typed is not sent: typed in the app, or typed into the turn', { timeout: 18_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n <= 2) p.rows(p.prompt(), ROW.call(`t${n}`)); });
    await c.say('run the long check');
    assert.deepEqual(c.sent, [NO_ANSWER_LINE]);
    const p = c.pane();
    // Someone typed into the cut turn while it ran (2.1.330 writes that as a queued_command attachment).
    p.rows(ROW.queuedPrompt('and delete the logs'), ROW.result('t1'), ROW.text('Checked, and the logs are gone.'));
    p.stop('Checked, and the logs are gone.');
    await until(() => !p.marked());
    await wait(250);
    assert.deepEqual(c.sent, [NO_ANSWER_LINE]);
    assert.match(c.lines()[0], /is not delivered: a person typed it in the Claude app or the pane \(a typed prompt \(origin human\), a prompt typed while the turn ran \(origin human\)\); 31 chars/);
    // A turn in the window whose one prompt is someone else's words.
    await c.say('run it again');
    assert.equal(c.sent.length, 2);
    p.rows(p.prompt(Date.now() - 10), ROW.result('t2'));
    const at = c.pane().enteredAt[1] + 1;
    p.mark({ text: 'Not yours.', origin: 'prompt', prompt_at: at, prompt_key: promptKey('another text'), prompts: 1 });
    await until(() => !p.marked());
    await wait(250);
    assert.equal(c.sent.length, 2);
    assert.match(c.lines()[1], /late, but the prompt the hook read is not the one Angelia typed; 10 chars/);
  });

  test('an answer that ends while the next message waits to be typed goes out first, then the turn\'s', { timeout: 18_000 }, async (t) => {
    const c = await stubChat({ idlePollMs: 600_000 }); t.after(() => c.o.shutdown());
    c.onPaste((n, p) => {
      // A task's end is answered just before the Enter of message 2.
      if (n === 2) { p.rows(ROW.notification(), ROW.text('The build passed.')); p.stop('The build passed.'); }
    });
    c.onEnter((n, p) => {
      if (n === 1) { p.rows(p.prompt(), ...ROW.background('toolu_1'), ROW.text('First.')); p.stop('First.'); }
      if (n === 2) { p.rows(p.prompt(), ROW.text('Second.')); p.stop('Second.'); }
    });
    await c.say('first');
    await c.say('second');
    assert.deepEqual(c.sent, ['First.', 'The build passed.', 'Second.']);
    assert.deepEqual(c.lines(), [`self-started answer delivered key=${c.key} chars=17`]);
  });
});
