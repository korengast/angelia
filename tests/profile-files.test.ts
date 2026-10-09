// Ported from Angelia Desk (tests/files.test.ts, tests/instructions.test.ts) when the rules moved into
// the daemon (mobile plan M1.1, D18), plus the daemon's own: credential places and deny rules.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FILE_MAX_BYTES, FILE_MAX_BYTES as INSTRUCTIONS_MAX_BYTES, instructionNames, listProfileFolder, openChecked, readInstructions as readInstr, readProfileFile, secretName, segments, type Hidden } from '../src/instance/profile-files.js';

const none: Hidden = () => false;
const listFolder = (d: string, rel: string) => listProfileFolder(d, rel, none);
const readFileView = (d: string, rel: string, uid?: number) => readProfileFile(d, rel, none, uid);
const readInstructions = (d: string, backend: string, uid?: number) => readInstr(d, backend, none, uid);
function tmp(t: { after(fn: () => unknown): void }, prefix = 'pf-t-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function folder(t: Parameters<typeof tmp>[0]): string {
  const d = tmp(t);
  writeFileSync(join(d, 'CLAUDE.md'), '# hi');
  writeFileSync(join(d, '.env'), 'TOKEN=1');
  writeFileSync(join(d, '.env.local'), 'TOKEN=2');
  writeFileSync(join(d, 'api.token'), 'x');
  writeFileSync(join(d, 'id_ed25519'), 'key');
  writeFileSync(join(d, 'server.pem'), 'pem');
  mkdirSync(join(d, 'secrets'));
  writeFileSync(join(d, 'secrets', 'a.txt'), 'shh');
  mkdirSync(join(d, '.git'));
  mkdirSync(join(d, 'memory'));
  writeFileSync(join(d, 'memory', 'index.md'), 'notes');
  return d;
}

test('files: secret names, at any depth', () => {
  for (const n of [
    '.env',
    '.env.prod',
    'API.TOKEN',
    'id_rsa',
    'tls.KEY',
    'secrets',
    'my-credentials.json',
    'auth.json',
    '.npmrc',
  ])
    assert.equal(secretName(n), true, n);
  for (const n of ['CLAUDE.md', 'environment.md', 'tokenizer-notes.md'.replace('token', 'tok'), 'keys.md', 'index.md'])
    assert.equal(secretName(n), false, n);
});

test('files: a listing leaves out secrets, .git and node_modules; folders first', (t) => {
  const d = folder(t);
  assert.deepEqual(listFolder(d, ''), [
    { name: 'memory', kind: 'dir' },
    { name: 'CLAUDE.md', kind: 'file' },
  ]);
  assert.deepEqual(listFolder(d, 'memory'), [{ name: 'index.md', kind: 'file' }]);
});

test('files: paths that leave the folder or name a secret are refused', (t) => {
  const d = folder(t);
  for (const bad of [
    '../x',
    'memory/../../x',
    '/etc/passwd',
    '.env',
    'secrets/a.txt',
    '.git/config',
    'a\0b',
    'memory\\x',
  ])
    assert.throws(() => segments(bad), /not/, bad);
  const outside = tmp(t);
  writeFileSync(join(outside, 'x.md'), 'out');
  symlinkSync(join(outside, 'x.md'), join(d, 'link.md'));
  assert.throws(() => readFileView(d, 'link.md'), /outside/);
  symlinkSync(join(d, '.env'), join(d, 'plain.md'));
  assert.throws(() => readFileView(d, 'plain.md'), /not shown/, 'a plain name linking to a secret');
  // Changed in the daemon: an entry that could not be opened is not listed at all.
  assert.equal(
    listFolder(d, '').some((e) => e.name === 'link.md' || e.name === 'plain.md'),
    false,
    'a link out, or to a secret, is not listed',
  );
});

test('files: text, cut text, and binary', (t) => {
  const d = folder(t);
  assert.deepEqual(readFileView(d, 'memory/index.md'), { binary: false, size: 5, text: 'notes', cut: false });
  writeFileSync(join(d, 'big.log'), 'a'.repeat(FILE_MAX_BYTES + 10));
  const big = readFileView(d, 'big.log');
  assert.ok(!big.binary && big.cut && big.text.length === FILE_MAX_BYTES);
  writeFileSync(join(d, 'img.png'), Buffer.from([0x89, 0x50, 0, 1, 2]));
  assert.deepEqual(readFileView(d, 'img.png'), { binary: true, size: 5 });
  assert.throws(() => readFileView(d, 'memory'), /not a file/);
  assert.throws(() => readFileView(d, 'memory/index.md', 999_999), /another user/);
});

test('instructions: the file each CLI reads first', () => {
  assert.deepEqual(instructionNames('claude-code'), ['CLAUDE.md']);
  assert.deepEqual(instructionNames('codex'), ['AGENTS.md', 'CLAUDE.md']);
  assert.deepEqual(instructionNames('pi'), ['AGENTS.md', 'CLAUDE.md']);
});

test('instructions: read from the folder; AGENTS.md first for codex; missing ones say so', (t) => {
  const d = tmp(t);
  writeFileSync(join(d, 'CLAUDE.md'), '# Garden\nWater on Tuesdays.');
  assert.deepEqual(readInstructions(d, 'claude-code'), {
    found: true,
    file: 'CLAUDE.md',
    text: '# Garden\nWater on Tuesdays.',
    cut: false,
  });
  writeFileSync(join(d, 'AGENTS.md'), 'agents');
  assert.equal((readInstructions(d, 'codex') as { file: string }).file, 'AGENTS.md');
  assert.equal(
    (readInstructions(d, 'claude-code') as { file: string }).file,
    'CLAUDE.md',
    'Claude Code never reads AGENTS.md',
  );
  const empty = tmp(t);
  assert.deepEqual(readInstructions(empty, 'claude-code'), {
    found: false,
    file: 'CLAUDE.md',
    why: 'this profile has no instruction file',
  });
  assert.match((readInstructions(join(empty, 'gone'), 'claude-code') as { why: string }).why, /folder is missing/);
});

test('instructions: a link out of the folder is refused, one inside is followed', (t) => {
  const d = tmp(t);
  const outside = tmp(t);
  writeFileSync(join(outside, 'secret.md'), 'not yours');
  symlinkSync(join(outside, 'secret.md'), join(d, 'CLAUDE.md'));
  assert.deepEqual(readInstructions(d, 'claude-code'), {
    found: false,
    file: 'CLAUDE.md',
    why: 'CLAUDE.md points outside the profile folder',
  });
  const e = tmp(t);
  mkdirSync(join(e, 'docs'));
  writeFileSync(join(e, 'docs', 'main.md'), 'inside');
  symlinkSync(join(e, 'docs', 'main.md'), join(e, 'CLAUDE.md'));
  assert.equal((readInstructions(e, 'claude-code') as { text: string }).text, 'inside');
  const f = tmp(t);
  mkdirSync(join(f, 'CLAUDE.md'));
  assert.match((readInstructions(f, 'claude-code') as { why: string }).why, /not a file/);
});

test('instructions: a huge file is cut and says so; another owner is refused', (t) => {
  const d = tmp(t);
  writeFileSync(join(d, 'CLAUDE.md'), 'é'.repeat(INSTRUCTIONS_MAX_BYTES));
  const r = readInstructions(d, 'claude-code');
  assert.ok(r.found && r.cut && Buffer.byteLength(r.text) <= INSTRUCTIONS_MAX_BYTES + 3);
  assert.match((readInstructions(d, 'claude-code', 999_999) as { why: string }).why, /another user/);
});

// Review of 2026-10-09 (mobile M1): each of these got a file out, or held the daemon, before the fix.

test('files: a named pipe is refused at once, never waited on', (t) => {
  const d = tmp(t);
  execFileSync('mkfifo', [join(d, 'CLAUDE.md')]);
  const start = Date.now();
  assert.throws(() => readFileView(d, 'CLAUDE.md'), /not a file/);
  assert.equal(readInstructions(d, 'claude-code').found, false);
  assert.ok(Date.now() - start < 1000);
});

test('files: a second name for a file (a hard link) is refused, so a credential cannot hide under a plain name', (t) => {
  const d = tmp(t);
  const elsewhere = tmp(t);
  writeFileSync(join(elsewhere, 'creds.json'), '{"key":"never"}');
  linkSync(join(elsewhere, 'creds.json'), join(d, 'notes.md'));
  assert.throws(() => readFileView(d, 'notes.md'), /more than one name/);
});

test('files: a folder swapped for a link after the checks is not followed by the open', (t) => {
  const d = tmp(t);
  const outside = tmp(t);
  mkdirSync(join(d, 'docs'));
  writeFileSync(join(d, 'docs', 'a.md'), 'inside');
  writeFileSync(join(outside, 'a.md'), 'outside');
  const checked = join(realpathSync.native(d), 'docs', 'a.md');
  // The swap the checks cannot see: the same path now goes through a link.
  renameSync(join(d, 'docs'), join(d, 'docs-old'));
  symlinkSync(outside, join(d, 'docs'));
  assert.throws(() => openChecked(checked), /could not be opened|changed|no such file/);
});


test('files: a folder of 20,000 names lists its first 1000 quickly', (t) => {
  const d = tmp(t);
  mkdirSync(join(d, 'many'));
  for (let i = 0; i < 20_000; i++) writeFileSync(join(d, 'many', `f${String(i).padStart(5, '0')}.md`), '');
  const start = Date.now();
  const list = listFolder(d, 'many');
  assert.equal(list.length, 1000);
  assert.equal(list[0].name, 'f00000.md');
  assert.ok(Date.now() - start < 3000, `took ${Date.now() - start} ms`);
});
