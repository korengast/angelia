import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Config } from '../src/instance/config/schema.js';
import { claudeTranscript, exportChat, grokSessionDir } from '../src/instance/export.js';

const jl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n{"half a line';

function rig() {
  const home = mkdtempSync(join(tmpdir(), 'angelia-export-'));
  const cfg = Config.parse({
    profiles: { c: { cwd: '/w/claude.one' }, g: { cwd: '/w/grok one', backend: 'grok' } },
    routes: [{ platform: 'whatsapp', chat: 'c@g.us', profile: 'c' }, { platform: 'telegram', chat: '9', profile: 'g' }],
  });
  const claude = claudeTranscript('/w/claude.one', 'c1', home);
  mkdirSync(dirname(claude), { recursive: true });
  writeFileSync(claude, jl([
    { type: 'user', timestamp: 't1', message: { role: 'user', content: 'hello' } },
    { type: 'user', isMeta: true, timestamp: 't1', message: { role: 'user', content: 'meta' } },
    { type: 'assistant', timestamp: 't2', message: { content: [{ type: 'thinking', thinking: 'hm' }] } },
    { type: 'assistant', timestamp: 't2', message: { content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', name: 'Bash', input: {} }] } },
    { type: 'user', timestamp: 't3', message: { content: [{ type: 'tool_result', content: 'SECRET-ISH OUTPUT' }] } },
    { type: 'assistant', isSidechain: true, timestamp: 't3', message: { content: [{ type: 'text', text: 'subagent' }] } },
    { type: 'assistant', timestamp: 't4', message: { content: [{ type: 'text', text: 'done' }] } },
    { type: 'attachment', timestamp: 't4' },
  ]));
  const gdir = grokSessionDir('/w/grok one', 'g1', home);
  mkdirSync(gdir, { recursive: true });
  writeFileSync(join(gdir, 'rewind_points.jsonl'), jl([{ prompt_index: 0, created_at: 'T0' }]));
  writeFileSync(join(gdir, 'chat_history.jsonl'), jl([
    { type: 'system', content: 'you are grok' },
    { type: 'user', content: [{ type: 'text', text: '<user_info>env</user_info>' }] },
    { type: 'user', content: [{ type: 'text', text: 'reminder' }], synthetic_reason: 'system_reminder' },
    { type: 'user', content: [{ type: 'text', text: '<user_query>\nsearch it\n</user_query>' }], prompt_index: 0 },
    { type: 'reasoning', summary: [] },
    { type: 'assistant', content: 'on it', tool_calls: [{ name: 'use_tool', arguments: '{}' }] },
    { type: 'tool_result', content: 'results' },
    { type: 'assistant', content: 'found' },
  ]));
  const sessions = { version: 1 as const, chats: {
    'whatsapp:c@g.us': { active: 'c1', history: [{ id: 'c1', created_at: '', last_used_at: '', turns: 2, started: true, label: '', backend: 'claude-code' }] },
    'telegram:9': { active: 'g1', history: [{ id: 'old', created_at: '', last_used_at: '', turns: 1, started: true, label: '', backend: 'claude-code' }, { id: 'g1', created_at: '', last_used_at: '', turns: 1, started: true, label: '', backend: 'grok' }] },
  } };
  return { home, cfg, sessions };
}

test('the Claude transcript is looked up under the resolved cwd, as the CLI names it', () => {
  const base = mkdtempSync(join(tmpdir(), 'angelia-export-link-'));
  mkdirSync(join(base, 'real'));
  symlinkSync(join(base, 'real'), join(base, 'link'));
  assert.equal(claudeTranscript(join(base, 'link'), 's1', '/h'), claudeTranscript(realpathSync(join(base, 'real')), 's1', '/h'));
  assert.match(claudeTranscript('/w/claude.one', 'c1', '/h'), /^\/h\/\.claude\/projects\/-w-claude-one\/c1\.jsonl$/);
});

test('a Claude chat exports what was said and the tools used, not tool output', () => {
  const { home, cfg, sessions } = rig();
  const rows = exportChat(cfg, sessions, 'whatsapp:c@g.us', { home });
  assert.deepEqual(rows.map((r) => [r.ts, r.role, r.text, r.tools]), [
    ['t1', 'user', 'hello', undefined], ['t2', 'assistant', 'checking', ['Bash']], ['t4', 'assistant', 'done', undefined]]);
  assert.equal(rows[0].backend, 'claude-code');
  assert.equal(rows[0].profile, 'c');
  const withTools = exportChat(cfg, sessions, 'whatsapp:c@g.us', { home, tools: true });
  assert.ok(withTools.some((r) => r.role === 'tool' && r.text === 'SECRET-ISH OUTPUT'), '--tools adds the output');
});

test('a grok chat exports the same shape, prompts timed, preamble and reminders left out', () => {
  const { home, cfg, sessions } = rig();
  const rows = exportChat(cfg, sessions, 'telegram:9', { home });
  assert.deepEqual(rows.map((r) => [r.ts, r.role, r.text, r.tools]), [
    ['T0', 'user', 'search it', undefined], ['T0', 'assistant', 'on it', ['use_tool']], ['T0', 'assistant', 'found', undefined]]);
  assert.equal(rows[0].backend, 'grok');
  assert.equal(exportChat(cfg, sessions, 'telegram:9', { home, tools: true }).filter((r) => r.role === 'tool').length, 1);
});

test('--all walks every session, each read by the CLI that owned it; bad input is named', () => {
  const { home, cfg, sessions } = rig();
  const all = exportChat(cfg, sessions, 'telegram:9', { home, all: true });
  assert.deepEqual([...new Set(all.map((r) => r.session))], ['g1'], 'a session whose file is gone gives no rows, not an error');
  assert.throws(() => exportChat(cfg, sessions, 'telegram:404', { home }), /no route/);
  assert.throws(() => exportChat(cfg, sessions, 'telegram:9', { home, session: 'nope' }), /no session nope/);
});
