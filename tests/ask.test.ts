import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { AskError, ASK_NOTE } from '../src/brain/ask.js';
import { API_SOCKET, ApiServer, claimSocket, loadOrMintToken, sessionToken } from '../src/daemon/api/server.js';
import { apiDeps } from '../src/daemon/api/deps.js';
import type { Inbound } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-claude.mjs');

function setup(extra: Record<string, unknown> = {}) {
  const cfg = Config.parse({
    profiles: { home: { cwd: here, model: 'opus', add_dirs: ['/tmp'], answer_from: ['social'] }, social: { cwd: here, answer_from: ['home'] }, side: { cwd: here, backend: 'grok', answer_from: ['*'] }, quiet: { cwd: here } },
    routes: [
      { platform: 'telegram', chat: 1, profile: 'home' },
      { platform: 'telegram', chat: 2, profile: 'social' },
      { platform: 'telegram', chat: -100, profile: 'home' },
      { platform: 'telegram', chat: 3, profile: 'side' },
      { platform: 'telegram', chat: 4, profile: 'social' },
      { platform: 'telegram', chat: 5, profile: 'social' },
      { platform: 'telegram', chat: 6, profile: 'quiet' },
    ],
    defaults: { max_out_per_min: 1000 },
    onboard: { owners: ['1'] },
    ...extra,
  });
  const sent: { chat: string; text: string }[] = [];
  const sender = { send: async (chat: string, text: string) => { sent.push({ chat, text }); } };
  const o = new Orchestrator(cfg, { telegram: sender, whatsapp: sender }, { stateDir: mkdtempSync(join(tmpdir(), 'angelia-ask-')), bins: { 'claude-code': FAKE } });
  return { o, sent, cfg };
}
const dm = (chat: string, text: string): Inbound => ({ platform: 'telegram', chat, sender: 'u1', senderName: 'Owner', text, isGroup: false, mentioned: false, media: [] });
const parsed = (answer: string) => JSON.parse(answer) as { argv: string[]; prompt: string; cwd: string };

test('ask: a fresh chat is asked in a read-only session of its own, and the asker gets the answer', async (t) => {
  const { o, sent } = setup(); t.after(() => o.shutdown());
  const a = parsed(await o.ask('telegram:1', 'what is in the inbox?', 'telegram:2'));
  for (const f of ['-p', '--no-session-persistence', '--strict-mcp-config']) assert.ok(a.argv.includes(f), f);
  assert.equal(a.argv[a.argv.indexOf('--settings') + 1], '{"disableAllHooks":true}');
  assert.ok(a.argv[a.argv.indexOf('--append-system-prompt') + 1].endsWith(ASK_NOTE));
  assert.equal(a.argv[a.argv.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.equal(a.argv[a.argv.indexOf('--permission-mode') + 1], 'default');
  assert.equal(a.argv[a.argv.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.ok(!a.argv.includes('--resume'), 'no session yet: nothing to fork');
  assert.deepEqual([a.argv[a.argv.indexOf('--model') + 1], a.argv[a.argv.indexOf('--add-dir') + 1]], ['opus', '/tmp']);
  assert.match(a.prompt, /^\[telegram dm 1 · profile social \(telegram:2\) \(profile\)\]\n\nwhat is in the inbox\?$/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat, '1');
  assert.equal(sent[0].text, '📨 social asked: what is in the inbox? (answered)');
  // A DM with someone who is not an owner hears nothing: another profile's topic is not theirs.
  sent.length = 0;
  await o.ask('telegram:4', 'a question', 'telegram:1');
  assert.deepEqual(sent, []);
});

test('ask: a chat with a session is asked in a fork of it, beside a turn still running, and a group hears nothing', async (t) => {
  const { o, sent } = setup(); t.after(() => o.shutdown());
  await o.handle(dm('1', 'hello'));
  const id = o.map.getActive('telegram:1')!.id;
  const slow = o.handle(dm('1', 'SLOW work'));
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  const a = parsed(await o.ask('telegram:1', 'how is it going?', 'telegram:2'));
  assert.ok(Date.now() - t0 < 2500, 'answered without waiting for the running turn');
  assert.deepEqual(a.argv.slice(a.argv.indexOf('--resume'), a.argv.indexOf('--resume') + 3), ['--resume', id, '--fork-session']);
  await slow;
  sent.length = 0;
  await o.ask('telegram:-100', 'a group question', 'telegram:2');
  assert.deepEqual(sent, [], 'no line in a group: its members must not see another profile\'s topic');
});

test('ask: a made-up thread is the same chat for every limit, and an asker cannot ask itself through one', async (t) => {
  const { o } = setup(); t.after(() => o.shutdown());
  const two = [o.ask('telegram:1:a', 'ASKSLOW a', 'telegram:2'), o.ask('telegram:1:b', 'ASKSLOW b', 'telegram:2')];
  await assert.rejects(o.ask('telegram:1:c', 'a third', 'telegram:2'), (e: AskError) => e.status === 429);
  await Promise.all(two);
  await assert.rejects(o.ask('telegram:2:x', 'me?', 'telegram:2'), (e: AskError) => e.status === 400);
  // Four at once across chats, then no more.
  const four = [o.ask('telegram:1', 'ASKSLOW 1', 'telegram:2'), o.ask('telegram:1', 'ASKSLOW 2', 'telegram:2'), o.ask('telegram:-100', 'ASKSLOW 3', 'telegram:2'), o.ask('telegram:-100', 'ASKSLOW 4', 'telegram:2')];
  await assert.rejects(o.ask('telegram:5', 'a fifth', 'telegram:1'), (e: AskError) => e.status === 429 && /4 questions/.test(e.message));
  await Promise.all(four);
});

test('ask: a question the asker gave up on stops its copy', async (t) => {
  const { o, sent } = setup(); t.after(() => o.shutdown());
  const gone = new AbortController();
  const p = o.ask('telegram:1', 'ASKSLOW then gone', 'telegram:2', gone.signal);
  setTimeout(() => gone.abort(), 200);
  await assert.rejects(p, (e: AskError) => e.status === 499);
  assert.deepEqual(sent, []);
});

test('ask: refusals say why, and at most two questions run at once per chat', async (t) => {
  const { o } = setup(); t.after(() => o.shutdown());
  await assert.rejects(o.ask('telegram:9', 'x', 'telegram:2'), (e: AskError) => e.status === 404);
  await assert.rejects(o.ask('telegram:3', 'x', 'telegram:2'), (e: AskError) => e.status === 501 && /grok profile is not supported yet/.test(e.message));
  await assert.rejects(o.ask('telegram:1', 'ASKFAIL', 'telegram:2'), (e: AskError) => e.status === 502);
  const two = [o.ask('telegram:1', 'ASKSLOW a', 'telegram:2'), o.ask('telegram:1', 'ASKSLOW b', 'telegram:2')];
  await assert.rejects(o.ask('telegram:1', 'a third', 'telegram:2'), (e: AskError) => e.status === 429);
  await Promise.all(two);
  assert.ok(parsed(await o.ask('telegram:1', 'after', 'telegram:2')).prompt.endsWith('after'));
});

function post(socket: string, path: string, body: unknown) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ socketPath: socket, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('ask over the API (the daemon\'s wiring): another chat\'s agent gets the answer; its own chat is refused', async (t) => {
  const { o } = setup();
  const dir = mkdtempSync(join(tmpdir(), 'angelia-ask-api-'));
  const token = loadOrMintToken(join(dir, 'api.token'));
  const api = new ApiServer(apiDeps(o), token);
  const socket = join(dir, API_SOCKET);
  await claimSocket(socket);
  await api.listen(socket);
  t.after(async () => { await api.close(); await o.shutdown(); });
  const social = sessionToken(token, 'telegram:2');
  const r = await post(socket, '/ask', { token: social, key: 'telegram:1', from: 'telegram:2', text: 'what changed today?' });
  assert.equal(r.status, 200);
  assert.match(parsed(String(r.body.answer)).prompt, /profile social \(telegram:2\)/);
  assert.equal((await post(socket, '/ask', { token: sessionToken(token, 'telegram:1'), key: 'telegram:1', text: 'me?' })).status, 400);
  assert.equal((await post(socket, '/ask', { token: social, key: 'telegram:3', from: 'telegram:2', text: 'x' })).status, 501);
});

test('ask: a profile answers only the profiles in its answer_from; the owner always', async (t) => {
  const { o } = setup(); t.after(() => o.shutdown());
  await assert.rejects(o.ask('telegram:6', 'what is new?', 'telegram:2'), (e: AskError) => e.status === 403 && /does not answer questions from social; its owner can add it to answer_from/.test(e.message));
  await assert.rejects(o.ask('telegram:1', 'x', 'telegram:-100'), (e: AskError) => e.status === 403, 'home asking home through another chat is not in its own list');
  assert.ok(parsed(await o.ask('telegram:6', 'from the owner')).prompt.endsWith('from the owner'), 'the owner, from a terminal, needs no list');
  await assert.rejects(o.ask('telegram:3', 'x', 'telegram:6'), (e: AskError) => e.status === 501, '"*" lets everyone ask');
});
