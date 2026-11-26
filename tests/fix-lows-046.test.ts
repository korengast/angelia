import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearMcpListFiles, mcpListRoot, tuiBlockedConnectors } from '../src/brain/connectors-check.js';

// 0.4.6 fix-lows: the connectors check's settings file goes under <state>/compiled/ (closed to every
// profile by the deny floor), never the temp folder; and what a killed daemon left is removed at start.

const GMAIL = 'https://gmailmcp.googleapis.com/*';
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

test('the mcp list settings file is under <state>/compiled/mcp-list, 0600, and gone after the check', async () => {
  const dir = tmp('angelia-fl046-'), state = join(dir, 'state'), seen = join(dir, 'seen');
  writeFileSync(seen, '');
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === '--settings') fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ file: a[1], mode: fs.statSync(a[1]).mode & 0o777, dir: fs.statSync(require('path').dirname(require('path').dirname(a[1]))).mode & 0o777, urls: fs.readFileSync(a[1], 'utf8').includes('googleapis') }) + '\\n');
const urls = a[0] === '--settings' && fs.readFileSync(a[1], 'utf8').includes('serverUrl');
process.stdout.write(['claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected', 'claude.ai Drive: https://drive.example.com/mcp - ✔ Connected'].filter((l) => !urls || !l.startsWith('claude.ai Gmail')).join('\\n') + '\\n');
`, { mode: 0o755 });
  const settings = { deniedMcpServers: [{ serverUrl: GMAIL }], disabledMcpjsonServers: ['own'] };
  assert.deepEqual(await tuiBlockedConnectors(bin, dir, process.env, settings, state), ['claude.ai Gmail']);
  const runs = readFileSync(seen, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { file: string; mode: number; dir: number; urls: boolean });
  assert.equal(runs.length, 2, 'both runs got a settings file');
  for (const r of runs) {
    assert.ok(r.file.startsWith(join(state, 'compiled', 'mcp-list') + '/'), r.file);
    assert.equal(r.mode, 0o600);
    assert.equal(r.dir, 0o700, 'the mcp-list folder is 0700');
  }
  assert.ok(runs.some((r) => r.urls), 'the run with the denies had the addresses in its file');
  assert.deepEqual(readdirSync(mcpListRoot(state)), [], 'each run removes its file');
});

test('clearMcpListFiles removes what a killed daemon left, and is fine when there is nothing', () => {
  const state = tmp('angelia-fl046-clear-');
  clearMcpListFiles(state);
  const left = join(mcpListRoot(state), 'run-abc');
  mkdirSync(left, { recursive: true });
  writeFileSync(join(left, 'settings.json'), JSON.stringify({ deniedMcpServers: [{ serverUrl: GMAIL }] }));
  clearMcpListFiles(state);
  assert.equal(existsSync(mcpListRoot(state)), false);
  assert.ok(existsSync(state), 'only the mcp-list folder goes');
});

test('the daemon clears the leftovers at start, before any pane starts', () => {
  const src = readFileSync(new URL('../src/daemon/daemon.ts', import.meta.url), 'utf8');
  const clear = src.indexOf('clearMcpListFiles(STATE_DIR)'), orch = src.indexOf('new Orchestrator(');
  assert.ok(clear > 0 && clear < orch, 'cleared before the orchestrator is made');
});
