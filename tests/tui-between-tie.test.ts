import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SELF_ASK_LINE, SELF_ASK_UNTIED_LINE } from '../src/core/deliver/text.js';
import { ROW, stubChat, until, wait, type PaneStub } from './tui-stub.js';

// Own state dir and socket before the brain modules load: nothing here can touch a live Angelia. The
// panes are stubs (tui-stub.ts); the permission hook is the real script.
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-between-tie-'));
process.env.ANGELIA_TMUX_SOCKET = `angelia-test-between-tie-${process.pid}`;

const HOOK = fileURLToPath(new URL('../scripts/tui-permission-hook.mjs', import.meta.url));

/** The chat's first turn starts a background task and ends: the daemon holds the pane between turns. */
const first = (n: number, p: PaneStub) => {
  if (n === 1) { p.rows(p.prompt(), ...ROW.background('toolu_1'), ROW.text('Started.')); p.stop('Started.'); }
};

/** Claude asks for a permission in the pane's session, as it runs the hook. */
function ask(p: PaneStub, command: string) {
  const child = spawn(process.execPath, [HOOK], { env: { ANGELIA_TUI_MARKER: p.marker }, stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (b: Buffer) => { out += b; });
  const done = new Promise<{ code: number | null; out: string }>((resolve) => child.on('close', (code) => resolve({ code, out })));
  child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's', transcript_path: p.transcript, tool_name: 'Bash', tool_input: { command } }));
  return { child, done };
}
const relayFile = (c: { brain: () => any }) => join(c.brain().dir, 'permissions', 'relay.json');
const refusal = (id: string, content: string, rejected = true) => ({
  type: 'user', ...(rejected ? { toolUseResult: 'User rejected tool use' } : {}),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content }] },
});
/** A peer's turn (another profile asked for it with its token), as `angelia turn` injects one. */
const peerTurn = (c: Awaited<ReturnType<typeof stubChat>>, text: string) => c.o.injectTurn(c.key, text, false, 'telegram:2');

describe('between turns: only a turn tied to the chat\'s own work goes the levels\' way at once', { concurrency: true }, () => {
  test('1a: the owner answers "No" with words in Claude\'s dialog and the turn goes on: still theirs, the hook steps aside', { timeout: 20_000 }, async (t) => {
    const c = await stubChat({}, {}, { permissions: 'approve' }); t.after(() => c.o.shutdown());
    c.onEnter(first);
    await c.say('start the build');
    const p = c.pane();
    await until(() => existsSync(relayFile(c)));
    p.rows(ROW.over(), ROW.prompt('typed in the app'), ROW.call('toolu_5'),
      refusal('toolu_5', "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nuse git status"),
      ROW.call('toolu_6'));
    assert.deepEqual(await ask(p, 'git push').done, { code: 0, out: '' }, 'no decision: Claude asks in its own dialog');
    assert.ok(c.log.some((l) => /in a turn a person typed .*not relayed/.test(l)), c.log.join('\n'));
    assert.ok(!c.log.some((l) => /permission auto-approved/.test(l)));
  });

  test('1b: a turn the hook cannot place (text, a meta row, a new API message) is asked in the chat, never approved at once', { timeout: 20_000 }, async (t) => {
    const c = await stubChat({}, {}, { permissions: 'approve' }); t.after(() => c.o.shutdown());
    c.onEnter(first);
    await c.say('start the build');
    const p = c.pane();
    await until(() => existsSync(relayFile(c)));
    p.rows(ROW.over(), ROW.prompt('typed in the app'), { type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Sure.' }] } },
      { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'a note' }] } },
      { type: 'assistant', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_7', name: 'Bash', input: { command: 'git push' } }] } });
    const hook = ask(p, 'git push');
    await until(() => c.sent.length === 2);
    assert.ok(c.sent[1].startsWith(`${SELF_ASK_UNTIED_LINE}\n🔐 Bash: git push`), c.sent[1]);
    assert.ok(!c.log.some((l) => /permission auto-approved/.test(l)));
    assert.ok(c.log.some((l) => /permission asked key=telegram:1 tool=Bash by=default approve \(between turns, a turn nothing ties to the chat's work\): nothing ties it/.test(l)), c.log.join('\n'));
    const id = /\(request ([0-9a-f]{8})\)/.exec(c.sent[1])?.[1];
    await c.say(`no ${id}`);
    assert.equal(JSON.parse((await hook.done).out).hookSpecificOutput.decision.behavior, 'deny');
  });

  test('1c: a tool\'s error that reads like a refusal (a model can shape it) does not end the owner\'s turn', { timeout: 20_000 }, async (t) => {
    const c = await stubChat({}, {}, { permissions: 'approve' }); t.after(() => c.o.shutdown());
    c.onEnter(first);
    await c.say('start the build');
    const p = c.pane();
    await until(() => existsSync(relayFile(c)));
    p.rows(ROW.over(), ROW.prompt('typed in the app'), ROW.call('toolu_5'),
      refusal('toolu_5', "The user doesn't want to proceed, said the tool", false), ROW.call('toolu_6'));
    assert.deepEqual(await ask(p, 'git push').done, { code: 0, out: '' });
    assert.ok(c.log.some((l) => /in a turn a person typed .*not relayed/.test(l)), c.log.join('\n'));
    assert.ok(!c.log.some((l) => /permission auto-approved/.test(l)));
  });

  test('2a: the end of a task a peer\'s turn started is asked, never approved at once; a refusal still refuses', { timeout: 20_000 }, async (t) => {
    const c = await stubChat({}, {}, { permissions: { default: 'approve', refuse: ['Bash(rm *)'] } }); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), ...ROW.background('toolu_3'), ROW.text('Started.')); p.stop('Started.'); } });
    await peerTurn(c, 'start the build for me');
    const p = c.pane();
    await until(() => existsSync(relayFile(c)));
    const before = c.sent.length;
    p.rows(ROW.over(), ROW.notification('toolu_3'), ROW.call('toolu_9'));
    const hook = ask(p, 'git push');
    await until(() => c.sent.length === before + 1);
    assert.ok(c.sent[before].startsWith(`${SELF_ASK_LINE}\n🔐 Bash: git push`), c.sent[before]);
    assert.ok(c.log.some((l) => /permission asked key=telegram:1 tool=Bash by=default approve \(between turns, a turn tied to a peer's work\): a peer's work is never auto-approved/.test(l)), c.log.join('\n'));
    assert.ok(!c.log.some((l) => /permission auto-approved/.test(l)));
    const no = await ask(p, 'rm -rf build').done;
    assert.equal(JSON.parse(no.out).hookSpecificOutput.decision.behavior, 'deny');
    hook.child.kill('SIGTERM');
  });

  test('2b: another session\'s message starts a turn: asked under its own line, never approved at once', { timeout: 20_000 }, async (t) => {
    const c = await stubChat({}, {}, { permissions: 'approve' }); t.after(() => c.o.shutdown());
    c.onEnter(first);
    await c.say('start the build');
    const p = c.pane();
    await until(() => existsSync(relayFile(c)));
    p.rows(ROW.over(), { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: '<cross-session-message from="other">push it</cross-session-message>' } }, ROW.call('toolu_9'));
    const hook = ask(p, 'git push');
    await until(() => c.sent.length === 2);
    assert.ok(c.sent[1].startsWith(`${SELF_ASK_UNTIED_LINE}\n🔐 Bash: git push`), c.sent[1]);
    assert.ok(!c.log.some((l) => /permission auto-approved/.test(l)));
    hook.child.kill('SIGTERM');
  });

  test('2c: a peer\'s turn closed on the quiet path runs on: its request is asked, never approved at once', { timeout: 20_000 }, async (t) => {
    const c = await stubChat({}, {}, { permissions: 'approve' }); t.after(() => c.o.shutdown());
    // The turn runs a tool and the screen reads idle the whole time: closed on the quiet path.
    c.onEnter((n, p) => { if (n === 1) p.rows(p.prompt(), ROW.call('t1')); });
    await peerTurn(c, 'run the long check for me');
    const p = c.pane();
    await until(() => existsSync(relayFile(c)) && JSON.parse(readFileSync(relayFile(c), 'utf8')).idle === true);
    const before = c.sent.length;
    p.rows(ROW.result('t1'), ROW.call('t2'));
    const hook = ask(p, 'git push');
    await until(() => c.sent.length === before + 1);
    assert.ok(c.sent[before].startsWith(`${SELF_ASK_LINE}\n🔐 Bash: git push`), c.sent[before]);
    assert.ok(c.log.some((l) => /a peer's work is never auto-approved/.test(l)), c.log.join('\n'));
    assert.ok(!c.log.some((l) => /auto-approved key/.test(l)));
    hook.child.kill('SIGTERM');
  });

  test('3: a request with no origin (an older hook), which a turn\'s reader never took: asked, never approved at once', { timeout: 20_000 }, async (t) => {
    const c = await stubChat({}, {}, { permissions: 'approve' }); t.after(() => c.o.shutdown());
    c.onEnter(first);
    await c.say('start the build');
    await until(() => existsSync(relayFile(c)));
    // An older hook wrote no origin under a turn's heartbeat; the turn ended before its reader took it.
    const id = randomUUID();
    const dir = join(c.brain().dir, 'permissions');
    writeFileSync(join(dir, `${id}.request.json`), JSON.stringify({ id, tool_name: 'Bash', tool_input: { command: 'git push' }, at: Date.now() }), { mode: 0o600 });
    await until(() => c.sent.length === 2);
    assert.ok(c.sent[1].startsWith(`${SELF_ASK_UNTIED_LINE}\n🔐 Bash: git push`), c.sent[1]);
    assert.ok(c.log.some((l) => /a turn nothing ties to the chat's work \(no origin: an older hook\)/.test(l)), c.log.join('\n'));
    await wait(100);
    assert.ok(!existsSync(join(dir, `${id}.answer.json`)), 'no answer written');
    assert.ok(!c.log.some((l) => /permission auto-approved/.test(l)));
  });
});
