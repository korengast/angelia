import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpListEnv, plainSettings, tuiBlockedConnectors } from '../src/brain/connectors-check.js';

// fix3: the plain `claude mcp list` run keeps the launch's denies by name and its .mcp.json out (High),
// both runs get a minimal environment (High), a list with the denies that loaded no connector list
// cannot pass the check (Medium), and the checks run one profile at a time.

const GMAIL = 'https://gmailmcp.googleapis.com/*';
const LIST = ['claude.ai Notes: https://notes.example.com/mcp - ✔ Connected', 'claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected', 'claude.ai Drive: https://drive.example.com/mcp - ✔ Connected', 'github: npx server-github - ✔ Connected'];

/** A fake `claude mcp list`: each run appends {args, env, start, end} to `runs`. A run whose settings
 *  deny a serverUrl leaves out BLOCKED (KEPT_NONE: every connector). It takes DELAY ms. */
function fake(dir: string, o: { blocked?: string[]; keptNone?: boolean; delay?: number } = {}): { bin: string; runs: () => { args: string[]; settings: any; env: Record<string, string>; start: number; end: number }[] } {
  const id = Math.random().toString(36).slice(2), bin = join(dir, `claude-${id}`), runs = join(dir, `runs-${id}`);
  writeFileSync(runs, '');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2), start = Date.now();
const s = a[0] === '--settings' ? JSON.parse(fs.readFileSync(a[1], 'utf8')) : {};
const urls = (s.deniedMcpServers || []).some((e) => e.serverUrl);
setTimeout(() => {
  let lines = ${JSON.stringify(LIST)};
  if (urls) lines = ${!!o.keptNone} ? lines.filter((l) => !l.startsWith('claude.ai ')) : lines.filter((l) => !${JSON.stringify(o.blocked ?? [])}.some((b) => l.startsWith(b + ':')));
  fs.appendFileSync(${JSON.stringify(runs)}, JSON.stringify({ args: a, settings: s, env: process.env, start, end: Date.now() }) + '\\n');
  process.stdout.write('Checking MCP server health…\\n\\n' + lines.join('\\n') + '\\n');
}, ${o.delay ?? 0});
`, { mode: 0o755 });
  return { bin, runs: () => readFileSync(runs, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'angelia-fix3-')));

test('plainSettings: the launch keys less the serverUrl denies; nothing left is no --settings', () => {
  const strict = { deniedMcpServers: [{ serverName: 'local-tool' }, { serverUrl: GMAIL }], disabledMcpjsonServers: ['own'] };
  assert.deepEqual(plainSettings(strict), { deniedMcpServers: [{ serverName: 'local-tool' }], disabledMcpjsonServers: ['own'] });
  assert.deepEqual(plainSettings({ deniedMcpServers: [{ serverUrl: GMAIL }], disabledMcpjsonServers: ['own'] }), { disabledMcpjsonServers: ['own'] });
  assert.equal(plainSettings({ deniedMcpServers: [{ serverUrl: GMAIL }] }), undefined);
  assert.deepEqual(strict.deniedMcpServers.length, 2, 'the launch keys are not changed');
});

test('both runs keep the denied servers by name and the .mcp.json out, and get no secret, session key or API token', async () => {
  const dir = tmp(), f = fake(dir, { blocked: ['claude.ai Gmail'] });
  const settings = { deniedMcpServers: [{ serverName: 'local-tool' }, { serverUrl: GMAIL }], disabledMcpjsonServers: ['own'] };
  const env = { HOME: '/Users/example', PATH: process.env.PATH, CLAUDE_CONFIG_DIR: '/cfg', GITHUB_TOKEN: 'granted', ANGELIA_SESSION_KEY: 'key', ANGELIA_API_TOKEN: 'tok', ANTHROPIC_API_KEY: 'k' };
  assert.deepEqual(await tuiBlockedConnectors(f.bin, dir, env, settings), ['claude.ai Gmail']);
  const runs = f.runs();
  assert.equal(runs.length, 2);
  for (const r of runs) {
    assert.equal(r.args[0], '--settings');
    assert.ok(!r.args.join(' ').includes('googleapis'), 'no address on the command line');
    const s = r.settings;
    assert.ok(s.deniedMcpServers.some((e: { serverName?: string }) => e.serverName === 'local-tool'), JSON.stringify(s));
    assert.deepEqual(s.disabledMcpjsonServers, ['own']);
    for (const k of ['GITHUB_TOKEN', 'ANGELIA_SESSION_KEY', 'ANGELIA_API_TOKEN', 'ANTHROPIC_API_KEY']) assert.equal(r.env[k], undefined, k);
    assert.equal(r.env.HOME, '/Users/example');
    assert.equal(r.env.CLAUDE_CONFIG_DIR, '/cfg');
    assert.equal(r.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  }
  assert.equal(runs.filter((r) => r.settings.deniedMcpServers.some((e: { serverUrl?: string }) => e.serverUrl)).length, 1, 'one run with the connector denies, one without');
  assert.deepEqual(Object.keys(mcpListEnv({ FOO: 'x', PATH: '/bin' })), ['PATH']);
});

test('the list with the denies names no connector while the plain one names more than are denied: it cannot tell', async () => {
  const dir = tmp();
  assert.equal(await tuiBlockedConnectors(fake(dir, { keptNone: true }).bin, dir, process.env, { deniedMcpServers: [{ serverUrl: GMAIL }] }), null);
  // Three denied, three listed, none kept: they may all be blocked, which is what was asked.
  const three = { deniedMcpServers: ['https://a/*', 'https://b/*', 'https://c/*'].map((serverUrl) => ({ serverUrl })) };
  assert.deepEqual(await tuiBlockedConnectors(fake(dir, { keptNone: true }).bin, dir, process.env, three), ['claude.ai Notes', 'claude.ai Gmail', 'claude.ai Drive']);
});

test('the checks run one profile at a time: never more than two lists at once', async () => {
  const dir = tmp(), f = fake(dir, { blocked: ['claude.ai Gmail'], delay: 300 });
  const settings = { deniedMcpServers: [{ serverUrl: GMAIL }] };
  const got = await Promise.all([1, 2, 3].map(() => tuiBlockedConnectors(f.bin, dir, process.env, settings)));
  assert.deepEqual(got, [['claude.ai Gmail'], ['claude.ai Gmail'], ['claude.ai Gmail']]);
  const runs = f.runs();
  assert.equal(runs.length, 6);
  const most = Math.max(...runs.map((r) => runs.filter((q) => q.start < r.end && r.start < q.end).length));
  assert.ok(most <= 2, `${most} runs at once`);
  // A failed check does not stop the next one.
  const bad = join(dir, 'bad');
  writeFileSync(bad, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const [x, y] = await Promise.all([tuiBlockedConnectors(bad, dir, process.env, settings), tuiBlockedConnectors(f.bin, dir, process.env, settings)]);
  assert.equal(x, null);
  assert.deepEqual(y, ['claude.ai Gmail']);
});
