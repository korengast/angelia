import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { parseCommand } from '../src/core/commands.js';
import { takeRestartNote, watchChatRestart, RESTART_NOTE, RESTART_ERROR } from '../src/daemon/restart.js';
import { EventEmitter } from 'node:events';
import type { Inbound } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));

function rig(restart?: { check(): string | undefined; launch(key: string): void }) {
  const cfg = Config.parse({
    profiles: { a: { cwd: here } },
    routes: [{ platform: 'whatsapp', chat: 'g@g.us', profile: 'a', mention: 'any', owners: ['boss'], allow_from: ['*'] }],
    defaults: { max_out_per_min: 1000 },
  });
  const sent: string[] = [];
  const sender = { send: async (_c: string, text: string) => { sent.push(text); } };
  const o = new Orchestrator(cfg, { telegram: sender, whatsapp: sender }, { stateDir: mkdtempSync(join(tmpdir(), 'angelia-rst-')), bins: { 'claude-code': join(here, 'fake-claude.mjs') }, restart });
  return { o, sent };
}
const msg = (sender: string): Inbound => ({ platform: 'whatsapp', chat: 'g@g.us', sender, senderName: sender, text: '/restart', isGroup: true, mentioned: true, media: [], allow_from: ['*'] });

test('/restart parses as a router command', () => {
  assert.deepEqual(parseCommand('/restart'), { name: 'restart' });
  assert.deepEqual(parseCommand('/restart@AngeliaBot'), { name: 'restart' });
});

test('/restart: owners only in a group; the table is checked before anything stops', async (t) => {
  const launched: string[] = [];
  let tableError: string | undefined = 'profiles.a.cwd: required';
  const { o, sent } = rig({ check: () => tableError, launch: (k) => launched.push(k) });
  t.after(() => o.shutdown());

  await o.handle(msg('member'));
  assert.equal(launched.length, 0);
  assert.doesNotMatch(sent.at(-1)!, /Restarting/);

  await o.handle(msg('boss'));
  assert.equal(launched.length, 0, 'a table that does not load must not restart');
  assert.match(sent.at(-1)!, /^Not restarting: the routing table does not load\.\nprofiles\.a\.cwd: required$/);

  tableError = undefined;
  await o.handle(msg('boss'));
  assert.match(sent.at(-1)!, /^Routing table ok\. Restarting now/);
  assert.deepEqual(launched, ['whatsapp:g@g.us'], 'launched once, for the chat that asked, after the reply');
});

test('/restart without a restarter says to use a terminal', async (t) => {
  const { o, sent } = rig();
  t.after(() => o.shutdown());
  await o.handle(msg('boss'));
  assert.match(sent.at(-1)!, /cannot restart itself/);
});

test('the restart note is read once, and a stale one is ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-note-'));
  const now = Date.parse('2026-09-21T10:00:00Z');
  writeFileSync(join(dir, RESTART_NOTE), JSON.stringify({ key: 'whatsapp:g@g.us', at: '2026-09-21T09:58:00Z' }));
  assert.deepEqual(takeRestartNote(dir, now), { key: 'whatsapp:g@g.us' });
  assert.ok(!existsSync(join(dir, RESTART_NOTE)));
  assert.equal(takeRestartNote(dir, now), undefined);
  writeFileSync(join(dir, RESTART_NOTE), JSON.stringify({ key: 'whatsapp:g@g.us', at: '2026-09-21T09:00:00Z' }));
  assert.equal(takeRestartNote(dir, now), undefined);
  assert.ok(!existsSync(join(dir, RESTART_NOTE)), 'a stale note is removed too');
});

test('end to end: the detached restart outlives the daemon it stops and starts a new one', { timeout: 90_000 }, async () => {
  const { spawn, spawnSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const root = join(here, '..');
  assert.equal(spawnSync('npx', ['tsc', '-p', root], { cwd: root, encoding: 'utf8' }).status, 0, 'build');
  const state = mkdtempSync(join(tmpdir(), 'angelia-e2e-'));
  const cfg = join(state, 'routing.yaml');
  writeFileSync(cfg, `profiles:\n  a:\n    cwd: ${state}\nroutes: []\napi:\n  port: ${20000 + Math.floor(Math.random() * 20000)}\n`);
  // Stands in for the running daemon: it owns the pid file and launches /restart's helper as its child.
  const fakeDaemon = `
    import { writeFileSync } from 'node:fs';
    const { launchChatRestart } = await import(${JSON.stringify(join(root, 'dist', 'daemon', 'restart.js'))});
    writeFileSync(${JSON.stringify(join(state, 'daemon.pid'))}, String(process.pid));
    launchChatRestart('telegram:1', ${JSON.stringify(cfg)});
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);`;
  const env = { ...process.env, ANGELIA_STATE_DIR: state };
  delete env.ANGELIA_SESSION_KEY;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', fakeDaemon], { env, stdio: 'ignore' });
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const pidNow = () => { try { return Number(readFileSync(join(state, 'daemon.pid'), 'utf8')); } catch { return 0; } };
  let next = 0;
  for (let i = 0; i < 200 && !next; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const p = pidNow();
    if (p && p !== parent.pid && alive(p)) next = p;
  }
  try {
    assert.ok(next, `no new daemon came up; daemon.out:\n${(() => { try { return readFileSync(join(state, 'daemon.out'), 'utf8').slice(-800); } catch { return '(none)'; } })()}`);
    assert.ok(!alive(parent.pid!), 'the old daemon was stopped');
    await new Promise((r) => setTimeout(r, 1000));
    assert.ok(!existsSync(join(state, RESTART_NOTE)), 'the new daemon took the note');
  } finally {
    if (next) process.kill(next, 'SIGTERM');
    if (alive(parent.pid!)) parent.kill('SIGKILL');
  }
});

test('a failed /restart reports its reason and drops the note; a clean exit says nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-rst-'));
  const said: string[] = [];
  const failed = new EventEmitter();
  writeFileSync(join(dir, RESTART_NOTE), '{}');
  writeFileSync(join(dir, RESTART_ERROR), 'daemon 42 did not stop; not starting a second one\n');
  watchChatRestart(failed, (why) => said.push(why), dir);
  failed.emit('exit', 1, null);
  assert.deepEqual(said, ['daemon 42 did not stop; not starting a second one']);
  assert.ok(!existsSync(join(dir, RESTART_NOTE)) && !existsSync(join(dir, RESTART_ERROR)));

  const killed = new EventEmitter();
  watchChatRestart(killed, (why) => said.push(why), dir);
  killed.emit('exit', null, 'SIGKILL');
  assert.equal(said.at(-1), 'the restart was killed by SIGKILL');

  const ok = new EventEmitter();
  writeFileSync(join(dir, RESTART_NOTE), '{}');
  watchChatRestart(ok, (why) => said.push(why), dir);
  ok.emit('exit', 0, null);
  assert.equal(said.length, 2);
  assert.ok(existsSync(join(dir, RESTART_NOTE)), 'a clean exit leaves the note for the new daemon');
});
