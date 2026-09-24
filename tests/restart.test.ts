import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// STATE_DIR is read from the environment when daemon.js is first imported, so this must be set
// before the dynamic import below. A temp dir keeps the test away from a real daemon.
const dir = mkdtempSync(join(tmpdir(), 'angelia-restart-'));
process.env.ANGELIA_STATE_DIR = dir;
const { restartCommand } = await import('../src/daemon/restart.js');

test('restart refuses to run as the daemon\'s own agent, in print mode and in tmux alike', async () => {
  const before = process.env.ANGELIA_SESSION_KEY;
  process.env.ANGELIA_SESSION_KEY = 'whatsapp:1@g.us';
  try {
    // A live daemon pid is not needed: in tui mode the agent is not a descendant of the daemon at
    // all, so the env var is the only signal that catches both hosts.
    writeFileSync(join(dir, 'daemon.pid'), String(process.pid));
    await assert.rejects(() => restartCommand([]), /agent of whatsapp:1@g\.us/);
    await assert.rejects(() => restartCommand([]), /terminal of your own/);
    // Nothing was stopped and nothing was started.
    assert.equal(readFileSync(join(dir, 'daemon.pid'), 'utf8'), String(process.pid));
    assert.equal(existsSync(join(dir, 'daemon.out')), false);
  } finally {
    if (before === undefined) delete process.env.ANGELIA_SESSION_KEY;
    else process.env.ANGELIA_SESSION_KEY = before;
  }
});
