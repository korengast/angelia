import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { loadConfig, ConfigError, configWarnings } from '../src/instance/config/load.js';
import { resolveProfile } from '../src/capabilities/resolve.js';
import { planProfile, planText, readRecord, strictMcpArgs, pathRule, linkText, RECORD, launchCheck, seedGuards, floorWarnings, profileFloor, nestingWarnings } from '../src/capabilities/compile.js';
import { claudeArgv } from '../src/brain/argv.js';
import { SELF_START } from '../src/daemon/self.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'angelia-cap-'));

/** A skill library, a profile folder, and a table written to disk so the real loader reads it. */
function rig(extra: (lib: string, cwd: string) => Record<string, unknown> = () => ({})) {
  const root = tmp();
  const lib = join(root, 'skills');
  for (const s of ['fitness', 'ledger', 'maps']) { mkdirSync(join(lib, s), { recursive: true }); writeFileSync(join(lib, s, 'SKILL.md'), `---\nname: ${s}\n---\n`); }
  const cwd = join(root, 'profile');
  mkdirSync(cwd);
  const home = join(root, 'home');
  mkdirSync(home);
  const table = {
    capabilities: {
      transcribe: { kind: 'command', run: 'angelia transcribe <path>', when: 'a voice note arrives' },
      fitness: { kind: 'skill', path: join(lib, 'fitness') },
      maps: { kind: 'skill', path: join(lib, 'maps') },
      'ledger': { kind: 'skill', path: join(lib, 'ledger'), secrets: [join(root, 'secrets', 'bank')] },
      'bank-api': { kind: 'mcp', command: 'bash', args: ['bank.sh'], env: ['BANK_USER'], when: 'balances' },
      'fx-rates': { kind: 'mcp', command: 'node', args: ['fx.js'], when: 'exchange rates' },
    },
    defaults: { capabilities: ['transcribe', 'maps'], deny: ['ledger', 'bank-api'] },
    profiles: { home: { cwd, permission_mode: 'acceptEdits', capabilities: ['fitness', 'fx-rates'] } },
    routes: [{ platform: 'telegram', chat: 1, profile: 'home' }],
    telegram: {},
    ...extra(lib, cwd),
  };
  const path = join(root, 'routing.yaml');
  writeFileSync(path, stringify(table));
  return { root, lib, cwd, home, path, cfg: () => loadConfig(path) };
}

function writeTable(path: string, mutate: (t: any) => void) {
  const t = parse(readFileSync(path, 'utf8'));
  mutate(t);
  writeFileSync(path, stringify(t));
}

test('the loader refuses unknown names, a name both given and denied, and a secret value where a name belongs', () => {
  const r = rig();
  writeTable(r.path, (t) => { t.profiles.home.deny = ['nope']; });
  assert.throws(() => r.cfg(), /profiles\.home\.deny: unknown capability "nope"/);
  writeTable(r.path, (t) => { t.profiles.home.deny = ['fitness']; });
  assert.throws(() => r.cfg(), /fitness both given and denied/);
  writeTable(r.path, (t) => { delete t.profiles.home.deny; t.capabilities['bank-api'].env = ['BANK_USER=hunter2']; });
  assert.throws(() => r.cfg(), ConfigError);
  writeTable(r.path, (t) => { t.capabilities['bank-api'].env = ['BANK_USER']; t.capabilities.x = { kind: 'mcp', when: 'no command' }; });
  assert.throws(() => r.cfg(), /either command or url/);
});

test('precedence: defaults, except, the profile lifting a default deny, and the profile deny beating all', () => {
  const r = rig();
  let res = resolveProfile(r.cfg(), 'home');
  assert.deepEqual([...res.allowed.keys()], ['fitness', 'fx-rates', 'maps', 'transcribe']);
  assert.deepEqual([...res.denied.keys()], ['bank-api', 'ledger']);
  writeTable(r.path, (t) => { t.profiles.home.except = ['maps']; t.profiles.home.capabilities.push('bank-api'); t.profiles.home.deny = ['transcribe']; });
  res = resolveProfile(r.cfg(), 'home');
  assert.deepEqual([...res.allowed.keys()], ['bank-api', 'fitness', 'fx-rates']);
  assert.deepEqual([...res.denied.keys()], ['ledger', 'transcribe']);
});

test('compile (claude-code): links, strict MCP, deny floor in the //abs form, a managed block; hand entries survive; a rerun is a no-op', () => {
  const r = rig();
  mkdirSync(join(r.cwd, '.claude'));
  writeFileSync(join(r.cwd, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Read(~/.old-gateway/.env)'] }, model: 'x' }));
  writeFileSync(join(r.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'mine' } } }));
  writeFileSync(join(r.cwd, 'CLAUDE.md'), '# Home\nFor a voice note run angelia transcribe on it.\n');

  const pl = planProfile(r.cfg(), 'home', { home: r.home });
  assert.deepEqual(pl.conflicts, []);
  assert.ok(pl.changes.includes(`+ skill link fitness → ${join(r.lib, 'fitness')}`));
  assert.ok(pl.changes.some((c) => c.startsWith('+ strict MCP')));
  assert.match(pl.duplicates[0], /angelia transcribe/);
  pl.apply();

  assert.equal(readlinkSync(join(r.cwd, '.claude', 'skills', 'fitness')), join(r.lib, 'fitness'));
  assert.ok(!existsSync(join(r.cwd, '.claude', 'skills', 'ledger')), 'a denied skill is absent, not merely denied');
  const mcp = JSON.parse(readFileSync(join(r.cwd, '.mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ['fx-rates', 'mine']);
  assert.ok(!('bank-api' in mcp.mcpServers));
  const settings = JSON.parse(readFileSync(join(r.cwd, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'x');
  assert.ok(settings.permissions.deny.includes('Read(~/.old-gateway/.env)'), 'the hand entry survives');
  assert.ok(settings.permissions.deny.includes('mcp__bank-api'));
  assert.ok(settings.permissions.deny.includes('Skill(ledger)'));
  assert.ok(settings.permissions.deny.includes(`Read(/${join(r.lib, 'ledger')}/**)`), 'Claude reads //abs as absolute');
  assert.ok(settings.permissions.deny.includes(`Read(/${join(r.root, 'secrets', 'bank')})`));
  const md = readFileSync(join(r.cwd, 'CLAUDE.md'), 'utf8');
  assert.ok(md.includes(SELF_START) && md.includes('- transcribe: run `angelia transcribe <path>` when a voice note arrives.'));
  assert.ok(md.includes('# Home\nFor a voice note'), 'hand text kept');
  assert.equal(readRecord(r.cwd)!.mcpStrict, true);
  assert.deepEqual(strictMcpArgs(r.cwd), ['--strict-mcp-config', '--mcp-config', join(r.cwd, '.mcp.json')]);
  const argv = claudeArgv(r.cfg().profiles.home, { id: 's', started: false });
  assert.ok(argv.includes('--strict-mcp-config'));

  const again = planProfile(r.cfg(), 'home', { home: r.home });
  assert.deepEqual(again.changes, [], planText(again));
});

test('compile: a profile that denies no MCP server is not strict, so user-level servers still load', () => {
  const r = rig();
  writeTable(r.path, (t) => { t.profiles.home.capabilities.push('bank-api', 'ledger'); });
  const pl = planProfile(r.cfg(), 'home', { home: r.home });
  assert.ok(!pl.changes.some((c) => c.includes('strict MCP')));
  assert.ok(pl.notes.some((n) => /not strict/.test(n)));
  pl.apply();
  assert.equal(readRecord(r.cwd)!.mcpStrict, false);
  assert.deepEqual(strictMcpArgs(r.cwd), []);
  writeTable(r.path, (t) => { t.profiles.home.capabilities = t.profiles.home.capabilities.filter((n: string) => n !== 'bank-api'); });
  assert.ok(planProfile(r.cfg(), 'home', { home: r.home }).changes.includes('+ strict MCP: only this folder\'s .mcp.json is loaded; user-level servers (such as github, tavily) are left out'));
});

test('compile removes only what it wrote when a capability goes away', () => {
  const r = rig();
  planProfile(r.cfg(), 'home', { home: r.home }).apply();
  const settingsPath = join(r.cwd, '.claude', 'settings.json');
  const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
  s.permissions.deny.push('Bash(rm -rf *)');
  writeFileSync(settingsPath, JSON.stringify(s));
  writeTable(r.path, (t) => { t.profiles.home.capabilities = ['fx-rates']; t.defaults.deny = ['bank-api']; });
  const pl = planProfile(r.cfg(), 'home', { home: r.home });
  assert.ok(pl.changes.includes('- skill link fitness'));
  pl.apply();
  assert.ok(!existsSync(join(r.cwd, '.claude', 'skills', 'fitness')));
  const after = JSON.parse(readFileSync(settingsPath, 'utf8')).permissions.deny;
  assert.ok(after.includes('Bash(rm -rf *)'), 'a hand deny entry is never removed');
  assert.ok(!after.includes('Skill(ledger)'), 'an entry compile wrote and no longer wants is removed');
  assert.ok(after.includes('mcp__bank-api'));
});

test('compile refuses rather than fixes: a hand server that is denied, a denied skill left in place, one installed for everyone', () => {
  const r = rig();
  writeFileSync(join(r.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { 'bank-api': { command: 'bash' } } }));
  mkdirSync(join(r.cwd, '.claude', 'skills'), { recursive: true });
  symlinkSync(join(r.lib, 'ledger'), join(r.cwd, '.claude', 'skills', 'ledger'));
  mkdirSync(join(r.home, '.claude', 'skills', 'ledger'), { recursive: true });
  const pl = planProfile(r.cfg(), 'home', { home: r.home });
  assert.equal(pl.conflicts.length, 3, planText(pl));
  assert.match(pl.conflicts.join('\n'), /lists "bank-api", which this profile denies/);
  assert.match(pl.conflicts.join('\n'), /typed as \/ledger/);
  assert.match(pl.conflicts.join('\n'), /installed for every profile/);
  assert.throws(() => pl.apply(), /3 conflict/);
  assert.ok(!existsSync(join(r.cwd, RECORD)), 'nothing written');
});

test('compile (grok): /abs path rules, self text and lines in one block, allowed MCP left as a note', () => {
  const r = rig();
  writeTable(r.path, (t) => { t.profiles.home.backend = 'grok'; });
  writeFileSync(join(r.home, '.claude.json'), JSON.stringify({ mcpServers: { github: {}, 'fx-rates': {} }, projects: { secret: 'x' } }));
  const pl = planProfile(r.cfg(), 'home', { home: r.home, self: (n) => `SELF ${n}` });
  assert.match(pl.notes.join('\n'), /grok: allowed MCP servers are not written yet \(fx-rates\)/);
  pl.apply();
  const deny = JSON.parse(readFileSync(join(r.cwd, '.claude', 'settings.json'), 'utf8')).permissions.deny;
  assert.ok(deny.includes(`Read(${join(r.lib, 'ledger')}/**)`), 'grok reads /abs as absolute');
  assert.ok(!deny.some((d: string) => d.startsWith('Skill(')), 'grok skips Skill() as an unknown prefix');
  assert.ok(deny.includes('mcp__github'), 'a user-level server grok would load is denied by name');
  assert.ok(!deny.includes('mcp__fx-rates'), 'unless the profile was given it');
  assert.ok(!existsSync(join(r.cwd, '.mcp.json')));
  const md = readFileSync(join(r.cwd, 'CLAUDE.md'), 'utf8');
  assert.ok(md.indexOf('SELF home') < md.indexOf('- transcribe:'));
  assert.equal(readRecord(r.cwd)!.mcpStrict, false);
  assert.equal(pathRule('Read', '/a/b', 'claude-code'), 'Read(//a/b)');
  assert.equal(pathRule('Read', '/a/b', 'grok'), 'Read(/a/b)');
  writeFileSync(join(r.cwd, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: [...deny, 'Read(~/.env)'] } }));
  assert.match(planProfile(r.cfg(), 'home', { home: r.home, self: (n) => `SELF ${n}` }).notes.join('\n'), /grok ignores rules written with ~.*deny Read\(~\/\.env\)/);
  assert.equal(pathRule('Read', '/h/me/x/**', 'claude-code', '/h/me'), 'Read(~/x/**)', 'Claude: under home as ~/');
  assert.equal(pathRule('Read', '/h/meow/x', 'claude-code', '/h/me'), 'Read(//h/meow/x)', 'a sibling folder is not under home');
  assert.equal(pathRule('Read', '/h/me/x', 'grok', '/h/me'), 'Read(/h/me/x)', 'grok ignores ~ (measured), so it keeps /abs');
  // A malformed user file is not read as "no servers": that would drop every mcp__ deny on this write.
  writeFileSync(join(r.home, '.claude.json'), '{"mcpServers": {"github": {}');
  assert.throws(() => planProfile(r.cfg(), 'home', { home: r.home }), /\.claude\.json is not valid JSON/);
});

test('an uncompiled profile gets no MCP flags', () => {
  assert.deepEqual(strictMcpArgs(tmp()), []);
});

/** A workspace laid out as the guide says: the table at its root, a skill in _capabilities/. */
function workspaceRig() {
  const home = tmp();
  const ws = join(home, '.angelia', 'workspace');
  const skill = join(ws, '_capabilities', 'skills', 'coach');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: coach\n---\n');
  const outside = join(home, 'old-skills', 'maps');
  mkdirSync(outside, { recursive: true });
  const cwd = join(ws, 'profiles', 'home');
  mkdirSync(cwd, { recursive: true });
  const path = join(ws, 'routing.yaml');
  writeFileSync(path, stringify({
    capabilities: {
      coach: { kind: 'skill', path: '_capabilities/skills/coach' },
      maps: { kind: 'skill', path: outside },
      docs: { kind: 'directory', path: join(home, 'Documents') },
    },
    profiles: { home: { cwd, permission_mode: 'acceptEdits', capabilities: ['coach', 'maps'] } },
    routes: [{ platform: 'telegram', chat: 1, profile: 'home' }],
    telegram: {},
  }));
  return { home, ws, skill, outside, cwd, path };
}

test('a relative capability path is read from the table\'s folder, not from where the command runs', () => {
  const r = workspaceRig();
  const here = process.cwd();
  try {
    process.chdir(tmpdir());
    assert.equal((loadConfig(r.path).capabilities.coach as { path: string }).path, r.skill);
  } finally { process.chdir(here); }
});

test('check-config warns about a skill outside the workspace, not about a data folder', () => {
  const r = workspaceRig();
  const w = configWarnings(loadConfig(r.path), r.ws);
  assert.ok(w.some((l) => /capabilities\.maps: the skill lives outside the workspace/.test(l) && l.includes('_capabilities/skills/maps')), w.join('\n'));
  assert.ok(!w.some((l) => l.startsWith('capabilities.coach')), w.join('\n'));
  assert.ok(!w.some((l) => /capabilities\.docs: .*outside/.test(l)), w.join('\n'));
  assert.ok(!configWarnings(loadConfig(r.path)).some((l) => /outside the workspace/.test(l)), 'no workspace given: no such warning');
});

test('a skill in the workspace is linked relatively, so a clone on another machine still resolves it', () => {
  const r = workspaceRig();
  const pl = planProfile(loadConfig(r.path), 'home', { home: r.home });
  assert.deepEqual(pl.conflicts, []);
  pl.apply();
  const coach = readlinkSync(join(r.cwd, '.claude', 'skills', 'coach'));
  assert.equal(coach, join('..', '..', '..', '..', '_capabilities', 'skills', 'coach'));
  assert.ok(existsSync(join(r.cwd, '.claude', 'skills', 'coach', 'SKILL.md')));
  // Outside the workspace, sharing only the home folder: the full path, as before.
  assert.equal(readlinkSync(join(r.cwd, '.claude', 'skills', 'maps')), r.outside);
  assert.equal(linkText('/srv/a/x', '/srv/b', '/home/example'), join('..', 'a', 'x'));
  assert.equal(linkText('/opt/x', '/srv/b', '/home/example'), '/opt/x');
  // Compiling again changes nothing: the relative link is recognised as ours.
  assert.deepEqual(planProfile(loadConfig(r.path), 'home', { home: r.home }).changes, []);
});

test('an absolute link to a workspace skill is out of date: --check reports it, --write makes it relative in place', () => {
  const r = workspaceRig();
  const at = join(r.cwd, '.claude', 'skills', 'coach');
  mkdirSync(join(r.cwd, '.claude', 'skills'), { recursive: true });
  symlinkSync(r.skill, at); // as compile wrote it before cec92ec
  const pl = planProfile(loadConfig(r.path), 'home', { home: r.home });
  assert.ok(pl.changes.some((c) => c.startsWith('~ skill link coach → ../')), pl.changes.join('\n'));
  pl.apply();
  assert.equal(readlinkSync(at), join('..', '..', '..', '..', '_capabilities', 'skills', 'coach'));
  assert.ok(existsSync(join(at, 'SKILL.md')));
  assert.deepEqual(planProfile(loadConfig(r.path), 'home', { home: r.home }).changes, []);
});

test('every profile gets the deny floor on the instance\'s own secrets, with no capability at all, and check-config names a profile without it', async () => {
  const { floorWarnings, floorRules } = await import('../src/capabilities/compile.js');
  const { Config } = await import('../src/instance/config/schema.js');
  const home = mkdtempSync(join(tmpdir(), 'angelia-floor-home-'));
  const cwd = join(home, '.angelia', 'workspace', 'profiles', 'plain');
  mkdirSync(cwd, { recursive: true });
  const cfg = Config.parse({ profiles: { plain: { cwd }, g: { cwd: join(home, 'g'), backend: 'grok' } }, routes: [] });
  assert.equal(floorWarnings(cfg, join(home, '.angelia'), home).length, 2, 'neither profile has it yet');
  planProfile(cfg, 'plain', { home }).apply();
  const deny: string[] = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8')).permissions.deny;
  for (const r of ['Read(~/.angelia/env)', 'Edit(~/.angelia/env)', 'Read(~/.angelia/wa/**)', 'Read(~/.angelia/api.token)', 'Read(~/.angelia/tui/**)', 'Read(~/.angelia/sessions.json)']) assert.ok(deny.includes(r), r);
  assert.ok(!existsSync(join(cwd, '.mcp.json')), 'no capability, no .mcp.json');
  assert.ok(!deny.some((d) => /daemon\.log|status\.json/.test(d)), 'the logs stay readable: the agent mending the setup needs them');
  assert.deepEqual(floorWarnings(cfg, join(home, '.angelia'), home).map((w) => w.split(':')[0]), ['profiles.g']);
  // grok reads path rules only as absolute paths.
  assert.ok(floorRules('grok', join(home, '.angelia'), home).includes(`Read(${join(home, '.angelia', 'env')})`));
  // Recompiling adds nothing twice.
  assert.deepEqual(planProfile(cfg, 'plain', { home }).changes, []);
});

test('the files that decide the next launch are edit-denied; the instruction file and skills stay writable', async () => {
  const { Config } = await import('../src/instance/config/schema.js');
  const home = mkdtempSync(join(tmpdir(), 'angelia-launch-home-'));
  const cwd = join(home, 'p');
  mkdirSync(cwd, { recursive: true });
  const cfg = Config.parse({ profiles: { p: { cwd } }, routes: [] });
  planProfile(cfg, 'p', { home }).apply();
  const deny: string[] = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8')).permissions.deny;
  for (const f of ['.claude/settings.json', '.claude/settings.local.json', '.claude/angelia-compiled.json', '.mcp.json', 'angelia-jobs.yaml']) assert.ok(deny.includes(`Edit(~/p/${f})`), f);
  assert.ok(!deny.some((d) => /CLAUDE\.md|skills/.test(d)), 'its own instructions and skills are its to write');
});

test('sandbox: the API socket is always reachable; sandbox: true turns it on with no escape; off again removes only ours', () => {
  const r = rig();
  const state = join(r.home, '.angelia');
  const settings = () => JSON.parse(readFileSync(join(r.cwd, '.claude', 'settings.json'), 'utf8'));
  mkdirSync(join(r.cwd, '.claude'), { recursive: true });
  writeFileSync(join(r.cwd, '.claude', 'settings.json'), JSON.stringify({ sandbox: { network: { allowedDomains: ['example.com'] } } }));
  planProfile(r.cfg(), 'home', { home: r.home, stateDir: state }).apply();
  assert.deepEqual(settings().sandbox, { network: { allowedDomains: ['example.com'], allowUnixSockets: [join(state, 'api.sock')] } }, 'the socket, next to what the owner wrote');
  assert.equal(settings().sandbox.enabled, undefined, 'off unless the profile asks');

  writeTable(r.path, (t) => { t.profiles.home.sandbox = true; });
  assert.deepEqual(launchCheck(r.cfg(), 'home', state), [], 'the table asking for more is not a refusal until it is compiled');
  planProfile(r.cfg(), 'home', { home: r.home, stateDir: state }).apply();
  assert.equal(settings().sandbox.enabled, true);
  assert.equal(settings().sandbox.allowUnsandboxedCommands, false, 'no way around it');
  assert.deepEqual(launchCheck(r.cfg(), 'home', state), []);
  const file = join(r.cwd, '.claude', 'settings.json');
  writeFileSync(file, JSON.stringify({ ...settings(), sandbox: { ...settings().sandbox, enabled: false } }));
  assert.deepEqual(launchCheck(r.cfg(), 'home', state), ['sandbox off']);
  planProfile(r.cfg(), 'home', { home: r.home, stateDir: state }).apply();
  writeFileSync(join(r.cwd, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: { allowUnsandboxedCommands: true } }));
  assert.deepEqual(launchCheck(r.cfg(), 'home', state), ['sandbox off in settings.local.json']);
  writeFileSync(join(r.cwd, '.claude', 'settings.local.json'), '{}');

  writeTable(r.path, (t) => { t.profiles.home.sandbox = false; });
  planProfile(r.cfg(), 'home', { home: r.home, stateDir: state }).apply();
  assert.deepEqual(settings().sandbox, { network: { allowedDomains: ['example.com'], allowUnixSockets: [join(state, 'api.sock')] } });
});

test('launch guard: fails closed when never compiled, when a rule the compile wrote is gone, when the settings or the record break', () => {
  const r = rig();
  const state = join(r.home, '.angelia');
  assert.deepEqual(launchCheck(r.cfg(), 'home', state), ['never compiled']);
  planProfile(r.cfg(), 'home', { home: r.home, stateDir: state }).apply();
  assert.deepEqual(launchCheck(r.cfg(), 'home', state), []);
  const file = join(r.cwd, '.claude', 'settings.json');
  const s = JSON.parse(readFileSync(file, 'utf8'));
  const gone = s.permissions.deny.filter((d: string) => d.includes('api.token') || d.includes('/env'));
  assert.ok(gone.length >= 4, 'Read and Edit of the env file and the API token');
  writeFileSync(file, JSON.stringify({ ...s, permissions: { ...s.permissions, deny: s.permissions.deny.filter((d: string) => !gone.includes(d)) } }));
  assert.deepEqual(launchCheck(r.cfg(), 'home', state), gone.map((d: string) => `deny ${d}`));
  // The profile's own record deleted: the guard lives in the state folder, so it still holds.
  rmSync(join(r.cwd, RECORD));
  assert.equal(launchCheck(r.cfg(), 'home', state).length, gone.length);
  // A settings file the CLI would drop, with every deny rule in it.
  writeFileSync(file, '{ not json');
  assert.match(launchCheck(r.cfg(), 'home', state)[0], /settings\.json cannot be read/);
  assert.throws(() => planProfile(r.cfg(), 'home', { home: r.home, stateDir: state }), /not valid JSON/, 'compile does not guess either');
  writeFileSync(file, '{}');
  planProfile(r.cfg(), 'home', { home: r.home, stateDir: state }).apply();
  assert.deepEqual(launchCheck(r.cfg(), 'home', state), [], 'a compile restores it');
  // A floor that grew since (an update) is named by floorWarnings, not refused.
  writeTable(r.path, (t) => { t.profiles.other = { cwd: r.lib }; t.routes.push({ platform: 'telegram', chat: 2, profile: 'other' }); });
  assert.deepEqual(launchCheck(r.cfg(), 'home', state), []);
  assert.equal(floorWarnings(r.cfg(), state, r.home).filter((w) => w.startsWith('profiles.home')).length, 1);
});

test('seedGuards: an instance compiled before the state-side guard keeps running, once', () => {
  const r = rig();
  const state = join(r.home, '.angelia');
  writeTable(r.path, (t) => { t.profiles.other = { cwd: r.lib }; });
  planProfile(r.cfg(), 'home', { home: r.home, stateDir: state }).apply();
  planProfile(r.cfg(), 'other', { home: r.home, stateDir: state }).apply();
  rmSync(join(state, 'compiled'), { recursive: true });
  // One profile compiled again before the first start of this version: its guard is kept, the other seeded.
  planProfile(r.cfg(), 'other', { home: r.home, stateDir: state }).apply();
  assert.deepEqual(launchCheck(r.cfg(), 'home', state), ['never compiled']);
  assert.deepEqual(seedGuards(r.cfg(), state), ['home']);
  assert.deepEqual(launchCheck(r.cfg(), 'home', state), []);
  rmSync(join(state, 'compiled', 'home.json'));
  assert.deepEqual(seedGuards(r.cfg(), state), [], 'only once');
  assert.deepEqual(launchCheck(r.cfg(), 'home', state), ['never compiled'], 'a guard gone after that is not re-seeded');
});

test('the floor: other profiles\' folders and your credentials are denied, unless the profile was handed them', async () => {
  const { Config } = await import('../src/instance/config/schema.js');
  const home = mkdtempSync(join(tmpdir(), 'angelia-others-'));
  const ws = join(home, '.angelia', 'workspace');
  const dir = (n: string) => { const d = join(ws, 'profiles', n); mkdirSync(d, { recursive: true }); return d; };
  const cfg = Config.parse({
    profiles: {
      family: { cwd: dir('family') }, money: { cwd: dir('money') },
      master: { cwd: dir('master'), add_dirs: [ws] },
      deploy: { cwd: dir('deploy'), add_dirs: [join(home, '.ssh')] },
    },
    routes: [],
  });
  const floor = (n: string) => profileFloor(cfg, n, join(home, '.angelia'), home);
  assert.ok(floor('family').includes('Read(~/.angelia/workspace/profiles/money/**)'));
  assert.ok(floor('family').includes('Edit(~/.angelia/workspace/profiles/master/**)'));
  assert.ok(!floor('family').some((r) => r.includes('profiles/family')), 'never its own folder');
  assert.ok(!floor('master').some((r) => r.includes('/profiles/')), 'the workspace in add_dirs reaches every profile');
  for (const c of ['Read(~/.ssh/**)', 'Read(~/.aws/**)', 'Read(~/.config/gh/**)', 'Read(~/Library/Keychains/**)', 'Read(~/.netrc)', 'Edit(~/.ssh/**)']) assert.ok(floor('family').includes(c), c);
  assert.ok(floor('master').includes('Read(~/.ssh/**)'), 'a wide grant does not lift a credential');
  assert.ok(!floor('deploy').includes('Read(~/.ssh/**)') && floor('deploy').includes('Read(~/.aws/**)'), 'naming the folder lifts that one only');
  // A folder inside another profile's: the outer is not denied to the inner (it would lock it out), and check-config says so.
  const nested = Config.parse({ profiles: { outer: { cwd: ws }, inner: { cwd: dir('inner') } }, routes: [] });
  assert.ok(!profileFloor(nested, 'inner', join(home, '.angelia'), home).some((r) => r.includes('workspace/**')));
  assert.equal(nestingWarnings(nested, home).length, 1);
});

test('the commit gate\'s drift check runs on a table with no capabilities: a floor rule removed by hand is named', async () => {
  const { compileDrift } = await import('../src/capabilities/cli.js');
  const { Config } = await import('../src/instance/config/schema.js');
  const home = mkdtempSync(join(tmpdir(), 'angelia-drift-'));
  const cwd = join(home, 'p');
  mkdirSync(cwd);
  const cfg = Config.parse({ profiles: { p: { cwd } }, routes: [] });
  const state = join(home, '.angelia');
  planProfile(cfg, 'p', { home, stateDir: state }).apply();
  assert.equal(compileDrift(cfg, join(home, 'routing.yaml'), [], { home, stateDir: state }), '');
  const file = join(cwd, '.claude', 'settings.json');
  const s = JSON.parse(readFileSync(file, 'utf8'));
  s.permissions.deny = s.permissions.deny.filter((d: string) => !d.includes('api.token'));
  writeFileSync(file, JSON.stringify(s));
  assert.match(compileDrift(cfg, join(home, 'routing.yaml'), [], { home, stateDir: state }), /\+ deny Read\(~\/\.angelia\/api\.token\)[\s\S]*Out of date: p/);
});

test('the co-working folder: every profile that is not isolated gets it as an extra folder; an isolated one is denied it', async () => {
  const { Config } = await import('../src/instance/config/schema.js');
  const home = mkdtempSync(join(tmpdir(), 'angelia-common-'));
  const ws = join(home, '.angelia', 'workspace');
  const dir = (n: string) => { const d = join(ws, 'profiles', n); mkdirSync(d, { recursive: true }); return d; };
  const cfg = Config.parse({ profiles: { open: { cwd: dir('open') }, shut: { cwd: dir('shut'), isolated: true } }, routes: [] });
  planProfile(cfg, 'open', { home }).apply();
  planProfile(cfg, 'shut', { home }).apply();
  const settings = (n: string) => JSON.parse(readFileSync(join(ws, 'profiles', n, '.claude', 'settings.json'), 'utf8')).permissions;
  assert.deepEqual(settings('open').additionalDirectories, [join(ws, '_common')]);
  assert.ok(existsSync(join(ws, '_common')), 'made when a profile gets it');
  assert.equal(settings('shut').additionalDirectories, undefined);
  assert.ok(settings('shut').deny.includes('Read(~/.angelia/workspace/_common/**)') && settings('shut').deny.includes('Edit(~/.angelia/workspace/_common/**)'));
  assert.ok(!settings('open').deny.some((r: string) => r.includes('_common')));
});
