import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-tui.sh');
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();

const tmuxIn = (socket: string) => (...a: string[]) => execFileSync('tmux', ['-L', socket, ...a], { encoding: 'utf8' }).trim();

test('a turn has no end time: past the hour it says so once in the chat, and still ends with its answer', { skip: !hasTmux && 'no tmux', timeout: 60_000 }, async (t) => {
  // Own socket and own state dir, so nothing here can touch a live Angelia.
  const socket = `angelia-test-hours-${process.pid}`;
  const state = mkdtempSync(join(tmpdir(), 'angelia-tuihours-'));
  process.env.ANGELIA_TMUX_SOCKET = socket;
  process.env.ANGELIA_STATE_DIR = state;
  const { TuiBrain } = await import('../src/brain/tui.js');
  t.after(() => { try { tmuxIn(socket)('kill-server'); } catch { /* already gone */ } });

  const cwd = mkdtempSync(join(tmpdir(), 'angelia-tuihours-cwd-'));
  const profile = Config.parse({ profiles: { x: { cwd, tui: true } }, routes: [] }).profiles.x;
  const brain = new TuiBrain(profile, { id: '33333333-4444-5555-6666-777777777777', started: false }, { bin: FAKE });
  brain.start();
  assert.equal(await (brain as any).ready, null);

  // A turn sent two and a half hours ago is still read, not failed.
  brain.turnSentAt = Date.now() - 150 * 60_000;
  const fg = brain.follow();
  assert.deepEqual((await fg.next()).value, { kind: 'notice', text: 'Still working on this turn after 2 hours. /stop ends it.' });
  writeFileSync(join(state, 'tui', brain.name, 'turn.json'), JSON.stringify({ text: 'done at last', at: Date.now() }));
  assert.deepEqual((await fg.next()).value, { kind: 'result', text: 'done at last', isError: false });
});

test('with no end time a dead pane still ends the turn, even where ~/.tmux.conf keeps dead panes on screen', { skip: !hasTmux && 'no tmux', timeout: 60_000 }, async (t) => {
  // tui.js read the socket and state dir at its first import, in the test above: use the same ones.
  const { TuiBrain } = await import('../src/brain/tui.js');
  const tmux = tmuxIn(process.env.ANGELIA_TMUX_SOCKET!);
  t.after(() => { try { tmux('kill-server'); } catch { /* already gone */ } });
  // What a user's config would do: the server keeps a pane whose program has ended.
  tmux('new-session', '-d', '-s', 'keep', 'sleep 600');
  tmux('set-option', '-g', 'remain-on-exit', 'on');

  const cwd = mkdtempSync(join(tmpdir(), 'angelia-tuidead-cwd-'));
  const profile = Config.parse({ profiles: { x: { cwd, tui: true } }, routes: [] }).profiles.x;
  const brain = new TuiBrain(profile, { id: '44444444-5555-6666-7777-888888888888', started: false }, { bin: FAKE });
  brain.start();
  assert.equal(await (brain as any).ready, null);
  brain.turnSentAt = Date.now();
  const fg = brain.follow();
  execFileSync('kill', [tmux('list-panes', '-t', brain.name, '-F', '#{pane_pid}')]);
  assert.deepEqual((await fg.next()).value, { kind: 'result', text: '', isError: true, reason: 'exit' });
});
