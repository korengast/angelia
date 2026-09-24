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
