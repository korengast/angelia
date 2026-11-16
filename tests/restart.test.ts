import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// STATE_DIR is read from the environment when daemon.js is first imported, so this must be set
// before the dynamic import below. A temp dir keeps the test away from a real daemon.
const dir = mkdtempSync(join(tmpdir(), 'angelia-restart-'));
process.env.ANGELIA_STATE_DIR = dir;
const { restartCommand, startTable, restartUnitArgv, launchChatRestart, watchChatRestart } = await import('../src/daemon/restart.js');
const { scopedArgv, tmux } = await import('../src/brain/tmux.js');
/** A folder holding the given scripts, executable unless the mode says otherwise. */
const bins = (files: Record<string, [string, number?]>): string => {
  const b = mkdtempSync(join(tmpdir(), 'angelia-bin-'));
  for (const [n, [body, mode]] of Object.entries(files)) { writeFileSync(join(b, n), `#!/bin/sh\n${body}\n`); chmodSync(join(b, n), mode ?? 0o755); }
  return b;
};

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
  const plist = { node: '/usr/local/bin/node', entry: '/x/cli.js', config: '/srv/new.yaml', stateDir: '/s' };
  // After `angelia service install new.yaml`, /restart still passes the running daemon's old table.
  assert.equal(startTable('/srv/old.yaml', plist, '/srv/old.yaml'), '/srv/new.yaml');
  assert.equal(startTable(undefined, undefined, '/srv/last.yaml'), '/srv/last.yaml');
  assert.equal(startTable('rel.yaml', undefined, '/srv/last.yaml'), join(process.cwd(), 'rel.yaml'), 'resolved once, here: the daemon is spawned in the state folder');
});

test('under systemd the restarter is its own unit: waits for it, logs to daemon.out, carries only the five variables', () => {
  const a = restartUnitArgv({ node: '/n', entry: '/e', config: '/c/$x.yaml', stateDir: '/s/50%', env: { PATH: '/p', HOME: '/h', LANG: 'C', ANGELIA_STATE_DIR: '/s/50%', XDG_RUNTIME_DIR: '/run/user/1', TELEGRAM_BOT_TOKEN: 'x', ANGELIA_SESSION_KEY: 'k' }, now: 7 });
  assert.deepEqual(a.slice(0, 5), ['--user', '--wait', '--collect', '--quiet', '--unit=angelia-restart-7']);
  assert.ok(a.includes('StandardOutput=append:/s/50%/daemon.out'));
  assert.ok(a.includes('StandardError=append:/s/50%/daemon.out'));
  assert.ok(a.includes('--working-directory=/s/50%'));
  assert.ok(a.includes('--setenv=XDG_RUNTIME_DIR=/run/user/1'));
  assert.deepEqual(a.slice(-5), ['/n', '/e', 'restart', '--from-daemon', '/c/$$x.yaml'], 'systemd-run expands $VAR in the command: $ doubled there');
  const d = restartUnitArgv({ node: '/a$b/n', entry: '/e', config: '/c', stateDir: '/s/$y', env: { HOME: '/h/$z' }, now: 1 });
  assert.equal(d[d.length - 5], '/a$$b/n');
  assert.ok(d.includes('StandardOutput=append:/s/$y/daemon.out') && d.includes('--setenv=HOME=/h/$z'), 'not in -p or --setenv values');
  assert.ok(!a.some((x) => /TOKEN|SESSION_KEY/.test(x)));
});

test('scopedArgv wraps tmux in a transient scope, described without the tmux command line', () => {
  assert.deepEqual(scopedArgv('tmux', ['-L', 'a', 'new-session']), ['systemd-run', ['--user', '--scope', '--collect', '--quiet', '--description=angelia tmux', 'tmux', '-L', 'a', 'new-session']]);
});

test('a scoped tmux call without systemd-run falls back to plain tmux', async () => {
  const b = bins({ tmux: ['echo "plain $*"'] });
  const r = await tmux(['-V'], { scope: true, inService: true, bin: join(b, 'tmux'), socket: 's', env: { PATH: b } });
  assert.deepEqual([r.code, r.out], [0, 'plain -L s -V\n']);
});

test('a scoped tmux call whose systemd-run fails (no user bus) falls back to plain tmux, once', async () => {
  const b = bins({ tmux: ['echo "plain $*"'], 'systemd-run': [`echo x >> "${'$'}0.calls"; echo "Failed to connect to bus: No medium found" >&2; exit 1`] });
  const r = await tmux(['-V'], { scope: true, inService: true, bin: join(b, 'tmux'), socket: 's', env: { PATH: b } });
  assert.deepEqual([r.code, r.out], [0, 'plain -L s -V\n']);
  assert.equal(readFileSync(join(b, 'systemd-run.calls'), 'utf8'), 'x\n', 'systemd-run was tried first');
});

test('a scoped tmux call that tmux itself refuses is returned as is, not run twice', async () => {
  const b = bins({ tmux: ['echo x >> "$0.calls"; echo "duplicate session: a" >&2; exit 1'], 'systemd-run': ['shift 5; exec "$@"'] });
  const r = await tmux(['new-session'], { scope: true, inService: true, bin: join(b, 'tmux'), socket: 's', env: { PATH: b } });
  assert.deepEqual([r.code, r.err], [1, 'duplicate session: a\n']);
  assert.equal(readFileSync(join(b, 'tmux.calls'), 'utf8'), 'x\n');
});

test('outside angelia.service a scoped call is plain tmux: systemd-run is not tried', async () => {
  const b = bins({ tmux: ['echo "plain $*"'], 'systemd-run': ['echo scoped'] });
  const r = await tmux(['-V'], { scope: true, inService: false, bin: join(b, 'tmux'), socket: 's', env: { PATH: b } });
  assert.equal(r.out, 'plain -L s -V\n');
});

test('a systemd-run that cannot be started (not ENOENT) fails the /restart and drops the note', async () => {
  const b = bins({ 'systemd-run': ['exit 0', 0o644] });
  const s = mkdtempSync(join(tmpdir(), 'angelia-rs-'));
  const path = process.env.PATH;
  process.env.PATH = b;
  try {
    const why = await new Promise<string>((res) => launchChatRestart('k', '/c.yaml', res, s, true));
    assert.match(why, /could not start the restart: .*EACCES/);
    assert.equal(existsSync(join(s, 'restart-note.json')), false);
  } finally { process.env.PATH = path; }
});

test('under systemd a restarter killed by a signal is a good restart, a non-zero exit is not', () => {
  for (const [code, sig, fails] of [[null, 'SIGTERM', false], [1, null, true]] as const) {
    writeFileSync(join(dir, 'restart-note.json'), '{}');
    const fired: string[] = [];
    let cb: (c: number | null, s: string | null) => void = () => {};
    watchChatRestart({ once: (_e: string, f: never) => { cb = f; } } as never, (w) => fired.push(w), dir, { signalIsSuccess: true });
    cb(code, sig);
    assert.equal(fired.length, fails ? 1 : 0);
    assert.equal(existsSync(join(dir, 'restart-note.json')), !fails);
  }
});
