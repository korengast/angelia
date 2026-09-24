import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_SOCKET, ApiServer, claimSocket, loadOrMintToken, sessionToken } from '../src/daemon/api/server.js';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import type { Inbound } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));

/** One POST over the socket, with the status code (the client proper throws on errors). */
function caller(socket: string) {
  return (path: string, body: unknown) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ socketPath: socket, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('api: the owner token is minted mode 600 and reused, the socket is 600; send and turn need a token and a routed chat', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-api-'));
  const cfg = Config.parse({ profiles: { a: { cwd: here } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }], defaults: { max_out_per_min: 1000 } });
  const sent: string[] = [];
  const o = new Orchestrator(cfg, { telegram: { send: async (_c: string, text: string) => { sent.push(text); } }, whatsapp: { send: async () => {} } }, { stateDir: dir, bins: { 'claude-code': join(here, 'fake-claude.mjs') } });
  t.after(() => o.shutdown());
  const token = loadOrMintToken(join(dir, 'api.token'));
  const api = new ApiServer({ send: (k, x) => o.notify(k, x), turn: (k, x, a) => o.injectTurn(k, x, a), sendMedia: (k, m) => o.sendMediaTo(k, m), routed: (k) => o.routed(k) }, token);
  const socket = join(dir, API_SOCKET);
  await claimSocket(socket);
  await api.listen(socket); t.after(() => api.close());
  assert.equal(statSync(join(dir, 'api.token')).mode & 0o777, 0o600);
  assert.equal(statSync(socket).mode & 0o777, 0o600);
  assert.equal(loadOrMintToken(join(dir, 'api.token')), token, 'reused');
  await assert.rejects(claimSocket(socket), /another daemon answers/);
  const call = caller(socket);
  assert.equal((await call('/send', { token: 'nope', key: 'telegram:1', text: 'hi' })).status, 403);
  assert.equal((await call('/send', { token, key: 'telegram:9', text: 'hi' })).status, 404);
  assert.equal((await call('/send', { token, key: 'telegram:1', text: 'note from cron' })).status, 200);
  assert.deepEqual(sent, ['note from cron']);
  const r = await call('/turn', { token, key: 'telegram:1', text: 'daily card please' });
  assert.equal(r.status, 200);
  while (sent.length < 2) await new Promise((res) => setTimeout(res, 20));
  assert.match(sent[1], /^echo: \[telegram dm 1 · scheduled \(local\)\]\n\ndaily card please$/);
  assert.equal((await call('/nope', { token, key: 'telegram:1' })).status, 404);
});

test('api: an agent\'s token works for its own chat only, and its turns are never CLI commands', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-api-'));
  const cfg = Config.parse({ profiles: { a: { cwd: here }, b: { cwd: here } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }, { platform: 'telegram', chat: 2, profile: 'b' }], defaults: { max_out_per_min: 1000 } });
  const sent: { chat: string; text: string }[] = [];
  const token = loadOrMintToken(join(dir, 'api.token'));
  const o = new Orchestrator(cfg, { telegram: { send: async (chat: string, text: string) => { sent.push({ chat, text }); } }, whatsapp: { send: async () => {} } },
    { stateDir: dir, bins: { 'claude-code': join(here, 'fake-claude.mjs') }, sessionToken: (k) => sessionToken(token, k) });
  t.after(() => o.shutdown());
  const api = new ApiServer({ send: (k, x) => o.notify(k, x), turn: (k, x, a) => o.injectTurn(k, x, a), sendMedia: (k, m) => o.sendMediaTo(k, m), routed: (k) => o.routed(k) }, token);
  const socket = join(dir, API_SOCKET);
  await api.listen(socket); t.after(() => api.close());
  const call = caller(socket);
  const mine = sessionToken(token, 'telegram:1');
  assert.notEqual(mine, sessionToken(token, 'telegram:2'));
  assert.equal(mine, sessionToken(token, 'telegram:1'), 'stable: a pane that outlives the daemon keeps a working token');

  assert.equal((await call('/send', { token: mine, key: 'telegram:1', text: 'from my agent' })).status, 200);
  const other = await call('/send', { token: mine, key: 'telegram:2', text: 'into the other chat' });
  assert.equal(other.status, 403);
  assert.match(String(other.body.error), /works for its own chat/);
  assert.equal((await call('/turn', { token: mine, key: 'telegram:2', text: 'drive the other one' })).status, 403);
  assert.equal((await call('/send-media', { token: mine, key: 'telegram:2', path: '/etc/hosts' })).status, 403);
  assert.deepEqual(sent.map((m) => m.chat), ['1']);

  // A turn from the agent's own token is plain text, labelled as the agent's, even when it looks like a command.
  assert.equal((await call('/turn', { token: mine, key: 'telegram:1', text: '/logout' })).status, 200);
  while (sent.length < 2) await new Promise((res) => setTimeout(res, 20));
  assert.match(sent[1].text, /^echo: \[telegram dm 1 · this chat's agent \(local\)\]\n\n\/logout$/);
  // The agent of chat 1 was given chat 1's token, in its environment.
  const dm = (chat: string, text: string): Inbound => ({ platform: 'telegram', chat, sender: 'u1', text, isGroup: false, mentioned: false, media: [] });
  await o.handle(dm('1', 'ENVDUMP'));
  assert.equal(sent.at(-1)!.text, `env: ANGELIA_API_TOKEN=${mine}`);
  sent.length = 2;
  // The owner's token still sends a command bare.
  assert.equal((await call('/turn', { token, key: 'telegram:1', text: '/compact' })).status, 200);
  while (sent.length < 3) await new Promise((res) => setTimeout(res, 20));
  assert.equal(sent[2].text, 'echo: /compact');
});

test('api: a token file something widened is put back to 600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-api-'));
  const file = join(dir, 'api.token');
  writeFileSync(file, 'abc\n', { mode: 0o644 });
  let heard = 0;
  assert.equal(loadOrMintToken(file, (m) => { heard = m; }), 'abc');
  assert.equal(heard, 0o644);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('api: send-media checks the path once for every caller, and a MEDIA: line in /send is honoured', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-media-api-'));
  const cfg = Config.parse({ profiles: { a: { cwd: here } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }], defaults: { max_out_per_min: 1000 } });
  const sent: string[] = [];
  const files: string[] = [];
  const tg = {
    send: async (_c: string, text: string) => { sent.push(text); },
    sendMedia: async (_c: string, m: { path: string; kind: string; caption?: string }) => { files.push(`${m.kind} ${m.path.split('/').pop()} ${readFileSync(m.path).length}${m.caption ? ` :: ${m.caption}` : ''}`); },
  };
  const o = new Orchestrator(cfg, { telegram: tg, whatsapp: { send: async () => {} } }, { stateDir: dir });
  t.after(() => o.shutdown());
  const token = loadOrMintToken(join(dir, 'api.token'));
  const api = new ApiServer({ send: (k, x) => o.notify(k, x), turn: (k, x, a) => o.injectTurn(k, x, a), sendMedia: (k, m) => o.sendMediaTo(k, m), routed: (k) => o.routed(k) }, token);
  const socket = join(dir, API_SOCKET);
  await api.listen(socket); t.after(() => api.close());
  const call = caller(socket);
  const png = join(dir, 'chart.png'); writeFileSync(png, Buffer.alloc(64, 1));

  assert.equal((await call('/send-media', { token: 'nope', key: 'telegram:1', path: png })).status, 403);
  assert.equal((await call('/send-media', { token, key: 'telegram:9', path: png })).status, 404);
  const bad = await call('/send-media', { token, key: 'telegram:1', path: 'chart.png' });
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error), /absolute/);
  assert.equal((await call('/send-media', { token, key: 'telegram:1', path: join(dir, 'gone.png') })).status, 400);
  assert.equal((await call('/send-media', { token, key: 'telegram:1', path: png, caption: 'today' })).status, 200);
  assert.deepEqual(files, ['image chart.png 64 :: today'], 'a private copy of the checked file, same name, same bytes');

  const tagged = await call('/send', { token, key: 'telegram:1', text: `the chart\n\nMEDIA:${png}` });
  assert.equal(tagged.status, 200);
  assert.equal(tagged.body.media, 1);
  assert.deepEqual(sent, ['the chart']);
  assert.equal(files.length, 2);
});

test('/model and /effort: session-only overrides reach the next spawn, /status shows them, /new clears them', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-ovr-'));
  const cfg = Config.parse({ profiles: { a: { cwd: here, effort: 'low' } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }], defaults: { max_out_per_min: 1000 } });
  const sent: string[] = [];
  const o = new Orchestrator(cfg, { telegram: { send: async (_c: string, text: string) => { sent.push(text); } }, whatsapp: { send: async () => {} } }, { stateDir: dir, bins: { 'claude-code': join(here, 'fake-claude.mjs') }, env: { ...process.env, FAKE_CLAUDE_ECHO_ARGV: '1' } });
  t.after(() => o.shutdown());
  const dm = (text: string): Inbound => ({ platform: 'telegram', chat: '1', sender: 'u1', text, isGroup: false, mentioned: false, media: [] });
  await o.handle(dm('/effort'));
  assert.equal(sent.at(-1), 'effort for this session: (profile default: low)');
  await o.handle(dm('/effort turbo'));
  assert.match(sent.at(-1)!, /effort is one of/);
  await o.handle(dm('/model opus')); await o.handle(dm('/effort max'));
  await o.handle(dm('hi'));
  assert.match(sent.at(-1)!, /--model opus/); assert.match(sent.at(-1)!, /--effort max/);
  await o.handle(dm('/status'));
  assert.match(sent.at(-1)!, /model opus · effort max/);
  await o.handle(dm('/effort default')); await o.handle(dm('hi'));
  assert.match(sent.at(-1)!, /--effort low/); assert.match(sent.at(-1)!, /--model opus/);
  await o.handle(dm('/new')); await o.handle(dm('hi'));
  assert.doesNotMatch(sent.at(-1)!, /--model/);
});

test('api: profiles message each other with their own token and their own chat as from, labelled, unless one is isolated', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-api-'));
  const cfg = Config.parse({
    profiles: { a: { cwd: here }, b: { cwd: here }, walled: { cwd: here, isolated: true } },
    routes: [{ platform: 'telegram', chat: 1, profile: 'a' }, { platform: 'telegram', chat: 2, profile: 'b' }, { platform: 'telegram', chat: 3, profile: 'walled' }],
    defaults: { max_out_per_min: 1000 },
  });
  const sent: { chat: string; text: string }[] = [];
  const token = loadOrMintToken(join(dir, 'api.token'));
  const o = new Orchestrator(cfg, { telegram: { send: async (chat: string, text: string) => { sent.push({ chat, text }); } } },
    { stateDir: dir, bins: { 'claude-code': join(here, 'fake-claude.mjs') }, sessionToken: (k) => sessionToken(token, k) });
  t.after(() => o.shutdown());
  const api = new ApiServer({ send: (k, x, f) => o.notify(k, x, f), turn: (k, x, a, f) => o.injectTurn(k, x, a, f), sendMedia: (k, m) => o.sendMediaTo(k, m), routed: (k) => o.routed(k), reach: (f, to) => o.reach(f, to) }, token);
  const socket = join(dir, API_SOCKET);
  await api.listen(socket); t.after(() => api.close());
  const call = caller(socket);
  const a = sessionToken(token, 'telegram:1');

  assert.equal((await call('/send', { token: a, key: 'telegram:2', text: 'no from' })).status, 403, 'without from, a token is its own chat\'s only');
  assert.equal((await call('/send', { token: a, key: 'telegram:2', from: 'telegram:3', text: 'posing as walled' })).status, 403, 'from must be the token\'s own chat');
  assert.equal((await call('/send', { token: a, key: 'telegram:2', from: 'telegram:1', text: 'hello b' })).status, 200);
  assert.deepEqual(sent.at(-1), { chat: '2', text: '[from a] hello b' });
  assert.equal((await call('/turn', { token: a, key: 'telegram:2', from: 'telegram:1', text: '/logout' })).status, 200);
  while (!sent.some((m) => m.chat === '2' && m.text.startsWith('echo:'))) await new Promise((res) => setTimeout(res, 20));
  assert.match(sent.find((m) => m.text.startsWith('echo:'))!.text, /^echo: \[telegram dm 2 · profile a \(telegram:1\) \(profile\)\]\n\n\/logout$/, 'labelled as the other profile, and never a CLI command');

  const walled = await call('/turn', { token: a, key: 'telegram:3', from: 'telegram:1', text: 'hi' });
  assert.equal(walled.status, 403);
  assert.match(String(walled.body.error), /walled is isolated/);
  const out = await call('/send', { token: sessionToken(token, 'telegram:3'), key: 'telegram:1', from: 'telegram:3', text: 'out' });
  assert.match(String(out.body.error), /walled is isolated: it cannot message/);
  assert.equal((await call('/send-media', { token: a, key: 'telegram:2', from: 'telegram:1', path: '/etc/hosts' })).status, 403, 'files only into its own chat');

  // Two agents that keep answering each other stop by themselves.
  let n = 0, status = 200;
  while (status === 200 && n < 50) { status = (await call('/send', { token: a, key: 'telegram:2', from: 'telegram:1', text: `ping ${n++}` })).status; }
  assert.equal(status, 403);
  assert.ok(n <= 31, `stopped after ${n}`);
});
