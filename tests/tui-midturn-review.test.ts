import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boxHoldsOnly, paneMidTurn } from '../src/brain/tmux.js';

import { hookSettings } from '../src/brain/tui.js';
import { ROW, stubChat, until, wait } from './tui-stub.js';

// The review of midturn (2026-11-25): each test names the finding it covers. Own state dir and socket
// before the brain modules load; the panes are stubs (tui-stub.ts).
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-midturn-review-'));
process.env.ANGELIA_TMUX_SOCKET = `angelia-test-midturn-review-${process.pid}`;

const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = (name: string): string => readFileSync(join(here, 'fixtures', `pane-${name}.txt`), 'utf8');
const PRETOOL = join(here, '..', 'scripts', 'tui-pretool-hook.mjs');
const working = (p: { rows: (...r: object[]) => void; prompt: () => object; show: (s: 'busy') => void }) => { p.rows(p.prompt(), ROW.call('t1')); p.show('busy'); };
/** One assistant message with two tool calls (a batch): the second's PreToolUse runs only once the first ends. */
const batch = { type: 'assistant', message: { role: 'assistant', content: [
  { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'sleep 25' } },
  { type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'ls -la /tmp' } },
] } };

/** Run the PreToolUse hook as Claude Code does; resolves with how long it took. */
const runHook = (marker: string): Promise<number> => new Promise((done) => {
  const t0 = Date.now();
  const p = execFile(process.execPath, [PRETOOL], { env: { ...process.env, ANGELIA_TUI_MARKER: marker } }, () => done(Date.now() - t0));
  p.stdin?.on('error', () => {});
  p.stdin?.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }));
});

test('H1: the PreToolUse hook holds a tool call while the absorb lock is there, and says when it ended', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-pretool-'));
  const marker = join(dir, 'turn.json');
  // No lock: at once, and the mark of when it ended is written; its own in-flight mark is gone.
  assert.ok(await runHook(marker) < 3000);
  const last = JSON.parse(readFileSync(join(dir, 'pretool', 'last.json'), 'utf8')).at;
  assert.ok(Date.now() - last < 5000);
  // A fresh lock: the hook waits, with its in-flight mark there, until the lock goes.
  writeFileSync(join(dir, 'absorb.lock'), '1');
  const running = runHook(marker);
  await until(() => { try { return readdirIn(join(dir, 'pretool')).some((n) => n.endsWith('.in')); } catch { return false; } }, 3000);
  await wait(600);
  rmSync(join(dir, 'absorb.lock'));
  const took = await running;
  assert.ok(took >= 600, `held while the lock was there (${took} ms)`);
  assert.equal(readdirIn(join(dir, 'pretool')).some((n) => n.endsWith('.in')), false, 'its mark is gone');
  // A lock left by a daemon that died (old): it holds nothing.
  writeFileSync(join(dir, 'absorb.lock'), '1');
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(join(dir, 'absorb.lock'), old, old);
  assert.ok(await runHook(marker) < 3000);
  // Outside an Angelia session: nothing at all.
  const none = mkdtempSync(join(tmpdir(), 'angelia-pretool-none-'));
  await new Promise<void>((done) => { const p = execFile(process.execPath, [PRETOOL], { env: { ...process.env, ANGELIA_TUI_MARKER: '' }, cwd: none }, () => done()); p.stdin?.on('error', () => {}); p.stdin?.end('{}'); });
});

function readdirIn(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

test('H1: the tmux settings carry the PreToolUse hook only where midturn is on', () => {
  const on = hookSettings('/h/stop.mjs', '/h/perm.mjs', '/h/pre.mjs') as { hooks: Record<string, { hooks: { command: string; timeout: number }[] }[]> };
  assert.deepEqual(Object.keys(on.hooks).sort(), ['PermissionRequest', 'PreToolUse', 'Stop']);
  assert.match(on.hooks.PreToolUse[0].hooks[0].command, /pre\.mjs/);
  assert.ok(on.hooks.PreToolUse[0].hooks[0].timeout > 15, 'past the hook\'s own longest wait');
  const off = hookSettings('/h/stop.mjs', '/h/perm.mjs') as { hooks: Record<string, unknown> };
  assert.deepEqual(Object.keys(off.hooks).sort(), ['PermissionRequest', 'Stop']);
});

test('L3: right before Enter the box must hold our text alone, on the busy screen with its prompt', () => {
  const busy = fixture('busy-box-332');
  const chip = busy.replace(/^❯\s*$/m, '❯ [Pasted text #1 +3 lines]');
  assert.equal(paneMidTurn(chip, 'any\nmessage\nhere\nnow'), true);
  assert.equal(paneMidTurn(busy.replace(/^❯\s*$/m, '❯ hello there'), 'hello there'), true);
  // Someone's text before ours, or ours with more after it: no.
  assert.equal(paneMidTurn(busy.replace(/^❯\s*$/m, '❯ wait hello there'), 'hello there'), false);
  assert.equal(paneMidTurn(fixture('busy-halftyped-332'), 'hello'), false);
  // A dialog, or no turn at work: no.
  assert.equal(paneMidTurn(fixture('permission-332'), 'hello'), false);
  assert.equal(paneMidTurn(fixture('idle').replace(/❯\s+Try "refactor <filepath>"/, '❯ hello'), 'hello'), false);
  assert.equal(boxHoldsOnly(busy, 'hello'), false, 'an empty box holds nothing');
});

describe('midturn review fixes, through the real orchestrator with stub panes', { concurrency: true, timeout: 180_000 }, () => {
  test('H1: two calls in one message: while the second call is being checked (its PreToolUse in flight, or just ended) no Enter', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), batch); p.show('busy'); } });
    const first = c.say('run both');
    await until(() => c.pane()?.enters === 1);
    const b = c.brain();
    const pre = join(b.dir, 'pretool');
    // The second call's PreToolUse hook runs now (the first call ended a moment ago).
    writeFileSync(join(pre, `${process.pid}.in`), '1');
    const second = c.say('one more thing');
    await wait(900);
    const p = c.pane();
    assert.equal(p.queued.length, 0, 'not while a PreToolUse hook runs');
    // It ended just now: its PermissionRequest may come; still no Enter within the settle time.
    rmSync(join(pre, `${process.pid}.in`));
    writeFileSync(join(pre, 'last.json'), JSON.stringify({ at: Date.now() + 400 }));
    await wait(300);
    assert.equal(p.queued.length, 0, 'not right after a PreToolUse ended');
    await until(() => p.queued.length === 1);
    await second;
    assert.deepEqual(p.lockedAtEnter, [true]);
    p.rows(ROW.queuedPrompt(p.queued[0]), ROW.result('b1'), ROW.result('b2'), ROW.text('Both done.'));
    p.show('idle');
    p.stop('Both done.');
    await first;
    assert.deepEqual(c.sent, ['Both done.']);
  });

  test('H1: a session with no PreToolUse mark since the turn began (started before the hook) is never typed into', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => {
      if (n === 1) { p.rows(p.prompt(), ROW.call('t1')); rmSync(join(c.brain().dir, 'pretool'), { recursive: true, force: true }); p.show('busy'); }
      if (n === 2) { p.rows(p.prompt(), ROW.text('Second.')); p.stop('Second.'); }
    });
    const first = c.say('first');
    await until(() => c.pane()?.enters === 1);
    const second = c.say('second');
    await wait(900);
    assert.equal(c.pane().queued.length, 0);
    c.pane().rows(ROW.result('t1'), ROW.text('First.'));
    c.pane().show('idle');
    c.pane().stop('First.');
    await first; await second;
    assert.deepEqual(c.sent, ['First.', 'Second.']);
  });

  test('H1 (b): a call that asks the person by itself (a question, a plan, an MCP tool) holds the message back', { timeout: 45_000 }, async (t) => {
    for (const name of ['AskUserQuestion', 'ExitPlanMode', 'mcp__drive__search']) {
      const c = await stubChat(); t.after(() => c.o.shutdown());
      const call = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'q1', name, input: {} }] } };
      c.onEnter((n, p) => {
        if (n === 1) { p.rows(p.prompt(), call); p.show('busy'); }
        if (n === 2) { p.rows(p.prompt(), ROW.text('Second.')); p.stop('Second.'); }
      });
      const first = c.say('first');
      await until(() => c.pane()?.enters === 1);
      const second = c.say('second');
      await wait(700);
      assert.equal(c.pane().queued.length, 0, name);
      c.pane().rows({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 'q1', type: 'tool_result', content: 'ok' }] } }, ROW.text('First.'));
      c.pane().show('idle');
      c.pane().stop('First.');
      await first; await second;
      assert.deepEqual(c.sent, ['First.', 'Second.'], name);
    }
  });

  test('M1: /stop while a message waits for its moment drops it, and the reply counts it', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), ROW.call('t1')); p.show('dialog'); } });
    const first = c.say('first');
    await until(() => c.pane()?.enters === 1);
    const second = c.say('second');
    await wait(300);
    await c.say('/stop');
    await first; await second;
    await wait(300);
    assert.deepEqual(c.sent, ['Stopped. 1 waiting message dropped.']);
    assert.equal(c.pane().enters, 1, 'it never ran');
  });

  test('M1: /new while a message waits drops it too', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), ROW.call('t1')); p.show('dialog'); } });
    const first = c.say('first');
    await until(() => c.pane()?.enters === 1);
    const second = c.say('second');
    await wait(300);
    await c.say('/new');
    await first; await second;
    await wait(300);
    assert.equal(c.sent.length, 1);
    assert.match(c.sent[0], / 1 waiting message dropped\.$/);
    assert.equal(c.pane().enters, 1);
  });

  test('M2: at shutdown a waiting message is dropped and logged, never typed', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), ROW.call('t1')); p.show('dialog'); } });
    const first = c.say('first');
    await until(() => c.pane()?.enters === 1);
    const second = c.say('second');
    await wait(300);
    await c.o.shutdown();
    await Promise.race([Promise.all([first, second]), wait(3000)]);
    await wait(300);
    assert.equal(c.pane().enters, 1);
    assert.equal(c.pane().buffers.length, 1, 'nothing more was pasted');
    assert.ok(c.log.some((l) => /shutdown: 1 waiting turn dropped key=telegram:1|shutdown: a message waiting for the running turn dropped|restart: a message waiting for the running turn goes to the next daemon/.test(l)), c.log.join('\n'));
  });

  test('M3: the turn Claude Code runs for an untaken message relays its permission request to the chat', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    await c.say('two');
    const p = c.pane();
    p.rows(ROW.result('t1'), ROW.text('First.'));
    p.stop('First.'); p.rows(ROW.over());
    await until(() => c.sent.length === 1);
    // The second runs as its own turn and asks for a permission through the hook.
    p.rows(ROW.prompt(p.queued[0]), ROW.call('t9'));
    const b = c.brain();
    mkdirSync(join(b.dir, 'permissions'), { recursive: true });
    writeFileSync(join(b.dir, 'permissions', '11111111-2222-3333-4444-555555555555.request.json'), JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, at: Date.now() }));
    await until(() => c.sent.length === 2);
    assert.match(c.sent[1], /Bash: .*rm -rf build[\s\S]*Reply "yes" or "no"/, 'the chat is asked, as in any turn of its own');
    rmSync(join(b.dir, 'permissions', '11111111-2222-3333-4444-555555555555.request.json'));
    p.rows(ROW.result('t9'), ROW.text('Second.'));
    p.show('idle');
    p.stop('Second.');
    await first;
    assert.equal(c.sent[c.sent.length - 1], 'Second.');
  });

  test('L1: two untaken messages that Claude Code runs as one turn (joined) get its one answer', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    await Promise.all([c.say('four'), c.say('six')]);
    const p = c.pane();
    assert.equal(p.queued.length, 2);
    p.rows(ROW.result('t1'), ROW.text('First.'));
    p.stop('First.'); p.rows(ROW.over());
    await until(() => c.sent.length === 1);
    p.rows(ROW.prompt(`${p.queued[0]}\n\n${p.queued[1]}`), ROW.text('Four and six.'));
    p.show('idle');
    p.stop('Four and six.');
    await first;
    assert.deepEqual(c.sent, ['First.', 'Four and six.']);
    assert.ok(!c.log.some((l) => /prompt key miss/.test(l)), 'not dropped as someone else\'s prompt');
  });

  test('L1: the reader between turns also takes a joined marker as the chat\'s (no reader came)', { timeout: 30_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    await Promise.all([c.say('four'), c.say('six')]);
    const b = c.brain();
    const p = c.pane();
    // The reader for the next turn is not there (as when it gives up): the marker is read between turns.
    b.followAbsorbed = undefined;
    p.rows(ROW.result('t1'), ROW.text('First.'));
    p.stop('First.'); p.rows(ROW.over());
    await first;
    await wait(5300); // the wait for a reader (FOLLOW_WAIT_MS) passes
    p.rows(ROW.prompt(`${p.queued[0]}\n\n${p.queued[1]}`), ROW.text('Four and six.'));
    p.show('idle');
    p.stop('Four and six.');
    await until(() => c.sent.length === 2, 4000);
    assert.equal(c.sent[1], 'Four and six.');
    assert.ok(c.log.some((l) => /mid-turn answer delivered/.test(l)));
  });

  test('L2: a turn that fails after it took a message: the message is queued as its own turn', { timeout: 40_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => {
      if (n === 1) { p.rows(p.prompt(), ROW.text('Zero.')); p.stop('Zero.'); }
      if (n === 2) working(p);
      // A fresh pane after the first died: the message typed into the dead turn runs as its own.
      if (n === 3) { p.rows(p.prompt(), ROW.text('Answer to two.')); p.stop('Answer to two.'); }
    });
    // A first turn that went well: the session is started, so a failure is not retried in a fresh one.
    await c.say('zero');
    const first = c.say('one');
    await until(() => c.pane()?.enters === 2);
    await wait(150);
    await c.say('two');
    const p = c.pane();
    assert.equal(p.queued.length, 1);
    p.rows(ROW.queuedPrompt(p.queued[0]));
    await wait(800);
    p.die();
    await first;
    await until(() => c.sent.includes('Answer to two.'), 8000);
    assert.ok(c.log.some((l) => /midturn: a message typed into a failed turn is queued as its own/.test(l)));
    assert.match(c.pane().typed, /two/);
  });

  test('M4: a turn that is not the chat\'s own (a job, `angelia turn`) takes no chat message', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => {
      if (n === 1) working(p);
      if (n === 2) { p.rows(p.prompt(), ROW.text('Chat answer.')); p.stop('Chat answer.'); }
    });
    const job = c.o.injectTurn(c.key, 'the scheduled job');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    const msg = c.say('a chat message');
    await wait(700);
    assert.equal(c.pane().queued.length, 0, 'not typed into the job\'s turn');
    c.pane().rows(ROW.result('t1'), ROW.text('[SILENT]'));
    c.pane().show('idle');
    c.pane().stop('[SILENT]');
    await job; await msg;
    assert.deepEqual(c.sent, ['Chat answer.']);
  });

  test('L4: a turn injected while a chat message waits for its moment comes after that message', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    const order: string[] = [];
    c.onEnter((n, p) => {
      order.push(p.typed.includes('chat two') ? 'chat' : p.typed.includes('the job') ? 'job' : 'first');
      if (n === 1) { p.rows(p.prompt(), ROW.call('t1')); p.show('dialog'); }
      if (n > 1) { p.rows(p.prompt(), ROW.text(`Answer ${n}.`)); p.stop(`Answer ${n}.`); }
    });
    const first = c.say('first');
    await until(() => c.pane()?.enters === 1);
    const two = c.say('chat two');
    await wait(200);
    const job = c.o.injectTurn(c.key, 'the job');
    await wait(300);
    c.pane().rows(ROW.result('t1'), ROW.text('First.'));
    c.pane().show('idle');
    c.pane().stop('First.');
    await first; await two; await job;
    assert.deepEqual(order, ['first', 'chat', 'job']);
  });

  test('L5: an untaken message nobody answered is forgotten at the next turn: the same words later are a turn of their own', { timeout: 40_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => {
      if (n === 1) working(p);
      if (n === 2) { p.rows(p.prompt(), ROW.text('Two.')); p.stop('Two.'); }
    });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    await c.say('again');
    const b = c.brain();
    b.followAbsorbed = undefined;
    c.pane().rows(ROW.result('t1'), ROW.text('First.'));
    c.pane().show('idle');
    c.pane().stop('First.');
    await first;
    await c.say('next');
    assert.equal(b.absorbed.length, 0, 'nothing is waited for after the next turn of Angelia\'s');
  });

  test('L6: a message typed into the turn is a `turn` event that names the turn it went into, and ends with it', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    const events: { type: string; turn?: string; into?: string; ok?: boolean }[] = [];
    c.o.onEvent((e) => { if (e.type === 'turn' || e.type === 'turn-end') events.push(e as never); });
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    await c.say('two');
    const p = c.pane();
    p.rows(ROW.queuedPrompt(p.queued[0]), ROW.result('t1'), ROW.text('Both.'));
    p.show('idle');
    p.stop('Both.');
    await first;
    const [host, joined] = events.filter((e) => e.type === 'turn');
    assert.equal(joined.into, host.turn);
    const ends = new Map(events.filter((e) => e.type === 'turn-end').map((e) => [e.turn, e.ok]));
    assert.equal(ends.size, 2);
    assert.equal(ends.get(host.turn), true);
    assert.equal(ends.get(joined.turn), true);
  });
});

