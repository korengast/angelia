import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Inbound } from '../src/core/types.js';

// The last review of restart adoption (fix-final-043): a tmux that does not answer, a second stop
// before the first adopted turn ran, what waits behind a turn at the stop, a message that comes as the
// daemon stops, the heartbeats of the state folder this daemon runs on, and a deferred restart that
// waits for the asking chat's queue. Its own state folder, set before the first import.
const here = dirname(fileURLToPath(import.meta.url));
const state = mkdtempSync(join(tmpdir(), 'angelia-rf-'));
process.env.ANGELIA_STATE_DIR = state;
process.env.ANGELIA_TMUX_SOCKET = `angelia-test-restart-final-${process.pid}`;

const { Config } = await import('../src/instance/config/schema.js');
const { Orchestrator } = await import('../src/core/orchestrator.js');
const { ADOPT_TURNS, CUT_TURNS, writeAdoptTurns } = await import('../src/core/cut-turns.js');
const { DeferredRestart } = await import('../src/daemon/deferred-restart.js');
const { tmux } = await import('../src/brain/tmux.js');
const { TMUX_STALLED_LINE } = await import('../src/core/deliver/text.js');
const { takeAdoptTurns, takeCutTurns } = await import('../src/core/cut-turns.js');
const { ROW, stubChat, until, wait } = await import('./tui-stub.js');

const KEY = 'whatsapp:g@g.us';
const msg = (text: string, extra: Partial<Inbound> = {}): Inbound => ({ platform: 'whatsapp', chat: 'g@g.us', sender: 'boss', senderName: 'boss', text, isGroup: true, mentioned: true, media: [], ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rig(stateDir = state) {
  const cfg = Config.parse({
    profiles: { a: { cwd: mkdtempSync(join(tmpdir(), 'angelia-rf-cwd-')), tui: true } },
    routes: [{ platform: 'whatsapp', chat: 'g@g.us', profile: 'a', mention: 'any', owners: ['boss'], allow_from: ['*'] }],
    defaults: { max_out_per_min: 1000 },
  });
  const sent: string[] = [];
  const logs: string[] = [];
  const o = new Orchestrator(cfg, { whatsapp: { send: async (_c: string, text: string) => { sent.push(text); } } }, {
    stateDir, bins: { 'claude-code': join(here, 'fake-tui.sh') }, log: (l) => logs.push(l), adoptTimeoutMs: 300,
  });
  const row = (o as any).map.ensureActive(KEY, 'x', 'claude-code');
  return { o: o as any, sent, logs, row };
}

/** adoptTurn, on either line: the brain pool's (dev) or the orchestrator's own (release). */
function stubAdopt(o: any, fn: (...a: unknown[]) => Promise<unknown>) {
  if (o.pool) o.pool.adoptTurn = fn; else o.adoptTurn = fn;
}

/** A brain that adopts at once and holds the pane by name, with nothing to read. */
function fakeBrain() {
  const b = {
    name: 'angelia-rf-pane', alive: true, turnSentAt: Date.now(), released: 0,
    follow: () => (async function* () { /* nothing */ })(), restoreMidturn: () => {}, midturnState: () => [],
    hasPendingPermission: () => false, answerPermission: () => false,
    release: async () => { b.released++; b.alive = false; },
  };
  return b;
}

/** makeBrain gives a brain whose adoption (its tmux call) waits for `finish`. */
function slowAdopt(o: any) {
  const ctl = { finish: (_ok: boolean) => {}, made: 0 };
  o.makeBrain = () => {
    ctl.made++;
    const b = { ...fakeBrain(), alive: false, adopt: () => new Promise<boolean>((r) => { ctl.finish = r; }) };
    return b;
  };
  return ctl;
}

test('a tmux that does not answer: the adoption gives up within its time, the chat gets the cut line, and a late one leaves a newer brain alone', async () => {
  const { o, logs } = rig();
  const ctl = slowAdopt(o);
  writeAdoptTurns(state, [{ key: KEY, session: o.map.getActive(KEY).id, since: Date.now(), inbound: msg('a long one') }]);
  const t0 = Date.now();
  assert.deepEqual(await o.restoreTurns(), [KEY]);
  assert.ok(Date.now() - t0 < 2000, 'the start was not held');
  assert.ok(logs.some((l) => /tmux did not answer within/.test(l)));
  // A message made a brain since; then tmux answers after all: the newer brain stays, the late one is not used.
  const newer = fakeBrain();
  o.brains.set(KEY, newer);
  ctl.finish(true);
  await sleep(50);
  assert.equal(o.brains.get(KEY), newer);
  assert.equal(newer.released, 0);
  assert.ok(logs.some((l) => /finished late is not used/.test(l)));
  o.brains.delete(KEY);
  await o.shutdown();
});

test('a stop while the turns are being taken back: the file is written again with those not adopted yet', async () => {
  const { o } = rig();
  const ctl = slowAdopt(o);
  writeAdoptTurns(state, [{ key: KEY, session: o.map.getActive(KEY).id, since: 77, inbound: msg('the turn'), waiting: [{ inbound: msg('behind it'), bare: false }] }]);
  const restoring = o.restoreTurns();
  await sleep(50);
  assert.ok(!existsSync(join(state, ADOPT_TURNS)), 'taken');
  // The start's own SIGTERM handler (daemon.ts, earlyStop) calls cutTurns.
  o.cutTurns();
  const t = JSON.parse(readFileSync(join(state, ADOPT_TURNS), 'utf8')).turns[0];
  assert.equal(t.key, KEY);
  assert.equal(t.since, 77);
  assert.deepEqual(t.waiting.map((w: { inbound: Inbound }) => w.inbound.text), ['behind it']);
  ctl.finish(false);
  await restoring;
  await o.shutdown();
});

test('a stop while starting: the chats owed the cut line go into the new cut list beside the stop\'s own', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-rf-owed-'));
  const { o } = rig(dir);
  const ctl = slowAdopt(o);
  writeAdoptTurns(dir, [{ key: KEY, session: o.map.getActive(KEY).id, since: 1, inbound: msg('the turn') }]);
  const restoring = o.restoreTurns(() => {}, []);
  await sleep(50);
  // The last shutdown's cut list (taken by the daemon at its start), and a turn already found lost.
  o.cutTurns(['telegram:7', 'telegram:8', 'telegram:7']);
  assert.deepEqual(takeCutTurns(dir), ['telegram:7', 'telegram:8']);
  assert.equal(takeAdoptTurns(dir)[0].key, KEY, 'the turn not adopted yet is written back for the next daemon');
  ctl.finish(false);
  await restoring;
  await o.shutdown();
});

test('the daemon has a stop handler before it takes the turns back, and swaps it for the full one after', () => {
  const src = readFileSync(join(here, '..', 'src', 'daemon', 'daemon.ts'), 'utf8');
  const early = src.indexOf("process.on('SIGTERM', earlyTerm)"), restore = src.indexOf('await orch.restoreTurns('), full = src.indexOf("process.on('SIGTERM', () => void shutdown('SIGTERM'))");
  assert.ok(early > 0 && restore > early && full > restore, 'early handler, restore, full handler, in that order');
  assert.ok(src.indexOf("process.off('SIGTERM', earlyTerm)") > restore);
  assert.match(src.slice(src.indexOf('const earlyStop'), early), /orch\.cutTurns\(owedCut\(\)\)[\s\S]*process\.exit\(0\)/);
  // The old cut list is taken before the early handler, and told from the same list it writes back.
  assert.ok(src.indexOf('const cutBefore = takeCutTurns(STATE_DIR)') > 0 && src.indexOf('const cutBefore = takeCutTurns(STATE_DIR)') < early);
  assert.equal(src.split('takeCutTurns(').length, 2, 'taken once');
});

test('a permission answer that comes as the daemon stops is not carried as a chat message', async () => {
  const { o, logs } = rig();
  const b = fakeBrain();
  stubAdopt(o, async () => { o.brains.set(KEY, b); return b; });
  writeAdoptTurns(state, [{ key: KEY, session: o.map.getActive(KEY).id, since: 1, inbound: msg('the turn') }]);
  assert.deepEqual(await o.restoreTurns(() => {}), []);
  // The chat has a request open: a yes or no answered it, and the next daemon asks again.
  o.asks.set(KEY, new Map([['1a2b3c4d-0000', { id: '1a2b3c4d-0000', tool: 'Bash', preview: 'ls', at: new Date().toISOString() }]]));
  (b as any).hasPendingPermission = (id: string) => id === '1a2b3c4d-0000';
  o.cutTurns();
  await o.handle(msg('yes 1a2b3c4d'));
  await o.handle(msg('no'));
  await o.handle(msg('a real message'));
  // None open: a bare "yes" is the chat's answer to the agent's own question, carried like any message.
  o.asks.delete(KEY);
  await o.handle(msg('yes'));
  const t = JSON.parse(readFileSync(join(state, ADOPT_TURNS), 'utf8')).turns[0];
  assert.deepEqual(t.waiting.map((w: { inbound: Inbound }) => w.inbound.text), ['a real message', 'yes']);
  assert.equal(logs.filter((l) => /permission answer that came as the daemon stops is not carried/.test(l)).length, 2);
  await o.shutdown();
});

test('a message for an idle chat while the stop settles: held until the cut, then it goes as one that came at the stop, never typed', { timeout: 45_000 }, async () => {
  const one = await stubChat({}, {}, {}, {});
  one.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), ROW.text('Hi.')); p.stop('Hi.'); } });
  await one.say('hello');
  const o = one.o as any;
  // Another chat's pane is between an Enter and Claude Code's word: the stop waits for it (stopAbsorbing).
  let settle!: () => void;
  const other = { alive: true, stopAbsorbing: () => new Promise<void>((r) => { settle = r; }) };
  o.brains.set('telegram:2', other);
  const stopping = o.beforeStop();
  await wait(50);
  assert.equal(o.cutDone, false, 'the cut is not made yet');
  const late = one.say('are you there?');
  await wait(400);
  assert.equal(one.pane().enters, 1, 'not typed while the stop settles');
  settle();
  await stopping;
  await late;
  o.brains.delete('telegram:2');
  assert.equal(one.pane().enters, 1, 'not typed after the cut either');
  assert.ok(one.log.some((l) => l === `shutdown: a message that came as the daemon stops is not run; its chat is told by the next daemon key=${one.key}`), one.log.join('\n'));
  assert.ok(JSON.parse(readFileSync(join(one.stateDir, CUT_TURNS), 'utf8')).keys.includes(one.key), 'the next daemon tells the chat');
  assert.deepEqual(one.sent, ['Hi.']);
  await one.o.shutdown();
});

test('a tmux call that timed out is told apart, and the reader polls again instead of ending a live turn', { timeout: 45_000 }, async () => {
  const one = await stubChat();
  one.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), ROW.call('t1')); p.show('busy'); } });
  const turn = one.say('one');
  await until(() => one.pane()?.enters === 1);
  const b = one.brain();
  // Once the turn's reader runs (its heartbeat), not while the Enter is checked.
  await until(() => !!b.beating, 10_000);
  await wait(800);
  const real = b.capture.bind(b);
  // Two in a row (each a TMUX_TIMEOUT_MS of 30 s in real life): fewer than TMUX_STALLS.
  let slow = 2;
  b.capture = async (l?: number) => { if (slow > 0) { slow--; b.captureTimedOut = true; return ''; } b.captureTimedOut = false; return real(l); };
  // tmux answers nothing in time meanwhile, has-session neither: taken for a dead pane, the turn would end.
  const tm = b.tm.bind(b);
  b.tm = async (a: string[]) => (a[0] === 'has-session' && slow > 0 ? { code: 1, out: '', err: '', timedOut: true } : tm(a));
  await until(() => slow === 0, 10_000);
  one.pane().rows(ROW.result('t1'), ROW.text('Done.'));
  one.pane().stop('Done.');
  await turn;
  assert.deepEqual(one.sent, ['Done.']);
  assert.ok(b.up !== false, 'not taken for a pane that died');
  await one.o.shutdown();
});

test('three tmux calls in a row that time out: the reader gives up with a clear line, the pane is kept, and the answer still comes, late', { timeout: 45_000 }, async () => {
  const one = await stubChat();
  one.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), ROW.call('t1')); p.show('busy'); } });
  const turn = one.say('one');
  await until(() => one.pane()?.enters === 1);
  const b = one.brain();
  await until(() => !!b.beating, 10_000);
  await wait(800);
  const real = b.capture.bind(b);
  let slow = true;
  b.capture = async (l?: number) => { if (slow) { b.captureTimedOut = true; return ''; } b.captureTimedOut = false; return real(l); };
  const tm = b.tm.bind(b);
  b.tm = async (a: string[]) => (a[0] === 'has-session' && slow ? { code: 1, out: '', err: '', timedOut: true } : tm(a));
  await turn;
  assert.deepEqual(one.sent, [TMUX_STALLED_LINE]);
  assert.ok(one.pane().logs.some((l) => /3 tmux calls in a row timed out; the turn's reader gives up and the pane is kept/.test(l)), one.pane().logs.join('\n'));
  assert.ok(b.up !== false, 'not taken for a pane that died');
  assert.equal(b.turnSentAt, undefined);
  // tmux answers again, and the turn ends: its answer reaches the chat, late.
  slow = false;
  one.pane().rows(ROW.result('t1'), ROW.text('Done.'));
  one.pane().stop('Done.');
  await until(() => one.sent.length === 2, 10_000);
  assert.equal(one.sent[1], 'Done.');
  await one.o.shutdown();
});

test('tmux calls have a time limit: a client that hangs is killed and the call fails', async () => {
  const bin = join(mkdtempSync(join(tmpdir(), 'angelia-rf-bin-')), 'tmux');
  writeFileSync(bin, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const t0 = Date.now();
  const r = await tmux(['has-session', '-t', 'x'], { bin, timeoutMs: 300 });
  assert.notEqual(r.code, 0);
  assert.equal(r.timedOut, true, 'told apart from a pane that is gone');
  assert.ok(Date.now() - t0 < 5000);
  const quick = join(dirname(bin), 'quick');
  writeFileSync(quick, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.equal((await tmux(['has-session', '-t', 'x'], { bin: quick })).timedOut, undefined);
});

test('a request that is over does not swallow a bare yes at the stop', async () => {
  const { o } = rig();
  const b = fakeBrain();
  stubAdopt(o, async () => { o.brains.set(KEY, b); return b; });
  writeAdoptTurns(state, [{ key: KEY, session: o.map.getActive(KEY).id, since: 1, inbound: msg('the turn') }]);
  assert.deepEqual(await o.restoreTurns(() => {}), []);
  o.asks.set(KEY, new Map([['1a2b3c4d-0000', { id: '1a2b3c4d-0000', tool: 'Bash', preview: 'ls', at: new Date().toISOString() }]]));
  (b as any).hasPendingPermission = () => false;
  o.cutTurns();
  await o.handle(msg('yes'));
  assert.deepEqual(JSON.parse(readFileSync(join(state, ADOPT_TURNS), 'utf8')).turns[0].waiting.map((w: { inbound: Inbound }) => w.inbound.text), ['yes']);
  await o.shutdown();
});

test('a second stop before the adopted turn started: it is written back, with what waited and what came after, and nothing that is not a chat message', async () => {
  const { o, logs } = rig();
  const b = fakeBrain();
  stubAdopt(o, async () => { o.brains.set(KEY, b); return b; });
  const session = o.map.getActive(KEY).id;
  writeAdoptTurns(state, [{ key: KEY, session, since: 123, inbound: msg('the turn'), chat: true, waiting: [{ inbound: msg('waited behind it'), bare: false }], joined: [{ i: msg('typed into it'), turn: 't1' }] }]);
  // The platform never comes up before the next stop.
  assert.deepEqual(await o.restoreTurns(() => {}), []);
  // Behind it meanwhile: a chat message, one from the desk app, and an `angelia turn` (no tag).
  void o.handle(msg('came after'));
  void o.queue.enqueue(KEY, async () => {}, { inbound: msg('from the app', { surface: 'app' }), bare: false });
  void o.queue.enqueue(KEY, async () => {});
  await sleep(50);
  o.cutTurns();
  const t = JSON.parse(readFileSync(join(state, ADOPT_TURNS), 'utf8')).turns[0];
  assert.equal(t.key, KEY);
  assert.equal(t.since, 123);
  assert.deepEqual(t.waiting.map((w: { inbound: Inbound }) => w.inbound.text), ['waited behind it', 'came after']);
  assert.deepEqual(t.joined.map((j: { i: Inbound }) => j.i.text), ['typed into it']);
  assert.equal(b.released, 1, 'its pane is let go of, its heartbeat kept');
  assert.ok(logs.some((l) => /1 message\(s\) from the desk app waiting behind the turn not carried/.test(l)));
  assert.ok(logs.some((l) => /1 waiting turn\(s\) that are not chat messages .* dropped/.test(l)));
  // A message that comes before the adapters stop goes along, last.
  await o.handle(msg('just as it stops'));
  const again = JSON.parse(readFileSync(join(state, ADOPT_TURNS), 'utf8')).turns[0];
  assert.deepEqual(again.waiting.map((w: { inbound: Inbound }) => w.inbound.text), ['waited behind it', 'came after', 'just as it stops']);
  assert.ok(logs.some((l) => /came as the daemon stops goes to the next daemon/.test(l)));
  await o.shutdown();
  assert.equal(JSON.parse(readFileSync(join(state, ADOPT_TURNS), 'utf8')).turns.length, 1, 'the second pass in shutdown keeps it');
});

test('the heartbeats a restart clears are those under the state folder this daemon runs on', async () => {
  const other = mkdtempSync(join(tmpdir(), 'angelia-rf-state-'));
  const { o } = rig(other);
  const beat = join(other, 'tui', 'angelia-old-pane', 'permissions', 'relay.json');
  mkdirSync(dirname(beat), { recursive: true });
  writeFileSync(beat, JSON.stringify({ at: Date.now() }));
  await o.restoreTurns();
  assert.ok(!existsSync(beat));
  await o.shutdown();
});

test('a deferred restart waits while the asking chat has turns queued, a while at most', () => {
  let now = 0, queued = 2;
  const launched: string[] = [];
  const d = new DeferredRestart({ running: () => [KEY], queued: () => queued, launch: (k) => launched.push(k), log: () => {}, now: () => now, othersWaitMs: 60_000 });
  assert.equal(d.request(KEY), true);
  d.tick(KEY);
  assert.deepEqual(launched, [], 'its next message runs first');
  queued = 0;
  d.tick();
  assert.deepEqual(launched, [], 'and while it runs');
  // A chat that keeps sending: past the wait it goes anyway.
  queued = 1;
  const e = new DeferredRestart({ running: () => [], queued: () => queued, launch: (k) => launched.push(k), log: () => {}, now: () => now, othersWaitMs: 60_000 });
  const f = new DeferredRestart({ running: () => [KEY], queued: () => queued, launch: (k) => launched.push(k), log: () => {}, now: () => now, othersWaitMs: 60_000 });
  assert.equal(e.request(KEY), false, 'no turn runs there');
  assert.equal(f.request(KEY), true);
  (f as any).h.running = () => [];
  f.tick(KEY);
  assert.deepEqual(launched, []);
  now += 61_000;
  f.tick();
  assert.deepEqual(launched, [KEY]);
});

test('a stop while a message typed into the turn waits for Claude Code\'s word: it goes as typed into the turn, never as waiting too', { timeout: 45_000 }, async () => {
  const one = await stubChat();
  one.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), ROW.call('t1')); p.show('busy'); } });
  void one.say('one');
  await until(() => one.pane()?.enters === 1);
  await wait(150);
  // Claude Code writes that it queued the message a second after the Enter.
  one.pane().slowRow(1200);
  const two = one.say('two');
  await until(() => one.pane().lockedAtEnter.length === 1, 10_000);
  // The Enter is pressed and the word is not in yet: the stop starts here.
  await (one.o as any).beforeStop();
  const kept = JSON.parse(readFileSync(join(one.stateDir, ADOPT_TURNS), 'utf8')).turns[0];
  assert.deepEqual(kept.waiting.map((w: { inbound: Inbound }) => w.inbound.text), [], 'not also waiting: the next daemon would run it again');
  assert.deepEqual(kept.joined.map((j: { i: Inbound }) => j.i.text), ['two']);
  await one.o.shutdown();
  await Promise.race([two, wait(2000)]);
});

test('a stop before a message for the running turn found its moment: it waits held for the cut, and goes as waiting', { timeout: 45_000 }, async () => {
  const one = await stubChat();
  one.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), ROW.call('t1')); p.show('busy'); } });
  void one.say('one');
  await until(() => one.pane()?.enters === 1);
  await wait(150);
  one.pane().show('dialog');
  void one.say('two');
  await until(() => (one.o as any).queue.holding(one.key) === 1);
  await (one.o as any).beforeStop();
  const kept = JSON.parse(readFileSync(join(one.stateDir, ADOPT_TURNS), 'utf8')).turns[0];
  assert.deepEqual(kept.waiting.map((w: { inbound: Inbound }) => w.inbound.text), ['two']);
  assert.ok(!one.pane().buffers.includes('two'), 'never typed here');
  await one.o.shutdown();
});

test('turns to adopt: a typed-in message of another chat is dropped, and each keeps the id of its turn event', () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-rf-joined-'));
  writeAdoptTurns(dir, [{ key: KEY, session: 's', since: 1, inbound: msg('turn'), joined: [{ i: msg('mine'), turn: 'tA' }, { i: { ...msg('theirs'), chat: 'other@g.us' }, turn: 'tB' }] }]);
  const [t] = takeAdoptTurns(dir);
  assert.deepEqual(t.joined!.map((j) => [j.i.text, j.turn, j.i.turnId]), [['mine', 'tA', 'tA']]);
  assert.equal('chat' in t, false);
});

test('a paste into a box that still holds text clears it first', { timeout: 30_000 }, async () => {
  const one = await stubChat();
  one.onEnter((n, p) => { const a = n === 1 ? 'Hi.' : 'Again.'; p.rows(p.prompt(), ROW.text(a)); p.stop(a); });
  await one.say('hello');
  // Text left in the box (a restart cut a paste before its Enter), then the next message.
  one.pane().show('draft');
  await one.say('again');
  assert.ok(one.pane().logs.some((l) => /the input box held text before a paste; cleared/.test(l)), one.pane().logs.join('\n'));
  assert.deepEqual(one.sent, ['Hi.', 'Again.']);
  // A box of two lines: one Ctrl-U clears one line, so it takes two, and the paste goes into an empty box.
  one.pane().show('draft2');
  await one.say('third');
  assert.ok(one.pane().logs.some((l) => l.includes('the input box held text before a paste; cleared: "half of an old message\\nand its second line"')), one.pane().logs.join('\n'));
  assert.match(one.pane().typed, /\n\nthird$/, 'nothing of the old text went with it');
  assert.deepEqual(one.sent, ['Hi.', 'Again.', 'Again.']);
  await one.o.shutdown();
});
