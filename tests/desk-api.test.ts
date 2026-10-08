import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_SOCKET, ApiServer, claimSocket, loadOrMintToken, sessionToken } from '../src/daemon/api/server.js';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { apiDeps } from '../src/daemon/api/deps.js';
import type { ChatEvent } from '../src/core/events.js';
import { projectFolder } from '../src/brain/transcripts.js';

const here = dirname(fileURLToPath(import.meta.url));

/** A daemon's API over a real socket, on a fake Claude, with what each chat was sent. */
async function setup(t: { after(fn: () => unknown): void }, transcripts?: string, permissionMinutes?: number, cwd = here) {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-desk-'));
  const cfg = Config.parse({
    profiles: { a: { cwd, model: 'm1', add_dirs: ['/tmp'] }, b: { cwd: here } },
    routes: [{ platform: 'telegram', chat: 1, profile: 'a' }, { platform: 'telegram', chat: 2, profile: 'b' }],
    defaults: { max_out_per_min: 1000, ...(permissionMinutes ? { permission_timeout_minutes: permissionMinutes } : {}) },
  });
  const sent: { chat: string; text: string }[] = [];
  const o = new Orchestrator(cfg, { telegram: { send: async (chat: string, text: string) => { sent.push({ chat, text }); } }, whatsapp: { send: async () => {} } },
    { stateDir: dir, bins: { 'claude-code': join(here, 'fake-claude.mjs') }, ...(transcripts ? { transcripts } : {}) });
  const token = loadOrMintToken(join(dir, 'api.token'));
  // The daemon's own wiring: a test with its own would pass where the daemon fails.
  const api = new ApiServer(apiDeps(o, cfg, () => ({ pid: 1, sessions: o.status() })), token);
  const socket = join(dir, API_SOCKET);
  await claimSocket(socket);
  await api.listen(socket);
  t.after(async () => { await api.close(); await o.shutdown(); });
  return { o, token, socket, sent, api };
}

function post(socket: string, path: string, body: unknown, bearer?: string) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) };
    const req = request({ socketPath: socket, path, method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function get(socket: string, path: string, token?: string) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ socketPath: socket, path, method: 'GET', headers: token ? { authorization: `Bearer ${token}` } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Subscribe to `/events` and collect what arrives; resolves once the stream is open. */
function listen(socket: string, token: string, key = '') {
  const events: ChatEvent[] = [];
  return new Promise<{ events: ChatEvent[]; status: number; stop(): void; until(p: (e: ChatEvent[]) => boolean): Promise<void> }>((resolve, reject) => {
    const req = request({ socketPath: socket, path: `/events${key ? `?key=${encodeURIComponent(key)}` : ''}`, method: 'GET', headers: { authorization: `Bearer ${token}` } }, (res) => {
      let buf = '';
      res.on('data', (c: Buffer) => {
        buf += c.toString('utf8');
        let at;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, at); buf = buf.slice(at + 2);
          if (block.startsWith('data: ')) events.push(JSON.parse(block.slice(6)));
        }
      });
      res.on('error', () => {});
      const until = async (p: (e: ChatEvent[]) => boolean) => {
        const end = Date.now() + 10_000;
        while (!p(events)) { if (Date.now() > end) throw new Error(`timed out; events: ${JSON.stringify(events)}`); await new Promise((r) => setTimeout(r, 20)); }
      };
      resolve({ events, status: res.statusCode ?? 0, stop: () => req.destroy(), until });
    });
    req.on('error', reject);
    req.end();
  });
}

test('desk api: an app turn answers on the event stream only, never in the chat', async (t) => {
  const { token, socket, sent } = await setup(t);
  const s = await listen(socket, token);
  assert.equal(s.status, 200);
  const r = await post(socket, '/turn', { token, key: 'telegram:1', text: 'PROGRESS hello from the desk', reply: 'caller' });
  assert.equal(r.status, 200);
  await s.until((e) => e.some((x) => x.type === 'turn-end'));
  s.stop();
  const types = s.events.map((e) => e.type);
  assert.equal(types[0], 'turn');
  assert.equal(types.at(-1), 'turn-end');
  const start = s.events[0] as Extract<ChatEvent, { type: 'turn' }>;
  assert.equal(start.key, 'telegram:1');
  assert.equal(start.surface, 'app');
  assert.equal(start.text, 'PROGRESS hello from the desk');
  assert.ok(s.events.some((e) => e.type === 'progress' && e.text === 'working on it'), 'progress streams live');
  const out = s.events.filter((e) => e.type === 'out') as Extract<ChatEvent, { type: 'out' }>[];
  assert.equal(out.length, 1);
  assert.match(out[0].text, /desk app \(local\)\]\n\nPROGRESS hello from the desk$/, 'the agent is told it came from the owner in the app');
  assert.equal((s.events.at(-1) as Extract<ChatEvent, { type: 'turn-end' }>).ok, true);
  assert.deepEqual(sent, [], 'nothing reached the chat');
});

test('desk api: a chat turn goes to the chat as before and is streamed too; the key filter holds', async (t) => {
  const { o, token, socket, sent } = await setup(t);
  const one = await listen(socket, token, 'telegram:1');
  const two = await listen(socket, token, 'telegram:2');
  await o.handle({ platform: 'telegram', chat: '1', sender: '1', text: 'hi there', isGroup: false, mentioned: true, media: [] });
  await one.until((e) => e.some((x) => x.type === 'turn-end'));
  one.stop(); two.stop();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /hi there$/);
  const start = one.events[0] as Extract<ChatEvent, { type: 'turn' }>;
  assert.equal(start.surface, 'chat');
  assert.ok(one.events.some((e) => e.type === 'out' && e.text === sent[0].text), 'the stream shows what the chat got');
  assert.deepEqual(two.events, [], 'another chat\'s stream saw nothing');
});

test('desk api: reads and the stream take the owner\'s token only; reply-to-caller too', async (t) => {
  const { token, socket } = await setup(t);
  const agent = sessionToken(token, 'telegram:1');
  for (const path of ['/status', '/profiles', '/sessions?key=telegram:1', '/events']) {
    assert.equal((await get(socket, path)).status, 403, `${path} without a token`);
    assert.equal((await get(socket, path, agent)).status, 403, `${path} with an agent's token`);
  }
  assert.equal((await post(socket, '/turn', { token: agent, key: 'telegram:1', text: 'x', reply: 'caller' })).status, 403);
  assert.equal((await post(socket, '/permission', { token: agent, key: 'telegram:1', id: 'abc', allow: true })).status, 403);
  assert.equal((await get(socket, '/sessions?key=telegram:9', token)).status, 404);

  const status = await get(socket, '/status', token);
  assert.equal(status.status, 200);
  assert.equal(status.body.pid, 1);
  const profiles = await get(socket, '/profiles', token);
  assert.deepEqual(profiles.body.profiles.map((p: { name: string }) => p.name), ['a', 'b'], 'the table\'s order');
  assert.equal(profiles.body.profiles[0].model, 'm1');
  assert.deepEqual(profiles.body.profiles[0].settings.add_dirs, ['/tmp']);
  assert.equal(profiles.body.profiles[0].settings.permission_mode, 'acceptEdits');
  assert.deepEqual((await get(socket, '/sessions?key=telegram:1', token)).body, { active: null, sessions: [] });
});

test('desk api: sessions list the chat\'s sessions once it has one', async (t) => {
  const { o, token, socket } = await setup(t);
  const s = await listen(socket, token, 'telegram:1');
  await o.handle({ platform: 'telegram', chat: '1', sender: '1', text: 'first message', isGroup: false, mentioned: true, media: [] });
  await s.until((e) => e.some((x) => x.type === 'turn-end'));
  s.stop();
  const r = await get(socket, '/sessions?key=telegram:1', token);
  assert.equal(r.body.sessions.length, 1);
  assert.equal(r.body.active, r.body.sessions[0].id);
  assert.equal(r.body.sessions[0].label, 'first message');
});

test('desk api: a chat turn\'s permission request can be answered from the app; the first answer wins and the chat is told', async (t) => {
  const { o, token, socket, sent } = await setup(t);
  const s = await listen(socket, token, 'telegram:1');
  // Not awaited: the turn waits for the answer this test gives.
  const turn = o.handle({ platform: 'telegram', chat: '1', sender: '1', text: 'PERM run it', isGroup: false, mentioned: true, media: [] });
  await s.until((e) => e.some((x) => x.type === 'permission'));
  const ask = s.events.find((e) => e.type === 'permission') as Extract<ChatEvent, { type: 'permission' }>;
  assert.ok(sent.some((m) => m.text.includes(ask.id.slice(0, 4))), 'the chat got the prompt too');
  assert.equal((await post(socket, '/permission', { token, key: 'telegram:1', id: ask.id, allow: true })).status, 200);
  assert.equal((await post(socket, '/permission', { token, key: 'telegram:1', id: ask.id, allow: false })).status, 409, 'already answered');
  await turn;
  await s.until((e) => e.some((x) => x.type === 'turn-end'));
  s.stop();
  assert.ok(s.events.some((e) => e.type === 'permission-answered' && e.by === 'app' && e.allow));
  assert.ok(sent.some((m) => m.text === 'Permission allowed from the desk app.'));
  assert.ok(sent.some((m) => /tool allowed/.test(m.text)), 'the agent went on with the tool');
});

test('desk api: an app turn\'s permission request stays off the chat', async (t) => {
  const { token, socket, sent } = await setup(t);
  const s = await listen(socket, token, 'telegram:1');
  await post(socket, '/turn', { token, key: 'telegram:1', text: 'PERM run it', reply: 'caller' });
  await s.until((e) => e.some((x) => x.type === 'permission'));
  const ask = s.events.find((e) => e.type === 'permission') as Extract<ChatEvent, { type: 'permission' }>;
  assert.equal((await post(socket, '/permission', { token, key: 'telegram:1', id: ask.id, allow: false })).status, 200);
  await s.until((e) => e.some((x) => x.type === 'turn-end'));
  s.stop();
  assert.ok(s.events.some((e) => e.type === 'out' && /tool deny/.test(e.text)), JSON.stringify(s.events));
  assert.deepEqual(sent, []);
});

test('desk api: closing the server does not wait for an open event stream', async (t) => {
  const { token, socket, api } = await setup(t);
  await listen(socket, token);
  const closed = await Promise.race([api.close().then(() => true), new Promise((r) => setTimeout(() => r(false), 2000))]);
  assert.equal(closed, true);
});

test('desk api: history comes from the session\'s transcript, and only for a session the chat has had', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'angelia-desk-tx-'));
  const { o, token, socket } = await setup(t, root);
  assert.deepEqual((await get(socket, '/history?key=telegram:1', token)).body, { session: null, supported: true, items: [], more: false });
  const s = await listen(socket, token, 'telegram:1');
  await o.handle({ platform: 'telegram', chat: '1', sender: '1', text: 'hello', isGroup: false, mentioned: true, media: [] });
  await s.until((e) => e.some((x) => x.type === 'turn-end'));
  s.stop();
  const id = o.sessionsOf('telegram:1').active!;
  mkdirSync(join(root, projectFolder(here)), { recursive: true });
  writeFileSync(join(root, projectFolder(here), `${id}.jsonl`), [
    { type: 'user', timestamp: '2026-09-29T10:00:00Z', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', timestamp: '2026-09-29T10:00:01Z', message: { id: 'm1', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'hi back' }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const h = await get(socket, '/history?key=telegram:1', token);
  assert.equal(h.status, 200);
  assert.equal(h.body.session, id);
  assert.deepEqual(h.body.items.map((i: { role: string; text: string; tools?: string[] }) => [i.role, i.text, i.tools ?? []]), [['user', 'hello', []], ['assistant', 'hi back', ['Read']]]);
  // One message per page: the cursor reaches the older one over the API too.
  const newest = await get(socket, '/history?key=telegram:1&limit=1', token);
  assert.deepEqual([newest.body.items[0].text, newest.body.more, typeof newest.body.cursor], ['hi back', true, 'string']);
  const older = await get(socket, `/history?key=telegram:1&limit=1&before=${newest.body.cursor}`, token);
  assert.deepEqual([older.body.items[0].text, older.body.more], ['hello', false]);
  assert.equal((await get(socket, `/history?key=telegram:1&session=${encodeURIComponent('../../etc/passwd')}`, token)).status, 404, 'an id the chat never had');
  assert.equal((await get(socket, `/history?key=telegram:2&session=${id}`, token)).status, 404, 'another chat\'s session');
  assert.equal((await get(socket, '/history?key=telegram:1', sessionToken(token, 'telegram:1'))).status, 403, 'not with an agent\'s token');
});

test('desk api: a pi chat\'s history comes from pi\'s own session file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-desk-pi-'));
  const home = mkdtempSync(join(tmpdir(), 'angelia-desk-pihome-'));
  const cfg = Config.parse({ profiles: { p: { cwd: here, backend: 'pi' } }, routes: [{ platform: 'telegram', chat: 3, profile: 'p' }], defaults: { max_out_per_min: 1000 } });
  const o = new Orchestrator(cfg, { telegram: { send: async () => {} }, whatsapp: { send: async () => {} } },
    { stateDir: dir, bins: { pi: join(here, 'fake-pi.mjs') }, cliHome: home });
  const token = loadOrMintToken(join(dir, 'api.token'));
  const api = new ApiServer(apiDeps(o, cfg, () => ({ pid: 1, sessions: o.status() })), token);
  const socket = join(dir, API_SOCKET);
  await claimSocket(socket);
  await api.listen(socket);
  t.after(async () => { await api.close(); await o.shutdown(); });
  const s = await listen(socket, token, 'telegram:3');
  await o.handle({ platform: 'telegram', chat: '3', sender: '1', text: 'hello', isGroup: false, mentioned: true, media: [] });
  await s.until((e) => e.some((x) => x.type === 'turn-end'));
  s.stop();
  const id = o.sessionsOf('telegram:3').active!;
  assert.deepEqual((await get(socket, '/history?key=telegram:3', token)).body, { session: id, supported: true, items: [], more: false }, 'no file yet');
  const folder = join(home, '.pi', 'agent', 'sessions', '--project--');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `2026-10-08T07-11-16-672Z_${id}.jsonl`), [
    { type: 'session', version: 3, id, timestamp: '2026-10-08T07:11:16Z', cwd: here },
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-10-08T07:11:17Z', message: { role: 'user', content: 'hello' } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-10-08T07:11:18Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'read', arguments: {} }, { type: 'text', text: 'hi back' }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const h = await get(socket, '/history?key=telegram:3', token);
  assert.deepEqual([h.body.supported, h.body.items.map((i: { role: string; text: string; tools?: string[] }) => [i.role, i.text, i.tools ?? []])],
    [true, [['user', 'hello', []], ['assistant', 'hi back', ['read']]]]);
});

test('desk api: a grok chat\'s history is replayed by grok, kept, and read again after the chat\'s next turn', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-desk-grok-'));
  const cfg = Config.parse({ profiles: { g: { cwd: here, backend: 'grok' } }, routes: [{ platform: 'telegram', chat: 4, profile: 'g' }], defaults: { max_out_per_min: 1000 } });
  const loads = join(dir, 'loads.log');
  const o = new Orchestrator(cfg, { telegram: { send: async () => {} }, whatsapp: { send: async () => {} } },
    { stateDir: dir, bins: { grok: join(here, 'fake-grok.mjs') }, env: { ...process.env, FAKE_GROK_REPLAY: '1', FAKE_GROK_LOAD_LOG: loads } });
  const token = loadOrMintToken(join(dir, 'api.token'));
  const api = new ApiServer(apiDeps(o, cfg, () => ({ pid: 1, sessions: o.status() })), token);
  const socket = join(dir, API_SOCKET);
  await claimSocket(socket);
  await api.listen(socket);
  t.after(async () => { await api.close(); await o.shutdown(); });
  const turn = async (text: string) => {
    const s = await listen(socket, token, 'telegram:4');
    await o.handle({ platform: 'telegram', chat: '4', sender: '1', text, isGroup: false, mentioned: true, media: [] });
    await s.until((e) => e.some((x) => x.type === 'turn-end'));
    s.stop();
  };
  await turn('hello');
  const h = await get(socket, '/history?key=telegram:4', token);
  assert.deepEqual([h.body.supported, h.body.items.map((i: { role: string; text: string }) => [i.role, i.text])],
    [true, [['user', 'Read note.txt'], ['assistant', "I'll read it.\n\nIt says hello."], ['user', 'Thanks'], ['assistant', 'Welcome.']]]);
  const count = () => (existsSync(loads) ? readFileSync(loads, 'utf8').trim().split('\n').length : 0);
  const first = count();
  assert.ok(first >= 1);
  await get(socket, '/history?key=telegram:4', token);
  assert.equal(count(), first, 'served from memory');
  await turn('again');
  await get(socket, '/history?key=telegram:4', token);
  assert.equal(count(), first + 1, 'a turn ended: replayed again');
});

test('desk api: a grok replay that a turn end overtakes is not kept; a failed one is an error, not an empty page', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-desk-grok2-'));
  const cfg = Config.parse({ profiles: { g: { cwd: here, backend: 'grok' } }, routes: [{ platform: 'telegram', chat: 6, profile: 'g' }], defaults: { max_out_per_min: 1000 } });
  const loads = join(dir, 'loads.log');
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_GROK_REPLAY: '1', FAKE_GROK_LOAD_LOG: loads, FAKE_GROK_LOAD_DELAY_MS: '800' };
  const o = new Orchestrator(cfg, { telegram: { send: async () => {} }, whatsapp: { send: async () => {} } }, { stateDir: dir, bins: { grok: join(here, 'fake-grok.mjs') }, env });
  const token = loadOrMintToken(join(dir, 'api.token'));
  const api = new ApiServer(apiDeps(o, cfg, () => ({ pid: 1, sessions: o.status() })), token);
  const socket = join(dir, API_SOCKET);
  await claimSocket(socket);
  await api.listen(socket);
  t.after(async () => { await api.close(); await o.shutdown(); });
  const turn = async (text: string) => {
    const s = await listen(socket, token, 'telegram:6');
    await o.handle({ platform: 'telegram', chat: '6', sender: '1', text, isGroup: false, mentioned: true, media: [] });
    await s.until((e) => e.some((x) => x.type === 'turn-end'));
    s.stop();
  };
  await turn('hello');
  const count = () => (existsSync(loads) ? readFileSync(loads, 'utf8').trim().split('\n').length : 0);
  // The replay starts, then a turn ends while it runs: what it read may be older than that turn.
  const slow = get(socket, '/history?key=telegram:6', token);
  await new Promise((r) => setTimeout(r, 200));
  await turn('during');
  assert.equal((await slow).status, 200);
  const before = count();
  await get(socket, '/history?key=telegram:6', token);
  assert.equal(count(), before + 1, 'not served from the replay the turn overtook');

  env.FAKE_GROK_NO_LOAD = '1';
  await turn('drop the cache');
  const failed = await get(socket, '/history?key=telegram:6', token);
  assert.deepEqual([failed.status, failed.body.error], [502, 'grok did not replay this session']);
});

test('desk api: a Codex chat\'s history is read by Codex, page by page', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-desk-codex-'));
  const cfg = Config.parse({ profiles: { c: { cwd: here, backend: 'codex' } }, routes: [{ platform: 'telegram', chat: 5, profile: 'c' }], defaults: { max_out_per_min: 1000 } });
  const o = new Orchestrator(cfg, { telegram: { send: async () => {} }, whatsapp: { send: async () => {} } },
    { stateDir: dir, bins: { codex: join(here, 'fake-codex.mjs') } });
  const token = loadOrMintToken(join(dir, 'api.token'));
  const api = new ApiServer(apiDeps(o, cfg, () => ({ pid: 1, sessions: o.status() })), token);
  const socket = join(dir, API_SOCKET);
  await claimSocket(socket);
  await api.listen(socket);
  t.after(async () => { await api.close(); await o.shutdown(); });
  const s = await listen(socket, token, 'telegram:5');
  await o.handle({ platform: 'telegram', chat: '5', sender: '1', text: 'hello', isGroup: false, mentioned: true, media: [] });
  await s.until((e) => e.some((x) => x.type === 'turn-end'));
  s.stop();
  const id = o.sessionsOf('telegram:5').active!;
  const h = await get(socket, '/history?key=telegram:5', token);
  assert.deepEqual([h.body.session, h.body.supported, h.body.items.length, h.body.more], [id, true, 4, false]);
  const newest = await get(socket, '/history?key=telegram:5&limit=2', token);
  assert.deepEqual([newest.body.items.map((i: { text: string }) => i.text), newest.body.more], [['Say DONE only.', 'DONE'], true]);
  const older = await get(socket, `/history?key=telegram:5&limit=2&before=${encodeURIComponent(newest.body.cursor)}`, token);
  assert.deepEqual([older.body.items[0].text, older.body.more], ['Run cat note.txt\n\n[image]', false]);
  const other = encodeURIComponent(JSON.stringify({ requestedThreadId: 'thr-someone-else', rolloutOrdinal: 1 }));
  assert.equal((await get(socket, `/history?key=telegram:5&before=${other}`, token)).status, 400, 'a cursor for another thread');
});

test('desk api: an app turn\'s unanswered permission times out as an event, with no line in the chat', async (t) => {
  const { o, token, socket, sent } = await setup(t, undefined, 0.005);
  const s = await listen(socket, token, 'telegram:1');
  await post(socket, '/turn', { token, key: 'telegram:1', text: 'PERM run it', reply: 'caller' });
  await s.until((e) => e.some((x) => x.type === 'turn-end'));
  s.stop();
  assert.ok(s.events.some((e) => e.type === 'permission-answered' && e.by === 'timeout' && !e.allow), JSON.stringify(s.events));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(sent, []);
  void o;
});

test('desk api: a client that stops reading is cut off instead of buffered for', async (t) => {
  const { o, token, socket } = await setup(t);
  const closed = await new Promise<boolean>((resolve, reject) => {
    const req = request({ socketPath: socket, path: '/events', method: 'GET', headers: { authorization: `Bearer ${token}` } }, (res) => {
      res.pause(); // never reads
      res.on('close', () => resolve(true));
      res.on('error', () => resolve(true));
      void (async () => {
        const big = 'x'.repeat(3_500); // one chunk each: the chat's rate limit stays out of the way
        for (let n = 0; n < 600; n++) await o.notify('telegram:1', big);
      })();
      setTimeout(() => resolve(false), 8000);
    });
    req.on('error', () => resolve(true));
    req.on('close', () => resolve(true));
    req.end();
    void reject;
  });
  assert.equal(closed, true);
});

test('desk api: a chat\'s "yes abcde" is evented under the full id the client has', async (t) => {
  const { o, token, socket } = await setup(t);
  const s = await listen(socket, token, 'telegram:1');
  const turn = o.handle({ platform: 'telegram', chat: '1', sender: '1', text: 'PERM run it', isGroup: false, mentioned: true, media: [] });
  await s.until((e) => e.some((x) => x.type === 'permission'));
  const ask = s.events.find((e) => e.type === 'permission') as Extract<ChatEvent, { type: 'permission' }>;
  await o.handle({ platform: 'telegram', chat: '1', sender: '1', text: `yes ${ask.id.slice(0, 6)}`, isGroup: false, mentioned: true, media: [] });
  await turn;
  await s.until((e) => e.some((x) => x.type === 'turn-end'));
  s.stop();
  const answer = s.events.find((e) => e.type === 'permission-answered') as Extract<ChatEvent, { type: 'permission-answered' }>;
  assert.equal(answer.id, ask.id);
  assert.equal(answer.by, 'chat');
});

test('desk api: /turn returns an id that the turn\'s events carry', async (t) => {
  const { token, socket } = await setup(t);
  const s = await listen(socket, token, 'telegram:1');
  const r = await post(socket, '/turn', { token, key: 'telegram:1', text: 'hello', reply: 'caller' });
  assert.match(String(r.body.turn), /^[0-9a-f-]{36}$/);
  await s.until((e) => e.some((x) => x.type === 'turn-end'));
  s.stop();
  const ids = s.events.filter((e) => e.type === 'turn' || e.type === 'turn-end').map((e) => (e as { turn: string }).turn);
  assert.deepEqual(ids, [r.body.turn, r.body.turn]);
});

test('desk api: a client that connects late still sees the running turn and the request it waits on', async (t) => {
  const { o, token, socket } = await setup(t);
  const health = await get(socket, '/healthz');
  assert.equal(health.body.api, 1, 'the desk API version is announced');
  assert.deepEqual(health.body.features, ['command', 'files'], 'and what it adds to it');
  const s = await listen(socket, token, 'telegram:1');
  const turn = o.handle({ platform: 'telegram', chat: '1', sender: '1', text: 'PERM run it', isGroup: false, mentioned: true, media: [] });
  await s.until((e) => e.some((x) => x.type === 'permission'));
  const ask = s.events.find((e) => e.type === 'permission') as Extract<ChatEvent, { type: 'permission' }>;
  // What a client that was not listening reads.
  const status = await get(socket, '/status', token);
  assert.deepEqual(status.body.sessions.find((x: { key: string }) => x.key === 'telegram:1')?.running, true);
  const waiting = await get(socket, '/permissions', token);
  assert.equal(waiting.status, 200);
  assert.equal(waiting.body.permissions.length, 1);
  assert.equal(waiting.body.permissions[0].key, 'telegram:1');
  assert.equal(waiting.body.permissions[0].id, ask.id);
  assert.equal(waiting.body.permissions[0].tool, ask.tool);
  assert.equal(waiting.body.permissions[0].preview, ask.preview);
  assert.equal(typeof waiting.body.permissions[0].at, 'string');
  assert.equal((await get(socket, '/permissions', 'not-the-token')).status, 403, 'owner only');
  assert.equal((await post(socket, '/permission', { token, key: 'telegram:1', id: ask.id, allow: true })).status, 200);
  await turn;
  await s.until((e) => e.some((x) => x.type === 'turn-end'));
  s.stop();
  assert.deepEqual((await get(socket, '/permissions', token)).body.permissions, [], 'an answered request is gone');
  assert.equal((await get(socket, '/status', token)).body.sessions.find((x: { key: string }) => x.key === 'telegram:1')?.running, false);
});

test('desk api: a request answered in the CLI\'s own dialog is evented as by the terminal, and the chat is told', async (t) => {
  const { o, token, socket, sent } = await setup(t);
  const { EventEmitter } = await import('node:events');
  // A brain that asks, then reports the answer was given in its pane (the tmux brain does this).
  (o as any).makeBrain = (_key: string, name: string) => Object.assign(new EventEmitter(), {
    profile: (o as any).cfg.profiles[name], session: { id: 's', started: true }, lastUsedAt: Date.now(), version: 'x', alive: true,
    pendingPermissionCount: 0, start() {}, kill() {}, async stop() {}, hasPendingPermission: () => false, answerPermission: () => false,
    async *turn() {
      yield { kind: 'permission', id: 'abcdef12-0000', tool: 'Bash', preview: 'rm -rf build' };
      yield { kind: 'permission-answered', id: 'abcdef12-0000', allow: false };
      yield { kind: 'permission-answered', id: 'not-asked', allow: true };
      yield { kind: 'result', text: 'ok then', isError: false };
    },
  });
  const s = await listen(socket, token, 'telegram:1');
  await o.handle({ platform: 'telegram', chat: '1', sender: '1', text: 'go', isGroup: false, mentioned: true, media: [] });
  await s.until((e) => e.some((x) => x.type === 'turn-end'));
  s.stop();
  const answers = s.events.filter((e) => e.type === 'permission-answered');
  assert.deepEqual(answers.map((e) => e.type === 'permission-answered' && [e.id, e.allow, e.by]), [['abcdef12-0000', false, 'terminal']], 'only a request this chat was asked');
  assert.ok(sent.some((m) => m.text === 'Permission denied in the Claude app or the pane.'));
  assert.deepEqual((await get(socket, '/permissions', token)).body.permissions, []);
});

test('desk api: POST takes the owner token from the Authorization header, with none in the body', async (t) => {
  const { token, socket, sent } = await setup(t);
  assert.equal((await post(socket, '/send', { key: 'telegram:1', text: 'by header' }, token)).status, 200);
  assert.ok(sent.some((m) => m.text === 'by header'));
  assert.equal((await post(socket, '/send', { key: 'telegram:1', text: 'wrong' }, 'not-the-token')).status, 403);
  // The header wins over the body: a right token in the body does not rescue a wrong header.
  assert.equal((await post(socket, '/send', { token, key: 'telegram:1', text: 'mixed' }, 'not-the-token')).status, 403);
  assert.equal((await post(socket, '/permission', { key: 'telegram:1', id: 'nope', allow: true }, token)).status, 409, 'owner by header; nothing waits');
  assert.equal((await post(socket, '/permission', { key: 'telegram:1', id: 'nope', allow: true }, sessionToken(token, 'telegram:1'))).status, 403, 'an agent token by header is still not the owner');
});

test('desk api: /command runs new, stop and status for the app; the chat hears only what changes it', async (t) => {
  const { o, token, socket, sent } = await setup(t);
  const status = await post(socket, '/command', { key: 'telegram:1', command: 'status' }, token);
  assert.equal(status.status, 200);
  assert.match(String(status.body.text), /^angelia · profile a/);
  assert.equal((await post(socket, '/command', { key: 'telegram:1', command: 'stop' }, token)).body.text, 'Nothing running.');
  assert.deepEqual(sent, [], 'status and an idle stop say nothing in the chat');

  const before = o.map.getActive('telegram:1')?.id;
  const made = await post(socket, '/command', { key: 'telegram:1', command: 'new' }, token);
  assert.match(String(made.body.text), /^New session [0-9a-f]{8} started\.$/);
  assert.notEqual(o.map.getActive('telegram:1')?.id, before);
  assert.deepEqual(sent.map((m) => m.text), [`${String(made.body.text).slice(0, -1)} from the desk app.`]);

  // A chat turn waiting on a permission is cut by the app's Stop, without waiting behind it.
  const s = await listen(socket, token, 'telegram:1');
  const turn = o.handle({ platform: 'telegram', chat: '1', sender: '1', text: 'PERM run it', isGroup: false, mentioned: true, media: [] });
  await s.until((e) => e.some((x) => x.type === 'permission'));
  assert.equal((await post(socket, '/command', { key: 'telegram:1', command: 'stop' }, token)).body.text, 'Stopped.');
  await turn;
  await s.until((e) => e.some((x) => x.type === 'turn-end'));
  s.stop();
  assert.ok(sent.some((m) => m.text === 'Stopped from the desk app.'));
});

test('desk api: /command is the owner\'s, for a routed chat, and one of three commands', async (t) => {
  const { token, socket } = await setup(t);
  const agent = sessionToken(token, 'telegram:1');
  assert.equal((await post(socket, '/command', { key: 'telegram:1', command: 'new' }, agent)).status, 403);
  assert.equal((await post(socket, '/command', { token: agent, key: 'telegram:1', command: 'new' })).status, 403);
  assert.equal((await post(socket, '/command', { key: 'telegram:1', command: 'restart' }, token)).status, 400);
  assert.equal((await post(socket, '/command', { key: 'telegram:9', command: 'status' }, token)).status, 404);
});

test('desk api: files dropped in the app reach the agent from the profile\'s inbox', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'angelia-desk-profile-'));
  const { token, socket, sent } = await setup(t, undefined, undefined, cwd);
  const src = mkdtempSync(join(tmpdir(), 'angelia-desk-drop-'));
  writeFileSync(join(src, 'notes.txt'), 'hello');
  writeFileSync(join(src, 'memo.m4a'), 'not really audio');
  const s = await listen(socket, token);
  const r = await post(socket, '/turn', { key: 'telegram:1', text: 'look', files: [join(src, 'notes.txt'), join(src, 'memo.m4a')], reply: 'caller' }, token);
  assert.equal(r.status, 200);
  await s.until((e) => e.some((x) => x.type === 'turn-end'));
  s.stop();
  const inbox = readdirSync(join(cwd, '.inbox'));
  assert.equal(inbox.length, 2, 'both copied');
  const txt = inbox.find((f) => f.endsWith('.txt'))!;
  assert.equal(readFileSync(join(cwd, '.inbox', txt), 'utf8'), 'hello');
  const out = s.events.find((e) => e.type === 'out') as Extract<ChatEvent, { type: 'out' }>;
  assert.ok(out.text.includes(`[file: ${join(cwd, '.inbox', txt)}]`), out.text);
  assert.match(out.text, /\[voice note: .*\.m4a\]/);
  assert.deepEqual(sent, []);

  // Files alone are a turn too.
  assert.equal((await post(socket, '/turn', { key: 'telegram:1', files: [join(src, 'notes.txt')], reply: 'caller' }, token)).status, 200);
});

test('desk api: dropped files are refused from a credential location, from an agent, outside an app turn', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'angelia-desk-profile-'));
  const { token, socket } = await setup(t, undefined, undefined, cwd);
  const src = mkdtempSync(join(tmpdir(), 'angelia-desk-drop-'));
  writeFileSync(join(src, '.env'), 'SECRET=1');
  writeFileSync(join(src, 'ok.txt'), 'fine');
  const env = await post(socket, '/turn', { key: 'telegram:1', text: 'x', files: [join(src, 'ok.txt'), join(src, '.env')], reply: 'caller' }, token);
  assert.equal(env.status, 400);
  assert.match(String(env.body.error), /refusing to send from that location/);
  assert.ok(!existsSync(join(cwd, '.inbox')) || readdirSync(join(cwd, '.inbox')).length === 0, 'nothing copied when one file is refused');
  const agent = sessionToken(token, 'telegram:1');
  assert.equal((await post(socket, '/turn', { key: 'telegram:1', text: 'x', files: [join(src, 'ok.txt')], reply: 'caller' }, agent)).status, 403);
  assert.equal((await post(socket, '/turn', { key: 'telegram:1', text: 'x', files: [join(src, 'ok.txt')] }, token)).status, 403);
  assert.equal((await post(socket, '/send', { key: 'telegram:1', text: 'x', files: [join(src, 'ok.txt')] }, token)).status, 400);
  assert.equal((await post(socket, '/turn', { key: 'telegram:1', text: 'x', files: [], reply: 'caller' }, token)).status, 400);
  assert.equal((await post(socket, '/turn', { key: 'telegram:1', text: 'x', files: ['relative.txt'], reply: 'caller' }, token)).status, 400);
});

test('desk api: a copy the app made is checked where it came from too', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'angelia-desk-profile-'));
  const { token, socket } = await setup(t, undefined, undefined, cwd);
  const staged = mkdtempSync(join(tmpdir(), 'angelia-desk-staged-'));
  writeFileSync(join(staged, '0-id_rsa.txt'), 'a copy');
  const home = join(tmpdir(), 'nowhere-home');
  const fromSecret = await post(socket, '/turn', { key: 'telegram:1', files: [{ path: join(staged, '0-id_rsa.txt'), from: `${home}/.ssh/id_rsa` }], reply: 'caller' }, token);
  assert.equal(fromSecret.status, 400);
  assert.match(String(fromSecret.body.error), /refusing to send from that location/);
  const ok = await post(socket, '/turn', { key: 'telegram:1', files: [{ path: join(staged, '0-id_rsa.txt'), from: '/Users/example/Downloads/report.txt' }], reply: 'caller' }, token);
  assert.equal(ok.status, 200);
  assert.equal(readdirSync(join(cwd, '.inbox')).length, 1);
  assert.equal((await post(socket, '/turn', { key: 'telegram:1', files: [{ path: join(staged, '0-id_rsa.txt'), from: 'relative' }], reply: 'caller' }, token)).status, 400);
  assert.equal((await post(socket, '/turn', { key: 'telegram:1', files: [{ from: '/x' }], reply: 'caller' }, token)).status, 400);
});

test('/turn answers 429 when the chat is full, and /stop empties the queue', async (t) => {
  const { o, token, socket, sent } = await setup(t);
  const agent = sessionToken(token, 'telegram:1');
  const codes: number[] = [];
  for (let n = 0; n < 11; n++) codes.push((await post(socket, '/turn', { key: 'telegram:1', text: n === 0 ? 'SLOW first' : `go ${n}` }, agent)).status);
  assert.deepEqual(codes, [...Array(10).fill(200), 429]);
  const r = await post(socket, '/command', { key: 'telegram:1', command: 'stop' }, token);
  assert.equal(r.body.text, 'Stopped. 9 waiting messages dropped.');
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(o.queueFull('telegram:1'), false);
  assert.ok(!sent.some((m) => /go \d/.test(m.text)), 'no dropped turn ran');
});
