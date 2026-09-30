import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBuffer, tmux } from '../src/brain/tmux.js';

const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();

test('a message far past tmux\'s 16 KB command limit reaches the paste buffer whole, and leaves no file behind', { skip: !hasTmux && 'no tmux', timeout: 30_000 }, async (t) => {
  // Own socket, so nothing here can touch a live Angelia.
  const socket = `angelia-test-paste-${process.pid}`;
  const run = (a: string[]) => tmux(a, { socket });
  t.after(() => { try { execFileSync('tmux', ['-L', socket, 'kill-server']); } catch { /* already gone */ } });
  assert.equal((await run(['new-session', '-d', '-s', 'p', 'sleep 60'])).code, 0);

  const dir = mkdtempSync(join(tmpdir(), 'angelia-paste-'));
  const text = `[whatsapp group 1@g.us · Owner (1)]\n\n${'a long release checklist, שלום; '.repeat(1500)}`;
  assert.ok(Buffer.byteLength(text) > 40_000);
  // What the old set-buffer did with it: refused, so the pane never saw the message.
  assert.notEqual((await run(['set-buffer', '-b', 'old', '--', text])).code, 0);

  assert.equal((await loadBuffer('p', text, dir, run)).code, 0);
  assert.equal((await run(['show-buffer', '-b', 'p'])).out, text);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(existsSync(join(dir, 'paste.txt')), false);
});

test('a paste file left over from a crash, or a link in its place, is replaced, never written through', { skip: !hasTmux && 'no tmux', timeout: 30_000 }, async (t) => {
  const socket = `angelia-test-paste2-${process.pid}`;
  const run = (a: string[]) => tmux(a, { socket });
  t.after(() => { try { execFileSync('tmux', ['-L', socket, 'kill-server']); } catch { /* already gone */ } });
  assert.equal((await run(['new-session', '-d', '-s', 'p', 'sleep 60'])).code, 0);
  const dir = mkdtempSync(join(tmpdir(), 'angelia-paste-'));
  const outside = join(mkdtempSync(join(tmpdir(), 'angelia-outside-')), 'target');
  writeFileSync(outside, 'untouched');
  symlinkSync(outside, join(dir, 'paste.txt'));
  assert.equal((await loadBuffer('p', 'hello', dir, run)).code, 0);
  assert.equal((await run(['show-buffer', '-b', 'p'])).out, 'hello');
  assert.equal(readFileSync(outside, 'utf8'), 'untouched');
  writeFileSync(join(dir, 'paste.txt'), 'old', { mode: 0o644 });
  const seen: number[] = [];
  await loadBuffer('p', 'again', dir, async (a) => { seen.push(statSync(join(dir, 'paste.txt')).mode & 0o777); return run(a); });
  assert.deepEqual(seen, [0o600]);
  assert.equal(existsSync(join(dir, 'paste.txt')), false);
});
