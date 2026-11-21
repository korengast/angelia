import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { textArg } from '../src/daemon/api/client.js';

test('send text: a WhatsApp tag at the start is text; @file only as the whole text and an existing file', () => {
  assert.equal(textArg(['@15550000000', 'hello']), '@15550000000 hello');
  assert.equal(textArg(['@15550000000 hello']), '@15550000000 hello');
  assert.equal(textArg(['@nosuchfile-' + 'x'.repeat(300)]), '@nosuchfile-' + 'x'.repeat(300), 'a long word that is no file is text, not ENAMETOOLONG');
  const dir = mkdtempSync(join(tmpdir(), 'angelia-sendtext-'));
  const f = join(dir, 'msg.txt');
  writeFileSync(f, 'from the file');
  assert.equal(textArg([`@${f}`]), 'from the file');
  assert.equal(textArg([`@${dir}`]), `@${dir}`, 'a folder is not a file: text');
  assert.equal(textArg(['plain', 'words']), 'plain words');
});
