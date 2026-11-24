import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> };

/** The flags of each `node --test` run in `npm test`, file globs left out. */
function runs(): string[][] {
  return pkg.scripts.test.split('&&').map((s) => s.trim().split(/\s+/)).filter((w) => w[0] === 'node' && w.includes('--test'))
    .map((w) => w.slice(1).filter((x, i, a) => x.startsWith('--') || a[i - 1] === '--import'));
}
// The runner run here must not report into this one (it would if it saw NODE_TEST_CONTEXT).
const env = (extra: NodeJS.ProcessEnv) => { const e = { ...process.env, ...extra }; delete e.NODE_TEST_CONTEXT; return e; };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('npm test: every node --test run exits once its files end, though a test left a child running', () => {
  // 2026-11-21: a test of agy-gate failed before its stop(); fake agy kept the file's process open,
  // and the full run waited 8 hours. --test-timeout is per test and cannot end a file whose tests are done.
  const all = runs();
  assert.equal(all.length, 2, 'the fast run and the slow run');
  for (const flags of all) {
    assert.ok(flags.includes('--test-force-exit'), `--test-force-exit in: node ${flags.join(' ')}`);
    const pidFile = join(mkdtempSync(join(tmpdir(), 'angelia-runner-exit-')), 'pid');
    const r = spawnSync(process.execPath, [...flags, join(here, 'fixtures', 'leaky-child.mjs')], { encoding: 'utf8', timeout: 15_000, env: env({ LEAK_PID_FILE: pidFile }) });
    const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0;
    assert.ok(pid > 0, `the fixture ran: ${r.stdout}${r.stderr}`);
    try {
      assert.equal((r.error as NodeJS.ErrnoException | undefined)?.code, undefined, `node ${flags.join(' ')} did not end by itself within 15 s`);
      assert.equal(r.status, 0, r.stdout + r.stderr);
    } finally { if (alive(pid)) process.kill(pid, 'SIGKILL'); }
  }
});
