import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROW, stubChat, until, wait } from './tui-stub.js';

// Mid-turn messages across a restart that adopts the running tmux turn (restart-relay): what was typed
// into the turn, what it holds for the next turn, and what waits for a moment, all go to the next daemon.
// Own state dir and socket before the brain modules load; the panes are stubs (tui-stub.ts).
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-midturn-restart-'));
process.env.ANGELIA_TMUX_SOCKET = `angelia-test-midturn-restart-${process.pid}`;

const working = (p: { rows: (...r: object[]) => void; prompt: () => object; show: (s: 'busy') => void }) => { p.rows(p.prompt(), ROW.call('t1')); p.show('busy'); };

/** A turn at work with one message typed into it and one waiting for its moment (a dialog opened),
 *  then a restart: the old daemon stops, the next one adopts the turn. */
async function across() {
  const one = await stubChat();
  one.onEnter((n, p) => { if (n === 1) working(p); });
  const first = one.say('one');
  await until(() => one.pane()?.enters === 1);
  await wait(150);
  await one.say('two');
  const typed = one.pane().queued[0];
  assert.ok(typed);
  one.pane().show('dialog');
  void one.say('three');
  await until(() => (one.o as any).queue.holding(one.key) === 1);
  (one.o as any).cutTurns();
  await one.o.shutdown();
  await Promise.race([first, wait(2000)]);
  const kept = JSON.parse(readFileSync(join(one.stateDir, 'adopt-turns.json'), 'utf8')).turns[0];
  const two = await stubChat({}, {}, {}, { cwd: one.cwd, stateDir: one.stateDir });
  return { one, two, kept, typed };
}

describe('mid-turn messages across a restart', { concurrency: true, timeout: 180_000 }, () => {
  test('the turn is adopted with the message it took: its one answer reaches the chat, and the waiting one runs after it', { timeout: 45_000 }, async (t) => {
    const { one, two, kept, typed } = await across();
    t.after(() => two.o.shutdown());
    assert.deepEqual(kept.waiting.map((w: { inbound: { text: string } }) => w.inbound.text), ['three'], 'the one waiting for its moment goes along');
    assert.deepEqual(kept.joined.map((j: { i: { text: string } }) => j.i.text), ['two'], 'the one typed into the turn goes along');
    assert.equal(kept.absorbed.length, 1);
    assert.ok(one.log.some((l) => /restart: a message waiting for the running turn goes to the next daemon/.test(l)), one.log.join('\n'));
    assert.ok(!existsSync(join(one.brain().dir, 'absorb.lock')));
    two.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), ROW.text('Three.')); p.stop('Three.'); } });
    assert.deepEqual(await (two.o as any).restoreTurns(), [], 'adopted');
    const p = two.pane();
    // The turn goes on in the pane: it took the message, and ends with one answer for both.
    p.rows(ROW.queuedPrompt(typed), ROW.result('t1'), ROW.text('Both.'));
    p.show('idle');
    p.stop('Both.');
    await until(() => two.sent.includes('Three.'), 20_000);
    assert.deepEqual(two.sent, ['Both.', 'Three.']);
    assert.deepEqual(one.sent, [], 'nothing was said at the stop');
  });

  test('the adopted turn ends without taking it: the turn Claude Code runs for it is read for the chat by the next daemon', { timeout: 45_000 }, async (t) => {
    const { two, typed } = await across();
    t.after(() => two.o.shutdown());
    two.onEnter((n, p) => { if (n === 1) { p.rows(p.prompt(), ROW.text('Three.')); p.stop('Three.'); } });
    assert.deepEqual(await (two.o as any).restoreTurns(), []);
    const p = two.pane();
    p.rows(ROW.result('t1'), ROW.text('First.'));
    p.stop('First.');
    p.rows(ROW.over(), ROW.prompt(typed), ROW.text('Second.'));
    await until(() => two.sent.length >= 1);
    p.show('idle');
    p.stop('Second.');
    await until(() => two.sent.includes('Three.'), 20_000);
    assert.deepEqual(two.sent, ['First.', 'Second.', 'Three.']);
  });
});
