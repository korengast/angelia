import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-tui.sh');
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();

test('a pane sent to the background: its dialog is seen once, nobody answers it, a follow takes it back, and a new daemon can adopt it', { skip: !hasTmux && 'no tmux', timeout: 60_000 }, async (t) => {
  // Own socket and own state dir, so nothing here can touch a live Angelia.
  const socket = `angelia-test-bg-${process.pid}`;
  const state = mkdtempSync(join(tmpdir(), 'angelia-tuibg-'));
  process.env.ANGELIA_TMUX_SOCKET = socket;
  process.env.ANGELIA_STATE_DIR = state;
  const { TuiBrain } = await import('../src/brain/tui.js');
  const tmux = (...a: string[]) => execFileSync('tmux', ['-L', socket, ...a], { encoding: 'utf8' }).trim();
  t.after(() => { try { tmux('kill-server'); } catch { /* already gone */ } });

  const cwd = mkdtempSync(join(tmpdir(), 'angelia-tuibg-cwd-'));
  const profile = Config.parse({ profiles: { x: { cwd, tui: true } }, routes: [] }).profiles.x;
  const session = { id: '22222222-3333-4444-5555-666666666666', started: false };
  const brain = new TuiBrain(profile, session, { bin: FAKE, permissionTimeoutMs: 60_000 });
  brain.start();
  assert.equal(await (brain as any).ready, null);
  const dialog = () => tmux('respawn-pane', '-k', '-t', brain.name, 'env', 'FAKE_TUI_FRAME=pane-permission.txt', FAKE);
  const marker = (text: string) => writeFileSync(join(state, 'tui', brain.name, 'turn.json'), JSON.stringify({ text, at: Date.now() }));

  // A turn is running when the handoff comes: the pane is let go of, and read in the background.
  brain.turnSentAt = Date.now() - 1000;
  await brain.release();
  dialog();
  const bg = brain.backgroundTurn();
  const asked = (await bg.next()).value;
  assert.equal(asked?.kind, 'permission');
  assert.equal(asked?.kind === 'permission' && asked.tool, 'Bash command');
  assert.equal(brain.pendingPermissionCount, 0, 'no chat answers it, and no timeout denies it');
  assert.equal(brain.alive, false, 'not the chat\'s brain while in the background');
  const relaying = join(state, 'tui', brain.name, 'permissions', 'relay.json');
  assert.equal(existsSync(relaying), false, 'no hook relays to a chat that is not reading');

  // /resume: the pane is read in the foreground again; the background reader stops without ending it.
  const fg = brain.follow();
  assert.equal(brain.alive, true);
  const stopped = (await bg.next()).value;
  assert.deepEqual(stopped, { kind: 'result', text: '', isError: true, reason: 'released' });
  const again = (await fg.next()).value;
  assert.equal(again?.kind, 'notice', 'the waiting dialog did not come through the hook: the chat hears where to answer it');
  assert.match(again?.kind === 'notice' ? again.text : '', /cannot be answered from here/);
  assert.equal(brain.pendingPermissionCount, 0, 'and is not asked to');
  assert.equal(existsSync(relaying), true, 'read from the chat again: the hook relays what it asks next');
  marker('the answer');
  assert.deepEqual((await fg.next()).value, { kind: 'result', text: 'the answer', isError: false });
  assert.equal(brain.turnSentAt, undefined, 'the turn is over');

  // A restarted daemon adopts a live pane by name, and not one that is gone.
  const next = new TuiBrain(profile, session, { bin: FAKE });
  assert.equal(await next.adopt(Date.now()), true);
  tmux('kill-session', '-t', brain.name);
  assert.equal(await new TuiBrain(profile, session, { bin: FAKE }).adopt(Date.now()), false);
});
