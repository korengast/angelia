import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'angelia-svc-'));
process.env.ANGELIA_STATE_DIR = dir;
const { entry, servicePath, serviceCommand } = await import('../src/daemon/service.js');
const { envFile } = await import('../src/daemon/daemon.js');

test('service PATH: keeps order, drops duplicates and folders that do not exist, always has the system ones', () => {
  const extra = mkdtempSync(join(tmpdir(), 'angelia-bin-'));
  const p = servicePath({ PATH: `/usr/bin:/no/such/dir:/usr/bin` }, [extra], '/no/home').split(':');
  assert.equal(p[0], '/usr/bin');
  assert.ok(p.includes(extra));
  assert.ok(p.includes('/bin'));
  assert.ok(!p.includes('/no/such/dir'));
  assert.equal(p.filter((d) => d === '/usr/bin').length, 1);
});

test('the daemon reads the env file itself; quotes and export are stripped', () => {
  writeFileSync(join(dir, 'env'), 'export TELEGRAM_BOT_TOKEN="abc"\n# note\nOTHER=x y\n');
  assert.deepEqual(envFile(dir), { TELEGRAM_BOT_TOKEN: 'abc', OTHER: 'x y' });
});

test('uninstall refuses to run as the daemon\'s own agent: nothing would start it again', { skip: process.platform !== 'darwin' }, async () => {
  const before = process.env.ANGELIA_SESSION_KEY;
  process.env.ANGELIA_SESSION_KEY = 'whatsapp:1@g.us';
  try { await assert.rejects(() => serviceCommand(['uninstall']), /agent of whatsapp:1@g\.us/); }
  finally { if (before === undefined) delete process.env.ANGELIA_SESSION_KEY; else process.env.ANGELIA_SESSION_KEY = before; }
});

test('entry: a daemon whose own file moved away under it still restarts through the angelia link', () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-entry-'));
  const real = join(dir, 'cli.js');
  writeFileSync(real, '');
  const link = join(dir, 'angelia');
  symlinkSync(real, link);
  assert.equal(entry(real, link), link, 'the link, when it points at this very file');
  assert.equal(entry(join(dir, 'gone', 'cli.js'), link), link, 'the link, when this file no longer exists');
  const other = join(dir, 'other.js');
  writeFileSync(other, '');
  assert.equal(entry(other, link), other, 'this file, when it exists and the link points elsewhere');
  assert.equal(entry(other, undefined), other);
});

const { linger, systemd, systemdLoaded, systemdAvailable } = await import('../src/daemon/systemd.js');

test('linger: already on says nothing; turned on says nothing; refused gives the sudo line', () => {
  const run = (enable: number) => (cmd: string, args: string[]) =>
    args[0] === 'show-user' ? { code: 0, out: enable < 0 ? 'Linger=yes' : 'Linger=no' } : { code: enable, out: `${cmd} ${args.join(' ')}` };
  assert.equal(linger('u', run(-1)), undefined);
  assert.equal(linger('u', run(0)), undefined);
  assert.equal(linger('u', run(1)), 'Run sudo loginctl enable-linger u once, or the daemon stops when you log out.');
});

test('systemdLoaded means running: is-active, not is-enabled', () => {
  const asked: string[][] = [];
  assert.equal(systemdLoaded((a) => { asked.push(a); return { code: 0, out: '' }; }), true);
  assert.equal(systemdLoaded(() => ({ code: 3, out: 'inactive' })), false);
  assert.deepEqual(asked[0][0], 'is-active');
});

test('startedByService: only the process systemd itself started', () => {
  const was = { p: process.env.SYSTEMD_EXEC_PID, i: process.env.INVOCATION_ID };
  try {
    process.env.SYSTEMD_EXEC_PID = String(process.pid);
    assert.equal(systemd.startedByService(), true);
    process.env.SYSTEMD_EXEC_PID = String(process.pid + 1); process.env.INVOCATION_ID = 'x';
    assert.equal(systemd.startedByService(), false);
  } finally {
    for (const [k, v] of [['SYSTEMD_EXEC_PID', was.p], ['INVOCATION_ID', was.i]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('service install without a systemd user session says how to run it instead', { skip: process.platform !== 'linux' || systemdAvailable() }, async () => {
  await assert.rejects(serviceCommand(['install']), /needs systemd --user.*angelia daemon/);
});
