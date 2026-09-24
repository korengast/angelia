import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { exitReason } from '../src/brain/claude.js';
import { OWNER_COMMANDS } from '../src/core/router/gate.js';
import type { Inbound } from '../src/core/types.js';

/**
 * The failure paths an external review found live on a running instance, 2026-09-20. Every test
 * here is a thing that used to take the daemon, the chat or the machine down quietly.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-claude.mjs');

function setup(bin = FAKE) {
  const cfg = Config.parse({
    profiles: { a: { cwd: here } },
    routes: [
      { platform: 'telegram', chat: 1, profile: 'a' },
      { platform: 'whatsapp', chat: 'g@g.us', profile: 'a', mention: 'any', owners: ['u1'], allow_from: ['*'] },
    ],
    defaults: { max_out_per_min: 1000 },
  });
  const sent: string[] = [];
  const log: string[] = [];
  const sender = { send: async (_c: string, text: string) => { sent.push(text); } };
  const o = new Orchestrator(cfg, { telegram: sender, whatsapp: sender },
    { stateDir: mkdtempSync(join(tmpdir(), 'angelia-res-')), bins: { 'claude-code': bin }, log: (l) => log.push(l) });
  return { o, sent, log };
}
const msg = (text: string, extra: Partial<Inbound> = {}): Inbound =>
  ({ platform: 'telegram', chat: '1', sender: 'u1', senderName: 'Owner', text, isGroup: false, mentioned: false, media: [], ...extra });

test('a first turn that can never work is retried once, not forever', async (t) => {
  // No such binary: the spawn raises `error` and never `exit`, which is the shape of every
  // deterministic failure - not logged in, an unknown flag, no tmux. The reviewer's probe on the
  // unbounded version: 110 respawns and 111 sessions in four seconds, with the chat told nothing.
  const { o, sent, log } = setup(join(here, 'no-such-claude.mjs')); t.after(() => o.shutdown());
  await o.handle(msg('hello'));
  assert.equal(sent.length, 1, 'exactly one answer');
  assert.match(sent[0], /^Something broke on my side \(exit: spawn .*ENOENT\)\. Try again, or \/new\.$/);
  assert.equal(log.filter((l) => l.startsWith('retry with fresh session')).length, 1, 'one retry');
  assert.ok(o.map.list('telegram:1').length <= 2, `${o.map.list('telegram:1').length} sessions minted`);
});

test('the reason the child died survives into the log instead of a bare "exit"', () => {
  assert.equal(exitReason(''), 'exit');
  assert.equal(exitReason('\n  Invalid API key · Fix external API key\n'), 'exit: Invalid API key · Fix external API key');
  assert.equal(exitReason('x'.repeat(500)).length, 'exit: '.length + 200);
});

test('/stop mid-turn is not reported as a crash', async (t) => {
  const { o, sent, log } = setup(); t.after(() => o.shutdown());
  const turn = o.handle(msg('SLOW hello'));
  await new Promise((r) => setTimeout(r, 150));
  await o.handle(msg('/stop'));
  await turn;
  assert.deepEqual(sent, ['Stopped.'], 'the stop line, and no failure line after it');
  assert.ok(log.some((l) => l.includes('stopped by the user')));
});

test('a send that throws mid-turn does not leave the agent running', async (t) => {
  const cfg = Config.parse({ profiles: { a: { cwd: here } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }], defaults: { max_out_per_min: 1000 } });
  let fail = false;
  const sender = { send: async () => { if (fail) throw new Error('chat is gone'); } };
  const o = new Orchestrator(cfg, { telegram: sender, whatsapp: sender },
    { stateDir: mkdtempSync(join(tmpdir(), 'angelia-res-')), bins: { 'claude-code': FAKE } });
  t.after(() => o.shutdown());
  await o.handle(msg('warm up'));
  fail = true;
  await o.handle(msg('hello')); // must not reject: the queue entry would carry the throw
  assert.equal(o.status().filter((s) => s.alive).length, 1, 'still exactly one brain, still owned');
});

test('router commands that change the session are owners-only in a group', async (t) => {
  const { o, sent } = setup(); t.after(() => o.shutdown());
  const fromGroup = (text: string, sender: string) =>
    o.handle(msg(text, { platform: 'whatsapp', chat: 'g@g.us', isGroup: true, mentioned: true, sender, allow_from: ['*'] }));
  for (const cmd of ['/new', '/stop', '/resume', '/model opus', '/effort high', '/sh echo hi']) {
    sent.length = 0;
    await fromGroup(cmd, 'stranger');
    assert.equal(sent.length, 1, cmd);
    assert.match(sent[0], /owner/i, `${cmd} must be refused for a non-owner`);
  }
  // What a member may still do: find out where they are.
  sent.length = 0;
  await fromGroup('/status', 'stranger');
  assert.doesNotMatch(sent[0], /owner/i);
  assert.ok(OWNER_COMMANDS.has('model') && !OWNER_COMMANDS.has('status'));
});
