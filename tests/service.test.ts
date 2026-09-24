import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'angelia-svc-'));
process.env.ANGELIA_STATE_DIR = dir;
const { buildPlist, entry, servicePath, LABEL, serviceCommand, plistConfig, tableMismatch, plistStateDir, otherInstance } = await import('../src/daemon/service.js');
const { envFile } = await import('../src/daemon/daemon.js');

test('plist: runs the daemon on the given table, carries PATH, never a secret, and is valid XML', () => {
  const p = buildPlist({ node: '/usr/local/bin/node', entry: '/lib/angelia/dist/cli.js', config: '/a&b/routing.yaml', stateDir: dir, path: '/Users/example/.local/bin:/usr/bin', home: '/Users/example', lang: 'en_US.UTF-8' });
  assert.match(p, new RegExp(`<key>Label</key><string>${LABEL}</string>`));
  assert.match(p, /<string>\/usr\/local\/bin\/node<\/string>\n {4}<string>\/lib\/angelia\/dist\/cli\.js<\/string>\n {4}<string>daemon<\/string>\n {4}<string>\/a&amp;b\/routing\.yaml<\/string>/);
  assert.match(p, /<key>PATH<\/key><string>\/Users\/example\/\.local\/bin:\/usr\/bin<\/string>/);
  assert.match(p, /<key>SuccessfulExit<\/key><false\/>/);
  assert.doesNotMatch(p, /TOKEN/);
  if (process.platform === 'darwin') {
    const f = join(dir, 't.plist'); writeFileSync(f, p);
    execFileSync('plutil', ['-lint', f]);
  }
});

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

test('a restart that names the plist\'s own table goes through; another table is refused', () => {
  // /restart from a chat always passes the table the daemon runs. Refusing that one left the
  // hand-started daemon in place on 2026-09-21 instead of moving it onto the service.
  const p = buildPlist({ node: '/n', entry: '/e', config: '/Users/example/.angelia/routing.yaml', stateDir: dir, path: '/usr/bin', home: '/Users/example' });
  assert.equal(plistConfig(p), '/Users/example/.angelia/routing.yaml');
  assert.equal(tableMismatch(undefined, p), undefined);
  assert.equal(tableMismatch('/Users/example/.angelia/routing.yaml', p), undefined);
  assert.match(tableMismatch('/Users/example/other.yaml', p) ?? '', /runs \/Users\/example\/\.angelia\/routing\.yaml, not \/Users\/example\/other\.yaml/);
  // The daemon names the table it was started with; after the plist was rewritten for a moved table
  // that is the old path, and refusing it would leave the old table running for good.
  assert.equal(tableMismatch('/Users/example/other.yaml', p, true), undefined);
});

test('a plist belongs to the instance whose state folder it names', () => {
  const p = buildPlist({ node: '/n', entry: '/e', config: '/c', stateDir: '/Users/example/.angelia', path: '/usr/bin', home: '/Users/example' });
  assert.equal(plistStateDir(p), '/Users/example/.angelia');
  assert.equal(plistStateDir(buildPlist({ node: '/n', entry: '/e', config: '/c', stateDir: '/tmp/a<b>&c', path: '/usr/bin', home: '/h' })), '/tmp/a<b>&c');
  // install and uninstall refuse a plist another instance wrote: one label serves the whole user.
  const file = join(mkdtempSync(join(tmpdir(), 'angelia-plist-')), 'x.plist');
  writeFileSync(file, p);
  assert.equal(otherInstance('/Users/example/.angelia', file), undefined);
  assert.match(otherInstance('/tmp/test-instance', file) ?? '', /runs the instance in \/Users\/example\/\.angelia, not this one.*--force/);
  assert.equal(otherInstance('/tmp/test-instance', join(tmpdir(), 'no-such.plist')), undefined, 'no plist, nothing to protect');
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
