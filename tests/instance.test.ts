import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GITIGNORE, buildSkeleton, configPath, defaultConfigPath, describeInstance, initRepo, isRepo, profileDir, syncWorkspace, workspaceDir } from '../src/instance/instance.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'angelia-inst-'));

test('the skeleton is one folder with one boundary inside it', () => {
  const dir = fresh();
  const s = buildSkeleton(['main', 'family'], dir);
  for (const p of ['profiles', '_shared', '_capabilities', '_capabilities/skills', '_capabilities/tools', '.gitignore', 'README.md']) {
    assert.ok(existsSync(join(s.workspace, p)), p);
  }
  for (const sub of ['memory', 'prompts', 'docs', 'scripts']) {
    assert.ok(existsSync(join(profileDir('family', dir), sub)), sub);
  }
  assert.equal(s.configPath, join(workspaceDir(dir), 'routing.yaml'));
  // The credentials side is the parent, and nothing in the skeleton reaches into it.
  assert.ok(s.created.every((p) => p.startsWith(workspaceDir(dir))));
});

test('a second run adds and never overwrites: everything in there was written by a person', () => {
  const dir = fresh();
  buildSkeleton(['main'], dir);
  const mine = join(profileDir('main', dir), 'memory', 'notes.md');
  writeFileSync(mine, 'hand written');
  writeFileSync(join(workspaceDir(dir), '.gitignore'), 'mine\n');

  const again = buildSkeleton(['main', 'later'], dir);
  assert.equal(readFileSync(mine, 'utf8'), 'hand written');
  assert.equal(readFileSync(join(workspaceDir(dir), '.gitignore'), 'utf8'), 'mine\n');
  assert.ok(again.created.some((p) => p.includes('later')), 'the new profile is created');
  assert.ok(!again.created.includes(mine));
});

test('the generated ignore file keeps a stray key out of the repo', () => {
  const dir = fresh();
  const s = buildSkeleton(['main'], dir);
  if (initRepo(s.workspace).startsWith('not version controlled')) return; // no git on this machine
  const p = profileDir('main', dir);
  writeFileSync(join(p, '.env'), 'TOKEN=shhh');
  writeFileSync(join(p, 'deploy.pem'), 'key');
  mkdirSync(join(p, '.state'), { recursive: true });
  writeFileSync(join(p, '.state', 'cache.json'), '{}');
  writeFileSync(join(p, 'memory', 'notes.md'), 'keep me');

  const seen = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: s.workspace, encoding: 'utf8' });
  assert.doesNotMatch(seen, /\.env/);
  assert.doesNotMatch(seen, /\.pem/);
  assert.doesNotMatch(seen, /\.state/);
  assert.match(seen, /notes\.md/);
  assert.match(GITIGNORE, /^\.env$/m);
});

test('git touches the workspace and never the directory holding the credentials', () => {
  const dir = fresh();
  const s = buildSkeleton(['main'], dir);
  writeFileSync(join(dir, 'env'), 'TELEGRAM_BOT_TOKEN=secret');
  const what = initRepo(s.workspace);
  if (what.startsWith('not version controlled')) return;
  assert.ok(isRepo(s.workspace));
  assert.ok(!isRepo(dir), 'the instance root is not a repo');
  const tracked = execFileSync('git', ['ls-files'], { cwd: s.workspace, encoding: 'utf8' });
  assert.doesNotMatch(tracked, /env/);
  assert.equal(initRepo(s.workspace), 'already a git repo; left alone');
});

test('one table, whichever subcommand asks: the workspace, then a checkout', () => {
  const dir = fresh();
  const ws = join(dir, 'workspace');
  const checkout = fresh();
  assert.equal(defaultConfigPath(dir, checkout), join(ws, 'routing.yaml'), 'nothing yet: where a new one belongs');
  writeFileSync(join(checkout, 'routing.yaml'), 'profiles: {}\nroutes: []\n');
  assert.equal(defaultConfigPath(dir, checkout), join(checkout, 'routing.yaml'));
  buildSkeleton([], dir);
  writeFileSync(join(ws, 'routing.yaml'), 'profiles: {}\nroutes: []\n');
  assert.equal(defaultConfigPath(dir, checkout), join(ws, 'routing.yaml'), 'the workspace wins');
  assert.match(describeInstance(dir), /table +.*workspace\/routing\.yaml/);
});

test('configPath: the command line, then ANGELIA_CONFIG (what a timer and the service carry), then the default', () => {
  assert.equal(configPath('/x/table.yaml', { ANGELIA_CONFIG: '/env/table.yaml' }), '/x/table.yaml');
  assert.equal(configPath(undefined, { ANGELIA_CONFIG: '/env/table.yaml' }), '/env/table.yaml');
  assert.equal(configPath(undefined, {}), defaultConfigPath());
});

test('workspace sync commits what changed, pushes it, and is silent when there is nothing', () => {
  const instance = mkdtempSync(join(tmpdir(), 'angelia-sync-'));
  const ws = buildSkeleton(['p'], instance).workspace;
  initRepo(ws);
  const git = (args: string[], cwd = ws) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const now = new Date('2026-09-21T03:30:00Z');
  assert.equal(syncWorkspace(ws, now), '', 'nothing changed, no remote');
  writeFileSync(join(ws, 'profiles', 'p', 'notes.md'), 'x');
  assert.equal(syncWorkspace(ws, now), 'saved 1 file, no remote to push to');
  // A pasted key is left out of the nightly save, and said; the rest is saved.
  writeFileSync(join(ws, 'profiles', 'p', 'leak.md'), `token ${'ghp_'}${'A1b2'.repeat(9)}\n`);
  writeFileSync(join(ws, 'profiles', 'p', 'kept.md'), 'k');
  assert.equal(syncWorkspace(ws, now), 'saved 1 file, no remote to push to; left out, secret-shaped: profiles/p/leak.md: a GitHub token');
  assert.match(git(['status', '--porcelain']), /\?\? profiles\/p\/leak\.md/, 'still on disk, never committed');
  rmSync(join(ws, 'profiles', 'p', 'leak.md'));
  // A file name git quotes in a diff header (not ASCII) is still the name it holds back.
  const hebrew = join(ws, 'profiles', 'p', '\u05e7\u05e0\u05d9\u05d5\u05ea.md');
  writeFileSync(hebrew, `paid with 4111 1111 1111 1111\n`);
  assert.match(syncWorkspace(ws, now), /left out, secret-shaped: profiles\/p\/\u05e7\u05e0\u05d9\u05d5\u05ea\.md: a card number/);
  assert.doesNotMatch(git(['-c', 'core.quotePath=false', 'ls-files']), /\u05e7/, 'never committed');
  rmSync(hebrew);
  const remote = join(instance, 'remote.git');
  git(['init', '-q', '--bare', remote], instance);
  git(['remote', 'add', 'origin', remote]);
  assert.equal(syncWorkspace(ws, now), 'pushed', 'the first push sets the upstream');
  writeFileSync(join(ws, 'profiles', 'p', 'more.md'), 'y');
  writeFileSync(join(ws, 'profiles', 'p', '.env'), 'SECRET=1');
  assert.equal(syncWorkspace(ws, now), 'saved 1 file, pushed', '.env stays out');
  assert.equal(syncWorkspace(ws, now), '');
  assert.match(git(['log', '--format=%s', '-1', 'main'], remote), /^Workspace sync 2026-09-21: 1 file/);
  assert.throws(() => syncWorkspace(join(instance, 'nope')), /not a git repo/);
});

test('the starter skills are copied into a new workspace once, and an owner\'s own folder is left alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-starter-'));
  buildSkeleton([], dir);
  const skills = join(workspaceDir(dir), '_capabilities', 'skills');
  for (const name of ['checkout', 'mfa']) {
    const text = readFileSync(join(skills, name, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${name}\\n`));
    assert.match(text, /Suggestions, not rules/);
  }
  writeFileSync(join(skills, 'mfa', 'SKILL.md'), 'mine');
  buildSkeleton([], dir);
  assert.equal(readFileSync(join(skills, 'mfa', 'SKILL.md'), 'utf8'), 'mine');
});
