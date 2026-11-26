import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TAKEN_LATE_LINE, TuiBrain } from '../src/brain/tui.js';
import { promptKey } from '../scripts/turn-origin.mjs';
import { Config } from '../src/instance/config/schema.js';
import { CUT_TURNS } from '../src/core/cut-turns.js';
import { Orchestrator } from '../src/core/orchestrator.js';

// The Lows carried into 0.4.6 from the 0.4.5 review (review-045).

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const brain = () => {
  const dir = tmp('angelia-carry46-tui-');
  const profile = Config.parse({ profiles: { x: { cwd: dir, tui: true } }, routes: [] }).profiles.x;
  const b = new TuiBrain(profile, { id: '11111111-2222-3333-4444-555555555555', started: false }, { stateDir: join(dir, 'state') }) as any;
  b.transcript = join(dir, 'transcript.jsonl');
  writeFileSync(b.transcript, '');
  b.ready = Promise.resolve(null);
  return b;
};
const row = (o: object) => `${JSON.stringify(o)}\n`;
const unsure = (b: any, text: string, at = Date.now() - 1000) => ({ key: promptKey(text), text, transcript: b.transcript, offset: 0, at, turn: at - 1000, answered: false });
const marker = (b: any, m: object) => { mkdirSync(b.dir, { recursive: true }); writeFileSync(b.markerPath, JSON.stringify(m)); };

test('a message pressed into a turn and taken late: the turn Claude Code ran for it is the chat\'s, and it is not answered twice', async () => {
  const b = brain();
  const text = 'and this too';
  b.unsure.set('msg-1', unsure(b, text));
  writeFileSync(b.transcript, row({ type: 'queue-operation', operation: 'enqueue', content: text }));
  // Claude Code ran it by itself and ended before the chat's own turn for it looked.
  marker(b, { at: Date.now(), origin: 'prompt', prompt_key: promptKey(text), prompts: 1, text: 'Done, and this too.' });
  assert.deepEqual(b.takeIdle(), { answer: 'midturn', text: 'Done, and this too.' });
  b.paste = () => assert.fail('typed');
  const events = [];
  for await (const e of b.turn(text, { msg: 'msg-1' })) events.push(e);
  assert.deepEqual(events, [{ kind: 'result', text: TAKEN_LATE_LINE, isError: false }]);
  assert.equal(b.absorbed.length, 0, 'no answer is waited for again');
  // From its Enter on, a request of such a turn is the chat's own.
  const late = brain();
  late.unsure.set('msg-2', unsure(late, 'next one'));
  assert.ok(late.typedByUs(promptKey('next one')));
});

test('unsure entries are kept by message: another message with the same words is typed; release, stop and another transcript forget them', async () => {
  const b = brain();
  const text = 'ok';
  b.unsure.set('msg-1', unsure(b, text));
  writeFileSync(b.transcript, row({ type: 'queue-operation', operation: 'enqueue', content: text }));
  let typed = 0;
  b.paste = async () => { typed++; return { ok: false, why: 'released', keep: true }; };
  for await (const _ of b.turn(text, { msg: 'msg-2' })) { /* drain */ }
  assert.equal(typed, 1, 'a later message with the same words is its own');
  assert.ok(b.unsure.has('msg-1'));
  // Another transcript: its offset says nothing there.
  b.transcript = join(dirname(b.transcript), 'other.jsonl');
  writeFileSync(b.transcript, row({ type: 'queue-operation', operation: 'enqueue', content: text }));
  assert.equal(b.unsureOpen().length, 0);
  for await (const _ of b.turn(text, { msg: 'msg-1' })) { /* drain */ }
  assert.equal(typed, 2);
  b.unsure.set('msg-3', unsure(b, text));
  b.up = true;
  await b.release();
  assert.equal(b.unsure.size, 0, 'release');
  b.unsure.set('msg-4', unsure(b, text));
  b.tm = async () => ({ code: 0, out: '', err: '' });
  await b.stop();
  assert.equal(b.unsure.size, 0, 'stop');
});

test('a teammate that ended before an Enter keeps its name for that turn: its last report may still be queued', async () => {
  const b = brain();
  // The submit runs inside paste(): called as paste does, then nothing is typed.
  b.paste = async (_t: string, submit: () => void) => { submit(); return { ok: false, why: 'released', keep: true }; };
  const enter = async () => { for await (const _ of b.turn('next', {})) { /* drain */ } };
  b.own('toolu_1', 'scout', false, 'team-a');
  b.endedTeammates.add('scout');
  await enter();
  assert.ok(b.isOurs('scout'), 'kept at the first Enter after its end');
  await enter();
  assert.ok(!b.isOurs('scout'), 'gone at the next one');
  // Spawned again, and ended after that Enter: its end waits for an Enter of its own.
  b.own('toolu_2', 'scout', false, 'team-a');
  b.endedTeammates.add('scout');
  await enter();
  assert.ok(b.isOurs('scout'));
  await enter();
  assert.ok(!b.isOurs('scout'));
});

test('at a stop, a bare yes for a request asked after the cut is not carried, and its chat is not told of a cut', async () => {
  const dir = tmp('angelia-carry46-orch-');
  const cfg = Config.parse({ profiles: { a: { cwd: dir } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a', owners: ['1'] }], telegram: {} });
  const logs: string[] = [];
  const o = new Orchestrator(cfg, { telegram: { send: async () => {} } } as any, { stateDir: dir, log: (l) => logs.push(l) }) as any;
  const id = 'abcdef12-0000';
  o.brains.set('telegram:1', { alive: true, lastUsedAt: 0, pendingPermissionCount: 1, hasPendingPermission: (x: string) => x === id, release: async () => {} });
  o.cutTurns();
  // Asked between turns after the cut, by the pane the cut did not let go of.
  o.asks.set('telegram:1', new Map([[id, { id, tool: 'Bash', preview: 'ls', at: new Date().toISOString() }]]));
  await o.handle({ platform: 'telegram', chat: '1', sender: '1', senderName: 'Owner', text: 'yes', isGroup: false, mentioned: false, media: [] });
  assert.ok(logs.some((l) => /permission answer that came as the daemon stops is not carried key=telegram:1/.test(l)), logs.join('\n'));
  assert.ok(!existsSync(join(dir, CUT_TURNS)) || !JSON.parse(readFileSync(join(dir, CUT_TURNS), 'utf8')).keys.includes('telegram:1'));
  await o.shutdown();
});
