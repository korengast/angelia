import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/instance/config/load.js';
import { writeAccepted } from '../src/instance/accepted.js';
import { onboardChat } from '../src/instance/onboard.js';
import { compileDrift } from '../src/capabilities/cli.js';
import { selfPrompt } from '../src/daemon/self.js';
import { agentDenyRules, floorMissing, launchCheck, pathRule, planProfile, profileFloor, refreshFloor, refreshFloors, withCompileLock } from '../src/capabilities/compile.js';
import { makeLaunchGuard } from '../src/daemon/launch-guard.js';
import { ACCEPTED_FILE } from '../src/instance/accepted.js';

/** An onboard: block whose new profiles run on `backend`. */
const onboardOn = (backend: string) => `onboard:\n  owners: ["15550000001"]\n  profile: {backend: ${backend}}\n`;
/** A new profile, as onboarding a new chat makes it (the public line's one way to add one at run time). */
const newProfile = (t: { inst: string; table: string }, name: string, chat = `${name}@g.us`) =>
  onboardChat({ table: t.table, cfg: loadConfig(t.table), platform: 'whatsapp', chat, chatName: name, instance: t.inst, self: selfOf(t) });
const selfOf = (t: { inst: string; table: string }) => (profile: string) => selfPrompt({ profile, table: t.table, instance: t.inst });

/** A temp instance whose table has the profiles given (name -> backend), each compiled, and an accepted copy. */
function instance(profiles: Record<string, string>, onboard = '') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'angelia-floor-')));
  const inst = join(dir, 'instance');
  const ws = join(inst, 'workspace');
  const cwd = (n: string) => join(ws, 'profiles', n);
  for (const n of Object.keys(profiles)) mkdirSync(cwd(n), { recursive: true });
  const table = join(ws, 'routing.yaml');
  writeFileSync(table, `profiles:
${Object.entries(profiles).map(([n, b]) => `  ${n}: {cwd: ${cwd(n)}, backend: ${b}}`).join('\n')}
routes:
  - {platform: telegram, chat: 1, profile: ${Object.keys(profiles)[0]}}
telegram: {}
whatsapp: {}
${onboard}`);
  const cfg = loadConfig(table);
  for (const n of Object.keys(profiles)) planProfile(cfg, n, { stateDir: inst, self: selfOf({ inst, table }) }).apply();
  writeAccepted(cfg, inst);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: ws, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'start');
  return { dir, inst, table };
}

const fresh = (t: { inst: string; table: string }, names: string[]) => {
  const cfg = loadConfig(t.table);
  for (const n of names) {
    assert.equal(compileDrift(cfg, t.table, [n], { stateDir: t.inst }), '', `${n} is up to date`);
    assert.deepEqual(launchCheck(cfg, n, t.inst), [], `${n} starts`);
  }
};

test('a new agy profile: the agy profiles there before stay up to date and start (review M2)', () => {
  const t = instance({ a: 'agy', b: 'agy', c: 'claude-code' }, onboardOn('agy'));
  fresh(t, ['a', 'b', 'c']);
  const made = newProfile(t, 'third');
  fresh(t, ['a', 'b', 'c', made.name]);
});

test('a new claude profile: every other profile denies its folder at once (review M2, the same for every backend)', () => {
  const t = instance({ a: 'claude-code', b: 'grok' }, onboardOn('claude-code'));
  const made = newProfile(t, 'new');
  fresh(t, ['a', 'b', made.name]);
  const settings = JSON.parse(readFileSync(join(t.inst, 'workspace', 'profiles', 'a', '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.permissions.deny.includes(pathRule('Read', join(made.folder, '**'), 'claude-code')), 'a denies the new folder');
});

test('an onboarded agy chat: the agy profiles there before stay up to date and start (review M2)', () => {
  const t = instance({ a: 'agy', b: 'agy' }, `onboard:
  owners: ["15550000001"]
  profile: {backend: agy}
`);
  const made = onboardChat({ table: t.table, cfg: loadConfig(t.table), platform: 'whatsapp', chat: 'n@g.us', chatName: 'Third', instance: t.inst, self: selfOf(t) });
  fresh(t, ['a', 'b', made.name]);
});

test('a refresh that fails puts every profile it touched back, and the new profile is not made', () => {
  const t = instance({ a: 'agy', b: 'agy' }, onboardOn('agy'));
  const read = (n: string) => readFileSync(join(t.inst, 'workspace', 'profiles', n, '.claude', 'settings.json'), 'utf8');
  const before = { a: read('a'), b: read('b'), table: readFileSync(t.table, 'utf8') };
  // b's settings cannot be written (its folder is read-only): a's refresh ran first and must be undone.
  chmodSync(join(t.inst, 'workspace', 'profiles', 'b', '.claude'), 0o500);
  try {
    assert.throws(() => newProfile(t, 'third'));
  } finally { chmodSync(join(t.inst, 'workspace', 'profiles', 'b', '.claude'), 0o755); }
  assert.equal(read('a'), before.a);
  assert.equal(read('b'), before.b);
  assert.equal(readFileSync(t.table, 'utf8'), before.table);
  fresh(t, ['a', 'b']);
});

test('refreshFloors only adds deny rules: a capability the table gives but nobody compiled stays out', () => {
  const t = instance({ a: 'claude-code', b: 'claude-code' });
  const shared = join(t.dir, 'shared');
  mkdirSync(shared);
  const text = readFileSync(t.table, 'utf8').replace('profiles:', `capabilities:\n  docs: {kind: directory, path: ${shared}}\nprofiles:`)
    .replace('backend: claude-code}', 'backend: claude-code, capabilities: [docs]}');
  writeFileSync(t.table, text);
  const cfg = loadConfig(t.table);
  const settings = () => JSON.parse(readFileSync(join(t.inst, 'workspace', 'profiles', 'a', '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(refreshFloors(cfg, [], t.inst).refreshed, [], 'nothing missing: nothing written');
  // A new profile folder: a takes its deny rule, not the folder the table gave it.
  mkdirSync(join(t.inst, 'workspace', 'profiles', 'z'));
  const more = loadConfig(t.table);
  more.profiles.z = { ...more.profiles.b, cwd: join(t.inst, 'workspace', 'profiles', 'z') };
  assert.deepEqual(refreshFloors(more, ['z'], t.inst).refreshed, ['a', 'b']);
  assert.ok(!(settings().permissions.additionalDirectories ?? []).includes(shared), 'the capability is not live');
  assert.match(compileDrift(more, t.table, ['a'], { stateDir: t.inst }), /\+ additionalDirectories/);
  assert.deepEqual(refreshFloor(cfg, 'never-there', t.inst).added, []);
});

test('a new entry in the state folder: compile --check stays clean, the agent is still denied it, and the next start writes it (review M3)', () => {
  const t = instance({ a: 'claude-code', g: 'agy' });
  const cfg = loadConfig(t.table);
  const file = join(t.inst, 'routing.yaml.bak-new'), dir = join(t.inst, 'some-tool');
  writeFileSync(file, 'secret-ish');
  mkdirSync(dir);
  for (const n of ['a', 'g']) {
    const backend = cfg.profiles[n].backend;
    assert.equal(compileDrift(cfg, t.table, [n], { stateDir: t.inst }), '', `${n}: a new closed entry is no drift`);
    const rules = agentDenyRules(cfg, n, t.inst);
    for (const tool of ['Read', 'Edit'] as const) {
      assert.ok(rules.includes(pathRule(tool, file, backend)), `${n} denied ${tool} of the new file`);
      assert.ok(rules.includes(pathRule(tool, join(dir, '**'), backend)), `${n} denied ${tool} in the new folder`);
    }
    assert.deepEqual(launchCheck(cfg, n, t.inst), [], `${n} starts`);
  }
  // The daemon's refresh before a start writes the new rules into the profile's own settings.
  const r = refreshFloor(cfg, 'a', t.inst);
  assert.ok(r.added.includes(pathRule('Read', file, 'claude-code')), r.added.join('\n'));
  const deny: string[] = JSON.parse(readFileSync(join(t.inst, 'workspace', 'profiles', 'a', '.claude', 'settings.json'), 'utf8')).permissions.deny;
  assert.ok(deny.includes(pathRule('Read', file, 'claude-code')));
  assert.equal(compileDrift(cfg, t.table, ['a'], { stateDir: t.inst }), '');
  assert.deepEqual(launchCheck(cfg, 'a', t.inst), []);
  // The entry goes away again: a rule for a path that is gone is no drift either (an extra deny is safe).
  execFileSync('rm', ['-rf', file, dir]);
  assert.equal(compileDrift(cfg, t.table, ['a'], { stateDir: t.inst }), '');
});

test('compile --check still sees a change that matters in the state folder: a profile given an entry there', () => {
  const t = instance({ a: 'claude-code' });
  const tool = join(t.inst, 'tool-x');
  mkdirSync(tool);
  writeFileSync(join(tool, 'run.sh'), '');
  // The table now gives a a folder there: its compiled deny for that folder is stale.
  planProfile(loadConfig(t.table), 'a', { stateDir: t.inst, self: selfOf(t) }).apply();
  const text = readFileSync(t.table, 'utf8').replace(`backend: claude-code}`, `backend: claude-code, add_dirs: [${tool}]}`);
  writeFileSync(t.table, text);
  const cfg = loadConfig(t.table);
  assert.match(compileDrift(cfg, t.table, ['a'], { stateDir: t.inst }), /Out of date: a/);
});

test('a deny rule removed from the settings outside Angelia is not put back by a refresh: the launch check refuses it', () => {
  const t = instance({ a: 'claude-code' });
  const cfg = loadConfig(t.table);
  const file = join(t.inst, 'workspace', 'profiles', 'a', '.claude', 'settings.json');
  const s = JSON.parse(readFileSync(file, 'utf8'));
  const gone = s.permissions.deny[0];
  writeFileSync(file, JSON.stringify({ ...s, permissions: { ...s.permissions, deny: s.permissions.deny.slice(1) } }));
  assert.deepEqual(refreshFloor(cfg, 'a', t.inst).added, []);
  assert.deepEqual(launchCheck(cfg, 'a', t.inst), [`deny ${gone}`]);
});

// Review fixes (2026-11-24).

const settingsOf = (t: { inst: string }, n: string) => join(t.inst, 'workspace', 'profiles', n, '.claude', 'settings.json');
const denyOf = (t: { inst: string }, n: string): string[] => JSON.parse(readFileSync(settingsOf(t, n), 'utf8')).permissions.deny;
/** The daemon's own launch guard (daemon.ts makes it the same way), with its log. */
const guardOf = (t: { inst: string; table: string }) => { const log: string[] = []; return { log, guard: makeLaunchGuard(loadConfig(t.table), t.inst, (l) => log.push(l)) }; };

test('launch guard H1: a refresh that cannot write refuses the start, it is not only logged', () => {
  const t = instance({ a: 'claude-code' });
  const file = join(t.inst, 'new-backup.json');
  writeFileSync(file, 'x');
  const { guard, log } = guardOf(t);
  chmodSync(join(t.inst, 'workspace', 'profiles', 'a', '.claude'), 0o500);
  try {
    const refused = guard('a', true);
    assert.equal(refused.length, 1);
    assert.match(refused[0], /^its deny rules could not be brought up to date/);
    assert.ok(log.some((l) => /floor rules could not be added/.test(l)), log.join('\n'));
  } finally { chmodSync(join(t.inst, 'workspace', 'profiles', 'a', '.claude'), 0o755); }
  assert.deepEqual(guard('a', true), [], 'writable again: starts');
  assert.ok(denyOf(t, 'a').includes(pathRule('Read', file, 'claude-code')));
});

test('launch guard H1: a settings file the agent hard-linked is replaced, never written through, and the start goes on with the rule', () => {
  const t = instance({ a: 'claude-code' });
  const outside = join(t.dir, 'elsewhere.json');
  linkSync(settingsOf(t, 'a'), outside);
  const before = readFileSync(outside, 'utf8');
  const file = join(t.inst, 'new-backup.json');
  writeFileSync(file, 'x');
  assert.deepEqual(guardOf(t).guard('a', true), []);
  assert.ok(denyOf(t, 'a').includes(pathRule('Read', file, 'claude-code')));
  assert.equal(readFileSync(outside, 'utf8'), before, 'the other name of the file is untouched');
  assert.equal(statSync(settingsOf(t, 'a')).nlink, 1);
});

test('launch guard M1: the agent deleted its record: the new floor rule is still written, and the start is refused', () => {
  const t = instance({ a: 'claude-code' });
  rmSync(join(t.inst, 'workspace', 'profiles', 'a', '.claude', 'angelia-compiled.json'));
  const file = join(t.inst, 'new-backup.json');
  writeFileSync(file, 'x');
  // Without its record the launch would load every Claude app connector (connectors review H1).
  assert.deepEqual(guardOf(t).guard('a', true), ['the compiled record is missing or lacks its connectors list, so the launch would load every Claude app connector; compile again']);
  assert.ok(denyOf(t, 'a').includes(pathRule('Read', file, 'claude-code')));
  assert.ok(denyOf(t, 'a').includes(pathRule('Edit', file, 'claude-code')));
});

test('launch guard M1: a floor rule still missing after the refresh refuses the start', () => {
  const t = instance({ a: 'claude-code' });
  // The guard holds the new rule (so the refresh leaves it to the launch check), the settings do not.
  const file = join(t.inst, 'new-backup.json');
  writeFileSync(file, 'x');
  const gfile = join(t.inst, 'compiled', 'a.json');
  const g = JSON.parse(readFileSync(gfile, 'utf8'));
  writeFileSync(gfile, JSON.stringify({ ...g, deny: [...g.deny, pathRule('Read', file, 'claude-code')] }));
  const refused = guardOf(t).guard('a', true);
  assert.ok(refused.length >= 1, 'refused');
  assert.ok(refused.some((r) => r.includes(pathRule('Read', file, 'claude-code'))), refused.join('\n'));
});

test('launch guard L3: a question (can it start?) writes nothing; a start does', () => {
  const t = instance({ a: 'claude-code' });
  const file = join(t.inst, 'new-backup.json');
  writeFileSync(file, 'x');
  const { guard } = guardOf(t);
  const before = readFileSync(settingsOf(t, 'a'), 'utf8');
  assert.deepEqual(guard('a'), []);
  assert.equal(readFileSync(settingsOf(t, 'a'), 'utf8'), before);
  assert.deepEqual(guard('a', true), []);
  assert.notEqual(readFileSync(settingsOf(t, 'a'), 'utf8'), before);
});

test('M2 fix: a step after the refresh fails (the accepted table cannot be written): the other profiles are put back', () => {
  for (const how of ['onboard'] as const) {
    const t = instance({ a: 'claude-code', b: 'agy' }, `onboard:
  owners: ["15550000001"]
  profile: {backend: agy}
`);
    const before = { a: readFileSync(settingsOf(t, 'a'), 'utf8'), b: readFileSync(settingsOf(t, 'b'), 'utf8'), table: readFileSync(t.table, 'utf8') };
    mkdirSync(join(t.inst, `${ACCEPTED_FILE}.tmp`));
    const cfg = loadConfig(t.table);
    assert.throws(() => onboardChat({ table: t.table, cfg, platform: 'whatsapp', chat: 'n@g.us', chatName: 'Third', instance: t.inst, self: selfOf(t) }));
    assert.equal(readFileSync(settingsOf(t, 'a'), 'utf8'), before.a, how);
    assert.equal(readFileSync(settingsOf(t, 'b'), 'utf8'), before.b, how);
    assert.equal(readFileSync(t.table, 'utf8'), before.table, how);
    rmSync(join(t.inst, `${ACCEPTED_FILE}.tmp`), { recursive: true });
    fresh(t, ['a', 'b']);
  }
});

test('M3 fix: add_dirs into a closed entry of the state folder, given or taken, is drift', () => {
  const t = instance({ a: 'claude-code' });
  const deep = join(t.inst, 'tools', 'one');
  mkdirSync(deep, { recursive: true });
  mkdirSync(join(t.inst, 'tools', 'two'));
  planProfile(loadConfig(t.table), 'a', { stateDir: t.inst, self: selfOf(t) }).apply();
  const plain = readFileSync(t.table, 'utf8');
  const given = plain.replace('backend: claude-code}', `backend: claude-code, add_dirs: [${deep}]}`);
  writeFileSync(t.table, given);
  assert.match(compileDrift(loadConfig(t.table), t.table, ['a'], { stateDir: t.inst }), /Out of date: a/, 'given');
  planProfile(loadConfig(t.table), 'a', { stateDir: t.inst, self: selfOf(t) }).apply();
  assert.equal(compileDrift(loadConfig(t.table), t.table, ['a'], { stateDir: t.inst }), '');
  writeFileSync(t.table, plain);
  assert.match(compileDrift(loadConfig(t.table), t.table, ['a'], { stateDir: t.inst }), /Out of date: a/, 'taken');
});

test('L1: a rule for a state entry that is gone is dropped by the refresh', () => {
  const t = instance({ a: 'claude-code' });
  const file = join(t.inst, 'x.tmp');
  writeFileSync(file, 'x');
  const cfg = loadConfig(t.table);
  assert.ok(refreshFloor(cfg, 'a', t.inst).added.includes(pathRule('Read', file, 'claude-code')));
  rmSync(file);
  const r = refreshFloor(cfg, 'a', t.inst);
  assert.deepEqual(r.dropped.sort(), [pathRule('Edit', file, 'claude-code'), pathRule('Read', file, 'claude-code')].sort());
  assert.ok(!denyOf(t, 'a').includes(pathRule('Read', file, 'claude-code')));
  assert.equal(compileDrift(cfg, t.table, ['a'], { stateDir: t.inst }), '');
  assert.deepEqual(launchCheck(cfg, 'a', t.inst), []);
});

test('L2: the refresh waits for the compile lock, takes over one whose process is gone, and gives up on a live one', async () => {
  const t = instance({ a: 'claude-code' });
  writeFileSync(join(t.inst, 'new.json'), 'x');
  const cfg = loadConfig(t.table);
  const lock = join(t.inst, 'compiled', '.compile.lock');
  writeFileSync(lock, '999999\n');
  assert.equal(refreshFloor(cfg, 'a', t.inst).added.length, 2, 'a lock left by a process that is gone is taken over');
  assert.ok(!existsSync(lock), 'and let go after');
  writeFileSync(join(t.inst, 'newer.json'), 'x');
  const child = spawn('sleep', ['30']);
  try {
    writeFileSync(lock, `${child.pid}\n`);
    assert.throws(() => withCompileLock(t.inst, () => 1, 200), /another compile is writing/);
    assert.throws(() => refreshFloor(cfg, 'a', t.inst), /another compile is writing/);
  } finally { child.kill(); rmSync(lock, { force: true }); }
  assert.equal(withCompileLock(t.inst, () => withCompileLock(t.inst, () => 7)), 7, 'held again in the same process: no wait');
});

// Recheck (2026-11-24): N1-N3. N4 is in orchestrator.test.ts.

/** As a build before stateReach compiled it: no stateReach in the guard or the record. */
const oldBuild = (t: { inst: string }, n: string) => {
  for (const f of [join(t.inst, 'compiled', `${n}.json`), join(t.inst, 'workspace', 'profiles', n, '.claude', 'angelia-compiled.json')]) {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    delete j.stateReach;
    writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  }
};

test('N1: a profile compiled before stateReach takes it at its next start, and a new state entry is no drift after', () => {
  const t = instance({ a: 'claude-code' });
  oldBuild(t, 'a');
  writeFileSync(join(t.inst, 'new.json'), 'x');
  const cfg = loadConfig(t.table);
  assert.match(compileDrift(cfg, t.table, ['a'], { stateDir: t.inst }), /Out of date: a/, 'nothing to compare yet');
  assert.deepEqual(guardOf(t).guard('a', true), []);
  assert.ok(Array.isArray(JSON.parse(readFileSync(join(t.inst, 'compiled', 'a.json'), 'utf8')).stateReach));
  writeFileSync(join(t.inst, 'newer.json'), 'x');
  assert.equal(compileDrift(cfg, t.table, ['a'], { stateDir: t.inst }), '');
});

test('N1: not when the table gave the profile more of the state folder since its compile: that stays drift', () => {
  const t = instance({ a: 'claude-code' });
  const tool = join(t.inst, 'tool-x');
  mkdirSync(tool);
  planProfile(loadConfig(t.table), 'a', { stateDir: t.inst, self: selfOf(t) }).apply();
  oldBuild(t, 'a');
  writeFileSync(t.table, readFileSync(t.table, 'utf8').replace('backend: claude-code}', `backend: claude-code, add_dirs: [${tool}]}`));
  const cfg = loadConfig(t.table);
  refreshFloor(cfg, 'a', t.inst);
  assert.equal(JSON.parse(readFileSync(join(t.inst, 'compiled', 'a.json'), 'utf8')).stateReach, undefined);
  assert.match(compileDrift(cfg, t.table, ['a'], { stateDir: t.inst }), /Out of date: a/);
});

test('N2: the refresh keeps a file\'s mode: a 0600 settings file stays 0600', () => {
  const t = instance({ a: 'claude-code' });
  chmodSync(settingsOf(t, 'a'), 0o600);
  writeFileSync(join(t.inst, 'new.json'), 'x');
  assert.equal(refreshFloor(loadConfig(t.table), 'a', t.inst).added.length, 2);
  assert.equal(statSync(settingsOf(t, 'a')).mode & 0o777, 0o600);
  assert.equal(statSync(join(t.inst, 'compiled', 'a.json')).mode & 0o777, 0o600);
});

test('N3: a lock older than a minute is taken over though its process id is alive, by a rename that leaves nothing behind', () => {
  const t = instance({ a: 'claude-code' });
  writeFileSync(join(t.inst, 'new.json'), 'x');
  const lock = join(t.inst, 'compiled', '.compile.lock');
  writeFileSync(lock, `${process.pid}\n`); // alive: this process, as a reused id would be
  const old = new Date(Date.now() - 2 * 60_000);
  utimesSync(lock, old, old);
  assert.equal(refreshFloor(loadConfig(t.table), 'a', t.inst).added.length, 2);
  assert.deepEqual(readdirSync(join(t.inst, 'compiled')).filter((f) => f.startsWith('.compile.lock')), []);
});

test('N3: the daemon waits for a held lock briefly, then refuses the start', () => {
  const t = instance({ a: 'claude-code' });
  writeFileSync(join(t.inst, 'new.json'), 'x');
  const child = spawn('sleep', ['30']);
  const lock = join(t.inst, 'compiled', '.compile.lock');
  try {
    writeFileSync(lock, `${child.pid}\n`);
    const at = Date.now();
    const refused = guardOf(t).guard('a', true);
    assert.ok(Date.now() - at < 1500, `waited ${Date.now() - at} ms`);
    assert.match(refused[0] ?? '', /another compile is writing/);
  } finally { child.kill(); rmSync(lock, { force: true }); }
});

test('fix2 L1: the launch check compares with the floor the refresh wrote from; an entry made just after does not refuse the start', () => {
  const t = instance({ a: 'claude-code' });
  const cfg = loadConfig(t.table);
  const r = refreshFloor(cfg, 'a', t.inst);
  assert.ok(Array.isArray(r.floor), 'the refresh says which floor it used');
  // An entry made between the refresh and the check (a .tmp, a backup): not a refusal for this start.
  const late = join(t.inst, 'late.tmp');
  writeFileSync(late, 'x');
  assert.deepEqual(floorMissing(cfg, 'a', t.inst, undefined, r.floor), []);
  assert.ok(floorMissing(cfg, 'a', t.inst).includes(pathRule('Read', late, 'claude-code')), 'read now, it is missing');
  // The next start adds it.
  assert.deepEqual(guardOf(t).guard('a', true), []);
  assert.ok(denyOf(t, 'a').includes(pathRule('Read', late, 'claude-code')));
});

test('fix2 L4: a record whose deny the agent made a non-list does not refuse every start; the rule is written', () => {
  const t = instance({ a: 'claude-code' });
  const rec = join(t.inst, 'workspace', 'profiles', 'a', '.claude', 'angelia-compiled.json');
  writeFileSync(rec, JSON.stringify({ ...JSON.parse(readFileSync(rec, 'utf8')), deny: 'nope', stateReach: 7 }));
  const file = join(t.inst, 'new-backup.json');
  writeFileSync(file, 'x');
  const g = guardOf(t);
  assert.deepEqual(g.guard('a', true), [], g.log.join('\n'));
  assert.ok(denyOf(t, 'a').includes(pathRule('Read', file, 'claude-code')));
  assert.ok(JSON.parse(readFileSync(rec, 'utf8')).deny.includes(pathRule('Read', file, 'claude-code')), 'the record is a list again');
});

test('fix2 L6: a table\'s passing lock in the state folder gets no deny rule; a link or a second name with a lock\'s name does', () => {
  const t = instance({ a: 'claude-code' });
  const cfg = loadConfig(t.table);
  const table = join(t.inst, 'routing.yaml'); // a table kept at the state folder's top, as before workspaces
  writeFileSync(table, 'x');
  writeFileSync(`${table}.lock`, String(process.pid));
  writeFileSync(`${table}.lock.takeover`, '');
  const floor = profileFloor(cfg, 'a', t.inst);
  for (const p of [`${table}.lock`, `${table}.lock.takeover`]) assert.ok(!floor.includes(pathRule('Read', p, 'claude-code')), `${p}: no rule`);
  assert.ok(floor.includes(pathRule('Read', table, 'claude-code')), 'the table itself stays closed');
  // A lock name with no file beside it, a link, a hard link: denied as any entry.
  const env = join(t.inst, 'env');
  writeFileSync(env, 'TOKEN=1');
  linkSync(env, `${env}.lock`);
  rmSync(`${table}.lock.takeover`);
  symlinkSync(env, `${table}.lock.takeover`);
  writeFileSync(join(t.inst, 'orphan.lock'), '1');
  const after = profileFloor(cfg, 'a', t.inst);
  for (const p of [`${env}.lock`, `${table}.lock.takeover`, join(t.inst, 'orphan.lock')]) assert.ok(after.includes(pathRule('Read', p, 'claude-code')), `${p}: denied`);
});
