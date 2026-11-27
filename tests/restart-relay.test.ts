import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Inbound } from '../src/core/types.js';

// A daemon restart in the middle of a tmux turn (2026-11-25): the turn is adopted, the permission hook
// waits for the new daemon, an orphaned dialog is told to the chat (and never answered from it), and
// the agent's own `angelia restart` waits for its turn to end. One tmux socket and one state folder of
// its own, set before the first import: tmux.ts and daemon.ts read them once, and nothing here may
// reach a live Angelia.
const here = dirname(fileURLToPath(import.meta.url));
const SOCKET = `angelia-test-restart-relay-${process.pid}`;
process.env.ANGELIA_TMUX_SOCKET = SOCKET;
const state = mkdtempSync(join(tmpdir(), 'angelia-rr-'));
process.env.ANGELIA_STATE_DIR = state;
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();
const tmux = (...a: string[]) => execFileSync('tmux', ['-L', SOCKET, ...a], { encoding: 'utf8' }).trim();
function killServer() {
  spawnSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' });
  rmSync(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.()}`, SOCKET), { force: true });
}
process.on('exit', killServer);

const { Config } = await import('../src/instance/config/schema.js');
const { Orchestrator } = await import('../src/core/orchestrator.js');
const { ADOPT_TURNS, CUT_TURNS, takeAdoptTurns, writeAdoptTurns } = await import('../src/core/cut-turns.js');
const { promptKey } = await import('../src/brain/tui.js');
const { SELF_ASK_UNTIED_LINE } = await import('../src/core/deliver/text.js');
const { ScreenAsks, screenAlarmLine, openDialog } = await import('../src/core/screen-asks.js');
const { DeferredRestart, DEFERRED_LINE } = await import('../src/daemon/deferred-restart.js');
const { restartCommand } = await import('../src/daemon/restart.js');
const { ApiServer, sessionToken } = await import('../src/daemon/api/server.js');

const FAKE_TUI = join(here, 'fake-tui.sh');
const FAKE_DIALOG = join(here, 'fake-dialog.mjs');
const HOOK = join(here, '..', 'scripts', 'tui-permission-hook.mjs');
const FRAME = join(here, 'fixtures', 'pane-permission.txt');
const KEY = 'whatsapp:g@g.us';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, f: () => T | undefined, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const msg = (sender: string, text: string, extra: Partial<Inbound> = {}): Inbound => ({ platform: 'whatsapp', chat: 'g@g.us', sender, senderName: sender, text, isGroup: true, mentioned: true, media: [], ...extra });

function rig(tui: boolean, cwd = mkdtempSync(join(tmpdir(), 'angelia-rr-cwd-'))) {
  const cfg = Config.parse({
    profiles: { a: { cwd, tui } },
    routes: [{ platform: 'whatsapp', chat: 'g@g.us', profile: 'a', mention: 'any', owners: ['boss'], allow_from: ['*'] }],
    defaults: { max_out_per_min: 1000 },
  });
  const sent: string[] = [];
  const sender = { send: async (_c: string, text: string) => { sent.push(text); } };
  const o = new Orchestrator(cfg, { whatsapp: sender }, { stateDir: state, bins: { 'claude-code': tui ? FAKE_TUI : join(here, 'fake-claude.mjs') } });
  return { o, sent, cwd };
}

/** A turn running in a live pane of `o`, read for the chat, as after any typed message (follow skips the paste). */
async function runningTurn(o: any, text: string) {
  o.map.ensureActive(KEY, text, 'claude-code');
  // The brain pool's on the dev line, the orchestrator's own on the public one.
  const brain = await (o.pool ? o.pool.brainFor(KEY, 'a') : o.brainFor(KEY, 'a'));
  assert.equal(await brain.whenReady(), null);
  brain.turnSentAt = Date.now() - 1000;
  void o.queue.enqueue(KEY, () => o.turn(msg('boss', text), KEY, 'a', { follow: brain.follow() }));
  const dir = join(state, 'tui', brain.name);
  await until('the heartbeat', () => existsSync(join(dir, 'permissions', 'relay.json')));
  return { brain, dir };
}

test('a restart in the middle of a tmux turn: the next daemon adopts it, offers the waiting request again, and the answer reaches the chat', { skip: !hasTmux && 'no tmux', timeout: 60_000 }, async (t) => {
  t.after(killServer);
  const one = rig(true);
  const o1 = one.o as any;
  const { brain, dir } = await runningTurn(o1, 'please update and restart');
  const relayFile = join(dir, 'permissions', 'relay.json');
  const row = o1.map.getActive(KEY);
  // What the turn typed, as the hook reads it from the transcript, and its key (as turn() keeps it):
  // the next daemon gets the key with the turn, so the request is still that turn's.
  const transcript = join(state, 'rr-transcript.jsonl');
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), origin: { kind: 'human' }, message: { role: 'user', content: 'please update and restart' } })}\n`);
  brain.restoreTurnKey(promptKey('please update and restart'));

  // The agent's next tool call needs a permission; the chat is asked.
  const hook = spawn(process.execPath, [HOOK], { env: { ANGELIA_TUI_MARKER: join(dir, 'turn.json') }, stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  hook.stdout.on('data', (b: Buffer) => { out += b; });
  const closed = new Promise((r) => hook.on('close', r));
  hook.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', transcript_path: transcript, tool_name: 'Bash', tool_input: { command: 'sleep 5; angelia status' } }));
  const first = await until('the first request line', () => one.sent.find((l) => l.includes('sleep 5; angelia status')));
  assert.ok(!first.startsWith(SELF_ASK_UNTIED_LINE), first);

  // The daemon stops for a restart: the turn is written down to be adopted, not cut, and the hook waits.
  // An orphaned heartbeat of another pane goes at the next start (its hook must not wait for nobody).
  const other = join(state, 'tui', 'angelia-gone-pane', 'permissions');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'relay.json'), JSON.stringify({ at: Date.now() }));
  o1.cutTurns();
  await o1.shutdown();
  assert.ok(existsSync(join(state, ADOPT_TURNS)), 'the turn is kept for the next daemon');
  assert.equal(JSON.parse(readFileSync(join(state, ADOPT_TURNS), 'utf8')).turns[0].typedKey, promptKey('please update and restart'), 'with the key of what it typed');
  assert.ok(!existsSync(join(state, CUT_TURNS)), 'and its chat is not told to send it again');
  assert.ok(existsSync(relayFile), 'the last heartbeat is left to grow old, not removed');
  await sleep(1500);
  assert.equal(hook.exitCode, null, 'the hook still waits: the request stays for the next daemon');

  // The next daemon.
  const two = rig(true, one.cwd);
  const o2 = two.o as any;
  t.after(() => o2.shutdown());
  assert.equal(o2.map.getActive(KEY)?.id, row.id);
  assert.deepEqual(await o2.restoreTurns(), [], 'adopted, so no cut line');
  assert.ok(!existsSync(join(state, ADOPT_TURNS)), 'taken once');
  assert.ok(!existsSync(join(other, 'relay.json')), 'a pane nobody adopted has no heartbeat any more');
  assert.ok(existsSync(relayFile), 'the adopted one beats');
  const line = await until('the request offered again', () => two.sent.find((l) => l.includes('sleep 5; angelia status')));
  assert.ok(!line.startsWith(SELF_ASK_UNTIED_LINE), `still the adopted turn's own: ${line}`);
  const id = /\(request ([0-9a-z-]+)\)/.exec(line)![1];
  await o2.handle(msg('boss', `yes ${id}`));
  await closed;
  assert.deepEqual(JSON.parse(out).hookSpecificOutput.decision, { behavior: 'allow' }, 'the chat\'s yes reached the request Claude made');

  // The turn ends: its answer goes to the chat it came from.
  writeFileSync(join(dir, 'turn.json'), JSON.stringify({ text: 'Updated, and Angelia is back.', at: Date.now() }));
  await until('the answer', () => two.sent.includes('Updated, and Angelia is back.'));
});

test('a restart stops the turn\'s reader before the adapters: the answer waits for the next daemon, and so do the messages queued behind it', { skip: !hasTmux && 'no tmux', timeout: 60_000 }, async (t) => {
  t.after(killServer);
  const one = rig(true);
  const o1 = one.o as any;
  const { dir } = await runningTurn(o1, 'a long task');
  void o1.handle(msg('boss', 'and then this one'));
  await until('the second message waits', () => o1.queue.queued(KEY) === 2);

  o1.cutTurns();
  // The answer comes while the adapters stop: the old daemon does not take it.
  writeFileSync(join(dir, 'turn.json'), JSON.stringify({ text: 'The long task is done.', at: Date.now() }));
  await sleep(1500);
  assert.ok(existsSync(join(dir, 'turn.json')), 'the Stop marker stays for the next daemon');
  assert.ok(!one.sent.includes('The long task is done.'), 'nothing went to a stopping adapter');
  await o1.shutdown();
  assert.ok(!one.sent.some((l) => /restarted|send it again|failed/i.test(l)), 'nothing is said in the chat at the stop');
  const kept = JSON.parse(readFileSync(join(state, ADOPT_TURNS), 'utf8')).turns[0];
  assert.deepEqual(kept.waiting.map((w: { inbound: Inbound }) => w.inbound.text), ['and then this one']);

  const two = rig(true, one.cwd);
  const o2 = two.o as any;
  t.after(() => o2.shutdown());
  const turns: string[] = [];
  o2.onEvent((e: { type: string; text?: string }) => { if (e.type === 'turn') turns.push(e.text ?? ''); });
  assert.deepEqual(await o2.restoreTurns(), []);
  await until('the answer', () => two.sent.includes('The long task is done.'));
  await until('the waiting message runs after it', () => turns.includes('and then this one'));
  assert.deepEqual(turns, ['a long task', 'and then this one'], 'in their order');
});

test('turns to adopt: a message that is not its chat\'s, a chat no longer routed, a broken file: none adopted, and the file goes', async () => {
  const { o } = rig(true);
  writeAdoptTurns(state, [{ key: KEY, session: 'not-the-session', since: Date.now(), inbound: msg('boss', 'x') }]);
  assert.deepEqual(await (o as any).restoreTurns(), [KEY], 'the pane or session is gone: the cut line');
  writeAdoptTurns(state, [{ key: KEY, session: 's', since: Date.now(), inbound: { ...msg('boss', 'x'), chat: 'other@g.us' } }]);
  assert.deepEqual(await (o as any).restoreTurns(), [KEY], 'a message of another chat is never answered here');
  writeAdoptTurns(state, [{ key: 'telegram:999', session: 's', since: Date.now(), inbound: { ...msg('boss', 'x'), platform: 'telegram', chat: '999', isGroup: false } }]);
  assert.deepEqual(await (o as any).restoreTurns(), ['telegram:999'], 'a chat no longer routed');
  writeFileSync(join(state, ADOPT_TURNS), '{"turns": [');
  assert.deepEqual(takeAdoptTurns(state), []);
  assert.ok(!existsSync(join(state, ADOPT_TURNS)), 'a broken file is removed, not read again at every start');
  await o.shutdown();
});

test('openDialog: only a dialog that is open now, with nothing drawn after it, and no input box', () => {
  const frame = readFileSync(FRAME, 'utf8');
  assert.ok(openDialog(frame), 'the real dialog');
  const rule = '─'.repeat(80);
  // An agent's answer that ends with the question sits above the input box.
  assert.equal(openDialog(['⏺ Shall I go on? Do you want to proceed?', '  ❯ 1. Yes', '', rule, '❯ ', rule, '  ? for shortcuts'].join('\n')), null);
  // A dialog drawn in the agent's text above a real dialog of another kind: not the last thing drawn.
  assert.equal(openDialog([rule, ' Read file', '   docs/README.md', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', rule, ' Edit file', ' ~/.zshrc',
    ' Do you want to make this edit to .zshrc?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel'].join('\n')), null);
  // The question with no option rows right under it.
  assert.equal(openDialog([rule, ' Bash command', '   ls', ' Do you want to proceed?', '   some text'].join('\n')), null);
});

test('a teammate\'s dialog (claude 2.1.332, the screen seen 2026-11-25): read as open, named with its agent, told once per dialog', async () => {
  const frame = readFileSync(join(here, 'fixtures', 'pane-permission-teammate-332.txt'), 'utf8');
  const d = openDialog(frame);
  assert.deepEqual(d && { tool: d.tool, from: d.from }, { tool: 'Bash command', from: 'the restart-relay agent' });
  assert.match(d!.preview, /rm -rf "\$RELAY_STATE"\/\* · Dangerous rm operation on possibly-empty variable path/);
  // With the session's agents listed under the dialog's foot, as under the input box: still open.
  assert.ok(openDialog(`${frame}\n  ⏺ main\n  ◯ restart-relay  Restart the relay                 2m 3s · ↓ 4.1k tokens\n`));
  // Only "from (the) <name> agent" at the end of the title names an asker: any other "· from" is the title's own.
  const titled = (t: string) => openDialog(frame.replace('Bash command · from the restart-relay agent', t));
  assert.ok(frame.includes('Bash command · from the restart-relay agent'));
  assert.deepEqual(titled('Bash command · from scout agent') && { tool: titled('Bash command · from scout agent')!.tool, from: titled('Bash command · from scout agent')!.from }, { tool: 'Bash command', from: 'scout agent' });
  for (const t of ['Fetch · from the web', 'Bash command · from the restart-relay agent now', 'Read · from two agents agent x']) {
    const d2 = titled(t);
    assert.ok(d2 && d2.from === undefined, t);
    assert.equal(d2.tool, t.slice(0, 40));
  }
  // But the same rows before the foot are no dialog's.
  assert.equal(openDialog(frame.replace(' Esc to cancel · Tab to amend', '  ◯ restart-relay  Restart the relay\n Esc to cancel')), null);

  const line = screenAlarmLine({ name: 'pane-1', ...d! }, SOCKET);
  assert.match(line, /^A permission waits: Bash command from the restart-relay agent \(Run shell command · rm -rf /);
  assert.match(line, /It did not come through the chat, and the chat cannot answer it: answer it in the Claude app, or in the pane \(tmux -L \S+ attach -t '=pane-1'\)/);

  // The scan: at first sight nothing, told once ORPHAN_MS (20 s) on, at the next look; a scan every
  // SCAN_MS (10 s), so within about 30 s. Once per dialog: a new dialog is told again.
  let now = 1_000_000, screen = frame;
  const told: { key: string; tool: string; from?: string }[] = [];
  const asks = new ScreenAsks({ panes: () => [{ key: KEY, name: 'pane-1', dir: mkdtempSync(join(tmpdir(), 'angelia-rr-mate-')) }], log: () => {}, env: () => process.env, now: () => now, tell: async (a) => { told.push(a); } });
  (asks as any).capture = async () => screen;
  for (let t = 0; t <= 60_000; t += 10_000) { now = 1_000_000 + t; await asks.scan(); if (t === 10_000) assert.equal(told.length, 0, 'not before 20 s'); }
  assert.deepEqual(told.map((a) => [a.key, a.tool, a.from]), [[KEY, 'Bash command', 'the restart-relay agent']], 'told once, at 20 s');
  screen = frame.replace('"$RELAY_STATE"/*', '"$RELAY_LOGS"/*');
  for (let t = 70_000; t <= 100_000; t += 10_000) { now = 1_000_000 + t; await asks.scan(); }
  assert.equal(told.length, 2, 'another dialog is told again');
});

test('a dialog in a chat\'s pane with no hook request is told once after ORPHAN_MS, and only told: no key reaches the pane', { skip: !hasTmux && 'no tmux', timeout: 30_000 }, async (t) => {
  t.after(killServer);
  const name = `rr-dialog-${process.pid}`;
  const keys = join(state, `keys-${process.pid}.txt`);
  writeFileSync(keys, '');
  tmux('new-session', '-d', '-s', name, '-x', '220', '-y', '50', '-e', `FAKE_FRAME=${FRAME}`, '-e', `FAKE_KEYS=${keys}`, process.execPath, FAKE_DIALOG);
  const dir = mkdtempSync(join(tmpdir(), 'angelia-rr-pane-'));
  const told: { name: string; tool: string; preview: string }[] = [];
  let failNext = true;
  const asks = new ScreenAsks({
    panes: () => [{ key: KEY, name, dir }], log: () => {}, env: () => process.env, socket: SOCKET, orphanMs: 400,
    tell: async (a) => { if (failNext) { failNext = false; throw new Error('the chat is down'); } told.push(a); },
  });
  await until('the frame', () => tmux('capture-pane', '-p', '-t', name).includes('Do you want to proceed?'));

  // A hook waits on a request of this pane: the dialog is the relay's, never told.
  mkdirSync(join(dir, 'permissions'));
  writeFileSync(join(dir, 'permissions', '00000000-0000-4000-8000-000000000000.request.json'), '{}');
  await asks.scan(); await sleep(500); await asks.scan();
  assert.equal(told.length, 0);
  rmSync(join(dir, 'permissions'), { recursive: true });

  await asks.scan();
  assert.equal(told.length, 0, 'not at first sight');
  await sleep(500);
  await asks.scan();
  assert.equal(told.length, 0, 'the line did not go out');
  await asks.scan();
  assert.equal(told.length, 1, 'tried again at the next look, and told');
  await asks.scan();
  assert.equal(told.length, 1, 'once');
  const line = screenAlarmLine(told[0], SOCKET);
  assert.match(line, /^A permission waits: Bash command \(/);
  assert.match(line, /the chat cannot answer it: answer it in the Claude app, or in the pane \(tmux -L \S+ attach -t '=rr-dialog-\d+'\)/);
  assert.doesNotMatch(line, /reply "yes"|can answer it here/);
  await sleep(300);
  assert.equal(readFileSync(keys, 'utf8'), '', 'no key was pressed in the pane');
  // A credential shape on the screen is masked, the tool line too, and both are cut short.
  const masked = screenAlarmLine({ name: 'p', tool: `token=${'s'.repeat(30)}`, preview: `curl -H "Authorization: Bearer ${'x'.repeat(40)}" ${'y'.repeat(300)}` });
  assert.doesNotMatch(masked, /s{20}|x{20}/);
  assert.ok(masked.length < 500);
});

test('a chat message "yes" or "no" never reaches a dialog only the screen shows', async () => {
  const { o, sent } = rig(false);
  (o as any).screen = { scan: async () => {} };
  await (o as any).tellScreen({ key: KEY, name: 'p', tool: 'Bash command', preview: 'touch x', at: Date.now() });
  assert.match(sent.at(-1)!, /^A permission waits: Bash command \(touch x/);
  assert.doesNotMatch(sent.at(-1)!, /reply "yes"|\(request /, 'nothing to answer it by');
  assert.equal((o as any).answerScreen, undefined, 'no answer path');
  assert.equal(typeof ScreenAsks.prototype.scan, 'function');
  assert.equal((ScreenAsks.prototype as any).answer, undefined, 'no key-press path');
  await o.shutdown();
});

test('a request offered again after a restart times out within its hook\'s own time left', async () => {
  const { PermissionBook } = await import('../src/brain/brain.js');
  const { PermissionRelay, HOOK_GIVE_UP_MS } = await import('../src/brain/tui-permissions.js');
  const gone: string[] = [];
  const book = new PermissionBook(60_000, (id) => gone.push(id));
  book.add('short', 50);
  book.add('long', 10 * 60 * 60_000);
  await sleep(150);
  assert.deepEqual(gone, ['short'], 'the shorter wait holds; a longer one is cut to the book\'s own');
  book.clear();
  // The relay hands on when the hook wrote the request, which the reader counts from.
  const relay = new PermissionRelay(mkdtempSync(join(tmpdir(), 'angelia-rr-relay-')));
  relay.reset();
  const at = Date.now() - 8 * 60_000;
  writeFileSync(join(relay.dir, '11111111-2222-4333-8444-555555555555.request.json'), JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, at }));
  assert.equal(relay.take()[0].at, at);
  assert.ok(HOOK_GIVE_UP_MS - (Date.now() - at) < 10 * 60_000, 'less than the daemon\'s own ten minutes are left');
});

test('a deferred restart: held only for a chat with a running turn, it waits for that turn, then a while for the others', () => {
  let now = Date.parse('2026-11-25T10:00:00Z');
  let running = [KEY, 'telegram:2'];
  const launched: string[] = [];
  const d = new DeferredRestart({ running: () => running, launch: (k) => launched.push(k), log: () => {}, now: () => now, othersWaitMs: 60_000 });
  assert.equal(d.request('telegram:9'), false, 'no turn runs there: nothing is held');
  d.tick();
  assert.equal(d.request(KEY), true);
  d.tick();
  assert.deepEqual(launched, [], 'the asking turn still runs');
  running = ['telegram:2'];
  d.tick(KEY);
  assert.deepEqual(launched, [], 'another chat\'s turn runs: it waits');
  now += 30_000; d.tick();
  assert.deepEqual(launched, []);
  now += 31_000; d.tick();
  assert.deepEqual(launched, [KEY], 'past the wait it goes, once');
  d.tick();
  assert.equal(d.request(KEY), false, 'gone: a second ask holds nothing');
  d.failed();
  running = [];
  assert.equal(d.request(KEY), false, 'after a failed restart, a chat with no turn running holds nothing');
});

test('angelia restart from a chat\'s own agent: deferred by the daemon, by the agent\'s own token, only while its chat runs a turn', async (t) => {
  const table = join(state, 'routing.yaml');
  writeFileSync(table, `profiles:\n  p: { cwd: ${state} }\nroutes: []\n`);
  // A process whose command line reads as a daemon's, so the pid file names a running one.
  const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'angelia', 'daemon']);
  t.after(() => daemon.kill());
  await sleep(300);
  writeFileSync(join(state, 'daemon.pid'), String(daemon.pid));
  const owner = 'owner-token-for-the-test';
  const asked: string[] = [];
  let runs = true;
  const api = new ApiServer({ restartAfterTurn: (key: string) => { asked.push(key); return runs; } } as never, owner);
  await api.listen(join(state, 'api.sock'));
  t.after(() => api.close());
  const env = { key: process.env.ANGELIA_SESSION_KEY, token: process.env.ANGELIA_API_TOKEN };
  const said: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { said.push(a.join(' ')); };
  t.after(() => {
    console.log = log;
    if (env.key === undefined) delete process.env.ANGELIA_SESSION_KEY; else process.env.ANGELIA_SESSION_KEY = env.key;
    if (env.token === undefined) delete process.env.ANGELIA_API_TOKEN; else process.env.ANGELIA_API_TOKEN = env.token;
  });
  process.env.ANGELIA_SESSION_KEY = KEY;
  process.env.ANGELIA_API_TOKEN = sessionToken(owner, KEY);
  for (const argv of [[table], [table, '--force']]) {
    await restartCommand(argv);
    assert.ok(said.at(-1)!.startsWith(DEFERRED_LINE));
  }
  assert.deepEqual(asked, [KEY, KEY]);
  assert.equal(daemon.exitCode, null, 'the daemon was not signalled');
  assert.equal(existsSync(join(state, 'daemon.out')), false, 'nothing was started');

  // A key the token does not name: the daemon refuses it, and the command goes the old way.
  process.env.ANGELIA_SESSION_KEY = 'telegram:5';
  await assert.rejects(() => restartCommand([table]), /agent of telegram:5/);
  assert.deepEqual(asked, [KEY, KEY], 'the daemon was not asked for a chat the token is not');
  // The chat has no turn running: nothing is held, the old way.
  process.env.ANGELIA_SESSION_KEY = KEY;
  runs = false;
  await assert.rejects(() => restartCommand([table]), /agent of whatsapp:g@g\.us/);
  assert.equal(daemon.exitCode, null);
});
