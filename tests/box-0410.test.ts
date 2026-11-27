import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boxHoldsOnly, boxText, paneHasBox, paneIdle, pasteLanded } from '../src/brain/tmux.js';

// 0.4.10: the input box items of review-keymiss (0.4.8) and the Up-arrow History box. The screens are
// live captures, claude 2.1.332 in a 220-column tmux pane (2026-11-27).
const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = (name: string): string => readFileSync(join(here, 'fixtures', `pane-${name}.txt`), 'utf8');
const idle = fixture('idle');
const box = (inner: string) => idle.replace(/❯\s+Try "refactor <filepath>"/, `❯ ${inner}`);
const lines = (n: number) => Array.from({ length: n }, (_, i) => `a${i + 1}`).join('\n');

test('the Up-arrow History box (its top rule says "─── History 2/2 ───") is an input box: idle, and its text is read', () => {
  const pane = fixture('history-332');
  assert.equal(paneHasBox(pane), true);
  assert.equal(paneIdle(pane), true, 'a prompt called back from the history is text in an idle box');
  assert.equal(boxText(pane), 'reply with the word beta only', 'so the clear before a paste sees it');
});

test('a lone chip is the paste only when it has the paste\'s shape', () => {
  const chip = fixture('chip-332'); // six lines pasted: "[Pasted text #15 +5 lines]"
  assert.equal(boxHoldsOnly(chip, lines(6)), true);
  assert.equal(pasteLanded(chip, lines(6)), true);
  assert.equal(boxHoldsOnly(chip, 'hi'), false, 'a short message is never a chip: this one is another paste');
  assert.equal(pasteLanded(chip, 'hi'), false);
  assert.equal(boxHoldsOnly(chip, lines(8)), false, 'seven line breaks, not five');
  assert.equal(pasteLanded(chip, lines(8)), false);
  // One line of more than 800 characters: a chip with no count; up to 800 it is drawn as text.
  const long = 'q'.repeat(801);
  assert.equal(boxHoldsOnly(box('[Pasted text #12]'), long), true);
  assert.equal(boxHoldsOnly(box('[Pasted text #12]'), 'q'.repeat(800)), false);
  assert.equal(boxHoldsOnly(box('[Pasted text #12]'), `${'q'.repeat(400)}\n${'r'.repeat(400)}`), false, 'one break: a count is drawn');
  assert.equal(boxHoldsOnly(box('[Pasted text #14 +1 lines]'), `${'q'.repeat(400)}\n${'r'.repeat(401)}`), true);
});

test('a symbol or an emoji left in the box is text that would go with the paste', () => {
  assert.equal(boxHoldsOnly(box('hello ★'), 'hello'), false);
  assert.equal(boxHoldsOnly(box('hello 🎉'), 'hello'), false);
  assert.equal(boxHoldsOnly(box('→ hello'), 'hello'), false);
  assert.equal(boxHoldsOnly(box('hello?'), 'hello'), false);
  // What a terminal may give back another way still matches: joiners, skin tones, variation selectors, marks.
  assert.equal(boxHoldsOnly(box('Family 👨👩👧 heart ❤ thumbs 👍 café ★ ok'), 'Family 👨‍👩‍👧 heart ❤️ thumbs 👍🏽 café ★ ok'), true);
  assert.equal(boxHoldsOnly(box('Family 👨‍👩‍👧 flag 🇮🇱 → done ✓ ™ ok'), 'Family 👨‍👩‍👧 flag 🇮🇱 → done ✓ ™ ok'), true, 'as the 2.1.332 box drew them');
});
