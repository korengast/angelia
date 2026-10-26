import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { NODE_FIX, nodeFixProblem, nodeHasFix } from '../src/daemon/node-fix.js';
import { updateCommand } from '../src/daemon/update.js';
import { ACCEPT, REFUSE } from './node-versions.js';

const root = join(import.meta.dirname, '..');
const preload = join(import.meta.dirname, 'fake-node-version.cjs');

/** Runs a script under `node` with process.versions.node set to `version`; true when it exits 0. */
const underNode = (version: string, script: string) =>
  spawnSync(process.execPath, ['-e', script], { env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, FAKE_NODE_VERSION: version }, encoding: 'utf8' }).status === 0;

test('nodeHasFix takes the fixed lines at or past their fix, and nothing else', () => {
  for (const v of ACCEPT) assert.equal(nodeHasFix(v), true, v);
  for (const v of REFUSE) assert.equal(nodeHasFix(v), false, JSON.stringify(v));
  assert.equal(nodeFixProblem('26.12.1'), undefined);
  assert.match(nodeFixProblem('25.1.0')!, /^Node 25\.1\.0 is open to CVE-2026-111497/);
  assert.ok(nodeFixProblem('24.22.0')!.includes(NODE_FIX), 'names the three minimums');
});

test('install.sh and nodeHasFix give the same answer for every version', () => {
  const sh = readFileSync(join(root, 'install.sh'), 'utf8');
  const expr = /^node -e '([^']*process\.versions\.node[^']*)'/m.exec(sh)?.[1];
  assert.ok(expr, 'install.sh checks the version with node -e');
  assert.equal(underNode('9.9.9', 'process.exit(process.versions.node === "9.9.9" ? 0 : 1)'), true, 'the preload takes');
  for (const v of [...ACCEPT, ...REFUSE]) assert.equal(underNode(v, expr), nodeHasFix(v), JSON.stringify(v));
  assert.ok(sh.includes(`die "${NODE_FIX} is required (CVE-2026-111497)`), 'and names the same versions');
});

test('update refuses a Node without the fix unless --force', async () => {
  const real = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
  Object.defineProperty(process.versions, 'node', { ...real, value: '24.22.0' });
  try {
    await assert.rejects(updateCommand([]), (e: Error) => e.message.startsWith('Node 24.22.0 is open to CVE-2026-111497') && e.message.includes(NODE_FIX) && /Nothing was installed/.test(e.message));
    await assert.rejects(updateCommand(['--check']), /CVE-2026-111497/, '--check too');
    // Past the check, this checkout is refused for its own reason: nothing is fetched either way.
    await assert.rejects(updateCommand(['--force']), /runs from a checkout/);
  } finally {
    Object.defineProperty(process.versions, 'node', real);
  }
});
