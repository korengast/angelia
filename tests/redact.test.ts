import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactLog } from '../src/daemon/redact.js';

const R = '<redacted>';

test('redact: every credential shape is masked, the rest of the line kept', () => {
  const cases: [string, string][] = [
    [`telegram: getUpdates failed https://api.telegram.org/bot1234567890:AAHfakefakefakefakefakefakefakefake/getUpdates`, `telegram: getUpdates failed https://api.telegram.org/bot${R}/getUpdates`],
    [`a token without the AA start 123456789:BBxfakefakefakefakefakefakefakefake ends`, `a token without the AA start ${R} ends`],
    [`openai said sk-abcdefghijklmnopqrstuvwxyz0123 no`, `openai said ${R} no`],
    [`anthropic key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789`, `anthropic key ${R}`],
    [`slack xoxb-1234567890-abcdefghij and xoxp-1234567890-abcdefghij`, `slack ${R} and ${R}`],
    [`github ghp_abcdefghijklmnopqrstuvwxyz0123456789 gho_abcdefghijklmnopqrstuvwxyz0123456789 github_pat_abcdefghijklmnopqrstuvwxyz0123456789`, `github ${R} ${R} ${R}`],
    [`aws AKIAIOSFODNN7EXAMPLE here`, `aws ${R} here`],
    [`google AIzaSyA-abcdefghijklmnopqrstuvwxyz0123456 key`, `google ${R} key`],
    [`xai xai-abcdefghijklmnopqrstuvwxyz0123456789 said`, `xai ${R} said`],
    [`jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c end`, `jwt ${R} end`],
    [`request had Authorization: Bearer abcdefghijklmnop`, `request had Authorization: Bearer ${R}`],
    [`header bearer abcdefghijklmnop sent`, `header bearer ${R} sent`],
    [`env token=abcdefgh1234 api_key: "0123456789abcdef" apiKey=xyzxyzxyzxyz`, `env token=${R} api_key: "${R}" apiKey=${R}`],
    [`password=hunter22hunter passwd: longenough cookie=sid123456789 secret: s3cr3t-s3cr3t`, `password=${R} passwd: ${R} cookie=${R} secret: ${R}`],
    [`x-auth-token: abcdefghijkl session_token=abcdefghijkl`, `x-auth-token: ${R} session_token=${R}`],
    [`body {"token":"abcdefghijklmnop","password":"hunter2hunter2"} sent`, `body {"token":"${R}","password":"${R}"} sent`],
    [`body {'api_key': 'abcdefghijklmnop'} sent`, `body {'api_key': '${R}'} sent`],
    [`token="abcdefghijklmnop", next`, `token="${R}", next`],
    [`-----BEGIN RSA PRIVATE KEY-----`, `${R}-----`],
  ];
  for (const [line, want] of cases) assert.equal(redactLog(line), want, line);
});

test('redact: a plain line, a sha, a chat id, a session id and the status words are unchanged', () => {
  const plain = [
    'daemon up pid=12345 profiles=9 routes=11 tg=polling wa=connected api=api.sock',
    'whatsapp: connected as 1555…',
    'telegram: token in',
    'api.token was mode 644; set back to 600',
    'restart failed key=whatsapp:120363000000000001@g.us: angelia version b77c821a is not installed',
    'telegram: chat=-1001000000000 dropped (anonymous admin)',
    'background turn over key=telegram:-1001000000000 session=3f1c2a9e-7b4d-4e2a-9c1d-0a1b2c3d4e5f',
    'ask key=whatsapp:120363000000000001@g.us from=owner session=3f1c2a9e-7b4d-4e2a-9c1d-0a1b2c3d4e5f',
    'token short=abc',
    'ask key=whatsapp:120363000000000001@g.us session=3f1c2a9e from=owner',
    'tmux could not start the session: no server running on /tmp/tmux-501/default',
    'config warning: whatsapp auth_dir: /Users/example/.angelia/whatsapp-auth is mode 755',
    'telegram: unauthorized: the bot was removed from the chat',
    'grok: OAuth: the browser did not come back in 120 s',
    'workspace commit: author: someone <someone@example.com>',
    'a short token: abc',
    'commit 9e7294c3f1c2a9e7b4d4e2a9c1d0a1b2c3d4e5f6 pushed',
    'the session=3f1c2a9e-7b4d-4e2a-9c1d-0a1b2c3d4e5f; ended',
  ];
  for (const line of plain) assert.equal(redactLog(line), line);
});

test('redact: a long line is cut before the regexes run, and a dashed value does not make them slow', () => {
  const dashed = Array.from({ length: 300 }, (_, i) => `ab${i}cd-`).join('') .repeat(8); // ~18 kB of base64-like text with a dash every few characters
  const t0 = performance.now();
  const out = redactLog(`payload ${dashed}`);
  const ms = performance.now() - t0;
  assert.ok(ms < 20, `${ms.toFixed(1)} ms`);
  assert.ok(out.length < 2100 && out.endsWith('(line cut at 2000 characters)'), out.slice(-60));
  assert.equal(redactLog('x'.repeat(2000)), 'x'.repeat(2000), 'at the limit nothing is cut');
});
