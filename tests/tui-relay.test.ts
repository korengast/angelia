import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-tui.sh');
const HOOK = join(here, '..', 'scripts', 'tui-permission-hook.mjs');
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();

test('a turn read from the chat: the hook\'s request is relayed whole, the answer returns to that request, and no key is pressed', { skip: !hasTmux && 'no tmux', timeout: 60_000 }, async (t) => {
  // Own socket and own state dir, so nothing here can touch a live Angelia.
  const socket = `angelia-test-relay-${process.pid}`;
  const state = mkdtempSync(join(tmpdir(), 'angelia-tuirelay-'));
  process.env.ANGELIA_TMUX_SOCKET = socket;
  process.env.ANGELIA_STATE_DIR = state;
  const { TuiBrain } = await import('../src/brain/tui.js');
  const tmux = (...a: string[]) => execFileSync('tmux', ['-L', socket, ...a], { encoding: 'utf8' }).trim();
  t.after(() => { try { tmux('kill-server'); } catch { /* already gone */ } });

  const cwd = mkdtempSync(join(tmpdir(), 'angelia-tuirelay-cwd-'));
  const profile = Config.parse({ profiles: { x: { cwd, tui: true } }, routes: [] }).profiles.x;
  const brain = new TuiBrain(profile, { id: '33333333-4444-5555-6666-777777777777', started: false }, { bin: FAKE, permissionTimeoutMs: 60_000 });
  brain.start();
  assert.equal(await (brain as any).ready, null);
  const dir = join(state, 'tui', brain.name);

  // A turn read from the chat; follow() reads the one running, so nothing is pasted into the fake pane.
  brain.turnSentAt = Date.now() - 1000;
  const fg = brain.follow();
  const next = fg.next(); // the reader starts, and tells the hook so before its first poll
  const hook = spawn(process.execPath, [HOOK], { env: { ANGELIA_TUI_MARKER: join(dir, 'turn.json') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  hook.stdout.on('data', (b: Buffer) => { out += b; });
  const closed = new Promise((r) => hook.on('close', r));
  hook.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'Clean up' } }));

  const asked = (await next).value;
  assert.equal(asked?.kind, 'permission');
  if (asked?.kind !== 'permission') return;
  assert.deepEqual({ tool: asked.tool, preview: asked.preview }, { tool: 'Bash', preview: 'rm -rf build' });
  assert.equal(brain.pendingPermissionCount, 1);
  // The chat is slow to take the request (a rate limit, a network stall): the reader waits at its yield,
  // and the hook must not take that for a daemon that stopped reading.
  const beat = () => JSON.parse(readFileSync(join(dir, 'permissions', 'relay.json'), 'utf8')).at as number;
  const before = beat();
  await new Promise((r) => setTimeout(r, 2500));
  assert.ok(beat() > before, 'the heartbeat goes on while the reader waits');
  const screen = tmux('capture-pane', '-p', '-t', brain.name);
  assert.equal(brain.answerPermission(asked.id.slice(0, 8), true), true);
  await closed;
  assert.deepEqual(JSON.parse(out).hookSpecificOutput.decision, { behavior: 'allow' });
  assert.equal(tmux('capture-pane', '-p', '-t', brain.name), screen, 'no key reached the pane');
  assert.equal(brain.pendingPermissionCount, 0);

  writeFileSync(join(dir, 'turn.json'), JSON.stringify({ text: 'done', at: Date.now() }));
  assert.deepEqual((await fg.next()).value, { kind: 'result', text: 'done', isError: false });
  assert.ok(!existsSync(join(dir, 'permissions', 'relay.json')), 'the turn is over: the hook steps aside');

  // A reader let go of (the idle reap, a restart) stops the heartbeat, and its loop does not restart it.
  brain.turnSentAt = Date.now();
  const again = brain.follow();
  const pending = again.next();
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(existsSync(join(dir, 'permissions', 'relay.json')));
  await brain.release();
  assert.equal((await pending).value?.kind, 'result');
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(!existsSync(join(dir, 'permissions', 'relay.json')), 'no heartbeat after release');
});
