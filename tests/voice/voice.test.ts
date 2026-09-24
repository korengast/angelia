import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODEL, parseArgs as parseWhisper, whisperArgs } from '../../src/voice/transcribe.js';
import { HEBREW_VOICE, isHebrew, pickVoice, parseArgs as parseSay, sayArgs } from '../../src/voice/speak.js';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('transcribe: the default model is the accurate one, and language is only passed when asked for', () => {
  assert.equal(DEFAULT_MODEL, 'large-v3-turbo');
  assert.deepEqual(parseWhisper(['/tmp/a.ogg']), { file: '/tmp/a.ogg', model: 'large-v3-turbo', language: '' });
  assert.deepEqual(parseWhisper(['/tmp/a.ogg', '--language', 'he', '--model', 'small']), { file: '/tmp/a.ogg', model: 'small', language: 'he' });
  assert.deepEqual(whisperArgs(parseWhisper(['/tmp/a.ogg']), '/out'),
    ['/tmp/a.ogg', '--model', 'large-v3-turbo', '--output_format', 'txt', '--output_dir', '/out']);
  assert.deepEqual(whisperArgs(parseWhisper(['/tmp/a.ogg', '--lang', 'he']), '/out').slice(-2), ['--language', 'he']);
});

test('speak: Hebrew text picks the Hebrew voice, and degrades instead of reading letter salad', () => {
  assert.ok(isHebrew('שלום'));
  assert.ok(isHebrew('mixed שלום text'));
  assert.equal(isHebrew('plain english'), false);

  // English: the system default voice, so no -v at all.
  assert.equal(pickVoice('hello', '', [HEBREW_VOICE]), '');
  // Hebrew: the Hebrew voice, when this machine has it.
  assert.equal(pickVoice('שלום', '', [HEBREW_VOICE, 'Samantha']), HEBREW_VOICE);
  // Hebrew on a machine without it: fall back rather than name a voice that does not exist.
  assert.equal(pickVoice('שלום', '', ['Samantha']), '');
  // An explicit choice always wins.
  assert.equal(pickVoice('hello', 'Daniel', ['Samantha']), 'Daniel');
});

test('speak: arguments keep the text last, where say expects it', () => {
  assert.deepEqual(parseSay(['hi there', '--voice', 'Carmit', '--rate', '180']), { text: 'hi there', voice: 'Carmit', out: '', rate: '180' });
  const args = sayArgs({ text: 'hi', voice: 'Carmit', rate: '' }, '/tmp/a.wav');
  assert.deepEqual(args, ['-v', 'Carmit', '-o', '/tmp/a.wav', '--data-format=LEI16@22050', 'hi']);
  assert.deepEqual(sayArgs({ text: 'hi', voice: '', rate: '' }, '/tmp/a.wav').slice(0, 2), ['-o', '/tmp/a.wav']);
});

test('both commands reach their own code from the CLI: no arguments prints the usage and exits 2', () => {
  // They used to be loose scripts with a main-guard that a symlinked install silently skipped. Now
  // they run in-process from the CLI, so this proves the wiring rather than a guard.
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'cli.ts');
  for (const cmd of ['transcribe', 'speak']) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', cli, cmd], { encoding: 'utf8' });
    assert.equal(r.status, 2, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`usage: angelia ${cmd}`));
  }
});
