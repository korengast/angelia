import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionMap } from '../src/core/session/map.js';

const fresh = () => new SessionMap(join(mkdtempSync(join(tmpdir(), 'angelia-map-')), 'sessions.json'));

test('new map has no active session; ensureActive mints', () => {
  const m = fresh();
  assert.equal(m.getActive('telegram:1'), undefined);
  const row = m.ensureActive('telegram:1', 'hello world');
  assert.match(row.id, /^[0-9a-f-]{36}$/);
  assert.equal(row.started, false);
  assert.equal(m.ensureActive('telegram:1').id, row.id);
});

test('recordTurn marks started; startNew keeps history', () => {
  const m = fresh();
  const a = m.ensureActive('k');
  m.recordTurn('k', a.id, 'first message');
  assert.equal(m.getActive('k')?.started, true);
  assert.equal(m.getActive('k')?.turns, 1);
  const b = m.startNew('k');
  assert.notEqual(a.id, b.id);
  assert.equal(m.list('k').length, 2);
});

test('setActive by index and by uuid prefix', () => {
  const m = fresh();
  const a = m.ensureActive('k');
  m.recordTurn('k', a.id);
  const b = m.startNew('k');
  assert.equal(m.getActive('k')?.id, b.id);
  assert.equal(m.setActive('k', a.id.slice(0, 8))?.id, a.id);
  const listed = m.list('k');
  assert.equal(m.setActive('k', '2')?.id, listed[1].id);
  assert.equal(m.setActive('k', 'zzz'), undefined);
});

test('startNew then ensureActive keeps the new id; file is persisted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-map-'));
  const path = join(dir, 'sessions.json');
  const m = new SessionMap(path);
  const a = m.ensureActive('k');
  m.startNew('k');
  const b = m.ensureActive('k');
  assert.notEqual(a.id, b.id);
  assert.ok(existsSync(path));
  const again = new SessionMap(path);
  assert.equal(again.getActive('k')?.id, b.id);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1);
});

test('a damaged sessions.json is moved aside and the map starts empty; history keeps the newest 200', async () => {
  const { mkdtempSync, writeFileSync, readdirSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { SessionMap } = await import('../src/core/session/map.js');
  for (const bad of ['{"chats": {', '', '{"chats": [1, 2]}', '{"chats": {"k": {"active": null}}}']) {
    const dir = mkdtempSync(join(tmpdir(), 'angelia-map-'));
    writeFileSync(join(dir, 'sessions.json'), bad);
    const warned: string[] = [];
    const m = new SessionMap(join(dir, 'sessions.json'), (l) => warned.push(l));
    assert.equal(m.getActive('telegram:1'), undefined);
    assert.match(warned[0] ?? '', /could not be read/, JSON.stringify(bad));
    assert.ok(readdirSync(dir).some((f) => f.startsWith('sessions.json.damaged-')));
    m.startNew('telegram:1');
    assert.equal(JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')).version, 1);
  }
  const m = new SessionMap(join(mkdtempSync(join(tmpdir(), 'angelia-map-')), 'sessions.json'));
  for (let i = 0; i < 230; i++) m.startNew('telegram:1', `s${i}`);
  const all = m.list('telegram:1', 1000);
  assert.equal(all.length, 200);
  assert.equal(m.getActive('telegram:1')?.label, 's229');
});

test('a session map that cannot be read for another reason is not moved aside; the cap drops the least used', async () => {
  const { mkdtempSync, writeFileSync, chmodSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { SessionMap } = await import('../src/core/session/map.js');
  const dir = mkdtempSync(join(tmpdir(), 'angelia-map-'));
  writeFileSync(join(dir, 'sessions.json'), '{"version":1,"chats":{}}');
  chmodSync(join(dir, 'sessions.json'), 0o000);
  if (process.getuid?.() !== 0) {
    assert.throws(() => new SessionMap(join(dir, 'sessions.json')), /EACCES/);
    assert.deepEqual(readdirSync(dir), ['sessions.json']);
  }
  chmodSync(join(dir, 'sessions.json'), 0o600);
  const m = new SessionMap(join(mkdtempSync(join(tmpdir(), 'angelia-map-')), 'sessions.json'));
  const first = m.startNew('telegram:1', 'first');
  for (let i = 0; i < 100; i++) m.startNew('telegram:1', `s${i}`);
  m.setActive('telegram:1', first.id); // used again through /resume
  m.recordTurn('telegram:1', first.id, 'again');
  for (let i = 100; i < 230; i++) m.startNew('telegram:1', `s${i}`);
  assert.ok(m.list('telegram:1', 1000).some((r) => r.id === first.id), 'a session used lately stays');
});
