import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    const id = `11111111-2222-3333-4444-55555555556${n}`;
    const b = new TuiBrain(profile, { id, started }, { bin: FAKE, startTimeoutMs: 20_000 });
    const logs: string[] = [];
    b.on('log', (l: string) => logs.push(l));
    b.start();
    const problem = await ((b as any).ready as Promise<string | null>);
    const read = (f: string) => (existsSync(join(cwd, f)) ? readFileSync(join(cwd, f), 'utf8') : '');
    return { b, cwd, id, profile, read, problem, logs: logs.filter((l) => l.includes('resume dialog')).map((l) => l.replace(/^pane \S+ /, '')), choice: read('choice.txt'), keys: read('keys.log').trim().split('\n').filter(Boolean).map((k) => JSON.parse(k) as string) };
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

  // A running idle pane asks: the next message answers it, then goes in.
  const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 100)); assert.ok(ok()); };
  const live = await start('idle', 5);
  assert.equal(live.problem, null);
  const shows = (b: typeof live.b) => execFileSync('tmux', ['-L', socket, 'capture-pane', '-p', '-t', b.name], { encoding: 'utf8' }).includes('Esc to dismiss');
  const reopen = async () => {
    for (const f of ['keys.log', 'choice.txt']) rmSync(join(live.cwd, f), { force: true });
    writeFileSync(join(live.cwd, 'open-now'), '');
    await until(() => shows(live.b));
  };
  await reopen();
  const logs: string[] = [];
  live.b.on('log', (l: string) => logs.push(l));
  assert.deepEqual(await (live.b as any).paste('hello there'), { ok: true });
  const keys = live.read('keys.log');
  assert.ok(keys.startsWith('"\\u001b"\n'), 'Esc first');
  assert.ok(keys.indexOf('hello there') > 0, 'then the message');
  assert.equal(live.read('choice.txt'), 'resume');
  assert.equal(logs.filter((l) => l.includes('answered the resume dialog with Esc')).length, 1);

  // A restarted daemon reattaches the pane while it asks.
  await reopen();
  const again = new TuiBrain(live.profile, { id: live.id, started: true }, { bin: FAKE, startTimeoutMs: 20_000 });
  const relogs: string[] = [];
  again.on('log', (l: string) => relogs.push(l));
  again.start();
  assert.equal(await ((again as any).ready as Promise<string | null>), null);
  await until(() => live.read('choice.txt') === 'resume');
  assert.deepEqual(live.read('keys.log').trim().split('\n').map((k) => JSON.parse(k)), ['\x1b']);
  assert.equal(relogs.filter((l) => l.includes('answered the resume dialog with Esc')).length, 1);

  // Not a --resume launch: the dialog is not one this start answers.
  const fresh = await start('esc', 4, false);
  assert.match(fresh.problem ?? '', /never reached a prompt/);
  assert.deepEqual(fresh.keys, []);
});
