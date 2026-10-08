import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { apiDeps } from '../src/daemon/api/deps.js';
import { API_SOCKET, ApiServer, claimSocket, loadOrMintToken } from '../src/daemon/api/server.js';
import { jobsView, lastRuns } from '../src/jobs/jobs-view.js';

function instance() {
  const state = mkdtempSync(join(tmpdir(), 'angelia-jobsview-'));
  const cwd = join(state, 'garden');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'angelia-jobs.yaml'), [
    'jobs:',
    '  morning:',
    '    schedule: "0 7 * * *"',
    '    turn: Plan the day in the garden.',
    '  weekly:',
    '    every: 7d',
    '    send: Water the pots.',
    '    enabled: false',
  ].join('\n'));
  writeFileSync(join(state, 'jobs.log'), [
    '2026-10-01T07:00:01.000Z garden/morning turn queued in telegram:1',
    '2026-10-01T07:00:02.000Z other/morning ran, nothing to send',
    'not a log line',
    '2026-10-02T07:00:01.000Z garden/morning error: the daemon did not answer',
  ].join('\n') + '\n');
  const cfg = Config.parse({ profiles: { garden: { cwd }, empty: { cwd: state } }, routes: [{ platform: 'telegram', chat: 1, profile: 'garden' }] });
  return { state, cwd, cfg };
}

test('jobs view: each job with when, what, where, and its last runs newest first', () => {
  const { state, cfg } = instance();
  const v = jobsView(cfg, 'garden', state, state);
  assert.equal(v.error, undefined);
  assert.deepEqual(v.jobs.map((j) => [j.name, j.when, j.kind, j.what, j.chat, j.enabled, j.installed]), [
    ['morning', 'cron 0 7 * * *', 'turn', 'Plan the day in the garden.', 'telegram:1', true, false],
    ['weekly', 'every 7d', 'send', 'Water the pots.', 'telegram:1', false, false],
  ]);
  assert.deepEqual(v.jobs[0]?.runs.map((r) => r.result), ['error: the daemon did not answer', 'turn queued in telegram:1']);
  assert.deepEqual(v.jobs[1]?.runs, []);
  assert.deepEqual(jobsView(cfg, 'empty', state, state).jobs, [], 'no jobs file: no jobs');
  assert.equal(lastRuns(join(state, 'nowhere')).size, 0, 'no log: no runs');
});

test('jobs view: a jobs file that does not load is reported, not thrown', () => {
  const { state, cwd, cfg } = instance();
  writeFileSync(join(cwd, 'angelia-jobs.yaml'), 'jobs:\n  bad:\n    every: soon\n    send: x\n');
  const v = jobsView(cfg, 'garden', state, state);
  assert.deepEqual(v.jobs, []);
  assert.match(v.error ?? '', /every/);
});

test('jobs view over the API: owner only, and an unknown profile is 404', async (t) => {
  const { state, cfg } = instance();
  const o = new Orchestrator(cfg, { telegram: { send: async () => {} } }, { stateDir: state });
  const token = loadOrMintToken(join(state, 'api.token'));
  const api = new ApiServer(apiDeps(o, cfg, () => ({}), state), token);
  const socket = join(state, API_SOCKET);
  await claimSocket(socket);
  await api.listen(socket);
  t.after(async () => { await api.close(); await o.shutdown(); });
  const get = (path: string, bearer?: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ socketPath: socket, path, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(s) }));
    });
    req.on('error', reject); req.end();
  });
  const ok = await get('/jobs?profile=garden', token);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.jobs.length, 2);
  assert.equal((await get('/jobs?profile=nope', token)).status, 404);
  assert.equal((await get('/jobs?profile=__proto__', token)).status, 404);
  assert.equal((await get('/jobs?profile=garden')).status, 403);
});
