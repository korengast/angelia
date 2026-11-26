import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { LOGIN_LOST_LINE } from '../src/core/deliver/text.js';
import { apiErrorReason, apiErrorText, isApiErrorReason, isApiErrorRow, loginLost } from '../src/brain/api-error.js';
import type { Inbound } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-claude.mjs');

function setup(apiRetryMs = 50) {
  const cfg = Config.parse({ profiles: { a: { cwd: here } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }], defaults: { max_out_per_min: 1000 } });
  const sent: string[] = [];
  const logs: string[] = [];
  const sender = { send: async (_chat: string, text: string) => { sent.push(text); } };
  const o = new Orchestrator(cfg, { telegram: sender }, { stateDir: mkdtempSync(join(tmpdir(), 'angelia-apiretry-')), bins: { 'claude-code': FAKE }, apiRetryMs, log: (l) => logs.push(l) });
  return { o, sent, logs };
}
const dm = (text: string): Inbound => ({ platform: 'telegram', chat: '1', sender: 'u1', senderName: 'Owner', text, isGroup: false, mentioned: false, media: [] });

test('a lost login is told by the words Claude Code and the API use for it, and nothing else', () => {
  for (const t of ['Not logged in · Please run /login', 'Invalid API key · Please run /login', 'OAuth token has expired. Please obtain a new token or refresh your existing token.',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}']) assert.equal(loginLost(t), true, t);
  for (const t of ['API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}', 'Request timed out.', 'logged the run in notes.md', '']) assert.equal(loginLost(t), false, t);
});

test('only a row Claude Code marks as a failed API call counts, and a usage limit stays an answer', () => {
  const row = (text: string, extra: object = {}) => ({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text }] }, ...extra });
  assert.equal(apiErrorText(row('Not logged in · Please run /login', { isApiErrorMessage: true })), 'Not logged in · Please run /login');
  assert.equal(apiErrorText(row('API Error: 500', { error: 'server_error' })), 'API Error: 500', 'the print-mode stream marks it with error');
  assert.equal(apiErrorText(row('If it says "Please run /login", run claude and type /login.')), null, 'the same words in an answer');
  assert.equal(apiErrorText(row("You've hit your limit · resets 3pm", { isApiErrorMessage: true })), null, 'a limit has its own path');
  assert.equal(isApiErrorRow({ type: 'user', isApiErrorMessage: true }), false);
  assert.equal(isApiErrorReason(apiErrorReason('Not logged in')), true);
  assert.equal(isApiErrorReason('exit'), false);
});

test('an API error is never posted as the answer: the same turn runs again a minute later, in the same session, and answers', async (t) => {
  const { o, sent, logs } = setup(); t.after(() => o.shutdown());
  await o.handle(dm('warm up'));
  const id = o.map.getActive('telegram:1')!.id;
  sent.length = 0;
  await o.handle(dm('NOLOGINONCE what is new'));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^echo: .*NOLOGINONCE what is new$/s, 'the retry answered');
  assert.ok(!sent.some((s) => /Please run \/login/.test(s)));
  assert.equal(o.map.getActive('telegram:1')!.id, id, 'the same session, not a fresh one');
  assert.ok(logs.some((l) => /api error key=telegram:1, the same turn again/.test(l)));
});

test('a login still lost after the retry is one plain line on what to do; another API error keeps the failure line', async (t) => {
  const { o, sent } = setup(); t.after(() => o.shutdown());
  await o.handle(dm('NOLOGIN hello'));
  assert.deepEqual(sent, [LOGIN_LOST_LINE]);
  sent.length = 0;
  await o.handle(dm('APIERR hello'));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^Something broke on my side \(api-error: API Error: 500 .*\)\. Try again, or \/new\.$/);
  sent.length = 0;
  await o.handle(dm('back'));
  assert.match(sent[0], /^echo:/, 'the chat answers again');
});

test('/stop during the wait cancels the retry: nothing is typed again and nothing more is said', async (t) => {
  const { o, sent, logs } = setup(1500); t.after(() => o.shutdown());
  const turn = o.handle(dm('NOLOGIN hello'));
  for (let n = 0; n < 50 && !logs.some((l) => l.startsWith('api error')); n++) await new Promise((r) => setTimeout(r, 100));
  await o.handle(dm('/stop'));
  await turn;
  assert.deepEqual(sent, ['Stopped.']);
  assert.ok(logs.some((l) => /api retry dropped key=telegram:1/.test(l)));
});
