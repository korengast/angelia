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
  // Alone in the box, a chip is taken on its count only (the pane's height: see below).
  assert.equal(boxHoldsOnly(box('[Pasted text #12]'), 'q'.repeat(800)), true);
  assert.equal(boxHoldsOnly(box('hi [Pasted text #12]'), 'q'.repeat(800)), false, 'not alone: text that would go with it');
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

// Review fix (Fable, 0.4.10): Claude Code turns each tab into 4 spaces before it measures the 800
// characters (measured on 2.1.332, 2026-11-27: 740 characters with 20 tabs drawn as text, 741 as a chip).
test('a one-line paste with tabs is a chip by its length with each tab as 4 spaces', () => {
  const tabs780 = `${'x'.repeat(38)}\t`.repeat(20); // 780 characters, 840 as Claude Code counts them
  assert.equal(tabs780.length, 780);
  const chip = box('[Pasted text #1]');
  assert.equal(pasteLanded(chip, tabs780), true, 'the chip of this paste: Enter may follow');
  assert.equal(boxHoldsOnly(chip, tabs780), true);
  // Among other text the length decides: 740 with 20 tabs is 800, drawn as text, so a chip is another paste's.
  const tabs740 = `${'x'.repeat(36)}\t`.repeat(20);
  assert.equal(pasteLanded(box('[Pasted text #1] [Pasted text #2]'), tabs740), false);
  assert.equal(pasteLanded(box('[Pasted text #1] [Pasted text #2]'), `${tabs740}y`), true);
});

// Review fix (Fable, 0.4.10): a pane under 12 rows collapses fewer line breaks (measured on 2.1.332,
// 2026-11-27, a 220-column pane: at 11 rows 2 breaks are a chip, at 10 rows 1 break is; from 12 rows 3).
test('on a short pane a chip of fewer than 3 line breaks, alone in the box, is the paste when its count fits', () => {
  const two = 'alpha line\nbeta line';
  const chip = box('[Pasted text #3 +1 lines]');
  assert.equal(pasteLanded(chip, two), true);
  assert.equal(boxHoldsOnly(chip, two), true);
  assert.equal(boxHoldsOnly(box('[Pasted text #4 +2 lines]'), 'alpha\nbeta\ngamma'), true);
  assert.equal(pasteLanded(box('[Pasted text #4 +2 lines]'), 'alpha\nbeta\ngamma'), true);
  // The count still decides: another paste's chip is refused.
  assert.equal(boxHoldsOnly(box('[Pasted text #3 +2 lines]'), two), false);
  assert.equal(pasteLanded(box('[Pasted text #3 +2 lines]'), two), false);
  assert.equal(boxHoldsOnly(box('[Pasted text #3 +1 lines]'), 'one line'), false);
  // Not alone: another chip or text with it would go with the paste.
  assert.equal(boxHoldsOnly(box('[Pasted text #2 +1 lines] [Pasted text #3 +1 lines]'), two), false);
  assert.equal(boxHoldsOnly(box('ok [Pasted text #3 +1 lines]'), two), false);
});
