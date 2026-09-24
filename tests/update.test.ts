import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changesText, chooseTarget, defaultSource, newCommits, readBuild, refusal, releaseTags, verifyTag } from '../src/daemon/update.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'angelia-upd-'));

test('update refuses a checkout, a linked global install, and a global folder inside the instance', () => {
  const state = tmp();
  const checkout = tmp();
  mkdirSync(join(checkout, '.git'));
  assert.match(refusal(checkout, tmp(), state, 'angelia-gateway')!, /runs from a checkout/);

  const pkg = tmp();
  const linked = tmp();
  symlinkSync(checkout, join(linked, 'angelia-gateway'));
  assert.match(refusal(pkg, linked, state, 'angelia-gateway')!, /is a link to a checkout/);

  assert.match(refusal(pkg, join(state, 'npm', 'lib', 'node_modules'), state, 'angelia-gateway')!, /inside the instance/);

  const real = tmp();
  mkdirSync(join(real, 'angelia-gateway'));
  assert.equal(refusal(pkg, real, state, 'angelia-gateway'), undefined);
});

test('update reads the build stamp and the repository URL from the installed package', () => {
  const root = tmp();
  assert.equal(readBuild(root), undefined);
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'build.json'), '{"commit":"abc","dirty":false}');
  writeFileSync(join(root, 'package.json'), '{"repository":{"type":"git","url":"git+https://example.com/a.git"}}');
  assert.deepEqual(readBuild(root), { commit: 'abc', dirty: false });
  writeFileSync(join(root, 'dist', 'build.json'), '{"commit":');
  assert.throws(() => readBuild(root), /not valid JSON, so the installed commit is unknown/, 'a broken stamp must not skip the ancestry check');
  assert.equal(defaultSource(root), 'https://example.com/a.git');
});

test('update says what changed, and says so plainly when it cannot know', () => {
  const to = 'bbbbbbb0000';
  assert.deepEqual(changesText({ commit: 'aaaaaaa0000' }, to, ['bbbbbbb second', 'ccccccc first']),
    ['aaaaaaa → bbbbbbb, 2 commits:', '  bbbbbbb second', '  ccccccc first']);
  assert.match(changesText({ commit: 'aaaaaaa0000' }, to, undefined)[0], /not in the source's history/);
  assert.match(changesText(undefined, to, [])[0], /no build stamp/);
  assert.match(changesText({ commit: 'aaaaaaa0000', dirty: true }, to, [])[0], /uncommitted changes/);
});

test('releases are vX.Y.Z tags, newest by number, not by text', () => {
  assert.deepEqual(releaseTags(['v0.9.0', 'v0.10.0', 'latest', 'v1.0.0-rc1', 'v0.10.1', '']), ['v0.10.1', 'v0.10.0', 'v0.9.0']);
});

/** A source repo with a release key, an attacker's key, and a helper to commit and tag. */
function source() {
  const dir = tmp(), repo = join(dir, 'src');
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' }).trim();
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const key = (name: string) => { execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', join(dir, name)]); return join(dir, name); };
  const release = key('release'), other = key('other');
  const signers = (k: string) => `angelia-release namespaces="git" ${readFileSync(`${k}.pub`, 'utf8').trim()}\n`;
  let n = 0;
  const commit = () => { writeFileSync(join(repo, 'f'), String(++n)); git('add', 'f'); git('commit', '-q', '-m', `c${n}`); return git('rev-parse', 'HEAD'); };
  const tag = (name: string, k = release) => git('-c', 'gpg.format=ssh', '-c', `user.signingkey=${k}`, 'tag', '-s', name, '-m', name);
  return { dir, repo, git, commit, tag, release, other, signers };
}

test('a release is taken only when its tag is signed by a key the installed copy trusts', () => {
  const s = source();
  const installed = tmp();
  const first = s.commit();
  assert.throws(() => chooseTarget(s.repo, installed, false), /no release tag .* --head/);
  assert.deepEqual(chooseTarget(s.repo, installed, true).commit, first, '--head is the branch tip');

  s.tag('v0.1.0');
  // A copy with no keys refuses, even when the download brings some: those are whoever-controls-the-repo's keys.
  writeFileSync(join(s.repo, 'allowed_signers'), s.signers(s.release));
  assert.throws(() => chooseTarget(s.repo, installed, false), /installed copy has no release keys.*install\.sh/);

  // The installed copy's keys decide, whatever the download brings.
  writeFileSync(join(installed, 'allowed_signers'), s.signers(s.release));
  const t = chooseTarget(s.repo, installed, false);
  assert.equal(t.tag, 'v0.1.0');
  s.git('checkout', '-q', 'main');
  s.commit();
  s.tag('v0.2.0', s.other);
  writeFileSync(join(s.repo, 'allowed_signers'), s.signers(s.other));
  assert.throws(() => chooseTarget(s.repo, installed, false), /v0\.2\.0 is not a release this copy trusts/);
  assert.match(verifyTag(s.repo, 'v0.1.0', join(installed, 'allowed_signers')) ?? 'ok', /^ok$/);

  s.git('checkout', '-q', 'main');
  const third = s.commit();
  s.git('tag', 'v0.3.0', '-m', 'unsigned');
  assert.throws(() => chooseTarget(s.repo, installed, false), /v0\.3\.0 is not a release/);
  s.tag('v0.3.1');
  const ok = chooseTarget(s.repo, installed, false);
  assert.deepEqual([ok.tag, ok.commit], ['v0.3.1', third]);

  // A genuine old tag object under a new, higher name verifies as a signature, but names itself v0.1.0.
  const obj = s.git('rev-parse', 'v0.1.0');
  s.git('update-ref', 'refs/tags/v9.0.0', obj);
  assert.equal(verifyTag(s.repo, 'v9.0.0', join(installed, 'allowed_signers')), 'the signed tag object is named v0.1.0, not v9.0.0');
  assert.throws(() => chooseTarget(s.repo, installed, false), /v9\.0\.0 is not a release.*named v0\.1\.0/);
});

test('an update whose history does not contain the installed commit is refused without --force', () => {
  const s = source();
  const a = s.commit(), b = s.commit();
  assert.deepEqual(newCommits(s.repo, { commit: a }, b, false)?.length, 1);
  assert.throws(() => newCommits(s.repo, { commit: b }, a, false), /not in the history .* older than what is installed.*--force/);
  assert.equal(newCommits(s.repo, { commit: b }, a, true), undefined, '--force: installed, and the lines say the history is unknown');
  assert.throws(() => newCommits(s.repo, { commit: 'f'.repeat(40) }, b, false), /rewritten/);
  assert.equal(newCommits(s.repo, undefined, b, false)?.length, 2, 'no build stamp: the last commits, no refusal');
});
