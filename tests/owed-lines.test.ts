import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { NO_ANSWER_LINE } from '../src/core/deliver/text.js';
import type { Inbound } from '../src/core/types.js';

// What the chat is told when a turn ends with nothing for it, and what is kept for later when a line
// cannot be sent: only the agent's words.

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-claude.mjs');
const dm = (chat: string, text: string): Inbound => ({ platform: 'telegram', chat, sender: 'u1', senderName: 'Owner', text, isGroup: false, mentioned: false, media: [] });

/** One DM chat on the fake CLI, with the log kept and a sender that can be made to fail. */
function setupWithLog() {
  const cfg = Config.parse({ profiles: { a: { cwd: here } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }], defaults: { max_out_per_min: 1000 } });
  const sent: string[] = [], log: string[] = [];
  const net = { down: false };
  const sender = { send: async (_c: string, text: string) => { if (net.down) throw new Error('chat is gone'); sent.push(text); } };
  const o = new Orchestrator(cfg, { telegram: sender, whatsapp: sender }, { stateDir: mkdtempSync(join(tmpdir(), 'angelia-orch-')), bins: { 'claude-code': FAKE }, sendRetryMs: [10, 10], log: (l) => log.push(l) });
  return { o, sent, log, net };
}

test('the no-answer line is counted in the log, by chat', async (t) => {
  const { o, sent, log } = setupWithLog(); t.after(() => o.shutdown());
  await o.handle(dm('1', 'hello'));
  assert.ok(!log.some((l) => l.startsWith('no answer')), 'an answered turn is not counted');
  await o.handle(dm('1', 'EMPTY'));
  assert.equal(sent.at(-1), NO_ANSWER_LINE);
  assert.deepEqual(log.filter((l) => l.startsWith('no answer')), ['no answer key=telegram:1']);
  // A slash command that says nothing has its own line, and is not counted.
  await o.handle(dm('1', '/compact EMPTY'));
  assert.equal(sent.at(-1), '/compact done.');
  assert.equal(log.filter((l) => l.startsWith('no answer')).length, 1);
});

test('a line of Angelia\'s own that could not be sent is dropped; only the agent\'s words are kept for later', async (t) => {
  const { o, sent, log, net } = setupWithLog(); t.after(() => o.shutdown());
  const LATE = 'An answer that could not be delivered earlier';
  await o.handle(dm('1', 'warm up'));
  // The no-answer line, with the platform down: logged, and never posted later as an answer.
  net.down = true;
  await o.handle(dm('1', 'EMPTY'));
  assert.ok(log.some((l) => /^deliver failed key=telegram:1 chat is gone \(a status line of Angelia: dropped, not kept for later\)$/.test(l)), log.join('\n'));
  net.down = false; sent.length = 0;
  await o.handle(dm('1', '/status'));
  assert.equal(sent.length, 1, 'the status answer alone');
  assert.ok(!sent.some((s) => s.includes(LATE) || s.includes(NO_ANSWER_LINE)));
  // The same for a slash command's "done" line.
  net.down = true;
  await o.handle(dm('1', '/compact EMPTY'));
  net.down = false; sent.length = 0;
  await o.handle(dm('1', '/status'));
  assert.ok(!sent.some((s) => s.includes(LATE) || s.includes('/compact done.')), sent.join('\n'));
  // And for a usage limit: the CLI's line and the hint are of that moment, not an answer.
  net.down = true;
  await o.handle(dm('1', 'LIMITOK'));
  assert.ok(log.includes('usage limit key=telegram:1'));
  net.down = false; sent.length = 0;
  await o.handle(dm('1', '/status'));
  assert.ok(!sent.some((s) => s.includes(LATE) || s.includes('usage limit')), sent.join('\n'));
  // The agent's own answer is still kept, and goes out with the next line the chat is told.
  net.down = true;
  await o.handle(dm('1', 'hello'));
  assert.match(log.at(-1)!, /^deliver failed key=telegram:1 chat is gone$/);
  net.down = false; sent.length = 0;
  await o.handle(dm('1', '/status'));
  assert.match(sent.at(-1)!, /^An answer that could not be delivered earlier:\n\necho: .*hello/s);
});

test('"Could not attach that file" that cannot be sent either is dropped, not kept as an answer for later', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-tags-'));
  const cfg = Config.parse({ profiles: { tagged: { cwd: here, media_tags: true } }, routes: [{ platform: 'telegram', chat: 1, profile: 'tagged' }], defaults: { max_out_per_min: 1000 } });
  const sent: string[] = [], log: string[] = [];
  let down = true;
  // The platform takes the agent's words, then fails for the line about the file.
  const tg = { send: async (_c: string, text: string) => { if (down && text.startsWith('Could not attach')) throw new Error('chat is gone'); sent.push(text); }, sendMedia: async () => {} };
  const o = new Orchestrator(cfg, { telegram: tg, whatsapp: tg }, { stateDir: dir, bins: { 'claude-code': FAKE }, sendRetryMs: [10, 10], log: (l) => log.push(l) });
  t.after(() => o.shutdown());
  await o.handle(dm('1', `the chart\n\nMEDIA:${join(dir, 'no-such-file.png')}`));
  assert.match(sent.at(-1)!, /the chart/);
  assert.ok(log.some((l) => l.startsWith('media failure line not sent key=telegram:1 chat is gone')), log.join('\n'));
  assert.ok(!log.some((l) => l.startsWith('deliver failed')), 'the turn\'s delivery did not fail: the answer went out');
  down = false; sent.length = 0;
  await o.handle(dm('1', '/status'));
  assert.equal(sent.length, 1, 'the status answer alone');
  assert.ok(!sent.some((s) => s.includes('could not be delivered earlier') || s.includes('Could not attach')), sent.join('\n'));
});

test('an answer that is exactly [SILENT] posts nothing, not even the no-answer line', async (t) => {
  const { o, sent, log } = setupWithLog(); t.after(() => o.shutdown());
  await o.handle(dm('1', 'SAYSILENT'));
  assert.deepEqual(sent, []);
  assert.ok(log.includes('silent key=telegram:1'));
  assert.ok(!log.some((l) => l.startsWith('no answer')));
});
