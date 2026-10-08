import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { piHistory } from '../src/brain/history.js';

const SID = '11111111-2222-3333-4444-555555555555';
const T = (n: number) => `2026-10-08T07:11:${String(n).padStart(2, '0')}.000Z`;
const header = { type: 'session', version: 3, id: SID, timestamp: T(0), cwd: '/project' };
const msg = (id: string, parentId: string | null, message: object, n: number) => ({ type: 'message', id, parentId, timestamp: T(n), message });

function write(lines: (object | string)[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-pi-history-'));
  const p = join(dir, `2026-10-08T07-11-16-672Z_${SID}.jsonl`);
  writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return p;
}

/** The lines of a real pi 0.86.1 session (2026-10-08, `pi -p` reading one file), signatures cut. */
const real = [
  header,
  { type: 'model_change', id: 'fc961771', parentId: null, timestamp: T(1), provider: 'openai-codex', modelId: 'gpt-5.6-luna' },
  { type: 'thinking_level_change', id: 'c728d621', parentId: 'fc961771', timestamp: T(1), thinkingLevel: 'medium' },
  msg('8515f8fc', 'c728d621', { role: 'system', content: '', sections: { preamble: 'You are...' }, timestamp: 1 }, 2),
  msg('7d2443d9', '8515f8fc', { role: 'user', content: [{ type: 'text', text: 'Read note.txt, then tell me its content.' }], timestamp: 2 }, 3),
  msg('fa2c8056', '7d2443d9', { role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'note.txt' } }], stopReason: 'toolUse', timestamp: 3 }, 4),
  msg('035f6ef6', 'fa2c8056', { role: 'toolResult', toolCallId: 'call_1', toolName: 'read', content: [{ type: 'text', text: 'hello file\n' }], isError: false, timestamp: 4 }, 5),
  msg('a00f671a', '035f6ef6', { role: 'assistant', content: [{ type: 'thinking', thinking: 'easy' }, { type: 'text', text: 'hello file', textSignature: 'x' }], stopReason: 'stop', timestamp: 5 }, 6),
];

test('pi: prompts and replies are shown; the system prompt, tool results and thinking are not', () => {
  const page = piHistory(write(real));
  assert.deepEqual(page, {
    items: [
      { role: 'user', text: 'Read note.txt, then tell me its content.', at: T(3) },
      { role: 'assistant', text: '', tools: ['read'], at: T(4) },
      { role: 'assistant', text: 'hello file', at: T(6) },
    ],
    more: false,
  });
});

test('pi: only the branch that ends at the last entry is shown', () => {
  const page = piHistory(write([
    header,
    msg('u1', null, { role: 'user', content: 'first' }, 1),
    msg('a1', 'u1', { role: 'assistant', content: [{ type: 'text', text: 'one' }] }, 2),
    msg('u2', 'a1', { role: 'user', content: 'left behind' }, 3),
    msg('a2', 'u2', { role: 'assistant', content: [{ type: 'text', text: 'abandoned' }] }, 4),
    { type: 'branch_summary', id: 'b1', parentId: 'a1', timestamp: T(5), fromId: 'a2', summary: 'tried A' },
    msg('u3', 'b1', { role: 'user', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }, 6),
    msg('a3', 'u3', { role: 'assistant', content: [{ type: 'text', text: 'a picture' }] }, 7),
  ]));
  assert.deepEqual(page.items.map((i) => i.text), ['first', 'one', '[image]', 'a picture']);
});

test('pi: compaction does not hide what the person saw; a bad line is skipped', () => {
  const page = piHistory(write([
    header,
    msg('u1', null, { role: 'user', content: 'old' }, 1),
    msg('a1', 'u1', { role: 'assistant', content: [{ type: 'text', text: 'old reply' }] }, 2),
    'not json',
    { type: 'compaction', id: 'c1', parentId: 'a1', timestamp: T(3), summary: 'S', firstKeptEntryId: 'a1', tokensBefore: 9 },
    msg('u2', 'c1', { role: 'user', content: 'new' }, 4),
  ]));
  assert.deepEqual(page.items.map((i) => i.text), ['old', 'old reply', 'new']);
});

test('pi: pages walk back with the cursor; a stale cursor gives an empty page', () => {
  const p = write(real);
  const newest = piHistory(p, { limit: 2 });
  assert.deepEqual([newest.items.map((i) => i.text), newest.more, newest.cursor], [['', 'hello file'], true, 'fa2c8056']);
  const older = piHistory(p, { limit: 2, before: newest.cursor });
  assert.deepEqual([older.items.map((i) => i.text), older.more, older.cursor], [['Read note.txt, then tell me its content.'], false, undefined]);
  assert.deepEqual(piHistory(p, { before: 'gone1234' }), { items: [], more: false });
  // Not an id at all: read as no cursor, like Claude's reader.
  assert.equal(piHistory(p, { before: '../x' }).items.length, 3);
});

test('pi: a file read from its end says older messages exist, with no cursor past the cut', () => {
  const lines: object[] = [header];
  let parent: string | null = null;
  for (let i = 0; i < 50; i++) {
    const id = `e${i}`;
    lines.push(msg(id, parent, i % 2 ? { role: 'assistant', content: [{ type: 'text', text: `r${i}` }] } : { role: 'user', content: `q${i}` }, i % 60));
    parent = id;
  }
  const page = piHistory(write(lines), { maxBytes: 2000 });
  assert.ok(page.items.length > 0 && page.items.length < 50);
  assert.equal(page.items.at(-1)!.text, 'r49');
  assert.deepEqual([page.more, page.cursor], [true, undefined]);
  assert.deepEqual(piHistory('/nonexistent/file.jsonl'), { items: [], more: false });
});
