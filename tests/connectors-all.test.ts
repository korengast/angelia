import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { configNotes, loadConfig } from '../src/instance/config/load.js';
import { connectorMode, droppedConnectors } from '../src/capabilities/resolve.js';
import { guardMcpLaunch, launchCheck, mcpLaunch, mcpSettingsFile, planProfile, planText, readGuard, readRecord, RECORD } from '../src/capabilities/compile.js';
import { claudeArgv, claudeTerminalLine, claudeTuiArgv, tuiSettings } from '../src/brain/argv.js';
import { claudeAskArgv } from '../src/brain/ask.js';
import { exitReason } from '../src/brain/brain.js';

// connectors: all (measured on claude 2.1.332, 2026-11-25): no allow list, so every connector of the
// account loads, and a deniedMcpServers list in --settings drops some by url; a strict profile keeps
// its user-level servers out by name there, since --strict-mcp-config drops every connector too.

const GMAIL = 'https://gmailmcp.googleapis.com/*';
const DRIVE = 'https://drivemcp.googleapis.com/*';
const CAL = 'https://calendarmcp.googleapis.com/*';

/** As connectors.test.ts: a profile folder, a home with a user-level Claude config, a state folder,
 *  and a table on disk. `home` takes every connector of the account and drops gmail. */
function rig(mutate: (t: any) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'angelia-connall-'));
  const cwd = join(root, 'profile'), home = join(root, 'home'), state = join(root, 'state');
  for (const d of [cwd, home, state]) mkdirSync(d);
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' }, search: { type: 'http', url: 'https://search.example.com/mcp?key=SECRET' } }, projects: { [cwd]: { mcpServers: { notes: { command: 'notes' } } } } }));
  const table: any = {
    capabilities: {
      gmail: { kind: 'connector', url: GMAIL },
      drive: { kind: 'connector', url: DRIVE },
      calendar: { kind: 'connector', url: CAL },
      'fx-rates': { kind: 'mcp', command: 'node', args: ['fx.js'], when: 'exchange rates' },
      'bank-api': { kind: 'mcp', command: 'bash', args: ['bank.sh'] },
    },
    defaults: { capabilities: [], deny: [], connectors: 'all' },
    profiles: { home: { cwd, permission_mode: 'acceptEdits', capabilities: ['fx-rates'], deny: ['gmail'] } },
    routes: [{ platform: 'telegram', chat: 1, profile: 'home' }],
    telegram: {},
  };
  mutate(table);
  const path = join(root, 'routing.yaml');
  writeFileSync(path, stringify(table));
  const edit = (m: (t: any) => void) => { const t = parse(readFileSync(path, 'utf8')); m(t); writeFileSync(path, stringify(t)); };
  const cfg = () => loadConfig(path);
  const plan = (env: NodeJS.ProcessEnv = {}) => planProfile(cfg(), 'home', { home, stateDir: state, env });
  const check = (env: NodeJS.ProcessEnv = {}) => launchCheck(cfg(), 'home', state, home, env);
  return { root, cwd, home, state, path, edit, cfg, plan, check };
}

const session = { id: '00000000-0000-4000-8000-000000000001', started: false };
const lastSettings = (argv: string[]) => JSON.parse(argv[argv.lastIndexOf('--settings') + 1]);
const editJson = (f: string, m: (j: any) => void) => { const j = JSON.parse(readFileSync(f, 'utf8')); m(j); writeFileSync(f, JSON.stringify(j)); };

test('config: connectors is granted or all, per instance (defaults) and per profile; granted by default', () => {
  const r = rig((t) => { delete t.defaults.connectors; });
  assert.equal(r.cfg().defaults.connectors, 'granted');
  assert.equal(connectorMode(r.cfg(), 'home'), 'granted', 'deny by default stays the default');
  r.edit((t) => { t.defaults.connectors = 'all'; });
  assert.equal(connectorMode(r.cfg(), 'home'), 'all');
  r.edit((t) => { t.profiles.home.connectors = 'granted'; });
  assert.equal(connectorMode(r.cfg(), 'home'), 'granted', 'the profile\'s own beats the default');
  r.edit((t) => { t.defaults.connectors = 'granted'; t.profiles.home.connectors = 'all'; });
  assert.equal(connectorMode(r.cfg(), 'home'), 'all');
  r.edit((t) => { t.profiles.home.connectors = 'every'; });
  assert.throws(() => r.cfg(), /connectors/);
  r.edit((t) => { delete t.profiles.home.connectors; t.defaults.connectors = true; });
  assert.throws(() => r.cfg(), /defaults\.connectors/);
});

test('resolve: in all mode a profile drops a connector with deny, except, or defaults.deny it does not lift', () => {
  const r = rig((t) => { t.defaults.deny = ['drive']; t.defaults.capabilities = ['calendar']; });
  assert.deepEqual(droppedConnectors(r.cfg(), 'home'), [['drive', DRIVE], ['gmail', GMAIL]]);
  r.edit((t) => { t.profiles.home.deny = []; t.profiles.home.except = ['calendar']; t.profiles.home.capabilities = ['fx-rates', 'drive']; });
  assert.deepEqual(droppedConnectors(r.cfg(), 'home'), [['calendar', CAL]], 'drive lifted from defaults.deny, calendar taken by except');
  r.edit((t) => { t.profiles.home.except = ['calendar', 'fx-rates']; t.profiles.home.capabilities = ['calendar']; });
  assert.deepEqual(droppedConnectors(r.cfg(), 'home'), [['drive', DRIVE]], 'a capability of its own beats its except; an mcp name is no connector');
});

test('compile, all mode, MCP not strict: no allow list, a deny list of the dropped connectors, from the guard; print, tmux and /status', () => {
  const r = rig();
  writeFileSync(join(r.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'mine' } } }));
  const pl = r.plan();
  assert.deepEqual(pl.conflicts, []);
  assert.ok(pl.changes.includes('+ connectors: all: every Claude app connector of the account loads for this profile, ones added later in the Claude app included, but gmail'), planText(pl));
  assert.ok(!pl.changes.some((c) => c.includes('allow list')), planText(pl));
  pl.apply();

  const rec = readRecord(r.cwd)!;
  assert.equal(rec.mcpStrict, false);
  assert.equal(rec.connectorsAll, true);
  assert.deepEqual(rec.connectors, [], 'no connector is granted by list');
  assert.deepEqual(rec.connectorsDenied, [GMAIL]);
  assert.deepEqual(rec.mcpOwn, ['fx-rates', 'mine']);
  assert.deepEqual(rec.mcpDeny, [], 'not strict: the user-level servers load, as before connectors');
  assert.equal(rec.mcpAllow, undefined);
  assert.deepEqual(readGuard(r.state, 'home')!.mcp, { strict: false, connectors: [], allow: [], own: ['fx-rates', 'mine'], urls: [], all: true, deniedUrls: [GMAIL], deniedNames: [] });
  const md = readFileSync(join(r.cwd, 'CLAUDE.md'), 'utf8');
  assert.ok(md.includes('- Claude app connectors: every connector of the claude.ai account loads (tools mcp__claude_ai_<its name>__*), but gmail; they need a claude.ai login.'), md);

  const want = { deniedMcpServers: [{ serverUrl: GMAIL }], disabledMcpjsonServers: ['fx-rates', 'mine'] };
  const p = r.cfg().profiles.home;
  const mcp = guardMcpLaunch(r.state, 'home', r.cwd)!;
  assert.deepEqual(mcp, { args: ['--mcp-config', join(r.cwd, '.mcp.json')], settings: want });
  assert.deepEqual(mcpLaunch(r.cwd), mcp, 'the record path gives the same launch');
  for (const argv of [claudeArgv(p, session, 'claude', undefined, mcp), claudeTuiArgv(p, session, 'claude', '/x/settings.json', 'n', undefined, mcp)]) {
    assert.ok(!argv.includes('--strict-mcp-config'));
    assert.equal(argv[argv.indexOf('--mcp-config') + 1], join(r.cwd, '.mcp.json'));
  }
  const s = lastSettings(claudeArgv(p, session, 'claude', undefined, mcp));
  assert.deepEqual(s.deniedMcpServers, want.deniedMcpServers);
  assert.equal(s.allowedMcpServers, undefined, 'no allow list: every connector of the account loads, later ones too');
  assert.deepEqual(tuiSettings(p, { hooks: {} }, mcp), { ...want, hooks: {} });
  assert.deepEqual(JSON.parse(readFileSync(mcpSettingsFile(r.state, 'home'), 'utf8')), want);
  const line = claudeTerminalLine(p, 'sid', r.home, { mcp, settingsFile: mcpSettingsFile(r.state, 'home') });
  assert.ok(line.includes(mcpSettingsFile(r.state, 'home')) && !line.includes('gmailmcp'), line);

  assert.deepEqual(r.check(), []);
  assert.deepEqual(r.plan().changes, [], planText(r.plan()));
});

test('compile, all mode, nothing dropped and no .mcp.json: the launch is a plain one', () => {
  const r = rig((t) => { t.profiles.home = { cwd: t.profiles.home.cwd }; });
  r.plan().apply();
  assert.deepEqual(guardMcpLaunch(r.state, 'home', r.cwd), { args: [], settings: {} });
  assert.deepEqual(r.check(), []);
  assert.ok(readFileSync(join(r.cwd, 'CLAUDE.md'), 'utf8').includes('every connector of the claude.ai account loads (tools mcp__claude_ai_<its name>__*); they need'));
});

test('compile, all mode on a strict profile: the user-level servers are kept out by name; one added later refuses the start until a compile', () => {
  const r = rig((t) => { t.defaults.deny = ['bank-api']; });
  const pl = r.plan();
  assert.deepEqual(pl.conflicts, []);
  assert.ok(pl.changes.some((c) => c.startsWith('+ strict MCP: user-level servers (such as github, tavily) are left out, by name')), planText(pl));
  assert.ok(pl.changes.includes('~ MCP kept out by name: github, notes, search'), planText(pl));
  assert.ok(pl.notes.some((n) => n.includes('one added later stops the start until the next compile')), planText(pl));
  pl.apply();
  const mcp = guardMcpLaunch(r.state, 'home', r.cwd)!;
  assert.ok(!mcp.args.includes('--strict-mcp-config'), 'strict MCP would drop every connector');
  assert.deepEqual(mcp.settings.deniedMcpServers, [{ serverName: 'github' }, { serverName: 'notes' }, { serverName: 'search' }, { serverUrl: GMAIL }]);
  assert.ok(!JSON.stringify(mcp).includes('SECRET'), 'a remote server is kept out by its name: its address goes nowhere');
  assert.deepEqual(r.check(), []);

  editJson(join(r.home, '.claude.json'), (j) => { j.mcpServers.newbie = { command: 'n' }; });
  assert.equal(r.check().length, 1);
  assert.match(r.check()[0], /^the user-level MCP server "newbie" \(in [^)]*\.claude\.json, mcpServers\) came after the last compile and would load/);
  assert.ok(r.plan().changes.includes('~ MCP kept out by name: github, newbie, notes, search'));
  r.plan().apply();
  assert.deepEqual(r.check(), []);
  writeFileSync(join(r.home, '.claude.json'), '{ broken');
  assert.match(r.check().join('\n'), /cannot be read, so Angelia cannot see which user-level MCP servers would load/);

  // A name Claude Code would drop from its lists cannot be kept out by name: the compile stops.
  writeFileSync(join(r.home, '.claude.json'), JSON.stringify({ mcpServers: { 'my.tool': { command: 'x' } } }));
  assert.match(r.plan().conflicts.join('\n'), /user-level MCP server "my\.tool" has a character other than/);
});

test('all mode: the record the agent rewrote decides nothing, and differs from the guard: the start is refused', () => {
  const r = rig();
  r.plan().apply();
  const recPath = join(r.cwd, RECORD);
  for (const m of [(j: any) => { j.connectorsDenied = []; }, (j: any) => { delete j.connectorsAll; }, (j: any) => { j.mcpDeny = ['x']; }]) {
    const before = readFileSync(recPath, 'utf8');
    editJson(recPath, m);
    assert.match(r.check().join('\n'), /MCP launch .* is not what the last compile wrote/);
    assert.deepEqual(guardMcpLaunch(r.state, 'home', r.cwd)!.settings.deniedMcpServers, [{ serverUrl: GMAIL }], 'the daemon launches from the guard');
    writeFileSync(recPath, before);
  }
  assert.deepEqual(r.check(), []);
  // A server added to .mcp.json by hand would hold a tmux pane on its dialog, as for a granted connector.
  editJson(join(r.cwd, '.mcp.json'), (j) => { j.mcpServers.handmade = { command: 'y' }; });
  assert.match(r.check().join('\n'), /\.mcp\.json names "handmade"/);
});

test('all mode: the profile\'s own settings cannot take the deny back; an allow list there only narrows, so it is a note, not a refusal', () => {
  const r = rig();
  r.plan().apply();
  mkdirSync(join(r.cwd, '.claude'), { recursive: true });
  // Measured: deny lists of every settings file are merged, and a deny wins over any allow list.
  writeFileSync(join(r.cwd, '.claude', 'settings.local.json'), JSON.stringify({ deniedMcpServers: [], allowedMcpServers: [{ serverUrl: GMAIL }] }));
  assert.deepEqual(r.check(), []);
  const pl = r.plan();
  assert.deepEqual(pl.conflicts, []);
  assert.ok(pl.notes.includes('.claude/settings.local.json lists allowedMcpServers, so Claude Code loads only what it names; the connectors this profile drops stay out all the same'), planText(pl));
});

test('all mode to granted and back: the change lines, and the granted launch again', () => {
  const r = rig((t) => { t.profiles.home.capabilities = ['fx-rates', 'drive']; });
  r.plan().apply();
  r.edit((t) => { t.profiles.home.connectors = 'granted'; });
  const back = r.plan();
  assert.ok(back.changes.includes('- connectors: all: only the connectors given to this profile load'), planText(back));
  assert.ok(back.changes.includes(`+ connector drive: the Claude app connector at ${DRIVE} loads for this profile`), planText(back));
  back.apply();
  assert.equal(readRecord(r.cwd)!.connectorsAll, undefined);
  assert.deepEqual(guardMcpLaunch(r.state, 'home', r.cwd)!.settings.allowedMcpServers, [{ serverName: 'fx-rates' }, { serverName: 'github' }, { serverName: 'notes' }, { serverName: 'search' }, { serverUrl: 'https://search.example.com/mcp*' }, { serverUrl: DRIVE }]);
  assert.deepEqual(r.check(), []);
  r.edit((t) => { delete t.profiles.home.connectors; t.profiles.home.deny = ['gmail', 'calendar']; });
  const again = r.plan();
  assert.ok(again.changes.includes('+ connectors: all: every Claude app connector of the account loads for this profile, ones added later in the Claude app included, but calendar, gmail'), planText(again));
  again.apply();
  r.edit((t) => { t.profiles.home.deny = ['gmail']; });
  assert.deepEqual(r.plan().changes.filter((c) => c.includes('connector')), [`+ connector ${CAL}: loads again for this profile`]);
  r.edit((t) => { t.profiles.home.deny = ['gmail', 'calendar', 'drive']; t.profiles.home.capabilities = ['fx-rates']; });
  assert.ok(r.plan().changes.includes(`- connector drive: the Claude app connector at ${DRIVE} no longer loads for this profile`), planText(r.plan()));
});

test('all mode: angelia ask still loads no connector', () => {
  const r = rig();
  r.plan().apply();
  const p = r.cfg().profiles.home;
  const ask = claudeAskArgv(p, undefined);
  assert.ok(ask.includes('--strict-mcp-config') && !ask.join(' ').includes('deniedMcpServers'));
});

test('check-config notes a profile in all mode; other backends get nothing, said once at compile', () => {
  const r = rig((t) => { t.profiles.other = { cwd: t.profiles.home.cwd, backend: 'grok', connectors: 'all' }; });
  const notes = configNotes(r.cfg());
  assert.ok(notes.includes('profiles.home: connectors: all: every Claude app connector of your claude.ai account, including ones you add later in the Claude app, reaches it at its next start; it drops gmail'), notes.join('\n'));
  assert.ok(!notes.some((n) => n.startsWith('profiles.other: connectors')));
  const g = planProfile(r.cfg(), 'other', { home: r.home, stateDir: r.state, env: {} });
  assert.ok(g.notes.includes('connectors: all is for Claude Code only: this grok profile gets no Claude app connector'), planText(g));
  r.edit((t) => { t.defaults.connectors = 'granted'; });
  assert.ok(!configNotes(r.cfg()).some((n) => n.includes('connectors: all')));
});

test('the warning for one connector left out (singular, measured live with a deny list of one) is no failure either', () => {
  const WARN = 'Warning: claude.ai MCP server blocked by enterprise policy: claude.ai Gmail';
  assert.equal(exitReason(`${WARN}\n`), 'exit');
  assert.equal(exitReason(`not logged in\n${WARN}\n`), 'exit: not logged in');
});
