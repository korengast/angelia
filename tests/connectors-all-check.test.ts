import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { configNotes, loadConfig } from '../src/instance/config/load.js';
import { droppedConnectorNote } from '../src/capabilities/resolve.js';
import { claudeProjectKeys, claudeUserMcpServers, launchCheck, planProfile, planText, readGuard } from '../src/capabilities/compile.js';
import { blockedConnectorNames, blockedShort, deniedConnectorCount } from '../src/brain/brain.js';

// The review of connectors: all (Fable, 2 Medium and a Low): a deny by address fails open, so the
// compile, check-config and each print-mode start say so; local MCP servers sit under the git root's
// key (measured); the start check reads the Claude config the compile read.

const GMAIL = 'https://gmailmcp.googleapis.com/*';
const DRIVE = 'https://drivemcp.googleapis.com/*';
const editJson = (f: string, m: (j: any) => void) => { const j = JSON.parse(readFileSync(f, 'utf8')); m(j); writeFileSync(f, JSON.stringify(j)); };

/** A profile folder inside a git repo (the workspace), a home, a state folder, a table: all mode, gmail
 *  dropped, an mcp server denied (strict, so the user-level servers are kept out by name). */
function rig() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'angelia-connall-check-')));
  const repo = join(root, 'workspace'), cwd = join(repo, 'profiles', 'home'), home = join(root, 'home'), state = join(root, 'state');
  for (const d of [join(repo, '.git'), cwd, home, state]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } }, projects: { [repo]: { mcpServers: { notes: { command: 'notes' } } } } }));
  const table = {
    capabilities: { gmail: { kind: 'connector', url: GMAIL }, drive: { kind: 'connector', url: DRIVE }, 'bank-api': { kind: 'mcp', command: 'bash', args: ['bank.sh'] } },
    defaults: { capabilities: [], deny: ['bank-api'], connectors: 'all' },
    profiles: { home: { cwd, permission_mode: 'acceptEdits', deny: ['gmail'] } },
    routes: [{ platform: 'telegram', chat: 1, profile: 'home' }],
    telegram: {},
  };
  const path = join(root, 'routing.yaml');
  writeFileSync(path, stringify(table));
  const cfg = () => loadConfig(path);
  return { root, repo, cwd, home, state, cfg };
}

test('local MCP servers: every key Claude Code writes them under (measured: the git root, by real path; a worktree\'s main root)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'angelia-keys-')));
  const repo = join(root, 'repo'), deep = join(repo, 'sub', 'deep');
  mkdirSync(join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
  mkdirSync(deep, { recursive: true });
  assert.deepEqual(claudeProjectKeys(deep), [deep, repo], 'a folder inside a repo: itself and the repo root');
  // Through a link: the path as given, its real path, the root of the real one.
  symlinkSync(join(repo, 'sub'), join(root, 'link'));
  assert.deepEqual(claudeProjectKeys(join(root, 'link', 'deep')), [join(root, 'link', 'deep'), deep, repo]);
  // A worktree: its .git file names a git folder whose commondir leads to the main checkout's.
  const wt = join(root, 'wt');
  mkdirSync(join(wt, 'p'), { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`);
  writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'gitdir'), `${join(wt, '.git')}\n`);
  assert.deepEqual(claudeProjectKeys(join(wt, 'p')), [join(wt, 'p'), wt, repo]);
  // Outside a repo: the real path only.
  const plain = join(root, 'plain');
  mkdirSync(plain);
  assert.deepEqual(claudeProjectKeys(plain), [plain]);
  // A folder that is gone: the path as given.
  assert.deepEqual(claudeProjectKeys(join(root, 'gone')), [join(root, 'gone')]);

  // Read under each of them, the user-level ones too.
  const home = join(root, 'home');
  mkdirSync(home);
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { u: { command: 'u' } }, projects: { [repo]: { mcpServers: { atroot: { command: 'r' } } }, [deep]: { mcpServers: { atfolder: { type: 'http', url: 'https://x.example/mcp' } } } } }));
  assert.deepEqual(claudeUserMcpServers(deep, home, {}), { atfolder: { url: 'https://x.example/mcp' }, atroot: {}, u: {} });
  assert.deepEqual(Object.keys(claudeUserMcpServers(join(wt, 'p'), home, {})), ['atroot', 'u'], 'a worktree reads the main checkout\'s');
});

test('strict all mode: a local server under the git root is kept out at compile, and one added there later refuses the start', () => {
  const r = rig();
  const pl = planProfile(r.cfg(), 'home', { home: r.home, stateDir: r.state, env: {} });
  assert.deepEqual(pl.conflicts, []);
  assert.ok(pl.changes.includes('~ MCP kept out by name: github, notes'), planText(pl));
  pl.apply();
  assert.deepEqual(launchCheck(r.cfg(), 'home', r.state, r.home, {}), []);
  editJson(join(r.home, '.claude.json'), (j) => { j.projects[r.repo].mcpServers.late = { command: 'l' }; });
  const late = launchCheck(r.cfg(), 'home', r.state, r.home, {});
  assert.equal(late.length, 1);
  assert.match(late[0], /^the user-level MCP server "late" \(in [^)]*\.claude\.json, projects\["[^"]*workspace"\]\.mcpServers\) came after the last compile and would load/);
});

test('the start check reads the Claude config of the launch environment; one other than the compile read refuses the start (fix4 M1)', () => {
  const r = rig();
  const conf = join(r.root, 'other-config');
  mkdirSync(conf);
  writeFileSync(join(conf, '.claude.json'), JSON.stringify({ mcpServers: { work: { command: 'w' } } }));
  const daemon = { CLAUDE_CONFIG_DIR: conf };
  planProfile(r.cfg(), 'home', { home: r.home, stateDir: r.state, env: daemon }).apply();
  assert.equal(readGuard(r.state, 'home')!.claudeConfig, join(conf, '.claude.json'));
  assert.deepEqual(readGuard(r.state, 'home')!.mcp!.deniedNames, ['work']);
  assert.deepEqual(launchCheck(r.cfg(), 'home', r.state, r.home, daemon), []);
  // The daemon has no CLAUDE_CONFIG_DIR: its agent reads ~/.claude.json (github, notes), which the compile never saw.
  const off = launchCheck(r.cfg(), 'home', r.state, r.home, {});
  assert.equal(off.length, 2, off.join('\n'));
  assert.match(off[0], new RegExp(`the agent would read the Claude config ${join(r.home, '.claude.json')} \\(from the daemon's environment\\), but the last compile read ${join(conf, '.claude.json')}`));
  assert.match(off[1], /"github" \([^)]*\), "notes" \([^)]*\) came after the last compile/);
  // The daemon's file gains a server after the compile: refused.
  editJson(join(conf, '.claude.json'), (j) => { j.mcpServers.late = { command: 'l' }; });
  assert.match(launchCheck(r.cfg(), 'home', r.state, r.home, daemon).join('\n'), /"late" \([^)]*\) came after the last compile/);
  // A compile from a shell with another config is a change, and the guard follows it.
  const again = planProfile(r.cfg(), 'home', { home: r.home, stateDir: r.state, env: {} });
  assert.ok(again.changes.includes(`~ Claude config read for MCP servers: ${join(r.home, '.claude.json')} (was ${join(conf, '.claude.json')})`), planText(again));
  again.apply();
  assert.equal(readGuard(r.state, 'home')!.claudeConfig, join(r.home, '.claude.json'));
  assert.deepEqual(launchCheck(r.cfg(), 'home', r.state, r.home, {}), []);
  assert.match(launchCheck(r.cfg(), 'home', r.state, r.home, daemon).join('\n'), /the agent would read the Claude config/);
});

test('a dropped connector is kept out by its address only: a note per dropped connector at compile and in check-config', () => {
  const r = rig();
  const note = droppedConnectorNote('gmail', GMAIL);
  assert.match(note, /gmail is kept out by its address https:\/\/gmailmcp\.googleapis\.com\/\* only; if that is not the address .* gmail loads/);
  const pl = planProfile(r.cfg(), 'home', { home: r.home, stateDir: r.state, env: {} });
  assert.deepEqual(pl.notes.filter((n) => n.includes('kept out by its address')), [note], planText(pl));
  assert.deepEqual(configNotes(r.cfg()).filter((n) => n.includes('kept out by its address')), [`profiles.home: ${note}`]);
});

test('the blocked-connector count: the line Claude Code prints, the launch\'s deny list, the warning when short', () => {
  assert.deepEqual(blockedConnectorNames('Warning: claude.ai MCP server blocked by enterprise policy: claude.ai Gmail'), ['claude.ai Gmail']);
  assert.deepEqual(blockedConnectorNames(' Warning: claude.ai MCP servers blocked by enterprise policy: claude.ai Gmail, claude.ai Google Drive '), ['claude.ai Gmail', 'claude.ai Google Drive']);
  assert.deepEqual(blockedConnectorNames('MCP server "x" failed'), []);
  assert.equal(deniedConnectorCount({ deniedMcpServers: [{ serverName: 'github' }, { serverUrl: GMAIL }, { serverUrl: DRIVE }, { serverUrl: GMAIL }] }), 2, 'by url, each once; a name is no connector');
  assert.equal(deniedConnectorCount({ allowedMcpServers: [], deniedMcpServers: [{ serverUrl: GMAIL }] }), 0, 'a granted launch: its warning names every connector left out');
  assert.equal(deniedConnectorCount({}), 0);
  assert.equal(blockedShort(0, []), undefined);
  assert.equal(blockedShort(1, ['claude.ai Gmail']), undefined);
  assert.equal(blockedShort(2, ['claude.ai Gmail']), 'connectors: all: this start dropped 2 connectors by address, but Claude Code named 1 as blocked (claude.ai Gmail): a dropped connector may be loading (a wrong address in the table, or one the Claude app changed), or the account does not have it, or its connector list did not load');
});

