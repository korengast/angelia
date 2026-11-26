import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
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
  for (const loose of [' https://u:p@h.example/mcp', '\thttps://u:p@h.example/mcp', 'https:\\\\u:p@h.example/mcp', 'https:/u:p@h.example/mcp', 'https:u:p@h.example/mcp', '${U:-https://u:p@h.example/mcp}']) {
    assert.ok(userInfo(loose), `loose form not caught: ${JSON.stringify(loose)}`);
    assert.throws(() => urlPattern(loose));
  }
  assert.ok(!userInfo('${U:-https://h.example/mcp}?a@b'));
});

/** A list-mode profile with a connector and no strict MCP, its user config and routing capabilities. */
function userInfoPlan(user: object, caps: Record<string, object> = {}, own?: object) {
  const root = mkdtempSync(join(tmpdir(), 'angelia-userinfo-'));
  const cwd = join(root, 'profile'), home = join(root, 'home'), state = join(root, 'state');
  for (const d of [cwd, home, state]) mkdirSync(d);
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: user }));
  if (own) writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: own }));
  const path = join(root, 'routing.yaml');
  writeFileSync(path, stringify({
    capabilities: { gmail: { kind: 'connector', url: 'https://gmailmcp.googleapis.com/*' }, ...caps },
    defaults: { capabilities: [], deny: [] },
    profiles: { home: { cwd, permission_mode: 'acceptEdits', capabilities: ['gmail', ...Object.keys(caps)] } },
    routes: [{ platform: 'telegram', chat: 1, profile: 'home' }],
    telegram: {},
  }));
  return { cwd, plan: planProfile(loadConfig(path), 'home', { home, stateDir: state, env: {} }) };
}
const secretUrl = 'https://bob:S3CRET@mcp.example.com/mcp';

test('compile: a user-level MCP server with a password in its address is left out with a note, not a conflict', () => {
  const { cwd, plan } = userInfoPlan({ tav: { type: 'http', url: secretUrl }, plain: { type: 'http', url: 'https://other.example.com/mcp' } });
  assert.deepEqual(plan.conflicts, []);
  const note = plan.notes.find((x) => x.includes('MCP server tav'));
  assert.ok(note && /user or password/.test(note) && /does not load/.test(note), plan.notes.join(' | '));
  assert.ok(!JSON.stringify([plan.changes, plan.notes]).includes('S3CRET'), 'the password is nowhere in the plan');
  plan.apply();
  const rec = JSON.parse(readFileSync(join(cwd, RECORD), 'utf8'));
  assert.deepEqual(rec.mcpAllow, ['plain']);
  assert.deepEqual(rec.mcpUrls, ['https://other.example.com/mcp']);
});

test('compile: a password in an address of the profile\'s own .mcp.json is a conflict that names the server, never the password', () => {
  const { cwd, plan } = userInfoPlan({}, {}, { tav: { type: 'http', url: secretUrl } });
  const c = plan.conflicts.find((x) => x.includes('MCP server tav'));
  assert.ok(c && /user or password/.test(c) && /headers in its MCP config/.test(c), plan.conflicts.join(' | '));
  assert.ok(!JSON.stringify([plan.changes, plan.conflicts, plan.notes]).includes('S3CRET'), 'the password is nowhere in the plan');
  assert.throws(() => plan.apply(), /conflict/);
  assert.ok(!existsSync(join(cwd, RECORD)), 'no record written');
});

test('compile: a password in a capability\'s url is a conflict that names the routing table', () => {
  const { plan } = userInfoPlan({}, { tav: { kind: 'mcp', url: secretUrl } });
  const c = plan.conflicts.find((x) => x.includes('MCP server tav'));
  assert.ok(c && c.includes('routing table (capabilities.tav)') && !c.includes('MCP config'), plan.conflicts.join(' | '));
  assert.ok(!c.includes('S3CRET'));
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
