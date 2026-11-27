import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heldLine, selfCapLine } from '../src/core/deliver/text.js';
import { ROW, stubChat, until, wait, type PaneStub } from './tui-stub.js';

// Own state dir and socket before the brain modules load: nothing here can touch a live Angelia. The
// panes are stubs (tui-stub.ts); the Stop hook that writes the markers is the real script, so what
// started each turn is read from the transcript rows as the hook reads them (scripts/turn-origin.mjs).
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-teammate-'));
process.env.ANGELIA_TMUX_SOCKET = `angelia-test-teammate-${process.pid}`;

const taken = async (p: PaneStub) => { await until(() => !p.marked()); await wait(150); };

// tmux mode: a named teammate (the Agent tool with `name`) sends the lead its report, and Claude Code
// starts a turn with it (measured on claude 2.1.332; 62 such answers were dropped on 2026-11-25 as
// "a person typed it"). A teammate spawned in a turn of the chat's is the chat's work, as a background
// task is: the answer to its message reaches the chat.
describe('tmux mode: a turn a teammate\'s message started, between turns', { concurrency: true }, () => {
  test('the answer to the report of a teammate the chat spawned reaches the chat; its idle note only when not [SILENT]', { timeout: 18_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), ...ROW.teammate('toolu_s', 'scout'), ROW.text('spawned')); p.stop('spawned'); } });
    await c.say('send a scout');
    assert.deepEqual(c.sent, ['spawned']);
    const p = c.pane();

    p.rows(ROW.teammateMessage('scout', 'SCOUT-DONE: the sleep finished'), ROW.text('The scout is done: the sleep finished.'));
    p.stop('The scout is done: the sleep finished.');
    await until(() => c.sent.length === 2);
    assert.equal(c.sent[1], 'The scout is done: the sleep finished.');

    // The teammate then goes idle: the agent has nothing to add.
    p.rows(ROW.teammateIdle('scout'), ROW.text('[SILENT]'));
    p.stop('[SILENT]');
    await taken(p);
    assert.match(c.lines().at(-1)!, /is not delivered: a teammate's idle note, and \[SILENT\]; 8 chars/);
    // An idle note the agent answers with words: sent, as any answer of the chat's work is.
    p.rows(ROW.teammateIdle('scout'), ROW.text('The scout waits for more work.'));
    p.stop('The scout waits for more work.');
    await until(() => c.sent.length === 3);
    assert.deepEqual(c.sent, ['spawned', 'The scout is done: the sleep finished.', 'The scout waits for more work.']);
  });

  test('a teammate the owner spawned in the app, or one of the same name spawned there later, stays in the app', { timeout: 18_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), ...ROW.teammate('toolu_s', 'scout'), ROW.text('spawned')); p.stop('spawned'); } });
    await c.say('send a scout');
    const p = c.pane();

    // The owner, in the app, spawns a reviewer; its report starts a turn: theirs.
    p.rows(ROW.prompt('review it'), ...ROW.teammate('toolu_r', 'reviewer'), ROW.text('Spawned the reviewer.'));
    p.stop('Spawned the reviewer.');
    await taken(p);
    p.rows(ROW.teammateMessage('reviewer', 'No findings.'), ROW.text('The review is clean.'));
    p.stop('The review is clean.');
    await taken(p);
    assert.match(c.lines().at(-1)!, /is not delivered: the teammate that sent it was not started by a turn of this chat; 20 chars/);

    // A message from a teammate the chat spawned and one the owner spawned, in one turn: not the chat's alone.
    p.rows(ROW.teammateMessage('scout', 'done'), ROW.teammateMessage('reviewer', 'done too'), ROW.text('Both are done.'));
    p.stop('Both are done.');
    await taken(p);
    assert.match(c.lines().at(-1)!, /the teammate that sent it was not started by a turn of this chat/);

    // The owner spawns a new "scout" in the app: from then on that name is theirs.
    p.rows(ROW.prompt('another scout'), ...ROW.teammate('toolu_s2', 'scout'), ROW.text('Spawned.'));
    p.stop('Spawned.');
    await taken(p);
    p.rows(ROW.teammateMessage('scout', 'found it'), ROW.text('The scout found it.'));
    p.stop('The scout found it.');
    await taken(p);
    assert.match(c.lines().at(-1)!, /the teammate that sent it was not started by a turn of this chat/);

    // A person who types into a teammate's turn makes it theirs.
    p.rows(ROW.teammateMessage('reviewer', 'x'), ROW.prompt('and the docs?'), ROW.text('Docs too.'));
    p.stop('Docs too.');
    await taken(p);
    assert.match(c.lines().at(-1)!, /a person typed it in the Claude app or the pane/);
    assert.deepEqual(c.sent, ['spawned'], 'only the chat\'s own turn went out');
  });

  test('a teammate the lead spawns in a turn the chat\'s teammate started is the chat\'s too; one the owner spawns there is not', { timeout: 18_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), ...ROW.teammate('toolu_s', 'scout'), ROW.text('spawned')); p.stop('spawned'); } });
    await c.say('send a scout');
    const p = c.pane();

    // The owner spawns a "builder" in the app: that name is theirs for now.
    p.rows(ROW.prompt('a builder too'), ...ROW.teammate('toolu_b0', 'builder'), ROW.text('Spawned.'));
    p.stop('Spawned.');
    await taken(p);
    // The scout reports, and the lead, woken by it, spawns a builder (the same name): the chat's work now.
    p.rows(ROW.over(), ROW.teammateMessage('scout', 'found the bug'), ...ROW.teammate('toolu_b', 'builder'), ROW.text('The scout found it; a builder fixes it.'));
    p.stop('The scout found it; a builder fixes it.');
    await until(() => c.sent.length === 2);
    p.rows(ROW.over(), ROW.teammateMessage('builder', 'fixed'), ROW.text('The builder fixed it.'));
    p.stop('The builder fixed it.');
    await until(() => c.sent.length === 3);
    assert.deepEqual(c.sent, ['spawned', 'The scout found it; a builder fixes it.', 'The builder fixed it.']);

    // A turn of the owner's that spawns a "tester": not the chat's, and nor is the tester's report.
    p.rows(ROW.over(), ROW.prompt('and a tester'), ...ROW.teammate('toolu_t', 'tester'), ROW.text('Spawned the tester.'));
    p.stop('Spawned the tester.');
    await taken(p);
    p.rows(ROW.over(), ROW.teammateMessage('tester', 'all green'), ROW.text('All green.'));
    p.stop('All green.');
    await taken(p);
    assert.match(c.lines().at(-1)!, /the teammate that sent it was not started by a turn of this chat/);
    // A turn nothing ties to the chat (a scheduled prompt) spawns a "watcher": not the chat's either.
    p.rows(ROW.over(), ...ROW.scheduled('Check the mail.'), ...ROW.teammate('toolu_w', 'watcher'), ROW.text('Watching.'));
    p.stop('Watching.');
    await taken(p);
    p.rows(ROW.over(), ROW.teammateMessage('watcher', 'mail came'), ROW.text('Mail came.'));
    p.stop('Mail came.');
    await taken(p);
    assert.match(c.lines().at(-1)!, /the teammate that sent it was not started by a turn of this chat/);
    assert.equal(c.sent.length, 3);
  });

  test('let go of between turns: no teammate name is the chat\'s any more', { timeout: 18_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => {
      if (n === 1) { p.rows(p.prompt(), ...ROW.teammate('toolu_s', 'scout'), ROW.text('spawned')); p.stop('spawned'); }
      if (n === 2) { p.rows(ROW.over(), p.prompt(), ROW.text('Here.')); p.stop('Here.'); }
    });
    await c.say('send a scout');
    const b = c.brain();
    assert.deepEqual([...b.oursTeammates], ['scout']);
    // The idle reap lets the pane go; the owner then spawns a "scout" of their own in the app, unread.
    await (c.o as any).dropBrain(c.key, false);
    assert.equal(b.oursTeammates.size, 0, 'a released brain keeps no name');
    c.pane().rows(ROW.prompt('my own scout'), ...ROW.teammate('toolu_s2', 'scout'), ROW.text('Spawned.'));
    await c.say('are you there?');
    assert.equal(c.sent.at(-1), 'Here.');
    const p = c.pane();
    p.rows(ROW.over(), ROW.teammateMessage('scout', 'mine'), ROW.text('Your scout is back.'));
    p.stop('Your scout is back.');
    await taken(p);
    assert.match(c.lines().at(-1)!, /the teammate that sent it was not started by a turn of this chat/);
    assert.deepEqual(c.sent, ['spawned', 'Here.']);
    // stop() forgets them too.
    const b2 = c.brain();
    b2.oursTeammates.add('x');
    await b2.stop();
    assert.equal(b2.oursTeammates.size, 0);
  });

  test('teammates\' reports have their own hourly count (30), idle notes among them', { timeout: 30_000 }, async (t) => {
    const c = await stubChat(); t.after(() => c.o.shutdown());
    c.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), ...ROW.teammate('toolu_s', 'scout'), ...ROW.background('toolu_1'), ROW.text('spawned')); p.stop('spawned'); } });
    await c.say('send a scout');
    const p = c.pane();
    const report = (n: number) => ({ text: `Report ${n}.`, origin: 'notification', origin_teammates: ['scout'] });
    // Eight reports and two idle notes: all reach the chat, past the six an hour of a task's ends.
    for (let n = 1; n <= 8; n++) {
      p.mark(report(n)); await taken(p);
      if (n % 3 === 0) { p.mark({ text: `Idle ${n}.`, origin: 'notification', origin_teammates: ['scout'], origin_idle: true }); await taken(p); }
    }
    assert.equal(c.sent.length, 11);
    const o = c.o as any;
    assert.equal(o.teammateSent.get(c.key).at.length, 10, 'idle notes are counted');
    assert.equal(o.selfSent.get(c.key), undefined, 'a task\'s ends keep their own count');
    // A task's end still has its six.
    for (let n = 1; n <= 7; n++) { p.mark({ text: `Task ${n}.`, origin: 'notification', origin_ids: ['toolu_1'] }); await taken(p); }
    assert.deepEqual(c.sent.slice(11), ['Task 1.', 'Task 2.', 'Task 3.', 'Task 4.', 'Task 5.', 'Task 6.', selfCapLine(6)]);
    // And the teammates' count stops at 30, with the line once.
    o.teammateSent.get(c.key).at.push(...Array.from({ length: 19 }, () => Date.now()));
    for (let n = 30; n <= 32; n++) { p.mark(report(n)); await taken(p); }
    assert.equal(c.sent.at(-2), 'Report 30.');
    assert.equal(c.sent.at(-1), selfCapLine(30));
    assert.equal(c.lines().filter((l) => /self-started answer held .*reason=hourly-limit/.test(l)).length, 3);
    // Both caps' held ones go in one message once both hours have room.
    await c.o.sendHeld(Date.now() + 3601_000);
    assert.equal(c.sent.at(-1), heldLine(['Task 7.', 'Report 31.', 'Report 32.'], 0));
  });
});
