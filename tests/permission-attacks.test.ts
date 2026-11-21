import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, MAX_COMMAND, type PermissionPolicy, type ToolRequest } from '../src/core/permission-rules.js';

/** The security review's attacks on the matcher, each with the level it must get. */
const ctx = { cwd: '/w/prof', home: '/Users/example' };
const pol = (o: Partial<PermissionPolicy>): PermissionPolicy => ({ default: 'ask', refuse: [], ask: [], approve: [], ...o });
const bash = (command: string): ToolRequest => ({ tool: 'Bash', input: { command } });
const level = (p: Partial<PermissionPolicy>, req: ToolRequest | undefined) => decide(pol(p), req, ctx).level;

test('approve: a shell line that is not plain is asked, whatever the approve rules say', () => {
  const A = { approve: ['Bash(git status *)', 'Bash(echo *)', 'Bash(ls *)'] };
  const cases: [string, string][] = [
    ['a comment hides a newline command', "git status # '\nrm -rf ~ # '"],
    ['the same with double quotes', 'git status # "\nrm -rf ~ # "'],
    ['>& to a file', 'echo evil >& /Users/example/.zshrc'],
    ['an escaped quote hides a redirection', "echo \\' >/Users/example/.zshrc \\'"],
    ['zsh =( )', 'git status =(touch /tmp/pwn)'],
    ['zsh glob qualifier', "ls *(e:'touch /tmp/pwn':)"],
    ['zsh glob qualifier, unquoted', 'ls *(e:touch\\ /tmp/pwn:)'],
    ['brace group', 'echo a; { rm x; }'],
    ['heredoc', 'echo <<EOF\nx\nEOF'],
    ['>|', 'echo x >| f'],
    ['a parameter expansion runs a command', 'echo ${x:-`id`}'],
    ['newline', 'git status\nrm x'],
    ['bash -c with two commands', "bash -c 'git status; rm x'"],
    ['an assignment in front', 'GIT_PAGER=rm git status'],
    ['carriage return', 'git status\rrm x'],
    ['$() in double quotes', 'echo "a$(id)"'],
    ['zsh ${(e)}', 'echo ${(e)x}'],
    ['2> to a file', 'echo x 2>/Users/example/.zshrc'],
    ['1>&2', 'echo x 1>&2'],
    ['a background &', 'echo x & rm y'],
    ['a letter outside ASCII as a separator', 'git status rm x'],
    ['a tab', 'git status\trm'],
  ];
  for (const [name, cmd] of cases) assert.equal(level(A, bash(cmd)), 'ask', name);
  assert.equal(level({ approve: ['Bash(ls*)'] }, bash('ls() { id; }')), 'ask', 'a function definition');
  assert.equal(level({ approve: ['Bash(git *)'] }, bash("git -c core.pager='sh -c id' log")), 'ask', 'git -c names a program to run');
  assert.equal(level({ approve: ['Bash(git *)'] }, bash('git --config-env=core.pager=X log')), 'ask');
  assert.equal(level({ approve: ['Bash(git *)'] }, bash('git -C sub log')), 'approve', 'git -C is fine');
  assert.equal(level(A, bash('time git status')), 'approve', 'a plain wrapper is taken off');
  assert.equal(level(A, bash("echo 'a b' \"c d\"")), 'approve', 'quoted strings with nothing in them that runs');
  assert.equal(level(A, bash("echo '$HOME'")), 'ask', 'a $ even inside single quotes is asked');
});

test('approve: a plain pipeline or && list passes only when every part has its approve rule', () => {
  const P = { approve: ['Bash(git log *)', 'Bash(head *)'] };
  assert.equal(level(P, bash('git log --oneline | head -5')), 'approve');
  assert.equal(level(P, bash('git log && head -1 x')), 'approve');
  assert.equal(level(P, bash('git log | tee out')), 'ask');
  assert.deepEqual(decide(pol(P), bash('git log | head'), ctx).rule, 'approve: Bash(git log *) + Bash(head *)');
});

test('refuse: the usual ways round a shell rule are seen', () => {
  const R = { default: 'approve' as const, refuse: ['Bash(rm *)', 'Bash(git push *)', 'Read(~/.ssh/**)', 'WebFetch(domain:evil.com)'] };
  const cases: [string, string][] = [
    ['a comment hides a newline command', "ls # '\nrm -rf ~ # '"],
    ['backslash', '\\rm -rf x'],
    ['quoted name', '"rm" -rf x'],
    ['empty quotes inside the name', "r''m -rf x"],
    ['git -C', 'git -C . push origin'],
    ['git -c', 'git -c a=b push'],
    ['find -exec', 'find . -exec rm {} +'],
    ['find -execdir', 'find . -name x -execdir rm {} \\;'],
    ['xargs with options', 'ls | xargs -n1 rm'],
    ['brace group', '{ rm -rf x; }'],
    ['if/then', 'if true; then rm x; fi'],
    ['while/do', 'while true; do rm x; done'],
    ['! in front', '! rm x'],
    ['sudo with options', 'sudo -u root rm x'],
    ['a path', '/bin/rm x'],
    ['upper case', 'RM x'],
    ['env', 'env -i FOO=1 rm x'],
    ['eval', "eval 'rm x'"],
    ['ANSI-C quoting', "echo $'\\'' ; rm x"],
  ];
  for (const [name, cmd] of cases) assert.equal(level(R, bash(cmd)), 'refuse', name);
  // Best effort, as the docs say: a variable or another language is not seen.
  assert.equal(level(R, bash('X=rm; $X -rf x')), 'approve');
  assert.equal(level(R, { tool: 'Bash', input: { cmd: 'rm x' } }), 'refuse', 'a Bash request with no command: a refuse rule matches');
  assert.equal(level(R, undefined), 'ask', 'no request: approve all with refuse rules asks');
});

test('refuse: paths by case, by .., by a Glob pattern or a Grep path, and a host with a trailing dot or a subdomain', () => {
  const R = { default: 'approve' as const, refuse: ['Read(~/.ssh/**)', 'WebFetch(domain:evil.com)'] };
  assert.equal(level(R, { tool: 'Read', input: { file_path: '/Users/example/.SSH/id' } }), 'refuse');
  assert.equal(level(R, { tool: 'Read', input: { file_path: '/w/prof/../../Users/example/.ssh/id' } }), 'refuse');
  assert.equal(level(R, { tool: 'Glob', input: { pattern: '/Users/example/.ssh/*' } }), 'refuse');
  assert.equal(level(R, { tool: 'Glob', input: { pattern: '../../Users/example/.ssh/*' } }), 'refuse');
  assert.equal(level(R, { tool: 'Grep', input: { pattern: 'x', path: '~/.ssh' } }), 'refuse', 'the folder itself: x/** covers x');
  assert.equal(level(R, { tool: 'LS', input: { path: '/Users/example/.ssh' } }), 'refuse');
  assert.equal(level(R, { tool: 'WebFetch', input: { url: 'https://evil.com./x' } }), 'refuse');
  assert.equal(level(R, { tool: 'WebFetch', input: { url: 'https://www.evil.com/x' } }), 'refuse');
});

test('approve: paths stay where the rule says, every path of the request', () => {
  const P = { approve: ['Edit(notes/**)', 'Read(//tmp/**)', 'Edit(*.md)', 'Read(~/docs/**)'] };
  assert.equal(level(P, { tool: 'Write', input: { file_path: 'notes/a' } }), 'approve');
  assert.equal(level(P, { tool: 'Write', input: { file_path: 'notes' } }), 'approve', 'notes/** covers notes itself');
  assert.equal(level(P, { tool: 'Write', input: { file_path: 'notes/../../x' } }), 'ask');
  assert.equal(level(P, { tool: 'Write', input: { file_path: '/other/notes/a' } }), 'ask');
  assert.equal(level(P, { tool: 'Write', input: { file_path: '/etc/x.md' } }), 'ask');
  // Documented: a bare *.md approves the profile's CLAUDE.md files too.
  assert.equal(level(P, { tool: 'Write', input: { file_path: '.claude/CLAUDE.md' } }), 'approve');
  assert.equal(level(P, { tool: 'Read', input: { file_path: '/tmp/../etc/passwd' } }), 'ask');
  assert.equal(level(P, { tool: 'Read', input: { file_path: '~/docs/../.ssh/id' } }), 'ask');
  assert.equal(level(P, { tool: 'NotebookEdit', input: { notebook_path: '/etc/x', file_path: 'notes/a' } }), 'ask', 'NotebookEdit: its notebook_path counts');
  assert.equal(level(P, { tool: 'Glob', input: { pattern: 'notes/**/../../x' } }), 'ask', 'a Glob pattern with .. never approves');
  assert.equal(level({ approve: ['mcp__a'] }, { tool: 'mcp__a__b__c' }), 'ask', 'mcp__a__b__c may be a server named a__b');
  assert.equal(level({ approve: ['mcp__a'] }, { tool: 'mcp__ab__c' }), 'ask');
  assert.equal(level({ approve: ['mcp__a'] }, { tool: 'mcp__a__c' }), 'approve');
});

test('a symbolic link is matched where it points, for approve and for refuse', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'angelia-perm-link-')));
  const cwd = join(root, 'prof'), secret = join(root, 'secret');
  mkdirSync(join(cwd, 'notes'), { recursive: true }); mkdirSync(secret);
  writeFileSync(join(secret, 'key'), 'x');
  symlinkSync(secret, join(cwd, 'notes', 'out'));
  const c = { cwd, home: root };
  const d = (p: Partial<PermissionPolicy>, file_path: string) => decide(pol(p), { tool: 'Edit', input: { file_path } }, c).level;
  assert.equal(d({ approve: ['Edit(notes/**)'] }, join(cwd, 'notes', 'a')), 'approve');
  assert.equal(d({ approve: ['Edit(notes/**)'] }, join(cwd, 'notes', 'out', 'key')), 'ask', 'a link out of the folder');
  assert.equal(d({ approve: ['Edit(notes/**)'] }, join(cwd, 'notes', 'out', 'new', 'file')), 'ask', 'a new file under a link out');
  assert.equal(d({ default: 'approve', refuse: [`Edit(/${secret}/**)`] }, join(cwd, 'notes', 'out', 'key')), 'refuse', 'refuse by where it resolves');
});

test('the matcher stays bounded: an option as the last word, and a very long line', () => {
  const R = { refuse: ['Bash(rm *)'], approve: ['Bash(ls *)'] };
  for (const cmd of ['timeout -x', 'stdbuf -x', 'env -x', 'timeout --x', 'nice -n', 'ls; timeout -', 'sudo -x', 'xargs -x', 'ls | xargs -n']) {
    const t0 = Date.now();
    decide(pol(R), bash(cmd), ctx);
    assert.ok(Date.now() - t0 < 500, cmd);
  }
  const long = `ls ${'a '.repeat(MAX_COMMAND)}`;
  assert.equal(level({ approve: ['Bash(ls *)'] }, bash(long)), 'ask', 'too long to approve');
  assert.equal(level({ default: 'approve', refuse: ['Bash(rm *)'] }, bash(long)), 'refuse', 'too long: a shell refuse rule matches');
  const t0 = Date.now();
  decide(pol(R), bash('$('.repeat(4000)), ctx);
  assert.ok(Date.now() - t0 < 2000, 'nested $( )');
});

test('re-check: no backtracking on quotes after an assignment, linear wildcards, a cap on *, a time budget', async () => {
  const { parseRule } = await import('../src/core/permission-rules.js');
  const timed = (p: Partial<PermissionPolicy>, cmd: string) => { const t0 = Date.now(); const l = level(p, bash(cmd)); return { l, ms: Date.now() - t0 }; };
  for (const cmd of [`X=${"'".repeat(44)}`, `X=${"'".repeat(4000)}`, `ls; X=${"a'".repeat(2000)}`]) {
    const { l, ms } = timed({ refuse: ['Bash(rm *)'] }, cmd);
    assert.ok(ms < 500 && l !== 'approve', `${cmd.slice(0, 12)}: ${ms} ms`);
  }
  for (const [p, cmd] of [
    [{ refuse: ['Bash(git * push * --force*)'] }, `git ${' push '.repeat(1300)}`],
    [{ refuse: ['Bash(*curl*|*sh*)'] }, 'curl '.repeat(1600)],
    [{ approve: ['Bash(git * log * -n * x)'] }, `git ${'log -n '.repeat(1100)}`],
  ] as [Partial<PermissionPolicy>, string][]) assert.ok(timed(p, cmd).ms < 500, String(p.refuse ?? p.approve));
  assert.equal(level({ refuse: ['Bash(git * push * --force*)'] }, bash('git -C x push origin --force-with-lease')), 'refuse', 'the wildcard matcher still matches');
  assert.equal(level({ approve: ['Bash(ls *)'] }, bash('ls')), 'approve', 'a trailing space-* takes the bare command');
  assert.equal(level({ approve: ['Bash(ls *)'] }, bash('lsof')), 'ask');
  assert.equal(typeof parseRule('Bash(a*b*c*d*e*f*g*h*i*j)'), 'string', 'more than 8 * fails the load');
  assert.equal(typeof parseRule('Bash(a * b * c * d *)'), 'object');
  const nest = { default: 'approve' as const, refuse: ['Bash(rm *)'] };
  assert.notEqual(level(nest, bash('$('.repeat(20000).slice(0, 8000))), 'approve', 'over the time budget: never approved');
  assert.equal(level({ default: 'refuse', ask: ['Bash(rm *)'] }, bash('$('.repeat(4000))), 'refuse', 'over the budget a refuse default stays');
  assert.equal(level({ approve: ['Bash(echo *)'] }, bash('echo =ls')), 'ask', 'a word that starts with =');
  assert.equal(level({ approve: ['Read(notes/**)'] }, { tool: 'Glob', input: { pattern: '{notes,/etc}/*' } }), 'ask', 'a Glob brace');
  assert.equal(level({ approve: ['Read(notes/**)'] }, { tool: 'Glob', input: { pattern: 'notes/*.md' } }), 'approve');
});
