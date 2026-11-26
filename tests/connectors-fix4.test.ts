import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { loadConfig } from '../src/instance/config/load.js';
import { launchCheck, parentMcpServers, planProfile, planText, readGuard } from '../src/capabilities/compile.js';

// fix4 M2: a .mcp.json in a folder above a strict profile's (connectors: all) is a source of MCP
// servers of its own (measured: `claude mcp list` in a child folder lists the parent's server). The
// compile keeps its servers out by name; one added there later refuses the start.

const editJson = (f: string, m: (j: any) => void) => { const j = JSON.parse(readFileSync(f, 'utf8')); m(j); writeFileSync(f, JSON.stringify(j)); };

/** top/.mcp.json above the workspace repo, workspace/.mcp.json at the repo root, the profile below. */
function rig(strict = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'angelia-connall-fix4-')));
  const top = join(root, 'top'), repo = join(top, 'workspace'), cwd = join(repo, 'profiles', 'home'), home = join(root, 'home'), state = join(root, 'state');
  for (const d of [join(repo, '.git'), cwd, home, state]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }));
  writeFileSync(join(top, '.mcp.json'), JSON.stringify({ mcpServers: { above: { command: 'a' }, shared: { command: 's' } } }));
  writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { atrepo: { type: 'http', url: 'https://x.example/mcp' }, shared: { command: 's2' } } }));
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
  const table = {
    capabilities: { gmail: { kind: 'connector', url: 'https://gmailmcp.googleapis.com/*' }, 'bank-api': { kind: 'mcp', command: 'bash', args: ['bank.sh'] } },
    defaults: { capabilities: [], deny: strict ? ['bank-api'] : [], connectors: 'all' },
    profiles: { home: { cwd, permission_mode: 'acceptEdits', deny: ['gmail'] } },
    routes: [{ platform: 'telegram', chat: 1, profile: 'home' }],
    telegram: {},
  };
  const path = join(root, 'routing.yaml');
  writeFileSync(path, stringify(table));
  const cfg = () => loadConfig(path);
  const plan = () => planProfile(cfg(), 'home', { home, stateDir: state, env: {} });
  const check = () => launchCheck(cfg(), 'home', state, home, {});
  return { root, top, repo, cwd, home, state, cfg, plan, check };
}

test('parentMcpServers: each .mcp.json above the folder up to the root, the nearest first; not the folder\'s own', () => {
  const r = rig();
  assert.deepEqual([...parentMcpServers(r.cwd)], [['atrepo', join(r.repo, '.mcp.json')], ['shared', join(r.repo, '.mcp.json')], ['above', join(r.top, '.mcp.json')]]);
  // Through a link: the real path's parents are read too (the agent's process sees those).
  symlinkSync(join(r.repo, 'profiles'), join(r.root, 'link'));
  assert.deepEqual([...parentMcpServers(join(r.root, 'link', 'home')).keys()].sort(), ['above', 'atrepo', 'shared']);
  // Not a plain file, or not JSON, or no object: a refusal, not "none".
  mkdirSync(join(r.repo, 'profiles', '.mcp.json'));
  assert.throws(() => parentMcpServers(r.cwd), /profiles\/\.mcp\.json cannot be read \(EFTYPE\)/);
});

test('strict all mode: the servers of a .mcp.json above the folder are kept out by name at compile; one added later refuses the start', () => {
  const r = rig();
  const pl = r.plan();
  assert.deepEqual(pl.conflicts, []);
  assert.ok(pl.changes.includes('~ MCP kept out by name: above, atrepo, github, shared'), planText(pl));
  assert.ok(pl.notes.some((n) => n.includes('those of each .mcp.json above its folder are kept out by name')), planText(pl));
  pl.apply();
  assert.deepEqual(readGuard(r.state, 'home')!.mcp!.deniedNames, ['above', 'atrepo', 'github', 'shared']);
  assert.deepEqual(r.check(), []);
  editJson(join(r.top, '.mcp.json'), (j) => { j.mcpServers.late = { command: 'l' }; });
  assert.deepEqual(r.check(), [`"late" (${join(r.top, '.mcp.json')}): MCP server in a .mcp.json above the profile's folder that came after the last compile and would load: this profile denies an MCP server, and with connectors: all only a compile keeps them out; compile again`]);
  r.plan().apply();
  assert.deepEqual(r.check(), []);
  // Broken after the compile: the start is refused.
  writeFileSync(join(r.repo, '.mcp.json'), '{ not json');
  assert.deepEqual(r.check(), [`${join(r.repo, '.mcp.json')} is not valid JSON, so Angelia cannot see which MCP servers it adds above the profile's folder; fix it`]);
});

test('strict all mode: a broken .mcp.json above, or a name Claude Code drops, is a compile conflict', () => {
  const r = rig();
  writeFileSync(join(r.top, '.mcp.json'), JSON.stringify({ mcpServers: [] }));
  assert.match(r.plan().conflicts.join('\n'), /top\/\.mcp\.json: mcpServers is not an object, so Angelia cannot see which MCP servers it adds above the profile's folder; this profile denies an MCP server/);
  writeFileSync(join(r.top, '.mcp.json'), JSON.stringify({ mcpServers: { 'bad.name': { command: 'b' } } }));
  assert.match(r.plan().conflicts.join('\n'), /the MCP server "bad\.name" in .*top\/\.mcp\.json \(above the profile's folder\) has a character other than letters/);
});

test('not strict: the .mcp.json files above are not read (nothing is kept out by name)', () => {
  const r = rig(false);
  writeFileSync(join(r.top, '.mcp.json'), '{ not json');
  const pl = r.plan();
  assert.deepEqual(pl.conflicts, []);
  pl.apply();
  assert.deepEqual(r.check(), []);
});
