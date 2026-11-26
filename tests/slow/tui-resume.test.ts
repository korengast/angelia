import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../../src/instance/config/schema.js';

// In the slow suite, as the add-dir cases are: each waits the real settle time before a key.
const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, '..', 'fake-tui-resume.mjs');
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();

test('a --resume launch answers the resume dialog with Resume, once it takes keys, and never starts a new conversation', { skip: !hasTmux && 'no tmux', timeout: 150_000 }, async (t) => {
  // Own socket and own state dir, so nothing here can touch a live Angelia.
  const socket = `angelia-test-rs-${process.pid}`;
  process.env.ANGELIA_TMUX_SOCKET = socket;
  process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-tuirs-'));
  const { TuiBrain } = await import('../../src/brain/tui.js');
  t.after(() => { try { execFileSync('tmux', ['-L', socket, 'kill-server']); } catch { /* already gone */ } });

  const start = async (mode: string, n: number, started = true) => {
    const cwd = mkdtempSync(join(tmpdir(), 'angelia-tuirs-cwd-'));
    writeFileSync(join(cwd, 'resume-mode.txt'), mode);
    const profile = Config.parse({ profiles: { x: { cwd, tui: true } }, routes: [] }).profiles.x;
    const b = new TuiBrain(profile, { id: `11111111-2222-3333-4444-55555555556${n}`, started }, { bin: FAKE, startTimeoutMs: 20_000 });
    const logs: string[] = [];
    b.on('log', (l: string) => logs.push(l));
    b.start();
    const problem = await ((b as any).ready as Promise<string | null>);
    const read = (f: string) => (existsSync(join(cwd, f)) ? readFileSync(join(cwd, f), 'utf8') : '');
    return { problem, logs: logs.filter((l) => l.includes('resume dialog')).map((l) => l.replace(/^pane \S+ /, '')), choice: read('choice.txt'), keys: read('keys.log').trim().split('\n').filter(Boolean).map((k) => JSON.parse(k) as string) };
  };

  const esc = await start('esc', 1);
  assert.equal(esc.problem, null);
  assert.equal(esc.choice, 'resume');
  assert.deepEqual([...new Set(esc.keys)], ['\x1b'], 'Esc only, no Enter: the cursor was on the new conversation');
  assert.deepEqual(esc.logs, ['answered the resume dialog with Esc: resume']);

  const enter = await start('enter', 2);
  assert.equal(enter.problem, null);
  assert.equal(enter.choice, 'resume', 'Up first, then Enter on Resume');
  assert.deepEqual(enter.logs, ['answered the resume dialog with Enter: resume']);

  const stuck = await start('stuck', 3);
  assert.match(stuck.problem ?? '', /never reached a prompt/);
  assert.equal(stuck.choice, '', 'nothing was chosen');
  assert.equal(stuck.keys.length, 3, 'a bounded number of presses');
  assert.ok(stuck.keys.every((k) => !k.includes('\r')), 'never Enter off "Resume"');
  assert.deepEqual(stuck.logs, ['shows the resume dialog, and the cursor did not reach "Resume": no Enter pressed']);

  // Not a --resume launch: the dialog is not one this start answers.
  const fresh = await start('esc', 4, false);
  assert.match(fresh.problem ?? '', /never reached a prompt/);
  assert.deepEqual(fresh.keys, []);
});
