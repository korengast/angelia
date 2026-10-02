import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BANNER_ART, banner } from '../src/cli/banner.js';

test('banner: fits a default terminal', () => {
  const lines = banner('0.3.5', { isTTY: true, env: { NO_COLOR: '1' } }).trimEnd().split('\n');
  assert.ok(lines.length <= 8);
  for (const l of lines) assert.ok(Array.from(l).length <= 64, l);
  assert.equal(lines.at(-1), 'Angelia 0.3.5 · your coding agent, your personal assistant');
  assert.deepEqual(lines.slice(0, BANNER_ART.length), BANNER_ART);
});

test('banner: nothing when the output is not a terminal; colour only when allowed', () => {
  assert.equal(banner('0.3.5', { isTTY: false, env: {} }), '');
  assert.equal(banner('0.3.5', { isTTY: undefined, env: {} }), '');
  assert.equal(banner('0.3.5', { isTTY: true, env: { NO_COLOR: '1' } }).includes('\x1b'), false);
  assert.ok(banner('0.3.5', { isTTY: true, env: { COLORTERM: 'truecolor' } }).includes('\x1b[38;2;208;107;107m'));
  assert.ok(banner('0.3.5', { isTTY: true, env: {} }).includes('\x1b[38;5;174m'));
  // NO_COLOR set but empty does not count (no-color.org).
  assert.ok(banner('0.3.5', { isTTY: true, env: { NO_COLOR: '' } }).includes('\x1b['));
});
