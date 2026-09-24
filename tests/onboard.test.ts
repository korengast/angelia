import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';
import { loadConfig } from '../src/instance/config/load.js';
import { DEFAULT_PROMPT, onboardChat, onboardingPrompt, profileName } from '../src/instance/onboard.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { readRecord } from '../src/capabilities/compile.js';
import type { Inbound } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-claude.mjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'angelia-onboard-'));

test('a profile is named after the chat, stays unique, and falls back to the chat id', () => {
  const none = () => false;
  assert.equal(profileName('Family Trip 2027!', 'x@g.us', none), 'family-trip-2027');
  assert.equal(profileName('σημειώσεις ταξιδιού', 'x@g.us', none), 'σημειώσεις-ταξιδιού');
  assert.equal(profileName(undefined, '120363000000000007@g.us', none), 'chat-000007');
  assert.equal(profileName('🎉', '-100200', none), 'chat-100200');
  const taken = new Set(['trip', 'trip-2']);
  assert.equal(profileName('Trip', 'x', (n) => taken.has(n)), 'trip-3');
});

test('the shipped prompt says it is the default, and that comment never reaches the agent', () => {
  const raw = readFileSync(DEFAULT_PROMPT, 'utf8');
  assert.match(raw, /default onboarding prompt/i);
  assert.match(raw, /onboard\.prompt/);
  const p = onboardingPrompt(DEFAULT_PROMPT, { profile: 'trip', folder: '/f/trip', instructions: 'CLAUDE.md', chat: 'whatsapp:x@g.us', chat_name: 'Trip' });
  assert.doesNotMatch(p, /<!--|\{profile\}|\{folder\}/);
  assert.match(p, /"trip", with its folder at \/f\/trip/);
  assert.match(p, /whatsapp:x@g\.us \(Trip\)/);
});

function table(extra = '') {
  const dir = tmp();
  const path = join(dir, 'routing.yaml');
  writeFileSync(path, `# my table, comments stay
profiles:
  a: {cwd: ${dir}}
routes:
  # the first chat
  - {platform: telegram, chat: 1, profile: a, owners: ["15550000001"], allow_from: ["15550000001", "15550000002", "15550000003"]}
telegram: {}
whatsapp: {}
defaults: {unmatched: onboard}
onboard:
  owners: ["15550000001"]
  allow_from: ["15550000001", "15550000002"]
  folder: ${join(dir, 'agents')}
  mention: any
  profile: {permission_mode: acceptEdits, model: some-model}
${extra}`);
  return { dir, path };
}

test('onboarding writes the profile, the route and the folder, and adds them to the live config', () => {
  const t = table();
  const cfg = loadConfig(t.path);
  const before = readFileSync(t.path, 'utf8');
  const made = onboardChat({ table: t.path, cfg, platform: 'whatsapp', chat: 'new@g.us', chatName: 'Home Reno', now: new Date('2026-09-21T10:00:00Z'), instance: join(t.dir, 'instance') });
  assert.equal(made.name, 'home-reno');
  assert.equal(made.folder, join(t.dir, 'agents', 'home-reno'));
  assert.match(readFileSync(join(made.folder, 'CLAUDE.md'), 'utf8'), /still being set up/);

  const text = readFileSync(t.path, 'utf8');
  const added = text.split('\n').filter((l) => !before.split('\n').includes(l));
  assert.deepEqual(added, [
    '  home-reno:', '    permission_mode: acceptEdits', '    model: some-model', `    cwd: ${made.folder}`,
    '  # Onboarded 2026-09-21 from "Home Reno".',
    '  - {platform: whatsapp, chat: new@g.us, profile: home-reno, mention: any, owners: ["15550000001"], allow_from: ["15550000001", "15550000002"]}',
  ], 'only the new profile and route are new; every other line is as it was');
  assert.equal(text.split('\n').length, before.split('\n').length + added.length);
  assert.ok(readdirSync(t.dir).some((f) => f.endsWith('.bak')), 'the old table is kept');

  const again = loadConfig(t.path);
  assert.equal(again.profiles['home-reno'].model, 'some-model');
  assert.equal(again.profiles['home-reno'].cwd, made.folder);
  assert.equal(cfg.profiles['home-reno'].model, 'some-model', 'live config has the profile');
  assert.ok(cfg.routes.some((r) => r.chat === 'new@g.us' && r.profile === 'home-reno' && r.allow_from.length === 2));
  assert.match(made.prompt, /"home-reno"/);

  delete cfg.onboard!.allow_from;
  const second = onboardChat({ table: t.path, cfg, platform: 'whatsapp', chat: 'other@g.us', chatName: 'Home Reno', instance: join(t.dir, 'instance') });
  assert.equal(second.name, 'home-reno-2');
  assert.match(readFileSync(t.path, 'utf8'), /owners: \["15550000001"\], allow_from: \["15550000001"\]\}/, 'the same list twice is written twice, not as a YAML anchor');
});

test('a new profile gets its capabilities compiled before its first turn', () => {
  const t = table();
  writeFileSync(t.path, readFileSync(t.path, 'utf8').replace('defaults: {unmatched: onboard}', `capabilities:\n  private: {kind: directory, path: ${t.dir}}\ndefaults: {unmatched: onboard, deny: [private]}`));
  const made = onboardChat({ table: t.path, cfg: loadConfig(t.path), platform: 'whatsapp', chat: 'n@g.us', chatName: 'Deny Me', instance: join(t.dir, 'instance') });
  assert.ok(readRecord(made.folder), 'compiled');
  assert.match(readFileSync(join(made.folder, '.claude', 'settings.json'), 'utf8'), /"deny"/);
});

test('in the default folder the workspace repo is made if missing, and each new profile is one commit', async () => {
  const t = table();
  writeFileSync(t.path, readFileSync(t.path, 'utf8').replace(/  folder: .*\n/, ''));
  const instance = join(t.dir, 'instance');
  const made = onboardChat({ table: t.path, cfg: loadConfig(t.path), platform: 'whatsapp', chat: 'n@g.us', chatName: 'Kept', instance });
  assert.equal(made.folder, join(instance, 'workspace', 'profiles', 'kept'));
  // The commit runs off the event loop: the new chat's reply does not wait for git.
  assert.doesNotMatch(execFileSync('git', ['log', '--format=%s'], { cwd: join(instance, 'workspace'), encoding: 'utf8' }), /Onboard kept/);
  assert.equal(await made.git, 'committed');
  const log = execFileSync('git', ['log', '--format=%s', '--name-only'], { cwd: join(instance, 'workspace'), encoding: 'utf8' });
  // The deny floor is compiled into the new profile and lands in the same commit as its instructions.
  assert.match(log, /^Onboard kept\n\nprofiles\/kept\/\.claude\/angelia-compiled\.json\nprofiles\/kept\/\.claude\/settings\.json\nprofiles\/kept\/CLAUDE\.md/);
  assert.match(log, /Angelia workspace: initial skeleton/);

  const remote = join(t.dir, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: join(instance, 'workspace') });
  const pushed = onboardChat({ table: t.path, cfg: loadConfig(t.path), platform: 'whatsapp', chat: 'm@g.us', chatName: 'Sent', instance });
  assert.equal(await pushed.git, 'committed and pushed');
  assert.match(execFileSync('git', ['log', '--format=%s', 'main'], { cwd: remote, encoding: 'utf8' }), /^Onboard sent\n/);
});

test('a table that would not load is put back as it was', () => {
  const t = table();
  const cfg = loadConfig(t.path);
  const before = readFileSync(t.path, 'utf8');
  // Written, then refused by the loader: bypassPermissions next to a folder holding .env.
  writeFileSync(join(t.dir, '.env'), '');
  cfg.onboard!.profile = { permission_mode: 'bypassPermissions', add_dirs: [t.dir] };
  assert.throws(() => onboardChat({ table: t.path, cfg, platform: 'whatsapp', chat: 'n@g.us', chatName: 'X' }), /\.env/);
  assert.equal(readFileSync(t.path, 'utf8'), before);
  assert.ok(!('x' in cfg.profiles));
});

test('the onboard block is checked when the table loads', () => {
  const dir = tmp();
  const write = (y: string) => { const p = join(dir, `t${Math.random()}.yaml`); writeFileSync(p, `profiles: {a: {cwd: ${dir}}}\nroutes: []\n${y}`); return p; };
  assert.throws(() => loadConfig(write('defaults: {unmatched: onboard}\n')), /needs an onboard/);
  assert.throws(() => loadConfig(write('onboard: {owners: []}\n')), /at least one sender/);
  assert.throws(() => loadConfig(write('onboard: {owners: ["1"], profile: {permission_mode: yolo}}\n')), /onboard\.profile\.permission_mode/);
  assert.throws(() => loadConfig(write('onboard: {owners: ["1"], profile: {cwd: /x}}\n')), /onboard\.folder/);
  assert.equal(loadConfig(write('defaults: {unmatched: onboard}\nonboard: {owners: ["1"]}\n')).defaults.unmatched, 'onboard');
});

function orch(owners = ['u1'], skip: string[] = []) {
  const cfg = Config.parse({
    profiles: { a: { cwd: here } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }],
    defaults: { unmatched: 'onboard', max_out_per_min: 1000 }, onboard: { owners, skip },
  });
  const sent: { chat: string; text: string }[] = [];
  const made: string[] = [];
  const sender = { send: async (chat: string, text: string) => { sent.push({ chat, text }); }, chatName: async () => 'Trip' };
  const onboard = (i: Inbound, chatName?: string) => {
    made.push(`${i.chat}/${chatName}`);
    cfg.profiles.trip = cfg.profiles.a;
    cfg.routes.push({ platform: i.platform, chat: i.chat, profile: 'trip', allow_from: [], owners: owners });
    return { name: 'trip', prompt: 'SETUP PROMPT' };
  };
  const o = new Orchestrator(cfg, { telegram: sender, whatsapp: sender }, { stateDir: tmp(), bins: { 'claude-code': FAKE }, onboard });
  return { o, sent, made };
}
const msg = (sender: string, text: string): Inbound => ({ platform: 'whatsapp', chat: 'new@g.us', sender, senderName: 'N', text, isGroup: true, mentioned: true, media: [] });

test('an owner in an unknown chat gets a new profile, whose first turn carries the prompt', async (t) => {
  const { o, sent, made } = orch(); t.after(() => o.shutdown());
  await Promise.all([o.handle(msg('u1', 'plan our trip')), o.handle(msg('u1', 'and hotels'))]);
  assert.deepEqual(made, ['new@g.us/Trip'], 'made once, even with two messages in flight');
  assert.match(sent[0].text, /I made a profile for it, named trip/);
  assert.match(sent[1].text, /^echo: SETUP PROMPT\n\n\[whatsapp group new@g\.us · N \(u1\)\]\n\nplan our trip$/);
  assert.match(sent[2].text, /^echo: \[whatsapp group new@g\.us · N \(u1\)\]\n\nand hotels$/, 'the prompt goes once');
  assert.equal(o.map.getActive('whatsapp:new@g.us')!.label, 'plan our trip', 'the session is labelled with the message, not the prompt');
});

test('anyone else in an unknown chat is dropped without a word, and a command makes nothing', async (t) => {
  const { o, sent, made } = orch(); t.after(() => o.shutdown());
  await o.handle(msg('stranger', 'hi'));
  await o.handle(msg('u1', '/help'));
  assert.deepEqual(made, []);
  assert.equal(sent.length, 0);
});

test('in a group, an owner starts a profile only by addressing the bot; a DM needs no mention', async (t) => {
  const { o, sent, made } = orch(); t.after(() => o.shutdown());
  await o.handle({ ...msg('u1', 'lunch anyone?'), mentioned: false });
  assert.deepEqual(made, [], 'an owner chatting in a group the bot sits in makes nothing');
  assert.equal(sent.length, 0);
  await o.handle({ ...msg('u1', 'hello there'), chat: 'u1', isGroup: false, mentioned: false });
  assert.deepEqual(made, ['u1/Trip']);
});

test('a chat on the skip list is never onboarded, even for an owner', async (t) => {
  const { o, sent, made } = orch(['u1'], ['whatsapp:new@g.us']); t.after(() => o.shutdown());
  await o.handle(msg('u1', 'hello'));
  assert.deepEqual(made, []);
  assert.equal(sent.length, 0);
  assert.throws(() => Config.parse({ profiles: {}, routes: [], onboard: { owners: ['1'], skip: ['new@g.us'] } }), /platform:chat/);
});
