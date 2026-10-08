import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexCursorFor, codexHistory, codexItems } from '../src/brain/codex-history.js';
import { Config } from '../src/instance/config/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-codex.mjs');
const profile = Config.parse({ profiles: { c: { cwd: here, backend: 'codex' } }, routes: [] }).profiles.c;

test('codex: a turn is its prompt, then one reply with the messages joined and the tools named', () => {
  assert.deepEqual(codexItems([
    { startedAt: 1791465873, completedAt: 1791465881, items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'Run cat note.txt' }, { type: 'image', url: 'data:' }] },
      { type: 'reasoning', summary: ['thinking'] },
      { type: 'plan', text: 'step 1' },
      { type: 'agentMessage', text: 'Reading it.', phase: 'commentary' },
      { type: 'commandExecution', command: 'cat note.txt' },
      { type: 'commandExecution', command: 'ls' },
      { type: 'fileChange', changes: [] },
      { type: 'mcpToolCall', server: 'github', tool: 'search' },
      { type: 'dynamicToolCall', tool: 'lookup' },
      { type: 'functionCallOutput', name: 'x' },
      { type: 'agentMessage', text: 'It says hello.', phase: 'final_answer' },
    ] },
    { startedAt: 1791465881, items: [{ type: 'userMessage', content: [{ type: 'text', text: 'and?' }] }] },
    { items: 'not a list' },
  ]), [
    { role: 'user', text: 'Run cat note.txt\n\n[image]', at: '2026-10-08T13:24:33.000Z' },
    { role: 'assistant', text: 'Reading it.\n\nIt says hello.', tools: ['shell', 'apply_patch', 'github.search', 'lookup'], at: '2026-10-08T13:24:41.000Z' },
    { role: 'user', text: 'and?', at: '2026-10-08T13:24:41.000Z' },
  ]);
});

test('codex: pages come from the app-server, newest last, and its cursor reaches older turns', async () => {
  const all = await codexHistory(profile, 'thr-1', { bin: FAKE });
  assert.deepEqual(all!.items.map((i) => [i.role, i.text, i.tools ?? []]), [
    ['user', 'Run cat note.txt\n\n[image]', []],
    ['assistant', 'Reading it.\n\nIt says hello.', ['shell', 'github.search']],
    ['user', 'Say DONE only.', []],
    ['assistant', 'DONE', []],
  ]);
  assert.equal(all!.more, false);
  const newest = await codexHistory(profile, 'thr-1', { bin: FAKE, limit: 2 });
  assert.deepEqual([newest!.items.map((i) => i.text), newest!.more, typeof newest!.cursor], [['Say DONE only.', 'DONE'], true, 'string']);
  const older = await codexHistory(profile, 'thr-1', { bin: FAKE, limit: 2, before: newest!.cursor });
  assert.deepEqual([older!.items.map((i) => i.role), older!.more], [['user', 'assistant'], false]);
});

test('codex: an unknown thread, a missing binary or a silent one is undefined', async () => {
  assert.equal(await codexHistory(profile, 'thr-1', { bin: FAKE, env: { ...process.env, FAKE_CODEX_NO_THREAD: '1' } }), undefined);
  assert.equal(await codexHistory(profile, 'thr-1', { bin: '/nonexistent/codex' }), undefined);
  assert.equal(await codexHistory(profile, 'thr-1', { bin: FAKE, env: { ...process.env, FAKE_CODEX_HANG: '1' }, timeoutMs: 300 }), undefined);
});

test('codex: only a cursor Codex gave for this very thread is passed on', () => {
  const mine = JSON.stringify({ requestedThreadId: 'thr-1', rolloutOrdinal: 20 });
  assert.equal(codexCursorFor(mine, 'thr-1'), true);
  assert.equal(codexCursorFor(mine, 'thr-2'), false, 'another thread');
  assert.equal(codexCursorFor('opaque', 'thr-1'), false);
  assert.equal(codexCursorFor(JSON.stringify({ requestedThreadId: 'thr-1', pad: 'x'.repeat(3000) }), 'thr-1'), false, 'too long');
});
