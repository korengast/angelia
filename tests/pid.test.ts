import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { isDaemonPid } from '../src/daemon/pid.js';

test('a pid counts as the daemon only when it runs one: a stranger left in a stale pid file does not', { skip: process.platform === 'win32' }, async (t) => {
  const stranger = spawn('sleep', ['5']);
  const daemon = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)', '/usr/local/bin/angelia', 'daemon', '/x/routing.yaml']);
  t.after(() => { stranger.kill(); daemon.kill(); });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(isDaemonPid(stranger.pid!), false, 'alive, but not an angelia daemon');
  assert.equal(isDaemonPid(daemon.pid!), true);
  assert.equal(isDaemonPid(process.pid), false, 'never this process itself');
  assert.equal(isDaemonPid(0), false);
});
