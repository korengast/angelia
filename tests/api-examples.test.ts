import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { API_SOCKET, ApiServer, claimSocket, loadOrMintToken } from '../src/daemon/api/server.js';
import { apiDeps } from '../src/daemon/api/deps.js';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator } from '../src/core/orchestrator.js';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', 'examples', 'api');
const run = promisify(execFile);

/** A daemon with the daemon's own wiring in a fresh instance folder, the way the examples find it:
 *  the socket and the owner token under ANGELIA_STATE_DIR. */
async function setup(t: { after(fn: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-ex-'));
  const folder = mkdtempSync(join(tmpdir(), 'angelia-ex-a-'));
  writeFileSync(join(folder, 'CLAUDE.md'), '# a\n');
  const cfg = Config.parse({ profiles: { a: { cwd: folder } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }], defaults: { max_out_per_min: 1000 } });
  const sent: string[] = [];
  const o = new Orchestrator(cfg, { telegram: { send: async (_c: string, text: string) => { sent.push(text); } }, whatsapp: { send: async () => {} } },
    { stateDir: dir, bins: { 'claude-code': join(here, 'fake-claude.mjs') } });
  const api = new ApiServer(apiDeps(o, cfg, () => ({}), dir), loadOrMintToken(join(dir, 'api.token')));
  const socket = join(dir, API_SOCKET);
  await claimSocket(socket);
  await api.listen(socket);
  t.after(async () => { await api.close(); await o.shutdown(); });
  // The owner's token from the file, never an agent's this test may itself be running under.
  const env = { ...process.env, ANGELIA_STATE_DIR: dir, ANGELIA_API_TOKEN: '' };
  return { env, sent };
}

const clients: [string, string[]][] = [
  ['python', ['python3', join(examples, 'angelia_api.py')]],
  ['node', [process.execPath, join(examples, 'angelia-api.mjs')]],
  ['curl', ['sh', join(examples, 'curl.sh')]],
];

for (const [name, [bin, script]] of clients) {
  test(`api examples: the ${name} client checks health, posts a line, asks and gives a task`, async (t) => {
    const { env, sent } = await setup(t);
    const ex = (...args: string[]) => run(bin, [script, ...args], { env, timeout: 15_000 });
    const health = JSON.parse((await ex('health')).stdout);
    assert.equal(health.api, 1);
    await ex('send', 'telegram:1', 'The backup finished.');
    assert.deepEqual(sent, ['The backup finished.']);
    const turn = await ex('turn', 'telegram:1', 'hello there');
    if (name === 'curl') assert.match(turn.stdout, /"queued":true/);
    // The fake agent echoes its prompt: the client printed the answer the chat got, and then stopped.
    else assert.match(turn.stdout, /^echo: \[telegram dm 1 · scheduled \(local\)\]\n\nhello there\n$/);
    const ask = await ex('ask', 'telegram:1', 'what is on today?');
    assert.match(ask.stdout, /what is on today\?/, 'the read-only copy answered');
    await assert.rejects(ex('send', 'telegram:9', 'nobody'), (e: { stderr?: string; stdout?: string }) => /not a routed chat/.test(`${e.stderr}${e.stdout}`));
  });
}

test('api examples: the Python snippet on the API page works as printed', async (t) => {
  const { env } = await setup(t);
  const page = readFileSync(join(here, '..', 'docs', 'api.md'), 'utf8');
  const code = /```python\n([\s\S]*?)```/.exec(page)?.[1];
  assert.ok(code, 'docs/api.md has a Python snippet');
  const out = await run('python3', ['-c', code.replace("'telegram:123456'", "'telegram:1'")], { env, timeout: 15_000 });
  assert.match(out.stdout, /^echo: \[telegram dm 1 · scheduled \(local\)\]\n\nSummarise today\.\n$/);
});
