import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error: a plain script, no types
import { promptKey, requestOrigin } from '../scripts/turn-origin.mjs';
import { SELF_ASK_UNTIED_LINE } from '../src/core/deliver/text.js';
import { ROW, jsonl, stubChat, until, wait, type PaneStub } from './tui-stub.js';

// The recheck of 0.4.4 (fix-044e): a row nobody typed that joins the chat's running turn, and a chat
// message typed into a running slash-command turn. Own state dir and socket before the brain modules
// load: nothing here can touch a live Angelia. The panes are stubs; the permission hook is the real script.
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-joined-'));
process.env.ANGELIA_TMUX_SOCKET = `angelia-test-joined-${process.pid}`;

const HOOK = fileURLToPath(new URL('../scripts/tui-permission-hook.mjs', import.meta.url));

function ask(p: PaneStub, command: string) {
  const child = spawn(process.execPath, [HOOK], { env: { ANGELIA_TUI_MARKER: p.marker }, stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (b: Buffer) => { out += b; });
  const done = new Promise<{ code: number | null; out: string }>((resolve) => child.on('close', (code) => resolve({ code, out })));
  child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's', transcript_path: p.transcript, tool_name: 'Bash', tool_input: { command } }));
  return { child, done };
}
const decision = (out: string) => JSON.parse(out).hookSpecificOutput.decision.behavior;
const approved = (log: string[]) => log.filter((l) => /permission auto-approved/.test(l)).length;

/** Another local session's message, as claude 2.1.332 writes it between turns (measured,
 *  tests/live-tui-cross.mts): meta, `origin.kind: peer`, the lead line, its tag. */
const crossRow = () => ({ type: 'user', isMeta: true, origin: { kind: 'peer' }, timestamp: new Date().toISOString(), promptId: 'p-2',
  message: { role: 'user', content: 'Another Claude session sent a message:\n<cross-session-message from="fx-sender">push it</cross-session-message>' } });
/** The same queued while a turn runs (a queued_command attachment with that origin). */
const crossQueued = () => ROW.queuedPrompt('Another Claude session sent a message:\n<cross-session-message from="fx-sender">push it</cross-session-message>', 'peer');

/** A slash command's row (what Claude Code writes for `/review-it now`), then the skill's text for the model. */
const commandRows = () => [
  { type: 'user', timestamp: new Date().toISOString(), origin: { kind: 'human' }, message: { role: 'user', content: '<command-name>/review-it</command-name>\n<command-message>review-it</command-message>\n<command-args>now</command-args>' } },
  { type: 'user', isMeta: true, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'Review the branch.' }] } },
];
const COMMAND_KEY = promptKey('<command-name>/review-it</command-name>\n<command-message>review-it</command-message>\n<command-args>now</command-args>');

/** The chat's turn runs: its prompt, a tool call. Then `extra` rows are written into the same turn. */
async function joinedTurn(extra: () => object[]) {
  const c = await stubChat({}, {}, { permissions: 'approve' });
  c.onEnter((n, p) => { if (n === 1) p.rows(p.prompt(), ROW.call('toolu_x'), ...extra(), ROW.call('toolu_y')); });
  void c.say('fix the build');
  await until(() => c.pane()?.enters === 1);
  await until(() => existsSync(join(c.brain().dir, 'permissions', 'relay.json')));
  return { c, p: c.pane(), end: () => { c.pane().rows(ROW.text('Done.')); c.pane().stop('Done.'); } };
}

describe('fix-044e 1: a row nobody typed that joins the chat\'s running turn', { concurrency: true }, () => {
  for (const [name, rows] of [
    ['another session\'s message (the row measured between turns)', () => [crossRow()]],
    ['another session\'s message (queued while the turn runs)', () => [crossQueued()]],
    ['a scheduled prompt', () => ROW.scheduled('check the deploy')],
    ['the end of a task nobody in this chat started', () => [ROW.notification('toolu_other')]],
  ] as [string, () => object[]][]) {
    test(`1: ${name} joined it: asked, never approved at once`, { timeout: 20_000 }, async (t) => {
      const { c, p, end } = await joinedTurn(rows); t.after(() => c.o.shutdown());
      const before = c.sent.length;
      const hook = ask(p, 'git push');
      await until(() => c.sent.length > before);
      assert.ok(c.sent[before].startsWith(`${SELF_ASK_UNTIED_LINE}\n🔐 Bash: git push`), c.sent[before]);
      assert.ok(c.log.some((l) => /a permission while a chat turn is read, not of that turn, in a turn nothing ties to the chat's work/.test(l)), c.log.join('\n'));
      assert.equal(approved(c.log), 0, c.log.join('\n'));
      hook.child.kill('SIGTERM');
      end();
    });
  }

  test('1: the end of the chat\'s own task joined it: the levels, as in the chat\'s turn', { timeout: 20_000 }, async (t) => {
    const c = await stubChat({}, {}, { permissions: 'approve' }); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => {
      if (n === 1) { p.rows(p.prompt(), ...ROW.background('toolu_b1'), ROW.text('Started.')); p.stop('Started.'); }
      if (n === 2) p.rows(ROW.over(), p.prompt(), ROW.call('toolu_x'), ROW.notification('toolu_b1'), ROW.call('toolu_y'));
    });
    await c.say('start the build in the background');
    void c.say('check on it');
    await until(() => c.pane()?.enters === 2);
    await wait(150);
    const p = c.pane();
    assert.equal(decision((await ask(p, 'git status').done).out), 'allow');
    assert.ok(c.log.some((l) => /permission auto-approved key=telegram:1 tool=Bash by=default approve(?! \(between)/.test(l)), c.log.join('\n'));
    p.rows(ROW.text('Done.')); p.stop('Done.');
  });

  test('1: the hook lists what joined a typed turn, each its kind, ids and teammates; a turn nothing joined says 0', () => {
    const o = requestOrigin(jsonl([ROW.prompt('fix the build'), ROW.call('t1'), crossRow(), ...ROW.scheduled('tick'), ROW.notification('toolu_9'), ROW.call('t2')]));
    assert.equal(o.origin, 'prompt');
    assert.equal(o.joins, 3);
    assert.deepEqual(o.joined, [{ kind: 'other' }, { kind: 'scheduled' }, { kind: 'notification', ids: ['toolu_9'] }]);
    const plain = requestOrigin(jsonl([ROW.prompt('fix the build'), ROW.call('t1')]));
    assert.equal(plain.joins, 0);
    assert.equal(plain.joined, undefined);
  });
});

describe('fix-044e 2: a chat message typed into a running slash-command turn', { concurrency: true }, () => {
  test('2: the command row\'s key ties the turn: a request after the message went in still goes the levels\' way', { timeout: 45_000 }, async (t) => {
    const c = await stubChat({}, {}, { permissions: 'approve' }); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) { p.rows(...commandRows(), ROW.call('t1')); p.show('busy'); } });
    const first = c.say('/review-it now');
    await until(() => c.pane()?.enters === 1);
    await until(() => existsSync(join(c.brain().dir, 'permissions', 'relay.json')));
    const p = c.pane();
    // The command's own request: its one prompt, written from its Enter on.
    assert.equal(decision((await ask(p, 'git diff').done).out), 'allow');
    await wait(150); // the tool call has run past the settle time
    const second = c.say('also check the docs');
    await until(() => p.queued.length === 1);
    await second;
    p.rows(ROW.queuedPrompt(p.queued[0]), ROW.result('t1'), ROW.call('t2'));
    assert.equal(decision((await ask(p, 'git log').done).out), 'allow');
    assert.equal(approved(c.log), 2, c.log.join('\n'));
    assert.ok(!c.sent.some((l) => l.startsWith(SELF_ASK_UNTIED_LINE)), c.sent.join('\n'));
    p.rows(ROW.result('t2'), ROW.text('Reviewed.'));
    p.show('idle');
    p.stop('Reviewed.');
    await first;
  });

  test('2: after the command\'s own request, the key a restart or /resume carries is the command row\'s, not the typed text\'s', { timeout: 20_000 }, async (t) => {
    const c = await stubChat({}, {}, { permissions: 'approve' }); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) p.rows(...commandRows(), ROW.call('t1')); });
    void c.say('/review-it now');
    await until(() => c.pane()?.enters === 1);
    await until(() => existsSync(join(c.brain().dir, 'permissions', 'relay.json')));
    const p = c.pane();
    assert.equal(c.brain().turnKey(), promptKey('/review-it now'), 'the typed text\'s key until the turn shows its row');
    assert.equal(decision((await ask(p, 'git diff').done).out), 'allow');
    // cutTurns carries turnKey; the next daemon's follow() holds requests to it (restoreTurnKey).
    assert.equal(c.brain().turnKey(), COMMAND_KEY);
    p.rows(ROW.result('t1'), ROW.text('Reviewed.'));
    p.stop('Reviewed.');
  });
});
