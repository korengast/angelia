import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { briefTurn, handoffTarget, HandoffError, pickChat } from '../src/core/handoff.js';
import { planHandoffSkill } from '../src/capabilities/compile.js';
import { handoffCommand } from '../src/cli/handoff-cli.js';
import type { BrainEvent, Inbound } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-claude.mjs');
const SESSION = '0c99166e-f194-4a49-a5cf-f3af457ba94c';
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

/** Folders: a (Claude Code, owns `own`, reaches `code`), g (grok, owns `grok`), m (the handoff profile, reaches `code` too). */
function world(o: { handoff?: string | null; chats?: number } = {}) {
  const root = tmp('angelia-ho-');
  const d = (n: string) => { const p = join(root, n); mkdirSync(p, { recursive: true }); return p; };
  const own = d('own'), grok = d('grok'), master = d('master'), code = d('code'), elsewhere = d('elsewhere');
  const routes: unknown[] = [{ platform: 'telegram', chat: 1, profile: 'a' }, { platform: 'telegram', chat: 2, profile: 'm' }, { platform: 'telegram', chat: 3, profile: 'g' }];
  if ((o.chats ?? 1) > 1) routes.push({ platform: 'whatsapp', chat: 'g@g.us', profile: 'a', owners: ['u1'] });
  const cfg = Config.parse({
    profiles: { a: { cwd: own, add_dirs: [code] }, g: { cwd: grok, backend: 'grok' }, m: { cwd: master, add_dirs: [code] } },
    routes,
    telegram: {},
    defaults: { max_out_per_min: 1000, ...(o.handoff === null ? {} : { handoff: o.handoff ?? 'm' }) },
  });
  return { cfg, own, grok, master, code, elsewhere };
}

function orch(cfg: Config, env?: NodeJS.ProcessEnv) {
  const sent: { chat: string; text: string }[] = [];
  const log: string[] = [];
  const sender = { send: async (chat: string, text: string) => { sent.push({ chat, text }); } };
  const o = new Orchestrator(cfg, { telegram: sender, whatsapp: sender },
    { stateDir: tmp('angelia-ho-state-'), bins: { 'claude-code': FAKE }, log: (l) => log.push(l), ...(env ? { env } : {}) });
  return { o, sent, log };
}
const dm = (chat: string, text: string): Inbound => ({ platform: 'telegram', chat, sender: 'u1', senderName: 'Owner', text, isGroup: false, mentioned: false, media: [] });
const until = async (cond: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

test('the folder decides: a profile\'s own folder moves the session, add_dirs and the rest get a brief', () => {
  const w = world();
  assert.deepEqual(handoffTarget(w.cfg, w.own), { mode: 'session', profile: 'a', via: 'folder', chats: ['telegram:1'] });
  assert.equal(handoffTarget(w.cfg, join(w.own)).mode, 'session');
  mkdirSync(join(w.own, 'sub'));
  assert.equal(handoffTarget(w.cfg, join(w.own, 'sub')).profile, 'a', 'a folder inside the profile\'s own counts');
  // A profile on another CLI cannot take a Claude Code session: its own folder gets a brief.
  assert.deepEqual(handoffTarget(w.cfg, w.grok), { mode: 'brief', profile: 'g', via: 'folder', chats: ['telegram:3'] });
  // Both a and m reach `code`: the tie goes to the handoff profile.
  assert.deepEqual(handoffTarget(w.cfg, w.code), { mode: 'brief', profile: 'm', via: 'add_dirs', chats: ['telegram:2'] });
  assert.deepEqual(handoffTarget(w.cfg, w.elsewhere), { mode: 'brief', profile: 'm', via: 'default', chats: ['telegram:2'] });
  // A deeper add_dir beats a shallower one.
  const deep = join(w.code, 'deep'); mkdirSync(deep);
  const cfg2 = Config.parse({ ...w.cfg, profiles: { ...w.cfg.profiles, a: { ...w.cfg.profiles.a, add_dirs: [deep] } } });
  assert.equal(handoffTarget(cfg2, deep).profile, 'a');
  assert.equal(handoffTarget(cfg2, w.code).profile, 'm');
});

test('no handoff profile: another folder is refused and told which key to set', () => {
  const w = world({ handoff: null });
  assert.throws(() => handoffTarget(w.cfg, w.elsewhere), (e: Error) => e instanceof HandoffError && /defaults\.handoff/.test(e.message));
  assert.equal(handoffTarget(w.cfg, w.code).profile, 'a', 'add_dirs still route without it');
});

test('several chats: listed, and picked by number or by key', () => {
  const w = world({ chats: 2 });
  const t = handoffTarget(w.cfg, w.own);
  assert.throws(() => pickChat(t), /2 chats\. Pick one: \/angelia-handoff <number>\n1\. telegram:1\n2\. whatsapp:g@g\.us/);
  assert.equal(pickChat(t, '2'), 'whatsapp:g@g.us');
  assert.equal(pickChat(t, 'telegram:1'), 'telegram:1');
  assert.throws(() => pickChat(t, '3'), /No chat 3/);
});

test('session mode: the terminal session becomes the chat\'s active one, the chat is told, and the next message resumes it', async (t) => {
  const w = world();
  const { o, sent } = orch(w.cfg, { ...process.env, FAKE_CLAUDE_ECHO_ARGV: '1' }); t.after(() => o.shutdown());
  await o.handle(dm('1', 'hello'));
  const before = o.map.getActive('telegram:1')!.id;
  const r = await o.handoff({ cwd: w.own, session: SESSION, summary: '  Designing the handoff command.  ' });
  assert.deepEqual(r, { key: 'telegram:1', profile: 'a', mode: 'session', said: 'From the terminal: Designing the handoff command. Continuing here.' });
  assert.equal(sent.at(-1)!.text, r.said);
  const row = o.map.getActive('telegram:1')!;
  assert.equal(row.id, SESSION);
  assert.equal(row.started, true, 'resumed, not started fresh');
  assert.equal(row.label, 'Designing the handoff command');
  assert.ok(o.map.list('telegram:1').some((x) => x.id === before), 'the old session stays in /resume');
  await o.handle(dm('1', 'go on'));
  assert.match(sent.at(-1)!.text, new RegExp(`--resume ${SESSION}`));
  await assert.rejects(o.handoff({ cwd: w.own, session: SESSION, summary: 'again' }), /already the active one/);
  await assert.rejects(o.handoff({ cwd: w.own, summary: 'x' }), /no session id/);
});

test('brief mode: a fresh session in the handoff profile\'s chat, whose first turn is the brief', async (t) => {
  const w = world();
  const { o, sent } = orch(w.cfg); t.after(() => o.shutdown());
  await o.handle(dm('2', 'something personal'));
  const before = o.map.getActive('telegram:2')!.id;
  await assert.rejects(o.handoff({ cwd: w.elsewhere, session: SESSION, summary: 'x' }), /a brief is needed/);
  const r = await o.handoff({ cwd: w.elsewhere, session: SESSION, summary: 'Fixing the parser', brief: 'Goal: parse it.\nNext step: tests.', project: `${w.elsewhere} (git: branch main)` });
  assert.equal(r.said, `From the terminal, ${w.elsewhere} (git: branch main): Fixing the parser.`);
  await until(() => sent.length >= 3);
  const answer = sent.at(-1)!.text;
  assert.match(answer, /^echo: \[telegram dm 2 · terminal handoff \(local\)\]/);
  assert.ok(answer.includes(briefTurn(`${w.elsewhere} (git: branch main)`, 'Goal: parse it.\nNext step: tests.')));
  const row = o.map.getActive('telegram:2')!;
  assert.notEqual(row.id, before);
  assert.notEqual(row.id, SESSION, 'the terminal session does not move');
  assert.equal(row.label, 'Fixing the parser');
});

test('a chat in the middle of a turn, on a CLI that cannot go on alone, refuses the handoff', async (t) => {
  const w = world();
  const { o } = orch(w.cfg); t.after(() => o.shutdown());
  const busy = o.handle(dm('1', 'SLOW'));
  await new Promise((r) => setTimeout(r, 400));
  await assert.rejects(o.handoff({ cwd: w.own, session: SESSION, summary: 'x' }), /in the middle of a turn.*\/stop/);
  await busy;
});

/** A tui-like brain whose running turn the test drives by hand. As in the real pane, a new reader
 *  (release, background, follow) ends the one before it with a `released` result. */
function fakePane(name: string) {
  const events: string[] = [];
  let current: { queue: (BrainEvent)[]; wake?: () => void; closed: boolean } | undefined;
  const open = (): AsyncGenerator<BrainEvent> => {
    if (current) { current.queue.push({ kind: 'result', text: '', isError: true, reason: 'released' }); current.wake?.(); }
    const ch: { queue: BrainEvent[]; wake?: () => void; closed: boolean } = { queue: [], closed: false };
    current = ch;
    return (async function* () {
      for (;;) {
        while (!ch.queue.length) await new Promise<void>((r) => { ch.wake = r; });
        const e = ch.queue.shift()!;
        yield e;
        if (e.kind === 'result') return;
      }
    })();
  };
  const brain = {
    name, alive: true, lastUsedAt: Date.now(), pendingPermissionCount: 0, turnSentAt: 1_700_000_000_000,
    on() { return this; }, start() {}, kill() { events.push('kill'); },
    hasPendingPermission: () => false, answerPermission: () => false,
    turn() { events.push('turn'); return open(); },
    async release() { events.push('release'); brain.alive = false; if (current) { current.queue.push({ kind: 'result', text: '', isError: true, reason: 'released' }); current.wake?.(); current = undefined; } },
    backgroundTurn() { events.push('background'); return open(); },
    follow() { events.push('follow'); brain.alive = true; return open(); },
    async stop() { events.push('stop'); brain.alive = false; },
  };
  return { brain, events, emit: (e: BrainEvent) => { current!.queue.push(e); current!.wake?.(); } };
}

test('mid-turn on a tui pane: the turn goes on in the background, a waiting permission is told once, and its end ends the pane', async (t) => {
  const w = world();
  const { o, sent } = orch(w.cfg); t.after(() => o.shutdown());
  const p = fakePane('pane-old');
  const brains = (o as unknown as { brains: Map<string, unknown> }).brains;
  const oldId = o.map.startNew('telegram:1', 'the old work').id;
  brains.set('telegram:1', p.brain);
  // A turn is running: the chat's queue holds it.
  const running = (o as unknown as { queue: { enqueue(k: string, j: () => Promise<void>): Promise<void> } }).queue.enqueue('telegram:1', async () => { for await (const _ of p.brain.turn()) { /* read */ } });
  await until(() => p.events.includes('turn'));
  const r = await o.handoff({ cwd: w.own, session: SESSION, summary: 'New direction' });
  assert.equal(r.said, 'From the terminal: New direction. Continuing here. A running turn went to the background; /resume 2 shows it.');
  assert.deepEqual(p.events, ['turn', 'release', 'background']);
  assert.equal(o.map.getActive('telegram:1')!.id, SESSION);
  assert.equal(o.map.list('telegram:1')[1].background_since, new Date(1_700_000_000_000).toISOString());
  assert.ok(o.tuiPanes().keep.has('pane-old'), 'the sweep leaves it alone');
  await running; // the old reader stopped at the release
  await o.handle(dm('1', '/status'));
  assert.match(sent.at(-1)!.text, new RegExp(`session ${oldId.slice(0, 8)} is still working in the background: /resume 2`));

  p.emit({ kind: 'permission', id: 'abcd1234', tool: 'Bash command', preview: 'rm -rf build' });
  await until(() => sent.some((s) => s.text.startsWith('The background turn')));
  assert.equal(sent.at(-1)!.text, `The background turn of session ${oldId.slice(0, 8)} is waiting for a permission. Answer it in the Claude app or in its pane; the chat cannot, since only the screen says what it asks.`);
  assert.ok(!sent.at(-1)!.text.includes('rm -rf build'), 'nothing read off the screen is quoted');
  p.emit({ kind: 'result', text: 'done in the dark', isError: false });
  await until(() => p.events.includes('stop'));
  assert.equal(o.map.list('telegram:1').find((x) => x.id === oldId)!.background_since, undefined);
  assert.ok(!o.tuiPanes().keep.has('pane-old'));
  assert.ok(!sent.some((s) => s.text.includes('done in the dark')), 'its answer is not posted');
});

test('/resume of a background session reads its turn again, and its answer arrives in the chat', async (t) => {
  const w = world();
  const { o, sent } = orch(w.cfg); t.after(() => o.shutdown());
  const p = fakePane('pane-old');
  const oldId = o.map.startNew('telegram:1', 'the old work').id;
  (o as unknown as { brains: Map<string, unknown> }).brains.set('telegram:1', p.brain);
  const running = (o as unknown as { queue: { enqueue(k: string, j: () => Promise<void>): Promise<void> } }).queue.enqueue('telegram:1', async () => { for await (const _ of p.brain.turn()) { /* read */ } });
  await until(() => p.events.includes('turn'));
  await o.handoff({ cwd: w.own, session: SESSION, summary: 'New direction' });
  await running;
  const resumed = o.handle(dm('1', '/resume 2'));
  await until(() => p.events.includes('follow'));
  assert.match(sent.at(-1)!.text, new RegExp(`^Resumed ${oldId.slice(0, 8)} · the old work\\. Its turn is still running; the answer comes here\\.$`));
  p.emit({ kind: 'result', text: 'the old answer', isError: false });
  await resumed;
  assert.equal(sent.at(-1)!.text, 'the old answer');
  assert.ok(!p.events.includes('stop'));
  assert.equal(o.map.getActive('telegram:1')!.id, oldId);
  assert.equal(o.map.getActive('telegram:1')!.background_since, undefined);
});

test('after a restart, a background mark whose pane cannot be taken back is dropped', async (t) => {
  const w = world();
  const { o, log } = orch(w.cfg); t.after(() => o.shutdown());
  const id = o.map.startNew('telegram:1', 'x').id;
  o.map.setBackground('telegram:1', id, new Date());
  await o.restoreBackground(); // print mode: nothing outlives the daemon
  assert.equal(o.map.background().length, 0);
  assert.ok(!log.some((l) => l.includes('background restored')));
});

test('compile installs the skill in the user\'s skills folder, marked, and leaves a stranger\'s file alone', () => {
  const home = tmp('angelia-ho-home-');
  const src = join(home, 'src.md');
  writeFileSync(src, '---\nname: angelia-handoff\n---\n\nBody.\n');
  const first = planHandoffSkill(home, src);
  assert.match(first.change!, /^\+ .*\.claude\/skills\/angelia-handoff\/SKILL\.md/);
  first.apply();
  const at = join(home, '.claude', 'skills', 'angelia-handoff', 'SKILL.md');
  assert.match(readFileSync(at, 'utf8'), /^---\nname: angelia-handoff\n---\n<!-- Written by angelia compile/);
  assert.deepEqual(planHandoffSkill(home, src).change, undefined, 'nothing to do the second time');
  writeFileSync(src, '---\nname: angelia-handoff\n---\n\nBody, newer.\n');
  assert.match(planHandoffSkill(home, src).change!, /^~ /);
  writeFileSync(at, 'my own skill');
  assert.match(planHandoffSkill(home, src).conflict!, /not Angelia's/);
});

test('the shipped skill only runs when typed, and the CLI refuses inside a chat\'s agent', async () => {
  const skill = readFileSync(join(here, '..', 'capabilities', 'builtin', 'angelia-handoff', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: angelia-handoff\n[\s\S]*disable-model-invocation: true\n/);
  await assert.rejects(handoffCommand(['--where'], { ANGELIA_API_TOKEN: 'x' }), /from a terminal session, not from a chat's agent/);
});

test('angelia handoff --where says the mode, the profile and the chat', async () => {
  const w = world();
  const table = join(w.master, 'routing.yaml');
  writeFileSync(table, JSON.stringify(w.cfg)); // JSON is YAML
  const env = { ANGELIA_CONFIG: table };
  assert.equal(await handoffCommand(['--where', '--cwd', w.own], env),
    'mode: session\nprofile: a (this folder is its own)\nchat: telegram:1\nThe session itself moves to that chat. Write one summary line.');
  assert.match(await handoffCommand(['--where', '--cwd', w.elsewhere], env), /^mode: brief\nprofile: m \(the handoff profile for other folders \(defaults\.handoff\)\)\nchat: telegram:2\n/);
});

test('api: /handoff takes the owner\'s token only, and says what is wrong in words', async (t) => {
  const { request } = await import('node:http');
  const { API_SOCKET, ApiServer, claimSocket, loadOrMintToken, sessionToken } = await import('../src/daemon/api/server.js');
  const w = world();
  const { o } = orch(w.cfg); t.after(() => o.shutdown());
  const dir = tmp('angelia-ho-api-');
  const token = loadOrMintToken(join(dir, 'api.token'));
  const api = new ApiServer({ send: (k, x) => o.notify(k, x), turn: (k, x, a) => o.injectTurn(k, x, a), sendMedia: (k, m) => o.sendMediaTo(k, m), routed: (k) => o.routed(k), handoff: (r) => o.handoff(r) }, token);
  const socket = join(dir, API_SOCKET);
  await claimSocket(socket);
  await api.listen(socket); t.after(() => api.close());
  const call = (body: unknown) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ socketPath: socket, path: '/handoff', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  const agent = await call({ token: sessionToken(token, 'telegram:1'), key: 'telegram:1', cwd: w.own, session: SESSION, summary: 'x' });
  assert.equal(agent.status, 403, 'a chat\'s agent cannot move sessions around');
  const bad = await call({ token, cwd: w.elsewhere, summary: 'x' });
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error), /a brief is needed/);
  const ok = await call({ token, cwd: w.own, session: SESSION, summary: 'Moving on' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.mode, 'session');
  assert.equal(o.map.getActive('telegram:1')!.id, SESSION);
});

test('defaults.handoff may name a chat: its profile catches the rest, and that chat is picked without asking', () => {
  const w = world({ chats: 2 });
  const cfg = Config.parse({ ...w.cfg, defaults: { ...w.cfg.defaults, handoff: 'whatsapp:g@g.us' } });
  const t = handoffTarget(cfg, w.elsewhere);
  assert.equal(t.profile, 'a');
  assert.equal(t.via, 'default');
  assert.equal(pickChat(t), 'whatsapp:g@g.us');
  assert.equal(pickChat(t, '1'), 'telegram:1', 'a number still picks');
  // In a's own folder the handoff chat is the default pick too.
  assert.equal(pickChat(handoffTarget(cfg, w.own)), 'whatsapp:g@g.us');
  // The tie over `code` goes to the profile behind the chat.
  assert.equal(handoffTarget(cfg, w.code).profile, 'a');
});

test('the table refuses a handoff default it cannot resolve', async () => {
  const { loadConfig } = await import('../src/instance/config/load.js');
  const w = world();
  const table = join(w.master, 'bad.yaml');
  for (const [v, why] of [['nosuch', /defaults\.handoff: profile "nosuch", which the routing table does not have/], ['whatsapp:nobody@g.us', /defaults\.handoff: chat whatsapp:nobody@g\.us, which no route has/]] as const) {
    writeFileSync(table, JSON.stringify({ ...w.cfg, defaults: { ...w.cfg.defaults, handoff: v } }));
    assert.throws(() => loadConfig(table), why);
  }
});
