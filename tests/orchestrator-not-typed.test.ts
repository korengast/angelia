import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { notDeliveredLine } from '../src/core/deliver/text.js';
import type { Inbound } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));

function setup() {
  const cfg = Config.parse({ profiles: { a: { cwd: here } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }], defaults: { max_out_per_min: 1000 } });
  const sent: string[] = [];
  const o = new Orchestrator(cfg, { telegram: { send: async (_c: string, text: string) => { sent.push(text); } } },
    { stateDir: mkdtempSync(join(tmpdir(), 'angelia-orch-nt-')), bins: { 'claude-code': join(here, 'fake-claude.mjs') } });
  return { o, sent };
}
const dm = (text: string): Inbound => ({ platform: 'telegram', chat: '1', sender: 'u1', senderName: 'Owner', text, isGroup: false, mentioned: false, media: [] });

/** A tmux brain stand-in: the first turn's message is not typed (the pane busy with its own work), the next is answered. */
function pane(events: string[], first: Record<string, unknown>) {
  let turns = 0;
  return {
    name: 'pane-1', alive: true, lastUsedAt: 0, pendingPermissionCount: 0,
    on() { return this; }, start() {}, kill() { events.push('kill'); },
    async release() { events.push('release'); }, async stop() { events.push('stop'); this.alive = false; },
    async *turn() { turns++; yield turns === 1 ? first : { kind: 'result', text: 'answered', isError: false }; },
  };
}

test('a message not typed into a live, busy pane leaves the pane running and tells the chat to send again', async (t) => {
  const { o, sent } = setup(); t.after(() => o.shutdown());
  const events: string[] = [];
  const reason = 'not delivered: the session stayed busy for 10 minutes with work of its own (a background task\'s report, or a turn typed in the Claude app)';
  const b = pane(events, { kind: 'result', text: '', isError: true, reason, keep: true });
  const brains = (o as unknown as { brains: Map<string, unknown> }).brains;
  brains.set('telegram:1', b);
  await o.handle(dm('hello'));
  assert.deepEqual(events, [], 'the pane is neither stopped nor killed: its background agents live in it');
  assert.equal(brains.get('telegram:1'), b, 'the pool still holds the same pane');
  assert.deepEqual(sent, [notDeliveredLine(reason)]);
  assert.match(sent[0], /did not reach the agent: the session stayed busy for 10 minutes/);
  assert.ok(!sent.some((s) => /Something broke/.test(s)));
  await o.handle(dm('hello again'));
  assert.equal(sent.at(-1), 'answered', 'the next message goes to the same pane');
  assert.deepEqual(events, []);
});

test('a failed turn without keep still ends the pane, as before (a hung or dead one)', async (t) => {
  const { o, sent } = setup(); t.after(() => o.shutdown());
  const events: string[] = [];
  const brains = (o as unknown as { brains: Map<string, unknown> }).brains;
  brains.set('telegram:1', pane(events, { kind: 'result', text: '', isError: true, reason: 'the message could not be typed into the session (no prompt, or Claude Code did not take it)' }));
  await o.handle(dm('hello'));
  assert.deepEqual(events, ['stop']);
  assert.match(sent.at(-1)!, /^Something broke on my side/);
});
