import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { otherPreToolUseHooks } from '../src/brain/tui.js';
import { ROW, stubChat, until, wait } from './tui-stub.js';

// The recheck of midturn (2026-11-25, N1-N10): each test names the finding it covers. Own state dir
// and socket before the brain modules load; the panes are stubs (tui-stub.ts).
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-midturn-recheck-'));
process.env.ANGELIA_TMUX_SOCKET = `angelia-test-midturn-recheck-${process.pid}`;

const here = fileURLToPath(new URL('.', import.meta.url));
const PRETOOL = join(here, '..', 'scripts', 'tui-pretool-hook.mjs');
const PERMISSION = join(here, '..', 'scripts', 'tui-permission-hook.mjs');
const working = (p: { rows: (...r: object[]) => void; prompt: () => object; show: (s: 'busy') => void }) => { p.rows(p.prompt(), ROW.call('t1')); p.show('busy'); };
const ls = (dir: string): string[] => { try { return readdirSync(dir); } catch { return []; } };

test('N2 (a): another PreToolUse hook is found in the merged settings and in an enabled plugin', () => {
  const home = mkdtempSync(join(tmpdir(), 'angelia-hooks-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'angelia-hooks-cwd-'));
  assert.deepEqual(otherPreToolUseHooks(cwd, home), [], 'none anywhere');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  // A Stop hook of the owner's is no PreToolUse hook.
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }));
  assert.deepEqual(otherPreToolUseHooks(cwd, home), []);
  writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'lint' }] }] } }));
  assert.deepEqual(otherPreToolUseHooks(cwd, home), [join(cwd, '.claude', 'settings.local.json')]);
  // A plugin the user settings enable, whose hooks file has one.
  const plugin = join(home, '.claude', 'plugins', 'cache', 'm', 'hookify', '1.0.0');
  mkdirSync(join(plugin, 'hooks'), { recursive: true });
  writeFileSync(join(plugin, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'py' }] }] } }));
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'hookify@m': [{ installPath: plugin }], 'other@m': [{ installPath: '/nowhere' }] } }));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'hookify@m': true, 'other@m': true } }));
  const found = otherPreToolUseHooks(cwd, home);
  assert.equal(found.length, 2);
  assert.match(found[1], /^plugin hookify@m \(/);
  // Turned off in the project's settings: not counted.
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'hookify@m': false } }));
  assert.deepEqual(otherPreToolUseHooks(cwd, home), [join(cwd, '.claude', 'settings.local.json')]);
});

test('N7, N8: the PreToolUse hook reads no stdin (an open stdin does not hold it) and a signal ends it with its mark', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-pretool-sig-'));
  const env = { ...process.env, ANGELIA_TUI_MARKER: join(dir, 'turn.json') };
  // stdin left open: it ends at once all the same.
  const t0 = Date.now();
  await new Promise<void>((done) => { const p = spawn(process.execPath, [PRETOOL], { env, stdio: ['pipe', 'ignore', 'ignore'] }); p.on('exit', () => done()); });
  assert.ok(Date.now() - t0 < 3000, 'not held by an open stdin');
  // Held by the lock, then sent SIGTERM: it ends at once, and its mark is gone.
  writeFileSync(join(dir, 'absorb.lock'), '1');
  const p = spawn(process.execPath, [PRETOOL], { env, stdio: ['ignore', 'ignore', 'ignore'] });
  await until(() => ls(join(dir, 'pretool')).some((n) => n === `${p.pid}.in`), 3000);
  const t1 = Date.now();
  p.kill('SIGTERM');
  await new Promise<void>((done) => p.on('exit', () => done()));
  assert.ok(Date.now() - t1 < 1000, 'the signal ended it at once');
  assert.equal(existsSync(join(dir, 'pretool', `${p.pid}.in`)), false, 'and its mark went with it');
});

test('N2 (b): Angelia\'s PermissionRequest hook marks itself first thing, until it ends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-perm-mark-'));
  mkdirSync(join(dir, 'permissions'), { recursive: true });
  // The chat reads the turn: the hook relays and waits for the answer.
  writeFileSync(join(dir, 'permissions', 'relay.json'), JSON.stringify({ at: Date.now() }));
  const p = execFile(process.execPath, [PERMISSION], { env: { ...process.env, ANGELIA_TUI_MARKER: join(dir, 'turn.json') } });
  p.stdin?.on('error', () => {});
  p.stdin?.end(JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }));
  const ended = new Promise<void>((done) => p.on('exit', () => done()));
  await until(() => ls(join(dir, 'pretool')).includes(`${p.pid}.perm`), 3000);
  await until(() => ls(join(dir, 'permissions')).some((n) => n.endsWith('.request.json')), 3000);
  const id = ls(join(dir, 'permissions')).find((n) => n.endsWith('.request.json'))!.replace('.request.json', '');
  writeFileSync(join(dir, 'permissions', `${id}.answer.json`), JSON.stringify({ allow: false }));
  await ended;
  assert.equal(ls(join(dir, 'pretool')).includes(`${p.pid}.perm`), false, 'the mark goes when the hook ends');
});

test('N3: the PreToolUse hook does not enter the launch fingerprint: an upgrade relaunches no idle pane', async () => {
  const { TuiBrain } = await import('../src/brain/tui.js');
  const cwd = mkdtempSync(join(tmpdir(), 'angelia-fp-'));
  const base = { cwd, permission_mode: 'acceptEdits', add_dirs: [], unsafe_ok: false, shell: false, shell_timeout_seconds: 60, chrome: false, backend: 'claude-code', tui: true };
  const session = { id: '11111111-2222-3333-4444-555555555555', started: true };
  const on = new TuiBrain({ ...base } as never, session) as any;
  const off = new TuiBrain({ ...base, midturn: false } as never, session) as any;
  const closed = new TuiBrain({ ...base } as never, session, { midturn: false }) as any;
  assert.equal(on.fingerprint(true), off.fingerprint(true));
  assert.equal(on.fingerprint(true), closed.fingerprint(true));
  // N8: a session the caller says cannot take messages gets no PreToolUse hook at its launch.
  assert.equal(on.midturn, true);
  assert.equal(closed.midturn, false);
});

describe('midturn recheck fixes, through the real orchestrator with stub panes', { concurrency: true, timeout: 180_000 }, () => {
  /** A chat whose first turn runs a tool behind a dialog, with a chat message waiting for its moment. */
  async function waiting() {
    const c = await stubChat();
    const typed: string[] = [];
    c.onEnter((n, p) => {
      typed.push(p.typed.includes('the job') ? 'job' : p.typed.includes('second') ? 'second' : 'first');
      if (n === 1) { p.rows(p.prompt(), ROW.call('t1')); p.show('dialog'); }
      if (n > 1) { p.rows(p.prompt(), ROW.text(`Answer ${n}.`)); p.stop(`Answer ${n}.`); }
    });
    const first = c.say('first');
    await until(() => c.pane()?.enters === 1);
    const second = c.say('second');
    await wait(200);
    return { c, typed, first, second };
  }

  test('N1: /stop drops a turn injected behind a waiting chat message, and counts it', { timeout: 45_000 }, async (t) => {
    const { c, typed, first, second } = await waiting(); t.after(() => c.o.shutdown());
    const job = c.o.injectTurn(c.key, 'the job');
    await wait(300);
    await c.say('/stop');
    await Promise.all([first, second, job]);
    await wait(800);
    assert.deepEqual(c.sent, ['Stopped. 2 waiting messages dropped.']);
    assert.deepEqual(typed, ['first'], 'neither ran after the stop');
  });

  test('N1: shutdown drops a turn injected behind a waiting chat message: nothing is typed', { timeout: 45_000 }, async () => {
    const { c, typed, first, second } = await waiting();
    const job = c.o.injectTurn(c.key, 'the job');
    await wait(300);
    await c.o.shutdown();
    await Promise.race([Promise.all([first, second, job]), wait(4000)]);
    await wait(800);
    assert.deepEqual(typed, ['first']);
    assert.equal(c.pane().buffers.length, 1);
  });

  test('N1: the queue cap counts turns injected behind a waiting chat message', { timeout: 45_000 }, async (t) => {
    const { c, first } = await waiting(); t.after(() => c.o.shutdown());
    for (let k = 0; k < 30; k++) void c.o.injectTurn(c.key, `job ${k}`);
    await wait(300);
    const q = (c.o as any).queue;
    assert.ok(q.queued(c.key) <= 10, `at most the cap (${q.queued(c.key)})`);
    assert.ok(c.log.filter((l) => /queue-full/.test(l)).length >= 1, 'the rest refused');
    c.pane().rows(ROW.result('t1'), ROW.text('First.'));
    c.pane().show('idle');
    c.pane().stop('First.');
    await first;
  });

  test('N2 (a): a pane with another PreToolUse hook takes no messages into its turns, says so in the log and /status', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    const home = mkdtempSync(join(tmpdir(), 'angelia-hooks-home2-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'lint' }] }] } }));
    c.onEnter((n, p) => {
      if (n === 1) working(p);
      if (n === 2) { p.rows(p.prompt(), ROW.text('Second.')); p.stop('Second.'); }
    });
    const first = c.say('first');
    await until(() => c.pane()?.enters === 1);
    const b = c.brain();
    b.opts.settingsHome = home;
    b.checkOtherHooks();
    assert.match(b.midturnOff, /another PreToolUse hook runs in this session/);
    assert.ok(c.log.some((l) => /midturn off for pane .*1 other PreToolUse hook/.test(l)));
    await wait(150);
    const second = c.say('second');
    await wait(600);
    assert.equal(c.pane().queued.length, 0, 'not typed into the turn');
    c.pane().rows(ROW.result('t1'), ROW.text('First.'));
    c.pane().show('idle');
    c.pane().stop('First.');
    await first; await second;
    assert.deepEqual(c.sent, ['First.', 'Second.']);
    await c.say('/status');
    assert.match(c.sent[c.sent.length - 1], /Mid-turn messages: messages wait for the turn to end: another PreToolUse hook/);
  });

  test('N2 (b): a permission being asked (the hook\'s mark) holds the Enter back', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('first');
    await until(() => c.pane()?.enters === 1);
    const b = c.brain();
    // This test's own pid stands for a hook that is still alive.
    const mark = join(b.dir, 'pretool', `${process.pid}.perm`);
    writeFileSync(mark, '1');
    assert.equal(b.pretoolBusy(b.turnSentAt), 'a permission is being asked');
    const second = c.say('second');
    await wait(700);
    assert.equal(c.pane().queued.length, 0);
    // A mark of a hook that died holds nothing.
    writeFileSync(join(b.dir, 'pretool', '999999.perm'), '1');
    const { rmSync } = await import('node:fs');
    rmSync(mark);
    await until(() => c.pane().queued.length === 1);
    await second;
    c.pane().rows(ROW.queuedPrompt(c.pane().queued[0]), ROW.result('t1'), ROW.text('Both.'));
    c.pane().show('idle');
    c.pane().stop('Both.');
    await first;
    assert.deepEqual(c.sent, ['Both.']);
  });

  test('N4: a follow claimed at the result waits as long as the delivery takes', { timeout: 45_000 }, async (t) => {
    const c = await stubChat({ followWaitMs: 200 } as never); t.after(() => c.o.shutdown());
    const b0 = () => c.brain();
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    await c.say('two');
    const p = c.pane();
    // The delivery of the first answer is slow: longer than the wait for a claim.
    const o = c.o as any;
    const reply = o.replyFromAgent.bind(o);
    o.replyFromAgent = async (...a: unknown[]) => { await wait(800); return reply(...a); };
    p.rows(ROW.result('t1'), ROW.text('First.'));
    p.stop('First.'); p.rows(ROW.over());
    await until(() => c.sent.length === 1, 5000);
    assert.ok(b0().turnSentAt !== undefined, 'still held for its reader');
    p.rows(ROW.prompt(p.queued[0]), ROW.text('Second.'));
    p.show('idle');
    p.stop('Second.');
    await first;
    assert.deepEqual(c.sent, ['First.', 'Second.']);
  });

  test('N5: the old turn\'s last row written after its marker is never read as the next turn\'s', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    await c.say('two');
    const p = c.pane();
    p.rows(ROW.result('t1'));
    p.stop('First.');
    await until(() => c.sent.length === 1);
    // Flushed late: the first turn's text, after its marker.
    p.rows(ROW.text('First.'), ROW.over());
    await wait(300);
    p.rows(ROW.prompt(p.queued[0]), ROW.call('t2'), ROW.result('t2'), ROW.text('Second.'));
    p.show('idle');
    p.stop('Second.');
    await first;
    assert.deepEqual(c.sent, ['First.', 'Second.'], 'the old text did not come again as a progress line');
  });

  test('N6: an Enter is not pressed when the lock has stood too long', { timeout: 45_000 }, async (t) => {
    const c = await stubChat({ lockFreshMs: -1 } as never); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => {
      if (n === 1) working(p);
      if (n === 2) { p.rows(p.prompt(), ROW.text('Second.')); p.stop('Second.'); }
    });
    const first = c.say('first');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    const second = c.say('second');
    await wait(1200);
    assert.deepEqual(c.pane().lockedAtEnter, [], 'no Enter under a lock that may read as left over');
    c.pane().rows(ROW.result('t1'), ROW.text('First.'));
    c.pane().show('idle');
    c.pane().stop('First.');
    await first; await second;
    assert.deepEqual(c.sent, ['First.', 'Second.']);
  });

  test('N9: a take the screen shows late is a take: no second Enter, and no second turn for it', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) working(p); });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    await wait(150);
    c.pane().slowTake(3200);
    await c.say('two');
    const p = c.pane();
    assert.equal(p.queued.length, 1);
    assert.equal(p.lockedAtEnter.length, 1, 'one Enter');
    p.rows(ROW.queuedPrompt(p.queued[0]), ROW.result('t1'), ROW.text('Both.'));
    p.show('idle');
    p.stop('Both.');
    await first;
    await wait(300);
    assert.deepEqual(c.sent, ['Both.']);
    assert.equal(p.enters, 1, 'it was not typed again as a turn of its own');
  });

  test('N10: a message taken just as the turn ends leaves nothing for the next turn', { timeout: 45_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => {
      if (n === 1) working(p);
      if (n === 2) { p.rows(p.prompt(), ROW.text('Next.')); p.stop('Next.'); }
    });
    const first = c.say('one');
    await until(() => c.pane()?.enters === 1);
    const b = c.brain();
    // Claude Code takes it as the turn ends: absorb says yes once the turn is over.
    b.absorb = async () => { await first; return true; };
    await wait(150);
    const two = c.say('two');
    c.pane().rows(ROW.result('t1'), ROW.text('First.'));
    c.pane().show('idle');
    c.pane().stop('First.');
    await first; await two;
    assert.ok(c.log.some((l) => /the turn ended as the message was taken/.test(l)));
    assert.equal((c.o as any).intoTurnTaken.has(c.key), false);
    await c.say('next');
    assert.deepEqual(c.sent, ['First.', 'Next.']);
  });
});
