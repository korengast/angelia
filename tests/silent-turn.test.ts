import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_SOCKET, ApiServer, claimSocket, loadOrMintToken } from '../src/daemon/api/server.js';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator, type Sender } from '../src/core/orchestrator.js';
import { apiDeps } from '../src/daemon/api/deps.js';
import type { ChatEvent } from '../src/core/events.js';

// reply: "caller" promises that nothing reaches the chat. A script that gets its answer cannot see
// a message the chat got as well, so these tests watch the chat side: every call on the adapter.

const here = dirname(fileURLToPath(import.meta.url));
const DM = 'telegram:1';
const GROUP = 'whatsapp:g@g.us';

/** A chat adapter that records every call on it, whatever the method: a send path added later is caught too. */
function recorder() {
  const calls: { method: string; chat: unknown }[] = [];
  const sender = new Proxy({}, {
    get: (_, name) => (typeof name === 'string' && name !== 'then'
      ? async (chat: unknown) => { calls.push({ method: name, chat }); }
      : undefined),
  }) as Sender;
  return { calls, sender };
}

async function setup(t: { after(fn: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-silent-'));
  const cfg = Config.parse({
    profiles: { a: { cwd: here, answer_from: ['b'] }, b: { cwd: here } },
    routes: [
      { platform: 'telegram', chat: 1, profile: 'a' },
      { platform: 'telegram', chat: 2, profile: 'b' },
      { platform: 'whatsapp', chat: 'g@g.us', profile: 'a' },
    ],
    defaults: { max_out_per_min: 1000 },
    onboard: { owners: ['1'] },
  });
  const telegram = recorder();
  const whatsapp = recorder();
  const o = new Orchestrator(cfg, { telegram: telegram.sender, whatsapp: whatsapp.sender },
    { stateDir: dir, bins: { 'claude-code': join(here, 'fake-claude.mjs') }, sendRetryMs: [10], chunkGapMs: [0, 0] });
  const token = loadOrMintToken(join(dir, 'api.token'));
  const api = new ApiServer(apiDeps(o, cfg, () => ({ pid: 1, sessions: o.status() })), token);
  const socket = join(dir, API_SOCKET);
  await claimSocket(socket);
  await api.listen(socket);
  t.after(async () => { await api.close(); await o.shutdown(); });
  return { o, token, socket, calls: () => [...telegram.calls, ...whatsapp.calls] };
}

function post(socket: string, path: string, body: unknown, bearer: string) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ socketPath: socket, path, method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function listen(socket: string, token: string, key: string) {
  const events: ChatEvent[] = [];
  return new Promise<{ events: ChatEvent[]; stop(): void; until(p: (e: ChatEvent[]) => boolean): Promise<void> }>((resolve, reject) => {
    const req = request({ socketPath: socket, path: `/events?key=${encodeURIComponent(key)}`, method: 'GET', headers: { authorization: `Bearer ${token}` } }, (res) => {
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
        const end = Date.now() + 15_000;
        while (!p(events)) { if (Date.now() > end) throw new Error(`timed out; events: ${JSON.stringify(events)}`); await new Promise((r) => setTimeout(r, 20)); }
      };
      resolve({ events, stop: () => req.destroy(), until });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Long enough for a send that was not awaited (a notice, a paced outbox) to have gone out. */
const settle = () => new Promise((r) => setTimeout(r, 500));
const LONG = `LONG ${'x'.repeat(30_000)}`;

/** One turn with reply: "caller", through the API as a script sends it; the answer to a permission request, if any. */
async function callerTurn(t: { after(fn: () => unknown): void }, key: string, text: string, allow?: boolean) {
  const { token, socket, calls } = await setup(t);
  const s = await listen(socket, token, key);
  const r = await post(socket, '/turn', { key, text, reply: 'caller' }, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (allow !== undefined) {
    await s.until((e) => e.some((x) => x.type === 'permission'));
    const ask = s.events.find((e) => e.type === 'permission') as Extract<ChatEvent, { type: 'permission' }>;
    assert.equal((await post(socket, '/permission', { key, id: ask.id, allow }, token)).status, 200);
  }
  await s.until((e) => e.some((x) => x.type === 'turn-end'));
  await settle();
  s.stop();
  return { events: s.events, calls: calls() };
}

test('silent: the recorder sees a normal chat turn (so an empty record below means something)', async (t) => {
  const { o, calls } = await setup(t);
  await o.handle({ platform: 'telegram', chat: '1', sender: '1', text: LONG, isGroup: false, mentioned: true, media: [] });
  await settle();
  const methods = new Set(calls().map((c) => c.method));
  for (const m of ['typing', 'send', 'sendMedia']) assert.ok(methods.has(m), `${m}: ${JSON.stringify([...methods])}`);
});

const CASES: [string, string, boolean?][] = [
  ['an answer', 'hello'],
  ['progress lines', 'PROGRESS hello'],
  ['a busy turn of forty lines', 'BUSYTURN'],
  ['a long answer, which a chat gets as a file', LONG],
  ['an empty answer', 'EMPTY'],
  ['a usage limit', 'LIMIT'],
  ['a CLI that crashes', 'CRASH'],
  ['a permission request allowed from the app', 'PERM run it', true],
  ['a permission request denied from the app', 'PERM run it', false],
];

for (const key of [DM, GROUP]) {
  for (const [name, text, allow] of CASES) {
    test(`silent: reply: caller in ${key === DM ? 'the owner\'s DM' : 'a group'}, ${name}: the caller gets the turn, the chat gets nothing`, async (t) => {
      const { events, calls } = await callerTurn(t, key, text, allow);
      assert.equal(events[0]?.type, 'turn');
      assert.equal(events.at(-1)?.type, 'turn-end');
      assert.deepEqual(calls, [], 'no call of any kind on the chat adapter');
    });
  }
}

test('silent: /ask in a group sends the group nothing; in the owner\'s DM only the one documented line', async (t) => {
  const { o, calls } = await setup(t);
  await o.ask(GROUP, 'what changed today?', 'telegram:2');
  await settle();
  assert.deepEqual(calls(), []);
  await o.ask(DM, 'what changed today?', 'telegram:2');
  await settle();
  assert.deepEqual(calls().map((c) => c.method), ['send']);
  await o.ask(DM, 'and from the owner?');
  await settle();
  assert.equal(calls().length, 1, 'the owner asking from a terminal is not announced');
});
