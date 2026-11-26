import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { loadConfig } from '../src/instance/config/load.js';
import { planProfile, RECORD, urlPattern, userInfo } from '../src/capabilities/compile.js';
import { wireChild } from '../src/brain/brain.js';

// 0.4.9, connector and compile safety: the small carried items (0.4.3 final look, connall reviews).

test('urlPattern: no query, fragment or user:key@ is copied; an address with no path gets /*, never host*', () => {
  assert.equal(urlPattern('https://mcp.tavily.com/mcp/?tavilyApiKey=K'), 'https://mcp.tavily.com/mcp/*');
  assert.equal(urlPattern('https://sse.example.com/s#frag'), 'https://sse.example.com/s*');
  assert.equal(urlPattern('https://x.example.com/mcp'), 'https://x.example.com/mcp', 'nothing cut: as it is');
  assert.equal(urlPattern('https://host.example?k=K'), 'https://host.example/*', 'not https://host.example*, which lets in host.example.evil');
  assert.equal(urlPattern('http://localhost:8080#k'), 'http://localhost:8080/*');
  // No `*@`: `*` also matches `/`, so https://*@x.example.com/mcp would let in https://evil.example/a@x.example.com/mcp.
  assert.throws(() => urlPattern('https://user:KEY@x.example.com/mcp'), /user or password/);
  assert.throws(() => urlPattern('https://user@x.example.com/mcp?k=K'), /user or password/);
  assert.equal(urlPattern('https://x.example.com/a@b/mcp'), 'https://x.example.com/a@b/mcp', 'an @ in the path is no user');
  assert.equal(urlPattern('https://x.example.com/mcp?u=a@b'), 'https://x.example.com/mcp*', 'an @ in the query is no user');
  assert.ok(userInfo('https://u:p@h.example/mcp') && userInfo('http://u@h.example') && !userInfo('https://h.example/a@b') && !userInfo('https://h.example?a@b') && !userInfo('https://h.example#a@b'));
});

test('compile: an MCP server address with a user or password is a conflict that names the server, never the password', () => {
  const root = mkdtempSync(join(tmpdir(), 'angelia-userinfo-'));
  const cwd = join(root, 'profile'), home = join(root, 'home'), state = join(root, 'state');
  for (const d of [cwd, home, state]) mkdirSync(d);
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { tav: { type: 'http', url: 'https://bob:S3CRET@mcp.example.com/mcp' }, plain: { type: 'http', url: 'https://other.example.com/mcp' } } }));
  const path = join(root, 'routing.yaml');
  writeFileSync(path, stringify({
    capabilities: { gmail: { kind: 'connector', url: 'https://gmailmcp.googleapis.com/*' } },
    defaults: { capabilities: [], deny: [] },
    profiles: { home: { cwd, permission_mode: 'acceptEdits', capabilities: ['gmail'] } },
    routes: [{ platform: 'telegram', chat: 1, profile: 'home' }],
    telegram: {},
  }));
  const pl = planProfile(loadConfig(path), 'home', { home, stateDir: state, env: {} });
  const c = pl.conflicts.find((x) => x.includes('MCP server tav'));
  assert.ok(c && /user or password/.test(c) && /header/.test(c), pl.conflicts.join(' | '));
  assert.ok(!JSON.stringify([pl.changes, pl.conflicts, pl.notes]).includes('S3CRET'), 'the password is nowhere in the plan');
  assert.throws(() => pl.apply(), /conflict/);
  assert.ok(!existsSync(join(cwd, RECORD)), 'no record written');
});

test('stderr: a blocked-connector warning cut between two chunks is no failure text, and is counted once', () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined }) as any;
  const failures: string[] = [], benign: string[] = [];
  wireChild(child, { exit: () => {}, failure: (t) => failures.push(t), line: () => {}, benign: (l) => benign.push(l) });
  const warn = 'Warning: claude.ai MCP server blocked by enterprise policy: claude.ai Gmail\n';
  for (const c of [warn.slice(0, 20), warn.slice(20)]) child.stderr.emit('data', Buffer.from(c));
  assert.deepEqual(benign, [warn.trim()]);
  assert.equal(failures.at(-1), '', 'once the line is whole it is out of the failure text');
  child.stderr.emit('data', Buffer.from('Error: real trouble\n'));
  assert.equal(failures.at(-1), 'Error: real trouble\n', failures.join(' | '));
});
