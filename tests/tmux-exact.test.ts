import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Config } from '../src/instance/config/schema.js';
import { exact, tmux } from '../src/brain/tmux.js';
import { tmp } from './tmp.js';

const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();

// tmux `-t name` is a prefix match: with only foo-12 there, `-t foo-1` reaches it. Measured on tmux 3.7c.
test('tmux targets: exact() reaches only the session of that name, for every command Angelia sends', { skip: !hasTmux && 'no tmux', timeout: 30_000 }, async (t) => {
  const socket = `angelia-exact-${process.pid}`;
  const opts = { socket };
  t.after(() => { try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ } });
  const code = async (args: string[]) => (await tmux(args, opts)).code;
  assert.equal(await code(['new-session', '-d', '-s', 'foo-12', '-x', '80', '-y', '10', 'cat']), 0);
  // The problem: a bare name finds the longer one.
  assert.equal(await code(['has-session', '-t', 'foo-1']), 0, 'a bare name is a prefix match');
  for (const args of [['has-session'], ['capture-pane', '-p'], ['send-keys'], ['set-option', '-w'], ['kill-session']]) {
    assert.notEqual(await code([...args, '-t', exact('foo-1'), ...(args[1] === '-w' ? ['remain-on-exit', 'off'] : [])]), 0, `${args[0]} ${exact('foo-1')} reaches no other session`);
  }
  assert.equal(await code(['set-buffer', '-b', 'b', 'x']), 0);
  assert.notEqual(await code(['paste-buffer', '-b', 'b', '-t', exact('foo-1')]), 0);
  // And the same form reaches the session of that name, for each command.
  for (const args of [['has-session'], ['capture-pane', '-p'], ['send-keys', ''], ['set-option', '-w', 'remain-on-exit', 'off'], ['paste-buffer', '-b', 'b']]) {
    const [cmd, ...rest] = args;
    assert.equal(await code([cmd, '-t', exact('foo-12'), ...rest]), 0, `${cmd} ${exact('foo-12')}`);
  }
  assert.equal(await code(['kill-session', '-t', exact('foo-12')]), 0);
});

test('a tmux brain whose name is the start of a live session\'s name sees no session, and ends none', { skip: !hasTmux && 'no tmux', timeout: 30_000 }, async (t) => {
  const socket = `angelia-exact-b-${process.pid}`;
  t.after(() => { try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ } });
  const { TuiBrain } = await import('../src/brain/tui.js');
  const dir = tmp(t, 'angelia-exact-');
  const profile = Config.parse({ profiles: { x: { cwd: dir, tui: true } }, routes: [] }).profiles.x;
  const b = new TuiBrain(profile, { id: crypto.randomUUID(), started: false }, { stateDir: dir, tmuxSocket: socket });
  const longer = `${b.name}2`;
  execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', longer, '-x', '80', '-y', '10', 'cat']);
  assert.equal(await (b as any).sessionAlive(), false, 'has-session');
  assert.equal(await b.adopt(Date.now()), false, 'adopt');
  assert.equal(await (b as any).capture(10), '', 'capture-pane');
  await b.stop();
  assert.equal(execFileSync('tmux', ['-L', socket, 'ls', '-F', '#S'], { encoding: 'utf8' }).trim(), longer, 'stop ended no other session');
});

// Fable recheck (0.4.10): a lone chip is taken on its count only on a pane under 12 rows, so a capture
// reads the pane's height too, in the same tmux call, and gives back the screen without it.
test('a capture gives the screen as tmux draws it, and the pane\'s height', { skip: !hasTmux && 'no tmux', timeout: 30_000 }, async (t) => {
  const socket = `angelia-exact-c-${process.pid}`;
  t.after(() => { try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ } });
  const { TuiBrain } = await import('../src/brain/tui.js');
  const dir = tmp(t, 'angelia-exact-');
  const profile = Config.parse({ profiles: { x: { cwd: dir, tui: true } }, routes: [] }).profiles.x;
  const b = new TuiBrain(profile, { id: crypto.randomUUID(), started: false }, { stateDir: dir, tmuxSocket: socket });
  execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', b.name, '-x', '80', '-y', '10', 'printf "line 7\\n"; exec cat']);
  await new Promise((r) => setTimeout(r, 500));
  const want = execFileSync('tmux', ['-L', socket, 'capture-pane', '-p', '-t', exact(b.name), '-S', '-30'], { encoding: 'utf8' });
  assert.equal(await (b as any).capture(30), want);
  assert.equal((b as any).paneRows, 10);
  execFileSync('tmux', ['-L', socket, 'resize-window', '-t', exact(b.name), '-y', '14']);
  await (b as any).capture(30);
  assert.equal((b as any).paneRows, 14);
  await b.stop();
});
