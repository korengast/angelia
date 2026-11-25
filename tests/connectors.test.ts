import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { loadConfig } from '../src/instance/config/load.js';
import { resolveProfile } from '../src/capabilities/resolve.js';
import { floorWarnings, guardMcpLaunch, launchCheck, mcpLaunch, mcpSettingsFile, planProfile, planText, readGuard, readRecord, RECORD } from '../src/capabilities/compile.js';
import { exitReason } from '../src/brain/brain.js';
import { claudeArgv, claudeTerminalLine, claudeTuiArgv, tuiSettings } from '../src/brain/argv.js';
import { claudeAskArgv } from '../src/brain/ask.js';
import { capabilitiesView } from '../src/instance/profile-views.js';

const GMAIL = 'https://gmailmcp.googleapis.com/*';
const DRIVE = 'https://drivemcp.googleapis.com/*';

/** A profile folder, a home with a user-level Claude config, a state folder, and a table on disk. */
function rig(mutate: (t: any) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'angelia-conn-'));
  const cwd = join(root, 'profile'), home = join(root, 'home'), state = join(root, 'state');
  for (const d of [cwd, home, state]) mkdirSync(d);
  // A user-level server and one for this folder only: Claude Code loads both when MCP is not strict.
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } }, projects: { [cwd]: { mcpServers: { notes: { command: 'notes' } } } } }));
  const table: any = {
    capabilities: {
      gmail: { kind: 'connector', url: GMAIL, when: 'mail is asked about' },
      drive: { kind: 'connector', url: DRIVE },
      'fx-rates': { kind: 'mcp', command: 'node', args: ['fx.js'], when: 'exchange rates' },
      'bank-api': { kind: 'mcp', command: 'bash', args: ['bank.sh'] },
    },
    defaults: { capabilities: [], deny: ['bank-api'] },
    profiles: { home: { cwd, permission_mode: 'acceptEdits', capabilities: ['fx-rates', 'gmail'] } },
    routes: [{ platform: 'telegram', chat: 1, profile: 'home' }],
    telegram: {},
  };
  mutate(table);
  const path = join(root, 'routing.yaml');
  writeFileSync(path, stringify(table));
  const edit = (m: (t: any) => void) => { const t = parse(readFileSync(path, 'utf8')); m(t); writeFileSync(path, stringify(t)); };
  const cfg = () => loadConfig(path);
  const plan = (env: NodeJS.ProcessEnv = {}) => planProfile(cfg(), 'home', { home, stateDir: state, env });
  return { root, cwd, home, state, path, edit, cfg, plan };
}

const session = { id: '00000000-0000-4000-8000-000000000001', started: false };
const lastSettings = (argv: string[]) => JSON.parse(argv[argv.lastIndexOf('--settings') + 1]);

test('config: a connector needs an https url that names one site', () => {
  const bad: [unknown, RegExp][] = [
    [{ kind: 'connector' }, /capabilities\.x\.url/],
    [{ kind: 'connector', url: 'http://gmailmcp.googleapis.com/*' }, /must start with https/],
    [{ kind: 'connector', url: 'https://*/*' }, /named in full, with no \*/],
    [{ kind: 'connector', url: 'https://*.com/*' }, /named in full/],
    [{ kind: 'connector', url: 'https://*.co.uk/*' }, /named in full/],
    [{ kind: 'connector', url: 'https://*.googleapis.com/*' }, /named in full/],
    [{ kind: 'connector', url: 'https://*mcp.googleapis.com/*' }, /named in full/],
    [{ kind: 'connector', url: 'https://a.b?x/*' }, /must not hold "\?"/],
    [{ kind: 'connector', url: 'https://gmailmcp.googleapis.com/#/*' }, /must not hold "#"/],
    [{ kind: 'connector', url: 'https://gmailmcp.googleapis.com/"*' }, /must not hold/],
    [{ kind: 'connector', url: "https://gmailmcp.googleapis.com/'*" }, /must not hold/],
    [{ kind: 'connector', url: 'https://1.2.3.4/*' }, /not an IP address/],
    [{ kind: 'connector', url: 'https://[::1]/*' }, /not an IP address/],
    [{ kind: 'connector', url: 'https://localhost/*' }, /full name/],
    [{ kind: 'connector', url: 'https://gmailmcp.googleapis.com' }, /needs a path/],
    [{ kind: 'connector', url: 'https://gmail mcp.googleapis.com/*' }, /space/],
    [{ kind: 'connector', url: GMAIL, command: 'x' }, /unknown key|Unrecognized/i],
  ];
  for (const [x, re] of bad) {
    const r = rig((t) => { t.capabilities.x = x; });
    assert.throws(() => r.cfg(), re, JSON.stringify(x));
  }
  const ok = rig((t) => { t.capabilities.x = { kind: 'connector', url: 'https://gmailmcp.googleapis.com:443/mcp/*' }; });
  assert.equal(ok.cfg().capabilities.x.kind, 'connector');
});

test('resolve: a connector is granted and denied like any capability', () => {
  const r = rig((t) => { t.defaults.capabilities = ['drive']; });
  let res = resolveProfile(r.cfg(), 'home');
  assert.deepEqual([...res.allowed.keys()], ['drive', 'fx-rates', 'gmail']);
  r.edit((t) => { t.profiles.home.except = ['drive']; t.profiles.home.deny = ['gmail']; t.profiles.home.capabilities = ['fx-rates']; });
  res = resolveProfile(r.cfg(), 'home');
  assert.deepEqual([...res.allowed.keys()], ['fx-rates']);
  assert.deepEqual([...res.denied.keys()], ['bank-api', 'gmail']);
  r.edit((t) => { t.profiles.home.deny = ['nope']; });
  assert.throws(() => r.cfg(), /unknown capability "nope"/);
  // The app's view names the host, never more.
  const r2 = rig();
  assert.deepEqual(capabilitiesView(r2.cfg(), 'home', r2.home).allowed.find((c) => c.name === 'gmail'), { name: 'gmail', kind: 'connector', when: 'mail is asked about', what: 'gmailmcp.googleapis.com' });
});

test('compile, strict profile granted Gmail: the record, the change lines, the capability line; print and tmux argv load an allow list, not --strict-mcp-config', () => {
  const r = rig();
  writeFileSync(join(r.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'mine' } } }));
  const pl = r.plan();
  assert.deepEqual(pl.conflicts, []);
  assert.ok(pl.changes.includes(`+ connector gmail: the Claude app connector at ${GMAIL} loads for this profile`), planText(pl));
  assert.ok(pl.changes.some((c) => c.startsWith('~ MCP by allow list: only the servers fx-rates, mine and the granted connectors load')), planText(pl));
  pl.apply();

  const rec = readRecord(r.cwd)!;
  assert.equal(rec.mcpStrict, true, 'it denies bank-api, so user-level servers stay out');
  assert.deepEqual(rec.connectors, [GMAIL]);
  assert.deepEqual(rec.mcpAllow, ['fx-rates', 'mine'], 'its own .mcp.json servers only: github and the folder-local notes stay out');
  assert.deepEqual(rec.mcpOwn, ['fx-rates', 'mine']);
  assert.deepEqual(readGuard(r.state, 'home')!.mcp, { strict: true, connectors: [GMAIL], allow: ['fx-rates', 'mine'], own: ['fx-rates', 'mine'], urls: [] });
  const md = readFileSync(join(r.cwd, 'CLAUDE.md'), 'utf8');
  assert.ok(md.includes('- gmail: Gmail through the Claude app connector (tools mcp__claude_ai_Gmail__*); needs a claude.ai login. When: mail is asked about.'), md);
  assert.ok(!md.includes('- drive:'), 'a connector not granted has no line');

  const want = {
    allowedMcpServers: [{ serverName: 'fx-rates' }, { serverName: 'mine' }, { serverUrl: GMAIL }],
    disabledMcpjsonServers: ['fx-rates', 'mine'],
  };
  const p = r.cfg().profiles.home;
  const argv = claudeArgv(p, session);
  assert.ok(!argv.includes('--strict-mcp-config'));
  assert.equal(argv[argv.indexOf('--mcp-config') + 1], join(r.cwd, '.mcp.json'));
  assert.equal(argv.filter((a) => a === '--settings').length, 1, 'one --settings: of two, only the last counts');
  assert.deepEqual(lastSettings(argv), want);

  const tui = claudeTuiArgv(p, session, 'claude', '/x/settings.json', 'n');
  assert.ok(!tui.includes('--strict-mcp-config'));
  assert.equal(tui[tui.indexOf('--mcp-config') + 1], join(r.cwd, '.mcp.json'));
  assert.equal(tui.filter((a) => a === '--settings').length, 1);
  const ts = tuiSettings(p, { hooks: { Stop: [] } });
  assert.deepEqual(ts, { ...want, hooks: { Stop: [] } });

  const line = claudeTerminalLine(p, 'sid', r.home);
  assert.ok(line.includes(`--mcp-config ${join(r.cwd, '.mcp.json')}`) && line.includes('allowedMcpServers') && !line.includes('--strict-mcp-config'), line);

  assert.deepEqual(launchCheck(r.cfg(), 'home', r.state, r.home), []);
  const again = r.plan();
  assert.deepEqual(again.changes, [], planText(again));
});

test('compile, a profile that is not strict granted Gmail: its user-level servers stay in the allow list, plugin servers are named', () => {
  const r = rig((t) => { t.defaults.deny = []; });
  const pl = r.plan();
  assert.ok(pl.changes.some((c) => c.includes('a user-level server added later loads after the next compile')), planText(pl));
  assert.ok(pl.notes.some((n) => /plugin/.test(n)));
  pl.apply();
  const rec = readRecord(r.cwd)!;
  assert.equal(rec.mcpStrict, false);
  assert.deepEqual(rec.mcpAllow, ['fx-rates', 'github', 'notes']);
  const s = lastSettings(claudeArgv(r.cfg().profiles.home, session));
  assert.deepEqual(s.allowedMcpServers, [{ serverName: 'fx-rates' }, { serverName: 'github' }, { serverName: 'notes' }, { serverUrl: GMAIL }]);
});

test('compile, no connector: a strict profile keeps its exact argv; one that is not strict drops the connectors, said in the change list', () => {
  // Strict, none granted: as before this kind.
  const r = rig((t) => { t.profiles.home.capabilities = ['fx-rates']; });
  r.plan().apply();
  const p = r.cfg().profiles.home;
  const argv = claudeArgv(p, session);
  const at = argv.indexOf('--strict-mcp-config');
  assert.deepEqual(argv.slice(at, at + 3), ['--strict-mcp-config', '--mcp-config', join(r.cwd, '.mcp.json')]);
  assert.ok(!argv.includes('--settings'), 'print mode passes no settings, as before');
  assert.deepEqual(tuiSettings(p, { hooks: 1 }), { hooks: 1 });
  assert.deepEqual(readRecord(r.cwd)!.connectors, []);

  // Not strict, compiled before connectors existed (no field in the record): the launch is as then.
  const n = rig((t) => { t.defaults.deny = []; t.profiles.home.capabilities = ['fx-rates']; });
  n.plan().apply();
  const recPath = join(n.cwd, RECORD);
  const old = JSON.parse(readFileSync(recPath, 'utf8'));
  delete old.connectors;
  writeFileSync(recPath, JSON.stringify(old));
  assert.deepEqual(mcpLaunch(n.cwd), { args: [], settings: {} }, 'an old record launches as it did');
  const pl = n.plan();
  assert.ok(pl.changes.some((c) => c.startsWith('- claude.ai connectors: this profile no longer loads the Claude app connectors')), planText(pl));
  pl.apply();
  const np = n.cfg().profiles.home;
  const nargv = claudeArgv(np, session);
  assert.ok(!nargv.includes('--strict-mcp-config') && !nargv.includes('--mcp-config'), 'user-level servers still load');
  assert.equal(lastSettings(nargv).disableClaudeAiConnectors, true);
  assert.equal(tuiSettings(np, {}).disableClaudeAiConnectors, true);
  assert.deepEqual(n.plan().changes, [], 'said once');
});

test('compile: a connector taken away goes back to the strict launch', () => {
  const r = rig();
  r.plan().apply();
  r.edit((t) => { t.profiles.home.capabilities = ['fx-rates']; });
  const pl = r.plan();
  assert.ok(pl.changes.includes(`- connector ${GMAIL}: no longer loads for this profile`), planText(pl));
  pl.apply();
  assert.deepEqual(mcpLaunch(r.cwd).args, ['--strict-mcp-config', '--mcp-config', join(r.cwd, '.mcp.json')]);
  assert.deepEqual(readGuard(r.state, 'home')!.mcp, { strict: true, connectors: [], allow: [], own: [], urls: [] });
  assert.deepEqual(launchCheck(r.cfg(), 'home', r.state, r.home), []);
});

test('compile on grok, agy, codex or pi grants no connector and says why', () => {
  for (const backend of ['grok', 'agy', 'codex', 'pi'] as const) {
    const r = rig((t) => { t.profiles.home.backend = backend; t.profiles.home.capabilities = ['gmail', 'drive']; });
    const pl = r.plan();
    assert.ok(pl.notes.includes(`Claude app connectors work only with Claude Code, so drive, gmail are not given to this ${backend} profile`), `${backend}: ${planText(pl)}`);
    pl.apply();
    assert.equal(readRecord(r.cwd)!.connectors, undefined);
    assert.ok(!existsSync(join(r.cwd, 'CLAUDE.md')) || !readFileSync(join(r.cwd, 'CLAUDE.md'), 'utf8').includes('connector'));
  }
});

test('launch check: a record changed after the compile, or an allowedMcpServers in the profile\'s settings, refuses the start', () => {
  const r = rig();
  r.plan().apply();
  assert.deepEqual(launchCheck(r.cfg(), 'home', r.state, r.home), []);
  // The agent widens its record: another connector.
  const recPath = join(r.cwd, RECORD);
  const rec = JSON.parse(readFileSync(recPath, 'utf8'));
  writeFileSync(recPath, JSON.stringify({ ...rec, connectors: [GMAIL, DRIVE] }));
  assert.match(launchCheck(r.cfg(), 'home', r.state, r.home).join('\n'), /MCP launch .* is not what the last compile wrote/);
  writeFileSync(recPath, JSON.stringify({ ...rec, mcpStrict: false }));
  assert.match(launchCheck(r.cfg(), 'home', r.state, r.home).join('\n'), /MCP launch/);
  writeFileSync(recPath, JSON.stringify(rec));
  // Measured: a list in settings.local.json is added to the one Angelia passes.
  writeFileSync(join(r.cwd, '.claude', 'settings.local.json'), JSON.stringify({ allowedMcpServers: [{ serverUrl: DRIVE }] }));
  assert.deepEqual(launchCheck(r.cfg(), 'home', r.state, r.home), ['.claude/settings.local.json lists allowedMcpServers, which Claude Code adds to the connectors this profile was granted; remove it']);
  const pl = r.plan();
  assert.match(pl.conflicts.join('\n'), /settings\.local\.json lists allowedMcpServers/);
  assert.throws(() => pl.apply(), /conflict/);
});

test('compile notes: a token in place of the claude.ai login, and settings that switch every connector off', () => {
  const r = rig();
  assert.ok(!r.plan().notes.some((n) => n.includes('CLAUDE_CODE_OAUTH_TOKEN')));
  assert.ok(r.plan({ CLAUDE_CODE_OAUTH_TOKEN: 'x' }).notes.includes('connectors load only with a claude.ai login, and CLAUDE_CODE_OAUTH_TOKEN is set in the environment the agent starts from: with that token Claude Code loads no connector'));
  r.edit((t) => { t.capabilities['fx-rates'].env = ['CLAUDE_CODE_OAUTH_TOKEN']; });
  assert.ok(r.plan().notes.some((n) => n.includes('an MCP capability of this profile declares CLAUDE_CODE_OAUTH_TOKEN')));
  mkdirSync(join(r.cwd, '.claude'), { recursive: true });
  writeFileSync(join(r.cwd, '.claude', 'settings.json'), JSON.stringify({ disableClaudeAiConnectors: true }));
  assert.ok(r.plan().notes.some((n) => n.includes('sets disableClaudeAiConnectors, so no connector loads')));
});

test('angelia ask keeps no connector, whatever the profile is granted', () => {
  const r = rig();
  r.plan().apply();
  const p = r.cfg().profiles.home;
  const ask = claudeAskArgv(p, undefined);
  assert.ok(ask.includes('--strict-mcp-config'));
  assert.equal(ask[ask.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.ok(!ask.join(' ').includes('allowedMcpServers'));
});

const guardPath = (r: { state: string }) => join(r.state, 'compiled', 'home.json');
const editJson = (f: string, m: (j: any) => void) => { const j = JSON.parse(readFileSync(f, 'utf8')); m(j); writeFileSync(f, JSON.stringify(j)); };

test('launch check fails closed under a current guard: a record gone, or without its connectors list, or a strict .mcp.json gone (review H1)', () => {
  for (const kind of ['open', 'strict', 'granted'] as const) {
    const r = rig((t) => {
      if (kind === 'open') { t.defaults.deny = []; t.profiles.home.capabilities = ['fx-rates']; }
      if (kind === 'strict') t.profiles.home.capabilities = ['fx-rates'];
    });
    r.plan().apply();
    assert.deepEqual(launchCheck(r.cfg(), 'home', r.state, r.home), [], kind);
    const recPath = join(r.cwd, RECORD), text = readFileSync(recPath, 'utf8');
    rmSync(recPath);
    assert.match(launchCheck(r.cfg(), 'home', r.state, r.home).join('\n'), /record is missing or lacks its connectors list/, `${kind}: record gone`);
    writeFileSync(recPath, text);
    editJson(recPath, (j) => { delete j.connectors; });
    assert.deepEqual(mcpLaunch(r.cwd).settings.disableClaudeAiConnectors, undefined, 'without the field the launch would load every connector');
    assert.match(launchCheck(r.cfg(), 'home', r.state, r.home).join('\n'), /lacks its connectors list/, `${kind}: field gone`);
    writeFileSync(recPath, text);
    assert.deepEqual(launchCheck(r.cfg(), 'home', r.state, r.home), []);
    if (kind === 'open') continue;
    rmSync(join(r.cwd, '.mcp.json'));
    assert.match(launchCheck(r.cfg(), 'home', r.state, r.home).join('\n'), kind === 'strict' ? /\.mcp\.json is gone, so the launch would not be strict/ : /\.mcp\.json is gone, so the launch would not load this profile's own servers/, `${kind}: .mcp.json gone`);
  }
  // The own servers and the remote addresses are in the guard too (review L1).
  const r = rig();
  r.plan().apply();
  editJson(join(r.cwd, RECORD), (j) => { j.mcpOwn = []; });
  assert.match(launchCheck(r.cfg(), 'home', r.state, r.home).join('\n'), /not what the last compile wrote/);
});

test('a guard from before connectors: a record that names them refuses, check-config names the profile, compile is not up to date (review M1)', () => {
  const r = rig((t) => { t.profiles.home.capabilities = ['fx-rates']; });
  r.plan().apply();
  editJson(guardPath(r), (g) => { delete g.mcp; });
  // The record as a compile from before connectors wrote it: starts as before.
  const recPath = join(r.cwd, RECORD);
  editJson(recPath, (j) => { delete j.connectors; });
  assert.deepEqual(launchCheck(r.cfg(), 'home', r.state, r.home), []);
  assert.ok(floorWarnings(r.cfg(), r.state, r.home).includes('profiles.home: compiled before Claude app connectors, so its MCP launch is not checked against the state folder; compile again: angelia compile --write home'));
  const pl = r.plan();
  assert.ok(pl.changes.some((c) => c.startsWith('+ MCP launch kept in the state folder')), planText(pl));
  // The agent writes connectors into it: refused.
  editJson(recPath, (j) => { j.connectors = [DRIVE, GMAIL]; j.mcpAllow = ['github']; });
  assert.deepEqual(launchCheck(r.cfg(), 'home', r.state, r.home), ['the compiled record names Claude app connectors, but its last compile was before them; compile again']);
  pl.apply();
  assert.deepEqual(launchCheck(r.cfg(), 'home', r.state, r.home), []);
  assert.ok(!floorWarnings(r.cfg(), r.state, r.home).some((w) => w.includes('compiled before Claude app connectors')));
  assert.deepEqual(r.plan().changes, []);
});

test('a remote MCP server beside a connector is let in by its address too, own and user-level (review M2, measured)', () => {
  const r = rig((t) => {
    t.defaults.deny = [];
    t.capabilities.remote = { kind: 'mcp', url: 'https://mcp.example.com/mcp' };
    t.profiles.home.capabilities.push('remote');
  });
  editJson(join(r.home, '.claude.json'), (j) => { j.mcpServers.tavily = { type: 'http', url: 'https://mcp.tavily.com/mcp' }; });
  const pl = r.plan();
  assert.deepEqual(pl.conflicts, []);
  pl.apply();
  const rec = readRecord(r.cwd)!;
  assert.deepEqual(rec.mcpUrls, ['https://mcp.example.com/mcp', 'https://mcp.tavily.com/mcp']);
  assert.deepEqual(rec.mcpAllow, ['fx-rates', 'github', 'notes', 'remote', 'tavily']);
  const s = lastSettings(claudeArgv(r.cfg().profiles.home, session));
  assert.deepEqual(s.allowedMcpServers.filter((e: any) => e.serverUrl), [{ serverUrl: 'https://mcp.example.com/mcp' }, { serverUrl: 'https://mcp.tavily.com/mcp' }, { serverUrl: GMAIL }]);
  assert.deepEqual(readGuard(r.state, 'home')!.mcp!.urls, rec.mcpUrls);
});

test('an unreadable settings.local.json on a connector profile refuses the start and the compile (review M3)', () => {
  const r = rig();
  r.plan().apply();
  writeFileSync(join(r.cwd, '.claude', 'settings.local.json'), `{"allowedMcpServers":[{"serverUrl":"${DRIVE}"}],}`);
  assert.deepEqual(launchCheck(r.cfg(), 'home', r.state, r.home), ['.claude/settings.local.json cannot be read, so Angelia cannot see whether it adds to the connectors this profile was granted; fix or remove it']);
  assert.throws(() => r.plan(), /settings\.local\.json is not valid JSON/);
  // A profile with no connector is not held to it here.
  const n = rig((t) => { t.profiles.home.capabilities = ['fx-rates']; });
  n.plan().apply();
  writeFileSync(join(n.cwd, '.claude', 'settings.local.json'), '{,}');
  assert.deepEqual(launchCheck(n.cfg(), 'home', n.state, n.home), []);
});

test('a server name Claude Code would drop from the allow list is a conflict on a connector profile (review L2)', () => {
  const r = rig((t) => { t.capabilities['my.srv'] = { kind: 'mcp', command: 'x' }; t.profiles.home.capabilities.push('my.srv'); });
  writeFileSync(join(r.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { 'hand made': { command: 'y' } } }));
  const pl = r.plan();
  assert.match(pl.conflicts.join('\n'), /"hand made" \(in .*\.mcp\.json\) has a character other than letters, digits/);
  assert.match(pl.conflicts.join('\n'), /"my\.srv"/);
  // Without a connector the name does no harm: strict mode loads the whole file.
  r.edit((t) => { t.profiles.home.capabilities = ['fx-rates', 'my.srv']; });
  assert.deepEqual(r.plan().conflicts, []);
});

test('the user-level servers are read from CLAUDE_CONFIG_DIR when it is set (review L4)', () => {
  const r = rig((t) => { t.defaults.deny = []; });
  const moved = join(r.root, 'claude-config');
  mkdirSync(moved);
  writeFileSync(join(moved, '.claude.json'), JSON.stringify({ mcpServers: { linear: { command: 'linear' } } }));
  writeFileSync(join(moved, 'settings.json'), JSON.stringify({ allowedMcpServers: [] }));
  const pl = r.plan({ CLAUDE_CONFIG_DIR: moved });
  pl.apply();
  assert.deepEqual(readRecord(r.cwd)!.mcpAllow, ['fx-rates', 'linear']);
  assert.ok(pl.notes.some((n) => n.startsWith(`${join(moved, 'settings.json')} lists allowedMcpServers`)));
});

test('the tmux fingerprint of a strict profile with no connector is the same with or without the connectors field', async () => {
  process.env.ANGELIA_STATE_DIR ??= mkdtempSync(join(tmpdir(), 'angelia-conn-state-'));
  const { TuiBrain } = await import('../src/brain/tui.js');
  const r = rig((t) => { t.profiles.home.capabilities = ['fx-rates']; t.profiles.home.tui = true; });
  r.plan().apply();
  const p = r.cfg().profiles.home;
  const fp = () => (new TuiBrain(p, { id: '11111111-2222-3333-4444-555555555555', started: true }, { bin: 'claude' }) as any).fingerprint(true);
  const now = fp();
  editJson(join(r.cwd, RECORD), (j) => { delete j.connectors; });
  assert.equal(fp(), now, 'a strict profile does not relaunch for this change');
  // A profile that is not strict does: its settings file gains disableClaudeAiConnectors.
  const n = rig((t) => { t.defaults.deny = []; t.profiles.home.capabilities = ['fx-rates']; t.profiles.home.tui = true; });
  n.plan().apply();
  const np = n.cfg().profiles.home;
  const nfp = () => (new TuiBrain(np, { id: '11111111-2222-3333-4444-555555555555', started: true }, { bin: 'claude' }) as any).fingerprint(true);
  const withField = nfp();
  editJson(join(n.cwd, RECORD), (j) => { delete j.connectors; });
  assert.notEqual(nfp(), withField);
});

test('a key in a remote server\'s address goes nowhere: the allow list holds scheme, host and path with a * (fix2 N1, measured)', () => {
  const KEY = 'tvly-SECRET123';
  const r = rig((t) => { t.defaults.deny = []; });
  editJson(join(r.home, '.claude.json'), (j) => { j.mcpServers.tavily = { type: 'http', url: `https://mcp.tavily.com/mcp/?tavilyApiKey=${KEY}` }; j.mcpServers.frag = { type: 'sse', url: `https://sse.example.com/s#${KEY}` }; });
  const pl = r.plan();
  pl.apply();
  assert.ok(!JSON.stringify(pl.changes).includes(KEY) && !JSON.stringify(pl.notes).includes(KEY));
  assert.ok(!pl.changes.some((c) => c.includes('https://mcp.tavily.com')), 'no address in the change list');
  const rec = readFileSync(join(r.cwd, RECORD), 'utf8');
  assert.ok(!rec.includes(KEY), 'not in the record');
  assert.deepEqual(readRecord(r.cwd)!.mcpUrls, ['https://mcp.tavily.com/mcp/*', 'https://sse.example.com/s*']);
  assert.ok(!readFileSync(guardPath(r), 'utf8').includes(KEY), 'not in the guard');
  const mcp = guardMcpLaunch(r.state, 'home', r.cwd)!;
  const p = r.cfg().profiles.home;
  const argv = claudeArgv(p, session, 'claude', undefined, mcp);
  assert.ok(!argv.join(' ').includes(KEY), 'not on the command line');
  assert.ok(!JSON.stringify(tuiSettings(p, {}, mcp)).includes(KEY), 'not in the tmux settings file');
  // The terminal line names the compile's settings file, never an address.
  const file = mcpSettingsFile(r.state, 'home');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), mcp.settings);
  const line = claudeTerminalLine(p, 'sid', r.home, { mcp, settingsFile: file });
  assert.ok(line.includes(`--settings ${file}`) && !line.includes('https://'), line);
  // A profile with no MCP keys has no such file.
  r.edit((t) => { t.defaults.deny = ['bank-api']; t.profiles.home.capabilities = ['fx-rates']; });
  r.plan().apply();
  assert.ok(!existsSync(file));
});

test('the daemon launches from the guard: a record the agent rewrote decides nothing (fix2 N1, L-a)', () => {
  const r = rig();
  r.plan().apply();
  const recPath = join(r.cwd, RECORD);
  editJson(recPath, (j) => { j.connectors = [GMAIL, DRIVE]; j.mcpAllow = ['fx-rates', 'mine', 'github']; });
  const mcp = guardMcpLaunch(r.state, 'home', r.cwd)!;
  assert.deepEqual(mcp.settings.allowedMcpServers, [{ serverName: 'fx-rates' }, { serverUrl: GMAIL }]);
  // A strict guard whose .mcp.json is gone loads nothing, not the user-level servers.
  const s = rig((t) => { t.profiles.home.capabilities = ['fx-rates']; });
  s.plan().apply();
  rmSync(join(s.cwd, '.mcp.json'));
  assert.deepEqual(guardMcpLaunch(s.state, 'home', s.cwd)!.args, ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']);
  // Another folder's guard, or none, gives nothing: the record path (and launchCheck) decide then.
  assert.equal(guardMcpLaunch(s.state, 'home', r.cwd), undefined);
  assert.equal(guardMcpLaunch(s.state, 'nobody', s.cwd), undefined);
});

test('a user-level server whose name Claude Code would drop is left off with a note; only this folder\'s names stop the compile (fix2 L-b)', () => {
  const r = rig((t) => { t.defaults.deny = []; });
  editJson(join(r.home, '.claude.json'), (j) => { j.mcpServers['my.tool'] = { command: 'x' }; });
  const pl = r.plan();
  assert.deepEqual(pl.conflicts, []);
  assert.ok(pl.notes.some((n) => n.startsWith('the user-level MCP server "my.tool" has a character other than')), planText(pl));
  pl.apply();
  assert.ok(!readRecord(r.cwd)!.mcpAllow!.includes('my.tool'));
});

test('a server added to .mcp.json by hand after the compile refuses a connector profile\'s start (fix2 L-d, measured: its dialog holds the pane)', () => {
  const r = rig();
  r.plan().apply();
  assert.deepEqual(launchCheck(r.cfg(), 'home', r.state, r.home), []);
  editJson(join(r.cwd, '.mcp.json'), (j) => { j.mcpServers.handmade = { command: 'y' }; });
  assert.deepEqual(launchCheck(r.cfg(), 'home', r.state, r.home), ['.mcp.json names "handmade", which the last compile did not (a server added by hand would hold the session on an approval dialog); compile again']);
  writeFileSync(join(r.cwd, '.mcp.json'), '{ broken');
  assert.ok(launchCheck(r.cfg(), 'home', r.state, r.home).includes('.mcp.json cannot be read; compile again'));
  // A strict profile with no connector never loads .mcp.json as the project's: not held to it.
  const s = rig((t) => { t.profiles.home.capabilities = ['fx-rates']; });
  s.plan().apply();
  editJson(join(s.cwd, '.mcp.json'), (j) => { j.mcpServers.handmade = { command: 'y' }; });
  assert.deepEqual(launchCheck(s.cfg(), 'home', s.state, s.home), []);
});

test('the warning Claude Code prints for the connectors an allow list leaves out is never a failure or a reason (fix2 L-e)', async () => {
  const WARN = 'Warning: claude.ai MCP servers blocked by enterprise policy: claude.ai Claude Docs, claude.ai Google Drive';
  assert.equal(exitReason(`${WARN}\n`), 'exit');
  assert.equal(exitReason(`not logged in\n${WARN}\n`), 'exit: not logged in');
  const dir = mkdtempSync(join(tmpdir(), 'angelia-conn-fake-'));
  const fake = (name: string, crash: boolean) => {
    const f = join(dir, name);
    writeFileSync(f, `#!/usr/bin/env node
process.stderr.write(${JSON.stringify(WARN + '\n')});
let buf = '';
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
  if (m.type !== 'user') continue;
  if (${crash}) process.exit(1);
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', apiKeySource: 'none', claude_code_version: '2.1.332' }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fine' })); } });
`, { mode: 0o755 });
    return f;
  };
  const { ClaudeBrain } = await import('../src/brain/claude.js');
  const profile = loadConfigFor(dir);
  for (const crash of [false, true]) {
    const b = new ClaudeBrain(profile, { id: '11111111-2222-3333-4444-555555555555', started: false }, { bin: fake(crash ? 'crash.mjs' : 'ok.mjs', crash) });
    b.start();
    const events = [];
    for await (const e of b.turn('hi')) events.push(e);
    const res = events.find((e) => e.kind === 'result') as any;
    if (crash) assert.equal(res.reason, 'exit', 'the warning is not the reason');
    else { assert.equal(res.isError, false); assert.equal(res.text, 'fine'); }
    assert.ok(!events.some((e: any) => String(e.text ?? '').includes('enterprise policy')), 'never in the chat');
    b.kill?.();
  }
});

function loadConfigFor(cwd: string) {
  const path = join(cwd, 'routing.yaml');
  writeFileSync(path, stringify({ profiles: { x: { cwd } }, routes: [] }));
  return loadConfig(path).profiles.x;
}

test('tmux: the connector warning on a pane above the prompt is not read as a dialog, a busy pane or a limit (fix2 L-e)', async () => {
  // Measured on claude 2.1.332: an interactive pane draws no such line; this holds if one ever does.
  const { paneBusy, paneIdle, permissionDialog, trustDialogOpen, importsDialogOpen, addDirDialog } = await import('../src/brain/tmux.js');
  const { isLimitText } = await import('../src/core/deliver/text.js');
  const WARN = 'Warning: claude.ai MCP servers blocked by enterprise policy: claude.ai Claude Docs, claude.ai Google Drive';
  const idle = readFileSync(join(import.meta.dirname, 'fixtures', 'pane-idle.txt'), 'utf8');
  const pane = `${WARN}\n${idle}`;
  assert.equal(paneIdle(pane), paneIdle(idle));
  assert.equal(paneBusy(pane), paneBusy(idle));
  assert.equal(permissionDialog(pane), null);
  assert.equal(trustDialogOpen(pane) || importsDialogOpen(pane), false);
  assert.equal(addDirDialog(pane), null);
  assert.equal(isLimitText(WARN), false);
});

test('an instance compiled before connectors: one compile --write, and the next plan is clean, for every kind of profile (fix2 N2)', () => {
  for (const kind of ['strict', 'open', 'granted', 'open-granted'] as const) {
    const r = rig((t) => {
      if (kind.startsWith('open')) t.defaults.deny = [];
      if (!kind.includes('granted')) t.profiles.home.capabilities = ['fx-rates'];
    });
    r.plan().apply();
    // As the last release left it: no connectors in the record, no MCP launch in the guard.
    editJson(join(r.cwd, RECORD), (j) => { for (const k of ['connectors', 'mcpAllow', 'mcpOwn', 'mcpUrls']) delete j[k]; });
    editJson(guardPath(r), (g) => { delete g.mcp; });
    rmSync(mcpSettingsFile(r.state, 'home'), { force: true });
    const pl = r.plan();
    assert.ok(pl.changes.length, `${kind}: the upgrade is a change`);
    pl.apply();
    assert.deepEqual(r.plan().changes, [], `${kind}: clean after one write`);
    assert.deepEqual(launchCheck(r.cfg(), 'home', r.state, r.home), [], kind);
    assert.ok(!floorWarnings(r.cfg(), r.state, r.home).some((w) => w.includes('compiled before Claude app connectors')), kind);
  }
});
