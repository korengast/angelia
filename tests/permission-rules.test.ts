import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRule, matches, decide, checkable, splitCommand, type PermissionPolicy, type ToolRequest } from '../src/core/permission-rules.js';

const ctx = { cwd: '/w/profile', home: '/h' };
const bash = (command: string): ToolRequest => ({ tool: 'Bash', input: { command } });
const m = (rule: string, req: ToolRequest, strict = false) => {
  const r = parseRule(rule);
  if (typeof r === 'string') throw new Error(r);
  return matches(r, req, ctx, strict);
};

test('rules that are not rules are refused with a reason', () => {
  for (const bad of ['Bash(', 'not a rule', 'mcp__x(y)', 'Bash()', 'Read(!x)', 'WebFetch(example.com)', 'Glob(*.ts)', 'mcp__a__b*']) {
    assert.equal(typeof parseRule(bad), 'string', bad);
  }
  for (const ok of ['Bash', 'Bash(*)', 'Bash(git push:*)', 'Read', 'Read(~/.ssh/**)', 'Edit(//etc/**)', 'WebFetch(domain:*.example.com)', 'mcp__gh', 'mcp__gh__*', 'mcp__gh__create_issue', 'Agent(Explore)', 'Task(Explore)', 'WebSearch']) {
    assert.notEqual(typeof parseRule(ok), 'string', ok);
  }
});

test('Bash: exact, prefix with :* or space-*, and a wildcard anywhere', () => {
  assert.ok(m('Bash(npm run build)', bash('npm run build')));
  assert.ok(!m('Bash(npm run build)', bash('npm run build --x')));
  assert.ok(m('Bash(git push:*)', bash('git push origin main')));
  assert.ok(m('Bash(git push:*)', bash('git push')), 'the space and * are optional together');
  assert.ok(!m('Bash(git push:*)', bash('git pushx')));
  assert.ok(m('Bash(ls*)', bash('lsof')));
  assert.ok(!m('Bash(ls *)', bash('lsof')));
  assert.ok(m('Bash(git * main)', bash('git push origin main')));
  assert.ok(m('Bash', bash('anything at all')) && m('Bash(*)', bash('x')));
  assert.ok(!m('Bash(rm *)', { tool: 'Read', input: { file_path: 'x' } }));
});

test('Bash refuse: any part of a compound line, a subshell, a wrapper or a shell -c matches', () => {
  assert.ok(m('Bash(rm *)', bash('echo ok && rm -rf /')));
  assert.ok(m('Bash(rm *)', bash('ls | xargs rm')));
  assert.ok(m('Bash(rm *)', bash('echo $(rm -rf x)')));
  assert.ok(m('Bash(rm *)', bash('echo "`rm x`"')));
  assert.ok(m('Bash(rm *)', bash('(cd /; rm x)')));
  assert.ok(m('Bash(rm *)', bash('FOO=1 timeout -s KILL 10 nice -n 5 nohup rm x')));
  assert.ok(m('Bash(rm *)', bash("bash -lc 'cd /x && rm y'")), 'Codex sends commands as a shell -c');
  assert.ok(m('Bash(curl *)', bash('a; b\ncurl x &')));
  assert.ok(!m('Bash(rm *)', bash('echo "rm x"')), 'quoted text is not a command');
});

test('Bash approve: every part must match, and nothing it cannot see past is approved', () => {
  const a = (rule: string, cmd: string) => m(rule, bash(cmd), true);
  assert.ok(a('Bash(git status)', 'git status'));
  assert.ok(a('Bash(git *)', 'git status && git log'));
  assert.ok(!a('Bash(git status)', 'git status && rm -rf /'));
  assert.ok(!a('Bash(git status *)', 'git status $(rm -rf x)'));
  assert.ok(!a('Bash(echo *)', 'echo "$(rm x)"'));
  assert.ok(!a('Bash(echo *)', 'echo hi > ~/.zshrc'));
  assert.ok(!a('Bash(echo *)', 'echo hi>f'));
  assert.ok(!a('Bash(echo *)', 'echo hi > /dev/null 2>&1'), 'any redirection: asked');
  assert.ok(!a('Bash(git *)', 'GIT_SSH_COMMAND=evil git fetch'), 'no match past an assignment');
  assert.ok(a('Bash(git *)', 'timeout 30 git fetch'), 'a wrapper is taken off');
  assert.ok(!a('Bash(echo *)', 'echo <(rm x)'));
  assert.ok(!a('Bash(echo *)', "echo 'unclosed"));
  assert.ok(a('Bash(git status)', "zsh -lc 'git status'"));
  assert.ok(!a('Bash(git status)', "zsh -lc 'git status; rm x'"));
  assert.ok(!a('Bash(git *)', 'git a & rm b'));
});

test('splitCommand keeps 2>&1 and &> whole', () => {
  assert.deepEqual(splitCommand('a 2>&1 | b &> f').parts, ['a 2>&1', 'b &> f']);
});

test('Read and Edit paths: the four anchors, globs, bare names at any depth', () => {
  const read = (p: string): ToolRequest => ({ tool: 'Read', input: { file_path: p } });
  assert.ok(m('Read(~/.ssh/**)', read('/h/.ssh/id_ed25519')));
  assert.ok(m('Read(~/.ssh/**)', read('~/.ssh/config')));
  assert.ok(!m('Read(~/.ssh/**)', read('/h/ssh/config')));
  assert.ok(m('Read(//etc/**)', read('/etc/hosts')));
  assert.ok(!m('Read(//etc/**)', read('/w/etc/hosts')));
  assert.ok(m('Read(/src/*.ts)', read('/w/profile/src/a.ts')), '/x is from the profile folder');
  assert.ok(!m('Read(/src/*.ts)', read('/w/profile/src/deep/a.ts')), '* stays in one folder');
  assert.ok(m('Read(src/**)', read('src/deep/a.ts')), 'relative to the folder it runs in');
  assert.ok(m('Read(.env)', read('/w/profile/a/b/.env')), 'a bare name matches at any depth');
  assert.ok(m('Read(*.key)', { tool: 'Grep', input: { path: '/w/profile/x/y.key' } }), 'Read covers Grep');
  assert.ok(m('Edit(docs/**)', { tool: 'Write', input: { file_path: '/w/profile/docs/a.md' } }), 'Edit covers Write');
  assert.ok(m('Edit', { tool: 'NotebookEdit', input: { notebook_path: '/x.ipynb' } }));
  assert.ok(m('Read(secrets/**)', read('/w/profile/a/secrets/k')), 'refuse: a relative folder rule matches at any depth');
  assert.ok(!m('Read(secrets/**)', read('/w/profile/a/secrets/k'), true), 'approve: only at the profile folder');
  assert.ok(m('Edit(src/**)', { tool: 'Edit', input: { file_path: '/w/profile/src/a' } }, true));
  assert.ok(!m('Edit(src/**)', { tool: 'Edit', input: { file_path: '/w/profile/src/../../x' } }, true), '.. is resolved first');
  assert.ok(m('Read(src/**)', { tool: 'Read', input: {} }), 'no path: a refuse rule matches');
  assert.ok(!m('Read(src/**)', { tool: 'Read', input: {} }, true), 'no path: an approve rule does not');
});

test('WebFetch domains, MCP servers and tools, Agent names', () => {
  const fetch = (url: string): ToolRequest => ({ tool: 'WebFetch', input: { url } });
  assert.ok(m('WebFetch(domain:example.com)', fetch('https://example.com/a')));
  assert.ok(!m('WebFetch(domain:example.com)', fetch('https://a.example.com/a'), true), 'approve: the host only');
  assert.ok(m('WebFetch(domain:example.com)', fetch('https://a.example.com/a')), 'refuse and ask: its subdomains too');
  assert.ok(m('WebFetch(domain:*.example.com)', fetch('https://a.b.example.com/')));
  assert.ok(!m('WebFetch(domain:*.example.com)', fetch('https://example.com/')));
  assert.ok(!m('WebFetch(domain:example.com)', fetch('https://example.com.evil.net/')));
  assert.ok(m('WebFetch(domain:x.com)', fetch('not a url')) && !m('WebFetch(domain:x.com)', fetch('not a url'), true));
  assert.ok(m('mcp__gh', { tool: 'mcp__gh__create_issue' }));
  assert.ok(m('mcp__gh__*', { tool: 'mcp__gh__create_issue' }));
  assert.ok(!m('mcp__gh', { tool: 'mcp__ghost__x' }));
  assert.ok(m('mcp__gh__create_issue', { tool: 'mcp__gh__create_issue' }) && !m('mcp__gh__create_issue', { tool: 'mcp__gh__create_issue2' }));
  assert.ok(m('Agent(Explore)', { tool: 'Task', input: { subagent_type: 'Explore' } }));
  assert.ok(!m('Agent(Explore)', { tool: 'Agent', input: { subagent_type: 'Plan' } }));
});

test('decide: refuse, then ask, then approve, then the default', () => {
  const p: PermissionPolicy = { default: 'ask', refuse: ['Bash(rm *)'], ask: ['Bash(git push *)'], approve: ['Bash(git *)', 'Read'] };
  assert.deepEqual(decide(p, bash('rm x'), ctx), { level: 'refuse', rule: 'refuse: Bash(rm *)' });
  assert.deepEqual(decide(p, bash('git push'), ctx), { level: 'ask', rule: 'ask: Bash(git push *)' });
  assert.deepEqual(decide(p, bash('git log'), ctx), { level: 'approve', rule: 'approve: Bash(git *)' });
  assert.deepEqual(decide(p, bash('git log && rm y'), ctx), { level: 'refuse', rule: 'refuse: Bash(rm *)' });
  assert.deepEqual(decide(p, bash('ls'), ctx), { level: 'ask' });
  assert.deepEqual(decide({ default: 'approve', refuse: [], ask: [], approve: [] }, bash('ls'), ctx), { level: 'approve' });
});

test('decide: a request no rule can be checked on keeps the default, and approve all with rules asks', () => {
  assert.deepEqual(decide({ default: 'approve', refuse: ['Bash(rm *)'], ask: [], approve: [] }, undefined, ctx), { level: 'ask', unchecked: true });
  assert.deepEqual(decide({ default: 'approve', refuse: [], ask: [], approve: [] }, undefined, ctx), { level: 'approve' });
  assert.deepEqual(decide({ default: 'ask', refuse: [], ask: [], approve: ['Bash'] }, undefined, ctx), { level: 'ask', unchecked: true });
  assert.deepEqual(decide({ default: 'refuse', refuse: [], ask: [], approve: ['Bash'] }, undefined, ctx), { level: 'refuse', unchecked: true });
});

test('what each backend can check', () => {
  assert.ok(checkable('claude-code', 'mcp__gh'));
  assert.ok(checkable('codex', 'Bash(git *)') && !checkable('codex', 'Read(x)') && !checkable('grok', 'mcp__gh'));
  assert.ok(checkable('pi', 'Edit(src/**)') && !checkable('pi', 'WebFetch(domain:x.com)'));
});

test('refuse and ask see past the usual ways round a rule: a path, case, env, sudo, eval, $\'…\'', () => {
  for (const cmd of ['/bin/rm x', 'RM x', 'env -i FOO=1 rm x', 'sudo -u root rm x', 'eval "rm x"', "echo $'\\'' ; rm x", 'exec rm x']) {
    assert.ok(m('Bash(rm *)', bash(cmd)), cmd);
  }
  const read = (p: string): ToolRequest => ({ tool: 'Read', input: { file_path: p } });
  assert.ok(m('Read(~/.ssh/**)', read('/h/.SSH/id_ed25519')), 'refuse: case does not matter');
  assert.ok(!m('Read(~/.ssh/**)', read('/h/.SSH/id_ed25519'), true), 'approve: it does');
  const a = (rule: string, cmd: string) => m(rule, bash(cmd), true);
  assert.ok(!a('Bash(git *)', 'env git status'), 'approve: env must be named by the rule');
  assert.ok(!a('Bash(git *)', 'sudo git status'));
  assert.ok(!a('Bash(echo *)', "echo $'x'"), 'approve: no ANSI-C quoting');
  assert.ok(!a('Bash(git status)', 'GIT status'), 'approve: case matters');
});
