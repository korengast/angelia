import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/instance/config/load.js';
import { readAccepted, writeAccepted } from '../src/instance/accepted.js';
import { arm, armedFor, armedList, bindChat, cancelArmed, connectPreface, connectWiring, type Armed } from '../src/instance/connect.js';

const cancelArmedFor = (inst: string, a: Armed) => { cancelArmed(inst, a.platform); };
import { connectCommand } from '../src/cli/connect-cli.js';
import { profilesText } from '../src/instance/profiles.js';
import { CONNECT_FAILED_LINE, ONBOARD_FAILED_LINE, Orchestrator } from '../src/core/orchestrator.js';
import type { Inbound } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-claude.mjs');
const SET_UP = '# recipes\nYou keep the family recipes. Set up on 2026-11-20.\n';

/** A temp instance: a profile `recipes` set up already (its own instruction file), no route for it, an
 *  onboard: block, and the table accepted. Never the real ~/.angelia. */
function instance(o: { unmatched?: 'drop' | 'reply' | 'onboard'; mention?: 'any'; connectMention?: 'required' | 'any'; noOnboard?: boolean; extraProfile?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-connect-'));
  const inst = join(dir, 'instance');
  const agents = join(dir, 'agents');
  const folder = join(agents, 'recipes');
  mkdirSync(folder, { recursive: true });
  mkdirSync(join(dir, 'a'));
  writeFileSync(join(folder, 'CLAUDE.md'), SET_UP);
  const table = join(dir, 'routing.yaml');
  writeFileSync(table, `# my table
profiles:
  a: {cwd: ${join(dir, 'a')}}
  recipes: {cwd: ${folder}}
${o.extraProfile ?? ''}routes:
  - {platform: telegram, chat: 1, profile: a}
telegram: {}
whatsapp: {}
defaults: {unmatched: ${o.unmatched ?? 'drop'}, max_out_per_min: 1000}
${o.noOnboard ? '' : `onboard:
  owners: ["u1"]
  allow_from: ["u1", "u2"]
  folder: ${agents}
${o.mention ? `  mention: ${o.mention}\n` : ''}${o.connectMention ? `  connect_mention: ${o.connectMention}\n` : ''}  profile: {bin: ${FAKE}}
`}`);
  const cfg = loadConfig(table);
  writeAccepted(cfg, inst);
  return { dir, inst, agents, folder, table, cfg };
}

function orch(t: { after(fn: () => unknown): void }, o: Parameters<typeof instance>[0] = {}, wire: { remove?: (instance: string, a: Armed) => void } = {}) {
  const s = instance(o);
  const sent: { chat: string; text: string }[] = [];
  const logs: string[] = [];
  const onboarded: string[] = [];
  const sender = { send: async (chat: string, text: string) => { sent.push({ chat, text }); }, chatName: async () => 'Family Kitchen' };
  // Today's onboarding, as a stub: the tests only need to see that it was the path taken.
  const onboard = (i: Inbound) => { onboarded.push(i.chat); throw new Error('stub onboarding'); };
  const orchestrator = new Orchestrator(s.cfg, { telegram: sender, whatsapp: sender }, {
    stateDir: s.inst, bins: { 'claude-code': FAKE }, log: (l) => logs.push(l), onboard,
    connect: connectWiring({ table: s.table, cfg: s.cfg, instance: s.inst, log: (l) => logs.push(l), ...wire }),
  });
  t.after(() => orchestrator.shutdown());
  return { ...s, o: orchestrator, sent, logs, onboarded };
}

const msg = (sender: string, text: string, more: Partial<Inbound> = {}): Inbound => ({ platform: 'whatsapp', chat: 'new@g.us', sender, senderName: 'N', text, isGroup: true, mentioned: true, media: [], ...more });

test('armed: the owner\'s first message in a new group binds it to the set-up profile, with a short preface', async (t) => {
  const s = orch(t, { unmatched: 'onboard' });
  arm(s.inst, { profile: 'recipes', platform: 'whatsapp' });
  const before = readFileSync(s.table, 'utf8');
  const folders = readdirSync(s.agents);
  await Promise.all([s.o.handle(msg('u1', 'what is for dinner')), s.o.handle(msg('u1', 'and dessert'))]);

  assert.deepEqual(s.onboarded, [], 'onboarding never ran');
  // No "Connected" line in the chat (a group in use): the first thing there is the agent's answer.
  assert.equal(s.sent[0].text, `echo: ${connectPreface('recipes', 'whatsapp:new@g.us', 'Family Kitchen')}\n\n[whatsapp group new@g.us · N (u1)]\n\nwhat is for dinner`);
  assert.match(s.sent[0].text, /Do not start onboarding/);
  assert.doesNotMatch(s.sent[0].text, /still being set up|onboarding prompt/i);
  assert.equal(s.sent[1].text, 'echo: [whatsapp group new@g.us · N (u1)]\n\nand dessert', 'the queued second message routes normally');
  assert.equal(s.sent.length, 2);
  assert.ok(!s.sent.some((m) => /Connected/.test(m.text)));

  assert.deepEqual(Object.keys(s.cfg.profiles), ['a', 'recipes'], 'no new profile');
  assert.deepEqual(readdirSync(s.agents), folders, 'no new folder');
  assert.equal(readFileSync(join(s.folder, 'CLAUDE.md'), 'utf8'), SET_UP, 'the instruction file is not touched');
  const added = readFileSync(s.table, 'utf8').split('\n').filter((l) => !before.split('\n').includes(l));
  assert.equal(added.length, 2);
  assert.match(added[0], /# Connected \d{4}-\d\d-\d\d to recipes, from "Family Kitchen"\./);
  assert.equal(added[1], '  - {platform: whatsapp, chat: new@g.us, profile: recipes, mention: required, owners: [u1], allow_from: [u1, u2]}', 'built as onboarding builds a route, answering only when mentioned');
  assert.ok(readAccepted(s.inst)!.routes.some((r) => r.chat === 'new@g.us' && r.profile === 'recipes'), 'the new route is accepted');
  assert.equal(armedFor(s.inst, 'whatsapp'), undefined, 'the entry is used once');
  assert.ok(s.logs.includes('connected key=whatsapp:new@g.us profile=recipes'));
  assert.notEqual(s.o.map.getActive('whatsapp:new@g.us')?.id, undefined, 'the chat has its own session');
});

test('armed, a non-owner first: dropped as today, the entry stays; then the owner binds', async (t) => {
  const s = orch(t, { unmatched: 'onboard' });
  arm(s.inst, { profile: 'recipes', platform: 'whatsapp' });
  await s.o.handle(msg('stranger', 'hi'));
  assert.equal(s.sent.length, 0);
  assert.ok(s.logs.some((l) => /drop key=whatsapp:new@g\.us reason=unmatched-not-owner sender=stranger/.test(l)));
  assert.equal(armedFor(s.inst, 'whatsapp')?.profile, 'recipes');
  await s.o.handle(msg('u1', 'hello'));
  assert.match(s.sent[0].text, /^echo: This chat \(whatsapp:new@g\.us, "Family Kitchen"\) was just connected to you, recipes\./);
});

test('armed, an owner who does not mention the bot in the group binds nothing; a command neither', async (t) => {
  const s = orch(t);
  arm(s.inst, { profile: 'recipes', platform: 'whatsapp' });
  await s.o.handle(msg('u1', 'lunch anyone?', { mentioned: false }));
  await s.o.handle(msg('u1', '/help'));
  assert.equal(s.sent.length, 0);
  assert.equal(s.cfg.routes.length, 1);
  assert.ok(armedFor(s.inst, 'whatsapp'));
});

test('a connected chat answers only when mentioned by default, even with onboard.mention: any', async (t) => {
  const s = orch(t, { mention: 'any' });
  arm(s.inst, { profile: 'recipes', platform: 'whatsapp' });
  // onboard.mention is for onboarding new chats; a connect has its own setting, required by default.
  await s.o.handle(msg('u1', 'hi all', { mentioned: false }));
  assert.equal(s.cfg.routes.length, 1);
  assert.ok(armedFor(s.inst, 'whatsapp'));
  await s.o.handle(msg('u1', 'hello'));
  assert.match(s.sent[0].text, /^echo: This chat \(whatsapp:new@g\.us, "Family Kitchen"\) was just connected to you, recipes\./);
  assert.equal(s.cfg.routes.at(-1)!.mention, 'required');
});

test('with onboard.connect_mention: any, the bind still needs a mention; then the route answers every message', async (t) => {
  const s = orch(t, { connectMention: 'any' });
  arm(s.inst, { profile: 'recipes', platform: 'whatsapp' });
  // An owner line in some other group the bot is in must not take the profile (review fix M2).
  await s.o.handle(msg('u1', 'hi all', { mentioned: false }));
  assert.equal(s.cfg.routes.length, 1, 'no bind without a mention');
  assert.ok(armedFor(s.inst, 'whatsapp'));
  await s.o.handle(msg('u1', 'hello'));
  assert.match(s.sent[0].text, /^echo: This chat \(whatsapp:new@g\.us, "Family Kitchen"\) was just connected to you, recipes\./);
  assert.equal(s.cfg.routes.at(-1)!.mention, 'any');
  await s.o.handle(msg('u1', 'and now?', { mentioned: false }));
  assert.equal(s.sent.at(-1)!.text, 'echo: [whatsapp group new@g.us · N (u1)]\n\nand now?', 'later messages need no mention');
});

test('the arm\'s --mention required wins over onboard.connect_mention: any', async (t) => {
  const s = orch(t, { connectMention: 'any' });
  arm(s.inst, { profile: 'recipes', platform: 'whatsapp', route: { mention: 'required' } });
  await s.o.handle(msg('u1', 'hi all', { mentioned: false }));
  assert.equal(s.cfg.routes.length, 1);
  await s.o.handle(msg('u1', 'hello'));
  assert.equal(s.cfg.routes.at(-1)!.mention, 'required');
});

test('armed telegram does not catch a whatsapp chat; an expired entry and nothing armed take today\'s path', async (t) => {
  const s = orch(t, { unmatched: 'onboard' });
  arm(s.inst, { profile: 'recipes', platform: 'telegram' });
  await s.o.handle(msg('u1', 'one'));
  assert.deepEqual(s.onboarded, ['new@g.us'], 'onboarding ran, as today');
  assert.ok(armedFor(s.inst, 'telegram'), 'the telegram entry stays');

  arm(s.inst, { profile: 'recipes', platform: 'whatsapp', hours: 24, now: new Date(Date.now() - 25 * 3600_000) });
  await s.o.handle(msg('u1', 'two', { chat: 'other@g.us' }));
  assert.deepEqual(s.onboarded, ['new@g.us', 'other@g.us']);
  assert.equal(s.cfg.routes.length, 1, 'nothing bound');
});

test('a chat on the skip list is not bound, even armed', async (t) => {
  const s = orch(t);
  const table = readFileSync(s.table, 'utf8').replace('  allow_from: ["u1", "u2"]', '  allow_from: ["u1", "u2"]\n  skip: ["whatsapp:new@g.us"]');
  writeFileSync(s.table, table);
  s.cfg.onboard!.skip = ['whatsapp:new@g.us'];
  arm(s.inst, { profile: 'recipes', platform: 'whatsapp' });
  await s.o.handle(msg('u1', 'hello'));
  assert.equal(s.sent.length, 0);
  assert.ok(armedFor(s.inst, 'whatsapp'));
});

test('defaults.unmatched: drop, and reply, with an entry armed: the owner binds; a stranger gets today\'s reply', async (t) => {
  const s = orch(t, { unmatched: 'drop' });
  arm(s.inst, { profile: 'recipes', platform: 'whatsapp' });
  await s.o.handle(msg('u1', 'hello'));
  assert.match(s.sent[0].text, /^echo: This chat \(whatsapp:new@g\.us, "Family Kitchen"\) was just connected to you, recipes\./);

  const r = orch(t, { unmatched: 'reply' });
  arm(r.inst, { profile: 'recipes', platform: 'whatsapp' });
  await r.o.handle(msg('stranger', 'hello', { isGroup: false, chat: 'stranger' }));
  assert.equal(r.sent.length, 1);
  assert.doesNotMatch(r.sent[0].text, /Connected/);
  assert.ok(armedFor(r.inst, 'whatsapp'));
});

test('a table changed by someone else: refused, logged, nothing said in the group, one fixed line in a DM; the entry kept', async (t) => {
  const s = orch(t);
  arm(s.inst, { profile: 'recipes', platform: 'whatsapp' });
  // An agent edits the table and nobody accepted it.
  writeFileSync(s.table, readFileSync(s.table, 'utf8').replace('a: {cwd:', 'a: {shell: true, cwd:'));
  const before = readFileSync(s.table, 'utf8');
  await s.o.handle(msg('u1', 'hello'));
  assert.equal(s.sent.length, 0, 'never in a group');
  assert.equal(readFileSync(s.table, 'utf8'), before);
  assert.ok(armedFor(s.inst, 'whatsapp'), 'still armed');
  assert.ok(s.logs.some((l) => l.startsWith('connect failed key=whatsapp:new@g.us not connecting: the routing table has 1 change')));
  assert.equal(s.cfg.routes.length, 1);
  await s.o.handle(msg('u1', 'hello', { chat: 'u1', isGroup: false, mentioned: false }));
  assert.deepEqual(s.sent.map((m) => m.text), [CONNECT_FAILED_LINE]);
  assert.doesNotMatch(CONNECT_FAILED_LINE, /\d|@|whatsapp:/, 'no ids in the line');
});

test('an edit that lands between the checks and the write: the table goes back, nothing is routed', () => {
  const s = instance();
  const before = readFileSync(s.table, 'utf8');
  const sneaky = (p: string) => readFileSync(p, 'utf8').replace('a: {cwd:', 'a: {shell: true, cwd:');
  assert.throws(() => bindChat({ table: s.table, cfg: s.cfg, profile: 'recipes', platform: 'whatsapp', chat: 'x@g.us', instance: s.inst, readTable: sneaky }),
    /not connecting: the routing table changed while it was written \(profiles\.a\.shell/);
  assert.equal(readFileSync(s.table, 'utf8'), before);
  assert.equal(s.cfg.routes.length, 1);
});

test('a bind holds the table lock: while another writer has it, a clean refusal at once, the table as it was (L6)', () => {
  const s = instance();
  const before = readFileSync(s.table, 'utf8');
  writeFileSync(`${s.table}.lock`, String(process.pid)); // a live writer: this process
  const t0 = Date.now();
  assert.throws(() => bindChat({ table: s.table, cfg: s.cfg, profile: 'recipes', platform: 'whatsapp', chat: 'x@g.us', instance: s.inst }),
    (e: Error) => e.message === 'not connecting: the routing table is being written by another process; try again in a moment');
  assert.ok(Date.now() - t0 < 1500, `waited ${Date.now() - t0} ms`);
  assert.equal(readFileSync(s.table, 'utf8'), before);
  assert.equal(s.cfg.routes.length, 1);
  rmSync(`${s.table}.lock`);
  bindChat({ table: s.table, cfg: s.cfg, profile: 'recipes', platform: 'whatsapp', chat: 'x@g.us', instance: s.inst });
  assert.equal(s.cfg.routes.length, 2, 'free again: it binds');
  assert.ok(!existsSync(`${s.table}.lock`), 'the lock is let go');
});

test('a bind waits only a short time for the compile lock, then refuses and puts the table back (L7)', () => {
  const s = instance();
  const before = readFileSync(s.table, 'utf8');
  mkdirSync(join(s.inst, 'compiled'), { recursive: true });
  writeFileSync(join(s.inst, 'compiled', '.compile.lock'), `${process.pid}\n`); // a live compile
  const t0 = Date.now();
  assert.throws(() => bindChat({ table: s.table, cfg: s.cfg, profile: 'recipes', platform: 'whatsapp', chat: 'x@g.us', instance: s.inst }), /another compile is writing/);
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `waited ${ms} ms, not the 2 s default`);
  assert.equal(readFileSync(s.table, 'utf8'), before);
  assert.equal(s.cfg.routes.length, 1);
});

test('a bind recompiles the profile, and in the workspace commits its folder only when something changed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-connect-ws-'));
  const inst = join(dir, 'i'), ws = join(inst, 'workspace'), folder = join(ws, 'profiles', 'recipes');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'CLAUDE.md'), SET_UP);
  const table = join(ws, 'routing.yaml');
  writeFileSync(table, `profiles:\n  recipes: {cwd: ${folder}}\nroutes: []\ntelegram: {}\nonboard: {owners: ["u1"]}\n`);
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'start']]) execFileSync('git', args, { cwd: ws, stdio: 'ignore' });
  const cfg = loadConfig(table);
  writeAccepted(cfg, inst);
  const made = bindChat({ table, cfg, profile: 'recipes', platform: 'telegram', chat: '-100200', instance: inst, self: (p) => `you are ${p}` });
  assert.equal(made.folder, folder);
  assert.ok(existsSync(join(inst, 'compiled', 'recipes.json')), 'compiled');
  const git = await made.git;
  assert.match(git ?? '', /^(committed|nothing to commit)$/);
  assert.equal(readFileSync(join(folder, 'CLAUDE.md'), 'utf8'), SET_UP);
  assert.throws(() => bindChat({ table, cfg, profile: 'recipes', platform: 'telegram', chat: '-100200', instance: inst }), /already routed/);
});

const cli = (s: ReturnType<typeof instance>, logs: string[] = []) => (...argv: string[]) => connectCommand(argv, { stateDir: s.inst, table: s.table, log: (l) => logs.push(l) });

test('CLI: arm, replace, list, cancel, and profiles shows the arm', async () => {
  const s = instance({ extraProfile: `  notes: {cwd: ${tmpdir()}}\n` });
  const logs: string[] = [];
  const run = cli(s, logs);
  assert.match(await run(), /^Nothing is armed/);
  const first = await run('recipes', 'whatsapp');
  assert.match(first, /^Armed recipes for the next new whatsapp chat, until /);
  assert.match(first, /mention the bot/);
  assert.match(logs[0], /^connect-armed profile=recipes platform=whatsapp until=\S+$/);
  assert.match(profilesText(s.cfg, armedList(s.inst)), /recipes\n[\s\S]*armed {4}takes the next new whatsapp chat an owner writes in, until /);

  const second = await run('notes', 'whatsapp', '--hours', '2');
  assert.match(second, /This replaces recipes, which was armed until /);
  assert.match(logs[1], /replaced=recipes$/);
  const a = armedFor(s.inst, 'whatsapp')!;
  assert.equal(a.profile, 'notes');
  assert.equal(Date.parse(a.until) - Date.parse(a.at), 2 * 3600_000);
  await run('recipes', 'telegram');
  assert.equal((await run()).split('\n').length, 2, 'one line per platform');

  assert.match(await run('--cancel', 'whatsapp'), /^Cancelled: notes no longer takes the next new whatsapp chat\.$/);
  assert.match(await run('--cancel', 'whatsapp'), /^Nothing was armed for whatsapp\.$/);
  assert.deepEqual(armedList(s.inst).map((x) => x.platform), ['telegram']);
});

test('CLI: refusals', async () => {
  const s = instance({ extraProfile: '  keeper: {cwd: /tmp, shared_write: true}\n' });
  const run = cli(s);
  await assert.rejects(run('nobody', 'whatsapp'), /no profile named nobody/);
  await assert.rejects(run('keeper', 'whatsapp'), /keeper has shared_write/);
  await assert.rejects(run('recipes', 'whatsapp', '--hours', '0'), /--hours: a whole number from 1 to 168/);
  await assert.rejects(run('recipes', 'whatsapp', '--hours', '169'), /--hours/);
  await assert.rejects(run('recipes', 'app'), /usage: angelia profile connect/);
  await assert.rejects(run('recipes'), /usage/);
  await assert.rejects(run('--cancel', 'sms'), /usage/);
  await assert.rejects(run('recipes', 'telegram:1'), /telegram:1 is already routed/);
  assert.deepEqual(armedList(s.inst), []);
  const w = instance();
  writeFileSync(w.table, readFileSync(w.table, 'utf8').replace('telegram: {}\n', '').replace('  - {platform: telegram, chat: 1, profile: a}\n', '  - {platform: whatsapp, chat: x, profile: a}\n'));
  await assert.rejects(cli(w)('recipes', 'telegram'), /no telegram: block/);
  const n = instance({ noOnboard: true });
  await assert.rejects(cli(n)('recipes', 'whatsapp'), /onboard: block/);
});

test('CLI: a chat whose id is known is routed now, by the same bind', async () => {
  const s = instance();
  const logs: string[] = [];
  const out = await cli(s, logs)('recipes', 'whatsapp:120363000000000001@g.us');
  assert.match(out, /^Connected whatsapp:120363000000000001@g\.us to recipes\.\nThe daemon picks it up at the next restart/);
  const fresh = loadConfig(s.table);
  assert.deepEqual(fresh.routes.at(-1), { platform: 'whatsapp', chat: '120363000000000001@g.us', profile: 'recipes', mention: 'required', owners: ['u1'], allow_from: ['u1', 'u2'] });
  assert.equal(readFileSync(join(s.folder, 'CLAUDE.md'), 'utf8'), SET_UP);
  assert.deepEqual(armedList(s.inst), [], 'a direct bind arms nothing');
  assert.equal(logs[0], 'connected key=whatsapp:120363000000000001@g.us profile=recipes from=terminal');
  await assert.rejects(cli(s)('recipes', 'whatsapp:120363000000000001@g.us'), /already routed/);
});

test('join event: an owner adds the bot, the group is routed at once, with no line and no turn; the next message routes', async (t) => {
  const s = orch(t);
  arm(s.inst, { profile: 'recipes', platform: 'whatsapp' });
  // A stranger adds the bot: nothing, the arm stays.
  await s.o.joined('whatsapp', 'busy@g.us', ['stranger']);
  assert.equal(s.cfg.routes.length, 1);
  assert.ok(armedFor(s.inst, 'whatsapp'));
  assert.ok(s.logs.includes('connect skipped key=whatsapp:busy@g.us reason=added-by-not-owner by=stranger'));
  // The owner, seen by lid and by phone: one of them is in the owners.
  await s.o.joined('whatsapp', 'busy@g.us', ['u1', '99999999999999']);
  assert.equal(s.sent.length, 0, 'nothing posted in a group in use');
  assert.ok(s.logs.includes('connected key=whatsapp:busy@g.us profile=recipes on=join'));
  assert.equal(armedFor(s.inst, 'whatsapp'), undefined);
  assert.equal(s.o.map.getActive('whatsapp:busy@g.us'), undefined, 'no turn ran');
  // Someone the onboard block allows writes next, mentioning the bot: an ordinary turn, no preface.
  await s.o.handle(msg('u2', 'hi', { chat: 'busy@g.us' }));
  assert.equal(s.sent[0].text, 'echo: [whatsapp group busy@g.us · N (u2)]\n\nhi');
  // Once routed, a second join event does nothing.
  await s.o.joined('whatsapp', 'busy@g.us', ['u1']);
  assert.equal(s.cfg.routes.length, 2);
});

test('join event: nothing armed, a skipped chat or another platform: nothing happens', async (t) => {
  const s = orch(t);
  await s.o.joined('whatsapp', 'g1@g.us', ['u1']);
  arm(s.inst, { profile: 'recipes', platform: 'telegram' });
  await s.o.joined('whatsapp', 'g1@g.us', ['u1']);
  s.cfg.onboard!.skip = ['telegram:-1001'];
  await s.o.joined('telegram', '-1001', ['u1']);
  assert.equal(s.cfg.routes.length, 1);
  assert.ok(armedFor(s.inst, 'telegram'));
});

test('the arm carries the route\'s settings: owners added to the block\'s, its allow list and mention; only the block\'s owners use it', async (t) => {
  const s = orch(t);
  arm(s.inst, { profile: 'recipes', platform: 'whatsapp', route: { owners: ['u9'], allow_from: ['*'], mention: 'any' } });
  // u9 is an owner of the route to come, not someone who may take the profile.
  await s.o.handle(msg('u9', 'hello', { mentioned: false }));
  await s.o.joined('whatsapp', 'new@g.us', ['u9']);
  assert.equal(s.cfg.routes.length, 1, 'u9 used nothing');
  assert.ok(armedFor(s.inst, 'whatsapp'));
  // The block's owner binds with a mention, as always; the arm's mention: any is the route's (M2).
  await s.o.handle(msg('u1', 'hello', { mentioned: false }));
  assert.equal(s.cfg.routes.length, 1, 'no bind without a mention, even with mention: any on the arm');
  await s.o.handle(msg('u1', 'hello'));
  const r = s.cfg.routes.at(-1)!;
  assert.deepEqual([r.chat, r.owners, r.allow_from, r.mention], ['new@g.us', ['u1', 'u9'], ['*'], 'any']);
  assert.match(s.sent[0].text, /was just connected to you, recipes/);
  assert.throws(() => arm(s.inst, { profile: 'recipes', platform: 'whatsapp', route: { owners: ['*'] } }), /everyone an owner/);
  assert.throws(() => arm(s.inst, { profile: 'recipes', platform: 'whatsapp', route: { allow_from: ['a b'] } }), /not a sender id/);
});

test('CLI: --allow, --owners and --mention go on the arm and on a direct bind; bad values are refused', async () => {
  const s = instance();
  const run = cli(s);
  const out = await run('recipes', 'whatsapp', '--allow', '15550000002,15550000003', '--owners', '15550000009', '--mention', 'any');
  assert.match(out, /Its route differs from the onboard: block: owners u1, 15550000009; allow_from 15550000002, 15550000003; mention any\./);
  assert.deepEqual(armedFor(s.inst, 'whatsapp')!.route, { owners: ['15550000009'], allow_from: ['15550000002', '15550000003'], mention: 'any' });
  // Flags that change nothing print nothing (M3: only a difference is worth the line).
  assert.doesNotMatch(await run('recipes', 'whatsapp', '--allow', 'u2,u1', '--mention', 'required'), /differs/);
  await assert.rejects(run('recipes', 'whatsapp', '--mention', 'sometimes'), /--mention: required or any/);
  await assert.rejects(run('recipes', 'whatsapp', '--owners', '*'), /everyone an owner/);
  await assert.rejects(run('recipes', 'whatsapp', '--allow'), /--allow needs a value/);
  const direct = await run('recipes', 'telegram:-100777', '--allow', '*');
  assert.deepEqual(loadConfig(s.table).routes.at(-1)!.allow_from, ['*']);
  assert.match(direct, /^Connected telegram:-100777 to recipes\.\nIts route differs from the onboard: block: allow_from \*\.\n/, 'the direct form shows the widening too');
  assert.doesNotMatch(await run('recipes', 'telegram:-100778'), /differs/, 'a plain direct bind: no line');
});

test('M2: a chat routed in the table on disk (waiting for a restart) is not connected again; nothing said, logged, the arm kept', async (t) => {
  const s = orch(t);
  arm(s.inst, { profile: 'recipes', platform: 'whatsapp' });
  // `profile connect recipes whatsapp:new@g.us` from a terminal: on disk and accepted, not live yet.
  await connectCommand(['a', 'whatsapp:new@g.us'], { stateDir: s.inst, table: s.table });
  s.cfg.routes.pop();
  const before = readFileSync(s.table, 'utf8');
  await s.o.handle(msg('u1', 'hello'));
  await s.o.joined('whatsapp', 'new@g.us', ['u1']);
  assert.equal(s.sent.length, 0);
  assert.equal(readFileSync(s.table, 'utf8'), before, 'no second route');
  assert.equal(s.logs.filter((l) => l === 'connect skipped key=whatsapp:new@g.us reason=routed').length, 2);
  assert.equal(armedFor(s.inst, 'whatsapp')?.profile, 'recipes');
});

test('M3: an arm another chat took while this one waited: today\'s path, as if nothing had been armed', async (t) => {
  for (const unmatched of ['onboard', 'drop'] as const) {
    const s = orch(t, { unmatched });
    arm(s.inst, { profile: 'recipes', platform: 'whatsapp' });
    // Both pass the check while the arm is there; the first to bind uses it.
    await Promise.all([s.o.handle(msg('u1', 'one', { chat: 'g1@g.us' })), s.o.handle(msg('u1', 'two', { chat: 'g2@g.us' }))]);
    assert.deepEqual(s.cfg.routes.map((r) => r.chat), ['1', 'g1@g.us']);
    assert.ok(s.logs.includes('connect skipped key=whatsapp:g2@g.us reason=not-armed'));
    assert.ok(!s.logs.some((l) => l.startsWith('connect failed')));
    if (unmatched === 'onboard') assert.deepEqual(s.onboarded, ['g2@g.us'], 'onboarded, as with nothing armed');
    else {
      assert.deepEqual(s.onboarded, []);
      assert.ok(s.logs.some((l) => l.startsWith('drop key=whatsapp:g2@g.us reason=unmatched')));
      assert.equal(s.sent.filter((m) => m.chat === 'g2@g.us').length, 0, 'silent');
    }
  }
});

test('L6: an arm that will not come off after a good bind: tried twice, logged, and the chat still gets its answer, no error line', async (t) => {
  let tries = 0;
  const s = orch(t, {}, { remove: () => { tries++; throw new Error('disk full'); } });
  arm(s.inst, { profile: 'recipes', platform: 'whatsapp' });
  await s.o.handle(msg('u1', 'hello'));
  assert.equal(tries, 2);
  assert.ok(s.logs.includes('connect arm not removed (try 1 of 2) platform=whatsapp profile=recipes: disk full'));
  assert.ok(s.logs.includes('connect arm not removed (try 2 of 2) platform=whatsapp profile=recipes: disk full'));
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].text, /^echo: This chat \(whatsapp:new@g\.us/);
  assert.ok(s.logs.includes('connected key=whatsapp:new@g.us profile=recipes'));

  let once = 0;
  const r = orch(t, {}, { remove: (inst, a) => { if (!once++) throw new Error('busy'); cancelArmedFor(inst, a); } });
  arm(r.inst, { profile: 'recipes', platform: 'whatsapp' });
  await r.o.handle(msg('u1', 'hello'));
  assert.equal(armedFor(r.inst, 'whatsapp'), undefined, 'the second try took it off');
  assert.equal(r.logs.filter((l) => l.startsWith('connect arm not removed')).length, 1);
});

test('L7: a Telegram add from before the arm (a replay) does not use it', async (t) => {
  const s = orch(t);
  arm(s.inst, { profile: 'recipes', platform: 'telegram' });
  await s.o.joined('telegram', '-100400', ['u1'], Date.now() - 3600_000);
  assert.equal(s.cfg.routes.length, 1);
  assert.ok(s.logs.includes('connect skipped key=telegram:-100400 reason=added-before-arm'));
  // A platform's time is whole seconds and its clock not this one: an add a moment before the arm counts.
  await s.o.joined('telegram', '-100400', ['u1'], Math.floor(Date.now() / 1000) * 1000 - 1500);
  assert.equal(s.cfg.routes.at(-1)!.chat, '-100400');
});

test('L9: the arm file is read again when it changes on disk, and not otherwise', () => {
  const s = instance();
  arm(s.inst, { profile: 'recipes', platform: 'whatsapp' });
  assert.equal(armedFor(s.inst, 'whatsapp')?.profile, 'recipes');
  // Another process (the terminal) arms another profile: the file changes, the next read sees it.
  const file = join(s.inst, 'compiled', 'table', 'connect.json');
  const other = JSON.parse(readFileSync(file, 'utf8')) as Armed[];
  other[0].profile = 'a';
  writeFileSync(file, JSON.stringify(other) + '\n  ');
  assert.equal(armedFor(s.inst, 'whatsapp')?.profile, 'a');
});

test('fix2 M2: a profile added (and accepted) after the daemon started binds against the table on disk, and joins the live config', async () => {
  const s = instance();
  // The daemon's live config, from before `profile add` and `angelia accept` in a terminal.
  const live = loadConfig(s.table);
  mkdirSync(join(s.agents, 'notes'), { recursive: true });
  writeFileSync(s.table, readFileSync(s.table, 'utf8').replace('routes:\n', `  notes: {cwd: ${join(s.agents, 'notes')}}\nroutes:\n`));
  writeAccepted(loadConfig(s.table), s.inst);
  assert.ok(!('notes' in live.profiles));
  arm(s.inst, { profile: 'notes', platform: 'whatsapp' });
  const wire = connectWiring({ table: s.table, cfg: live, instance: s.inst });
  const made = wire.bind({ platform: 'whatsapp', chat: 'g2@g.us' });
  assert.equal(made.name, 'notes');
  assert.equal(live.profiles.notes.cwd, join(s.agents, 'notes'), 'the live config has the profile now');
  assert.equal(live.routes.at(-1)!.profile, 'notes');
  assert.equal(readAccepted(s.inst)!.routes.at(-1)!.chat, 'g2@g.us');
  // Still refused: a name the table on disk does not have either.
  assert.throws(() => bindChat({ table: s.table, cfg: live, profile: 'ghost', platform: 'whatsapp', chat: 'g3@g.us', instance: s.inst }), /not connecting: no profile named ghost/);
});

test('fix2 L2: a bind whose accepted copy cannot be written puts the table back and routes nothing', () => {
  const s = instance();
  const before = readFileSync(s.table, 'utf8');
  mkdirSync(join(s.inst, 'compiled', 'table', 'accepted.json.tmp'), { recursive: true }); // the write fails: a folder there
  assert.throws(() => bindChat({ table: s.table, cfg: s.cfg, profile: 'recipes', platform: 'whatsapp', chat: 'x@g.us', instance: s.inst }));
  assert.equal(readFileSync(s.table, 'utf8'), before);
  assert.equal(s.cfg.routes.length, 1);
  assert.equal(readAccepted(s.inst)!.routes.length, 1);
});

test('fix2 C1: with an arm, an owner\'s unmentioned line in an unrouted group onboards nothing, even with onboard.mention: any', async (t) => {
  const s = orch(t, { unmatched: 'onboard', mention: 'any' });
  arm(s.inst, { profile: 'recipes', platform: 'whatsapp' });
  await s.o.handle(msg('u1', 'lunch anyone?', { mentioned: false }));
  assert.deepEqual(s.onboarded, [], 'no new profile');
  assert.equal(s.cfg.routes.length, 1, 'nothing bound');
  assert.equal(s.sent.length, 0);
  assert.ok(s.logs.some((l) => /drop key=whatsapp:new@g\.us reason=unmatched-armed-not-mentioned/.test(l)), s.logs.join('\n'));
  assert.ok(armedFor(s.inst, 'whatsapp'), 'still armed');
  // Nothing armed: onboarding with mention: any goes on as before.
  cancelArmed(s.inst, 'whatsapp');
  await s.o.handle(msg('u1', 'lunch anyone?', { mentioned: false }));
  assert.deepEqual(s.onboarded, ['new@g.us']);
});

test('fix2 C3: a failed onboarding says one fixed line in the chat; the error is in the log only', async (t) => {
  const s = orch(t, { unmatched: 'onboard' });
  await s.o.handle(msg('u1', 'hello', { chat: 'u1', isGroup: false, mentioned: false }));
  assert.deepEqual(s.onboarded, ['u1']);
  assert.deepEqual(s.sent.map((m) => m.text), [ONBOARD_FAILED_LINE]);
  assert.doesNotMatch(ONBOARD_FAILED_LINE, /stub|\d|\//);
  assert.ok(s.logs.some((l) => l === 'onboard failed key=whatsapp:u1 stub onboarding'), s.logs.join('\n'));
});
