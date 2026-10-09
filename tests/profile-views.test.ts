import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Config } from '../src/instance/config/schema.js';
import type { Hidden } from '../src/instance/profile-files.js';
import { capabilitiesView, importsOf, memoryView, readSkill, skillsView } from '../src/instance/profile-views.js';

const none: Hidden = () => false;
function tmp(t: { after(fn: () => unknown): void }): string {
  const d = mkdtempSync(join(tmpdir(), 'pv-t-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
const skill = (dir: string, name: string, description: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: "${description}"\n---\n\n# ${name}\n`);
};

test('imports: @paths outside code, not emails or handles', () => {
  assert.deepEqual(importsOf([
    'Read @../../_shared/WEB.md first, and @notes/today.md.',
    'Mail someone@example.com or ping @someone.',
    'Not `@code/span.md` here.',
    '```', '@fenced/file.md', '```',
    '@~/docs/x.md',
  ].join('\n')), ['../../_shared/WEB.md', 'notes/today.md', '~/docs/x.md']);
});

test('memory: the memory folder and the imported files, followed a few deep, each once; a hidden one says why', (t) => {
  const home = tmp(t);
  const shared = join(home, 'shared');
  const prof = join(home, 'p');
  mkdirSync(join(prof, 'memory'), { recursive: true });
  mkdirSync(shared);
  writeFileSync(join(shared, 'A.md'), 'A, see @./B.md');
  writeFileSync(join(shared, 'B.md'), 'B, back to @./A.md');
  writeFileSync(join(prof, '.env'), 'X=1');
  writeFileSync(join(prof, 'private.md'), 'mine');
  writeFileSync(join(prof, 'CLAUDE.md'), '@../shared/A.md\n@./.env\n@./private.md\n@./gone.md');
  const hidden: Hidden = (p) => p.endsWith('private.md');
  const v = memoryView(prof, 'claude-code', hidden, home);
  assert.equal(v.folder, 'memory');
  assert.deepEqual(v.imports.map((i) => [i.ref, i.from, i.text ?? `why: ${i.why}`]), [
    ['../shared/A.md', 'CLAUDE.md', 'A, see @./B.md'],
    ['./B.md', '~/shared/A.md', 'B, back to @./A.md'],
    ['./.env', 'CLAUDE.md', 'why: that file is not shown here'],
    ['./private.md', 'CLAUDE.md', 'why: that file is not shown here'],
    ['./gone.md', 'CLAUDE.md', 'why: no such file'],
  ]);
  assert.ok(!JSON.stringify(v).includes(home), 'paths shown with ~, never the home path');
});

test('skills: from the table, the profile folder and the CLI\'s own folder; a hidden one is not listed', (t) => {
  const home = tmp(t);
  const prof = join(home, 'p');
  skill(join(prof, '.claude', 'skills', 'local'), 'local', 'In the folder');
  skill(join(home, 'caps', 'web'), 'web-operator', 'Given by the table');
  skill(join(home, '.claude', 'skills', 'global'), 'global', 'For every profile');
  skill(join(home, '.claude', 'skills', 'banned'), 'banned', 'Denied to this profile');
  const cfg = Config.parse({
    capabilities: { web: { kind: 'skill', path: join(home, 'caps', 'web') } },
    profiles: { p: { cwd: prof, capabilities: ['web'] } }, routes: [],
  });
  const rules: Hidden = (p) => p.includes('banned');
  const v = skillsView(cfg, 'p', rules, home, rules);
  assert.deepEqual(v.skills.map((s) => [s.name, s.source, s.description, s.path]), [
    ['web-operator', 'capability', 'Given by the table', '~/caps/web/SKILL.md'],
    ['local', 'profile', 'In the folder', '~/p/.claude/skills/local/SKILL.md'],
    ['global', 'everyone', 'For every profile', '~/.claude/skills/global/SKILL.md'],
  ]);
  assert.match(readSkill(cfg, 'p', 'local', none, home).text, /# local/);
  assert.throws(() => readSkill(cfg, 'p', 'banned', rules, home, rules), /no such skill/);
});

test('capabilities: what each is, never its arguments, environment or secrets; denied ones; compile time', (t) => {
  const prof = tmp(t);
  const cfg = Config.parse({
    capabilities: {
      gh: { kind: 'mcp', command: '/usr/local/bin/gh-mcp', args: ['--token', 'abc123'], env: ['GH_TOKEN'], secrets: ['~/.config/gh/hosts.yml'] },
      remote: { kind: 'mcp', url: 'https://mcp.example.com/sse?key=SECRET' },
      img: { kind: 'command', run: 'python3 imagine.py --key SECRET', when: 'an image is asked for' },
      bank: { kind: 'directory', path: '/srv/bank' },
    },
    defaults: { deny: ['bank'] },
    profiles: { p: { cwd: prof, capabilities: ['gh', 'remote', 'img'] } }, routes: [],
  });
  const v = capabilitiesView(cfg, 'p');
  assert.deepEqual(v.allowed, [
    { name: 'gh', kind: 'mcp', what: 'gh-mcp', secrets: 1 },
    { name: 'img', kind: 'command', what: 'python3', when: 'an image is asked for' },
    { name: 'remote', kind: 'mcp', what: 'mcp.example.com' },
  ]);
  assert.deepEqual(v.denied, [{ name: 'bank', kind: 'directory' }]);
  assert.equal(v.compiledAt, null);
  assert.doesNotMatch(JSON.stringify(v), /abc123|SECRET|GH_TOKEN|hosts\.yml/);
  mkdirSync(join(prof, '.claude'));
  writeFileSync(join(prof, '.claude', 'angelia-compiled.json'), '{}');
  assert.match(capabilitiesView(cfg, 'p').compiledAt ?? '', /^\d{4}-/);
});

// Review of 2026-10-09 (mobile M1).
test('imports: a long run of dots and many references stay fast, and stop at the cap', () => {
  let start = Date.now();
  assert.deepEqual(importsOf(`@a/b${'.'.repeat(200_000)}`), []);
  importsOf(`see @x/y.md${'.'.repeat(4000)}`);
  assert.ok(Date.now() - start < 500, `dots took ${Date.now() - start} ms`);
  start = Date.now();
  const many = Array.from({ length: 40_000 }, (_, i) => `@d/f${i}.md`).join('\n');
  assert.equal(importsOf(many).length, 50);
  assert.ok(Date.now() - start < 500, `many took ${Date.now() - start} ms`);
});

test('skills: a SKILL.md in the CLI\'s folder that links out (to its settings, say) is held to every check', (t) => {
  const home = tmp(t);
  mkdirSync(join(home, '.claude', 'skills', 'evil'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), '{"env":{"TOKEN":"never"}}');
  symlinkSync(join(home, '.claude', 'settings.json'), join(home, '.claude', 'skills', 'evil', 'SKILL.md'));
  const prof = join(home, 'p');
  mkdirSync(prof);
  const cfg = Config.parse({ profiles: { p: { cwd: prof } }, routes: [] });
  // As the daemon wires it: every check outside the skills folder, the deny rules alone inside it.
  const credential: Hidden = (p) => p.includes(`${join('.claude', 'settings')}`);
  const v = skillsView(cfg, 'p', credential, home, none);
  assert.deepEqual(v.skills.map((s) => s.name), []);
  assert.throws(() => readSkill(cfg, 'p', 'evil', credential, home, none), /no such skill/);
});

test('skills: an empty name falls back to the folder, a name never runs on to the next line, one name one skill', (t) => {
  const home = tmp(t);
  const prof = join(home, 'p');
  mkdirSync(join(prof, '.claude', 'skills', 'empty'), { recursive: true });
  writeFileSync(join(prof, '.claude', 'skills', 'empty', 'SKILL.md'), '---\nname:\ndescription: First\n---\n');
  mkdirSync(join(prof, '.claude', 'skills', 'twin'), { recursive: true });
  writeFileSync(join(prof, '.claude', 'skills', 'twin', 'SKILL.md'), '---\nname: empty\ndescription: Second\n---\n');
  const cfg = Config.parse({ profiles: { p: { cwd: prof } }, routes: [] });
  const v = skillsView(cfg, 'p', none, home, none).skills.filter((s) => s.source === 'profile');
  assert.deepEqual(v.map((s) => [s.name, s.description]), [['empty', 'First']]);
});

test('capabilities: a command that sets a variable in front shows the program, not the value', (t) => {
  const prof = tmp(t);
  const cfg = Config.parse({ capabilities: { x: { kind: 'command', run: 'API_KEY=sk-123 TZ=UTC tool --flag', when: 'w' } }, profiles: { p: { cwd: prof, capabilities: ['x'] } }, routes: [] });
  assert.equal(capabilitiesView(cfg, 'p').allowed[0].what, 'tool');
});
