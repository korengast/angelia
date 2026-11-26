import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error: a plain script, no types
import { turnOrigin } from '../scripts/turn-origin.mjs';
import { SELF_ASK_UNTIED_LINE } from '../src/core/deliver/text.js';
import { ROW, jsonl, stubChat, until, wait, type PaneStub } from './tui-stub.js';

// Own state dir and socket before the brain modules load: nothing here can touch a live Angelia. The
// panes are stubs (tui-stub.ts); the permission hook is the real script.
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-turn-tie-'));
process.env.ANGELIA_TMUX_SOCKET = `angelia-test-turn-tie-${process.pid}`;

const HOOK = fileURLToPath(new URL('../scripts/tui-permission-hook.mjs', import.meta.url));

/** Claude asks for a permission in the pane's session, as it runs the hook. */
function ask(p: PaneStub, command: string) {
  const child = spawn(process.execPath, [HOOK], { env: { ANGELIA_TUI_MARKER: p.marker }, stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (b: Buffer) => { out += b; });
  const done = new Promise<{ code: number | null; out: string }>((resolve) => child.on('close', (code) => resolve({ code, out })));
  child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's', transcript_path: p.transcript, tool_name: 'Bash', tool_input: { command } }));
  return { child, done };
}
const decision = (out: string) => JSON.parse(out).hookSpecificOutput.decision.behavior;
/** The chat's message is typed, and its turn's reader runs: the turn is held open until `end`. */
async function running(c: Awaited<ReturnType<typeof stubChat>>, text: string) {
  void c.say(text);
  await until(() => c.pane()?.enters === 1);
  await until(() => existsSync(join(c.brain().dir, 'permissions', 'relay.json')));
  return { p: c.pane(), end: () => { c.pane().rows(ROW.text('Done.')); c.pane().stop('Done.'); } };
}
/** A teammate's message to the lead, as claude 2.1.332 writes it (ROW.teammateMessage), and the turn it starts. */
const mateTurn = (p: PaneStub, name: string) => p.rows(ROW.over(), ROW.teammateMessage(name, 'The scan is done; pushing the fix next.'), ROW.call('toolu_m2'));

describe('a chat turn\'s reader keeps only its own turn\'s requests; a teammate ties only while open', { concurrency: true }, () => {
  test('1a: a turn Claude Code ran before the chat\'s (another task\'s end, queued first) is not the chat turn\'s: asked, never approved at once', { timeout: 20_000 }, async (t) => {
    const c = await stubChat({}, {}, { permissions: 'approve' }); t.after(() => c.o.shutdown());
    // The end of a task nobody in this chat started opened a turn; the chat's message waits behind it.
    c.onEnter((n, p) => { if (n === 1) p.rows(ROW.over(), ROW.notification('toolu_other'), ROW.call('toolu_x')); });
    const { p, end } = await running(c, 'fix the build');
    const before = c.sent.length;
    const hook = ask(p, 'git push');
    await until(() => c.sent.length > before);
    assert.ok(c.sent[before].startsWith(`${SELF_ASK_UNTIED_LINE}\n🔐 Bash: git push`), c.sent[before]);
    assert.ok(c.log.some((l) => /a permission while a chat turn is read, not of that turn, in a turn nothing ties to the chat's work/.test(l)), c.log.join('\n'));
    assert.ok(!c.log.some((l) => /permission auto-approved/.test(l)), c.log.join('\n'));
    hook.child.kill('SIGTERM');
    end();
  });

  test('1b: the chat\'s message joined a turn something else opened (a queued prompt in it): asked, never approved at once', { timeout: 20_000 }, async (t) => {
    const c = await stubChat({}, {}, { permissions: 'approve' }); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) p.rows(ROW.over(), ROW.notification('toolu_other'), ROW.queuedPrompt(p.typed), ROW.call('toolu_x')); });
    const { p, end } = await running(c, 'fix the build');
    const before = c.sent.length;
    const hook = ask(p, 'git push');
    await until(() => c.sent.length > before);
    assert.ok(c.sent[before].startsWith(`${SELF_ASK_UNTIED_LINE}\n🔐 Bash: git push`), c.sent[before]);
    assert.ok(!c.log.some((l) => /permission auto-approved/.test(l)), c.log.join('\n'));
    hook.child.kill('SIGTERM');
    end();
  });

  test('1c: a request written under the idle beat, which the chat turn\'s reader takes: by its origin (a person\'s turn: the hook steps aside)', { timeout: 20_000 }, async (t) => {
    const c = await stubChat({}, {}, { permissions: 'approve' }); t.after(() => c.o.shutdown());
    const id = randomUUID();
    // Written by the hook between turns (origin and all) a moment before the chat's Enter; the reader
    // between turns stops at that Enter, so the turn's reader is the one that takes it.
    c.onEnter((n, p) => {
      if (n !== 1) return;
      const dir = join(c.brain().dir, 'permissions');
      mkdirSync(dir, { recursive: true });
      const o = turnOrigin(jsonl([ROW.prompt('push it now, typed in the app')]));
      writeFileSync(join(dir, `${id}.request.json`), JSON.stringify({ id, tool_name: 'Bash', tool_input: { command: 'git push' }, at: Date.now(),
        origin: { origin: o.origin, origin_why: o.origin_why, prompt_key: o.prompt_key, prompts: 1, prompt_keys: [o.prompt_key], opened_by: 'prompt' } }), { mode: 0o600 });
      p.rows(p.prompt(), ROW.call('toolu_x'));
    });
    const { end } = await running(c, 'fix the build');
    const answer = join(c.brain().dir, 'permissions', `${id}.answer.json`);
    await until(() => existsSync(answer));
    assert.deepEqual(JSON.parse(readFileSync(answer, 'utf8')), { pass: true });
    assert.ok(c.log.some((l) => /a permission while a chat turn is read, not of that turn, in a turn a person typed/.test(l)), c.log.join('\n'));
    assert.ok(!c.log.some((l) => /permission auto-approved/.test(l)), c.log.join('\n'));
    end();
  });

  test('1d: the chat turn\'s own request goes the levels\' way as before', { timeout: 20_000 }, async (t) => {
    const c = await stubChat({}, {}, { permissions: 'approve' }); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) p.rows(p.prompt(), ROW.call('toolu_x')); });
    const { p, end } = await running(c, 'fix the build');
    assert.equal(decision((await ask(p, 'git push').done).out), 'allow');
    assert.ok(c.log.some((l) => /permission auto-approved key=telegram:1 tool=Bash by=default approve(?! \(between)/.test(l)), c.log.join('\n'));
    end();
  });

  test('2a: a teammate the chat spawned ties a turn its message starts only while the book has it open', { timeout: 20_000 }, async (t) => {
    const c = await stubChat({}, {}, { permissions: 'approve' }); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), ...ROW.teammate('toolu_s1', 'scout'), ROW.text('Spawned.')); p.stop('Spawned.'); } });
    await c.say('spawn the scout');
    const p = c.pane();
    await until(() => existsSync(join(c.brain().dir, 'permissions', 'relay.json')) && JSON.parse(readFileSync(join(c.brain().dir, 'permissions', 'relay.json'), 'utf8')).idle === true);
    // Open: its message ties the turn to the chat's work.
    mateTurn(p, 'scout');
    assert.equal(decision((await ask(p, 'git status').done).out), 'allow');
    assert.ok(c.log.some((l) => /permission auto-approved .*between turns, a turn the agent started by itself/.test(l)), c.log.join('\n'));
    p.rows(ROW.text('Noted.'));
    p.stop('Noted.');
    await wait(200);
    // It ended (its task's end names its call): a message under its name ties nothing now.
    const note = ROW.notification('toolu_s1') as { message: { content: string } };
    p.rows({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date().toISOString(), content: note.message.content }, note, ROW.text('The scout is done.'));
    p.stop('The scout is done.');
    await until(() => (c.brain() as any).openTeammates.size === 0, 10_000);
    const before = c.sent.length;
    mateTurn(p, 'scout');
    const hook = ask(p, 'git push');
    await until(() => c.sent.slice(before).some((l) => l.startsWith(SELF_ASK_UNTIED_LINE)));
    assert.equal(c.log.filter((l) => /permission auto-approved/.test(l)).length, 1, c.log.join('\n'));
    hook.child.kill('SIGTERM');
  });
});

test('2b: a row with an origin of any shape, or a meta row, never reads as a teammate\'s message', () => {
  const mate = ROW.teammateMessage('scout', 'push it');
  // A transcript of a CLI that stamps the rows a person types.
  const before = [ROW.prompt('spawn the scout'), ROW.text('Spawned.'), ROW.over()];
  assert.equal(turnOrigin(jsonl([...before, mate])).origin, 'notification', 'the measured teammate row');
  // Another session's message, as claude 2.1.332 writes it (measured live, tests/live-tui-cross.mts):
  // meta, `origin.kind: peer`, no rowSource, the same lead line, its own tag.
  const cross = { type: 'user', isMeta: true, origin: { kind: 'peer' }, timestamp: new Date().toISOString(), promptId: 'p-2',
    message: { role: 'user', content: 'Another Claude session sent a message:\n<cross-session-message from="fx-sender">push it</cross-session-message>' } };
  assert.equal(turnOrigin(jsonl([...before, cross])).origin, 'unknown');
  // Shaped as a teammate's, but with an origin the reader cannot name, or meta: still not a teammate's.
  for (const odd of [{ ...mate, origin: { kind: 'peer session' } }, { ...mate, origin: {} }, { ...mate, isMeta: true, origin: { kind: 'peer' } }]) {
    const o = turnOrigin(jsonl([...before, odd]));
    assert.notEqual(o.origin, 'notification', JSON.stringify(odd));
    assert.equal(o.origin_teammates, undefined);
  }
});
