import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTO_DENY_MESSAGE, SELF_ASK_LINE } from '../src/core/deliver/text.js';
import { ROW, stubChat, until, wait, type PaneStub } from './tui-stub.js';

// Own state dir and socket before the brain modules load: nothing here can touch a live Angelia. The
// panes are stubs (tui-stub.ts); the permission hook and the Stop hook are the real scripts.
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-between-'));
process.env.ANGELIA_TMUX_SOCKET = `angelia-test-between-${process.pid}`;

const HOOK = fileURLToPath(new URL('../scripts/tui-permission-hook.mjs', import.meta.url));
const here = fileURLToPath(new URL('.', import.meta.url));

/** The first turn starts a background task and ends: from then on the daemon holds the pane between turns. */
const first = (n: number, p: PaneStub) => {
  if (n === 1) { p.rows(p.prompt(), ...ROW.background('toolu_1'), ROW.text('Started.')); p.stop('Started.'); }
};

/** Claude asks for a permission in the pane's session, as it runs the hook: the request and the transcript. */
function ask(p: PaneStub, command: string) {
  const child = spawn(process.execPath, [HOOK], { env: { ANGELIA_TUI_MARKER: p.marker }, stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (b: Buffer) => { out += b; });
  const done = new Promise<{ code: number | null; out: string }>((resolve) => child.on('close', (code) => resolve({ code, out })));
  child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's', transcript_path: p.transcript, tool_name: 'Bash', tool_input: { command } }));
  return { child, done };
}
const decision = (out: string) => JSON.parse(out).hookSpecificOutput.decision;
const relayFile = (c: { brain: () => any }) => join(c.brain().dir, 'permissions', 'relay.json');

describe('tmux mode: a permission request between the chat\'s turns', { concurrency: true }, () => {
  test('approve: a turn the agent started by itself is approved at once, and says so in the log; refuse rules refuse it', { timeout: 20_000 }, async (t) => {
    const c = await stubChat({}, {}, { permissions: { default: 'approve', refuse: ['Bash(rm *)'] } }); t.after(() => c.o.shutdown());
    c.onEnter(first);
    await c.say('start the build');
    assert.deepEqual(c.sent, ['Started.']);
    const p = c.pane();
    // The turn is over, and the reader between turns beats for the hook.
    await until(() => existsSync(relayFile(c)));
    assert.equal(JSON.parse(readFileSync(relayFile(c), 'utf8')).idle, true);

    // The task ends, Claude Code wakes the agent, and its next Bash call asks.
    p.rows(ROW.over(), ROW.notification('toolu_1'), ROW.call('toolu_9'));
    const yes = await ask(p, 'cd /srv/app && git commit -m done').done;
    assert.deepEqual(decision(yes.out), { behavior: 'allow' });
    assert.ok(c.log.some((l) => l === `permission auto-approved key=${c.key} tool=Bash by=default approve (between turns, a turn the agent started by itself)`), c.log.join('\n'));
    assert.ok(c.log.some((l) => /tmux: a permission between turns, in a turn the agent started by itself \(<task-notification> \(origin task-notification\)\)/.test(l)));

    const no = await ask(p, 'rm -rf build').done;
    assert.deepEqual(decision(no.out), { behavior: 'deny', message: AUTO_DENY_MESSAGE });
    assert.ok(c.log.some((l) => l.startsWith(`permission auto-denied key=${c.key} tool=Bash by=refuse: Bash(rm *) (between turns`)));
    assert.deepEqual(c.sent, ['Started.'], 'nothing was asked in the chat');
  });

  test('a turn a person typed in the Claude app: the hook steps aside at once, and Claude asks in its own dialog', { timeout: 20_000 }, async (t) => {
    const c = await stubChat({}, {}, { permissions: 'approve' }); t.after(() => c.o.shutdown());
    c.onEnter(first);
    await c.say('start the build');
    const p = c.pane();
    await until(() => existsSync(relayFile(c)));
    p.rows(ROW.over(), ROW.prompt('typed in the app'), ROW.call('toolu_9'));
    const started = Date.now();
    assert.deepEqual(await ask(p, 'git push').done, { code: 0, out: '' });
    assert.ok(Date.now() - started < 5000, 'no wait for an answer');
    assert.ok(c.log.some((l) => /tmux: a permission between turns, in a turn a person typed \(a typed prompt \(origin human\)\): not relayed, Claude asks in its own dialog/.test(l)));
    assert.ok(!c.log.some((l) => /auto-approved/.test(l)), 'the profile\'s levels are not used on a turn a person typed');
    assert.deepEqual(readdirSync(join(c.brain().dir, 'permissions')).filter((n) => n.endsWith('.request.json')), [], 'no request left');
    assert.deepEqual(c.sent, ['Started.']);
  });

  test('ask: the request goes to the chat like a turn\'s, and the owner\'s yes reaches that request', { timeout: 20_000 }, async (t) => {
    const c = await stubChat({}, {}, { permissions: 'ask' }); t.after(() => c.o.shutdown());
    // The chat's turn spawns the teammate: its message is the chat's work.
    c.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), ...ROW.teammate('toolu_2', 'scout'), ROW.text('Started.')); p.stop('Started.'); } });
    await c.say('start the build');
    const p = c.pane();
    await until(() => existsSync(relayFile(c)));
    // A teammate's message woke the lead this time.
    p.rows(ROW.over(), ROW.teammateMessage('scout', 'SCOUT-DONE'), ROW.call('toolu_9'));
    const hook = ask(p, 'angelia send "two\nlines"');
    await until(() => c.sent.length === 2);
    const id = /\(request ([0-9a-f]{8})\)/.exec(c.sent[1])?.[1];
    assert.ok(c.sent[1].startsWith(`${SELF_ASK_LINE}\n🔐 Bash: angelia send`), c.sent[1]);
    assert.ok(id);
    assert.ok(c.log.some((l) => l === `permission asked key=${c.key} tool=Bash by=default ask (between turns, a turn the agent started by itself)`));
    assert.equal(c.brain().pendingPermissionCount, 1);
    // The idle reap leaves a pane whose request waits for the owner.
    await (c.o as any).reapIdle(Date.now() + 24 * 3600_000);
    assert.equal(c.brain().alive, true, 'not reaped while a request waits');
    await c.say(`yes ${id}`);
    assert.deepEqual(decision((await hook.done).out), { behavior: 'allow' });
    assert.equal(c.brain().pendingPermissionCount, 0);
    assert.equal(c.sent.length, 2, 'the yes started no turn');

    // A second one, answered in Claude's own dialog: Claude ends the hook, the transcript says how.
    const second = ask(p, 'git push');
    await until(() => c.sent.length === 3);
    p.rows({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_10', name: 'Bash', input: { command: 'git push' } }] } },
      { type: 'user', toolUseResult: 'User rejected tool use', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_10', is_error: true, content: "The user doesn't want to proceed with this tool use." }] } });
    second.child.kill('SIGTERM');
    await until(() => c.sent.length === 4);
    assert.equal(c.sent[3], 'Permission denied in the Claude app or the pane.');
    assert.equal(c.brain().pendingPermissionCount, 0);
  });

  test('after the pane is let go of, nobody reads it: no heartbeat, and the hook steps aside', { timeout: 20_000 }, async (t) => {
    const c = await stubChat({}, {}, { permissions: 'approve' }); t.after(() => c.o.shutdown());
    c.onEnter(first);
    await c.say('start the build');
    await until(() => existsSync(relayFile(c)));
    await c.brain().release();
    assert.ok(!existsSync(relayFile(c)), 'the heartbeat went with the reader between turns');
    const p = c.pane();
    p.rows(ROW.over(), ROW.notification('toolu_1'), ROW.call('toolu_9'));
    assert.deepEqual(await ask(p, 'git commit').done, { code: 0, out: '' });
    await wait(100);
    assert.ok(!c.log.some((l) => /auto-approved/.test(l)));
  });
});

describe('a dialog only the screen shows, between turns', () => {
  test('a dialog whose options wrap in a narrow pane (80 columns, claude 2.1.332) reads as open', async () => {
    const { openDialog } = await import('../src/core/screen-asks.js');
    const narrow = readFileSync(join(here, 'fixtures', 'pane-permission-narrow-332.txt'), 'utf8');
    const multi = readFileSync(join(here, 'fixtures', 'pane-permission-narrow-multiline-332.txt'), 'utf8');
    assert.equal(openDialog(narrow)?.tool, 'Bash command');
    assert.match(openDialog(narrow)?.preview ?? '', /git add note\.txt && git commit/);
    assert.match(openDialog(multi)?.preview ?? '', /printf/);
    // Still only a dialog that is open: text drawn after its foot, a wrapped row with no option above it.
    assert.equal(openDialog(`${narrow.trimEnd()}\n      an indented row after the foot\n`), null);
    assert.equal(openDialog(narrow.replace(' ❯ 1. Yes\n', ' ❯ 1. Yes\n      a wrapped row\n').replace(/^ +2\. Yes, and don't ask again.*$/m, 'not an option')), null);
  });

  test('told to the chat once while it stays open; not while a hook request is beside it (the relay\'s)', async () => {
    const { ScreenAsks, ORPHAN_MS } = await import('../src/core/screen-asks.js');
    const narrow = readFileSync(join(here, 'fixtures', 'pane-permission-narrow-332.txt'), 'utf8');
    const dir = mkdtempSync(join(tmpdir(), 'angelia-between-pane-'));
    mkdirSync(join(dir, 'permissions'));
    const request = join(dir, 'permissions', '11111111-2222-3333-4444-555555555555.request.json');
    writeFileSync(request, '{}');
    let now = 1_000_000;
    const told: string[] = [];
    const s = new ScreenAsks({ panes: () => [{ key: 'telegram:1', name: 'angelia-a-1', dir }], tell: async (a) => { told.push(`${a.tool} ${a.preview}`); }, log: () => {}, env: () => ({}), now: () => now });
    // Only the capture: ScreenAsks never sends a key (it has no call that could).
    (s as any).capture = async () => narrow;
    await s.scan();
    now += ORPHAN_MS + 1;
    await s.scan();
    assert.deepEqual(told, [], 'a hook waits on a request: the relay has it');
    rmSync(request);
    await s.scan();
    now += ORPHAN_MS + 1;
    await s.scan();
    now += 10_000;
    await s.scan();
    assert.equal(told.length, 1);
    assert.match(told[0], /^Bash command .*git commit/);
  });
});
