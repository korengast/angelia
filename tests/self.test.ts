import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selfPrompt, tildePath, selfOverrideWarning, upsertSelfBlock, SELF_START, SELF_END, SELF_OVERRIDE, FILE_BACKENDS } from '../src/daemon/self.js';
import { claudeArgv, claudeTuiArgv, grokArgv } from '../src/brain/argv.js';
import { guideText, GUIDE } from '../src/instance/guide.js';
import { profilesText, profilesJson } from '../src/instance/profiles.js';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import type { Inbound } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'angelia-self-'));

test('self prompt names the profile, the table and the guide, and stays under 120 words', () => {
  const instance = tmp();
  mkdirSync(join(instance, 'workspace'));
  const text = selfPrompt({ profile: 'ops', table: '/t/routing.yaml', instance });
  assert.match(text, /profile "ops"/);
  assert.ok(text.includes('/t/routing.yaml') && text.includes(join(instance, 'workspace')));
  assert.ok(text.includes('angelia guide') && text.includes('angelia profiles'));
  assert.doesNotMatch(text, /\{(profile|instance|table|workspace|workspace_line)\}/);
  // It rides on every call of every profile. Growing it is a design change, not an edit.
  const words = text.split(/\s+/).filter(Boolean).length;
  assert.ok(words <= 120, `self prompt is ${words} words`);
});

test('self prompt leaves the workspace out while the folder is missing, and writes home as ~', () => {
  const home = tmp();
  const instance = join(home, '.angelia');
  mkdirSync(instance);
  const text = selfPrompt({ profile: 'ops', table: join(instance, 'routing.yaml'), instance, home });
  assert.doesNotMatch(text, /Workspace|_capabilities|\{/);
  assert.ok(text.includes('Instance: ~/.angelia. Routing table: ~/.angelia/routing.yaml. Tokens'));
  assert.ok(!text.includes(home));
  mkdirSync(join(instance, 'workspace'));
  assert.ok(selfPrompt({ profile: 'ops', table: '/t', instance, home }).includes('Workspace (git): ~/.angelia/workspace, holding'));
});

test('tildePath shortens only the home folder itself and what is under it', () => {
  assert.equal(tildePath('/Users/example/x', '/Users/example'), '~/x');
  assert.equal(tildePath('/Users/example', '/Users/example'), '~');
  assert.equal(tildePath('/srv/example2/x', '/srv/example'), '/srv/example2/x');
});

test('an override in the workspace replaces the template, and is reported, not blocked', () => {
  const instance = tmp();
  assert.equal(selfOverrideWarning(instance), undefined);
  mkdirSync(join(instance, 'workspace', '_shared'), { recursive: true });
  writeFileSync(join(instance, 'workspace', SELF_OVERRIDE), 'I am {profile}.\n');
  assert.equal(selfPrompt({ profile: 'ops', table: '/t', instance }), 'I am ops.');
  assert.match(selfOverrideWarning(instance)!, /will not follow upgrades/);
});

test('the file block: created, prepended, rewritten in place, left alone when unchanged or broken', () => {
  const dir = tmp();
  const f = join(dir, 'CLAUDE.md');
  assert.equal(upsertSelfBlock(f, 'v1'), 'created');
  assert.equal(readFileSync(f, 'utf8'), `${SELF_START}\nv1\n${SELF_END}\n`);

  writeFileSync(f, '# Mine\nhand written\n');
  assert.equal(upsertSelfBlock(f, 'v1'), 'updated');
  assert.equal(readFileSync(f, 'utf8'), `${SELF_START}\nv1\n${SELF_END}\n\n# Mine\nhand written\n`);
  assert.equal(upsertSelfBlock(f, 'v1'), 'unchanged');

  writeFileSync(f, `top\n${SELF_START}\nold\n${SELF_END}\nbottom\n`);
  assert.equal(upsertSelfBlock(f, 'v2'), 'updated');
  assert.equal(readFileSync(f, 'utf8'), `top\n${SELF_START}\nv2\n${SELF_END}\nbottom\n`);

  const broken = `top\n${SELF_START}\nno end, hand text follows\n`;
  writeFileSync(f, broken);
  assert.equal(upsertSelfBlock(f, 'v3'), 'broken');
  assert.equal(readFileSync(f, 'utf8'), broken);
});

test('Claude Code gets the prompt on argv; grok gets it from its instruction file', () => {
  const p = Config.parse({ profiles: { x: { cwd: '/x' } }, routes: [] }).profiles.x;
  const s = { id: 'u', started: false };
  const pair = (a: string[], flag: string) => a[a.indexOf(flag) + 1];
  assert.equal(pair(claudeArgv(p, s, 'claude', 'SELF'), '--append-system-prompt'), 'SELF');
  assert.equal(pair(claudeTuiArgv(p, s, 'claude', '/s.json', 'n', 'SELF'), '--append-system-prompt'), 'SELF');
  assert.ok(!claudeArgv(p, s).includes('--append-system-prompt'));
  // grok ignores --rules in ACP mode: it reads the block from a file instead.
  assert.ok(!grokArgv(p).includes('--rules'));
  assert.deepEqual(FILE_BACKENDS, { grok: 'CLAUDE.md' });
});

test('a real turn carries the prompt for its own profile', async (t) => {
  const cfg = Config.parse({
    profiles: { alpha: { cwd: here }, beta: { cwd: here } },
    routes: [{ platform: 'telegram', chat: 1, profile: 'alpha' }, { platform: 'telegram', chat: 2, profile: 'beta' }],
    defaults: { max_out_per_min: 1000 },
  });
  const sent: string[] = [];
  const sender = { send: async (_c: string, text: string) => { sent.push(text); } };
  const o = new Orchestrator(cfg, { telegram: sender, whatsapp: sender }, {
    stateDir: tmp(), bins: { 'claude-code': join(here, 'fake-claude.mjs') }, env: { ...process.env, FAKE_CLAUDE_ECHO_ARGV: '1' },
    selfPrompt: (name) => `SELF-FOR-${name}`,
  });
  t.after(() => o.shutdown());
  const dm = (chat: string): Inbound => ({ platform: 'telegram', chat, sender: 'u1', senderName: 'O', text: 'hi', isGroup: false, mentioned: false, media: [] });
  await o.handle(dm('1'));
  await o.handle(dm('2'));
  assert.match(sent[0], /--append-system-prompt SELF-FOR-alpha/);
  assert.match(sent[1], /--append-system-prompt SELF-FOR-beta/);
});

test('guide: the index lists every topic, a topic prints, an unknown one says what exists', () => {
  const index = guideText();
  for (const k of Object.keys(GUIDE)) assert.ok(index.includes(k));
  assert.match(guideText('routing'), /^routing: /);
  assert.throws(() => guideText('nope'), /Topics: layout/);
});

test('profiles lists backend, folder and routed chats, and names a dead profile', () => {
  const cfg = Config.parse({
    profiles: { a: { cwd: '/a', backend: 'grok' }, b: { cwd: '/b', tui: true } },
    routes: [{ platform: 'whatsapp', chat: 'g@g.us', profile: 'a' }, { platform: 'telegram', chat: -100, thread: '55', profile: 'a' }],
  });
  const out = profilesText(cfg);
  assert.match(out, /a\n  backend  grok\n  folder   \/a\n  chats    whatsapp:g@g\.us, telegram:-100:55\n/, 'a thread in the key form send and turn take');
  assert.match(out, /b\n  backend  claude-code \(tui\)[\s\S]*no route names it/);
});

test('profiles --json gives each profile its backend, folder, chats and session ids', () => {
  const cfg = Config.parse({
    profiles: { a: { cwd: '/a', backend: 'grok' }, b: { cwd: '/b', tui: true, model: 'm' } },
    routes: [{ platform: 'whatsapp', chat: 'g@g.us', profile: 'a' }, { platform: 'telegram', chat: '7', thread: '3', profile: 'b' }],
  });
  const row = (id: string) => ({ id, created_at: '', last_used_at: '', turns: 1, started: true, label: '' });
  const out = profilesJson(cfg, { version: 1, chats: { 'whatsapp:g@g.us': { active: 's2', history: [row('s1'), row('s2')] } } });
  assert.equal(out.version, 1);
  assert.deepEqual(out.profiles[0], { name: 'a', backend: 'grok', tui: false, model: null, folder: '/a', chats: [{ chat: 'whatsapp:g@g.us', session: 's2', sessions: ['s1', 's2'] }] });
  assert.deepEqual(out.profiles[1].chats, [{ chat: 'telegram:7:3', session: null, sessions: [] }], 'a chat with no session yet');
  assert.equal(out.profiles[1].tui, true);
  assert.equal(out.profiles[1].model, 'm');
});
