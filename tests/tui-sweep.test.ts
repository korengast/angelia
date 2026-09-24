import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-tui.sh');
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();

test('the sweep ends idle panes no chat stands behind, and leaves kept, busy and foreign ones', { skip: !hasTmux && 'no tmux', timeout: 30_000 }, async (t) => {
  // Own socket, so nothing here can touch a live Angelia.
  const socket = `angelia-test-sweep-${process.pid}`;
  process.env.ANGELIA_TMUX_SOCKET = socket;
  const { sweepPanes } = await import('../src/brain/tui.js');
  const tmux = (...a: string[]) => execFileSync('tmux', ['-L', socket, ...a], { encoding: 'utf8' }).trim();
  t.after(() => { try { tmux('kill-server'); } catch { /* already gone */ } });
  const pane = (name: string, frame = 'pane-idle.txt') => tmux('new-session', '-d', '-s', name, '-x', '220', '-y', '50', 'env', `FAKE_TUI_FRAME=${frame}`, FAKE);
  pane('angelia-home-aaaaaaaa');
  pane('angelia-home-bbbbbbbb');
  pane('angelia-home-cccccccc', 'pane-busy.txt');
  pane('someone-else');
  await new Promise((r) => setTimeout(r, 500));
  const gone = await sweepPanes(new Set(['angelia-home-aaaaaaaa']), ['angelia-home-'], process.env);
  assert.deepEqual(gone, ['angelia-home-bbbbbbbb']);
  assert.deepEqual(tmux('list-sessions', '-F', '#{session_name}').split('\n').sort(), ['angelia-home-aaaaaaaa', 'angelia-home-cccccccc', 'someone-else']);
});
