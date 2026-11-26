import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { TAKEN_LATE_LINE, TuiBrain } from '../src/brain/tui.js';
import { promptKey } from '../scripts/turn-origin.mjs';
import { requestOrigin } from '../scripts/turn-origin.mjs';
import { mcpListConnectors } from '../src/brain/connectors-check.js';
import { claudeProjectKeys, planProfile } from '../src/capabilities/compile.js';
import { loadConfig } from '../src/instance/config/load.js';
import { Config } from '../src/instance/config/schema.js';
import { CUT_TURNS } from '../src/core/cut-turns.js';
import { Orchestrator } from '../src/core/orchestrator.js';

// The Lows carried into 0.4.5 from the 0.4.4 and connectors reviews.

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const brain = () => {
  const dir = tmp('angelia-carry-tui-');
  const profile = Config.parse({ profiles: { x: { cwd: dir, tui: true } }, routes: [] }).profiles.x;
  const b = new TuiBrain(profile, { id: '11111111-2222-3333-4444-555555555555', started: false }, { stateDir: join(dir, 'state') }) as any;
  b.transcript = join(dir, 'transcript.jsonl');
  writeFileSync(b.transcript, '');
  return b;
};
const row = (o: object) => `${JSON.stringify(o)}\n`;

test('a message taken late into the turn before is not typed a second time', async () => {
  const b = brain();
  b.ready = Promise.resolve(null);
  b.unsure.set(promptKey('and this too'), { key: promptKey('and this too'), text: 'and this too', transcript: b.transcript, offset: 0, at: Date.now(), answered: false });
  writeFileSync(b.transcript, row({ type: 'queue-operation', operation: 'enqueue', content: 'and this too' }));
  b.paste = () => assert.fail('typed');
  const events = [];
  for await (const e of b.turn('and this too')) events.push(e);
  assert.deepEqual(events, [{ kind: 'result', text: TAKEN_LATE_LINE, isError: false }]);
  assert.equal(b.unsure.size, 0);
});

test('a turn cut with no interrupt row: the next turn\'s start is still noted, not while a tool result is owed', () => {
  const b = brain();
  const at = new Date().toISOString();
  const user = (content: unknown, extra: object = {}) => JSON.stringify({ type: 'user', timestamp: at, message: { content }, ...extra });
  b.noteStart(user('first', { origin: { kind: 'human' } }), 0);
  b.noteStart(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1' }] } }), 10);
  b.noteStart(user('<task-notification>x</task-notification>', { origin: { kind: 'task-notification' } }), 20);
  assert.equal(b.turnStarts.length, 1, 'a tool result is owed');
  b.noteStart(user([{ type: 'tool_result', tool_use_id: 't1' }]), 30);
  b.noteStart(user('<task-notification>y</task-notification>', { origin: { kind: 'task-notification' } }), 40);
  assert.deepEqual(b.turnStarts.map((s: { at: number }) => s.at), [0, 40]);
});

test('teammates: the team must match when both say one; an ended name goes, a peer mark stays until then', () => {
  const b = brain();
  b.own('toolu_1', 'scout', true, 'session-a');
  assert.ok(b.isOurs('scout') && b.isOurs('scout@session-a'));
  assert.ok(!b.isOurs('scout@session-b'), 'the same name in another team');
  b.own('toolu_2', 'scout', false, 'session-a');
  assert.ok(b.peerTeammates.has('scout'), 'a respawn in a chat turn keeps the peer mark');
  b.openTeammates.set('scout', { id: 'toolu_2', at: Date.now() });
  b.noteBackground(row({ type: 'queue-operation', operation: 'enqueue', content: '<task-notification><tool-use-id>toolu_2</tool-use-id></task-notification>' }).trim());
  assert.ok(b.isOurs('scout'), 'its last report is still judged');
  b.dropEnded(b.endedTeammates);
  assert.ok(!b.isOurs('scout') && !b.peerTeammates.has('scout'));
  b.own('toolu_3', 'old', false);
  b.openTeammates.set('old', { id: 'toolu_3', at: 0 });
  assert.ok(!b.isOurs('old'), 'closed as lost: dropped');
});

test('a prompt tied only by the turn closed on the quiet path is held to that turn\'s time and count', () => {
  const b = brain();
  const key = 'a'.repeat(32);
  b.quietEnd = { sentAt: 100_000, endedAt: 200_000, said: '', key, taken: [], peer: false };
  const o = (promptAt: number | undefined, prompts = 1) => ({ origin: 'prompt', promptKeys: Array(prompts).fill(key), prompts, joins: 0, ...(promptAt === undefined ? {} : { promptAt }) });
  assert.equal(b.workOf(o(150_000)), 'chat');
  assert.equal(b.workOf(o(900_000)), 'none', 'typed later, in the app');
  assert.equal(b.workOf(o(undefined)), 'none');
  assert.equal(b.workOf(o(150_000, 2)), 'none');
});

test('an adopted turn carries every key; with none it asks instead of stepping aside', () => {
  const b = brain();
  const keys = ['a'.repeat(32), 'b'.repeat(32)];
  b.restoreTurnKey(keys[0], keys);
  assert.deepEqual(b.turnKeys(), keys);
  assert.ok(keys.every((k) => b.ownKeys().has(k)));
  const bare = brain();
  const asked: unknown[] = [];
  bare.relay.pass = () => assert.fail('passed to the pane dialog');
  bare.on('self-permission', (e: unknown) => asked.push(e));
  bare.selfRequest({ id: 'abcdef12', tool: 'Bash', input: {}, origin: { origin: 'prompt', promptKeys: [keys[0]], prompts: 1 } }, true);
  assert.equal(asked.length, 1);
  bare.selfBook.clear();
});

test('more than 20 task ids over a turn\'s starters: tied to nothing', () => {
  const note = (from: number, n: number) => ({ type: 'user', origin: { kind: 'task-notification' }, message: { content: `<task-notification>${Array.from({ length: n }, (_, i) => `<tool-use-id>toolu_${from + i}</tool-use-id>`).join('')}</task-notification>` } });
  const of = (a: number, b: number) => requestOrigin([note(0, a), note(100, b)].map(row).join('')) as { origin_ids?: string[] };
  assert.equal(of(10, 10).origin_ids?.length, 20);
  assert.equal(of(11, 10).origin_ids, undefined);
});

test('a stop writes the owed cut lines it is given, and the reaper keeps a pane with a teammate open', async () => {
  const dir = tmp('angelia-carry-orch-');
  const cfg = Config.parse({ profiles: { a: { cwd: dir } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }] });
  const o = new Orchestrator(cfg, {} as any, { stateDir: dir }) as any;
  let open = 1, released = 0;
  o.brains.set('telegram:1', { alive: true, lastUsedAt: 0, pendingPermissionCount: 0, openTeammateCount: () => open, release: async () => { released++; } });
  await o.reapIdle();
  assert.equal(released, 0);
  open = 0;
  await o.reapIdle();
  assert.equal(released, 1);
  await o.beforeStop(['telegram:9']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, CUT_TURNS), 'utf8')).keys, ['telegram:9']);
});

test('a worktree\'s main root only when the git folder links back; a bare repo\'s worktree by the bare folder', () => {
  const root = tmp('angelia-carry-git-');
  for (const [common, want] of [['repo/.git', 'repo'], ['bare.git', 'bare.git']]) {
    const gitdir = join(root, common, 'worktrees', 'w'), wt = join(root, `wt-${want}`);
    mkdirSync(gitdir, { recursive: true });
    mkdirSync(wt);
    writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`);
    writeFileSync(join(gitdir, 'commondir'), '../..\n');
    writeFileSync(join(gitdir, 'gitdir'), `${join(wt, '.git')}\n`);
    assert.deepEqual(claudeProjectKeys(wt), [wt, join(root, want)]);
    // A .git file made by hand that borrows this git folder: not linked back to it.
    const fake = join(root, `fake-${want}`);
    mkdirSync(fake);
    writeFileSync(join(fake, '.git'), `gitdir: ${gitdir}\n`);
    assert.deepEqual(claudeProjectKeys(fake), [fake]);
  }
});

test('connectors: all notes a given connector that a dropped one\'s address covers', () => {
  const root = tmp('angelia-carry-overlap-');
  const cwd = join(root, 'p'), home = join(root, 'home');
  mkdirSync(cwd); mkdirSync(home);
  const path = join(root, 'routing.yaml');
  writeFileSync(path, stringify({
    capabilities: { given: { kind: 'connector', url: 'https://x.example.com/mcp/v1' }, wide: { kind: 'connector', url: 'https://x.example.com/*' } },
    defaults: { connectors: 'all' }, profiles: { a: { cwd, capabilities: ['given'], deny: ['wide'] } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }], telegram: {},
  }));
  const notes = planProfile(loadConfig(path), 'a', { home, stateDir: join(root, 'state'), env: {} }).notes;
  assert.ok(notes.some((n) => n.startsWith('connectors: all: given is given to this profile, but its address overlaps that of wide')), notes.join('\n'));
});

test('a claude mcp list that never ends is killed with its group and answers null in time', async () => {
  const dir = tmp('angelia-carry-hang-');
  const bin = join(dir, 'claude');
  // It ignores SIGTERM and leaves a child holding its output.
  writeFileSync(bin, '#!/bin/sh\ntrap "" TERM\nsleep 30 &\nsleep 30\n', { mode: 0o755 });
  const t0 = Date.now();
  assert.equal(await mcpListConnectors(bin, dir, process.env, dir, undefined, 500), null);
  assert.ok(Date.now() - t0 < 10_000);
});
