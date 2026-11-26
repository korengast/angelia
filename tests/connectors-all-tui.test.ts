import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listedConnectors, tuiBlockedConnectors } from '../src/brain/connectors-check.js';
import { TuiBrain } from '../src/brain/tui.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { Config } from '../src/instance/config/schema.js';

// Recheck 1, Medium: a tmux profile in `connectors: all` had no start check (a pane has no stderr).
// Measured on Claude Code 2.1.332: the pane shows no "blocked by enterprise policy" line, and
// `claude --settings <deny> mcp list` names no blocked connector but leaves it out of the list. So the
// check diffs two lists, with the deny list and without it.

const GMAIL = 'https://gmailmcp.googleapis.com/*';
const DRIVE = 'https://drivemcp.googleapis.com/*';

/** `claude mcp list` as 2.1.332 prints it (the shape measured, other names). */
const LIST = `Checking MCP server health…

claude.ai Notes: https://notes.example.com/mcp - ✔ Connected
claude.ai Health: Data (HD): https://hd.example.com/mcp - ✔ Connected
claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✗ Failed to connect
github: npx @modelcontextprotocol/server-github - ✔ Connected
`;

test('listedConnectors reads the claude.ai lines of claude mcp list, a colon in a name included', () => {
  assert.deepEqual(listedConnectors(LIST), ['claude.ai Notes', 'claude.ai Health: Data (HD)', 'claude.ai Gmail', 'claude.ai Google Drive']);
  assert.deepEqual(listedConnectors('Checking MCP server health…\n\nNo MCP servers configured.\n'), []);
});

/** A fake `claude`: `mcp list` prints LIST, less the connectors in BLOCKED when --settings is given;
 *  each run appends its argv to `runs`. FAIL makes it exit 1. */
function fakeClaude(dir: string, blocked: string[], fail = false): { bin: string; runs: string } {
  const bin = join(dir, `claude-${Math.random().toString(36).slice(2)}`), runs = join(dir, `runs-${Math.random().toString(36).slice(2)}`);
  writeFileSync(runs, '');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
// The settings file's content in place of its path: what the run was given. The path on its own goes to .raw.
fs.appendFileSync(${JSON.stringify(runs)}, JSON.stringify(a[0] === '--settings' ? ['--settings', fs.readFileSync(a[1], 'utf8'), ...a.slice(2)] : a) + '\\n');
fs.appendFileSync(${JSON.stringify(runs)} + '.raw', JSON.stringify(a) + '\\n');
if (${fail}) process.exit(1);
if (a.slice(-2).join(' ') !== 'mcp list') process.exit(2);
const blocked = a[0] === '--settings' ? ${JSON.stringify(blocked)} : [];
process.stdout.write(${JSON.stringify(LIST)}.split('\\n').filter((l) => !blocked.some((b) => l.startsWith(b + ':'))).join('\\n'));
`, { mode: 0o755 });
  return { bin, runs };
}
const runCount = (f: string) => readFileSync(f, 'utf8').split('\n').filter(Boolean).length;

test('tuiBlockedConnectors: the connectors only the plain list names; null when a list failed or named none', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'angelia-mcplist-')));
  const deny = { deniedMcpServers: [{ serverUrl: GMAIL }] };
  const one = fakeClaude(dir, ['claude.ai Gmail']);
  assert.deepEqual(await tuiBlockedConnectors(one.bin, dir, process.env, deny, dir), ['claude.ai Gmail']);
  const args = readFileSync(one.runs, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
  assert.deepEqual(args.find((a) => a[0] === '--settings'), ['--settings', JSON.stringify(deny), 'mcp', 'list'], 'the launch MCP keys, by a file, before the subcommand');
  assert.ok(!readFileSync(`${one.runs}.raw`, 'utf8').includes('googleapis'), 'no address on the command line');
  assert.ok(args.some((a) => a.join(' ') === 'mcp list'), 'and once without them');
  assert.equal(await tuiBlockedConnectors(fakeClaude(dir, [], true).bin, dir, process.env, deny, dir), null);
  const empty = join(dir, 'empty');
  writeFileSync(empty, '#!/bin/sh\necho "No MCP servers configured."\n', { mode: 0o755 });
  assert.equal(await tuiBlockedConnectors(empty, dir, process.env, deny, dir), null, 'no connector listed at all: it cannot tell');
});

test('tmux mode: a start that blocks fewer connectors than it drops warns with the names; a good one is checked once per daemon', { timeout: 30_000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'angelia-tui-connall-')));
  for (const d of 'abcde') mkdirSync(join(dir, d));
  const pane = (cwd: string, bin: string, denied: string[]) => {
    const profile = Config.parse({ profiles: { x: { cwd, tui: true } }, routes: [] }).profiles.x;
    const b = new TuiBrain(profile, { id: '11111111-2222-3333-4444-555555555555', started: false }, { bin, stateDir: join(dir, 'state'), mcp: { args: [], settings: { deniedMcpServers: denied.map((serverUrl) => ({ serverUrl })) } } });
    const logs: string[] = [], short: { text: string; blocked: string[] }[] = [];
    b.on('log', (l: string) => logs.push(l));
    b.on('connectors-short', (text: string, blocked: string[]) => short.push({ text, blocked }));
    return { b, logs, short };
  };
  // Two dropped, one blocked: said, with the name, never the address; counted again at the next start.
  const miss = fakeClaude(dir, ['claude.ai Gmail']);
  const a = pane(join(dir, 'a'), miss.bin, [GMAIL, DRIVE]);
  await a.b.checkConnectors();
  assert.equal(a.short.length, 1);
  assert.deepEqual(a.short[0].blocked, ['claude.ai Gmail']);
  assert.match(a.short[0].text, /dropped 2 connectors by address, but Claude Code named 1 as blocked \(claude\.ai Gmail\)/);
  assert.ok(!a.short[0].text.includes('googleapis'));
  assert.ok(a.logs.some((l) => l.startsWith('warning: connectors: all: this start dropped 2')), a.logs.join('\n'));
  await pane(join(dir, 'a'), miss.bin, [GMAIL, DRIVE]).b.checkConnectors();
  assert.equal(runCount(miss.runs), 4, 'a short start is counted again at the next pane start');
  // All blocked: nothing said, and the next pane of that profile and deny list runs no list.
  const ok = fakeClaude(dir, ['claude.ai Gmail', 'claude.ai Google Drive']);
  const b = pane(join(dir, 'b'), ok.bin, [GMAIL, DRIVE]);
  await b.b.checkConnectors();
  await pane(join(dir, 'b'), ok.bin, [GMAIL, DRIVE]).b.checkConnectors();
  assert.deepEqual(b.short, []);
  assert.equal(runCount(ok.runs), 2, 'once per daemon start per profile and deny list');
  // A list that failed: a log line, no warning, and the next pane start tries again.
  const bad = fakeClaude(dir, [], true);
  const c = pane(join(dir, 'c'), bad.bin, [GMAIL]);
  await c.b.checkConnectors();
  assert.deepEqual(c.short, []);
  assert.ok(c.logs.some((l) => l.includes('did not tell which connectors are blocked')), c.logs.join('\n'));
  await pane(join(dir, 'c'), bad.bin, [GMAIL]).b.checkConnectors();
  assert.equal(runCount(bad.runs), 4);
  // No connector dropped (granted mode, or all with nothing denied): no list is run.
  const none = fakeClaude(dir, []);
  await pane(join(dir, 'd'), none.bin, []).b.checkConnectors();
  const profile = Config.parse({ profiles: { x: { cwd: join(dir, 'e'), tui: true } }, routes: [] }).profiles.x;
  await new TuiBrain(profile, { id: '11111111-2222-3333-4444-555555555556', started: false }, { bin: none.bin, stateDir: join(dir, 'state'), mcp: { args: [], settings: { allowedMcpServers: [{ serverUrl: GMAIL }], deniedMcpServers: [{ serverUrl: DRIVE }] } } }).checkConnectors();
  assert.equal(runCount(none.runs), 0);
});

test('the owner hears a short start once per profile and blocked names, and the flag is set only after the notice went out', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'angelia-connall-told-')));
  const cfg = Config.parse({ profiles: { a: { cwd: dir } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a', owners: ['1'] }] });
  const o = new Orchestrator(cfg, {} as any, { stateDir: join(dir, 'state') });
  t.after(() => o.shutdown());
  (o as any).map.keys = () => ['telegram:1'];
  const sent: string[] = [];
  let fail = 1;
  (o as any).notify = async (key: string, text: string) => {
    if (fail-- > 0) throw new Error('offline');
    sent.push(`${key} ${text}`);
  };
  const short = (blocked: string[]) => (o as any).connectorsShort('a', `short ${blocked.join(',')}`, blocked);
  const flush = () => new Promise((r) => setTimeout(r, 20));
  short(['claude.ai Gmail']);
  await flush();
  assert.deepEqual(sent, [], 'the first notice failed');
  short(['claude.ai Gmail']);
  short(['claude.ai Gmail']); // while the second is on its way: not sent twice
  await flush();
  assert.equal(sent.length, 1, 'the failed notice is given at the next short start');
  assert.match(sent[0], /^telegram:1 short claude\.ai Gmail\. Check the addresses with: angelia check-config/);
  short(['claude.ai Gmail']);
  await flush();
  assert.equal(sent.length, 1, 'once sent, said once');
  short(['claude.ai Gmail', 'claude.ai Notes']);
  short([]);
  await flush();
  assert.equal(sent.length, 3, 'other blocked names are another notice');
});
