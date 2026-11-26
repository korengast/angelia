import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Config } from '../src/instance/config/schema.js';
import { profileFloor, stateOpenPaths } from '../src/capabilities/compile.js';
import { SANDBOX_EXEC, decide, sandboxProfile, type PiPolicy } from '../src/brain/pi-gate.js';
import { prepareAgyStart } from '../src/brain/agy-config.js';

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'angelia-stc-')));
const put = (f: string, text = 'SECRET') => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };
const CLOSED = ['passkeys.json', 'pay-ledger.json', 'secrets/x.env', 'posted-lines.json', 'app-notes.json', 'canary.json', 'looks.json', 'routing.yaml.bak-1', 'sessions.json.bak-1', 'keys/other/k.pem', 'unknown-new.json'];

function rig(backend: 'claude-code' | 'codex' | 'pi' | 'grok' | 'agy') {
  const home = scratch(), state = join(home, '.angelia');
  for (const f of CLOSED) put(join(state, f));
  put(join(state, 'data', 'sensor', 'g.csv'), 'mine');
  put(join(state, 'keys', 'mine', 'k.pem'), 'mine');
  put(join(state, 'daemon.log'), 'log');
  const cwd = join(state, 'workspace', 'profiles', 'a');
  put(join(cwd, 'notes.md'), 'notes');
  const cfg = Config.parse({ profiles: { a: { cwd, backend, add_dirs: [join(state, 'data', 'sensor'), join(state, 'keys', 'mine')] } }, routes: [] });
  return { home, state, cwd, cfg };
}

test('state folder closed by default: every entry not open or reached is in every backend\'s floor', () => {
  for (const backend of ['claude-code', 'codex', 'pi', 'grok', 'agy'] as const) {
    const r = rig(backend);
    const floor = profileFloor(r.cfg, 'a', r.state, r.home).join('\n');
    const has = (rel: string) => floor.includes(`/${rel}`) && (floor.includes(join(r.state, rel)) || floor.includes(`~/.angelia/${rel}`));
    for (const f of ['passkeys.json', 'pay-ledger.json', 'secrets/**', 'posted-lines.json', 'app-notes.json', 'canary.json', 'looks.json', 'routing.yaml.bak-1', 'sessions.json.bak-1', 'keys/other/**', 'unknown-new.json']) assert.ok(has(f), `${backend}: ${f}`);
    const rules = profileFloor(r.cfg, 'a', r.state, r.home);
    for (const f of ['workspace', 'daemon.log', 'data/sensor', 'keys/mine', 'data', 'keys']) assert.ok(!rules.some((x) => x.endsWith(`.angelia/${f})`) || x.endsWith(`.angelia/${f}/**)`)), `${backend}: ${f} stays open`);
  }
});

test('state folder closed in Angelia\'s sandbox, a file made after the profile was built included', { skip: process.platform !== 'darwin' }, () => {
  const r = rig('agy');
  const sb = sandboxProfile([], r.home, { closed: { dir: r.state, open: [...stateOpenPaths(r.cfg, 'a', r.state, r.home), r.cwd] } });
  put(join(r.state, 'made-later.json'));
  put(join(r.state, 'secrets', 'later.env'));
  const cat = (f: string) => spawnSync(SANDBOX_EXEC, ['-p', sb, '/bin/cat', f], { encoding: 'utf8', timeout: 10_000 });
  for (const f of [...CLOSED, 'made-later.json', 'secrets/later.env']) assert.notEqual(cat(join(r.state, f)).status, 0, f);
  for (const f of ['workspace/profiles/a/notes.md', 'daemon.log', 'data/sensor/g.csv', 'keys/mine/k.pem']) assert.equal(cat(join(r.state, f)).status, 0, f);
  // The way down to a reached folder resolves (realpath stats every folder on it).
  const rp = spawnSync(SANDBOX_EXEC, ['-p', sb, '/usr/bin/python3', '-c', `import os;print(os.path.realpath(${JSON.stringify(join(r.state, 'data', 'sensor'))}))`], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(rp.status, 0, rp.stderr);
  assert.equal(spawnSync(SANDBOX_EXEC, ['-p', sb, '/bin/ls', join(r.state, 'data')], { timeout: 10_000 }).status, 0, 'data stays open');
});

test('agy: an import from the closed state folder is left out of GEMINI.md, even one made after the compile', () => {
  const r = rig('agy');
  put(join(r.cwd, 'CLAUDE.md'), `top\n@${join(r.state, 'secrets', 'x.env')}\n@${join(r.state, 'data', 'sensor', 'g.csv')}\n`);
  prepareAgyStart(r.cfg.profiles.a, { stateDir: r.state, name: 'a', geminiDir: join(r.state, 'agy', 'a'), home: r.home, stateOpen: [...stateOpenPaths(r.cfg, 'a', r.state, r.home), r.cwd] });
  const text = readFileSync(join(r.cwd, 'GEMINI.md'), 'utf8');
  assert.doesNotMatch(text, /SECRET/);
  assert.match(text, /left out: this profile may not read it/);
  assert.match(text, /mine/);
});

test('state reach: only a program opens its whole entry; a secret or the state folder named in a text opens no more than itself (review 3, M2)', () => {
  const home = scratch(), state = join(home, '.angelia');
  for (const f of CLOSED) put(join(state, f));
  put(join(state, 'secrets', 'mine.env'));
  put(join(state, 'tools', 'x', 'x.py'), 'print(1)');
  put(join(state, 'mcpbin', 'srv'), '#!/bin/sh');
  const cwd = join(state, 'workspace', 'profiles', 'a');
  put(join(cwd, 'notes.md'), 'notes');
  for (const backend of ['claude-code', 'codex', 'agy'] as const) {
    const cfg = Config.parse({
      capabilities: {
        cmd: { kind: 'command', run: `python3 ~/.angelia/tools/x/x.py --env ~/.angelia/secrets/mine.env --root ~/.angelia`, when: 'x' },
        srv: { kind: 'mcp', command: join(state, 'mcpbin', 'srv'), args: ['--state', state, `--key=${join(state, 'keys', 'other', 'k.pem')}`] },
      },
      profiles: { a: { cwd, backend, capabilities: ['cmd', 'srv'] } }, routes: [],
    });
    const floor = profileFloor(cfg, 'a', state, home).join('\n');
    const has = (rel: string) => floor.includes(join(state, rel)) || floor.includes(`~/.angelia/${rel}`);
    for (const f of ['passkeys.json', 'pay-ledger.json', 'secrets/x.env', 'unknown-new.json']) assert.ok(has(f), `${backend}: ${f} stays closed`);
    assert.ok(!has('secrets/mine.env'), `${backend}: the named secret opens`);
    assert.ok(!has('tools'), `${backend}: the script's entry opens`);
    assert.ok(!has('mcpbin'), `${backend}: the server program's entry opens`);
  }
});

test('pi file tools: the closed state folder holds them too, a file made after the compile and the folder\'s own names included (review 3, L1, L2)', () => {
  const r = rig('pi');
  const policy: PiPolicy = { cwd: r.cwd, dirs: [], deny: [], mode: 'bypassPermissions', sandbox: true, closed: { dir: r.state, open: [...stateOpenPaths(r.cfg, 'a', r.state, r.home), r.cwd] } };
  put(join(r.state, 'made-later.json'));
  const act = (tool: string, path: string) => decide(policy, tool, { path }, r.home).action;
  for (const f of ['made-later.json', 'passkeys.json', 'secrets/x.env']) assert.equal(act('read', join(r.state, f)), 'block', f);
  for (const t of ['ls', 'find', 'grep']) assert.equal(act(t, r.state), 'block', `${t} of the state folder`);
  assert.equal(act('grep', r.home), 'block', 'a walk over the folder above');
  assert.equal(act('write', join(r.state, 'made-later.json')), 'block');
  for (const f of ['workspace/profiles/a/notes.md', 'daemon.log', 'data/sensor/g.csv']) assert.equal(act('read', join(r.state, f)), 'allow', f);
  assert.equal(act('ls', join(r.state, 'workspace')), 'allow');
});

test('sandbox: the state folder\'s names are not listed, yet a path through it resolves (review 3, L2)', { skip: process.platform !== 'darwin' }, () => {
  const r = rig('agy');
  const sb = sandboxProfile([], r.home, { closed: { dir: r.state, open: [...stateOpenPaths(r.cfg, 'a', r.state, r.home), r.cwd] } });
  const run = (...argv: string[]) => spawnSync(SANDBOX_EXEC, ['-p', sb, ...argv], { encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(run('/bin/ls', r.state).status, 0);
  assert.notEqual(run('/usr/bin/find', r.state, '-maxdepth', '1').status, 0);
  assert.equal(run('/bin/cat', join(r.cwd, 'notes.md')).stdout, 'notes');
  assert.equal(run('/bin/sh', '-c', `cd ${r.state} && cat daemon.log`).stdout, 'log');
  const rp = run('/usr/bin/python3', '-c', `import os;print(os.path.realpath(${JSON.stringify(join(r.cwd, 'notes.md'))}))`);
  assert.equal(rp.stdout.trim(), join(r.cwd, 'notes.md'));
});
