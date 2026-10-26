import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { NODE_FIX, nodeAdvice, nodeFixProblem, nodeHasFix, versionedNode } from '../src/daemon/node-fix.js';
import { updateCommand } from '../src/daemon/update.js';
import { nodeLine, nodeStart } from '../src/daemon/daemon.js';
import { ACCEPT, REFUSE } from './node-versions.js';

const root = join(import.meta.dirname, '..');
const preload = join(import.meta.dirname, 'fake-node-version.cjs');

const fake = (version: string) => ({ ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, FAKE_NODE_VERSION: version });
/** Runs a script under `node` with process.versions.node set to `version`; true when it exits 0. */
const underNode = (version: string, script: string) => spawnSync(process.execPath, ['-e', script], { env: fake(version), encoding: 'utf8' }).status === 0;
/** `angelia <args>` from the source, on an instance of its own, with process.versions.node set to `version`
 *  and argv[0] set to `argv0` (launchd passes the plist's node path there). */
const cli = (state: string, version: string, args: string[], argv0 = '/opt/node/bin/node') => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src', 'cli', 'cli.ts'), ...args], { encoding: 'utf8', argv0, env: { ...fake(version), ANGELIA_STATE_DIR: state } });
  return `${r.stdout}${r.stderr}`;
};
const nvm = '/Users/someone/.nvm/versions/node/v23.9.0/bin/node';

test('nodeHasFix takes the fixed lines at or past their fix, and nothing else', () => {
  for (const v of ACCEPT) assert.equal(nodeHasFix(v), true, v);
  for (const v of REFUSE) assert.equal(nodeHasFix(v), false, JSON.stringify(v));
  assert.equal(nodeFixProblem('26.12.1'), undefined);
  assert.match(nodeFixProblem('25.1.0')!, /^Node 25\.1\.0 is open to CVE-2026-111497/);
  assert.ok(nodeFixProblem('24.22.0')!.includes(NODE_FIX), 'names the three minimums');
  assert.match(nodeFixProblem('25.1.0', '/opt/node/bin/node')!, /^Node 25\.1\.0 at \/opt\/node\/bin\/node is open/);
});

test('a node path tied to one version is told to write the plist again, any other to restart', () => {
  const tied = [nvm, '/opt/homebrew/Cellar/node/24.1.0/bin/node', '/usr/local/Cellar/node@22/22.20.0/bin/node', '/Users/someone/.local/share/fnm/node-versions/v24.1.0/installation/bin/node',
    '/Users/someone/.local/state/fnm_multishells/123_456/bin/node', '/Users/someone/.asdf/installs/nodejs/24.1.0/bin/node', '/usr/local/lib/node-v24.1.0-darwin-arm64/bin/node'];
  const loose = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/opt/homebrew/opt/node@22/bin/node', '/Users/someone/.volta/bin/node'];
  for (const p of tied) assert.equal(versionedNode(p), true, p);
  for (const p of loose) assert.equal(versionedNode(p), false, p);
  assert.equal(nodeAdvice(nvm), `install a fixed Node, then angelia service install <routing.yaml> so the service starts it (${nvm} stays on this version)`);
  assert.equal(nodeAdvice('/opt/homebrew/bin/node'), 'install a fixed Node, then angelia restart');
  assert.equal(nodeAdvice(undefined), 'install a fixed Node, then angelia restart');
  // launchd's argv[0] is the plist's path; a bare `node` from a shell gives the path service install would write.
  assert.equal(nodeStart('/opt/homebrew/bin/node'), '/opt/homebrew/bin/node');
  assert.ok(isAbsolute(nodeStart('node')));
});

test('install.sh and nodeHasFix give the same answer for every version', () => {
  const sh = readFileSync(join(root, 'install.sh'), 'utf8');
  const expr = /^node -e '([^']*process\.versions\.node[^']*)'/m.exec(sh)?.[1];
  assert.ok(expr, 'install.sh checks the version with node -e');
  assert.equal(underNode('9.9.9', 'process.exit(process.versions.node === "9.9.9" ? 0 : 1)'), true, 'the preload takes');
  for (const v of [...ACCEPT, ...REFUSE]) assert.equal(underNode(v, expr), nodeHasFix(v), JSON.stringify(v));
  assert.ok(sh.includes(`die "${NODE_FIX} is required (CVE-2026-111497)`), 'and names the same versions');
});

test('update warns about a Node without the fix and goes on, --check too', async () => {
  const real = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
  Object.defineProperty(process.versions, 'node', { ...real, value: '24.22.0' });
  const said: string[] = [], log = console.log;
  console.log = (...a: unknown[]) => { said.push(a.join(' ')); };
  try {
    for (const argv of [[], ['--check']]) {
      said.length = 0;
      // Past the warning, this checkout is refused for its own reason: nothing is fetched either way.
      await assert.rejects(updateCommand(argv), /runs from a checkout/, argv.join(' '));
      assert.ok(said.some((l) => l.startsWith('Warning: Node 24.22.0 is open to CVE-2026-111497') && l.includes(NODE_FIX) && l.includes('Updating anyway')), `${argv.join(' ')}: ${said.join('|')}`);
    }
  } finally {
    console.log = log;
    Object.defineProperty(process.versions, 'node', real);
  }
});

test('the daemon logs a warning on a Node without the fix, and goes on starting', () => {
  const state = mkdtempSync(join(tmpdir(), 'angelia-nodefix-'));
  // A table that does not exist ends the start right after the check: nothing else runs, no socket, no tmux.
  assert.match(cli(state, '23.9.0', ['daemon', join(state, 'none.yaml')]), /cannot read .*none\.yaml/, 'it got past the check');
  const at = process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(readFileSync(join(state, 'daemon.log'), 'utf8'), new RegExp(`WARNING: Node 23\\.9\\.0 at ${at} is open to CVE-2026-111497.*: install a fixed Node, then angelia restart\\.$`, 'm'), 'names the binary it runs on');
  // Started by launchd from a plist that names nvm's folder: a new Node never lands there.
  const tied = mkdtempSync(join(tmpdir(), 'angelia-nodefix-'));
  cli(tied, '23.9.0', ['daemon', join(tied, 'none.yaml')], nvm);
  assert.ok(readFileSync(join(tied, 'daemon.log'), 'utf8').includes(`then angelia service install <routing.yaml> so the service starts it (${nvm} stays on this version).`));
});

test('status names the daemon\'s Node from status.json, not the one status runs on', () => {
  assert.equal(nodeLine({ node: '24.22.1', nodePath: '/opt/node/bin/node' }), 'node 24.22.1 at /opt/node/bin/node (has the CVE-2026-111497 fix)');
  assert.match(nodeLine({ node: '25.1.0', nodePath: nvm.replace('23.9.0', '25.1.0'), nodeStart: '/usr/local/bin/node' }), /; install a fixed Node, then angelia restart$/, 'judged by the path it was started as');
  assert.match(nodeLine({ node: '25.1.0', nodePath: '/x/node', nodeStart: nvm }), /then angelia service install <routing\.yaml>/);
  const state = mkdtempSync(join(tmpdir(), 'angelia-nodefix-'));
  const status = { pid: 0, at: 'now', tg: 'off', wa: 'off', sessions: [] };
  writeFileSync(join(state, 'status.json'), JSON.stringify({ ...status, node: '25.1.0', nodePath: '/opt/node/bin/node', nodeStart: '/opt/node/bin/node' }));
  assert.match(cli(state, '26.12.1', ['status']), /^warning: Node 25\.1\.0 at \/opt\/node\/bin\/node is open to CVE-2026-111497.*angelia restart$/m);
  // A daemon from before this version wrote no Node at all.
  writeFileSync(join(state, 'status.json'), JSON.stringify(status));
  assert.match(cli(state, '26.12.1', ['status']), /^daemon's Node unknown \(started before this version\); angelia restart records it$/m);
});

test('check-config warns about the Node it runs on', () => {
  const state = mkdtempSync(join(tmpdir(), 'angelia-nodefix-'));
  const table = join(state, 'routing.yaml');
  writeFileSync(table, `profiles:\n  home: {cwd: ${state}}\nroutes: []\n`);
  assert.match(cli(state, '22.23.3', ['check-config', table]), /^warning: Node 22\.23\.3 at .* is open to CVE-2026-111497/m);
});
