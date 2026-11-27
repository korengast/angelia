import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boxText, boxTyped } from '../src/brain/tmux.js';
import { CLAUDE_ENV } from '../src/brain/argv.js';
import { ROW, stubChat, until } from './tui-stub.js';

process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-suggest-'));
process.env.ANGELIA_TMUX_SOCKET = `angelia-test-suggest-${process.pid}`;

// 0.4.11: Claude Code draws a reply it guesses in the empty box, dim ("Yes a" after an answer that
// ended "Reply with: yes a / no"). 0.4.10 read it as text that would not clear and sent nothing:
// "not delivered: the input box holds text that could not be cleared" (live, 2026-11-27).
const here = fileURLToPath(new URL('.', import.meta.url));
// The input box of that pane, captured with colours (claude 2.1.332, 220 columns), the rows under it cut.
const live = readFileSync(join(here, 'fixtures', 'pane-suggestion-332.ansi.txt'), 'utf8');
// oxlint-disable-next-line no-control-regex -- the colours are taken out on purpose
const plain = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, '');

test('a guessed reply, drawn dim, is no text in the box; typed text is', () => {
  assert.equal(boxText(plain(live)), 'Yes a', 'a plain capture reads it as text: the bug');
  assert.equal(boxTyped(live), '', 'with colours it is seen as drawn dim');
  assert.equal(boxTyped(live.replace('\x1b[2mYes a\x1b[0m', 'Yes a')), 'Yes a', 'the same words typed');
  assert.equal(boxTyped(live.replace('\x1b[2mYes a\x1b[0m', 'ok \x1b[2mYes a\x1b[0m')), 'ok', 'typed text before a dim part');
  assert.equal(boxTyped(live.replace('\x1b[2mYes a\x1b[0m', '\x1b[2mdim\x1b[22m typed')), 'typed', 'SGR 22 ends dim');
  assert.equal(boxTyped(live.replace('\x1b[2mYes a\x1b[0m', '\x1b[2mdim\x1b[m typed')), 'typed', 'an empty SGR ends dim');
  assert.equal(boxTyped(live.replace('\x1b[2mYes a\x1b[0m', '\x1b[1;2mdim\x1b[0;1m typed')), 'typed', 'dim among other attributes');
  // The values of an extended colour are not attributes (a 2 there is no dim, a 0 no reset).
  assert.equal(boxTyped(live.replace('\x1b[2mYes a\x1b[0m', '\x1b[38;5;2mgreen\x1b[39m')), 'green', '38;5;2 is green');
  assert.equal(boxTyped(live.replace('\x1b[2mYes a\x1b[0m', '\x1b[48;2;2;2;2mrgb\x1b[49m')), 'rgb', '48;2;r;g;b');
  assert.equal(boxTyped(live.replace('\x1b[2mYes a\x1b[0m', '\x1b[38:5:2mcolon\x1b[39m')), 'colon', 'the colon form');
  assert.equal(boxTyped(live.replace('\x1b[2mYes a\x1b[0m', '\x1b[2;38;5;0mstill dim\x1b[0m')), '', 'a 0 inside a colour ends nothing');
  assert.equal(boxTyped(live.replace('\x1b[2mYes a\x1b[0m', '\x1b]8;;https://x.example\x07link\x1b]8;;\x07')), 'link', 'an OSC 8 link is drawn text');
  assert.equal(boxTyped('no box here'), null);
});

test('a message sent while a guessed reply is drawn in the box is pasted and answered', { timeout: 30_000 }, async (t) => {
  const c = await stubChat(); t.after(() => c.o.shutdown());
  c.onEnter((n, p) => {
    p.rows(p.prompt(), ROW.text(`Answer ${n}.`));
    // The first answer ends with a question: Claude Code guesses the reply and draws it in the box.
    if (n === 1) p.show('suggestion');
    p.stop(`Answer ${n}.`);
    p.rows(ROW.over());
  });
  await c.say('one');
  await until(() => c.sent.includes('Answer 1.'));
  await c.say('Yes a');
  await until(() => c.sent.includes('Answer 2.'), 10_000).catch(() => {});
  const p = c.pane();
  assert.equal(p.enters, 2, p.logs.join('\n'));
  assert.ok(c.sent.includes('Answer 2.'), JSON.stringify(c.sent));
  assert.ok(!p.logs.some((l) => /input box held text/.test(l)), p.logs.join('\n'));
});

test('every session Angelia starts has prompt suggestions off', () => {
  assert.equal(CLAUDE_ENV.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, '0');
});
