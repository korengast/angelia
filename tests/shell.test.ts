import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runShell } from '../src/core/shell.js';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import type { Inbound } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));

test('runShell: cwd, exit code, stderr, timeout, truncation', async () => {
  const ok = await runShell('pwd; echo err 1>&2', { cwd: here, timeoutMs: 5000 });
  assert.equal(ok.code, 0);
  assert.equal(ok.text, `${here}\nerr\n[exit 0]`);
  const bad = await runShell('exit 3', { cwd: here, timeoutMs: 5000 });
  assert.equal(bad.text, '(no output)\n[exit 3]');
  const slow = await runShell('sleep 5', { cwd: here, timeoutMs: 200 });
  assert.equal(slow.timedOut, true);
  assert.match(slow.text, /\[timed out\]$/);
  // Several reads, most of them past what is kept: the total still counts every one.
  const big = await runShell('yes | head -c 2000000', { cwd: here, timeoutMs: 5000, maxChars: 100 });
  assert.match(big.text, /^(y\n){50}… \[truncated, 2000000 bytes in all\]\n\[exit 0\]$/);
});

test('/sh is opt-in per profile and runs without touching the brain', async (t) => {
  const cfg = Config.parse({
    profiles: { on: { cwd: here, shell: true }, off: { cwd: here } },
    routes: [
      { platform: 'telegram', chat: 1, profile: 'on' }, { platform: 'telegram', chat: 2, profile: 'off' },
      { platform: 'telegram', chat: -100, profile: 'on', mention: 'any', owners: ['boss'], allow_from: ['*'] },
    ],
    telegram: { token_env: 'TG_TEST_TOKEN' },
    defaults: { max_out_per_min: 1000 },
  });
  const sent: string[] = [];
  const sender = { send: async (_c: string, text: string) => { sent.push(text); } };
  const o = new Orchestrator(cfg, { telegram: sender, whatsapp: sender }, { stateDir: mkdtempSync(join(tmpdir(), 'angelia-sh-')), bins: { 'claude-code': join(here, 'fake-claude.mjs') } });
  t.after(() => o.shutdown());
  const dm = (chat: string, text: string, extra: Partial<Inbound> = {}): Inbound => ({ platform: 'telegram', chat, sender: 'u1', text, isGroup: false, mentioned: false, media: [], ...extra });
  await o.handle(dm('1', '/sh echo hi $((1+1))'));
  assert.equal(sent.at(-1), 'hi 2\n[exit 0]');
  await o.handle(dm('2', '/sh echo hi'));
  assert.match(sent.at(-1)!, /^Shell is off for profile off/);
  assert.equal(o.map.getActive('telegram:1'), undefined);
  assert.equal(o.status().length, 0);
  // groups: only listed owners
  await o.handle(dm('-100', '/sh echo hi', { isGroup: true, sender: 'stranger' }));
  assert.equal(sent.at(-1), 'Only an owner of this chat can do that.');
  await o.handle(dm('-100', '/sh echo hi', { isGroup: true, sender: 'boss' }));
  assert.equal(sent.at(-1), 'hi\n[exit 0]');
});

test('the bot token never reaches /sh or the agent; timeout kills the whole process group', async (t) => {
  const cfg = Config.parse({
    profiles: { on: { cwd: here, shell: true, shell_timeout_seconds: 2 } },
    routes: [{ platform: 'telegram', chat: 1, profile: 'on' }],
    telegram: { token_env: 'TG_TEST_TOKEN' },
    defaults: { max_out_per_min: 1000 },
  });
  const sent: string[] = [];
  const sender = { send: async (_c: string, text: string) => { sent.push(text); } };
  const env = { ...process.env, TG_TEST_TOKEN: 'secret123', ANTHROPIC_API_KEY: 'sk-nope' };
  const o = new Orchestrator(cfg, { telegram: sender, whatsapp: sender }, { stateDir: mkdtempSync(join(tmpdir(), 'angelia-sh-')), bins: { 'claude-code': join(here, 'fake-claude.mjs') }, env });
  t.after(() => o.shutdown());
  const dm = (text: string): Inbound => ({ platform: 'telegram', chat: '1', sender: 'u1', text, isGroup: false, mentioned: false, media: [] });
  await o.handle(dm('/sh echo "[${TG_TEST_TOKEN:-unset}]"'));
  assert.equal(sent.at(-1), '[unset]\n[exit 0]');
  const t0 = Date.now();
  await o.handle(dm('/sh (sleep 30 & echo child $!; wait)'));
  assert.ok(Date.now() - t0 < 5000, 'timeout must not wait for the background child');
  const pid = /child (\d+)/.exec(sent.at(-1)!)?.[1];
  assert.ok(pid);
  await new Promise((r) => setTimeout(r, 100));
  assert.throws(() => process.kill(Number(pid), 0), 'background child must be dead');
});
