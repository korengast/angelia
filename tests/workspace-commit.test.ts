import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitWorkspace, secretFindings } from '../src/instance/workspace-commit.js';
import { checkArgs } from '../src/cli/cli-args.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

/** A workspace repo with one commit and two profiles. */
function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-wc-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  for (const p of ['a', 'b']) { mkdirSync(join(dir, 'profiles', p), { recursive: true }); writeFileSync(join(dir, 'profiles', p, 'CLAUDE.md'), `${p}\n`); }
  writeFileSync(join(dir, 'routing.yaml'), 'profiles: {}\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'start');
  return dir;
}

// Built at runtime, so this file holds no secret-shaped literal of its own.
const fakeToken = () => 'ghp_' + 'x1'.repeat(18);

test('commits only the paths given, under the agent\'s message; other changes stay pending', () => {
  const dir = ws();
  writeFileSync(join(dir, 'profiles', 'a', 'CLAUDE.md'), 'a, changed\n');
  writeFileSync(join(dir, 'profiles', 'a', 'new.md'), 'new\n');
  writeFileSync(join(dir, 'profiles', 'b', 'CLAUDE.md'), 'b, changed by someone else\n');
  const out = commitWorkspace({ workspace: dir, message: 'a: new notes', paths: ['.'], cwd: join(dir, 'profiles', 'a') });
  assert.match(out, /^committed [0-9a-f]{7}: 2 files, no remote to push to$/);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'a: new notes');
  assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['profiles/a/CLAUDE.md', 'profiles/a/new.md']);
  assert.equal(git(dir, 'status', '--porcelain'), 'M profiles/b/CLAUDE.md');
});

test('no paths: every change in the workspace; a deletion is committed too', () => {
  const dir = ws();
  writeFileSync(join(dir, 'routing.yaml'), 'profiles: { x: 1 }\n');
  execFileSync('rm', [join(dir, 'profiles', 'b', 'CLAUDE.md')]);
  assert.match(commitWorkspace({ workspace: dir, message: 'table and b' }), /: 2 files/);
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('a secret-shaped value is refused: nothing committed, nothing staged, the file untouched, the value never echoed', () => {
  const dir = ws();
  const body = `token: ${fakeToken()}\n`;
  writeFileSync(join(dir, 'profiles', 'a', 'notes.md'), body);
  const head = git(dir, 'rev-parse', 'HEAD');
  assert.throws(() => commitWorkspace({ workspace: dir, message: 'oops' }), (e: Error) => {
    assert.match(e.message, /nothing committed/);
    assert.match(e.message, /secret scan: profiles\/a\/notes\.md: a GitHub token/);
    assert.ok(!e.message.includes(fakeToken()));
    return true;
  });
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), '');
  assert.equal(readFileSync(join(dir, 'profiles', 'a', 'notes.md'), 'utf8'), body);
});

test('removing a secret is never blocked: only added lines are read', () => {
  const diff = `--- a/x.md\n+++ b/x.md\n@@ -1 +0,0 @@\n-key ${fakeToken()}\n`;
  assert.deepEqual(secretFindings(diff), []);
  assert.deepEqual(secretFindings(`+++ b/x.md\n+key ${fakeToken()}\n`), ['x.md: a GitHub token']);
  assert.deepEqual(secretFindings('+++ b/doc.md\n+Put your GitHub token in the keychain, never here.\n'), []);
});

test('card numbers and IBANs are caught by their check digits; ids that only look long are not', () => {
  const found = (line: string) => secretFindings(`+++ b/m.md\n+${line}\n`).map((f) => f.slice(6));
  assert.deepEqual(found('card 4111 1111 1111 1111 exp 12/29'), ['a card number']);
  assert.deepEqual(found('card 4111-1111-1111-1111'), ['a card number']);
  assert.deepEqual(found(['37828224', '6310005'].join('')), ['a card number'], 'an Amex, no spaces');
  assert.deepEqual(found('transfer to GB82 WEST 1234 5698 7654 32 today'), ['an IBAN']);
  assert.deepEqual(found('card 4111 1111 1111 1112'), [], 'the Luhn digit is wrong');
  assert.deepEqual(found('GB82 WEST 1234 5698 7654 33'), [], 'mod 97 is wrong');
  assert.deepEqual(found('120363000000000001@g.us'), [], 'a WhatsApp group id');
  assert.deepEqual(found('order 2026092412345678'), [], 'no card issuer starts with 20');
  assert.deepEqual(found('"yoy": 0.4111111111111111, "x": 4111111111111111.5'), [], 'the digits of a float');
});

test('a failing gate stops the commit and names itself; a passing one does not', () => {
  const dir = ws();
  writeFileSync(join(dir, 'routing.yaml'), 'broken: [\n');
  const head = git(dir, 'rev-parse', 'HEAD');
  assert.throws(
    () => commitWorkspace({ workspace: dir, message: 'm', gates: [{ name: 'fine', check: () => undefined }, { name: 'check-config', check: () => { throw new Error('cannot read routing.yaml'); } }] }),
    /gate failed: check-config: cannot read routing\.yaml/,
  );
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), '');
  assert.match(commitWorkspace({ workspace: dir, message: 'm', gates: [{ name: 'fine', check: () => undefined }] }), /^committed/);
});

test('refused: no message, a path outside the workspace; nothing to commit is said plainly', () => {
  const dir = ws();
  assert.throws(() => commitWorkspace({ workspace: dir, message: '  ' }), /needs a message/);
  assert.throws(() => commitWorkspace({ workspace: dir, message: 'm', paths: ['/etc'] }), /outside the workspace/);
  assert.equal(commitWorkspace({ workspace: dir, message: 'm' }), 'nothing to commit');
});

test('pushes when there is a remote, unless --no-push; a later commit pushes what was left', () => {
  const dir = ws();
  const remote = mkdtempSync(join(tmpdir(), 'angelia-wc-remote-'));
  git(remote, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'origin', remote);
  writeFileSync(join(dir, 'routing.yaml'), 'profiles: { y: 1 }\n');
  assert.match(commitWorkspace({ workspace: dir, message: 'one', push: false }), /^committed [0-9a-f]{7}: 1 file$/);
  writeFileSync(join(dir, 'routing.yaml'), 'profiles: { y: 2 }\n');
  assert.match(commitWorkspace({ workspace: dir, message: 'two' }), /: 1 file, pushed$/);
  assert.equal(git(remote, 'log', '--format=%s', 'main').split('\n').join(','), 'two,one,start');
});

test('the CLI flag check reads -m as taking a value, so a message may start with dashes', () => {
  assert.deepEqual(checkArgs('workspace', ['commit', '-m', '--help is fixed', 'profiles/a']), { ok: true });
  assert.deepEqual(checkArgs('workspace', ['commit', '--message', 'x', '--no-push']), { ok: true });
  assert.ok('error' in checkArgs('workspace', ['commit', '-m', 'x', '--force']));
});

test('the gates check the profiles a commit touches; the table or a shared file checks them all', async () => {
  const { touched } = await import('../src/instance/workspace-gates.js');
  const { Config } = await import('../src/instance/config/schema.js');
  const ws = '/w';
  const cfg = Config.parse({ profiles: { a: { cwd: '/w/profiles/a' }, ab: { cwd: '/w/profiles/ab' }, out: { cwd: '/elsewhere/c' } }, routes: [] });
  assert.deepEqual(touched(cfg, '/w/routing.yaml', ws, ['profiles/a/TODO.md']), ['a'], 'not ab, whose name only starts the same');
  assert.deepEqual(touched(cfg, '/w/routing.yaml', ws, ['profiles/a/x', 'profiles/ab/y']), ['a', 'ab']);
  assert.deepEqual(touched(cfg, '/w/routing.yaml', ws, ['profiles/gone/z']), []);
  assert.deepEqual(touched(cfg, '/w/routing.yaml', ws, ['routing.yaml']), ['a', 'ab', 'out']);
  assert.deepEqual(touched(cfg, '/w/routing.yaml', ws, ['_capabilities/tools/t.py']), ['a', 'ab', 'out']);
});
