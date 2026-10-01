import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// STATE_DIR is read from the environment when daemon.js is first imported, so this must be set
// before the dynamic import below. A temp dir keeps the test away from a real daemon.
const dir = mkdtempSync(join(tmpdir(), 'angelia-restart-'));
process.env.ANGELIA_STATE_DIR = dir;
const { restartCommand, startTable } = await import('../src/daemon/restart.js');

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

test('a table this version cannot load stops nothing: the check runs in the new code, before the old daemon goes', async () => {
  // /restart's own check runs inside the old daemon, with the old code. After `angelia update` the
  // new code may reject the same table (an unknown key is an error since 0.3.3).
  const table = join(dir, 'routing.yaml');
  writeFileSync(table, `profiles:\n  p: { cwd: ${dir}, sanbox: true }\nroutes: []\n`);
  const daemon = spawn('sleep', ['30']);
  writeFileSync(join(dir, 'daemon.pid'), String(daemon.pid));
  try {
    await assert.rejects(() => restartCommand([table, '--force']), (e: Error) => /nothing was stopped/.test(e.message) && /profiles\.p\.sanbox: unknown key/.test(e.message));
    assert.equal(daemon.exitCode, null, 'the running daemon was not signalled');
    assert.equal(daemon.signalCode, null);
    assert.equal(existsSync(join(dir, 'daemon.out')), false, 'nothing was started');
  } finally { daemon.kill(); }
});

test('the table checked is the one the new daemon starts with: under launchd the plist\'s, else the given one, made absolute', () => {
  const plist = '<key>ProgramArguments</key><array><string>/usr/local/bin/node</string><string>/x/cli.js</string><string>daemon</string><string>/srv/new.yaml</string></array>';
  // After `angelia service install new.yaml`, /restart still passes the running daemon's old table.
  assert.equal(startTable('/srv/old.yaml', plist, '/srv/old.yaml'), '/srv/new.yaml');
  assert.equal(startTable(undefined, undefined, '/srv/last.yaml'), '/srv/last.yaml');
  assert.equal(startTable('rel.yaml', undefined, '/srv/last.yaml'), join(process.cwd(), 'rel.yaml'), 'resolved once, here: the daemon is spawned in the state folder');
});
