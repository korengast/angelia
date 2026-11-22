// An owner's own Read/Edit rule in .claude/settings.json, in each of Claude Code's path forms, binds
// pi's and agy's gate, their sandbox and agy's GEMINI.md (red team R1: a relative rule held nothing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { placeRule, placedPermissions, RECORD } from '../src/capabilities/compile.js';
import { agyGate, agyPolicy, agySandboxProfile } from '../src/brain/agy.js';
import { piPolicy } from '../src/brain/pi.js';
import { SANDBOX_EXEC, decide, sandboxProfile } from '../src/brain/pi-gate.js';
import { prepareAgyStart } from '../src/brain/agy-config.js';
import type { Profile } from '../src/instance/config/schema.js';

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'angelia-owner-rules-')));
const darwin = process.platform === 'darwin' && spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;

test('placeRule: Claude Code\'s forms, placed as its docs say for project settings', () => {
  const cwd = '/w/p', home = '/h';
  assert.deepEqual(placeRule('Read(./secret.txt)', cwd, home), ['Read(/w/p/secret.txt)']);
  assert.deepEqual(placeRule('Read(secret.txt)', cwd, home), ['Read(/w/p/secret.txt)']);
  assert.deepEqual(placeRule('Read(*.env)', cwd, home), ['Read(/w/p/*.env)']);
  assert.deepEqual(placeRule('Edit(/src/**)', cwd, home), ['Edit(/src/**)', 'Edit(/w/p/src/**)'], '/x: the settings source\'s folder, and as written (pi\'s form)');
  assert.deepEqual(placeRule('Read(//etc/passwd)', cwd, home), ['Read(/etc/passwd)']);
  assert.deepEqual(placeRule('Read(~/.aws/**)', cwd, home), ['Read(~/.aws/**)']);
  assert.deepEqual(placeRule('Read(../other/x)', cwd, home), ['Read(/w/other/x)']);
  assert.deepEqual(placeRule('Bash(rm *)', cwd, home), ['Bash(rm *)']);
});

function profileWith(deny: string[], backend: 'pi' | 'agy', compiled: string[] = []) {
  const cwd = scratch();
  mkdirSync(join(cwd, '.claude'));
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: [...compiled, ...deny] } }));
  writeFileSync(join(cwd, RECORD), JSON.stringify({ deny: compiled }));
  writeFileSync(join(cwd, 'secret.txt'), 'TOPSECRET\n');
  writeFileSync(join(cwd, 'notes.txt'), 'hello\n');
  const p = { cwd, add_dirs: [], permission_mode: 'bypassPermissions', backend, sandbox: true, unsafe_ok: false, shell: false, shell_timeout_seconds: 60, chrome: false } as unknown as Profile;
  return { cwd, p };
}

const FORMS = ['Read(./secret.txt)', 'Read(secret.txt)', 'Read(/secret.txt)', 'Read(*.txt)'];

test('an owner rule in every form: compiled /abs rules stay absolute; the owner\'s are placed in the folder', () => {
  const { cwd } = profileWith(['Read(./secret.txt)', 'Read(/secret.txt)'], 'agy', ['Read(/etc/compiled)']);
  assert.deepEqual(placedPermissions(cwd).deny, ['Read(/etc/compiled)', `Read(${cwd}/secret.txt)`, 'Read(/secret.txt)']);
});

for (const backend of ['pi', 'agy'] as const) for (const form of FORMS) {
  test(`${backend}: ${form} in the owner's settings refuses the gate's read`, () => {
    const { cwd, p } = profileWith([form], backend);
    const pol = backend === 'agy' ? agyPolicy(p) : piPolicy(p);
    if (backend === 'agy') assert.equal(typeof agyGate(pol, { name: 'read_file', rawInput: { Path: join(cwd, 'secret.txt') } }), 'object');
    else assert.equal(decide(pol, 'read', { path: join(cwd, 'secret.txt') }).action, 'block');
    if (form !== 'Read(*.txt)') assert.equal(backend === 'agy' ? agyGate(pol, { name: 'read_file', rawInput: { Path: join(cwd, 'notes.txt') } }) : decide(pol, 'read', { path: join(cwd, 'notes.txt') }).action, 'allow');
  });
  test(`${backend} sandbox (macOS): ${form} refuses an approved \`cat\``, { skip: !darwin && 'no sandbox-exec' }, () => {
    const { cwd, p } = profileWith([form], backend);
    const pol = backend === 'agy' ? agyPolicy(p) : piPolicy(p);
    const sb = backend === 'agy' ? agySandboxProfile(pol, join(scratch(), 'g'), undefined, { closeSiblings: false }) : sandboxProfile(pol.deny, undefined, { writable: [cwd] });
    const r = spawnSync(SANDBOX_EXEC, ['-p', sb, '/bin/cat', join(cwd, 'secret.txt')], { encoding: 'utf8' });
    assert.notEqual(r.status, 0); assert.doesNotMatch(r.stdout, /TOPSECRET/);
  });
}

test('agy GEMINI.md: an import of a file an owner rule denies is left out, by every path to it', () => {
  for (const form of FORMS) {
    const { cwd, p } = profileWith([form], 'agy');
    symlinkSync(join(cwd, 'secret.txt'), join(cwd, 'link.txt'));
    writeFileSync(join(cwd, 'CLAUDE.md'), `Hi.\n@secret.txt\n@./secret.txt\n@${join(cwd, 'secret.txt')}\n${form === 'Read(*.txt)' ? '' : '@link.txt\n'}`);
    const state = scratch();
    prepareAgyStart(p, { stateDir: state, name: 'a', geminiDir: join(state, 'g') });
    assert.doesNotMatch(readFileSync(join(cwd, 'GEMINI.md'), 'utf8'), /TOPSECRET/, form);
  }
});
