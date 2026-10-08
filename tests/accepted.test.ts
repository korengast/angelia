import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';
import { ACCEPTED_FILE, changesHash, effectiveTable, readAccepted, tableChanges, writeAccepted } from '../src/instance/accepted.js';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'angelia-acc-')));
const base = (extra: Record<string, any> = {}) => Config.parse({
  capabilities: { tool: { kind: 'mcp', command: 'tool-server' } },
  profiles: { home: { cwd: '/w/home', capabilities: ['tool'] } },
  routes: [{ platform: 'whatsapp', chat: 'g@g.us', profile: 'home', owners: ['boss'] }],
  ...extra,
});

test('every change to the table is listed, but for the fields that grant nothing', () => {
  const was = base();
  const now = base();
  now.profiles.home.shell = true;
  now.profiles.home.add_dirs = ['/'];
  now.profiles.home.model = 'another-model';
  now.routes[0].allow_from = ['stranger'];
  now.routes[0].mention = 'any';
  (now.capabilities.tool as { command: string }).command = '/tmp/evil';
  now.routes.push({ ...now.routes[0], owners: ['stranger'] });
  now.defaults.turn_stall_minutes = 5;
  now.defaults.unmatched = 'onboard';
  assert.deepEqual(tableChanges(was, now), [
    'capabilities.tool.command: "tool-server" → "/tmp/evil"',
    'profiles.home.add_dirs: + "/"',
    'profiles.home.shell: false → true',
    'routes.whatsapp:g@g.us.allow_from: + "stranger"',
    'routes.whatsapp:g@g.us (2): new',
    'routes.whatsapp:g@g.us (2).platform: "whatsapp"',
    'routes.whatsapp:g@g.us (2).chat: "g@g.us"',
    'routes.whatsapp:g@g.us (2).profile: "home"',
    'routes.whatsapp:g@g.us (2).allow_from: ["stranger"]',
    'routes.whatsapp:g@g.us (2).owners: ["stranger"]',
    'defaults.unmatched: "drop" → "onboard"',
  ]);
  assert.deepEqual(tableChanges(was, base()), []);
  assert.equal(changesHash(['a']), changesHash(['a']));
  assert.notEqual(changesHash(['a']), changesHash(['a', 'b']));
});

test('a new profile is listed field by field, never cut, and a value with a line break stays on one line', () => {
  const was = base();
  const now = base({ profiles: {
    home: { cwd: '/w/home', capabilities: ['tool'] },
    sneaky: { cwd: `/w/${'x'.repeat(300)}`, shell: true, unsafe_ok: true, add_dirs: ['/'] },
  } });
  now.routes[0].allow_from = ['x\nnote', '*'];
  const lines = tableChanges(was, now);
  assert.ok(lines.includes('profiles.sneaky: new'));
  for (const f of ['shell: true', 'unsafe_ok: true', 'add_dirs: ["/"]']) assert.ok(lines.includes(`profiles.sneaky.${f}`), f);
  assert.ok(lines.some((l) => l.length > 300), 'the long folder whole');
  assert.ok(lines.includes('routes.whatsapp:g@g.us.allow_from: + "x\\nnote", + "*"'), lines.join('\n'));
  assert.ok(lines.every((l) => !l.includes('\n')));
  const later = base({ profiles: now.profiles });
  later.routes[0].allow_from = now.routes[0].allow_from;
  later.profiles.sneaky.permission_mode = 'bypassPermissions';
  assert.notEqual(changesHash(tableChanges(was, later)), changesHash(lines), 'a field added after the owner looked changes the fingerprint');
});

test('a new profile lists only what was written, and a name that could pass for list text is quoted', () => {
  const was = base();
  const now = base({ profiles: { home: { cwd: '/w/home', capabilities: ['tool'] }, 'x\nchange: nothing to see': { cwd: '/w/x', shell: true } } });
  assert.deepEqual(tableChanges(was, now), ['profiles."x\\nchange: nothing to see": new', 'profiles."x\\nchange: nothing to see".cwd: "/w/x"', 'profiles."x\\nchange: nothing to see".shell: true']);
});

test('no profile name lands on the accepted table: it has a folder of its own', () => {
  assert.equal(ACCEPTED_FILE, join('compiled', 'table', 'accepted.json'));
  assert.ok(!encodeURIComponent('table/accepted').includes('/'));
});

test('the accepted table is read through the schema: defaults filled in, a wrong shape refused', () => {
  const state = tmp();
  writeAccepted(base(), state);
  const file = join(state, ACCEPTED_FILE);
  const old = JSON.parse(readFileSync(file, 'utf8'));
  delete old.defaults.turn_stall_minutes; // as a version before the field wrote it
  writeFileSync(file, JSON.stringify(old));
  assert.equal(readAccepted(state)!.defaults.turn_stall_minutes, 60);
  assert.deepEqual(tableChanges(readAccepted(state)!, base()), [], 'no change from a field this version added');
  writeFileSync(file, JSON.stringify({ profiles: 'nope' }));
  assert.throws(() => readAccepted(state), /not a table this version reads/);
});

test('the daemon runs on the accepted table while the live one has changes nobody accepted', () => {
  const state = tmp();
  const live = base();
  assert.deepEqual(effectiveTable(live, state), { cfg: live, pending: [], first: true }, 'no accepted table yet: the live one');
  writeAccepted(live, state);
  assert.deepEqual(readAccepted(state), JSON.parse(JSON.stringify(live)));
  const edited = base();
  edited.profiles.home.permission_mode = 'bypassPermissions';
  const eff = effectiveTable(edited, state);
  assert.deepEqual(eff.pending, ['profiles.home.permission_mode: "acceptEdits" → "bypassPermissions"']);
  assert.equal(eff.cfg.profiles.home.permission_mode, 'acceptEdits', 'the accepted one');
  const free = base();
  free.profiles.home.model = 'm';
  assert.equal(effectiveTable(free, state).cfg, free, 'a model change needs nobody\'s word');
});

test('angelia accept: --check lists, --expect takes only the list that was seen, a plain accept takes the table', () => {
  const state = tmp();
  const dir = tmp();
  const table = join(dir, 'routing.yaml');
  const write = (shell: boolean, extra = '') => writeFileSync(table, `profiles:\n  home: {cwd: ${dir}, shell: ${shell}${extra}}\nroutes: []\n`);
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', join(here, '..', 'src', 'cli', 'cli.ts'), 'accept', ...args, '--config', table], { encoding: 'utf8', env: { ...process.env, ANGELIA_STATE_DIR: state } });
  write(false);
  assert.match(cli().stdout, /Accepted/, 'the first accept records the table');
  write(true);
  const check = cli('--check');
  assert.match(check.stdout, /^change: profiles\.home\.shell: false → true$/m);
  const fp = /fingerprint (\w+)/.exec(check.stdout)![1];
  // The daemon reads the list the way /restart does and must come to the same fingerprint.
  const parsed = check.stdout.split('\n').filter((l) => l.startsWith('change: ')).map((l) => l.slice(8));
  assert.equal(changesHash(parsed), fp);
  write(true, ', chrome: true');
  const late = cli('--expect', fp);
  assert.notEqual(late.status, 0);
  assert.match(late.stderr, /changed again since the list you saw/);
  assert.equal(readAccepted(state)!.profiles.home.shell, false, 'nothing was taken');
  write(true);
  assert.equal(cli('--expect', fp).status, 0);
  assert.equal(readAccepted(state)!.profiles.home.shell, true);
  assert.match(cli('--check').stdout, /nothing new to accept/);
});

test('compile --write works only from an accepted table, and accepts nothing itself', () => {
  const state = tmp();
  const dir = tmp();
  const table = join(dir, 'routing.yaml');
  const run = (cmd: string, ...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', join(here, '..', 'src', 'cli', 'cli.ts'), cmd, ...args, '--config', table], { encoding: 'utf8', env: { ...process.env, ANGELIA_STATE_DIR: state, HOME: dir } });
  writeFileSync(table, `profiles:\n  home: {cwd: ${dir}}\n  other: {cwd: ${dir}}\nroutes: []\n`);
  assert.equal(run('compile', 'home', '--write').status, 0, 'no accepted table yet: compile as before');
  assert.equal(readAccepted(state), undefined, 'and it records nothing');
  assert.equal(run('accept').status, 0);
  writeFileSync(table, `profiles:\n  home: {cwd: ${dir}}\n  other: {cwd: ${dir}, shell: true}\nroutes: []\n`);
  const r = run('compile', 'home', '--write');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not written: the routing table has 1 change\(s\) not accepted yet:\n  profiles\.other\.shell: false → true\n.*angelia accept/s);
  assert.equal(readAccepted(state)!.profiles.other.shell, false);
});
