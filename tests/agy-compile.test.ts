import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Config } from '../src/instance/config/schema.js';
import { agyWarnings, launchCheck, planProfile, readGuard, readRecord, profileFloor } from '../src/capabilities/compile.js';
import { AGY_HEADER, AGY_INSTRUCTIONS, AGY_TOOL_RULE, agyInstructionsText, agyLaunchProblems, expandImports, mcpConfigServers } from '../src/brain/agy-instructions.js';
import { acpMcpServers, agyMcpServers, prepareAgyStart } from '../src/brain/agy-config.js';
import { agyGeminiPath } from '../src/brain/cache.js';
import { parseAgyModels } from '../src/brain/catalog.js';
import { MIN_AGY_VERSION, cliWarnings, olderThan } from '../src/brain/locate.js';
import { jobSandboxed } from '../src/jobs/jobs.js';

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'angelia-agyc-')));
const put = (f: string, text: string) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };

test('imports: relative to the importing file, ~ and absolute, nested, a cycle once, fences and spans left alone', () => {
  const d = scratch(), home = join(d, 'home');
  put(join(d, 'p', 'CLAUDE.md'), '');
  put(join(d, 'p', 'memory', 'a.md'), 'A1\n@sub/b.md');
  put(join(d, 'p', 'memory', 'sub', 'b.md'), 'B1 (relative to b.md) @../a.md');
  put(join(home, 'h.md'), 'HOME');
  put(join(d, 'abs.md'), 'ABS');
  const text = ['top', '@memory/a.md', 'see @~/h.md.', `@${join(d, 'abs.md')}`, '```', '@memory/a.md', '```', 'span `@memory/a.md` here', 'mail me @nobody or a@b.c', ''].join('\n');
  const out = expandImports(join(d, 'p', 'CLAUDE.md'), text, { home });
  const lines = out.split('\n');
  assert.deepEqual(lines.slice(0, 4), ['top', 'A1', 'B1 (relative to b.md) @../a.md', 'see @~/h.md.'], out);
  assert.equal(lines[4], 'HOME', 'an import inside a sentence keeps the sentence, its full stop is not part of the path');
  assert.equal(lines[5], 'ABS');
  assert.deepEqual(lines.slice(6, 9), ['```', '@memory/a.md', '```'], 'nothing inside a fence');
  assert.equal(lines[9], 'span `@memory/a.md` here', 'nothing inside a code span');
  assert.equal(lines[10], 'mail me @nobody or a@b.c', 'not a file: left as written');
  assert.equal(out.match(/A1/g)?.length, 1, 'the cycle a -> b -> a is expanded once');
});

test('imports: at most five hops, as Claude reads them', () => {
  const d = scratch();
  for (let i = 0; i < 8; i++) put(join(d, `f${i}.md`), `L${i}\n@f${i + 1}.md`);
  put(join(d, 'f8.md'), 'L8');
  const out = expandImports(join(d, 'CLAUDE.md'), '@f0.md', { home: d });
  for (let i = 0; i < 5; i++) assert.ok(out.includes(`L${i}`), `L${i}`);
  assert.ok(!out.includes('L5'), out);
  assert.ok(out.includes('@f5.md'), 'the import past the limit stays as written');
});

test('imports: a path the profile may not read is left out, also through a link', async () => {
  const { symlinkSync } = await import('node:fs');
  const d = scratch();
  put(join(d, 'secret', 'key'), 'PRIVATE KEY');
  symlinkSync(join(d, 'secret', 'key'), join(d, 'innocent.md'));
  const readable = (abs: string) => !abs.startsWith(join(d, 'secret'));
  const out = expandImports(join(d, 'CLAUDE.md'), `@${join(d, 'secret', 'key')}\n@innocent.md`, { home: d, readable });
  assert.ok(!out.includes('PRIVATE'), out);
  assert.equal(out.match(/is left out: this profile may not read it/g)?.length, 2);
});

test('the generated file: header first, imports expanded, the ungated tools named, no bare import left', () => {
  const d = scratch();
  put(join(d, 'inc.md'), 'INCLUDED');
  const text = agyInstructionsText(join(d, 'CLAUDE.md'), '# Me\n@inc.md\n');
  assert.ok(text.startsWith(AGY_HEADER + '\n'));
  assert.equal(text.split('\n')[1], AGY_TOOL_RULE, 'the tool rule comes right under the header, in plain text');
  assert.match(AGY_TOOL_RULE, /^Do tool work yourself; do not use invoke_subagent, swarm or run_workflow for it: their permission requests often come after the turn ends and are refused\.$/);
  assert.ok(text.includes('INCLUDED') && !text.includes('@inc.md'));
  assert.match(text, /Do not use invoke_subagent, define_subagent, manage_subagents, swarm, run_workflow, schedule/);
});

test('agy launch problems: MCP configs, instruction files above or beside, the gemini dir, skills compile did not put there', () => {
  const d = scratch();
  const cwd = join(d, 'ws', 'p'), add = join(d, 'extra'), g = join(d, 'g');
  mkdirSync(cwd, { recursive: true }); mkdirSync(add, { recursive: true }); mkdirSync(join(g, 'config', 'skills'), { recursive: true });
  assert.deepEqual(agyLaunchProblems(cwd, [add], g, []), []);
  put(join(g, 'config', 'mcp_config.json'), '');
  assert.deepEqual(agyLaunchProblems(cwd, [add], g, []), [], 'agy makes it empty on its first start');
  put(join(g, 'config', 'mcp_config.json'), '{"mcpServers":{}}');
  assert.deepEqual(agyLaunchProblems(cwd, [add], g, []), []);
  put(join(cwd, AGY_INSTRUCTIONS), `${AGY_HEADER}\nold copy`);
  assert.deepEqual(agyLaunchProblems(cwd, [add], g, []), [], 'its own earlier copy is fine');
  put(join(g, 'config', 'mcp_config.json'), '{"mcpServers":{"x":{"command":"sh"}}}');
  put(join(cwd, '.agents', 'mcp_config.json'), '{}');
  put(join(add, '.agents', 'mcp_config.json'), '{}');
  put(join(cwd, '.agents', 'skills', 'evil', 'SKILL.md'), '---\nname: evil\n---\n');
  put(join(d, 'ws', 'AGENTS.md'), 'stray');
  put(join(d, 'GEMINI.md'), 'stray');
  put(join(cwd, 'AGENTS.md'), 'hand');
  put(join(cwd, AGY_INSTRUCTIONS), 'hand-written');
  put(join(g, 'config', 'config.json'), '{"plugins":{"swarm":{"enabled":true}}}');
  assert.ok(!agyLaunchProblems(cwd, [add], g, []).some((l) => l.startsWith(`${join(g, 'config', 'config.json')}:`)), 'agy\'s own default is fine');
  put(join(g, 'config', 'config.json'), '{"plugins":{"swarm":{"enabled":true},"evil":{"enabled":true}}}');
  put(join(g, 'antigravity-cli', 'settings.json'), '{"hooks":{}}');
  put(join(g, 'GEMINI.md'), 'x'); put(join(g, 'config', 'GEMINI.md'), 'x');
  mkdirSync(join(g, 'config', 'skills', 'planted'));
  mkdirSync(join(g, 'config', 'skills', 'given'));
  const out = agyLaunchProblems(cwd, [add], g, ['given']);
  const has = (f: string) => assert.ok(out.some((l) => l.startsWith(f + ':')), `${f}\n${out.join('\n')}`);
  for (const f of [join(cwd, '.agents', 'mcp_config.json'), join(add, '.agents', 'mcp_config.json'), join(cwd, '.agents', 'skills'), join(d, 'ws', 'AGENTS.md'), join(d, 'GEMINI.md'),
    join(cwd, 'AGENTS.md'), join(cwd, AGY_INSTRUCTIONS), join(g, 'GEMINI.md'), join(g, 'config', 'GEMINI.md'), join(g, 'config', 'mcp_config.json'), join(g, 'config', 'skills', 'planted'), join(g, 'config', 'config.json'), join(g, 'antigravity-cli', 'settings.json')]) has(f);
  assert.equal(out.length, 13, out.join('\n'));
  assert.equal(mcpConfigServers(join(g, 'config', 'mcp_config.json')), 1);
  put(join(g, 'x.json'), 'not json'); assert.equal(mcpConfigServers(join(g, 'x.json')), -1);
});

/** An instance with an agy profile `a`, a Claude profile `c`, a skill and two MCP servers. */
function rig() {
  const home = scratch();
  const state = join(home, '.angelia');
  const lib = join(state, 'workspace', '_capabilities', 'skills');
  for (const s of ['maps', 'ledger']) put(join(lib, s, 'SKILL.md'), `---\nname: ${s}\n---\n`);
  const cwd = (n: string) => { const c = join(state, 'workspace', 'profiles', n); mkdirSync(c, { recursive: true }); return c; };
  const table = {
    capabilities: {
      maps: { kind: 'skill', path: join(lib, 'maps') },
      ledger: { kind: 'skill', path: join(lib, 'ledger') },
      bank: { kind: 'mcp', command: 'bank-mcp', args: ['--ro'], env: ['BANK_USER'], when: 'balances' },
      web: { kind: 'mcp', url: 'https://mcp.example.com/' },
    },
    profiles: { a: { cwd: cwd('a'), backend: 'agy', capabilities: ['maps', 'bank', 'web'], deny: ['ledger'] }, c: { cwd: cwd('c') } },
    routes: [],
  };
  const cfg = Config.parse(table);
  return { home, state, lib, cfg, a: cfg.profiles.a.cwd, g: agyGeminiPath(state, 'a') };
}

test('compile (agy): /abs rules, skills linked into the gemini dir, an empty MCP config made, servers kept in the guard, no file for them', () => {
  const r = rig();
  const pl = planProfile(r.cfg, 'a', { home: r.home, stateDir: r.state });
  assert.deepEqual(pl.conflicts, []);
  assert.ok(pl.notes.some((n) => /mcp\.example\.com|web is reached by URL/.test(n)), pl.notes.join('\n'));
  assert.ok(pl.notes.some((n) => /none of these Claude Code features: tmux mode/.test(n)));
  assert.ok(pl.notes.some((n) => /copied to GEMINI\.md/.test(n)));
  pl.apply();
  const deny: string[] = JSON.parse(readFileSync(join(r.a, '.claude', 'settings.json'), 'utf8')).permissions.deny;
  assert.ok(deny.every((x) => !/\(~\//.test(x)), 'agy rules are absolute');
  for (const x of [`Read(${join(r.lib, 'ledger')}/**)`, `Edit(${join(r.a, '.agents')}/**)`, `Edit(${join(r.a, 'GEMINI.md')})`, `Edit(${join(r.a, 'AGENTS.md')})`,
    `Edit(${join(r.g, 'config')}/**)`, `Edit(${join(r.g, 'antigravity-cli', 'plugins')}/**)`, `Edit(${join(r.g, 'antigravity-cli', 'hooks')}/**)`, `Edit(${join(r.g, 'GEMINI.md')})`,
    `Read(${agyGeminiPath(r.state, 'c')}/**)`]) assert.ok(deny.includes(x), x);
  assert.ok(!deny.some((x) => x.startsWith(`Read(${r.g}`)), 'its own gemini dir stays readable: agy runs inside the same sandbox');
  assert.ok(!deny.some((x) => x.startsWith('Skill(')), 'agy has no Skill rule');
  const link = join(r.g, 'config', 'skills', 'maps');
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(resolve(dirname(link), readlinkSync(link)), join(r.lib, 'maps'));
  assert.ok(!existsSync(join(r.g, 'config', 'skills', 'ledger')), 'a denied skill is not linked');
  assert.equal(readFileSync(join(r.g, 'config', 'mcp_config.json'), 'utf8'), '', 'made empty, so the sandbox can close it');
  assert.equal(lstatSync(r.g).mode & 0o777, 0o700);
  assert.ok(!existsSync(join(r.a, '.mcp.json')), 'no MCP file in the folder');
  assert.deepEqual(readRecord(r.a)?.mcpServers, ['bank']);
  assert.deepEqual(readGuard(r.state, 'a')?.agy, { mcpServers: [{ name: 'bank', command: 'bank-mcp', args: ['--ro'], env: ['BANK_USER'] }], skills: ['maps'] });
  assert.deepEqual(launchCheck(r.cfg, 'a', r.state), []);
  assert.deepEqual(agyMcpServers(r.state, 'a', { BANK_USER: 'u1' }), [{ name: 'bank', command: 'bank-mcp', args: ['--ro'], env: [{ name: 'BANK_USER', value: 'u1' }] }]);
  assert.deepEqual(acpMcpServers([{ name: 'x', command: 'y', args: [], env: ['UNSET_VAR'] }], {}), [{ name: 'x', command: 'y', args: [], env: [] }]);
  assert.deepEqual(planProfile(r.cfg, 'a', { home: r.home, stateDir: r.state }).changes, [], 'a second compile changes nothing');
  // A planted skill, servers in the gemini dir's config, a stray file above: the launch guard refuses.
  mkdirSync(join(r.g, 'config', 'skills', 'planted'));
  writeFileSync(join(r.g, 'config', 'mcp_config.json'), '{"mcpServers":{"evil":{"command":"sh"}}}');
  writeFileSync(join(r.state, 'workspace', 'profiles', 'AGENTS.md'), 'stray');
  const refused = launchCheck(r.cfg, 'a', r.state);
  assert.equal(refused.length, 3, refused.join('\n'));
  const warned = agyWarnings(r.cfg, r.state, r.home);
  assert.equal(warned.length, 1, 'check-config: one line for the profile');
  assert.match(warned[0], /^profiles\.a: agy will not start: .*planted.*evil|^profiles\.a: agy will not start: /);
  for (const f of ['planted', 'mcp_config.json', 'AGENTS.md']) assert.ok(warned[0].includes(f), f);
});

test('compile: every backend keeps the agy state folder closed; the owner\'s whole ~/.gemini only an agy profile', () => {
  const r = rig();
  const floor = profileFloor(r.cfg, 'c', r.state, r.home);
  assert.ok(floor.includes('Read(~/.angelia/agy/**)') && floor.includes('Edit(~/.angelia/agy/**)'), floor.filter((x) => x.includes('agy')).join('\n'));
  // A Claude Code (or Codex, pi, grok) profile may run the owner's own agy as a tool, which lives in ~/.gemini.
  for (const backend of ['claude-code', 'codex', 'pi', 'grok'] as const) {
    const cfg = Config.parse({ ...r.cfg, profiles: { ...r.cfg.profiles, c: { ...r.cfg.profiles.c, backend } } });
    const f = profileFloor(cfg, 'c', r.state, r.home);
    assert.ok(!f.some((x) => /\.gemini\/\*\*/.test(x)), `${backend}: ~/.gemini stays open`);
    assert.ok(f.some((x) => x.includes('.gemini/oauth_creds.json')), `${backend}: Gemini CLI's sign-in stays closed`);
    assert.ok(f.some((x) => x.startsWith('Read(') && x.includes(join('agy', '**'))), `${backend}: the agy state folder closed`);
  }
  // agy's own: its agy has its own --gemini-dir; other profiles' agy folders closed.
  const a = profileFloor(r.cfg, 'a', r.state, r.home);
  assert.ok(a.includes(`Read(${join(r.home, '.gemini', '**')})`) && a.includes(`Edit(${join(r.home, '.gemini', '**')})`));
});

test('compile (agy): a hand-written GEMINI.md, or an AGENTS.md beside it, is a conflict and never overwritten', () => {
  const r = rig();
  put(join(r.a, 'GEMINI.md'), 'mine');
  put(join(r.a, 'AGENTS.md'), 'also mine');
  const pl = planProfile(r.cfg, 'a', { home: r.home, stateDir: r.state });
  assert.equal(pl.conflicts.length, 2, pl.conflicts.join('\n'));
  assert.throws(() => pl.apply(), /conflict/);
  assert.equal(readFileSync(join(r.a, 'GEMINI.md'), 'utf8'), 'mine');
});

test('agy start: GEMINI.md written from CLAUDE.md, a denied import left out, a hand-written one refused', () => {
  const r = rig();
  planProfile(r.cfg, 'a', { home: r.home, stateDir: r.state }).apply();
  put(join(r.a, 'memory', 'active.md'), 'ACTIVE WORK');
  const claude = readFileSync(join(r.a, 'CLAUDE.md'), 'utf8');
  writeFileSync(join(r.a, 'CLAUDE.md'), `# a\n@memory/active.md\n@${join(r.state, 'env')}\n@${join(r.lib, 'ledger', 'SKILL.md')}\n${claude}`);
  put(join(r.state, 'env'), 'TOKEN=supersecret');
  const p = r.cfg.profiles.a;
  prepareAgyStart(p, { stateDir: r.state, name: 'a', geminiDir: r.g, home: r.home });
  const out = readFileSync(join(r.a, 'GEMINI.md'), 'utf8');
  assert.ok(out.startsWith(AGY_HEADER) && out.includes('ACTIVE WORK'));
  assert.ok(!out.includes('supersecret') && !out.includes('name: ledger'), out);
  assert.equal(out.match(/may not read it/g)?.length, 2);
  prepareAgyStart(p, { stateDir: r.state, name: 'a', geminiDir: r.g, home: r.home });
  writeFileSync(join(r.a, 'GEMINI.md'), 'hand');
  assert.throws(() => prepareAgyStart(p, { stateDir: r.state, name: 'a', geminiDir: r.g, home: r.home }), /agy not started: .*GEMINI\.md: not written by Angelia/);
  assert.equal(readFileSync(join(r.a, 'GEMINI.md'), 'utf8'), 'hand');
  rmSync(join(r.a, 'GEMINI.md'));
});

test('agy start: a named pipe the agent planted (CLAUDE.md, GEMINI.md, gemini dir files) does not hold the daemon; a CLAUDE.md link to a denied file is refused (review 3, M1)', () => {
  const r = rig();
  planProfile(r.cfg, 'a', { home: r.home, stateDir: r.state }).apply();
  const p = r.cfg.profiles.a;
  const start = () => prepareAgyStart(p, { stateDir: r.state, name: 'a', geminiDir: r.g, home: r.home });
  const fifo = (f: string) => { mkdirSync(dirname(f), { recursive: true }); assert.equal(spawnSync('/usr/bin/mkfifo', [f]).status, 0); };
  const claude = readFileSync(join(r.a, 'CLAUDE.md'), 'utf8');
  rmSync(join(r.a, 'CLAUDE.md'));
  fifo(join(r.a, 'CLAUDE.md'));
  assert.throws(start, /CLAUDE\.md is not a plain file/);
  rmSync(join(r.a, 'CLAUDE.md'));
  put(join(r.state, 'env'), 'TOKEN=supersecret');
  symlinkSync(join(r.state, 'env'), join(r.a, 'CLAUDE.md'));
  assert.throws(start, /may not read/);
  assert.ok(!existsSync(join(r.a, 'GEMINI.md')) || !readFileSync(join(r.a, 'GEMINI.md'), 'utf8').includes('supersecret'));
  rmSync(join(r.a, 'CLAUDE.md'));
  writeFileSync(join(r.a, 'CLAUDE.md'), claude);
  rmSync(join(r.a, 'GEMINI.md'), { force: true });
  fifo(join(r.a, 'GEMINI.md'));
  assert.throws(start, /GEMINI\.md: not written by Angelia/);
  rmSync(join(r.a, 'GEMINI.md'));
  for (const f of [join(r.g, 'config', 'config.json'), join(r.g, 'antigravity-cli', 'settings.json'), join(r.g, 'config', 'mcp_config.json')]) {
    rmSync(f, { force: true });
    fifo(f);
    assert.throws(start, /agy not started/, f);
    rmSync(f);
  }
  start();
  assert.ok(readFileSync(join(r.a, 'GEMINI.md'), 'utf8').startsWith(AGY_HEADER));
});

test('agy models: grouped by the id without its effort suffix, hydrogen the default', () => {
  const text = 'Fetching available models...\ngemini-4-neon-high\tGemini 4 Neon (High)\ngemini-4-neon-low\tGemini 4 Neon (Low)\ngemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\ngemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)\ngemini-pro-orchestrator-neon\tOrchestrator (Neon)\n';
  assert.deepEqual(parseAgyModels(text), [
    { id: 'gemini-4-neon', name: 'Gemini 4 Neon', efforts: ['high', 'low'] },
    { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', efforts: ['high', 'xhigh'], isDefault: true, defaultEffort: 'high' },
    { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)', efforts: undefined },
  ]);
});

test('agy: the version floor, a sandboxed job, a bypass group open to everyone allowed as Codex\'s', async () => {
  assert.equal(MIN_AGY_VERSION, '1.5.14');
  assert.ok(olderThan('1.5.11', '1.5.14') && !olderThan('1.5.14', '1.5.14') && !olderThan('1.10.0', '1.5.14'));
  const d = scratch();
  const bin = join(d, 'agy'); writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const cfg = Config.parse({ profiles: { a: { cwd: d, backend: 'agy', bin } }, routes: [] });
  assert.deepEqual(cliWarnings(cfg, {}, d, () => '1.5.14'), []);
  assert.match(cliWarnings(cfg, {}, d, () => '1.5.11')[0], /agy 1\.5\.11 is older than 1\.5\.14/);
  assert.match(cliWarnings(cfg, {}, d, () => undefined)[0], /did not print a version/);
  assert.equal(jobSandboxed(cfg.profiles.a), true);
  assert.equal(jobSandboxed({ ...cfg.profiles.a, sandbox: false }), false);
  const { loadConfig } = await import('../src/instance/config/load.js');
  const { stringify } = await import('yaml');
  const path = join(d, 'routing.yaml');
  const table = (sandbox?: boolean) => ({ profiles: { a: { cwd: d, backend: 'agy', permission_mode: 'bypassPermissions', ...(sandbox === undefined ? {} : { sandbox }) } }, routes: [{ platform: 'telegram', chat: -100123, profile: 'a', allow_from: ['*'] }], telegram: {} });
  writeFileSync(path, stringify(table()));
  assert.doesNotThrow(() => loadConfig(path));
  writeFileSync(path, stringify(table(false)));
  assert.throws(() => loadConfig(path), /without a sandbox/);
});

test('compile (agy): sandbox: false is noted, and turning it off after a compile is refused until the next compile', () => {
  const r = rig();
  planProfile(r.cfg, 'a', { home: r.home, stateDir: r.state }).apply();
  assert.equal(readGuard(r.state, 'a')?.agySandbox, true);
  const off = Config.parse({ ...r.cfg, profiles: { ...r.cfg.profiles, a: { ...r.cfg.profiles.a, sandbox: false } } });
  assert.ok(launchCheck(off, 'a', r.state).some((x) => /^sandbox off: .*agy's sandbox/.test(x)), launchCheck(off, 'a', r.state).join('\n'));
  const pl = planProfile(off, 'a', { home: r.home, stateDir: r.state });
  assert.ok(pl.notes.some((n) => /sandbox: false: .*Read deny inside the folder does not bind/.test(n)), pl.notes.join('\n'));
  pl.apply();
  assert.equal(readGuard(r.state, 'a')?.agySandbox, undefined);
  assert.ok(!launchCheck(off, 'a', r.state).some((x) => x.startsWith('sandbox off')));
});

test('launch check (agy): a plugin folder in config/, or a hooks or plugins folder in antigravity-cli/, stops the start', () => {
  const d = scratch(), cwd = join(d, 'p'), g = join(d, 'g');
  mkdirSync(cwd, { recursive: true });
  put(join(g, 'config', 'plugins', 'rt2', 'plugin.json'), '{}');
  put(join(g, 'config', 'plugins', 'rt2', 'hooks.json'), '{"PreToolUse":[]}');
  put(join(g, 'antigravity-cli', 'hooks', 'h.json'), '{}');
  put(join(g, 'antigravity-cli', 'plugins', 'x', 'plugin.json'), '{}');
  put(join(g, 'antigravity-cli', 'conversations', 'c.db'), 'agy writes this');
  const out = agyLaunchProblems(cwd, [], g, [], d).join('\n');
  for (const f of [join(g, 'config', 'plugins'), join(g, 'antigravity-cli', 'hooks'), join(g, 'antigravity-cli', 'plugins')]) assert.ok(out.includes(`${f}:`), f);
  assert.ok(!out.includes('conversations'), 'what agy writes as it works is no problem');
});

test('launch check: a profile compiled before the agy floor does not start while another profile is on agy', () => {
  const r = rig();
  planProfile(r.cfg, 'c', { home: r.home, stateDir: r.state }).apply();
  assert.deepEqual(launchCheck(r.cfg, 'c', r.state, r.home), []);
  // As a compile before the agy backend wrote it: no rule over the agy state folder.
  const file = join(r.state, 'compiled', 'c.json');
  const g = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...g, deny: g.deny.filter((x: string) => !x.includes('/agy/')) }));
  assert.match(launchCheck(r.cfg, 'c', r.state, r.home).join('\n'), /agy profiles' folders.*angelia compile --write c/);
  // No agy profile in the table: nothing to hold, so no refusal.
  const noAgy = Config.parse({ ...r.cfg, profiles: { c: r.cfg.profiles.c } });
  assert.deepEqual(launchCheck(noAgy, 'c', r.state, r.home), []);
  planProfile(r.cfg, 'c', { home: r.home, stateDir: r.state }).apply();
  assert.deepEqual(launchCheck(r.cfg, 'c', r.state, r.home), [], 'compiled again: starts');
});
