import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-tui-adddir.mjs');
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();

// claude 2.1.326 asks about each --add-dir folder it has not worked in (2026-11-16): every new
// session of a profile with add_dirs sat on that dialog until the start timed out.
test('a new session answers each add-dir dialog yes for a listed folder, once it takes keys, and never for another', { skip: !hasTmux && 'no tmux', timeout: 90_000 }, async (t) => {
  // Own socket and own state dir, so nothing here can touch a live Angelia.
  const socket = `angelia-test-ad-${process.pid}`;
  process.env.ANGELIA_TMUX_SOCKET = socket;
  process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-tuiad-'));
  const { TuiBrain } = await import('../src/brain/tui.js');
  const tmux = (...a: string[]) => execFileSync('tmux', ['-L', socket, ...a], { encoding: 'utf8' }).trim();
  t.after(() => { try { tmux('kill-server'); } catch { /* already gone */ } });

  const extra = mkdtempSync(join(tmpdir(), 'angelia-tuiad-extra-'));
  const second = mkdtempSync(join(tmpdir(), 'angelia-tuiad-second-'));
  const start = async (cwd: string, id: string) => {
    const profile = Config.parse({ profiles: { x: { cwd, tui: true, add_dirs: [extra, second] } }, routes: [] }).profiles.x;
    const b = new TuiBrain(profile, { id, started: false }, { bin: FAKE });
    const logs: string[] = [];
    b.on('log', (l: string) => logs.push(l));
    b.start();
    return { b, logs, problem: await ((b as any).ready as Promise<string | null>) };
  };

  const listed = await start(mkdtempSync(join(tmpdir(), 'angelia-tuiad-cwd-')), '11111111-2222-3333-4444-555555555551');
  assert.equal(listed.problem, null, 'both listed folders are added, each after its dialog takes keys, and the prompt comes');
  assert.match(tmux('capture-pane', '-p', '-t', listed.b.name), /❯/);
  assert.deepEqual(listed.logs.filter((l) => l.includes('answered add-dir')).map((l) => l.replace(/.* /, '')), [extra, second], 'one line per folder answered');

  const cwd = mkdtempSync(join(tmpdir(), 'angelia-tuiad-cwd-'));
  writeFileSync(join(cwd, 'adddir-ask.txt'), '/Users/example/.ssh');
  const t0 = Date.now();
  const other = await start(cwd, '11111111-2222-3333-4444-555555555552');
  assert.equal(other.problem, 'the session did not start: claude asks to add the folder /Users/example/.ssh, which is not in this profile\'s add_dirs');
  assert.ok(Date.now() - t0 < 20_000, 'it fails at once, not at the start timeout');
  assert.equal(existsSync(join(cwd, 'keys.log')), false, 'no key reached the dialog of a folder not listed');

  // The answered trust frame stays in the history above the add-dir dialog: Enter for it would land
  // on the add-dir dialog's "No, exit".
  const trusting = mkdtempSync(join(tmpdir(), 'angelia-tuiad-cwd-'));
  writeFileSync(join(trusting, 'trust-first.txt'), '');
  const both = await start(trusting, '11111111-2222-3333-4444-555555555553');
  assert.equal(both.problem, null, 'trust, then both folders, then the prompt');
  assert.match(tmux('capture-pane', '-p', '-t', both.b.name, '-S', '-40'), /Yes, I trust this folder/, 'the trust frame is still in the capture');

  // A resumed conversation whose last screen quotes the start dialogs: the prompt is below them, so
  // the session is up at once and no key reaches it.
  const resumed = mkdtempSync(join(tmpdir(), 'angelia-tuiad-cwd-'));
  writeFileSync(join(resumed, 'adddir-quoted.txt'), '⏺ The new dialog reads:\n\n  Adding a new directory:\n\n  /Users/example/.ssh\n\n    No, exit\n  ❯ Yes, add it\n\n'
    + '  and the trust one:\n\n  ❯ No, exit\n    Yes, I trust this folder\n\n  Allow external CLAUDE.md file imports?\n  ❯ No, disable external imports\n\n');
  const t1 = Date.now();
  const quoted = await start(resumed, '11111111-2222-3333-4444-555555555555');
  assert.equal(quoted.problem, null, 'the quote is no dialog');
  assert.ok(Date.now() - t1 < 10_000, 'up at once, not after waiting on a dialog');
  assert.equal(existsSync(join(resumed, 'keys.log')), false, 'no key was sent');
});

test('a dialog that closes while it is being answered gets no more keys: the next folder\'s dialog is not answered for it', async () => {
  process.env.ANGELIA_STATE_DIR ??= mkdtempSync(join(tmpdir(), 'angelia-tuiad-'));
  const { TuiBrain } = await import('../src/brain/tui.js');
  const { addDirAccepted, addDirDialog } = await import('../src/brain/tmux.js');
  const frame = (name: string) => readFileSync(join(here, 'fixtures', `pane-${name}.txt`), 'utf8');
  const listed = '/Users/example/.angelia/projects';
  const other = (name: string) => frame(name).replace(listed, '/Users/example/.ssh');
  const profile = Config.parse({ profiles: { x: { cwd: tmpdir(), tui: true, add_dirs: [listed] } }, routes: [] }).profiles.x;
  const b = new TuiBrain(profile, { id: '11111111-2222-3333-4444-555555555554', started: false }, { bin: FAKE }) as any;
  // The listed folder's dialog with "No" on, then (closed by something else) another folder's
  // dialog, which would take a Down to yes and then Enter if the loop did not know its folder.
  const frames = [frame('adddir'), other('adddir'), other('adddir-selected')];
  const keys: string[] = [];
  b.capture = async () => frames.shift() ?? other('adddir-selected');
  b.tm = async (a: string[]) => { if (a[0] === 'send-keys') keys.push(a[a.length - 1]); return { code: 0, out: '' }; };
  const ok = await b.acceptDialog((p: string) => addDirDialog(p) === listed, addDirAccepted);
  assert.equal(ok, false);
  assert.deepEqual(keys, ['Down'], 'one Down for the listed folder, nothing once its dialog is gone');
});
