import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_SOCKET, ApiServer, claimSocket, loadOrMintToken } from '../src/daemon/api/server.js';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator, type Sender } from '../src/core/orchestrator.js';
import { apiDeps } from '../src/daemon/api/deps.js';
import type { ChatEvent } from '../src/core/events.js';

// reply: "caller" promises that Angelia sends the chat nothing (docs/api.md). A script that gets its
// answer cannot see a message the chat got as well, and the event stream cannot show what the chat did
// not get, so these tests watch the chat side: every call on the adapter. What the agent posts itself
// (angelia send, send-media) is its own act and outside this promise.

const here = dirname(fileURLToPath(import.meta.url));
const DM = 'telegram:1';
const GROUP = 'whatsapp:g@g.us';
/** A read, not a send: asked only when a new chat is onboarded. */
const READS = new Set(['chatName']);

/** A chat adapter that records every call on it, whatever the method: a send path added later is caught too. */
function recorder() {
  const calls: { method: string; chat: unknown; text: unknown }[] = [];
  const sender = new Proxy({}, {
    get: (_, name) => (typeof name === 'string' && name !== 'then'
      ? async (chat: unknown, text: unknown) => { if (!READS.has(name)) calls.push({ method: name, chat, text }); }
      : undefined),
  }) as Sender;
  return { calls, sender };
}

/** `fast`: a permission times out in 0.3 s and a silent CLI is told about at 0.3 s and stopped at 0.6 s. */
async function setup(t: { after(fn: () => unknown): void }, fast = false) {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-silent-'));
  const cfg = Config.parse({
    profiles: { a: { cwd: here, answer_from: ['b'], media_tags: true }, b: { cwd: here } },
    routes: [
      { platform: 'telegram', chat: 1, profile: 'a' },
      { platform: 'telegram', chat: 2, profile: 'b' },
      { platform: 'whatsapp', chat: 'g@g.us', profile: 'a' },
    ],
    defaults: { max_out_per_min: 1000, ...(fast ? { permission_timeout_minutes: 0.005, turn_stall_minutes: 0.01 } : {}) },
    onboard: { owners: ['1'] },
  });
  const telegram = recorder();
  const whatsapp = recorder();
  const o = new Orchestrator(cfg, { telegram: telegram.sender, whatsapp: whatsapp.sender },
    { stateDir: dir, bins: { 'claude-code': join(here, 'fake-claude.mjs') }, sendRetryMs: [10], chunkGapMs: [0, 0], stallTickMs: 50 });
  const token = loadOrMintToken(join(dir, 'api.token'));
  const api = new ApiServer(apiDeps(o, cfg, () => ({ pid: 1, sessions: o.status() })), token);
  const socket = join(dir, API_SOCKET);
  await claimSocket(socket);
  await api.listen(socket);
  t.after(async () => { await api.close(); await o.shutdown(); rmSync(dir, { recursive: true, force: true }); });
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
const file = join(mkdtempSync(join(tmpdir(), 'angelia-silent-file-')), 'report.txt');
writeFileSync(file, 'a report');
const MEDIA = `see the file\nMEDIA:${file}`;

const turnEnd = (events: ChatEvent[]) => events.find((e) => e.type === 'turn-end') as Extract<ChatEvent, { type: 'turn-end' }> | undefined;
const outs = (events: ChatEvent[]) => events.filter((e) => e.type === 'out').map((e) => (e as { text: string }).text);

/**
 * One turn, as a script sends it through the API (`caller`) or as the chat sends it. `allow`: the
 * answer to its permission request, from the app; `null` leaves the request to time out.
 */
async function runTurn(t: { after(fn: () => unknown): void }, key: string, text: string, opts: { caller: boolean; allow?: boolean | null; fast?: boolean }) {
  const { o, token, socket, calls } = await setup(t, opts.fast);
  const s = await listen(socket, token, key);
  if (opts.caller) {
    const r = await post(socket, '/turn', { key, text, reply: 'caller' }, token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  } else {
    const [platform, chat] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    void o.handle({ platform: platform as 'telegram', chat, sender: '1', text, isGroup: chat.endsWith('@g.us'), mentioned: true, media: [] });
  }
  if (typeof opts.allow === 'boolean') {
    await s.until((e) => e.some((x) => x.type === 'permission'));
    const ask = s.events.find((e) => e.type === 'permission') as Extract<ChatEvent, { type: 'permission' }>;
    assert.equal((await post(socket, '/permission', { key, id: ask.id, allow: opts.allow }, token)).status, 200);
  }
  await s.until((e) => e.some((x) => x.type === 'turn-end'));
  await settle();
  s.stop();
  return { events: s.events, calls: calls() };
}

type Case = { name: string; text: string; allow?: boolean | null; fast?: boolean; out: RegExp; ok: boolean; chat: RegExp | 'file' };
/** `out`: what the caller must get, so a case cannot pass without reaching its path; `chat`: what a chat turn sends instead
 *  (a line, or `file` for an attachment). */
const CASES: Case[] = [
  { name: 'an answer', text: 'hello', out: /hello$/, ok: true, chat: /hello$/ },
  { name: 'progress lines', text: 'PROGRESS hello', out: /PROGRESS hello$/, ok: true, chat: /^working on it$/ },
  { name: 'a busy turn of forty lines', text: 'BUSYTURN', out: /^final answer$/, ok: true, chat: /^final answer$/ },
  { name: 'a long answer, which a chat gets as a file', text: LONG, out: /x{1000}$/, ok: true, chat: 'file' },
  { name: 'a file line, which a chat gets as an attachment', text: MEDIA, out: /MEDIA:/, ok: true, chat: 'file' },
  { name: 'a usage limit', text: 'LIMIT', out: /reached your Fable limit/, ok: false, chat: /reached your Fable limit/ },
  { name: 'a CLI that crashes', text: 'CRASH', out: /Something broke/, ok: false, chat: /Something broke/ },
  { name: 'a permission request allowed from the app', text: 'PERM run it', allow: true, out: /tool allowed/, ok: true, chat: /^Permission allowed from the desk app\.$/ },
  { name: 'a permission request denied from the app', text: 'PERM run it', allow: false, out: /tool deny/, ok: true, chat: /^Permission denied from the desk app\.$/ },
  { name: 'a permission request nobody answers', text: 'PERM run it', allow: null, fast: true, out: /tool deny/, ok: true, chat: /^No answer to the permission request in time/ },
  { name: 'a CLI that goes silent', text: 'HANG', fast: true, out: /./, ok: false, chat: /Nothing new from the agent/ },
];

/** What every case's chat turn sends, by method; the control below fills it. */
const seen = new Set<string>();

for (const c of CASES) {
  test(`silent control: a chat turn with ${c.name} reaches the chat`, async (t) => {
    const { calls } = await runTurn(t, DM, c.text, { caller: false, allow: c.allow, fast: c.fast });
    const want = c.chat;
    assert.ok(want === 'file' ? calls.some((x) => x.method === 'sendMedia') : calls.some((x) => x.method === 'send' && want.test(String(x.text))), JSON.stringify(calls).slice(0, 2000));
    for (const x of calls) seen.add(x.method);
  });
  for (const key of [DM, GROUP]) {
    test(`silent: reply: caller in ${key === DM ? 'the owner\'s DM' : 'a group'}, ${c.name}: the caller gets the turn, the chat gets nothing`, async (t) => {
      const { events, calls } = await runTurn(t, key, c.text, { caller: true, allow: c.allow, fast: c.fast });
      assert.equal(events[0]?.type, 'turn');
      assert.equal(turnEnd(events)?.ok, c.ok, JSON.stringify(turnEnd(events)));
      assert.ok(outs(events).some((x) => c.out.test(x)), JSON.stringify(outs(events)).slice(0, 2000));
      assert.deepEqual(calls, [], 'no call of any kind on the chat adapter');
    });
  }
}

test('silent control: the chat turns above used typing, send and sendMedia, so an empty record means something', () => {
  for (const m of ['typing', 'send', 'sendMedia']) assert.ok(seen.has(m), `${m}: ${JSON.stringify([...seen])}`);
});

test('silent: /ask in a group sends the group nothing; in the owner\'s DM only the one documented line', async (t) => {
  const { o, calls } = await setup(t);
  await o.ask(GROUP, 'what changed today?', 'telegram:2');
  await settle();
  assert.deepEqual(calls(), []);
  await o.ask(DM, 'what changed today?', 'telegram:2');
  await settle();
  assert.deepEqual(calls().map((c) => [c.method, c.text]), [['send', '📨 b asked: what changed today? (answered)']]);
  await o.ask(DM, 'and from the owner?');
  await settle();
  assert.equal(calls().length, 1, 'the owner asking from a terminal is not announced');
});
