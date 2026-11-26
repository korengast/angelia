import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import type { Inbound } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const HOUR = 3600_000;

test('print mode: a session with a background task still running is not reaped; after its end it is', { timeout: 20_000 }, async (t) => {
  const cfg = Config.parse({ profiles: { a: { cwd: here } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }], defaults: { max_out_per_min: 1000 } });
  const o = new Orchestrator(cfg, { telegram: { send: async () => {} } }, { stateDir: mkdtempSync(join(tmpdir(), 'angelia-bgreap-')), bins: { 'claude-code': join(here, 'fake-claude.mjs') } });
  t.after(() => o.shutdown());
  const dm = (text: string): Inbound => ({ platform: 'telegram', chat: '1', sender: 'u1', senderName: 'Owner', text, isGroup: false, mentioned: false, media: [] });
  await o.handle(dm('BGSTART'));
  await o.reapIdle(Date.now() + HOUR);
  assert.equal(o.status().length, 1, 'kept while the task runs');
  await o.handle(dm('BGDONE'));
  await o.reapIdle(Date.now() + HOUR);
  assert.equal(o.status().length, 0, 'reaped once it ended');
});

test('tmux mode: a background command and a subagent hold the pane until their end is read, or too long', async () => {
  process.env.ANGELIA_STATE_DIR ??= mkdtempSync(join(tmpdir(), 'angelia-bgreap-state-'));
  const { TuiBrain, TEAMMATE_MAX_MS } = await import('../src/brain/tui.js');
  const cwd = mkdtempSync(join(tmpdir(), 'angelia-bgreap-cwd-'));
  const profile = Config.parse({ profiles: { x: { cwd, tui: true } }, routes: [] }).profiles.x;
  const brain = new TuiBrain(profile, { id: crypto.randomUUID(), started: true }, { bin: '/bin/false' });
  const b = brain as any;
  b.up = true;
  b.transcript = join(cwd, 'transcript.jsonl');
  writeFileSync(b.transcript, '');
  const rows = (...r: object[]) => appendFileSync(b.transcript, r.map((x) => `${JSON.stringify(x)}\n`).join(''));
  const call = (id: string, name: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } });
  const result = (id: string, toolUseResult: object) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult });
  b.noteBackground(JSON.stringify(call('toolu_1', 'Bash')));
  b.noteBackground(JSON.stringify(result('toolu_1', { backgroundTaskId: 'b1' })));
  b.noteBackground(JSON.stringify(call('toolu_2', 'Agent')));
  b.noteBackground(JSON.stringify(result('toolu_2', { status: 'async_launched' })));
  assert.equal(brain.openTaskCount(), 2);
  rows({ type: 'queue-operation', operation: 'enqueue', content: '<task-notification><tool-use-id>toolu_1</tool-use-id></task-notification>' });
  assert.equal(brain.openTaskCount(), 1, 'its end is read between turns');
  b.openTasks.set('toolu_2', Date.now() - TEAMMATE_MAX_MS);
  assert.equal(brain.openTaskCount(), 0, 'past the longest time it holds nothing');
  await brain.stop().catch(() => {});
});
