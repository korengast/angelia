import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_SOCKET, ApiServer, claimSocket, loadOrMintToken } from '../src/daemon/api/server.js';
import { apiDeps } from '../src/daemon/api/deps.js';
import { ChatEventSchema, ROUTES, routeFor } from '../src/daemon/api/routes.js';
import { openApiDocument } from '../src/daemon/api/openapi.js';
import { guideText } from '../src/instance/guide.js';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator } from '../src/core/orchestrator.js';

const here = dirname(fileURLToPath(import.meta.url));

/** A daemon's API over a real socket, with the daemon's own wiring, on a fake Claude. */
async function setup(t: { after(fn: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-contract-'));
  const folder = mkdtempSync(join(tmpdir(), 'angelia-contract-a-'));
  writeFileSync(join(folder, 'CLAUDE.md'), '# a\n');
  const cfg = Config.parse({
    profiles: { a: { cwd: folder } },
    routes: [{ platform: 'telegram', chat: 1, profile: 'a' }],
    defaults: { max_out_per_min: 1000 },
  });
  const o = new Orchestrator(cfg, { telegram: { send: async () => {} }, whatsapp: { send: async () => {} } }, { stateDir: dir, bins: { 'claude-code': join(here, 'fake-claude.mjs') } });
  const token = loadOrMintToken(join(dir, 'api.token'));
  const api = new ApiServer(apiDeps(o, cfg, () => ({ pid: 1, sessions: o.status() }), dir), token);
  const socket = join(dir, API_SOCKET);
  await claimSocket(socket);
  await api.listen(socket);
  t.after(async () => { await api.close(); await o.shutdown(); });
  return { token, socket };
}

function call(socket: string, method: string, path: string, token?: string, body?: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const req = request({ socketPath: socket, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const query = (q: Record<string, unknown> = {}) => {
  const s = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString();
  return s ? `?${s}` : '';
};

test('api contract: docs/api/openapi.json is what the route table says (npm run openapi rewrites it)', () => {
  const file = JSON.parse(readFileSync(join(here, '..', 'docs', 'api', 'openapi.json'), 'utf8'));
  assert.deepEqual(file, openApiDocument());
});

test('api contract: every route in the table is served and asks for its token; nothing else is', async (t) => {
  const { socket } = await setup(t);
  for (const r of ROUTES) {
    const res = await call(socket, r.method, r.path, 'not-the-token', r.method === 'POST' ? {} : undefined);
    if (r.token === 'none') assert.equal(res.status, 200, `${r.method} ${r.path}`);
    else assert.equal(res.status, 403, `${r.method} ${r.path}: ${JSON.stringify(res.body)}`);
  }
  for (const [method, path] of [['GET', '/send'], ['POST', '/profiles'], ['GET', '/nope'], ['POST', '/healthz']]) {
    assert.equal(routeFor(method, path), undefined);
    assert.equal((await call(socket, method, path, 'not-the-token', method === 'POST' ? {} : undefined)).status, 404, `${method} ${path}`);
  }
});

test('api contract: every documented answer has the documented shape, and the stable routes a script uses have one', () => {
  for (const r of ROUTES) if (r.answer !== undefined) assert.ok(r.response.safeParse(r.answer).success, `${r.method} ${r.path}: ${r.response.safeParse(r.answer).error?.message}`);
  for (const r of ROUTES.filter((x) => x.stability === 'stable' && x.path !== '/openapi.json')) assert.notEqual(r.answer, undefined, `${r.method} ${r.path} shows no answer`);
});

test('api contract: the running daemon serves its own document, without a token', async (t) => {
  const { socket } = await setup(t);
  const r = await call(socket, 'GET', '/openapi.json');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, openApiDocument());
});

test('api contract: each example in the document succeeds, and the answer has the documented shape', async (t) => {
  const { token, socket } = await setup(t);
  const tried: string[] = [];
  for (const r of ROUTES) {
    if (r.stream || (!r.example && r.token !== 'none')) continue;
    if (r.body) assert.ok(r.body.safeParse(r.example).success, `${r.path}: the example fits its own schema`);
    if (r.query) assert.ok(r.query.safeParse(r.example).success, `${r.path}: the example fits its own schema`);
    const res = r.method === 'GET'
      ? await call(socket, 'GET', r.path + query(r.example), token)
      : await call(socket, 'POST', r.path, token, r.example);
    assert.equal(res.status, 200, `${r.method} ${r.path}: ${JSON.stringify(res.body)}`);
    const shape = r.response.safeParse(res.body);
    assert.ok(shape.success, `${r.method} ${r.path}: ${shape.error?.message} in ${JSON.stringify(res.body)}`);
    tried.push(r.path);
  }
  // Every stable route a script uses without side doors has a tried example.
  for (const p of ['/healthz', '/send', '/turn', '/profiles', '/sessions', '/history', '/permissions', '/jobs']) assert.ok(tried.includes(p), p);
});

test('api contract: the event stream carries events of the documented shape', async (t) => {
  const { token, socket } = await setup(t);
  const events: unknown[] = [];
  const stream = request({ socketPath: socket, path: '/events?key=telegram%3A1', method: 'GET', headers: { authorization: `Bearer ${token}` } }, (res) => {
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
  });
  stream.on('error', () => {});
  stream.end();
  t.after(() => stream.destroy());
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await call(socket, 'POST', '/turn', token, { key: 'telegram:1', text: 'hello' })).status, 200);
  const end = Date.now() + 10_000;
  while (!events.some((e) => (e as { type?: string }).type === 'turn-end')) {
    if (Date.now() > end) throw new Error(`no turn-end; events: ${JSON.stringify(events)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  for (const e of events) assert.ok(ChatEventSchema.safeParse(e).success, JSON.stringify(e));
  assert.deepEqual([...new Set(events.map((e) => (e as { type: string }).type))].filter((x) => x === 'turn' || x === 'turn-end'), ['turn', 'turn-end']);
});

test('api contract: a body that is not a JSON object, or too large, is the client\'s error (400, 413), not the daemon\'s', async (t) => {
  const { token, socket } = await setup(t);
  const raw = (body: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ socketPath: socket, path: '/send', method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', (e: NodeJS.ErrnoException) => (e.code === 'EPIPE' || e.code === 'ECONNRESET' ? resolve({ status: 413, body: { error: 'cut' } }) : reject(e)));
    req.end(body);
  });
  assert.deepEqual(await raw('{'), { status: 400, body: { error: 'bad json' } });
  assert.equal((await raw('[1]')).status, 400);
  assert.equal((await raw('"text"')).status, 400);
  assert.equal((await raw(JSON.stringify({ key: 'telegram:1', text: 'x'.repeat(300 * 1024) }))).status, 413);
});

test('api contract: a /history that fails on a file says so without the file\'s path', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-contract-h-'));
  const token = loadOrMintToken(join(dir, 'api.token'));
  const fail = () => { throw Object.assign(new Error(`ENOENT: no such file or directory, open '/Users/example/.claude/projects/x.jsonl'`), { code: 'ENOENT' }); };
  const api = new ApiServer({ send: async () => {}, turn: async () => {}, sendMedia: async () => {}, routed: () => true, history: fail }, token);
  const socket = join(dir, API_SOCKET);
  await claimSocket(socket);
  await api.listen(socket);
  t.after(() => api.close());
  const r = await call(socket, 'GET', '/history?key=telegram%3A1', token);
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'a file could not be read (ENOENT)');
});

test('api contract: `angelia guide api`, what agents read, names every stable route', () => {
  const text = guideText('api');
  for (const r of ROUTES.filter((x) => x.stability === 'stable')) assert.ok(text.includes(r.path), `${r.method} ${r.path} is missing from the guide`);
});
