import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteControlName, claudeArgv, childEnv, versionAtLeast } from '../src/brain/argv.js';

const p = { cwd: '/x', permission_mode: 'acceptEdits' as const, add_dirs: ['/y'], unsafe_ok: false, model: 'sonnet', effort: 'low' as const };

test('new session uses --session-id, started uses --resume, never both', () => {
  const a = claudeArgv(p, { id: 'u1', started: false });
  assert.ok(a.includes('--session-id') && !a.includes('--resume'));
  const b = claudeArgv(p, { id: 'u1', started: true });
  assert.ok(b.includes('--resume') && !b.includes('--session-id'));
  assert.deepEqual(a.slice(0, 9), ['claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio']);
  assert.ok(a.includes('--add-dir') && a.includes('/y') && a.includes('--model') && a.includes('--effort'));
});

test('bypassPermissions becomes the explicit flag', () => {
  const a = claudeArgv({ ...p, permission_mode: 'bypassPermissions' }, { id: 'u', started: false });
  assert.ok(a.includes('--dangerously-skip-permissions') && !a.includes('--permission-mode'));
});

test('billing env is stripped', () => {
  const env = childEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', HOME: '/h' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
});

test('the Google and xAI keys are stripped too, so grok, and a Gemini CLI an agent calls, stay on the subscription', () => {
  const env = childEnv({ PATH: '/bin', GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'g', GOOGLE_GENAI_USE_VERTEXAI: 'true', XAI_API_KEY: 'x', GROK_CODE_XAI_API_KEY: 'x', GOOGLE_APPLICATION_CREDENTIALS: '/c.json' });
  // Application credentials are how an agent's own gcloud tools log in; they do not bill a CLI turn.
  assert.deepEqual(Object.keys(env).sort(), ['GOOGLE_APPLICATION_CREDENTIALS', 'PATH']);
});

test('version compare', () => {
  assert.ok(versionAtLeast('2.1.270', '2.1.270'));
  assert.ok(versionAtLeast('2.2.0', '2.1.270'));
  assert.ok(!versionAtLeast('2.1.269', '2.1.270'));
});

test('chrome: true adds --chrome', async () => {
  const { Profile } = await import('../src/instance/config/schema.js');
  const p = Profile.parse({ cwd: '/tmp', chrome: true });
  assert.ok(claudeArgv(p, { id: 'x', started: false }).includes('--chrome'));
  assert.ok(!claudeArgv(Profile.parse({ cwd: '/tmp' }), { id: 'x', started: false }).includes('--chrome'));
});

test('print mode never passes --remote-control (ignored there); the session name is per profile and session', async () => {
  const { Profile } = await import('../src/instance/config/schema.js');
  const p = Profile.parse({ cwd: '/home/example/agents/notes' });
  const a = claudeArgv(p, { id: 'abcdef12-0000-0000-0000-000000000000', started: false });
  assert.ok(!a.includes('--remote-control'));
  assert.equal(remoteControlName(p, { id: 'abcdef12-0000-0000-0000-000000000000', started: false }), 'angelia-notes-abcdef12');
  assert.equal(remoteControlName({ ...p, cwd: '/x/σημειώσεις ταξιδιού' }, { id: '12345678-1', started: true }), 'angelia-12345678');
});

test('claudeTuiArgv runs the CLI the way a person does: no print mode, a Stop hook, Remote Control', async () => {
  const { claudeTuiArgv } = await import('../src/brain/argv.js');
  const p = { cwd: '/home/example/groups/angelia', permission_mode: 'bypassPermissions' as const, add_dirs: ['/home/example/code'], unsafe_ok: false,
    shell: false, shell_timeout_seconds: 60, chrome: false, backend: 'claude-code' as const,
    tui: true, model: 'opus', effort: 'high' as const };
  const fresh = claudeTuiArgv(p, { id: 'sess-1', started: false }, 'claude', '/s/settings.json', 'angelia-angelia-sess');
  assert.equal(fresh.includes('-p'), false);
  assert.equal(fresh.includes('--input-format'), false);
  assert.deepEqual(fresh, ['claude', '--dangerously-skip-permissions', '--settings', '/s/settings.json', '--session-id', 'sess-1',
    '--model', 'opus', '--effort', 'high', '--add-dir', '/home/example/code', '--disallowed-tools=AskUserQuestion', '--remote-control', 'angelia-angelia-sess']);
  const again = claudeTuiArgv(p, { id: 'sess-1', started: true }, 'claude', '/s/settings.json', 'n');
  assert.equal(again[again.indexOf('--resume') + 1], 'sess-1');
});

test('no tool that waits for a click on a screen the chat does not have', async () => {
  const { Profile } = await import('../src/instance/config/schema.js');
  const p = Profile.parse({ cwd: '/tmp' });
  assert.ok(claudeArgv(p, { id: 'x', started: false }).includes('--disallowed-tools=AskUserQuestion'));
});
