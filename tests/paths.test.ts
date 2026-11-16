import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNoFollow } from '../src/core/paths.js';

const { O_CREAT, O_RDONLY, O_WRONLY } = constants;
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'angelia-paths-')));

test('openNoFollow opens a plain path and creates a file', () => {
  const d = tmp();
  const fd = openNoFollow(join(d, 'a'), O_WRONLY | O_CREAT | constants.O_EXCL, 0o600);
  closeSync(fd);
  assert.ok(existsSync(join(d, 'a')));
});

test('openNoFollow refuses a link at the last name, a middle folder, and the parent', () => {
  const d = tmp();
  const target = tmp();
  writeFileSync(join(target, 'file'), 'x');
  symlinkSync(join(target, 'file'), join(d, 'link'));
  symlinkSync(target, join(d, 'mid'));
  mkdirSync(join(d, 'sub'));
  symlinkSync(join(d, 'sub'), join(d, 'parent'));
  for (const p of [join(d, 'link'), join(d, 'mid', 'x'), join(d, 'parent', 'x'), join(d, 'mid', 'deeper', 'x')]) {
    assert.throws(() => openNoFollow(p, O_WRONLY | O_CREAT, 0o600), { code: 'ELOOP' }, p);
  }
  assert.deepEqual(readdirSync(target), ['file'], 'nothing created through a link');
  assert.deepEqual(readdirSync(join(d, 'sub')), []);
});

test('openNoFollow refuses .., ., empty segments and a relative path', () => {
  const d = tmp();
  for (const p of ['rel/x', `${d}/../x`, `${d}/./x`, `${d}//x`]) assert.throws(() => openNoFollow(p, O_RDONLY), { code: 'EINVAL' }, p);
});
