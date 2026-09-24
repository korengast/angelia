import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommand, statusText, resumeListText, COMMANDS, HELP } from '../src/core/commands.js';
import { SessionMap } from '../src/core/session/map.js';

test('parseCommand', () => {
  assert.deepEqual(parseCommand('/new'), { name: 'new' });
  assert.deepEqual(parseCommand('/resume 2'), { name: 'resume', selector: '2' });
  assert.deepEqual(parseCommand('/status@mybot'), { name: 'status' });
  assert.equal(parseCommand('/compact'), null);
  assert.equal(parseCommand('hello /new'), null);
});

test('status and resume text', () => {
  const m = new SessionMap(join(mkdtempSync(join(tmpdir(), 'angelia-cmd-')), 's.json'));
  assert.match(statusText(m, 'k', 'coding', false, 0), /no active session/);
  const a = m.ensureActive('k', 'first question');
  m.recordTurn('k', a.id, 'first question');
  assert.match(statusText(m, 'k', 'coding', true, 1), /session [0-9a-f]{8} · 1 turns/);
  assert.match(resumeListText(m, 'k'), /^1\. [0-9a-f]{8} \* · 1 turns · first question$/);
});

test('parseCommand /sh', () => {
  assert.deepEqual(parseCommand('/sh ls -la'), { name: 'sh', script: 'ls -la' });
  assert.deepEqual(parseCommand('/sh@mybot git status'), { name: 'sh', script: 'git status' });
  assert.deepEqual(parseCommand('/sh\ncd x\nnpm test'), { name: 'sh', script: 'cd x\nnpm test' });
  assert.equal(parseCommand('/sh'), null);
  assert.equal(parseCommand('/shell ls'), null);
});

test('command menu matches the parser and Telegram limits', () => {
  for (const c of COMMANDS) {
    assert.match(c.command, /^[a-z0-9_]{1,32}$/);
    assert.ok(c.description.length >= 3 && c.description.length <= 256);
    assert.ok(parseCommand(`/${c.command}${c.command === 'sh' ? ' true' : ''}`), `/${c.command} must parse`);
  }
  assert.match(HELP, /^\/new — /);
  assert.match(HELP, /\/sh <command> — /);
});
