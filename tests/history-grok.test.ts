import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GrokItems, grokItems, grokPage, grokReplay } from '../src/brain/grok-history.js';
import { Config } from '../src/instance/config/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-grok.mjs');

/** What grok 1.0.40 replayed on session/load of a real two-prompt session (2026-10-08), output cut. */
const real = [
  { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Read note.txt and tell me its content in one short line.' }, _meta: { modelId: 'grok-4.7', promptIndex: 0 } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: "I'll read `note.txt` and give you its content in one short line." } },
  { sessionUpdate: 'tool_call', toolCallId: 'call-0', title: 'Execute `rg --files`', kind: 'execute', status: 'completed', rawInput: { variant: 'Bash' }, _meta: { 'x.ai/tool': { version: 1, name: 'run_terminal_command', kind: 'execute' } } },
  { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Found note.txt in the workspace.' } },
  { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read `note.txt`', kind: 'read', status: 'completed', rawInput: { variant: 'ReadFile' }, _meta: { 'x.ai/tool': { version: 1, name: 'read_file', kind: 'read' } } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The file says: hello grok file.' } },
  { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Say the word DONE only.' }, _meta: { modelId: 'grok-4.7', promptIndex: 1 } },
  { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Simple.' } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DONE' } },
  { sessionUpdate: 'available_commands_update', availableCommands: [] },
];

test('grok: a replay becomes prompts and replies; thoughts and tool output are left out', () => {
  assert.deepEqual(grokItems(real), [
    { role: 'user', text: 'Read note.txt and tell me its content in one short line.' },
    { role: 'assistant', text: "I'll read `note.txt` and give you its content in one short line.\n\nThe file says: hello grok file.", tools: ['run_terminal_command', 'read_file'] },
    { role: 'user', text: 'Say the word DONE only.' },
    { role: 'assistant', text: 'DONE' },
  ]);
});

test('grok: chunks of one message are glued; two prompts with no reply between stay two; a tool without a name uses its kind', () => {
  assert.deepEqual(grokItems([
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'first' }, _meta: { promptIndex: 0 } },
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'second' }, _meta: { promptIndex: 1 } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hel' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } },
    { sessionUpdate: 'tool_call', kind: 'edit' },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'image' } },
    null as never,
  ]), [
    { role: 'user', text: 'first' },
    { role: 'user', text: 'second' },
    { role: 'assistant', text: 'hello', tools: ['edit'] },
  ]);
});

test('grok: pages walk back by index', () => {
  const items = grokItems(real);
  const newest = grokPage(items, { limit: 3 });
  assert.deepEqual([newest.items.length, newest.more, newest.cursor], [3, true, '1']);
  const older = grokPage(items, { limit: 3, before: newest.cursor });
  assert.deepEqual([older.items.map((i) => i.role), older.more, older.cursor], [['user'], false, undefined]);
  assert.equal(grokPage(items, { before: 'x' }).items.length, 4, 'not an index: read as no cursor');
});

test('grok: the replay comes from grok itself over ACP; an unknown session or a dead grok is undefined', async () => {
  const profile = Config.parse({ profiles: { g: { cwd: here, backend: 'grok' } }, routes: [] }).profiles.g;
  const r = await grokReplay(profile, 'sess-1', { bin: FAKE, env: { ...process.env, FAKE_GROK_REPLAY: '1' } });
  assert.equal(r!.cut, false);
  assert.deepEqual(r!.items.map((i) => [i.role, i.text, i.tools ?? []]), [
    ['user', 'Read note.txt', []],
    ['assistant', "I'll read it.\n\nIt says hello.", ['run_terminal_command', 'read_file']],
    ['user', 'Thanks', []],
    ['assistant', 'Welcome.', []],
  ]);
  assert.equal(await grokReplay(profile, 'sess-1', { bin: FAKE, env: { ...process.env, FAKE_GROK_NO_LOAD: '1' } }), undefined);
  assert.equal(await grokReplay(profile, 'sess-1', { bin: '/nonexistent/grok' }), undefined);
  assert.equal(await grokReplay(profile, 'sess-1', { bin: FAKE, env: { ...process.env, FAKE_GROK_SILENT: '1' }, timeoutMs: 300 }), undefined);
});

test('grok: past the text limit the oldest messages go, and the page says older ones existed', () => {
  const b = new GrokItems(30);
  for (const u of real) b.add(u);
  assert.equal(b.cut, true);
  const items = b.items();
  assert.deepEqual(items.map((i) => i.text), ['Say the word DONE only.', 'DONE']);
  assert.deepEqual(grokPage(items, { cut: b.cut }), { items, more: true });
  assert.deepEqual(grokPage([], { cut: true }), { items: [], more: false });
});
