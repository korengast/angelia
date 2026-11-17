import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
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

// The walk needs search (x) on each folder, never read: a parent of mode 0711 (/home on shared hosts) must not refuse
// the paths below it. Owner rights are dropped to search only, so the test means something without a second user.
test('openNoFollow walks through a folder it may search but not read', { skip: process.platform !== 'linux' ? 'the /proc walk is Linux only' : process.getuid?.() === 0 ? 'root reads every folder' : false }, () => {
  const d = tmp();
  mkdirSync(join(d, 'home', 'user'), { recursive: true });
  writeFileSync(join(d, 'home', 'user', 'file'), 'x');
  chmodSync(join(d, 'home'), 0o111);
  try {
    closeSync(openNoFollow(join(d, 'home', 'user', 'file'), O_RDONLY));
    closeSync(openNoFollow(join(d, 'home', 'user', 'new'), O_WRONLY | O_CREAT, 0o600));
    assert.ok(existsSync(join(d, 'home', 'user', 'new')));
  } finally { chmodSync(join(d, 'home'), 0o711); }
});
