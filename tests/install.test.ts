import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const script = readFileSync(join(root, 'install.sh'), 'utf8');

test('install.sh carries exactly the keys in allowed_signers', () => {
  const embedded = /^SIGNERS='([^']*)'$/m.exec(script)?.[1];
  assert.notEqual(embedded, undefined, 'a SIGNERS line');
  const file = join(root, 'allowed_signers');
  assert.equal(embedded, existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
});

/** install.sh up to the build, against a local repository: npm is a stand-in that stops it there. */
function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-install-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'f'), '1');
  git('add', 'f');
  git('commit', '-q', '-m', 'c1');
  const key = (name: string) => { execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', join(dir, name)]); return join(dir, name); };
  const release = key('release'), other = key('other');
  const tag = (name: string, k: string) => git('-c', 'gpg.format=ssh', '-c', `user.signingkey=${k}`, 'tag', '-s', name, '-m', name);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho "npm reached" >&2\nexit 7\n');
  chmodSync(join(bin, 'npm'), 0o755);
  const signers = `angelia-release namespaces="git" ${readFileSync(`${release}.pub`, 'utf8').trim()}`;
  const copy = join(dir, 'install.sh');
  writeFileSync(copy, script.replace(/^SIGNERS='[^']*'$/m, `SIGNERS='${signers}'`));
  const run = (env: Record<string, string> = {}) => {
    const r = spawnSync('sh', [copy], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ANGELIA_REPO: `file://${repo}`, ANGELIA_STATE_DIR: join(dir, 'state'), ...env } });
    return `${r.stdout}${r.stderr}`;
  };
  return { git, tag, release, other, run };
}

test('install.sh installs only a tag signed by the key it carries, and one that names itself', () => {
  const r = rig();
  r.tag('v0.1.0', r.release);
  assert.match(r.run(), /v0\.1\.0: signature checked[\s\S]*npm reached/, 'a depth-1 clone keeps the tag object');
  r.tag('v0.2.0', r.other);
  assert.match(r.run(), /v0\.2\.0 is not signed by the Angelia release key\. Nothing was installed\./);
  assert.doesNotMatch(r.run(), /npm reached/);
  r.git('tag', '-d', 'v0.2.0');
  r.git('tag', 'v0.3.0', '-m', 'unsigned');
  assert.match(r.run(), /v0\.3\.0 is not signed/);
  r.git('tag', '-d', 'v0.3.0');
  r.git('update-ref', 'refs/tags/v9.0.0', r.git('rev-parse', 'v0.1.0'));
  assert.match(r.run(), /v9\.0\.0 is a signed tag of another release under a new name/);
  r.git('tag', '-d', 'v9.0.0');
  r.git('tag', 'v1.0.0');
  assert.match(r.run(), /v1\.0\.0 is not a signed release tag/, 'a lightweight tag');
  assert.match(r.run({ ANGELIA_REF: 'main' }), /main is not a release tag: installing it unsigned[\s\S]*npm reached/);
});
