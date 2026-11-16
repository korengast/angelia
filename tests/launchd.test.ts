import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'angelia-svc-'));
process.env.ANGELIA_STATE_DIR = dir;
const { buildPlist, LABEL, launchd, launchdStart, launchdStop, plistConfig, plistStateDir } = await import('../src/daemon/launchd.js');
const { otherInstance, tableMismatch } = await import('../src/daemon/service.js');

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

test('a restart that names the plist\'s own table goes through; another table is refused', () => {
  // /restart from a chat always passes the table the daemon runs. Refusing that one left the
  // hand-started daemon in place on 2026-09-21 instead of moving it onto the service.
  const p = buildPlist({ node: '/n', entry: '/e', config: '/Users/example/.angelia/routing.yaml', stateDir: dir, path: '/usr/bin', home: '/Users/example' });
  assert.equal(plistConfig(p), '/Users/example/.angelia/routing.yaml');
  assert.equal(tableMismatch(undefined, launchd.read(p)), undefined);
  assert.equal(tableMismatch('/Users/example/.angelia/routing.yaml', launchd.read(p)), undefined);
  assert.match(tableMismatch('/Users/example/other.yaml', launchd.read(p)) ?? '', /runs \/Users\/example\/\.angelia\/routing\.yaml, not \/Users\/example\/other\.yaml/);
  // The daemon names the table it was started with; after the plist was rewritten for a moved table
  // that is the old path, and refusing it would leave the old table running for good.
  assert.equal(tableMismatch('/Users/example/other.yaml', launchd.read(p), true), undefined);
});

test('a plist belongs to the instance whose state folder it names', () => {
  const p = buildPlist({ node: '/n', entry: '/e', config: '/c', stateDir: '/Users/example/.angelia', path: '/usr/bin', home: '/Users/example' });
  assert.equal(plistStateDir(p), '/Users/example/.angelia');
  assert.equal(plistStateDir(buildPlist({ node: '/n', entry: '/e', config: '/c', stateDir: '/tmp/a<b>&c', path: '/usr/bin', home: '/h' })), '/tmp/a<b>&c');
  // install and uninstall refuse a plist another instance wrote: one label serves the whole user.
  const file = join(mkdtempSync(join(tmpdir(), 'angelia-plist-')), 'x.plist');
  writeFileSync(file, p);
  assert.equal(otherInstance('/Users/example/.angelia', launchd, file), undefined);
  assert.match(otherInstance('/tmp/test-instance', launchd, file) ?? '', /runs the instance in \/Users\/example\/\.angelia, not this one.*--force/);
  assert.equal(otherInstance('/tmp/test-instance', launchd, join(tmpdir(), 'no-such.plist')), undefined, 'no plist, nothing to protect');
});

test('service restart: stop waits until launchd has dropped the job, start kickstarts what bootstrap leaves pended', () => {
  // A fake launchd: the job stays listed for two prints after bootout, as a daemon still shutting down does.
  const calls: string[] = [];
  let loaded = true, lingering = 0;
  const run = (args: string[]): { code: number; out: string } => {
    calls.push(args[0]);
    if (args[0] === 'print') { if (!loaded && lingering) { lingering--; return { code: 0, out: '' }; } return { code: loaded ? 0 : 113, out: '' }; }
    if (args[0] === 'bootout') { loaded = false; lingering = 2; }
    if (args[0] === 'bootstrap') { if (lingering) return { code: 5, out: 'Bootstrap failed: 5: Input/output error' }; loaded = true; }
    return { code: 0, out: '' };
  };
  launchdStop(run, () => {});
  assert.equal(lingering, 0, 'launchdStop returned while the job was still listed');
  launchdStart('/no/home', run);
  assert.deepEqual(calls.slice(-2), ['bootstrap', 'kickstart']);
  assert.ok(loaded);
});

test('service stop: a job launchd never drops fails loudly instead of a start that cannot work', () => {
  let sleeps = 0;
  const run = (args: string[]): { code: number; out: string } => ({ code: 0, out: args[0] === 'print' ? 'state = running' : '' });
  assert.throws(() => launchdStop(run, () => { sleeps++; }), /still holds .* after bootout/);
  assert.equal(sleeps * 250, 25_000, 'waits past launchd\'s 20 s ExitTimeOut');
});

test('service start: a failed kickstart is an error, with launchctl\'s own words', () => {
  const run = (args: string[]): { code: number; out: string } => (args[0] === 'kickstart' ? { code: 113, out: 'Could not find service' } : { code: 0, out: '' });
  assert.throws(() => launchdStart('/no/home', run), /kickstart failed: Could not find service/);
});
