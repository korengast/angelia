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
