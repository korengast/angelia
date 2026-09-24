import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Config } from '../src/instance/config/schema.js';
import { createBrain, type Brain } from '../src/brain/index.js';
import { GrokBrain } from '../src/brain/grok.js';
import { ClaudeBrain } from '../src/brain/claude.js';
import { grokArgv } from '../src/brain/argv.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import type { BrainEvent, Inbound } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, 'fake-claude.mjs');
const FAKE_GROK = join(here, 'fake-grok.mjs');
const base = { cwd: here, add_dirs: [], unsafe_ok: false, shell: false, shell_timeout_seconds: 60, chrome: false };
const profile = (backend: 'grok' | 'claude-code', permission_mode: 'acceptEdits' | 'bypassPermissions' = 'acceptEdits') => ({ ...base, backend, permission_mode });

const made: Brain[] = [];
process.on('exit', () => made.forEach((b) => b.kill()));
function make(backend: 'grok', started = false, mode: 'acceptEdits' | 'bypassPermissions' = 'acceptEdits', id = 'sess-1', env: NodeJS.ProcessEnv = {}) {
  const b = createBrain(profile(backend, mode), { id, started }, { bin: FAKE_GROK, permissionTimeoutMs: 200, env: { ...process.env, ...env } });
  made.push(b); b.start();
  return b;
}
async function collect(b: Brain, text: string, allow = true): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const e of b.turn(text)) { out.push(e); if (e.kind === 'permission') b.answerPermission(e.id.slice(0, 4), allow); }
  return out;
}

test('factory picks the class by profile.backend', () => {
  assert.ok(createBrain(profile('claude-code'), { id: 'x', started: false }, { bin: 'true' }) instanceof ClaudeBrain);
  assert.ok(createBrain(profile('grok'), { id: 'x', started: false }, { bin: 'true' }) instanceof GrokBrain);
});

test('config accepts the two backends, rejects others, and says what happened to agy', () => {
  const cfg = Config.parse({ profiles: { g: { cwd: here, backend: 'grok' }, c: { cwd: here } }, routes: [] });
  assert.equal(cfg.profiles.g.backend, 'grok'); assert.equal(cfg.profiles.c.backend, 'claude-code');
  assert.throws(() => Config.parse({ profiles: { a: { cwd: here, backend: 'codex' } }, routes: [] }));
});

test('argv: grok carries the stance on argv', () => {
  assert.deepEqual(grokArgv({ ...profile('grok'), model: 'grok-4.6', effort: 'low' }), ['grok', '--permission-mode', 'acceptEdits', 'agent', '-m', 'grok-4.6', '--reasoning-effort', 'low', 'stdio']);
  assert.deepEqual(grokArgv(profile('grok', 'bypassPermissions')), ['grok', '--permission-mode', 'bypassPermissions', 'agent', '--always-approve', 'stdio']);
});

test('grok: handshake, turn, progress before a tool call, permission relay both ways', async () => {
  const b = make('grok');
  assert.deepEqual(await collect(b, 'hello'), [{ kind: 'result', text: 'echo: hello', isError: false }]);
  assert.match(b.backendSessionId!, /^grok-/);
  assert.equal(b.version, '1.0.30');
  assert.deepEqual(await collect(b, 'PROGRESS'), [{ kind: 'progress', text: 'working on it' }, { kind: 'result', text: 'all done', isError: false }]);
  const ev = await collect(b, 'PERM', true);
  assert.deepEqual(ev, [{ kind: 'permission', id: 'call-7f3a', tool: 'run_terminal_command', preview: 'rm -rf /tmp/x' }, { kind: 'result', text: 'tool allowed', isError: false }]);
  const no = await collect(b, 'PERM', false);
  assert.equal((no[1] as any).text, 'tool denied');
  await b.stop();
  assert.equal(b.alive, false);
});

test('grok: permission timeout denies; bypass never asks; resume loads the session; load failure is a result', async () => {
  const b = make('grok');
  const ev: BrainEvent[] = [];
  for await (const e of b.turn('PERM')) ev.push(e); // never answered: 200 ms timeout
  assert.equal(ev[0].kind, 'permission'); assert.equal((ev[1] as any).text, 'tool denied');
  assert.deepEqual(await collect(b, 'FAIL'), [{ kind: 'result', text: '', isError: true, reason: 'model unavailable' }]);
  await b.stop();
  const y = make('grok', false, 'bypassPermissions');
  assert.deepEqual(await collect(y, 'PERM'), [{ kind: 'result', text: 'tool allowed', isError: false }]);
  await y.stop();
  const r = make('grok', true, 'acceptEdits', 'grok-old');
  assert.deepEqual(await collect(r, 'back'), [{ kind: 'result', text: 'echo: back', isError: false }]);
  assert.equal(r.backendSessionId, 'grok-old');
  assert.equal((r as any).replayedUpdates, 1); // the fake replays one chunk; it was drained, not sent as an answer
  await r.stop();
  const bad = make('grok', true, 'acceptEdits', 'grok-gone', { FAKE_GROK_NO_LOAD: '1' });
  const e2 = await collect(bad, 'hi');
  assert.equal(e2[0].kind, 'result'); assert.ok((e2[0] as any).isError); assert.match((e2[0] as any).reason, /handshake: session not found/);
  await bad.stop();
});

test('grok: a binary that cannot be run is a failed turn, not a hang or a daemon crash', async () => {
  const b = createBrain(profile('grok'), { id: 'x', started: false }, { bin: join(here, 'no-such-grok'), permissionTimeoutMs: 200 });
  made.push(b); b.start();
  const ev = await collect(b, 'hello');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'result');
  assert.equal((ev[0] as { isError: boolean }).isError, true);
  assert.equal(b.alive, false);
});

test('orchestrator: a minted backend id replaces the row id, and the next spawn resumes it', async (t) => {
  const cfg = Config.parse({ profiles: { g: { cwd: here, backend: 'grok' } },
    routes: [{ platform: 'telegram', chat: 2, profile: 'g' }], defaults: { max_out_per_min: 1000 } });
  const sent: string[] = [];
  const o = new Orchestrator(cfg, { telegram: { send: async (_c: string, text: string) => { sent.push(text); } }, whatsapp: { send: async () => {} } },
    { stateDir: mkdtempSync(join(tmpdir(), 'angelia-be-')), bins: { grok: FAKE_GROK } });
  t.after(() => o.shutdown());
  const dm = (chat: string, text: string): Inbound => ({ platform: 'telegram', chat, sender: 'u1', text, isGroup: false, mentioned: false, media: [] });
  await o.handle(dm('2', 'hi'));
  assert.match(sent[0], /^echo: /);
  const g = o.map.getActive('telegram:2')!;
  assert.match(g.id, /^grok-/); assert.ok(g.started); assert.equal(g.turns, 1);
  await o.handle(dm('2', '/stop'));
  await o.handle(dm('2', 'PROGRESS'));
  assert.equal(sent.at(-1), 'all done');
  assert.equal(o.map.getActive('telegram:2')!.id, g.id);
  assert.equal(o.map.getActive('telegram:2')!.turns, 2);
});

test('switching a profile to another CLI starts a fresh session instead of resuming a foreign id', async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'angelia-sw-'));
  const mk = (backend: 'claude-code' | 'grok') => {
    const cfg = Config.parse({ profiles: { a: { cwd: here, backend } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }], defaults: { max_out_per_min: 1000 } });
    return new Orchestrator(cfg, { telegram: { send: async () => {} }, whatsapp: { send: async () => {} } }, { stateDir: state, bins: { 'claude-code': FAKE_CLAUDE, grok: FAKE_GROK } });
  };
  const dm = (text: string): Inbound => ({ platform: 'telegram', chat: '1', sender: 'u1', text, isGroup: false, mentioned: false, media: [] });
  const o1 = mk('claude-code'); await o1.handle(dm('hi')); await o1.shutdown();
  const first = o1.map.getActive('telegram:1')!;
  assert.equal(first.backend, 'claude-code');
  const o2 = mk('grok'); t.after(() => o2.shutdown());
  await o2.handle(dm('hi'));
  const second = o2.map.getActive('telegram:1')!;
  assert.notEqual(second.id, first.id); assert.match(second.id, /^grok-/); assert.equal(second.backend, 'grok');
  assert.equal(o2.map.list('telegram:1').length, 2);
});

test('grok: a child that dies without answering says why, from the tail of its stderr', async () => {
  const b = make('grok');
  const ev = await collect(b, 'CRASH');
  assert.deepEqual(ev, [{ kind: 'result', text: '', isError: true, reason: 'exit: grok: the model is not available on this plan' }]);
});
