import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/instance/config/schema.js';
import { matchRoute } from '../src/core/router/match.js';
import { gate } from '../src/core/router/gate.js';
import type { Inbound } from '../src/core/types.js';

const cfg = Config.parse({
  profiles: { family: { cwd: '/f' }, coding: { cwd: '/c' }, side: { cwd: '/s' } },
  routes: [
    { platform: 'whatsapp', chat: '1@g.us', profile: 'family', mention: 'required', allow_from: ['*'] },
    { platform: 'telegram', chat: 123, profile: 'coding' },
    { platform: 'whatsapp', chat: '2@g.us', profile: 'side', mention: 'required', allow_from: ['1555'] },
    { platform: 'telegram', chat: -100, thread: 7, profile: 'side' },
    { platform: 'telegram', chat: -100, profile: 'family', mention: 'any', allow_from: ['*'] },
    { platform: 'whatsapp', chat: '3@g.us', profile: 'family', owners: ['1555'] },
  ],
});

const msg = (o: Partial<Inbound>): Inbound => ({ platform: 'whatsapp', chat: '1@g.us', sender: 'x', text: 'hi', isGroup: true, mentioned: false, media: [], ...o });

test('match: thread-specific beats chat-wide; unknown chat is undefined', () => {
  assert.equal(matchRoute(cfg, { platform: 'telegram', chat: '-100', thread: '7' })?.profile, 'side');
  assert.equal(matchRoute(cfg, { platform: 'telegram', chat: '-100', thread: '9' })?.profile, 'family');
  assert.equal(matchRoute(cfg, { platform: 'telegram', chat: '999' }), undefined);
});

test('gate: the six fixtures', () => {
  const r1 = matchRoute(cfg, { platform: 'whatsapp', chat: '1@g.us' });
  assert.deepEqual(gate(msg({ mentioned: false }), r1), { ok: false, reason: 'mention' });
  assert.deepEqual(gate(msg({ mentioned: true }), r1), { ok: true, route: r1 });
  const r2 = matchRoute(cfg, { platform: 'telegram', chat: '123' });
  assert.deepEqual(gate(msg({ platform: 'telegram', chat: '123', isGroup: false, mentioned: false }), r2), { ok: true, route: r2 });
  const r3 = matchRoute(cfg, { platform: 'whatsapp', chat: '2@g.us' });
  assert.deepEqual(gate(msg({ chat: '2@g.us', sender: 'other', mentioned: true }), r3), { ok: false, reason: 'sender' });
  assert.deepEqual(gate(msg({ chat: '2@g.us', sender: '1555', mentioned: true }), r3), { ok: true, route: r3 });
  assert.deepEqual(gate(msg({ chat: 'nope@g.us' }), undefined), { ok: false, reason: 'unmatched' });
  const r5 = matchRoute(cfg, { platform: 'telegram', chat: '-100' });
  assert.deepEqual(gate(msg({ platform: 'telegram', chat: '-100', mentioned: false }), r5), { ok: true, route: r5 });
  // No allow_from: the owners only. A personal assistant first; others are let in by name, or "*".
  const r6 = matchRoute(cfg, { platform: 'whatsapp', chat: '3@g.us' });
  assert.deepEqual(gate(msg({ chat: '3@g.us', sender: 'member', mentioned: true }), r6), { ok: false, reason: 'sender' });
  assert.deepEqual(gate(msg({ chat: '3@g.us', sender: '1555', mentioned: true }), r6), { ok: true, route: r6 });
});

test('a session key parses back into chat and topic; a group is known from its id alone', async () => {
  const { parseSessionKey, isGroupChat, sessionKey } = await import('../src/core/types.js');
  assert.deepEqual(parseSessionKey('telegram:-1001:5'), { platform: 'telegram', chat: '-1001', thread: '5' });
  assert.deepEqual(parseSessionKey('whatsapp:120363000000000001@g.us'), { platform: 'whatsapp', chat: '120363000000000001@g.us' });
  assert.equal(sessionKey(parseSessionKey('telegram:-1001:5')), 'telegram:-1001:5');
  assert.deepEqual([isGroupChat('telegram', '-1001'), isGroupChat('telegram', '7'), isGroupChat('whatsapp', 'x@g.us'), isGroupChat('whatsapp', '15550000001@s.whatsapp.net')], [true, false, true, false]);
});
